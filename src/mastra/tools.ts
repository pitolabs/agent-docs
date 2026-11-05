// Document archive tools for a Mastra agent that talks to people on a chat channel (WhatsApp in its first home). Files
// arrive in the conversation's inbox (ApprovalGate.setFiles, called by the host's channel handler); propose_file shows
// where one would go and stores the proposal in the ApprovalGate; save runs it only after the proposer's "sim" in a
// later message. In immediate mode archive_file replaces both and stores the file on the model's call. Each document
// carries a one-line description as S3 metadata, which list_documents reads back. With an index (a DocumentStore), a
// stored document is also recorded as pending and queued for the indexer, which reads its full text and metadata;
// search_documents and read_document query that, and propose_file / archive_file notice when the same bytes are
// already archived.
//
// An agent may attach one more write to a document (e.g. a note in its knowledge base) through `extra`: it is
// prepared when proposing, shown in the same proposal, and run after the upload. An agent may also restrict which keys
// a sender sees and writes (`keyFilter`; e.g. each person's own documents). Which conversation and person a call
// belongs to comes from the host's pass (pass.ts), never from the model.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
	DOCUMENT_TYPES,
	type DocsArchive,
	type DocumentStore,
	type Embedder,
	type Indexer,
	isDocumentKey,
	KeyTaken,
	kebabName,
	type Listed,
	safeError,
	sha256,
} from "../core/index.ts";
import type { ApprovalGate, InboxFile, Proposal } from "./approval.ts";
import { type Who, whoOf } from "./pass.ts";

/** list_documents page size, and how many description HEADs run at once. */
const LIST_PAGE = 50;
const HEAD_CONCURRENCY = 8;
/** read_document returns the text in pages of this many characters. */
const READ_PAGE = 12_000;
/** search_documents with a key filter asks the index for this many times `limit` hits (capped), then filters. */
const FILTER_OVERFETCH = 4;
const FILTER_FETCH_MAX = 40;
const NO_INDEX = { error: "índice de documentos indisponível" };

/** A write the agent adds to a document proposal: its preview, and what save runs after the upload. */
export interface Extra {
	/** Words for the proposal summary, e.g. "e criar documentos.md". */
	summary: string;
	/** Shown with the proposal, e.g. the note's changed lines. */
	preview: Record<string, string>;
	/** Runs after the file is in S3; returns fields for save's reply (e.g. the commit URL). */
	commit: () => Promise<Record<string, string>>;
}

export interface ArchiveToolsOptions {
	gate: ApprovalGate;
	docs?: DocsArchive;
	/** The agent's document index; absent -> archiving works as without it, and the search tools say it is unavailable. */
	index?: DocumentStore;
	indexer?: Indexer;
	/** For query vectors in search_documents; absent -> keyword search only. */
	embedder?: Embedder;
	/** "WhatsApp da empresa": where a refusal says writes come from (pt-BR, it ends a sentence shown to the person). */
	where: string;
	/** "no arquivo da empresa": the archive's name in tool descriptions (pt-BR). */
	archiveName: string;
	/** Log prefix, e.g. "[clerk]". */
	log?: string;
	/** Extra input for propose_file, and how to turn it (with the resolved key) into an Extra. */
	extra?: {
		schema: z.ZodRawShape;
		description: string;
		prepare: (input: Record<string, unknown>, key: string, reason: string) => Promise<Extra | { error: string } | undefined>;
	};
	/** Proposal kinds other than "document" that save should run (e.g. notes). */
	runOther?: (p: Proposal) => Promise<Record<string, unknown>>;
	/** Archive on the model's call, with no "yes": propose_file and save are replaced by archive_file (for people who asked for no confirmation). `extra` is not supported with it. */
	immediate?: boolean;
	/** Which keys the run's sender may see and write (needs the pass, so Studio/API runs are refused). Read tools hide other keys; propose_file / archive_file refuse them with `hint`. */
	keyFilter?: { allow: (key: string, who: Who) => boolean; hint: string };
}

interface DocumentPayload {
	key: string;
	/** The exact file shown in the proposal, copied when proposing: a later message's files never replace it. */
	file: InboxFile;
	description: string;
	extra?: Extra;
}

type ToolCtx = Parameters<typeof whoOf>[0];

const EXT_BY_TYPE: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };

