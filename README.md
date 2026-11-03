# @pitolabs/agent-docs

A document archive for an AI agent: files people send it go to a private S3 bucket, a model reads each one once
(full text as Markdown, type, title, parties, dates, deadlines, summary), and a per-agent libSQL index answers keyword
and semantic questions about them. The `core` entry point is framework-neutral; `@pitolabs/agent-docs/mastra` adds
ready-made [Mastra](https://mastra.ai) tools (`propose_file`/`save` or `archive_file`, `list_documents`,
`search_documents`, `read_document`, `document_link`), the approval gate they rely on, an extractor agent factory and
an embedder built from a Mastra model id.

```text
save ─► S3 PUT ─► row "pending" (before the reply) ─► Indexer queue (one at a time, in process)
                                                       ├─ extractor agent (PDF/JPEG/PNG/WebP): text + type, title, parties, date, deadlines, summary
                                                       └─ embedder: chunk vectors
sweep (30 s after boot, then every 6 h): S3 keys missing from the index + pending/failed rows with < 3 attempts
```

S3 is the source of truth; the index is derived state, rebuilt by deleting it.

## Install

```bash
bun add @pitolabs/agent-docs
npm install @pitolabs/agent-docs
```

`@mastra/core` (>= 1.79) is an optional peer dependency, needed only by the `/mastra` entry point.

## With Mastra

```ts
import { Agent } from "@mastra/core/agent";
import { ApprovalGate, archiveTools, DocsArchive, docsConfig, extractorAgent, extractWith, mastraEmbedder, openAgentIndex } from "@pitolabs/agent-docs/mastra";

const cfg = docsConfig("KINE"); // KINE_DOCS_BUCKET, _REGION, _AWS_ACCESS_KEY_ID, _AWS_SECRET_ACCESS_KEY
if ("off" in cfg) throw new Error(cfg.off);
const docs = new DocsArchive(cfg);
const embedder = mastraEmbedder("openai/text-embedding-3-small", { dims: 1536 }); // OPENAI_API_KEY
const extractor = extractorAgent({ model: "openai/gpt-4o-mini" }); // register it in your Mastra instance too
const opened = await openAgentIndex({ url: "file:/data/docs-kine.db", bucket: cfg.bucket, docs, embedder, extract: extractWith(extractor, "openai/gpt-4o-mini") });
if ("off" in opened) throw new Error(opened.off);
const { index, indexer } = opened;
const gate = new ApprovalGate();

const agent = new Agent({
	id: "kine",
	name: "Kine",
	model: "openai/gpt-4o-mini",
	instructions: "...",
	tools: archiveTools({ gate, docs, index, indexer, embedder, where: "WhatsApp do Kine", archiveName: "no S3 da Kine" }),
});
indexer.start(); // the reconcile sweep
```

Before each turn, the host (whatever delivers messages to the agent) does three things: `gate.receive()` for the
message's receipt and `gate.onMessage(conversation, sender, text, receipt)` so a "sim" approves the pending proposal
(anything else drops it); `gate.setFiles(conversation, files)` with the turn's attachments; and
`grantPass(requestContext, { conversation, sender })` on the run's `RequestContext`, which is how the tools learn who
is writing. A run without a pass (Studio, the HTTP API) is refused with `where` in the message, so a proposal cannot be
forged and approved by the real person's next "sim".

### The tools and the approval flow

- `received_files` lists the turn's attachments. `propose_file` picks the key (`documents/YYYY/MM/<kebab-name>.<ext>`,
  the document's own month, never over an existing key) and stores the proposal; the agent shows it and asks. `save`
  runs it only after the proposer's next message is a whole "sim" (`sim`, `ok`, `pode`, `confirmo`, ...; leading
  `@mentions` ignored), once. A proposal of the same bytes (sha256) already archived carries a `warning` naming the copy.
- `immediate: true` replaces `propose_file` + `save` with `archive_file`, which stores on the model's call and answers
  `already_archived` for known bytes.
- `extra` adds one more write to a proposal (a note in a knowledge base, say): prepared when proposing, shown with it,
  run after the upload. `keyFilter` restricts which keys the run's sender sees and writes (each person's own
  documents).
- `list_documents` browses the bucket by month with each document's one-line description (S3 metadata);
  `search_documents` and `read_document` use the index; `document_link` gives a 7-day presigned URL.

Tool descriptions, proposals and the extractor's prompt are in Brazilian Portuguese in this release
(`EXTRACTOR_INSTRUCTIONS` can be replaced through `extractorAgent({ instructions })`).

## Embeddings

- `mastraEmbedder("<provider>/<model>", { dims })` builds the embedder through Mastra's `ModelRouterEmbeddingModel`: the
  same ids an agent's `model:` accepts (`openai/text-embedding-3-small`, `google/gemini-embedding-001`, any registry
  provider with a URL), the key from the provider's usual environment variable.
