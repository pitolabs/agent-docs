// The libSQL DocumentStore: one database per agent (a `file:` next to the bucket it indexes, `:memory:`, or a remote
// `libsql://` URL with an auth token), never shared with another agent, as the buckets are not. It holds what the
// extractor read from each archived document (full text, type, title, parties, dates, deadlines, summary), an FTS5
// table for keyword search (accents folded) and chunk embeddings for semantic search (exact cosine scan; small
// archives). S3 stays the source of truth: the database is derived state, rebuilt by deleting it (the indexer's sweep
// re-reads S3).
//
// A row goes pending (archived, not read yet) -> indexed, or failed (attempts counted, retried by the sweep). The meta
// table pins the bucket and the embeddings model: opening a database built for another bucket or model is refused.
import { type Client, createClient, type InStatement, type Row } from "@libsql/client";
import type { Extraction } from "./extract.ts";
import type { Deadline, DocRow, DocState, DocumentStore, Hit, SearchArgs } from "./store.ts";

export interface IndexConfig {
	/** Any @libsql/client URL: `file:/data/docs.db`, `:memory:`, `libsql://<db>.turso.io`. */
	url: string;
	/** For remote (`libsql://`) databases. */
	authToken?: string;
}

/** `<PREFIX>_DOCS_DB` (e.g. KINE_DOCS_DB=file:/data/docs-kine.db); off when unset. */
export function indexConfig(prefix: string, env: NodeJS.ProcessEnv = process.env): IndexConfig | { off: string } {
	const url = env[`${prefix}_DOCS_DB`] ?? "";
	return url ? { url } : { off: `${prefix}_DOCS_DB not set` };
}

const SCHEMA_VERSION = "1";
/** Candidates each ranked list (keywords, vectors) contributes to the fusion. */
const CANDIDATES = 20;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const json = <T>(v: unknown, fallback: T): T => {
	try {
		return typeof v === "string" ? (JSON.parse(v) as T) : fallback;
	} catch {
		return fallback;
	}
};

function toRow(r: Row): DocRow {
	return {
		key: String(r.key),
		versionId: str(r.version_id),
		sha256: String(r.sha256),
		bytes: Number(r.bytes),
		contentType: String(r.content_type),
		description: String(r.description ?? ""),
		state: String(r.state) as DocState,
		attempts: Number(r.attempts),
		error: str(r.error),
		type: str(r.type),
		title: str(r.title),
		parties: json<string[]>(r.parties, []),
		documentDate: str(r.document_date),
		deadlines: json<Deadline[]>(r.deadlines, []),
		summary: str(r.summary),
		language: str(r.language),
		text: String(r.text ?? ""),
		extractedBy: str(r.extracted_by),
		archivedAt: String(r.archived_at),
		indexedAt: str(r.indexed_at),
	};
}

/**
 * Portuguese function words, folded like the FTS tokenizer (lower case, no accents). In a question ("quem cuida da
 * minha contabilidade?") they match nearly every document and outvote the one word that matters.
 */
const STOPWORDS = new Set(
	"a ao aos as com como da das de do dos e em entre esta este eu foi ha isso isto ja la mais mas me meu minha muito na nas nem no nos o onde os ou para pela pelo por qual quais quando que quem se sem ser seu sua sao tem um uma umas uns voce".split(
		" ",
	),
);
const fold = (w: string): string => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** FTS5 expression: every word of 2+ letters or digits that is not a stopword, quoted, OR'ed. Empty when none is left. */
export function ftsQuery(query: string): string {
	const words = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOPWORDS.has(fold(w)));
	return [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
}

export class LibSQLDocumentStore implements DocumentStore {
	private constructor(private db: Client) {}

