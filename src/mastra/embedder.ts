// An Embedder from a Mastra embedding model id ("openai/text-embedding-3-small", "google/gemini-embedding-001", or
// "<provider>/<model>" for any provider in Mastra's registry with a URL), through ModelRouterEmbeddingModel: the
// provider's API key comes from its usual environment variable (OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, ...),
// as it does for an agent's `model:`. Bedrock (SigV4) and OpenRouter's routing rules are not in the router: for those,
// createEmbedder in the core.
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import type { Embedder } from "../core/embeddings.ts";

export interface MastraEmbedderOptions {
	/** The vectors' length the model gives (text-embedding-3-small: 1536; gemini-embedding-001: 3072). The index pins it. */
	dims: number;
}

/** Throws at once when the provider's API key is missing (the router's own message). */
export function mastraEmbedder(modelId: string, opts: MastraEmbedderOptions): Embedder {
	if (!Number.isInteger(opts.dims) || opts.dims <= 0) throw new Error(`invalid dims ${opts.dims}`);
	const router = new ModelRouterEmbeddingModel(modelId);
	const dims = opts.dims;
	return {
		model: modelId,
		dims,
		// The router exposes no task type (document vs query): `kind` is accepted for the interface and ignored.
		async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
			if (texts.length === 0) return [];
			const max = (await router.maxEmbeddingsPerCall) ?? 2048;
			const out: number[][] = [];
			for (let i = 0; i < texts.length; i += max) {
				const batch = texts.slice(i, i + max);
				const result = await router.doEmbed({ values: batch });
				if (result.embeddings.length !== batch.length) throw new Error("Embeddings: unexpected embeddings response");
				out.push(...result.embeddings);
			}
			for (const v of out) if (v.length !== dims) throw new Error(`Embeddings: vector of ${v.length} dims, want ${dims}`);
			return out;
		},
	};
}
