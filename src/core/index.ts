// `@pitolabs/agent-docs`: the framework-neutral core. The S3 archive, the document store (libSQL), the indexer that
// reads documents into it, the embedders and the extraction contract. Nothing here imports a framework; the Mastra
// tools and agent factories are in `@pitolabs/agent-docs/mastra`.
export {
	type BedrockConfig,
	BedrockEmbeddings,
	type BedrockModel,
	chunkText,
	createEmbedder,
	EMBEDDING_DIMS,
	type Embedder,
	type EmbeddingsConfig,
	embeddingsConfig,
	OPENROUTER_MODEL,
	type OpenAICompatibleConfig,
	OpenAICompatibleEmbeddings,
	type OpenRouterConfig,
	OpenRouterEmbeddings,
} from "./embeddings.ts";
export {
	DOCUMENT_TYPES,
	EXTRACTOR_INSTRUCTIONS,
	type Extract,
	type ExtractFile,
	type Extraction,
	ExtractionSchema,
	emptyExtraction,
	isExtractable,
	TEXT_MAX,
} from "./extract.ts";
export { Indexer, type IndexJob, safeError, sha256 } from "./indexer.ts";
export { ftsQuery, type IndexConfig, indexConfig, LibSQLDocumentStore } from "./libsql-store.ts";
export {
	DOCUMENTS_PREFIX,
	DocsArchive,
	type DocsConfig,
	docsConfig,
	type Fetched,
	isDocumentKey,
	KeyTaken,
	kebabName,
	LINK_SECONDS,
	type Listed,
} from "./s3.ts";
export type { Deadline, DocRow, DocState, DocumentStore, Hit, SearchArgs } from "./store.ts";