	static async open(cfg: IndexConfig, opts: { bucket: string; embeddingsModel: string; dims: number }): Promise<LibSQLDocumentStore | { off: string }> {
		if (!Number.isInteger(opts.dims) || opts.dims <= 0) throw new Error(`invalid dims ${opts.dims}`);
		const db = createClient({ url: cfg.url, ...(cfg.authToken ? { authToken: cfg.authToken } : {}) });
		try {
			// As LibSQLStore does: readers never block the writer, and a busy file waits instead of failing. Only for a
			// local file: a remote database manages its own journal, and :memory: has none.
			if (cfg.url.startsWith("file:")) {
				await db.execute("PRAGMA journal_mode=WAL");
				await db.execute("PRAGMA busy_timeout=5000");
			}
			await db.batch(
				[
					"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
					`CREATE TABLE IF NOT EXISTS documents (
						key TEXT PRIMARY KEY, version_id TEXT, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, content_type TEXT NOT NULL,
						description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL CHECK (state IN ('pending','indexed','failed')),
						attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
						type TEXT, title TEXT, parties TEXT NOT NULL DEFAULT '[]', document_date TEXT, deadlines TEXT NOT NULL DEFAULT '[]',
						summary TEXT, language TEXT, text TEXT NOT NULL DEFAULT '', extracted_by TEXT,
						archived_at TEXT NOT NULL, indexed_at TEXT)`,
					"CREATE INDEX IF NOT EXISTS documents_sha ON documents(sha256)",
					"CREATE INDEX IF NOT EXISTS documents_state ON documents(state)",
					"CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(key UNINDEXED, title, parties, description, summary, text, tokenize='unicode61 remove_diacritics 2')",
					`CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, key TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, embedding F32_BLOB(${opts.dims}) NOT NULL)`,
					"CREATE INDEX IF NOT EXISTS chunks_key ON chunks(key)",
				],
				"write",
			);
			const meta = new Map((await db.execute("SELECT key, value FROM meta")).rows.map((r) => [String(r.key), String(r.value)]));
			const bucket = meta.get("bucket");
			if (bucket !== undefined && bucket !== opts.bucket) {
				db.close();
				return { off: `${cfg.url} belongs to bucket ${bucket}, not ${opts.bucket}` };
			}
			const model = meta.get("embeddings_model");
			const dims = meta.get("dims");
			if ((model !== undefined && model !== opts.embeddingsModel) || (dims !== undefined && dims !== String(opts.dims))) {
				db.close();
				return { off: `${cfg.url} was built with ${model ?? "?"} (${dims ?? "?"} dims); delete the file to re-index with ${opts.embeddingsModel}` };
			}
			await db.batch(
				[
					["schema_version", SCHEMA_VERSION],
					["bucket", opts.bucket],
					["embeddings_model", opts.embeddingsModel],
					["dims", String(opts.dims)],
				].map(([k, v]) => ({
					sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					args: [k ?? "", v ?? ""],
				})),
				"write",
			);
			return new LibSQLDocumentStore(db);
		} catch (e) {
			db.close();
			throw e;
		}
	}

	async has(key: string): Promise<boolean> {
		return (await this.db.execute({ sql: "SELECT 1 FROM documents WHERE key = ?", args: [key] })).rows.length > 0;
	}

	async get(key: string): Promise<DocRow | undefined> {
		const r = (await this.db.execute({ sql: "SELECT * FROM documents WHERE key = ?", args: [key] })).rows[0];
		return r ? toRow(r) : undefined;
	}

	/** The keys of archived documents with these exact bytes, oldest first (callers may see only some of them). */
	async keysBySha(sha256: string): Promise<string[]> {
		const { rows } = await this.db.execute({ sql: "SELECT key FROM documents WHERE sha256 = ? ORDER BY archived_at, key", args: [sha256] });
		return rows.map((r) => String(r.key));
	}

	/** Records an archived document before it is read; a no-op when the key is already known. */
	async markPending(row: Pick<DocRow, "key" | "versionId" | "sha256" | "bytes" | "contentType" | "description" | "archivedAt">): Promise<void> {
		await this.db.batch(
			[
				{
					sql: "INSERT OR IGNORE INTO documents (key, version_id, sha256, bytes, content_type, description, state, archived_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
					args: [row.key, row.versionId ?? null, row.sha256, row.bytes, row.contentType, row.description, row.archivedAt],
				},
				// Findable by its description while it waits to be read.
				{
					sql: "INSERT INTO documents_fts (key, title, parties, description, summary, text) SELECT ?, '', '', ?, '', '' WHERE NOT EXISTS (SELECT 1 FROM documents_fts WHERE key = ?)",
					args: [row.key, row.description, row.key],
				},
			],
			"write",
		);
	}

