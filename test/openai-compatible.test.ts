// The OpenAI-compatible embedder: where the request goes, what it carries (a bearer only with a key, `dimensions` only
// when dims is set), and that an error never carries the response body.
import { describe, expect, test } from "bun:test";
import { createEmbedder, EMBEDDING_DIMS, embeddingsConfig, type OpenAICompatibleConfig, OpenAICompatibleEmbeddings } from "../src/core/embeddings.ts";

function stub(status = 200) {
	const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
	const http = (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { input: string[]; dimensions?: number };
		calls.push({ url, headers: init.headers as Record<string, string>, body });
		if (status !== 200) return new Response("the document text echoed back", { status });
		const dims = body.dimensions ?? EMBEDDING_DIMS;
		return Response.json({ data: body.input.map((t, index) => ({ index, embedding: new Array(dims).fill(t.length) })) });
	}) as unknown as typeof fetch;
	return { calls, http };
}

describe("OpenAICompatibleEmbeddings", () => {
	test("posts to <baseURL>/embeddings with a bearer and `dimensions` when given", async () => {
		const { calls, http } = stub();
		const e = new OpenAICompatibleEmbeddings(
			{ provider: "openai-compatible", baseURL: "https://api.example.com/v1/", apiKey: "k", model: "m", dims: 256, headers: { "X-Title": "t" } },
			http,
		);
		const out = await e.embed(["contrato"], "document");
		expect(out[0]).toHaveLength(256);
		expect(e.dims).toBe(256);
		expect(calls[0]).toMatchObject({
			url: "https://api.example.com/v1/embeddings",
			headers: { Authorization: "Bearer k", "X-Title": "t" },
			body: { model: "m", input: ["contrato"], encoding_format: "float", dimensions: 256 },
		});
	});

	test("without a key there is no Authorization header; without dims no `dimensions`, and EMBEDDING_DIMS is expected", async () => {
		const { calls, http } = stub();
		const e = new OpenAICompatibleEmbeddings({ provider: "openai-compatible", baseURL: "http://localhost:11434/v1", model: "m" }, http);
		expect((await e.embed(["a"], "query"))[0]).toHaveLength(EMBEDDING_DIMS);
		expect(calls[0]?.headers).not.toHaveProperty("Authorization");
		expect(calls[0]?.body).not.toHaveProperty("dimensions");
	});

	test("an error says only the status, never the response body", async () => {
		const { http } = stub(500);
		const e = new OpenAICompatibleEmbeddings({ provider: "openai-compatible", baseURL: "https://api.example.com/v1", model: "m" }, http);
		await expect(e.embed(["contrato"], "query")).rejects.toThrow(/^Embeddings 500$/);
	});
});

describe("embeddingsConfig for openai-compatible", () => {
	const env = {
		EMBEDDINGS_PROVIDER: "openai-compatible",
		EMBEDDINGS_BASE_URL: "https://openrouter.ai/api/v1",
		EMBEDDINGS_MODEL: "openai/text-embedding-3-small",
	};
	test("base URL and model are required; key and dims optional; createEmbedder dispatches on it", () => {
		expect(embeddingsConfig(env)).toEqual({ provider: "openai-compatible", baseURL: env.EMBEDDINGS_BASE_URL, model: env.EMBEDDINGS_MODEL });
		expect(embeddingsConfig({ ...env, EMBEDDINGS_API_KEY: "k", EMBEDDINGS_DIMS: "1024" })).toMatchObject({ apiKey: "k", dims: 1024 });
		expect(embeddingsConfig({ ...env, EMBEDDINGS_BASE_URL: undefined })).toEqual({ off: "EMBEDDINGS_BASE_URL not set" });
		expect(embeddingsConfig({ ...env, EMBEDDINGS_MODEL: undefined })).toEqual({ off: "EMBEDDINGS_MODEL not set" });
		expect(embeddingsConfig({ ...env, EMBEDDINGS_DIMS: "1.5" })).toEqual({ off: "EMBEDDINGS_DIMS must be a positive integer" });
		expect(embeddingsConfig({ ...env, EMBEDDINGS_DIMS: "0" })).toEqual({ off: "EMBEDDINGS_DIMS must be a positive integer" });
		const cfg = embeddingsConfig(env) as OpenAICompatibleConfig;
		expect(createEmbedder(cfg, stub().http)).toBeInstanceOf(OpenAICompatibleEmbeddings);
	});
});
