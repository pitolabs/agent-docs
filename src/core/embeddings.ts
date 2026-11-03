// Text embeddings for the document index. Three providers, chosen by EMBEDDINGS_PROVIDER (unset: index off) or built
// directly from a config:
// - bedrock: Amazon Bedrock, signed with aws4fetch by an IAM user that may invoke Cohere embed-multilingual-v3
//   (separate document/query input types) or Titan Text Embeddings v2. Document text stays in the AWS region.
// - openrouter: OpenAI text-embedding-3-small through OpenRouter, restricted to providers that do not collect data
//   (OpenAI, Azure), never falling back to anyone else.
// - openai-compatible: any server with an OpenAI-style POST /embeddings (OpenAI itself, Azure, Ollama, LM Studio,
//   vLLM, OpenRouter without its routing rules); model and dims are the caller's.
// Bedrock and OpenRouter give 1024-dim vectors here; whatever the model, the index pins the one it was built with
// (the store's meta): another model means a new index. The Mastra entry point adds mastraEmbedder, which builds the
// embedder from a Mastra model id ("openai/text-embedding-3-small") through Mastra's model router.
import { AwsClient } from "aws4fetch";

export type BedrockModel = "cohere.embed-multilingual-v3" | "amazon.titan-embed-text-v2:0";
const BEDROCK_MODELS: readonly BedrockModel[] = ["cohere.embed-multilingual-v3", "amazon.titan-embed-text-v2:0"];
export const OPENROUTER_MODEL = "openai/text-embedding-3-small";

export interface BedrockConfig {
	provider: "bedrock";
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	model: BedrockModel;
}
export interface OpenRouterConfig {
	provider: "openrouter";
	apiKey: string;
	model: typeof OPENROUTER_MODEL;
}
export interface OpenAICompatibleConfig {
	provider: "openai-compatible";
	/** The API root, e.g. https://api.openai.com/v1; `/embeddings` is appended. */
	baseURL: string;
	/** Sent as `Authorization: Bearer`; omitted when unset (a local server). */
	apiKey?: string;
	model: string;
	/** The vectors' length; sent as `dimensions` when set (models that shorten natively), else EMBEDDING_DIMS is expected. */
	dims?: number;
	/** Extra request headers, merged last. */
	headers?: Record<string, string>;
}
export type EmbeddingsConfig = BedrockConfig | OpenRouterConfig | OpenAICompatibleConfig;

/**
 * EMBEDDINGS_PROVIDER (bedrock, openrouter or openai-compatible; unset turns the document index off). Bedrock:
 * EMBEDDINGS_REGION, EMBEDDINGS_AWS_ACCESS_KEY_ID, EMBEDDINGS_AWS_SECRET_ACCESS_KEY, EMBEDDINGS_MODEL. OpenRouter:
 * OPENROUTER_API_KEY; EMBEDDINGS_MODEL, if set, must be openai/text-embedding-3-small. OpenAI-compatible:
 * EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, optional EMBEDDINGS_API_KEY and EMBEDDINGS_DIMS (a positive integer).
 */
export function embeddingsConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig | { off: string } {
	const provider = env.EMBEDDINGS_PROVIDER ?? "";
	if (!provider) return { off: "EMBEDDINGS_PROVIDER not set" };
	const model = env.EMBEDDINGS_MODEL ?? "";
	if (provider === "openai-compatible") {
		const baseURL = env.EMBEDDINGS_BASE_URL ?? "";
		if (!baseURL) return { off: "EMBEDDINGS_BASE_URL not set" };
		if (!model) return { off: "EMBEDDINGS_MODEL not set" };
		const apiKey = env.EMBEDDINGS_API_KEY || undefined;
		const rawDims = env.EMBEDDINGS_DIMS;
		let dims: number | undefined;
		if (rawDims !== undefined && rawDims !== "") {
			dims = /^\d+$/.test(rawDims) ? Number(rawDims) : 0;
			if (dims <= 0) return { off: "EMBEDDINGS_DIMS must be a positive integer" };
		}
		return { provider, baseURL, model, ...(apiKey ? { apiKey } : {}), ...(dims !== undefined ? { dims } : {}) };
	}
	if (provider === "openrouter") {
		const apiKey = env.OPENROUTER_API_KEY ?? "";
		if (!apiKey) return { off: "OPENROUTER_API_KEY not set" };
		if (model && model !== OPENROUTER_MODEL) return { off: `EMBEDDINGS_MODEL ${model} is not ${OPENROUTER_MODEL} (openrouter)` };
		return { provider, apiKey, model: OPENROUTER_MODEL };
	}
	if (provider !== "bedrock") return { off: `EMBEDDINGS_PROVIDER ${provider} is not bedrock, openrouter or openai-compatible` };
	const region = env.EMBEDDINGS_REGION ?? "";
	const accessKeyId = env.EMBEDDINGS_AWS_ACCESS_KEY_ID ?? "";
	const secretAccessKey = env.EMBEDDINGS_AWS_SECRET_ACCESS_KEY ?? "";
	if (!region || !accessKeyId || !secretAccessKey || !model) return { off: "EMBEDDINGS_* not set" };
	if (!BEDROCK_MODELS.includes(model as BedrockModel)) return { off: `EMBEDDINGS_MODEL ${model} is not one of ${BEDROCK_MODELS.join(", ")}` };
	return { provider, region, accessKeyId, secretAccessKey, model: model as BedrockModel };
}