	/** Stores what was read and its chunk vectors, replacing any earlier FTS row and chunks, in one transaction. */
	async markIndexed(key: string, x: Extraction, extractedBy: string, chunks: { text: string; vector: number[] }[], now = new Date()): Promise<void> {
		const stmts: InStatement[] = [
			{
				sql: `UPDATE documents SET state = 'indexed', error = NULL, type = ?, title = ?, parties = ?, document_date = ?, deadlines = ?,
					summary = ?, language = ?, text = ?, extracted_by = ?, indexed_at = ? WHERE key = ?`,
				args: [
					x.type,
					x.title,
					JSON.stringify(x.parties),
					x.document_date,
					JSON.stringify(x.deadlines),
					x.summary,
					x.language,
					x.text,
					extractedBy,
					now.toISOString(),
					key,
				],
			},
			{ sql: "DELETE FROM documents_fts WHERE key = ?", args: [key] },
			{
				sql: "INSERT INTO documents_fts (key, title, parties, description, summary, text) SELECT key, title, ?, description, summary, text FROM documents WHERE key = ?",
				args: [x.parties.join("; "), key],
			},
			{ sql: "DELETE FROM chunks WHERE key = ?", args: [key] },
			...chunks.map((c, i) => ({
				sql: "INSERT INTO chunks (key, position, text, embedding) VALUES (?, ?, ?, vector32(?))",
				args: [key, i, c.text, JSON.stringify(c.vector)],
			})),
		];
		await this.db.batch(stmts, "write");
	}

	async markFailed(key: string, error: string): Promise<void> {
		await this.db.execute({ sql: "UPDATE documents SET state = 'failed', attempts = attempts + 1, error = ? WHERE key = ?", args: [error.slice(0, 500), key] });
	}

	/** Documents still to be read: pending or failed, with fewer than `max` failed attempts. */
	async retryable(max = 3): Promise<string[]> {
		const { rows } = await this.db.execute({
			sql: "SELECT key FROM documents WHERE state IN ('pending', 'failed') AND attempts < ? ORDER BY archived_at, key",
			args: [max],
		});
		return rows.map((r) => String(r.key));
	}

	private filters(a: SearchArgs): { sql: string; args: (string | number)[] } {
		const where: string[] = [];
		const args: (string | number)[] = [];
		if (a.type) {
			where.push("d.type = ?");
			args.push(a.type);
		}
		if (a.year !== undefined) {
			where.push("(d.document_date LIKE ? OR d.key LIKE ?)");
			args.push(`${a.year}-%`, `documents/${a.year}/%`);
		}
		if (a.dueBy) {
			where.push("EXISTS (SELECT 1 FROM json_each(d.deadlines) j WHERE json_extract(j.value, '$.date') <= ?)");
			args.push(a.dueBy);
		}
		return { sql: where.length ? where.join(" AND ") : "1", args };
	}

	private async rowsByKey(keys: string[]): Promise<Map<string, DocRow>> {
		if (!keys.length) return new Map();
		const { rows } = await this.db.execute({ sql: `SELECT * FROM documents WHERE key IN (${keys.map(() => "?").join(", ")})`, args: keys });
		return new Map(rows.map((r) => [String(r.key), toRow(r)]));
	}

	private static hit(d: DocRow, snippet: string): Hit {
		return {
			key: d.key,
			title: d.title,
			type: d.type,
			documentDate: d.documentDate,
			parties: d.parties,
			deadlines: d.deadlines,
			summary: d.summary,
			snippet,
			state: d.state,
		};
	}

