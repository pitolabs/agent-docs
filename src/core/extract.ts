// One extraction pass per archived document, for the index: a model reads the PDF or photo and returns its full text
// as Markdown plus type, title, parties, date, deadlines and a summary, validated against ExtractionSchema. `Extract`
// is the contract; the Mastra entry point (mastra/extractor.ts) implements it with an agent, and EXTRACTOR_INSTRUCTIONS
// (pt-BR) is the prompt it uses. Office documents and HEIC photos are not sent to the model: they are indexed by name
// and description only (emptyExtraction, extracted_by "none").
import { z } from "zod";

export const DOCUMENT_TYPES = [
	"contract",
	"invoice",
	"receipt",
	"payment-proof",
	"bank-slip",
	"power-of-attorney",
	"corporate-document",
	"certificate",
	"personal-id",
	"correspondence",
	"photo",
	"exam-result",
	"prescription",
	"medical-report",
	"other",
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ExtractionSchema = z.object({
	type: z.enum(DOCUMENT_TYPES),
	title: z.string().min(1).max(200),
	parties: z.array(z.string().min(1).max(120)).max(20),
	document_date: z.string().regex(DATE).nullable(),
	deadlines: z.array(z.object({ date: z.string().regex(DATE), description: z.string().min(1).max(160) })).max(20),
	summary: z.string().min(1).max(400),
	language: z.string().min(2).max(10),
	text: z.string(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ExtractFile {
	name: string;
	mimeType: string;
	data: Uint8Array<ArrayBuffer>;
}
/** Reads one file with a model. `model` is recorded as the row's extracted_by. */
export interface Extract {
	(file: ExtractFile): Promise<Extraction>;
	readonly model: string;
}

export const TEXT_MAX = 60_000;
const IMAGE = /^image\/(jpeg|png|webp)$/;

/** PDFs and the photo formats the model reads; everything else is indexed by name and description only. */
export const isExtractable = (mimeType: string): boolean => mimeType === "application/pdf" || IMAGE.test(mimeType);

/** What a file the model does not read is indexed with. */
export const emptyExtraction = (name: string): Extraction => ({
	type: "other",
	title: name.slice(0, 200) || "documento",
	parties: [],
	document_date: null,
	deadlines: [],
	summary: "",
	language: "",
	text: "",
});

/** The extractor's system prompt (pt-BR): the Markdown transcript, the fields and their rules. */
export const EXTRACTOR_INSTRUCTIONS = `Você extrai dados de UM documento (PDF ou foto) para um índice de busca. Responda só com o JSON pedido.

- text: transcreva o documento inteiro, na ordem de leitura, em Markdown (títulos, listas; tabelas como tabelas Markdown). Inclua todos os números e valores como aparecem. Se passar de 60.000 caracteres, pare e termine com "[texto truncado]".
- type: contract (contrato), invoice (nota fiscal), receipt (recibo), payment-proof (comprovante de pagamento), bank-slip (boleto), power-of-attorney (procuração), corporate-document (contrato social, ata, certidão da empresa), certificate (certidão, atestado, certificado), personal-id (documento pessoal), correspondence (carta, e-mail, notificação), photo (foto sem texto relevante), exam-result (resultado de exame de laboratório ou de imagem), prescription (receita médica), medical-report (laudo, relatório ou pedido médico), other.
- title: um título curto e descritivo, em português.
- parties: as partes (pessoas, empresas, órgãos) como escritas no documento.
- document_date: a data do próprio documento (emissão, assinatura) em AAAA-MM-DD, ou null se não houver.
- deadlines: datas que criam uma obrigação ou um fim (fim de vigência, vencimento de pagamento, validade, prazo de resposta), cada uma em AAAA-MM-DD com uma descrição curta. Lista vazia se não houver.
- summary: até 400 caracteres, em português: o que é o documento e o que importa nele.
- language: o idioma do documento (pt, en, es...).

Nunca invente valores, nomes ou datas: o que não estiver no documento fica de fora (ou null). Se a imagem estiver ilegível, devolva text vazio e diga isso no summary.`;
