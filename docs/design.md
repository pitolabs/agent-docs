# Design notes

Why things are the way they are, and what is planned.

## Why the approval gate is code, not a prompt

An instruction like "always ask before archiving" is advice the model can forget, misread, or be talked out of. Here
`save` refuses unless `ApprovalGate.take()` finds a proposal that *the same person* approved *in the message after*
the proposal, and the proposal carries a copy of the file it named, so the approving message's own attachments cannot
replace it. The pass (`grantPass`) is an object identity in a `WeakMap`, minted only by the host: Mastra's HTTP routes
merge `requestContext` strings from the body into a run, so a string could be forged from Studio; an object cannot.

## Why a libSQL file and not `@mastra/rag` + `LibSQLVector`

| Need | Mastra store | This package |
|---|---|---|
| Keyword search, accents folded, BM25 | not in the `MastraVector` interface | FTS5 `unicode61 remove_diacritics 2` |
| Filters by type, year, deadline | metadata filter applied after `vector_top_k` (over-fetch, then trim) | `WHERE` on `documents`, joined before ranking |
| Document state, attempts, sha256 duplicates, extracted fields | not modelled | columns on `documents`, FTS and chunks keyed to them |
| Approximate index | `libsql_vector_idx` (DiskANN; hundreds of KB per row) | exact scan; milliseconds at this scale |
| Dependencies | `@mastra/rag` pulls `js-tiktoken`, `zeroentropy`, `@aws-sdk/client-bedrock-agent-runtime`, ... | `@libsql/client`, `aws4fetch`, `zod` |

What *is* reused from Mastra: `ModelRouterEmbeddingModel` (`mastraEmbedder`), `Agent` with `structuredOutput` (the
extractor), `createTool`. Chunking is 20 lines (`chunkText`: paragraphs merged up to 1,400 characters).

## Why one index per agent

Each agent has its own bucket and its own database, pinned to each other in `meta`. Two agents never see each other's
documents even when they share a process, and a database copied to the wrong agent is refused instead of mixing.

## Why the indexer is in-process and single-flight

One file and one model call in flight at a time: an agent's container is small, and the archive grows by a few
documents a day. `save` records a pending row *before* replying, so a crash before the indexer reads it leaves
something the sweep will find; the sweep also catches anything written to the bucket by other means.

## Other databases

`DocumentStore` (`src/core/store.ts`) is the extension point; every search statement in `LibSQLDocumentStore` is
SQLite-specific, so another database is a second class, not a URL. Planned for 0.2.0 as `@pitolabs/agent-docs/postgres`
(PostgreSQL 16+, Aurora PostgreSQL):

| libSQL | PostgreSQL |
|---|---|
| `F32_BLOB(dims)` + `vector_distance_cos` | `pgvector`: `vector(dims)` + `<=>` |
| FTS5 `unicode61 remove_diacritics 2`, `bm25`, `snippet` | `tsvector` + `to_tsquery('portuguese', unaccent(...))`, `ts_rank_cd`, `ts_headline` |
| `json_each(deadlines)` | `jsonb_array_elements` |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` |

Aurora DSQL stays out: no extensions, no `tsvector`.

## Planned

- `@pitolabs/agent-docs/postgres` (above).
- English tool descriptions and extractor prompt, selectable per agent.
- A `DocumentStore` conformance test suite other stores can run.
