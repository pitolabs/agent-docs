// archiveInstructions goes into the agent's prompt next to archiveTools built from the same options: it must name
// exactly the tools the agent has (a prompt that says "save" to an agent without it, or never mentions archive_file,
// sends the model the wrong way) and carry the key filter's rule when there is one.
import { describe, expect, test } from "bun:test";
import { ApprovalGate } from "../src/mastra/approval.ts";
import { archiveInstructions, archiveTools } from "../src/mastra/tools.ts";

const TOOL_NAMES = ["received_files", "propose_file", "save", "archive_file", "document_link", "list_documents", "search_documents", "read_document"];
const named = (text: string) => TOOL_NAMES.filter((t) => new RegExp(`\\b${t}\\b`).test(text)).sort();

describe("archiveInstructions", () => {
	const base = { gate: new ApprovalGate(), where: "WhatsApp da empresa", archiveName: "no arquivo da empresa" };

	test("with the confirmation gate: names propose_file and save, never archive_file, as the tools are", () => {
		const text = archiveInstructions(base);
		expect(named(text)).toEqual(Object.keys(archiveTools(base)).sort());
		expect(text).toContain("no arquivo da empresa");
		expect(text).toContain('"sim"');
	});

	test("immediate: names archive_file, never propose_file or save, as the tools are", () => {
		const opts = { ...base, immediate: true as const };
		const text = archiveInstructions(opts);
		expect(named(text)).toEqual(Object.keys(archiveTools(opts)).sort());
		expect(text).not.toContain('"sim"');
	});

	test("a key filter's rule is part of the instructions", () => {
		const hint = "só os documentos de quem escreve";
		expect(archiveInstructions({ ...base, keyFilter: { allow: () => true, hint } })).toContain(hint);
		expect(archiveInstructions(base)).not.toContain(hint);
	});
});
