// The embeddings provider switch: which config each environment gives, and that the interim OpenRouter path never lets
// document text reach a provider that collects data, and returns vectors in input order at the index's dimension.
import { describe, expect, test } from "bun:test";
import { createEmbedder, EMBEDDING_DIMS, embeddingsConfig, OPENROUTER_MODEL } from "../src/core/embeddings.ts";

const bedrockEnv = {
	EMBEDDINGS_PROVIDER: "bedrock",
	EMBEDDINGS_REGION: "eu-central-1",
	EMBEDDINGS_AWS_ACCESS_KEY_ID: "AKIAX",
	EMBEDDINGS_AWS_SECRET_ACCESS_KEY: "s",
	EMBEDDINGS_MODEL: "cohere.embed-multilingual-v3",
};

describe("embeddingsConfig", () => {
	test("no provider turns the index off; openrouter needs only its key and pins its model", () => {
		expect(embeddingsConfig({ ...bedrockEnv, EMBEDDINGS_PROVIDER: undefined })).toEqual({ off: "EMBEDDINGS_PROVIDER not set" });
		expect(embeddingsConfig(bedrockEnv)).toMatchObject({ provider: "bedrock", model: "cohere.embed-multilingual-v3" });
		expect(embeddingsConfig({ EMBEDDINGS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" })).toEqual({
			provider: "openrouter",
			apiKey: "k",
			model: OPENROUTER_MODEL,
		});
	});
	test("a missing key, an unknown provider or a model the provider does not serve turns the index off", () => {
		expect(embeddingsConfig({ EMBEDDINGS_PROVIDER: "openrouter" })).toEqual({ off: "OPENROUTER_API_KEY not set" });
		expect(embeddingsConfig({ EMBEDDINGS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k", EMBEDDINGS_MODEL: "cohere.embed-multilingual-v3" })).toMatchObject({
			off: expect.stringContaining("openrouter"),
		});
		expect(embeddingsConfig({ ...bedrockEnv, EMBEDDINGS_PROVIDER: "voyage" })).toMatchObject({ off: expect.stringContaining("voyage") });
		expect(embeddingsConfig({ ...bedrockEnv, EMBEDDINGS_MODEL: OPENROUTER_MODEL })).toMatchObject({ off: expect.stringContaining("is not one of") });
	});
});

describe("OpenRouter embeddings", () => {
	function stub(status = 200, reorder = false) {
		const bodies: Record<string, unknown>[] = [];
		const http = (async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { input: string[] };
			bodies.push(body);
			if (status !== 200) return new Response("the document text echoed back", { status });
			const data = body.input.map((t, index) => ({ index, embedding: new Array(EMBEDDING_DIMS).fill(t.length) }));
			return Response.json({ data: reorder ? data.reverse() : data });
		}) as unknown as typeof fetch;
		const cfg = embeddingsConfig({ EMBEDDINGS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" });
		if ("off" in cfg) throw new Error(cfg.off);
		return { bodies, embedder: createEmbedder(cfg, http) };
	}
	test("asks only OpenAI or Azure, with data collection denied and no fallback, at the index's dimension", async () => {
		const { bodies, embedder } = stub();
		await embedder.embed(["contrato"], "document");
		expect(bodies[0]).toMatchObject({
			model: "openai/text-embedding-3-small",
			dimensions: EMBEDDING_DIMS,
			provider: { only: ["openai", "azure"], data_collection: "deny", allow_fallbacks: false, require_parameters: true },
		});
	});
	test("vectors come back in input order across batches, even when the response is reordered", async () => {
		const { bodies, embedder } = stub(200, true);
		const texts = Array.from({ length: 150 }, (_, i) => "x".repeat(i + 1));
		const out = await embedder.embed(texts, "document");
		expect(bodies.map((b) => (b.input as string[]).length)).toEqual([100, 50]);
		expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length));
	});
	test("an error says only the status, never the response body", async () => {
		const { embedder } = stub(402);
		await expect(embedder.embed(["contrato"], "query")).rejects.toThrow(/^OpenRouter 402$/);
	});
});