const fileInput = {
	index: z.number().int().min(0).describe("Índice em received_files"),
	year: z.number().int().min(2000).max(2100),
	month: z.number().int().min(1).max(12),
	name: z.string().min(3).max(120).describe("Nome do arquivo, ex.: nf-ferragem-silva-2026-11-03.pdf"),
	description: z
		.string()
		.min(3)
		.max(300)
		.describe("Uma linha: o que é o documento, ex.: Contrato de prestação de serviços com o escritório X, vigência até 2027-10"),
};

function buildTools(opts: ArchiveToolsOptions) {
	const { gate, docs, where, index: docsIndex, indexer, embedder } = opts;
	const needDocs = () => {
		if (!docs) throw new Error("arquivo de documentos indisponível (S3 não configurado)");
		return docs;
	};
	/** The run's key filter, bound to its sender; undefined when the agent has none. Throws without a pass. */
	const filterOf = (ctx: ToolCtx): ((key: string) => boolean) | undefined => {
		const kf = opts.keyFilter;
		if (!kf) return undefined;
		const who = whoOf(ctx, where);
		return (key) => kf.allow(key, who);
	};
	const refusedKey = (key: string) => ({ error: `${key}: ${opts.keyFilter?.hint ?? "caminho não permitido"}` });

	/** The inbox file `index` and the free key it would get, after the key filter; `dup` = where identical bytes already are. */
	const resolveFile = async (input: { index: number; year: number; month: number; name: string }, ctx: ToolCtx) => {
		const { conversation, sender } = whoOf(ctx, where);
		const file = gate.files(conversation)[input.index];
		if (!file) return { error: "não há arquivo com esse índice; peça para enviar de novo" };
		const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase() ?? EXT_BY_TYPE[file.mimeType];
		const base = kebabName(input.name).replace(/\.[a-z0-9]{1,5}$/, "");
		const wanted = `documents/${input.year}/${String(input.month).padStart(2, "0")}/${base}${ext ? `.${ext}` : ""}`;
		// Checked on the wanted name: freeKey's "-2" suffix never changes whose document it is.
		const allowed = filterOf(ctx);
		if (allowed && !allowed(wanted)) return refusedKey(wanted);
		const key = await needDocs().freeKey(wanted);
		const snapshot: InboxFile = { name: file.name, mimeType: file.mimeType, data: Uint8Array.from(file.data) };
		// A duplicate the sender may not see is no duplicate for them: never name its key, archive their own copy.
		const dups = docsIndex ? await docsIndex.keysBySha(sha256(file.data)) : [];
		const dup = allowed ? dups.find(allowed) : dups[0];
		return { conversation, sender, file, key, snapshot, dup };
	};

	/** Uploads a document (never over an existing key), records it for the indexer and runs its extra. */
	const store = async (d: DocumentPayload): Promise<{ taken: true } | Record<string, string>> => {
		let versionId: string | undefined;
		try {
			({ versionId } = await needDocs().put(d.key, d.file.data, d.file.mimeType, d.description));
		} catch (e) {
			if (e instanceof KeyTaken) return { taken: true };
			throw e;
		}
		// Recorded before replying, so a restart before the indexer reads it leaves a pending row for the sweep.
		if (docsIndex) {
			const { data, mimeType } = d.file;
			await docsIndex.markPending({
				key: d.key,
				versionId,
				sha256: sha256(data),
				bytes: data.byteLength,
				contentType: mimeType,
				description: d.description,
				archivedAt: new Date().toISOString().slice(0, 10),
			});
			indexer?.enqueue({ key: d.key, data, mimeType, description: d.description, versionId });
		}
		const more = d.extra ? await d.extra.commit() : {};
		return { file: d.key, indexing: docsIndex && indexer ? "in-progress" : "unavailable", ...more };
	};

	const received_files = createTool({
		id: "received_files",
		description: "Lista os arquivos (PDF, foto, documento) enviados na última mensagem com anexo desta conversa, para arquivar.",
		inputSchema: z.object({}),
		execute: async (_input, ctx) => {
			const { conversation } = whoOf(ctx, where);
			return { files: gate.files(conversation).map((f, i) => ({ index: i, name: f.name, type: f.mimeType, kb: Math.ceil(f.data.byteLength / 1024) })) };
		},
	});

	const propose_file = createTool({
		id: "propose_file",
		description: `Propõe arquivar um arquivo recebido ${opts.archiveName}, em documents/AAAA/MM/<nome-kebab-com-data>.<ext> (mês do próprio documento), com uma descrição de uma linha (tipo, partes, assunto e prazos; sem valores financeiros), que fica gravada com o arquivo e aparece em list_documents.${opts.extra ? ` ${opts.extra.description}` : ""}${opts.keyFilter ? ` ${opts.keyFilter.hint}.` : ""} Não grava: mostre a proposta e peça "sim".`,
		inputSchema: z.object({
			...fileInput,
			reason: z.string().min(3).max(200),
			...(opts.extra?.schema ?? {}),
		}),
		execute: async (input, ctx) => {
			const { description, reason } = input as { description: string; reason: string };
			const r = await resolveFile(input as { index: number; year: number; month: number; name: string }, ctx);
			if ("error" in r) return r;
			const { conversation, sender, file, key, snapshot, dup } = r;
			const extra = opts.extra ? await opts.extra.prepare(input as Record<string, unknown>, key, reason) : undefined;
			if (extra && "error" in extra) return extra;
			const summary = `Arquivar ${file.name} (${Math.ceil(file.data.byteLength / 1024)} KB) como ${key}${extra ? ` ${extra.summary}` : ""}: ${description}`;
			gate.propose(conversation, sender, "document", summary, { key, file: snapshot, description, extra } satisfies DocumentPayload);
			return {
				proposal: summary,
				...(extra?.preview ?? {}),
				...(dup ? { warning: `um arquivo idêntico já está arquivado em ${dup}` } : {}),
				next_step: 'Mostre isto e pergunte se pode arquivar. Arquive só se a próxima mensagem for um "sim".',
			};
		},
	});

	const save = createTool({
		id: "save",
		description: 'Grava a proposta pendente desta conversa, somente depois que a pessoa respondeu "sim". Sem "sim", recusa.',
		inputSchema: z.object({}),
		execute: async (_input, ctx) => {
			const { conversation } = whoOf(ctx, where);
			const p = gate.take(conversation);
			if ("refused" in p) return { refused: p.refused };
			if (p.kind !== "document") {
				if (!opts.runOther) return { refused: "tipo de proposta desconhecido" };
				return { saved: p.summary, ...(await opts.runOther(p)) };
			}
			const d = p.payload as DocumentPayload;
			const stored = await store(d);
			// Another document took this key after the proposal. Never rename it now: the person approved this name.
			if ("taken" in stored)
				return {
					refused: `${d.key} foi ocupado por outro documento depois da proposta; nada foi gravado. Proponha de novo (propose_file escolhe outro nome).`,
				};
			return { saved: p.summary, ...stored };
		},
	});

	const archive_file = createTool({
		id: "archive_file",
		description: `Arquiva na hora um arquivo recebido ${opts.archiveName}, em documents/AAAA/MM/<nome-kebab-com-data>.<ext> (mês do próprio documento), com uma descrição de uma linha (tipo, partes, assunto; sem valores financeiros) que fica gravada com o arquivo e aparece em list_documents.${opts.keyFilter ? ` ${opts.keyFilter.hint}.` : ""} Se um arquivo idêntico já estiver arquivado, não grava de novo e devolve already_archived.`,
		inputSchema: z.object(fileInput),
		execute: async (input, ctx) => {
			const r = await resolveFile(input, ctx);
			if ("error" in r) return r;
			if (r.dup) return { already_archived: r.dup };
			const stored = await store({ key: r.key, file: r.snapshot, description: input.description });
			// Two archive_file calls raced for the same free name: nothing was written, the next call picks another.
			if ("taken" in stored) return { refused: `${r.key} foi ocupado por outro documento agora; nada foi gravado. Chame archive_file de novo.` };
			return { saved: `Arquivado ${r.file.name} como ${r.key}: ${input.description}`, ...stored };
		},
	});

	const document_link = createTool({
		id: "document_link",
		description:
			"Gera um link temporário (7 dias) para baixar um documento do S3. Use o caminho documents/AAAA/MM/<nome> (de search_documents, list_documents ou de uma nota, sem o prefixo s3:).",
		inputSchema: z.object({ path: z.string() }),
		execute: async ({ path }, ctx) => {
			const key = path.replace(/^s3:/, "");
			if (!isDocumentKey(key)) return { error: "caminho inválido: deve ser documents/AAAA/MM/<nome>" };
			const allowed = filterOf(ctx);
			if (allowed && !allowed(key)) return refusedKey(key);
			if (!(await needDocs().exists(key))) return { error: `não encontrei ${key}` };
			return { link: await needDocs().link(key), valid_for: "7 dias" };
		},
	});

	const list_documents = createTool({
		id: "list_documents",
		description:
			"Lista os documentos arquivados (o próprio S3 é o índice): caminho, tamanho, data em que foi arquivado e a descrição, até 50 por vez. Use documents/ para tudo, documents/AAAA/ para um ano ou documents/AAAA/MM/ para um mês. Se a resposta trouxer `cursor`, há mais: chame de novo com o mesmo prefixo e esse valor em `cursor` até não vir mais nada, antes de dizer que um documento não existe.",
		inputSchema: z.object({
			prefix: z.string().regex(/^documents\/(\d{4}\/((0[1-9]|1[0-2])\/)?)?$/),
			cursor: z.string().max(2048).optional().describe("O valor `cursor` da página anterior"),
		}),
		execute: async ({ prefix, cursor }, ctx) => {
			const allowed = filterOf(ctx);
			const page = await needDocs().list(prefix, LIST_PAGE, cursor);
			const items = allowed ? page.items.filter((l) => allowed(l.key)) : page.items;
			// Descriptions are one HEAD each; a few at a time, never a burst of 50 parallel requests.
			const described: (Listed & { description: string })[] = [];
			for (let i = 0; i < items.length; i += HEAD_CONCURRENCY) {
				const batch = items.slice(i, i + HEAD_CONCURRENCY);
				described.push(...(await Promise.all(batch.map(async (l) => ({ ...l, description: await needDocs().describe(l.key) })))));
			}
			return {
				documents: described.map((d) => ({ path: d.key, kb: d.kb, archived_at: d.archived, description: d.description })),
				...(page.next ? { cursor: page.next } : {}),
			};
		},
	});

	const search_documents = createTool({
		id: "search_documents",
		description:
			'Busca nos documentos arquivados por palavras e por significado (texto extraído de cada documento + tipo, título, partes, data, vencimentos, resumo e descrição). Devolve caminho, título, tipo, data, partes, vencimentos, resumo e um trecho. Filtros: tipo, ano (do documento ou da pasta) e due_by (algum vencimento até essa data, AAAA-MM-DD). Sem query, lista os filtrados, mais recentes primeiro. state "pending" = arquivado mas ainda sendo lido (só título e descrição); "failed" = não foi possível ler.',
		inputSchema: z.object({
			query: z.string().max(300).optional(),
			type: z.enum(DOCUMENT_TYPES).optional(),
			year: z.number().int().min(2000).max(2100).optional(),
			due_by: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),
			limit: z.number().int().min(1).max(20).default(8),
		}),
		execute: async ({ query, type, year, due_by, limit }, ctx) => {
			const allowed = filterOf(ctx);
			if (!docsIndex) return NO_INDEX;
			const q = query?.trim() || undefined;
			// Bedrock down or throttled: search by keywords alone rather than fail, and say so (result, log, index meta).
			let queryVector: number[] | undefined;
			let degraded: string | undefined;
			if (q && embedder) {
				try {
					queryVector = (await embedder.embed([q], "query"))[0];
				} catch (e) {
					degraded = safeError(e);
					console.warn(`${opts.log ?? "[archive]"} search keyword-only: query embedding failed: ${degraded}`);
					await docsIndex.noteSemanticFailure(degraded);
				}
			}
			const want = limit ?? 8;
			const found = await docsIndex.search({
				query: q,
				queryVector,
				type,
				year,
				dueBy: due_by,
				limit: allowed ? Math.min(want * FILTER_OVERFETCH, FILTER_FETCH_MAX) : want,
			});
			const hits = allowed ? found.filter((h) => allowed(h.key)).slice(0, want) : found;
			return {
				documents: hits.map((h) => ({
					path: h.key,
					title: h.title,
					type: h.type,
					document_date: h.documentDate,
					parties: h.parties,
					deadlines: h.deadlines,
					summary: h.summary,
					snippet: h.snippet,
					state: h.state,
				})),
				...(degraded ? { search_mode: "keyword-only", warning: "busca por significado indisponível agora; resultados só por palavras" } : {}),
				...(await docsIndex.stats()),
			};
		},
	});

	const read_document = createTool({
		id: "read_document",
		description: `Lê o texto extraído de um documento arquivado (caminho documents/AAAA/MM/<nome>, de search_documents ou de uma nota, com ou sem s3:), com título, tipo, data, partes, vencimentos e resumo. Textos longos vêm em partes de ${READ_PAGE} caracteres: se vier next_offset, chame de novo com offset igual a ele para continuar.`,
		inputSchema: z.object({ path: z.string(), offset: z.number().int().min(0).default(0) }),
		execute: async ({ path, offset }, ctx) => {
			const allowed = filterOf(ctx);
			if (!docsIndex) return NO_INDEX;
			const key = path.replace(/^s3:/, "");
			if (!isDocumentKey(key)) return { error: "caminho inválido: deve ser documents/AAAA/MM/<nome>" };
			if (allowed && !allowed(key)) return refusedKey(key);
			const row = await docsIndex.get(key);
			if (!row) return { error: `não encontrei ${key} no índice` };
			if (row.state !== "indexed") return { error: `${key} ainda não foi lido (estado: ${row.state})` };
			const start = offset ?? 0;
			const end = start + READ_PAGE;
			return {
				path: key,
				title: row.title,
				type: row.type,
				document_date: row.documentDate,
				parties: row.parties,
				deadlines: row.deadlines,
				summary: row.summary,
				text: row.text.slice(start, end),
				total_chars: row.text.length,
				...(end < row.text.length ? { next_offset: end } : {}),
			};
		},
	});

	return { received_files, propose_file, save, archive_file, document_link, list_documents, search_documents, read_document };
}

