// The document index: what save records, what the indexer reads into it, and what search_documents / read_document
// answer, through the archive tools, a stub S3, a stub extractor (no model) and a stub embedder (hashed bag of words,
// so a query sharing words with a chunk is nearer to it). The approval flow is driven as a host's channel handler
// would: a pass on the request context, files in the gate's inbox, and the proposer's "sim" through gate.onMessage.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { RequestContext } from "@mastra/core/request-context";
import type { Embedder } from "../src/core/embeddings.ts";
import type { Extract, ExtractFile, Extraction } from "../src/core/extract.ts";
import { Indexer } from "../src/core/indexer.ts";
import { LibSQLDocumentStore } from "../src/core/libsql-store.ts";
import { ApprovalGate, type InboxFile } from "../src/mastra/approval.ts";
import { grantPass } from "../src/mastra/pass.ts";
import { archiveTools } from "../src/mastra/tools.ts";
import { stubS3 } from "./stub-s3.ts";

/** A fictional WhatsApp number (a US 555 one; the tools never parse it): the sender of every message below. */
const SENDER = "12025550123";
const CONVERSATION = "whatsapp:dm-ana";
const MODEL = "stub-embed";
const DIMS = 1024;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Words folded like FTS (lower case, no accents), each hashed into one of 1024 dimensions; unit length. */
const stubEmbedder = (): Embedder => ({
	model: MODEL,
	dims: DIMS,
	embed: async (texts) =>
		texts.map((t) => {
			const v = new Array<number>(DIMS).fill(0);
			for (const w of t
				.normalize("NFD")
				.replace(/\p{M}/gu, "")
				.toLowerCase()
				.split(/[^\p{L}\p{N}]+/u)) {
				if (w.length < 2) continue;
				let h = 0;
				for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
				v[h % DIMS] = (v[h % DIMS] ?? 0) + 1;
			}
			const norm = Math.hypot(...v) || 1;
			return v.map((x) => x / norm);
		}),
});

/** Fixed metadata, the file's own bytes as text; `hold` delays every extraction until released. */
function stubExtract(opts: { fail?: boolean; hold?: Promise<void> } = {}) {
	const calls: string[] = [];
	const fn = async (file: ExtractFile): Promise<Extraction> => {
		calls.push(file.name);
		await opts.hold;
		if (opts.fail) throw new Error("model unavailable");
		return {
			type: "contract",
			title: "Contrato de prestação de serviços contábeis",
			parties: ["Asclepius Labs", "Escritório Contábil X"],
			document_date: "2026-11-03",
			deadlines: [{ date: "2027-10-31", description: "fim da vigência" }],
			summary: "Contrato de contabilidade mensal.",
			language: "pt",
			text: Buffer.from(file.data).toString(),
		};
	};
	return { extract: Object.assign(fn, { model: "stub-model" }) as Extract, calls };
}

async function setup(opts: { url?: string; bucket?: string; extract?: Extract } = {}) {
	const s3 = stubS3(opts.bucket ?? "bucket-a");
	const opened = await LibSQLDocumentStore.open({ url: opts.url ?? ":memory:" }, { bucket: opts.bucket ?? "bucket-a", embeddingsModel: MODEL, dims: DIMS });
	if ("off" in opened) throw new Error(opened.off);
	const index = opened;
	const embedder = stubEmbedder();
	const ex = stubExtract();
	const indexer = new Indexer({ docs: s3.docs, index, extract: opts.extract ?? ex.extract, embedder, log: "[test]" });
	const gate = new ApprovalGate();
	const tools = archiveTools({
		gate,
		docs: s3.docs,
		index,
		indexer,
		embedder,
		where: "WhatsApp da empresa",
		archiveName: "no arquivo da empresa",
	});
	return { s3, index, indexer, gate, tools, extractCalls: ex.calls };
}

type Exec = (input: unknown, c: unknown) => Promise<Record<string, unknown>>;
const exec = (t: { execute?: unknown }) => t.execute as Exec;
const anyCtx = { requestContext: new RequestContext() };
type Tools = ReturnType<typeof archiveTools>;

/**
 * What a channel handler does for each admitted message: a receipt, the gate told about the message (approving or
 * dropping a proposal), the turn's files in the inbox, a pass on the run's context. "guarda ..." then proposes the
 * attached file; anything else runs save.
 */
