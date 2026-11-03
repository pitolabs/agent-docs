// An agent's document index and its indexer in one call, or `{ off }` saying why not (a database built for another
// bucket or embeddings model). The host reads its environment, builds the archive, the embedder and the extractor, and
// decides what to log; this only wires them.
import type { Embedder } from "../core/embeddings.ts";
import type { Extract } from "../core/extract.ts";
import { Indexer } from "../core/indexer.ts";
import { LibSQLDocumentStore } from "../core/libsql-store.ts";
import type { DocsArchive } from "../core/s3.ts";
import type { DocumentStore } from "../core/store.ts";

export interface OpenAgentIndexOptions {
	/** Any @libsql/client URL: `file:/data/docs.db`, `:memory:`, `libsql://<db>.turso.io`. */
	url: string;
	authToken?: string;
	/** The bucket the index belongs to; a database built for another bucket is refused. */
	bucket: string;
	docs: DocsArchive;
	embedder: Embedder;
	extract: Extract;
	/** Log prefix for the indexer, default "[docs]". */
	log?: string;
}

export async function openAgentIndex(o: OpenAgentIndexOptions): Promise<{ index: DocumentStore; indexer: Indexer } | { off: string }> {
	const opened = await LibSQLDocumentStore.open(
		{ url: o.url, ...(o.authToken ? { authToken: o.authToken } : {}) },
		{ bucket: o.bucket, embeddingsModel: o.embedder.model, dims: o.embedder.dims },
	);
	if ("off" in opened) return opened;
	return { index: opened, indexer: new Indexer({ docs: o.docs, index: opened, extract: o.extract, embedder: o.embedder, log: o.log ?? "[docs]" }) };
}
