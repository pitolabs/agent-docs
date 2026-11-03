// Reads archived documents into the index, one at a time, in this process (the only writer of the bucket and the
// index). `save` records a pending row before replying and enqueues the bytes it just uploaded; the reconcile sweep
// (30 s after boot, then every 6 h) lists the bucket and enqueues anything the index has never seen, plus pending or
// failed rows with fewer than 3 attempts. So a restart, a crash mid-extraction or a model outage only delays reading.
// One file and one model call in flight at a time: it runs inside the agent's process.
import { createHash } from "node:crypto";
import { chunkText, type Embedder } from "./embeddings.ts";
import { type Extract, type Extraction, emptyExtraction, isExtractable } from "./extract.ts";
import { DOCUMENTS_PREFIX, type DocsArchive } from "./s3.ts";
import type { DocumentStore } from "./store.ts";

export interface IndexJob {
	key: string;
	data?: Uint8Array<ArrayBuffer>;
	mimeType?: string;
	description?: string;
	versionId?: string;
	/** YYYY-MM-DD. */
	archivedAt?: string;
}

/** Year 0000 (documents/0000/...) is reserved for a deployment's write probes; they are never indexed. */
const PROBES = `${DOCUMENTS_PREFIX}0000/`;
const MAX_ATTEMPTS = 3;

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

export class Indexer {
	private queue: IndexJob[] = [];
	private queued = new Set<string>();
	private running?: Promise<void>;
	private timers: NodeJS.Timeout[] = [];
	private sweeping = false;
	private readonly now: () => Date;

	constructor(private deps: { docs: DocsArchive; index: DocumentStore; extract: Extract; embedder: Embedder; log: string; now?: () => Date }) {
		this.now = deps.now ?? (() => new Date());
	}

	/** Queues a document to read; a no-op when it is already queued. */
	enqueue(job: IndexJob): void {
		if (this.queued.has(job.key)) return;
		this.queued.add(job.key);
		this.queue.push(job);
		this.running ??= this.loop();
	}

	/** Resolves when the queue is empty. */
	async drain(): Promise<void> {
		while (this.running) await this.running;
	}

	start(opts: { bootDelayMs?: number; everyMs?: number } = {}): void {
		const sweep = () => void this.reconcile().catch((e) => console.error(`${this.deps.log} index sweep failed: ${safeError(e)}`));
		const boot = setTimeout(sweep, opts.bootDelayMs ?? 30_000);
		const every = setInterval(sweep, opts.everyMs ?? 6 * 3600_000);
		boot.unref();
		every.unref();
		this.timers.push(boot, every);
	}

	stop(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
	}

	/** Enqueues every document in S3 the index does not know, and every pending or failed one still retryable. */
	async reconcile(): Promise<{ enqueued: number }> {
		if (this.sweeping) return { enqueued: 0 };
		this.sweeping = true;
		try {
			let enqueued = 0;
			const add = (job: IndexJob) => {
				if (this.queued.has(job.key)) return;
				this.enqueue(job);
				enqueued++;
			};
			for await (const l of this.deps.docs.listAll(DOCUMENTS_PREFIX)) {
				if (l.key.startsWith(PROBES)) continue;
				if (!(await this.deps.index.has(l.key))) add({ key: l.key, archivedAt: l.archived });
			}
			for (const key of await this.deps.index.retryable(MAX_ATTEMPTS)) add({ key });
			if (enqueued) console.info(`${this.deps.log} index sweep: ${enqueued} document(s) to read`);
			return { enqueued };
		} finally {
			this.sweeping = false;
		}
	}

	/**
	 * The single worker. It marks itself idle (running = undefined) in the same synchronous step that finds the queue
	 * empty, so an enqueue can never see a worker that is already past its last shift() and be left unread.
	 */
	private async loop(): Promise<void> {
		for (;;) {
			const job = this.queue.shift();
			if (!job) {
				this.running = undefined;
				return;
			}
			try {
				await this.process(job);
			} catch (e) {
				// Never the raw message: model, parse and validation errors quote the document's text (the AI SDK's
				// JSONParseError message is "JSON parsing failed: Text: <the whole reply>").
				const message = safeError(e);
				console.error(`${this.deps.log} index ${job.key} failed: ${message}`);
				await this.deps.index.markFailed(job.key, message).catch(() => {});
			} finally {
				this.queued.delete(job.key);
			}
		}
	}

	private async process(job: IndexJob): Promise<void> {
		const { docs, index, extract, embedder } = this.deps;
		const started = Date.now();
		let { data, mimeType, versionId } = job;
		let archivedAt = job.archivedAt;
		if (!data) {
			const got = await stage("download", () => docs.get(job.key));
			if (!got) {
				if (await index.has(job.key)) await index.markFailed(job.key, "missing in S3");
				return;
			}
			data = got.data;
			mimeType = got.contentType;
			versionId ??= got.versionId;
			archivedAt ??= got.lastModified;
		}
		const bytes = data;
		const contentType = (mimeType ?? "application/octet-stream").split(";")[0]?.trim() || "application/octet-stream";
		const description = job.description ?? (await stage("describe", () => docs.describe(job.key)));
		await stage("record", () =>
			index.markPending({
				key: job.key,
				versionId,
				sha256: sha256(bytes),
				bytes: bytes.byteLength,
				contentType,
				description,
				archivedAt: archivedAt ?? this.now().toISOString().slice(0, 10),
			}),
		);
		const name = job.key.slice(job.key.lastIndexOf("/") + 1);
		let x: Extraction;
		let extractedBy: string;
		if (isExtractable(contentType)) {
			x = await stage("extract", () => extract({ name, mimeType: contentType, data: bytes }));
			extractedBy = extract.model;
		} else {
			x = emptyExtraction(name);
			extractedBy = "none";
		}
		const texts = x.text === "" ? [] : chunkText(x.text);
		const vectors = await stage("embed", () => embedder.embed(texts, "document"));
		await stage("store", () =>
			index.markIndexed(
				job.key,
				x,
				extractedBy,
				texts.map((text, i) => ({ text, vector: vectors[i] ?? [] })),
				this.now(),
			),
		);
		console.info(`${this.deps.log} indexed ${job.key} (${texts.length} chunks, ${Date.now() - started} ms)`);
	}
}

/** A failure in one step of reading a document; its message is already safe to log and store. */
class StageError extends Error {}

async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		throw new StageError(`${name}: ${safeError(e)}`);
	}
}

/**
 * What may be logged or stored about an error: never its message text, which for model, parse and validation errors
 * carries the document's content. Only the error's class name, plus an HTTP status or a short code when it has one.
 * Errors from this package's own clients ("Bedrock 429", "OpenRouter 402", "Embeddings 500", "S3 GET 500") are kept:
 * they are built from a status code only.
 */
export function safeError(e: unknown): string {
	if (e instanceof StageError) return e.message;
	if (!(e instanceof Error)) return "unknown error";
	if (/^(Bedrock|OpenRouter|Embeddings|S3 [A-Z]+) \d{3}$/.test(e.message)) return e.message;
	const fields = e as { statusCode?: unknown; status?: unknown; code?: unknown };
	const status = [fields.statusCode, fields.status].find((s) => typeof s === "number");
	const code = typeof fields.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(fields.code) ? fields.code : undefined;
	return [/^[A-Za-z0-9_]{1,60}$/.test(e.name) ? e.name : "Error", status !== undefined ? `status ${status}` : "", code ?? ""].filter(Boolean).join(" ");
}
