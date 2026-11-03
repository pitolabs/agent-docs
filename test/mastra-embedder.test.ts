// mastraEmbedder: a Mastra model id becomes an Embedder through Mastra's model router, which reads the provider's key
// from the environment and calls the provider's API (stubbed here through globalThis.fetch).
import { afterEach, describe, expect, test } from "bun:test";
import { mastraEmbedder } from "../src/mastra/embedder.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;
afterEach(() => {
	globalThis.fetch = realFetch;
	if (realKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = realKey;
});

describe("mastraEmbedder", () => {
	test("openai/text-embedding-3-small calls api.openai.com with OPENAI_API_KEY and returns the vectors", async () => {
		process.env.OPENAI_API_KEY = "test";
		const requests: { url: string; auth: string | null; body: { input: string[]; model: string } }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const req = new Request(input, init);
			const body = (await req.json()) as { input: string[]; model: string };
			requests.push({ url: req.url, auth: req.headers.get("authorization"), body });
			return Response.json({
				object: "list",
				data: body.input.map((_, index) => ({ object: "embedding", index, embedding: new Array(1536).fill(0.5) })),
				model: body.model,
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		}) as typeof fetch;
		const e = mastraEmbedder("openai/text-embedding-3-small", { dims: 1536 });
		expect(e.model).toBe("openai/text-embedding-3-small");
		const out = await e.embed(["contrato", "fatura"], "query");
		expect(out).toHaveLength(2);
		expect(out[0]).toHaveLength(1536);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			url: "https://api.openai.com/v1/embeddings",
			auth: "Bearer test",
			body: { model: "text-embedding-3-small", input: ["contrato", "fatura"] },
		});
	});

	test("a vector of the wrong length is refused", async () => {
		process.env.OPENAI_API_KEY = "test";
		globalThis.fetch = (async () =>
			Response.json({
				object: "list",
				data: [{ object: "embedding", index: 0, embedding: [1, 2, 3] }],
				model: "text-embedding-3-small",
				usage: { prompt_tokens: 1, total_tokens: 1 },
			})) as unknown as typeof fetch;
		await expect(mastraEmbedder("openai/text-embedding-3-small", { dims: 1536 }).embed(["x"], "document")).rejects.toThrow(
			"Embeddings: vector of 3 dims, want 1536",
		);
	});

	test("without the provider's key the constructor throws", () => {
		delete process.env.OPENAI_API_KEY;
		expect(() => mastraEmbedder("openai/text-embedding-3-small", { dims: 1536 })).toThrow(/^API key not found for provider openai/);
	});
});
