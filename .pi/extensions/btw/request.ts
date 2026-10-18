// The /btw side request: one-shot, in-process, and cache-parity with the main
// conversation.
//
// The request is the session's own projection - the messages the next main turn
// would send - plus one user message holding the side question. `convertToLlm`
// is applied to the projection first, because its roles are AgentMessage roles
// (`compactionSummary`, `branchSummary`, `custom`, `bashExecution`) that the
// main pipeline rewrites into LLM messages before sending. Skipping that
// conversion changes the request exactly on compacted sessions - the sessions
// whose context is too expensive to re-send - and can be rejected outright by
// OpenAI-compatible providers.
//
// With that conversion in place, nothing overrides the system prompt or the
// tool loadout, so the provider prefix matches the main request and the whole
// conversation is served from the prompt cache. `toolChoice: "none"` keeps the
// model from calling the declared tools; it is a request field rather than
// prompt content, though note that some providers (Anthropic, per its prompt
// cache documentation) invalidate message blocks when `tool_choice` changes,
// which the cache measurement has to confirm on the provider actually in use.

import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Usage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ModelRegistry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Tells the model what this request is, without touching the cached prefix. */
export const BTW_INSTRUCTION =
	"This is a /btw side question. Answer it from the conversation above. You have no tools here, so do not offer to run or change anything; if the conversation does not contain the answer, say what is missing.";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The exact context the side request sends.
 *
 * `buildSessionContext` is the same projection pi resolves for its own next
 * request, and `convertToLlm` is the same conversion the agent loop runs before
 * streaming. `leafId: null` is normalized to `undefined` ("the current leaf")
 * because `null` means an empty path - the question alone, with no history.
 * Passing `systemPrompt` or `tools` would prepend a second, different leading
 * system message and break the cache, so neither is set.
 */
export function buildBtwContext(
	entries: readonly SessionEntry[],
	leafId: string | null | undefined,
	question: string,
	now = Date.now(),
): Context {
	const projection = buildSessionContext(entries as SessionEntry[], leafId ?? undefined);
	return {
		messages: [
			...convertToLlm(projection.messages),
			{
				role: "user",
				content: [{ type: "text", text: `${BTW_INSTRUCTION}\n\n${question}` }],
				timestamp: now,
			},
		],
	};
}

/**
 * Remove terminal escape sequences and control characters from answer text.
 *
 * The answer can quote hostile tool output, and the viewer is a real terminal
 * program; a control sequence in the file would be obeyed by it. Both C0 and C1
 * controls go, as do the bidi overrides that can reorder a line; newlines and
 * tabs stay. A sequence split across two deltas loses its ESC byte here and
 * degrades to inert literal text.
 */
export function sanitizeAnswerText(text: string): string {
	return stripTerminalSequences(text).replace(
		/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,
		"",
	);
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
 * outcome instead of letting a failure masquerade as an answer. A failure to
 * record a delta stops the run rather than throwing out of the outcome
 * contract. The returned `text` is trimmed for validation; the streamed deltas
 * are not, so the answer file can differ from it in surrounding whitespace.
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
				try {
					await run.onText(text);
				} catch (error) {
					return { status: "error", message: `could not record the answer: ${messageOf(error)}` };
				}
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

export interface BtwRequestDeps {
	modelRegistry: ModelRegistry;
	model: Model<Api>;
	entries: readonly SessionEntry[];
	leafId?: string | null;
	question: string;
	signal?: AbortSignal;
	onText: (text: string) => void | Promise<void>;
}

/**
 * One-shot side request on the session's model.
 *
 * The auth lookup and the `streamSimple` call live here, with `runBtwStream`,
 * so the tool-free property this module documents is the property it tests:
 * a bare context builder cannot guarantee `toolChoice`.
 */
export async function runBtwRequest(deps: BtwRequestDeps): Promise<BtwOutcome> {
	let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
	try {
		auth = await deps.modelRegistry.getApiKeyAndHeaders(deps.model);
	} catch (error) {
		return { status: "error", message: messageOf(error) };
	}
	if (auth.ok === false) return { status: "error", message: auth.error };

	let stream: AssistantMessageEventStream;
	try {
		stream = deps.modelRegistry.streamSimple(deps.model, buildBtwContext(deps.entries, deps.leafId, deps.question), {
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: deps.signal,
			// Tool-free without touching the prefix: tool_choice is a request
			// field, and the tool declarations stay in the transcript's system
			// message on both the main request and this one.
			toolChoice: "none",
		});
	} catch (error) {
		return { status: "error", message: messageOf(error) };
	}
	return runBtwStream(stream, { onText: deps.onText, signal: deps.signal });
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
