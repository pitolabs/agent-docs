// Which WhatsApp conversation and person a run acts for, for an agent's write tools. The channel handler, after
// admitting a message, stamps the run's request context with a pass: an object only this module mints. Mastra's HTTP
// routes merge body.requestContext into a run, so plain strings could be forged from Studio or the API (and a forged
// proposal approved by the real person's next "sim"); an object identity cannot be.

interface ContextLike {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
}

export interface Who {
	conversation: string;
	/** The sender's phone (WhatsApp digits). */
	sender: string;
}

const PASS_KEY = "whatsappPass";
const passes = new WeakMap<object, Who>();

/** Called by the channel handler after admission: this run is `sender` writing in `conversation`. */
export function grantPass(ctx: ContextLike, who: Who): void {
	const pass = Object.freeze({});
	passes.set(pass, { ...who });
	ctx.set(PASS_KEY, pass);
}

/** The run's pass, or a refusal naming where writes come from. */
export function whoOf(ctx: { requestContext?: { get: (k: string) => unknown } } | undefined, where: string): Who {
	const pass = ctx?.requestContext?.get(PASS_KEY);
	const w = typeof pass === "object" && pass !== null ? passes.get(pass) : undefined;
	if (!w) throw new Error(`sem conversa do WhatsApp: escrita só pelo ${where}`);
	return w;
}
