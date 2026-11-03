# Reference

Embedders, where the index lives, how search ranks, the S3 contract, and what happens to document text. The
[guide](guide.md) covers wiring; the [design notes](design.md) cover why.

## Entry points

| Import | Contents |
|---|---|
| `@pitolabs/agent-docs` | Framework-neutral core: `DocsArchive`, `LibSQLDocumentStore`, `DocumentStore`, `Indexer`, the embedders, `ExtractionSchema`, `chunkText`, `safeError`. No `@mastra/core` import. |
| `@pitolabs/agent-docs/mastra` | Everything above plus `archiveTools`, `ApprovalGate`, `grantPass`/`whoOf`, `extractorAgent`/`extractWith`, `mastraEmbedder`, `openAgentIndex`. Needs `@mastra/core` ≥ 1.79 (optional peer). |

## Embedders

Every embedder is `{ model, dims, embed(texts, "document" | "query") }`. An index is **pinned to its model and dims**
(the store's `meta` table): opening it with another is refused with `{ off }`; switching means deleting the index and
re-reading every document (the boot sweep does it, one model call each).

- **`mastraEmbedder("<provider>/<model>", { dims })`** (`/mastra`): Mastra's `ModelRouterEmbeddingModel`, so the same
  ids an agent's `model:` accepts (`openai/text-embedding-3-small` 1536, `google/gemini-embedding-001` 3072, any
  registry provider with a URL), key from the provider's usual environment variable. The router has no document/query
  task type; `kind` is ignored.
- **`createEmbedder(embeddingsConfig(env))`** (core) reads `EMBEDDINGS_PROVIDER`:

  | Provider | Env | Notes |
  |---|---|---|
  | `bedrock` | `EMBEDDINGS_REGION`, `EMBEDDINGS_AWS_ACCESS_KEY_ID`, `EMBEDDINGS_AWS_SECRET_ACCESS_KEY`, `EMBEDDINGS_MODEL` (`cohere.embed-multilingual-v3` or `amazon.titan-embed-text-v2:0`) | SigV4 with `aws4fetch`; 1024 dims; Cohere gets separate document/query input types; text stays in the region. |
  | `openrouter` | `OPENROUTER_API_KEY` | OpenAI `text-embedding-3-small` at 1024 dims, routed only to OpenAI or Azure with data collection denied and no fallback. |
  | `openai-compatible` | `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, optional `EMBEDDINGS_API_KEY`, `EMBEDDINGS_DIMS` | Any OpenAI-style `POST <baseURL>/embeddings`: OpenAI, Azure, Ollama, vLLM, LM Studio, OpenRouter without routing rules. `dims` is sent as `dimensions` when set. |

  Unset `EMBEDDINGS_PROVIDER` gives `{ off: "EMBEDDINGS_PROVIDER not set" }`: the host decides what "off" means
  (pitomastra turns the index off and keeps archiving).

Batches: 96 texts (Cohere), 100 (OpenAI-style), the model's `maxEmbeddingsPerCall` (Mastra router). Every vector's
length is checked against `dims`.

## Where the index lives

`LibSQLDocumentStore.open({ url, authToken? }, { bucket, embeddingsModel, dims })` takes any `@libsql/client` URL:

| URL | Use |
|---|---|
| `file:/data/docs-clerk.db` | The usual: one file per agent, WAL, `busy_timeout` 5 s. |
| `:memory:` | Tests. |
| `libsql://<db>.turso.io` + `authToken` | Remote; no PRAGMAs are sent. |

Tables: `documents` (key, version id, sha256, bytes, content type, description, state `pending`/`indexed`/`failed`,
attempts, error, the extracted fields, full text, `extracted_by`, timestamps), `documents_fts` (FTS5 over title,
parties, description, summary, text; tokenizer `unicode61 remove_diacritics 2`), `chunks` (`F32_BLOB(dims)`), `meta`
(`schema_version`, `bucket`, `embeddings_model`, `dims`, `semantic_failures`, `semantic_last_failure`).

`DocumentStore` (`src/core/store.ts`) is the interface the indexer and tools are typed against; the libSQL class is
the one implementation shipped. See [design notes](design.md#other-databases) for what a PostgreSQL store would map to.

## Search

`search({ query?, queryVector?, type?, year?, dueBy?, limit })`:

1. Filters (`type`, `year` on the document date *or* the key's folder, `dueBy` on any deadline) go into the `WHERE`
   before ranking, never applied after a top-k.
2. Without a query or vector: the filtered documents, newest document date first.
3. With a query: an FTS5 `MATCH` of every word of 2+ letters that is not a Portuguese function word (`quem cuida da
   minha contabilidade?` → `"cuida" OR "contabilidade"`), ranked by BM25, 20 candidates, with a 12-token snippet.
4. With a vector: the nearest chunk per document by exact cosine distance (`vector_distance_cos`), 20 candidates,
   the best chunk's text as snippet.
5. Reciprocal rank fusion (`k = 60`) of the two lists, cut at `limit`.

Exact scan, no ANN index: an agent's archive is hundreds to a few thousand documents, and the scan takes milliseconds.

## S3 layout and IAM

Keys are `documents/YYYY/MM/<kebab-name>.<ext>` (`DOCUMENTS_PREFIX` is fixed: it is the IAM contract). `kebabName`
folds accents and case and keeps one extension; `freeKey` picks `-2`, `-3`… when a name is taken; `put` sends
`If-None-Match: *`, so nothing is ever overwritten (a race between two proposals gives `KeyTaken`, never a silent
rename). The description travels as `x-amz-meta-description`, percent-encoded (S3 metadata is ASCII), up to 600
characters. Year `0000` is reserved for a deployment's write probes (never indexed).

Give the agent's IAM user list, get and put under the prefix and nothing else, and turn versioning on so a bad upload
can be undone by hand:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{ "Sid": "ListDocuments", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>", "Condition": { "StringLike": { "s3:prefix": "documents/*" } } },
		{ "Sid": "ReadWriteDocuments", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::<bucket>/documents/*" }
	]
}
```

`docsConfig(prefix, env)` reads `<PREFIX>_DOCS_BUCKET`, `_DOCS_REGION`, `_DOCS_AWS_ACCESS_KEY_ID`,
`_DOCS_AWS_SECRET_ACCESS_KEY`; `indexConfig(prefix, env)` reads `<PREFIX>_DOCS_DB`. Both return `{ off }` when unset.

## What is stored, and where text goes

- The index holds the full extracted text, monetary amounts included; the files' sensitivity is the index's. Keep it
  where the bucket's credentials are.
- Document text reaches the extractor's model and the embedder's provider. Bedrock keeps it in the AWS region; the
  OpenRouter embedder restricts routing to OpenAI/Azure; a Mastra model id goes wherever that provider is.
- **Errors never carry document text.** `safeError` logs and stores only the error's class name plus an HTTP status or a
  short code (`extract: AI_JSONParseError`), except this package's own status-only messages (`Bedrock 429`,
  `OpenRouter 402`, `Embeddings 500`, `S3 GET 500`). The AI SDK's parse errors quote the whole model reply in their
  message; that is why.
- A query that cannot be embedded degrades `search_documents` to keywords (`search_mode: "keyword-only"`, a warning in
  the reply and the log) and is counted in `meta` (`semantic_failures`, `semantic_last_failure`) without the query text.

## Rebuild

Stop the process, delete the index (`docs-<agent>.db*`), start it: the boot sweep lists the bucket and re-reads every
document, one model call each.