function whatsapp(tools: Tools, gate: ApprovalGate, name = "contrato-contabilidade-2026-11-03.pdf") {
	const results: Record<string, unknown>[] = [];
	const send = async (text: string, doc?: { name: string; body: string; mimeType?: string }) => {
		const receipt = gate.receive();
		gate.onMessage(CONVERSATION, SENDER, text, receipt);
		const files: InboxFile[] = doc ? [{ name: doc.name, mimeType: doc.mimeType ?? "application/pdf", data: Uint8Array.from(Buffer.from(doc.body)) }] : [];
		gate.setFiles(CONVERSATION, files);
		const rc = new RequestContext();
		grantPass(rc, { conversation: CONVERSATION, sender: SENDER });
		const c = { requestContext: rc };
		results.push(
			text.startsWith("guarda")
				? await exec(tools.propose_file)(
						{
							index: 0,
							year: 2026,
							month: 11,
							name,
							description: "Contrato de contabilidade com o escritório X, vigência até 2027-10",
							reason: "contrato",
						},
						c,
					)
				: await exec(tools.save)({}, c),
		);
	};
	return { send, results };
}

const BODY = "Cláusula 1. O escritório presta serviços de contabilidade mensal.\n\nCláusula 2. Honorários pagos por boleto até o dia 10.";

describe("archiving a document indexes it", () => {
	test("save leaves it pending; the indexer reads it; search finds it by words without accents, by meaning, by deadline; read_document returns its text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "idx-"));
		const url = `file:${join(dir, "docs.db")}`;
		const { promise: hold, resolve: release } = Promise.withResolvers<void>();
		const { extract } = stubExtract({ hold });
		const h = await setup({ url, extract });
		const wa = whatsapp(h.tools, h.gate);
		await wa.send("guarda isso", { name: "Contrato.pdf", body: BODY });
		await wa.send("sim");
		const key = "documents/2026/11/contrato-contabilidade-2026-11-03.pdf";
		expect(wa.results[1]).toMatchObject({ file: key, indexing: "in-progress" });
		expect(await h.index.get(key)).toMatchObject({ state: "pending", versionId: "v1", contentType: "application/pdf" });
		release();
		await h.indexer.drain();
		expect(await h.index.get(key)).toMatchObject({
			state: "indexed",
			type: "contract",
			parties: ["Asclepius Labs", "Escritório Contábil X"],
			deadlines: [{ date: "2027-10-31", description: "fim da vigência" }],
			extractedBy: "stub-model",
		});

		const search = (input: Record<string, unknown>) =>
			exec(h.tools.search_documents)({ limit: 8, ...input }, anyCtx) as Promise<{
				documents: { path: string; snippet: string; state: string }[];
				indexed: number;
			}>;
		const byWords = await search({ query: "prestacao servicos" });
		expect(byWords.documents.map((d) => d.path)).toEqual([key]);
		expect(byWords.documents[0]?.snippet).toContain("[prestação]");
		expect(byWords.indexed).toBe(1);

		// Keywords gone: "honorarios boleto" appears only in the body, and is still found through the chunk vectors.
		const raw = createClient({ url });
		await raw.execute("DELETE FROM documents_fts");
		raw.close();
		const byMeaning = await search({ query: "honorarios boleto" });
		expect(byMeaning.documents.map((d) => d.path)).toEqual([key]);
		expect(byMeaning.documents[0]?.snippet).toContain("Honorários");

		expect((await search({ due_by: "2027-12-31" })).documents.map((d) => d.path)).toEqual([key]);
		expect((await search({ due_by: "2026-01-01" })).documents).toEqual([]);
		expect((await search({ type: "invoice" })).documents).toEqual([]);
		expect((await search({ year: 2026 })).documents.map((d) => d.path)).toEqual([key]);

		const read = await exec(h.tools.read_document)({ path: `s3:${key}`, offset: 0 }, anyCtx);
		expect(read).toMatchObject({
			path: key,
			text: BODY,
			total_chars: BODY.length,
			title: "Contrato de prestação de serviços contábeis",
		});
		expect(read.next_offset).toBeUndefined();
		h.index.close();
	});

	test('save without a prior yes is refused; "yes, but…" drops the proposal; an English "yes" archives, once', async () => {
		const h = await setup();
		const wa = whatsapp(h.tools, h.gate);
		await wa.send("guarda isso", { name: "Contrato.pdf", body: BODY });
		await wa.send("e o título?");
		expect(wa.results[1]).toMatchObject({ refused: expect.stringContaining("não há proposta pendente") });
		await wa.send("guarda isso", { name: "Contrato.pdf", body: BODY });
		await wa.send("yes, but change the title");
		expect(wa.results[3]).toMatchObject({ refused: expect.stringContaining("não há proposta pendente") });
		await wa.send("guarda isso", { name: "Contrato.pdf", body: BODY });
		await wa.send("yes");
		expect(wa.results[5]).toMatchObject({ file: "documents/2026/11/contrato-contabilidade-2026-11-03.pdf" });
		await wa.send("yes");
		expect(wa.results[6]).toMatchObject({ refused: expect.stringContaining("não há proposta pendente") });
		await h.indexer.drain();
	});

	test("the same bytes proposed again carry a warning naming the archived copy", async () => {
		const h = await setup();
		const wa = whatsapp(h.tools, h.gate);
		await wa.send("guarda isso", { name: "Contrato.pdf", body: BODY });
		expect(wa.results[0]?.warning).toBeUndefined();
		await wa.send("sim");
		await wa.send("guarda de novo", { name: "Contrato (1).pdf", body: BODY });
		expect(wa.results[2]).toMatchObject({
			warning: "um arquivo idêntico já está arquivado em documents/2026/11/contrato-contabilidade-2026-11-03.pdf",
		});
		await h.indexer.drain();
	});

	test("an office document is indexed without the model, by name and description", async () => {
		const h = await setup();
		const wa = whatsapp(h.tools, h.gate, "ata-reuniao-socios-2026-11-03.docx");
		await wa.send("guarda isso", { name: "Ata.docx", body: "PK binary", mimeType: DOCX });
		await wa.send("sim");
		await h.indexer.drain();
		expect(h.extractCalls).toEqual([]);
		const key = "documents/2026/11/ata-reuniao-socios-2026-11-03.docx";
		expect(await h.index.get(key)).toMatchObject({ state: "indexed", text: "", extractedBy: "none" });
		const found = await exec(h.tools.search_documents)({ query: "escritório vigência", limit: 8 }, anyCtx);
		expect((found.documents as { path: string }[]).map((d) => d.path)).toEqual([key]);
	});
});

