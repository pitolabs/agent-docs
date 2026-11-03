# Guide: wiring agent-docs into a Mastra agent

What the [README](../README.md)'s quick start leaves out: how messages reach the gate, what each tool does, and the
knobs (`immediate`, `extra`, `keyFilter`, the extractor).

## The pipeline

```text
save ─► S3 PUT ─► row "pending" (before the reply) ─► Indexer queue (one at a time, in process)
                                                       ├─ extractor agent (PDF/JPEG/PNG/WebP): text + type, title, parties, date, deadlines, summary
                                                       └─ embedder: chunk vectors
sweep (30 s after boot, then every 6 h): S3 keys missing from the index + pending/failed rows with < 3 attempts
```

S3 is the source of truth; the index is derived state, rebuilt by deleting it. A restart, a crash mid-extraction or a
model outage only delays reading: the sweep picks up anything pending or failed (up to 3 attempts).

## Who is talking: the gate and the pass

The tools never trust the model about *who* is writing or *whether* the person agreed. Both come from the host, the
code that delivers chat messages to the agent. Per admitted message, before the agent's turn:

```ts
import { RequestContext } from "@mastra/core/request-context";
import { grantPass } from "@pitolabs/agent-docs/mastra";

const receipt = gate.receive(); // its place in arrival order, taken as soon as it arrives
gate.onMessage(conversation, sender, text, receipt); // a whole "yes" approves the pending proposal; anything else drops it
gate.setFiles(conversation, files); // this turn's attachments ({ name, mimeType, data }); older ones are replaced
const requestContext = new RequestContext();
grantPass(requestContext, { conversation, sender }); // an object only this module mints: strings cannot forge it
await agent.generate(text, { requestContext });
```

- A run **without a pass** (Mastra Studio, the HTTP API, a cron) is refused by every tool that writes or filters, with
  `where` in the message (`"sem conversa do WhatsApp: escrita só pelo <where>"`). So a forged proposal cannot be
  approved by the real person's next "yes".
- `receive()` matters when turns queue: a "yes" that arrived *before* the proposal existed cannot approve it, even if
  its turn runs after.
- Approval is **the same person**, **within an hour**, **the whole message a yes**. The accepted words are the list in
  `isApproval`: English (`yes`, `y`, `yep`, `sure`, `go ahead`, `save it`, `confirm`...) and pt-BR (`sim`, `s`, `ok`,
  `pode`, `confirmo`, `isso`, `beleza`...), plus `👍` and `✅`; leading `@mentions` ignored. "yes, but change the
  title" is not a yes. Proposals live in memory: a restart drops them.

If the host batches a burst of messages into one turn, call `onMessage` for each in order: a "yes" then a "👍" stays
approved; a question after the "yes" drops it.

## The tools

`archiveTools(opts)` returns the set for one agent. `where` and `archiveName` are the only required strings: they
appear in refusals and tool descriptions (`"WhatsApp da empresa"`, `"no arquivo da empresa"`).

| Tool | What it does |
|---|---|
| `received_files` | The turn's attachments, with index, name, type and size. |
| `propose_file` | Picks the key (`documents/YYYY/MM/<kebab-name>.<ext>`, the document's own month, `-2` if taken), stores the proposal with a copy of the file, returns the summary to show. Warns when the same bytes (sha256) are already archived. |
| `save` | Runs the approved proposal once: S3 `PUT` (`If-None-Match: *`, so never over an existing key), a pending row, the indexer queue. Refuses without a "sim". If another document took the key meanwhile, nothing is written and it says to propose again. |
| `archive_file` | With `immediate: true`, replaces the two above: stores on the model's call, answers `already_archived` for known bytes. |
| `list_documents` | Browses the bucket by prefix (`documents/`, `documents/2026/`, `documents/2026/11/`), 50 per page with a `cursor`, each with its one-line description (S3 metadata). |
| `search_documents` | Hybrid search over the index: `query`, `type`, `year`, `due_by`, `limit`. Without a query, the filtered documents newest first. Says `search_mode: "keyword-only"` when the query could not be embedded. |
| `read_document` | The extracted text in 12,000-character pages (`offset`, `next_offset`), with title, type, parties, deadlines, summary. |
| `document_link` | A presigned download URL, valid 7 days. |

Without an index (`index`/`indexer` absent), archiving works as before and the two index tools say the index is
unavailable. Without an `embedder`, search is keyword-only.

### `extra`: one more write per document

An agent that keeps notes can attach a second write to a proposal (say, a Markdown note in a knowledge base next to
each archived document). `extra.schema` adds inputs to `propose_file`; `extra.prepare(input, key, reason)` returns a preview
(shown with the proposal) and a `commit()` that runs after the upload, whose result is merged into `save`'s reply. Not
available with `immediate`.

### `keyFilter`: each person sees their own

`keyFilter: { allow(key, who), hint }` restricts, per run, which keys the sender may see (`list_documents`,
`search_documents` over-fetch then filter, `read_document`, `document_link`) and write (`propose_file`/`archive_file`
refuse with `hint`). A duplicate the sender may not see is no duplicate for them: it is never named, and their own copy
is archived.

## The extractor

`extractorAgent({ model })` is a tool-less, memory-less `Agent` with `EXTRACTOR_INSTRUCTIONS` (pt-BR) as its prompt.
Register it in your `Mastra` instance if its model id resolves through a gateway, and so Studio can run it by hand.
`extractWith(agent, model)` turns it into the `Extract` the indexer calls; `model` is what the row records as
`extracted_by`. Output is validated by `ExtractionSchema` (15 document types, ISO dates, ≤ 400-char summary, text cut
at 60,000 chars).

Not extractable (indexed by name and description only, `extracted_by = none`): office documents, HEIC photos. PDFs the
model cannot read end `failed` after 3 attempts and stay findable by description.

## Opening the index

`openAgentIndex({ url, authToken?, bucket, docs, embedder, extract, log? })` opens a `LibSQLDocumentStore` and builds
the `Indexer`. It returns `{ off }` instead when the database was built for another bucket or another embeddings
model (delete it to re-index). `url` is any `@libsql/client` URL: `file:`, `:memory:`, `libsql://` + `authToken`.

Call `indexer.start()` once; it sweeps 30 s after boot and every 6 h (`{ bootDelayMs, everyMs }` to change), and
`indexer.stop()` to clear its timers. `indexer.enqueue({ key, data, mimeType, description })` reads one document now.
