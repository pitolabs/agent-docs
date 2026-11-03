// An agent's document archive: a private, versioned S3 bucket, one per agent. The IAM user the agent runs as may list,
// read and write documents/* only (DOCUMENTS_PREFIX); it cannot delete. Keys are documents/YYYY/MM/<kebab-name>.<ext>,
// by the document's own month. An existing key is never overwritten: freeKey picks a "-2" name when proposing, and
// put() uploads only if the key is still free (If-None-Match: *). Two proposals that picked the same free key cannot
// both land: the second gets KeyTaken and is proposed again, never renamed silently after approval. A document may
// carry a one-line description as S3 metadata, so the bucket itself is the index (list shows name, size, date and it).
// People get files through presigned links valid for 7 days.
import { AwsClient } from "aws4fetch";

export interface DocsConfig {
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** `<PREFIX>_DOCS_BUCKET`, `_REGION`, `_AWS_ACCESS_KEY_ID`, `_AWS_SECRET_ACCESS_KEY` (e.g. VILLA, KINE). */
export function docsConfig(prefix: string, env: NodeJS.ProcessEnv = process.env): DocsConfig | { off: string } {
	const bucket = env[`${prefix}_DOCS_BUCKET`] ?? "";
	const region = env[`${prefix}_DOCS_REGION`] ?? "";
	const accessKeyId = env[`${prefix}_DOCS_AWS_ACCESS_KEY_ID`] ?? "";
	const secretAccessKey = env[`${prefix}_DOCS_AWS_SECRET_ACCESS_KEY`] ?? "";
	if (!bucket || !region || !accessKeyId || !secretAccessKey) return { off: `${prefix}_DOCS_* not set` };
	return { bucket, region, accessKeyId, secretAccessKey };
}

/** The approved key was taken by another document after the proposal (S3 412 on If-None-Match). */
export class KeyTaken extends Error {
	constructor(readonly key: string) {
		super(`${key} já existe`);
	}
}

/** Every document key starts with it; the IAM policy grants list, get and put under it only. Fixed: it is the contract. */
export const DOCUMENTS_PREFIX = "documents/";
const KEY = new RegExp(`^${DOCUMENTS_PREFIX}\\d{4}/(0[1-9]|1[0-2])/[a-z0-9][a-z0-9-]*(\\.[a-z0-9]{1,5})?$`);
const LIST_PREFIX = new RegExp(`^${DOCUMENTS_PREFIX}(\\d{4}/((0[1-9]|1[0-2])/)?)?$`);
export const LINK_SECONDS = 7 * 24 * 3600;
/** S3 user metadata is limited to 2 KB per object, headers included; a description stays well under it. */
const DESCRIPTION_MAX = 600;

/** documents/YYYY/MM/<name>: the only keys the agent may write or link. */
export const isDocumentKey = (key: string): boolean => KEY.test(key);

/** kebab-case, lower case, no accents; keeps one extension. "NF Ferragem São José.PDF" -> "nf-ferragem-sao-jose.pdf". */
export function kebabName(name: string): string {
	const folded = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
	const ext = /\.([a-z0-9]{1,5})$/.exec(folded)?.[1];
	const stem = (ext ? folded.slice(0, -ext.length - 1) : folded)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return `${stem || "documento"}${ext ? `.${ext}` : ""}`;
}

export interface Listed {
	key: string;
	kb: number;
	/** When it was archived (S3 LastModified), YYYY-MM-DD. */
	archived: string;
}

export interface Fetched {
	data: Uint8Array<ArrayBuffer>;
	contentType: string;
	versionId?: string;
	/** S3 Last-Modified, YYYY-MM-DD. */
	lastModified?: string;
}

export class DocsArchive {
	private aws: AwsClient;
	private base: string;

