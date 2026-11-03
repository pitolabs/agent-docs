// The approval contract the docs promise: a whole message that only says yes (pt-BR or English) approves the pending
// proposal; a yes with anything else, another person, or a message received before the proposal does not; take()
// hands a proposal out once.
import { describe, expect, test } from "bun:test";
import { ApprovalGate, isApproval } from "../src/mastra/approval.ts";

describe("isApproval", () => {
	test("pt-BR and English yeses, with trailing punctuation and leading mentions", () => {
		for (const t of ["sim", "Sim!", "pode arquivar", "ok", "yes", "Yes.", "YEP", "sure", "go ahead", "save it", "confirmed", "👍", "@12025550123 yes"]) {
			expect({ t, yes: isApproval(t) }).toEqual({ t, yes: true });
		}
	});
	test("a yes with a condition, a question or anything else is not a yes", () => {
		for (const t of ["sim, mas troca o título", "yes, but change the title", "yes?", "not yet", "save as pdf", "yes please", ""]) {
			expect({ t, yes: isApproval(t) }).toEqual({ t, yes: false });
		}
	});
});

describe("ApprovalGate", () => {
	const setup = () => {
		let now = 1_000;
		const gate = new ApprovalGate(() => now);
		const say = (from: string, text: string) => gate.onMessage("c1", from, text, gate.receive());
		return { gate, say, tick: (ms: number) => (now += ms) };
	};

	test("an English yes from the proposer approves; take() hands the proposal out once", () => {
		const { gate, say } = setup();
		gate.propose("c1", "ana", "document", "Arquivar contrato.pdf", { key: "k" });
		expect(say("ana", "yes")).toBe("Arquivar contrato.pdf");
		expect(gate.take("c1")).toMatchObject({ kind: "document", payload: { key: "k" } });
		expect(gate.take("c1")).toEqual({ refused: expect.stringContaining("não há proposta pendente") });
	});

	test("'yes, but…' drops the proposal, so save is refused", () => {
		const { gate, say } = setup();
		gate.propose("c1", "ana", "document", "Arquivar contrato.pdf", {});
		expect(say("ana", "yes, but change the title")).toBeUndefined();
		expect(gate.take("c1")).toEqual({ refused: expect.stringContaining("não há proposta pendente") });
	});

	test("someone else's yes, or a yes received before the proposal, does not approve", () => {
		const { gate, say } = setup();
		const early = gate.receive();
		gate.propose("c1", "ana", "document", "Arquivar contrato.pdf", {});
		expect(gate.onMessage("c1", "ana", "yes", early)).toBeUndefined();
		expect(gate.take("c1")).toEqual({ refused: expect.stringContaining("ainda não confirmado") });
		expect(say("ben", "yes")).toBeUndefined();
		expect(gate.take("c1")).toEqual({ refused: expect.stringContaining("não há proposta pendente") });
	});

	test("a yes an hour later is too late", () => {
		const { gate, say, tick } = setup();
		gate.propose("c1", "ana", "document", "Arquivar contrato.pdf", {});
		tick(60 * 60_000);
		expect(say("ana", "yes")).toBeUndefined();
		expect(gate.take("c1")).toEqual({ refused: expect.stringContaining("não há proposta pendente") });
	});
});
