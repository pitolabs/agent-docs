// Writes need a confirmation, enforced here and not only in the agent's instructions. The agent proposes a change
// (an edit to a note, or a document to archive) with a propose_* tool; the proposal is stored per conversation. Only
// the *next* admitted message in that conversation, from the person the proposal was made to, can approve it, and
// only if that whole message is a short "yes" (sim, ok, pode, confirmo, ...; in a group, "@<agent> sim"). The
// agent's save tool then runs that proposal, once. Anything else (a question, a correction, a message from someone
// else, an hour going by) drops it, so the agent has to propose again. Proposals live in memory: a restart drops them.
//
// Files sent in the chat are kept per conversation: the attachments of the latest admitted turn (all its messages, when
// the host batches them) that had any, until newer files replace them. A document proposal copies the file it
// names, so save archives exactly what was shown, even if the approving message carries another file.

export interface Proposal {
	id: string;
	kind: "note" | "document";
	/** What the person sees and approves, verbatim. */
	summary: string;
	/** Phone of the person who asked (the one who may approve). */
	by: string;
	at: number;
	/** Receipt tick when the proposal was made: only a message received after it can approve it. */
	tick: number;
	approved: boolean;
	payload: unknown;
}

export interface InboxFile {
	name: string;
	mimeType: string;
	data: Uint8Array<ArrayBuffer>;
}

/** A whole message that only says yes, in pt-BR or English; the same list the docs promise. */
const YES =
	/^(sim|s|ok|okay|pode|pode sim|pode gravar|pode arquivar|grava|gravar|arquiva|arquivar|confirmo|confirmado|confirma|isso|isso mesmo|manda|beleza|blz|yes|y|yep|yeah|sure|go ahead|do it|save|save it|archive|archive it|confirm|confirmed|👍|✅)[\s.!]*$/iu;
const TTL_MS = 60 * 60_000;

/**
 * A whole message that only says yes. "sim, mas troca o título" / "yes, but change the title" is not a yes. Leading
 * @mentions ("@12025550123 sim", how a group confirmation reads) are not part of the answer.
 */
export const isApproval = (text: string): boolean =>
	YES.test(
		text
			.normalize("NFC")
			.trim()
			.replace(/^(@\S+\s*)+/, ""),
	);

export class ApprovalGate {
	private pending = new Map<string, Proposal>();
	private inbox = new Map<string, InboxFile[]>();
	private seq = 0;
	private clock = 0;

	constructor(private now: () => number = Date.now) {}

	/**
	 * Called when a message is admitted, before it waits for the conversation's earlier turn: its place in the order
	 * messages actually arrived. A "sim" queued while the previous turn is still preparing a proposal has an earlier
	 * receipt than that proposal, so it cannot approve something the person had not seen.
	 */
	receive(): number {
		return ++this.clock;
	}

	/**
	 * Called for every admitted message when its turn starts, with its receipt from receive(). A batched turn feeds it
	 * several messages in a row, so "sim" then "👍" from the proposer must stay approved, while any non-yes after the
	 * proposal still drops it; take() still deletes on success, so a save runs once. Approves the conversation's pending
	 * proposal when this is its proposer saying yes, received after the proposal (again, if it already was); otherwise
	 * drops it. Returns the approved proposal's summary, for the agent's context.
	 */
	onMessage(conversation: string, from: string, text: string, receipt: number): string | undefined {
		const p = this.pending.get(conversation);
		if (!p) return undefined;
		if (receipt <= p.tick) return undefined; // sent before the proposal existed: neither approves nor drops it
		if (p.by === from && this.now() - p.at < TTL_MS && isApproval(text)) {
			p.approved = true;
			return p.summary;
		}
		this.pending.delete(conversation);
		return undefined;
	}

	propose(conversation: string, by: string, kind: Proposal["kind"], summary: string, payload: unknown): Proposal {
		const p: Proposal = { id: `p${++this.seq}`, kind, summary, by, at: this.now(), tick: this.clock, approved: false, payload };
		this.pending.set(conversation, p);
		return p;
	}

	/** The conversation's approved proposal, removed so it runs once; otherwise why not. */
	take(conversation: string): Proposal | { refused: string } {
		const p = this.pending.get(conversation);
		if (!p) return { refused: "não há proposta pendente nesta conversa; proponha de novo" };
		if (!p.approved) return { refused: 'ainda não confirmado: espere o "sim" da pessoa na próxima mensagem' };
		this.pending.delete(conversation);
		return p;
	}

	setFiles(conversation: string, files: InboxFile[]): void {
		if (files.length) this.inbox.set(conversation, files);
	}

	files(conversation: string): InboxFile[] {
		return this.inbox.get(conversation) ?? [];
	}
}