describe("keyword search on a question", () => {
	test("Portuguese function words do not outvote the word that matters", async () => {
		const h = await setup();
		const fn = Object.assign(
			async (file: ExtractFile): Promise<Extraction> => ({
				type: "other",
				title: file.name,
				parties: [],
				document_date: null,
				deadlines: [],
				summary: "",
				language: "pt",
				text: Buffer.from(file.data).toString(),
			}),
			{ model: "stub-model" },
		);
		const keywordsOnly = new Indexer({
			docs: h.s3.docs,
			index: h.index,
			extract: fn,
			embedder: stubEmbedder(),
			log: "[test]",
		});
		const doc = (key: string, text: string) =>
			keywordsOnly.enqueue({
				key,
				data: Uint8Array.from(Buffer.from(text)),
				mimeType: "application/pdf",
				description: "",
			});
		doc(
			"documents/2026/10/conta-luz.pdf",
			"Fatura da energia elétrica da casa, em nome de quem paga a minha conta de luz, com o valor da minha fatura de outubro.",
		);
		doc("documents/2026/11/contrato.pdf", "Contrato de serviços de contabilidade mensal com o escritório.");
		await keywordsOnly.drain();
		const hits = await h.index.search({ query: "quem cuida da minha contabilidade?", limit: 2 });
		expect(hits[0]?.key).toBe("documents/2026/11/contrato.pdf");
	});
});

describe("search when the embedder cannot embed the query", () => {
	test("falls back to keywords, says so in the result, and records it in the index meta", async () => {
		const url = `file:${join(mkdtempSync(join(tmpdir(), "idx-")), "docs.db")}`;
		const h = await setup({ url });
		const key = "documents/2026/11/contrato.pdf";
		h.indexer.enqueue({
			key,
			data: Uint8Array.from(Buffer.from(BODY)),
			mimeType: "application/pdf",
			description: "contrato",
		});
		await h.indexer.drain();
		const throttled: Embedder = {
			model: MODEL,
			dims: DIMS,
			embed: async () => Promise.reject(new Error("Bedrock 429")),
		};
		const tools = archiveTools({
			gate: h.gate,
			docs: h.s3.docs,
			index: h.index,
			embedder: throttled,
			where: "WhatsApp da empresa",
			archiveName: "no arquivo da empresa",
			log: "[test]",
		});
		const r = await exec(tools.search_documents)({ query: "honorarios boleto", limit: 8 }, anyCtx);
		expect(r).toMatchObject({ search_mode: "keyword-only", warning: expect.stringContaining("só por palavras") });
		expect((r.documents as { path: string }[]).map((d) => d.path)).toEqual([key]);
		const ok = await exec(h.tools.search_documents)({ query: "honorarios boleto", limit: 8 }, anyCtx);
		expect(ok.search_mode).toBeUndefined();
		h.index.close();
		const meta = createClient({ url });
		const rows = (await meta.execute("SELECT key, value FROM meta WHERE key LIKE 'semantic_%' ORDER BY key")).rows.map((x) => [String(x.key), String(x.value)]);
		meta.close();
		expect(rows[0]).toEqual(["semantic_failures", "1"]);
		expect(rows[1]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ Bedrock 429$/);
	});
});

