// `@pitolabs/agent-docs/mastra`: the Mastra tools (archiveTools), the approval gate and pass they rely on, the
// extractor agent factory, an Embedder from a Mastra model id, and openAgentIndex. Everything from the core is
// re-exported, so one import serves a Mastra host.
export * from "../core/index.ts";
export { ApprovalGate, type InboxFile, isApproval, type Proposal } from "./approval.ts";
export { type MastraEmbedderOptions, mastraEmbedder } from "./embedder.ts";
export { type ExtractorAgentOptions, extractorAgent, extractWith } from "./extractor.ts";
export { type OpenAgentIndexOptions, openAgentIndex } from "./open-index.ts";
export { grantPass, type Who, whoOf } from "./pass.ts";
export { type ArchiveToolsOptions, archiveTools, type Extra } from "./tools.ts";