export const EMBEDDING_DIMS = 1024;
/** Cohere accepts at most 96 texts per request. */
const COHERE_BATCH = 96;
/** OpenAI accepts up to 2048 inputs per request; 100 keeps each request small (OpenRouter and OpenAI-compatible). */
const OPENAI_BATCH = 100;

export interface Embedder {
	readonly model: string;
	readonly dims: number;
	embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/** The embedder for a config. */
export function createEmbedder(cfg: EmbeddingsConfig, http: typeof fetch = fetch): Embedder {
	switch (cfg.provider) {
		case "openrouter":
			return new OpenRouterEmbeddings(cfg, http);
		case "openai-compatible":
			return new OpenAICompatibleEmbeddings(cfg, http);
		default:
			return new BedrockEmbeddings(cfg, http);
	}
}

export class BedrockEmbeddings implements Embedder {
	readonly model: BedrockModel;
	readonly dims = EMBEDDING_DIMS;
	private aws: AwsClient;
	private base: string;

	constructor(
		cfg: BedrockConfig,
		private http: typeof fetch = fetch,
	) {
		this.model = cfg.model;
		this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "bedrock", region: cfg.region });
		this.base = `https://bedrock-runtime.${cfg.region}.amazonaws.com/model/${encodeURIComponent(cfg.model)}/invoke`;
	}

	private async invoke(body: unknown): Promise<Record<string, unknown>> {
		const req = await this.aws.sign(this.base, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		const res = await this.http(req);
		// Never log or rethrow the body: it may echo the document's text.
		if (!res.ok) throw new Error(`Bedrock ${res.status}`);
		return (await res.json()) as Record<string, unknown>;
	}

	async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		if (this.model === "cohere.embed-multilingual-v3") {
			for (let i = 0; i < texts.length; i += COHERE_BATCH) {
				const batch = texts.slice(i, i + COHERE_BATCH);
				const r = await this.invoke({ texts: batch, input_type: kind === "query" ? "search_query" : "search_document", truncate: "END" });
				const vectors = r.embeddings;
				if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Bedrock: unexpected embeddings response");
				out.push(...(vectors as number[][]));
			}
		} else {
			for (const inputText of texts) {
				const r = await this.invoke({ inputText, dimensions: EMBEDDING_DIMS, normalize: true });
				if (!Array.isArray(r.embedding)) throw new Error("Bedrock: unexpected embedding response");
				out.push(r.embedding as number[]);
			}
		}
		for (const v of out) if (v.length !== this.dims) throw new Error(`Bedrock: vector of ${v.length} dims, want ${this.dims}`);
		return out;
	}
}

/**
 * OpenAI text-embedding-3-small through OpenRouter's OpenAI-compatible /embeddings, at 1024 dimensions (the model
 * shortens its vectors natively). Routed only to OpenAI or Azure, never to a provider that collects data, and the
 * request fails rather than falling back to anyone else.
 */
export class OpenRouterEmbeddings implements Embedder {
	readonly model = OPENROUTER_MODEL;
	readonly dims = EMBEDDING_DIMS;

	constructor(
		private cfg: OpenRouterConfig,
		private http: typeof fetch = fetch,
	) {}

