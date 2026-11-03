// The model-backed Extract (core/extract.ts) as a Mastra agent: tool-less, memory-less, with EXTRACTOR_INSTRUCTIONS as
// its system prompt. The host builds it with the model it already uses for conversation (any `model:` an Agent
// accepts: "openai/gpt-4o-mini", a gateway id, a provider instance) and may register it in its Mastra instance so
// Studio can run it by hand and gateway-routed ids resolve.
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { EXTRACTOR_INSTRUCTIONS, type Extract, type ExtractFile, type Extraction, ExtractionSchema, isExtractable, TEXT_MAX } from "../core/extract.ts";

export interface ExtractorAgentOptions {
	model: MastraModelConfig;
	/** Default "extractor". */
	id?: string;
	/** Default "Extrator de documentos". */
	name?: string;
	/** Default EXTRACTOR_INSTRUCTIONS (pt-BR). */
	instructions?: string;
}

export function extractorAgent(opts: ExtractorAgentOptions): Agent {
	return new Agent({
		id: opts.id ?? "extractor",
		name: opts.name ?? "Extrator de documentos",
		instructions: opts.instructions ?? EXTRACTOR_INSTRUCTIONS,
		model: opts.model,
	});
}

/**
 * The Extract an Indexer runs: one user message with the file and a short request; output validated by the schema.
 * `model` is what the index records as the row's extracted_by.
 */
export function extractWith(agent: Agent, model: string): Extract {
	const extract = async (file: ExtractFile): Promise<Extraction> => {
		if (!isExtractable(file.mimeType)) throw new Error(`not extractable: ${file.mimeType}`);
		const media =
			file.mimeType === "application/pdf"
				? { type: "file" as const, data: file.data, mediaType: "application/pdf", filename: file.name }
				: { type: "image" as const, image: file.data, mediaType: file.mimeType };
		const result = await agent.generate([{ role: "user", content: [media, { type: "text", text: "Extraia os dados deste documento." }] }], {
			structuredOutput: { schema: ExtractionSchema, jsonPromptInjection: "system" },
		});
		const x = result.object;
		if (!x) throw new Error("extractor returned no structured output");
		return { ...x, text: x.text.slice(0, TEXT_MAX) };
	};
	return Object.assign(extract, { model });
}