describe("each agent's index is its own", () => {
	test("the same key in two indexes keeps each agent's text; one agent's words find nothing in the other's", async () => {
		const first = await setup({ bucket: "bucket-a" });
		const second = await setup({ bucket: "bucket-b" });
		const key = "documents/2026/11/contrato.pdf";
		first.indexer.enqueue({
			key,
			data: Uint8Array.from(Buffer.from("Sociedade Asclepius fisioterapia software")),
			mimeType: "application/pdf",
			description: "contrato social",
		});
		second.indexer.enqueue({
			key,
			data: Uint8Array.from(Buffer.from("Comodato da cabana Casa Lua em Garopaba")),
			mimeType: "application/pdf",
			description: "comodato",
		});
		await Promise.all([first.indexer.drain(), second.indexer.drain()]);
		const secondSearch = await exec(second.tools.search_documents)({ query: "fisioterapia software", limit: 8 }, anyCtx);
		const hits = secondSearch.documents as { path: string; snippet: string }[];
		// The vector list always returns its nearest chunks; what matters is that the first agent's text never comes back.
		expect(hits.every((d) => !d.snippet.includes("fisioterapia"))).toBe(true);
		expect((await second.index.get(key))?.text).toBe("Comodato da cabana Casa Lua em Garopaba");
		expect((await first.index.get(key))?.text).toBe("Sociedade Asclepius fisioterapia software");
	});

	test("a file built for one bucket is refused for another, and for another embeddings model", async () => {
		const url = `file:${join(mkdtempSync(join(tmpdir(), "idx-")), "docs.db")}`;
		const first = await LibSQLDocumentStore.open({ url }, { bucket: "bucket-a", embeddingsModel: MODEL, dims: DIMS });
		if ("off" in first) throw new Error(first.off);
		first.close();
		expect(await LibSQLDocumentStore.open({ url }, { bucket: "bucket-b", embeddingsModel: MODEL, dims: DIMS })).toEqual({
			off: expect.stringContaining("belongs to bucket bucket-a"),
		});
		expect(await LibSQLDocumentStore.open({ url }, { bucket: "bucket-a", embeddingsModel: "other-model", dims: DIMS })).toEqual({
			off: expect.stringContaining("delete the file"),
		});
	});
});

describe("the indexer queue", () => {
	test("a document enqueued while the worker is finishing its last job is still read", async () => {
		// Sweeps every microtask depth after the last job's write, so whichever one lands between the worker seeing an
		// empty queue and it being marked idle is covered.
		for (let depth = 0; depth <= 30; depth++) {
			const h = await setup();
			const markIndexed = h.index.markIndexed.bind(h.index);
			let fired = false;
			h.index.markIndexed = async (...args: Parameters<typeof markIndexed>) => {
				await markIndexed(...args);
				if (fired) return;
				fired = true;
				let tick: Promise<void> = Promise.resolve();
				for (let i = 0; i < depth; i++) tick = tick.then(() => undefined);
				void tick.then(() =>
					h.indexer.enqueue({
						key: "documents/2026/11/b.pdf",
						data: Uint8Array.from(Buffer.from("B")),
						mimeType: "application/pdf",
						description: "b",
					}),
				);
			};
			h.indexer.enqueue({
				key: "documents/2026/11/a.pdf",
				data: Uint8Array.from(Buffer.from("A")),
				mimeType: "application/pdf",
				description: "a",
			});
			await h.indexer.drain();
			await new Promise((r) => setTimeout(r, 0));
			await h.indexer.drain();
			expect({ depth, state: (await h.index.get("documents/2026/11/b.pdf"))?.state }).toEqual({
				depth,
				state: "indexed",
			});
			h.index.close();
		}
	});
});

