// The /btw side request: one-shot, in-process, and cache-parity with the main
// conversation.
//
// The request is the session's own projection - the messages the next main turn
// would send, including the system message that carries the prompt and the tool
// declarations - plus one user message holding the side question. Nothing
// overrides the system prompt or the tool loadout, and `toolChoice` is "none",
// so the provider prefix is byte-identical to the main request: the whole
// conversation is served from the prompt cache and only the question is new.
//
// That is the point of this module. The child-process design rebuilt the prompt
// and the tool list in a forked session, so the prefix never matched and every
// question re-billed the whole context at full input price.

import type { AssistantMessage, AssistantMessageEventStream, Context, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Tells the model what this request is, without touching the cached prefix. */
export const BTW_INSTRUCTION =
	"This is a /btw side question. Answer it from the conversation above. You have no tools here, so do not offer to run or change anything; if the conversation does not contain the answer, say what is missing.";

/**
 * The exact context the side request sends.
 *
 * `buildSessionContext` is the same projection pi feeds its own next request:
 * it resolves compaction summaries, branch summaries and the system-message
 * deltas that carry the prompt and tool declarations. Passing `systemPrompt` or
 * `tools` here would prepend a second, different leading system message and
 * break the cache, so neither is set.
 */
export function buildBtwContext(
	entries: readonly SessionEntry[],
	leafId: string | null,
	question: string,
	now = Date.now(),
): Context {
	const projection = buildSessionContext(entries as SessionEntry[], leafId);
	return {
		messages: [
			...(projection.messages as unknown as Context["messages"]),
			{
				role: "user",
				content: [{ type: "text", text: `${BTW_INSTRUCTION}\n\n${question}` }],
				timestamp: now,
			},
		],
	};
}

/**
 * Remove terminal escape sequences and C0 controls from streamed answer text.
 *
 * The answer can quote hostile tool output, and the viewer is a real terminal
 * program; a control sequence in the file would be obeyed by it.
 */
export function sanitizeAnswerText(text: string): string {
	return stripTerminalSequences(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export type BtwOutcome =
	| { status: "ok"; text: string; usage?: Usage }
	| { status: "cancelled" }
	| { status: "error"; message: string };

export interface BtwStreamRun {
	/** Receives each sanitized text delta in stream order. */
	onText: (text: string) => void | Promise<void>;
	signal?: AbortSignal;
}

/**
 * Consume one side-response stream.
 *
 * Text deltas are sanitized and forwarded as they arrive, so the viewer can
 * follow the answer; the final message maps an aborted/error stop reason to an
 * outcome instead of letting a failure masquerade as an answer.
 */
export async function runBtwStream(stream: AssistantMessageEventStream, run: BtwStreamRun): Promise<BtwOutcome> {
	let final: AssistantMessage | undefined;
	let failure: AssistantMessage | undefined;
	const chunks: string[] = [];

	for await (const event of stream) {
		if (event.type === "text_delta") {
			const text = sanitizeAnswerText(event.delta);
			if (text.length > 0) {
				chunks.push(text);
				await run.onText(text);
			}
			continue;
		}
		if (event.type === "done") {
			final = event.message;
			continue;
		}
		if (event.type === "error") {
			failure = event.error;
		}
	}

	if (run.signal?.aborted || final?.stopReason === "aborted" || failure?.stopReason === "aborted") {
		return { status: "cancelled" };
	}
	if (failure !== undefined || final?.stopReason === "error") {
		return { status: "error", message: failure?.errorMessage ?? final?.errorMessage ?? "the model call failed" };
	}
	if (final === undefined) {
		return { status: "error", message: "the stream ended without a response" };
	}
	const text = chunks.join("").trim();
	if (text.length === 0) {
		return { status: "error", message: "the model returned no text" };
	}
	return { status: "ok", text, usage: final.usage };
}

/** The answer file's footer, and the measurement the cache gate reads. */
export function formatBtwUsage(usage: Usage | undefined): string {
	if (usage === undefined) return "";
	const number = (value: number): string => value.toLocaleString("en-US");
	const parts = [`input ${number(usage.input)}`];
	if (usage.cacheRead > 0) parts.push(`cache read ${number(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`cache write ${number(usage.cacheWrite)}`);
	parts.push(`output ${number(usage.output)}`);
	return parts.join(" · ");
}
