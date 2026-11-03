// The document index behind the indexer and the tools: what the extractor read from each archived document (full
// text, type, title, parties, dates, deadlines, summary), keyword search and semantic search over chunk vectors. S3
// stays the source of truth: a store is derived state, rebuilt by dropping it (the indexer's sweep re-reads S3).
//
// A row goes pending (archived, not read yet) -> indexed, or failed (attempts counted, retried by the sweep).
// LibSQLDocumentStore (libsql-store.ts) is the implementation this package ships; another database implements this
// interface.
import type { Extraction } from "./extract.ts";

export type DocState = "pending" | "indexed" | "failed";
export interface Deadline {
	date: string;
	description: string;
}

export interface DocRow {
	key: string;
	versionId?: string;
	sha256: string;
	bytes: number;
	contentType: string;
	description: string;
	state: DocState;
	attempts: number;
	error?: string;
	type?: string;
	title?: string;
	parties: string[];
	documentDate?: string;
	deadlines: Deadline[];
	summary?: string;
	language?: string;
	text: string;
	extractedBy?: string;
	archivedAt: string;
	indexedAt?: string;
}

export interface SearchArgs {
	query?: string;
	queryVector?: number[];
	type?: string;
	year?: number;
	/** Documents with a deadline on or before this date (YYYY-MM-DD). */
	dueBy?: string;
	limit: number;
}

export interface Hit {
	key: string;
	title?: string;
	type?: string;
	documentDate?: string;
	parties: string[];
	deadlines: Deadline[];
	summary?: string;
	snippet: string;
	state: DocState;
}

export interface DocumentStore {
	has(key: string): Promise<boolean>;
	get(key: string): Promise<DocRow | undefined>;
	/** The keys of archived documents with these exact bytes, oldest first (callers may see only some of them). */
	keysBySha(sha256: string): Promise<string[]>;
	/** Records an archived document before it is read; a no-op when the key is already known. */
	markPending(row: Pick<DocRow, "key" | "versionId" | "sha256" | "bytes" | "contentType" | "description" | "archivedAt">): Promise<void>;
	/** Stores what was read and its chunk vectors, replacing any earlier text and chunks, atomically. */
	markIndexed(key: string, x: Extraction, extractedBy: string, chunks: { text: string; vector: number[] }[], now?: Date): Promise<void>;
	markFailed(key: string, error: string): Promise<void>;
	/** Documents still to be read: pending or failed, with fewer than `max` failed attempts. */
	retryable(max?: number): Promise<string[]>;
	/**
	 * Hybrid search. Without a query: the filtered documents, newest document date first. With one: keyword and, when
	 * a query vector is given, semantic (closest chunk per document) candidates, merged by reciprocal rank fusion.
	 */
	search(a: SearchArgs): Promise<Hit[]>;
	stats(): Promise<{ total: number; indexed: number; pending: number; failed: number }>;
	/** Records that a search fell back to keywords because the query could not be embedded. */
	noteSemanticFailure(error: string, now?: Date): Promise<void>;
	close(): void;
}