describe("errors never carry the document's text", () => {
	test("a parse error quoting the model's reply is logged and stored as its type and stage only", async () => {
		const SENTINEL = "PIN 4821 PUK 99887766 exame HIV negativo";
		// The shape of the AI SDK's JSONParseError: the whole reply in the message, the class name in `name`.
		const leaky = Object.assign(
			async (): Promise<Extraction> => {
				throw Object.assign(new Error(`JSON parsing failed: Text: {"text": "${SENTINEL}"`), { name: "AI_JSONParseError" });
			},
			{ model: "stub-model" },
		);
		const h = await setup({ extract: leaky });
		const logged: string[] = [];
		const original = { error: console.error, warn: console.warn, info: console.info };
		for (const k of ["error", "warn", "info"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
		try {
			h.indexer.enqueue({
				key: "documents/2026/10/chip.jpeg",
				data: Uint8Array.from(Buffer.from("x")),
				mimeType: "image/jpeg",
				description: "chip",
			});
			await h.indexer.drain();
		} finally {
			Object.assign(console, original);
		}
		const row = await h.index.get("documents/2026/10/chip.jpeg");
		expect(row).toMatchObject({ state: "failed", error: "extract: AI_JSONParseError" });
		expect(logged.join("\n")).toContain("extract: AI_JSONParseError");
		expect(logged.join("\n")).not.toContain("4821");
		expect(row?.error).not.toContain("4821");
	});

	test("a query that cannot be embedded is not echoed into the log or the index meta", async () => {
		const url = `file:${join(mkdtempSync(join(tmpdir(), "idx-")), "docs.db")}`;
		const h = await setup({ url });
		const echoes: Embedder = {
			model: MODEL,
			dims: DIMS,
			embed: async (texts) => Promise.reject(new TypeError(`cannot embed ${texts.join(" ")}`)),
		};
		const tools = archiveTools({
			gate: h.gate,
			docs: h.s3.docs,
			index: h.index,
			embedder: echoes,
			where: "WhatsApp da empresa",
			archiveName: "no arquivo da empresa",
			log: "[test]",
		});
		const logged: string[] = [];
		const warn = console.warn;
		console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
		try {
			await exec(tools.search_documents)({ query: "resultado do exame de HIV da paciente Z", limit: 8 }, anyCtx);
		} finally {
			console.warn = warn;
		}
		h.index.close();
		const meta = createClient({ url });
		const last = String((await meta.execute("SELECT value FROM meta WHERE key = 'semantic_last_failure'")).rows[0]?.value);
		meta.close();
		expect(last).toMatch(/ TypeError$/);
		expect(`${logged.join("\n")}\n${last}`).not.toContain("HIV");
	});
});

describe("the reconcile sweep", () => {
	test("indexes what S3 has and the index lacks, skips write probes, retries failures up to 3 attempts", async () => {
		const failing = stubExtract({ fail: true });
		const h = await setup({ extract: failing.extract });
		h.s3.objects.set("/documents/2026/10/recibo-aluguel.pdf", {
			body: "Recibo de aluguel",
			meta: encodeURIComponent("Recibo do aluguel de outubro"),
		});
		h.s3.objects.set("/documents/0000/01/verify-probe-1.txt", { body: "verify", meta: "" });

		expect(await h.indexer.reconcile()).toEqual({ enqueued: 1 });
		await h.indexer.drain();
		const key = "documents/2026/10/recibo-aluguel.pdf";
		expect(await h.index.get(key)).toMatchObject({
			state: "failed",
			attempts: 1,
			error: "extract: Error",
			description: "Recibo do aluguel de outubro",
			archivedAt: "2026-11-03",
		});
		expect(await h.index.has("documents/0000/01/verify-probe-1.txt")).toBe(false);

		for (const attempts of [2, 3]) {
			expect(await h.indexer.reconcile()).toEqual({ enqueued: 1 });
			await h.indexer.drain();
			expect((await h.index.get(key))?.attempts).toBe(attempts);
		}
		expect(await h.indexer.reconcile()).toEqual({ enqueued: 0 });
		expect(failing.calls).toHaveLength(3);
	});

	test("a failed document is read on a later sweep once the model is back", async () => {
		let fail = true;
		const fn = Object.assign(
			async (file: ExtractFile): Promise<Extraction> => {
				if (fail) throw new Error("model unavailable");
				return {
					type: "receipt",
					title: "Recibo",
					parties: [],
					document_date: null,
					deadlines: [],
					summary: "Recibo.",
					language: "pt",
					text: Buffer.from(file.data).toString(),
				};
			},
			{ model: "stub-model" },
		);
		const h = await setup({ extract: fn });
		h.s3.objects.set("/documents/2026/10/recibo.pdf", { body: "Recibo de aluguel", meta: "" });
		await h.indexer.reconcile();
		await h.indexer.drain();
		fail = false;
		await h.indexer.reconcile();
		await h.indexer.drain();
		expect(await h.index.get("documents/2026/10/recibo.pdf")).toMatchObject({
			state: "indexed",
			text: "Recibo de aluguel",
			error: undefined,
		});
	});
});