type Tools = ReturnType<typeof buildTools>;
type Shared = "received_files" | "document_link" | "list_documents" | "search_documents" | "read_document";

/** The archive's tools: propose_file + save (a "sim" confirms), or archive_file with `immediate`. */
export function archiveTools(opts: ArchiveToolsOptions & { immediate: true }): Pick<Tools, Shared | "archive_file">;
export function archiveTools(opts: ArchiveToolsOptions & { immediate?: false }): Pick<Tools, Shared | "propose_file" | "save">;
export function archiveTools(opts: ArchiveToolsOptions): Pick<Tools, Shared | "archive_file"> | Pick<Tools, Shared | "propose_file" | "save"> {
	if (opts.immediate && opts.extra) throw new Error("archiveTools: extra is not supported with immediate");
	const { propose_file, save, archive_file, ...shared } = buildTools(opts);
	return opts.immediate ? { ...shared, archive_file } : { ...shared, propose_file, save };
}

/**
 * How to work with the archive, for the agent's system prompt (pt-BR, like the tool descriptions), built from the same
 * options as archiveTools so it always describes the tools the agent has: that files which are not notes live only in
 * the archive (never in the notes base, which only links them), the confirmation flow or immediate archiving, and the
 * key filter's rule. Nothing about the documents themselves: a host appends it to its own prompt.
 */