	constructor(
		cfg: DocsConfig,
		private http: typeof fetch = fetch,
	) {
		this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region });
		this.base = `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
	}

	private url(key: string): string {
		return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
	}

	private async head(key: string): Promise<Response> {
		return this.http(await this.aws.sign(this.url(key), { method: "HEAD" }));
	}

	async exists(key: string): Promise<boolean> {
		const res = await this.head(key);
		if (res.status === 404 || res.status === 403) return false;
		if (!res.ok) throw new Error(`S3 HEAD ${res.status}`);
		return true;
	}

	/** The description stored with the document, or "" (none, or not found). */
	async describe(key: string): Promise<string> {
		if (!isDocumentKey(key)) throw new Error(`invalid document key ${key}`);
		const res = await this.head(key);
		if (!res.ok) return "";
		const raw = res.headers.get("x-amz-meta-description") ?? "";
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}

	/** A free key: the one asked for, or with -2, -3... before the extension. */
	async freeKey(key: string): Promise<string> {
		if (!isDocumentKey(key)) throw new Error(`invalid document key ${key}`);
		const dot = key.lastIndexOf(".");
		const [stem, ext] = dot > key.lastIndexOf("/") ? [key.slice(0, dot), key.slice(dot)] : [key, ""];
		for (let i = 1; i < 50; i++) {
			const candidate = i === 1 ? key : `${stem}-${i}${ext}`;
			if (!(await this.exists(candidate))) return candidate;
		}
		throw new Error("too many documents with this name");
	}

	/**
	 * Uploads only if `key` does not exist yet; KeyTaken when another document took it since the proposal. The
	 * description travels percent-encoded (S3 metadata is ASCII): accents and line breaks survive the round trip.
	 * Returns the new object's version id (the buckets are versioned).
	 */
	async put(key: string, data: Uint8Array<ArrayBuffer>, contentType: string, description = ""): Promise<{ versionId?: string }> {
		if (!isDocumentKey(key)) throw new Error(`invalid document key ${key}`);
		const headers: Record<string, string> = { "Content-Type": contentType, "If-None-Match": "*" };
		const d = description.trim().slice(0, DESCRIPTION_MAX);
		if (d) headers["x-amz-meta-description"] = encodeURIComponent(d);
		const res = await this.http(await this.aws.sign(this.url(key), { method: "PUT", body: data, headers }));
		if (res.status === 412 || res.status === 409) throw new KeyTaken(key);
		if (!res.ok) throw new Error(`S3 PUT ${res.status}`);
		const versionId = res.headers.get("x-amz-version-id") ?? undefined;
		return versionId ? { versionId } : {};
	}

	/** The document's bytes and headers, or undefined when it does not exist. */
	async get(key: string): Promise<Fetched | undefined> {
		if (!isDocumentKey(key)) throw new Error(`invalid document key ${key}`);
		const res = await this.http(await this.aws.sign(this.url(key), { method: "GET" }));
		if (res.status === 404) return undefined;
		if (!res.ok) throw new Error(`S3 GET ${res.status}`);
		const data = new Uint8Array(await res.arrayBuffer());
		const contentType = res.headers.get("content-type") ?? "application/octet-stream";
		const versionId = res.headers.get("x-amz-version-id") ?? undefined;
		const modified = res.headers.get("last-modified");
		const when = modified ? new Date(modified) : undefined;
		const lastModified = when && !Number.isNaN(when.getTime()) ? when.toISOString().slice(0, 10) : undefined;
		return { data, contentType, ...(versionId ? { versionId } : {}), ...(lastModified ? { lastModified } : {}) };
	}

	/** A presigned GET link, valid for LINK_SECONDS. */
	async link(key: string): Promise<string> {
		if (!isDocumentKey(key)) throw new Error(`invalid document key ${key}`);
		const u = new URL(this.url(key));
		u.searchParams.set("X-Amz-Expires", String(LINK_SECONDS));
		const signed = await this.aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
		return signed.url;
	}

	/**
	 * One page of documents under a prefix (documents/, documents/2026/, documents/2026/11/), with size and date.
	 * `next` is S3's continuation token when there are more: pass it back to get the following page, so nothing past
	 * the first page is ever hidden from the agent.
	 */
	async list(prefix: string, pageSize = 50, token?: string): Promise<{ items: Listed[]; next?: string }> {
		if (!LIST_PREFIX.test(prefix)) throw new Error(`prefix must be ${DOCUMENTS_PREFIX}, ${DOCUMENTS_PREFIX}YYYY/ or ${DOCUMENTS_PREFIX}YYYY/MM/`);
		const u = new URL(`${this.base}/`);
		u.searchParams.set("list-type", "2");
		u.searchParams.set("prefix", prefix);
		u.searchParams.set("max-keys", String(pageSize));
		if (token) u.searchParams.set("continuation-token", token);
		const res = await this.http(await this.aws.sign(u.toString(), { method: "GET" }));
		if (!res.ok) throw new Error(`S3 LIST ${res.status}`);
		const xml = await res.text();
		const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap((m) => {
			const c = m[1] ?? "";
			const key = /<Key>([^<]+)<\/Key>/.exec(c)?.[1] ?? "";
			if (!isDocumentKey(key)) return [];
			const size = Number(/<Size>(\d+)<\/Size>/.exec(c)?.[1] ?? 0);
			const archived = (/<LastModified>([^<]+)<\/LastModified>/.exec(c)?.[1] ?? "").slice(0, 10);
			return [{ key, kb: Math.ceil(size / 1024), archived }];
		});
		const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
		const next = truncated ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
		if (truncated && !next) throw new Error("S3 LIST truncated without a continuation token");
		return { items, ...(next ? { next: next.replaceAll("&amp;", "&") } : {}) };
	}

	/** Every document under a prefix, page after page (200 at a time). */
	async *listAll(prefix: string): AsyncGenerator<Listed> {
		let token: string | undefined;
		do {
			const page = await this.list(prefix, 200, token);
			yield* page.items;
			token = page.next;
		} while (token);
	}
}