	/**
	 * Hybrid search. Without a query: the filtered documents, newest document date first. With one: keyword (FTS5,
	 * BM25) and, when a query vector is given, semantic (closest chunk per document) candidates, merged by reciprocal
	 * rank fusion.
	 */
	async search(a: SearchArgs): Promise<Hit[]> {
		const f = this.filters(a);
		const expr = a.query ? ftsQuery(a.query) : "";
		if (!expr && !a.queryVector) {
			const { rows } = await this.db.execute({
				sql: `SELECT * FROM documents d WHERE ${f.sql} ORDER BY d.document_date DESC NULLS LAST, d.archived_at DESC, d.key LIMIT ?`,
				args: [...f.args, a.limit],
			});
			return rows.map((r) => {
				const d = toRow(r);
				return LibSQLDocumentStore.hit(d, d.summary ?? "");
			});
		}
		const lists: string[][] = [];
		const snippets = new Map<string, string>();
		const best = new Map<string, string>();
		if (expr) {
			const { rows } = await this.db.execute({
				sql: `SELECT f.key AS key, bm25(documents_fts) AS s, snippet(documents_fts, -1, '[', ']', '…', 12) AS snippet
					FROM documents_fts f JOIN documents d ON d.key = f.key WHERE documents_fts MATCH ? AND ${f.sql} ORDER BY s LIMIT ${CANDIDATES}`,
				args: [expr, ...f.args],
			});
			lists.push(rows.map((r) => String(r.key)));
			for (const r of rows) if (typeof r.snippet === "string" && r.snippet) snippets.set(String(r.key), r.snippet);
		}
		if (a.queryVector) {
			const v = JSON.stringify(a.queryVector);
			const { rows } = await this.db.execute({
				sql: `SELECT c.key AS key, MIN(vector_distance_cos(c.embedding, vector32(?))) AS dist,
					(SELECT text FROM chunks WHERE key = c.key ORDER BY vector_distance_cos(embedding, vector32(?)) LIMIT 1) AS best
					FROM chunks c JOIN documents d ON d.key = c.key WHERE ${f.sql} GROUP BY c.key ORDER BY dist LIMIT ${CANDIDATES}`,
				args: [v, v, ...f.args],
			});
			lists.push(rows.map((r) => String(r.key)));
			for (const r of rows) if (typeof r.best === "string") best.set(String(r.key), r.best);
		}
		const score = new Map<string, number>();
		for (const list of lists) {
			list.forEach((k, rank) => {
				score.set(k, (score.get(k) ?? 0) + 1 / (RRF_K + rank + 1));
			});
		}
		const top = [...score]
			.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
			.slice(0, a.limit)
			.map(([k]) => k);
		const docs = await this.rowsByKey(top);
		return top.flatMap((k) => {
			const d = docs.get(k);
			if (!d) return [];
			return [LibSQLDocumentStore.hit(d, snippets.get(k) ?? best.get(k)?.slice(0, 200) ?? d.summary ?? "")];
		});
	}

	/**
	 * Records that a search fell back to keywords because the query could not be embedded: how many times, and the last
	 * time and reason, in `meta` (semantic_failures, semantic_last_failure). check-index.mjs reports them.
	 */
	async noteSemanticFailure(error: string, now = new Date()): Promise<void> {
		await this.db.batch(
			[
				{
					sql: "INSERT INTO meta (key, value) VALUES ('semantic_failures', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
					args: [],
				},
				{
					sql: "INSERT INTO meta (key, value) VALUES ('semantic_last_failure', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
					args: [`${now.toISOString()} ${error.slice(0, 200)}`],
				},
			],
			"write",
		);
	}

	async stats(): Promise<{ total: number; indexed: number; pending: number; failed: number }> {
		const { rows } = await this.db.execute("SELECT state, COUNT(*) AS n FROM documents GROUP BY state");
		const by = new Map(rows.map((r) => [String(r.state), Number(r.n)]));
		const indexed = by.get("indexed") ?? 0;
		const pending = by.get("pending") ?? 0;
		const failed = by.get("failed") ?? 0;
		return { total: indexed + pending + failed, indexed, pending, failed };
	}

	close(): void {
		this.db.close();
	}
}