export function archiveInstructions(opts: Pick<ArchiveToolsOptions, "archiveName" | "immediate" | "keyFilter">): string {
	const lines = [
		`Arquivo de documentos ${opts.archiveName}: PDFs, fotos e documentos em documents/AAAA/MM/<nome>, cada um com uma descrição de uma linha.`,
		"- Arquivos que não são notas (PDF, fotos, imagens, documentos de escritório) moram só no arquivo: nunca como arquivo na base de notas nem embutidos numa nota (![[...]]); uma nota só linka o caminho que o arquivo devolveu.",
		"- Para achar: search_documents (palavras, significado, tipo, ano, vencimento até uma data); list_documents só para folhear um mês. Para responder sobre o conteúdo, leia com read_document e cite o caminho. Para mandar um documento a alguém, document_link (vale 7 dias).",
		"- Para arquivar um arquivo recebido na conversa (received_files lista os da última mensagem com anexo): leia o conteúdo e identifique tipo, data, partes e prazos; nome em kebab-case com a data (ex.: nf-ferragem-silva-2026-11-03.pdf) e o mês do próprio documento.",
	];
	if (opts.immediate) {
		lines.push(
			"- Arquive com archive_file, sem pedir confirmação. Se ele responder already_archived, o mesmo arquivo já está arquivado: diga onde e não arquive de novo.",
		);
	} else {
		lines.push(
			'- Proponha com propose_file, mostre a proposta e pergunte se pode arquivar. Só chame save depois que a próxima mensagem da mesma pessoa for um "sim" (ou "ok", "pode"); se ela pedir ajuste, proponha de novo; se save recusar, explique e proponha de novo. save executa a proposta pendente da conversa, uma por vez.',
			"- Se propose_file avisar que um arquivo idêntico já está arquivado, diga onde e pergunte se ainda quer arquivar.",
		);
	}
	lines.push(
		"- Nunca diga que arquivou sem o retorno da ferramenta. O caminho final é o que ela devolve (pode ganhar -2 se o nome já existia); numa nota, linke o arquivo como (s3:<caminho>), seguindo as regras da base de notas.",
	);
	if (opts.keyFilter) lines.push(`- ${opts.keyFilter.hint}`);
	return lines.join("\n");
}