	async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += OPENAI_BATCH) {
			const batch = texts.slice(i, i + OPENAI_BATCH);
			const res = await this.http("https://openrouter.ai/api/v1/embeddings", {
				method: "POST",
				headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json", "X-Title": "agent-docs" },
				body: JSON.stringify({
					model: this.model,
					input: batch,
					dimensions: EMBEDDING_DIMS,
					encoding_format: "float",
					provider: { only: ["openai", "azure"], data_collection: "deny", allow_fallbacks: false, require_parameters: true },
				}),
			});
			// Never log or rethrow the body: it may echo the document's text.
			if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
			const r = (await res.json()) as { data?: { index?: number; embedding?: unknown }[] };
			const data = r.data;
			if (!Array.isArray(data) || data.length !== batch.length) throw new Error("OpenRouter: unexpected embeddings response");
			const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			for (const d of ordered) {
				if (!Array.isArray(d.embedding)) throw new Error("OpenRouter: unexpected embedding response");
				out.push(d.embedding as number[]);
			}
		}
		for (const v of out) if (v.length !== this.dims) throw new Error(`OpenRouter: vector of ${v.length} dims, want ${this.dims}`);
		return out;
	}
}

/**
 * Any server with an OpenAI-style POST /embeddings: `{ model, input, encoding_format }` in, `{ data: [{ index,
 * embedding }] }` out. `dims`, when set, is sent as `dimensions` (models that shorten natively) and is what every
 * vector must have back; unset, EMBEDDING_DIMS is expected.
 */
export class OpenAICompatibleEmbeddings implements Embedder {
	readonly model: string;
	readonly dims: number;
	private url: string;

	constructor(
		private cfg: OpenAICompatibleConfig,
		private http: typeof fetch = fetch,
	) {
		this.model = cfg.model;
		this.dims = cfg.dims ?? EMBEDDING_DIMS;
		this.url = `${cfg.baseURL.replace(/\/$/, "")}/embeddings`;
	}

	async embed(texts: string[], _kind: "document" | "query"): Promise<number[][]> {
		if (texts.length === 0) return [];
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += OPENAI_BATCH) {
			const batch = texts.slice(i, i + OPENAI_BATCH);
			const res = await this.http(this.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
					...(this.cfg.headers ?? {}),
				},
				body: JSON.stringify({
					model: this.model,
					input: batch,
					encoding_format: "float",
					...(this.cfg.dims !== undefined ? { dimensions: this.cfg.dims } : {}),
				}),
			});
			// Never log or rethrow the body: it may echo the document's text.
			if (!res.ok) throw new Error(`Embeddings ${res.status}`);
			const r = (await res.json()) as { data?: { index?: number; embedding?: unknown }[] };
			const data = r.data;
			if (!Array.isArray(data) || data.length !== batch.length) throw new Error("Embeddings: unexpected embeddings response");
			const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			for (const d of ordered) {
				if (!Array.isArray(d.embedding)) throw new Error("Embeddings: unexpected embedding response");
				out.push(d.embedding as number[]);
			}
		}
		for (const v of out) if (v.length !== this.dims) throw new Error(`Embeddings: vector of ${v.length} dims, want ${this.dims}`);
		return out;
	}
}

/**
 * Chunks for embedding: paragraphs (blank-line separated) merged while they fit in `max` characters; a paragraph
 * longer than `max` is cut at the last whitespace before the limit (or at the limit when there is none).
 */
export function chunkText(text: string, max = 1400): string[] {
	const pieces: string[] = [];
	for (const para of text.split(/\n\s*\n/)) {
		let p = para.trim();
		while (p.length > max) {
			// Last whitespace (space, tab, newline) at or before `max`; none -> a hard cut at `max`.
			const ws = p.slice(0, max + 1).search(/\s\S*$/);
			const cut = ws > 0 ? ws : max;
			pieces.push(p.slice(0, cut).trim());
			p = p.slice(cut).trim();
		}
		if (p) pieces.push(p);
	}
	const chunks: string[] = [];
	for (const piece of pieces) {
		const last = chunks.at(-1);
		if (last !== undefined && last.length + 2 + piece.length <= max) chunks[chunks.length - 1] = `${last}\n\n${piece}`;
		else chunks.push(piece);
	}
	return chunks.filter((c) => c.length > 0);
}