- `createEmbedder(embeddingsConfig(env))` (core) reads `EMBEDDINGS_PROVIDER`:
  - `bedrock`: Cohere Embed Multilingual v3 or Titan Text Embeddings v2, SigV4-signed (`EMBEDDINGS_REGION`,
    `EMBEDDINGS_AWS_ACCESS_KEY_ID`, `EMBEDDINGS_AWS_SECRET_ACCESS_KEY`, `EMBEDDINGS_MODEL`); 1024 dims; text stays in
    the region.
  - `openrouter`: OpenAI `text-embedding-3-small` at 1024 dims through OpenRouter, routed only to OpenAI or Azure with
    data collection denied and no fallback (`OPENROUTER_API_KEY`).
  - `openai-compatible`: any OpenAI-style `POST /embeddings` (`EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`, optional
    `EMBEDDINGS_API_KEY`, `EMBEDDINGS_DIMS`): OpenAI, Azure, Ollama, vLLM, LM Studio, OpenRouter without routing rules.
- **An index is pinned to its model.** The store's `meta` table records the bucket, the embeddings model and the dims;
  opening it with another is refused (`{ off }`). Switching model means deleting the index and re-reading every
  document (the boot sweep does it, one model call each).

## Where the index lives

`LibSQLDocumentStore.open({ url, authToken? }, { bucket, embeddingsModel, dims })` takes any `@libsql/client` URL:
`file:/data/docs-kine.db` (the usual: one file per agent, WAL, next to nothing else), `:memory:` (tests), or
`libsql://<db>.turso.io` with `authToken`. The tables: `documents` (state, attempts, sha256, extracted fields, full
text), `documents_fts` (FTS5, `unicode61 remove_diacritics 2`, Portuguese stopwords dropped from queries), `chunks`
(`F32_BLOB(dims)`, exact cosine scan: milliseconds for the hundreds or thousands of documents an agent holds), `meta`.
Search: BM25 and nearest-chunk candidates (20 each), filters (`type`, `year`, `due_by`) applied in the `WHERE` before
ranking, merged by reciprocal rank fusion.

`DocumentStore` (`core/store.ts`) is the extension point: the indexer and the tools are typed against it, not the
class. PostgreSQL / Aurora PostgreSQL is planned for 0.2.0 as `@pitolabs/agent-docs/postgres` (`pgvector` + `<=>`,
`tsvector` + `to_tsquery('portuguese', unaccent(...))` + `ts_rank_cd`/`ts_headline`, `jsonb_array_elements` for
deadlines, `ON CONFLICT DO NOTHING`). Aurora DSQL is out: no extensions, no `tsvector`.

## Why not `@mastra/rag` + `LibSQLVector`

| Need | Mastra store | This package |
|---|---|---|
| Keyword search, accents folded, BM25 | not in the `MastraVector` interface | FTS5 `unicode61 remove_diacritics 2` |
| Filters by type, year, deadline | metadata filter applied after `vector_top_k` (over-fetch, then trim) | `WHERE` on `documents`, joined before ranking |
| Document state, attempts, sha256 duplicates, extracted fields | not modelled | columns on `documents`, FTS and chunks keyed to them |
| Dependencies | `@mastra/rag` pulls `js-tiktoken`, `zeroentropy`, `@aws-sdk/client-bedrock-agent-runtime`, ... | `@libsql/client`, `aws4fetch`, `zod` |

`ModelRouterEmbeddingModel` is reused (`mastraEmbedder`); chunking is 20 lines (`chunkText`: paragraphs merged up to
1,400 characters).

## S3 layout and IAM

Keys are `documents/YYYY/MM/<kebab-name>.<ext>` (`DOCUMENTS_PREFIX` is fixed: it is the IAM contract); `freeKey` picks
`-2`, `-3` when a name is taken and `put` uses `If-None-Match: *`, so nothing is ever overwritten. Year `0000` is
reserved for a deployment's write probes (never indexed). Give the agent's IAM user list, get and put under the prefix
and nothing else; turn versioning on so a bad upload can be undone by hand:

```json
{
	"Version": "2012-10-17",
	"Statement": [
		{ "Sid": "ListDocuments", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>", "Condition": { "StringLike": { "s3:prefix": "documents/*" } } },
		{ "Sid": "ReadWriteDocuments", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::<bucket>/documents/*" }
	]
}
```

## What is stored, and where text goes

- The index holds the full extracted text, monetary amounts included; the files' sensitivity is the index's. Keep it
  in the same place as the bucket's credentials.
- Document text reaches the extractor's model and the embedder's provider. Bedrock keeps it in the AWS region; the
  OpenRouter embedder restricts routing to OpenAI/Azure; a Mastra model id goes wherever that provider is.
- Office documents and HEIC photos are not sent to the model: indexed by name and description only
  (`extracted_by = none`). PDFs the model cannot read end `failed` after 3 attempts and stay findable by description.
- Errors never carry document text: `safeError` logs and stores only the error's class name plus an HTTP status or a
  short code, except this package's own status-only messages (`Bedrock 429`, `OpenRouter 402`, `Embeddings 500`,
  `S3 GET 500`). A query that cannot be embedded degrades `search_documents` to keywords (`search_mode: "keyword-only"`)
  and is counted in `meta` (`semantic_failures`, `semantic_last_failure`), without the query text.

**Rebuild:** stop the process, delete the index (`docs-<agent>.db*`), start it; the boot sweep re-reads every document.

## Contributing

`bun install` turns the git hooks on: pre-commit formats with the pinned Biome and refuses a commit whose staged
changes carry a secret or personal data; pre-push scans every outgoing commit. Commits need a GitHub noreply e-mail
(`git config user.email "<id>+<login>@users.noreply.github.com"`). `bun run format && bun run typecheck && bun test`.

MIT.
