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
// conversation is served from the prompt cache.
//
// `tool_choice` is deliberately NOT set. Both Anthropic's cache documentation
// and the opencode-go measurement show that changing `tool_choice` invalidates
// the message-block cache: the same side question cost 808,589 input tokens
// with `none` and 813,184 cache-read tokens (79 new) without it. The tools stay
// declared for prefix parity, the new user message asks the model not to use
// them, and a tool call that produces no text is reported as an error rather
// than executed.
//
// One caveat is structural. The agent loop applies `transformContext` - the
// extension `context` handlers and, for a `before_agent_start` forced prompt, a
// collapsed system message - before streaming, and no extension API runs that
// chain. This request therefore matches a session without context-rewriting
// state; on a session with an active `/goal` the forced system prompt differs
// at byte 0, so the cache misses and the conversation is re-billed, and goal UI
// messages the main request strips are visible to the side model.

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	type ModelRegistry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Tells the model what this request is, without touching the cached prefix. */
export const BTW_INSTRUCTION =
	"This is a /btw side question. Answer it from the conversation above with text only: the tools declared in this request are not available here, and calling one will not work. If the conversation does not contain the answer, say what is missing.";

const IMAGE_BLOCKED_TEXT = "Image reading is disabled.";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Attach the ignored-tool-call count only when there is one, so outcomes stay exact. */
function withIgnored<T extends { status: string; usage?: Usage }>(outcome: T, ignored: number | undefined): T {
	return ignored === undefined ? outcome : { ...outcome, ignoredToolCalls: ignored };
}

/** What the synthetic tool result tells a model that tried to call one. */
const TOOL_REFUSAL =
	"Tools are disabled in this side panel and calling one again will not work. Answer the question from the conversation above with text only.";

/** Separates a tool-calling false start from the text-only continuation in the answer file. */
const TOOL_RETRY_MARKER = "\n\n_(the model tried to use a tool; answering without tools)_\n\n";

/** Add two usages, so a continued request reports everything it billed. */
function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

/**
 * The per-session routing headers pi's own request path adds.
 *
 * The SDK applies `mergeProviderAttributionHeaders` before dispatch, including
 * `x-opencode-session` for opencode providers; a raw `modelRegistry.streamSimple`
 * call (the only request API an extension has) skips that transform. On
 * opencode-go the header is mandatory — a request without it is refused with
 * `MissingSessionID` — and it is also what pins the prompt-cache lineage, so
 * passing the MAIN session id is precisely what lets this request reuse the
 * main conversation's cache.
 *
 * Mirrors pi's rule: provider `opencode`/`opencode-go`, or an opencode.ai host.
 * The telemetry attribution headers other providers use are not needed for
 * routing and are left to the SDK path.
 */
export function providerSessionHeaders(
	model: Pick<Model<Api>, "provider" | "baseUrl">,
	sessionId: string,
): Record<string, string> {
	let host: string | undefined;
	try {
		host = typeof model.baseUrl === "string" ? new URL(model.baseUrl).hostname : undefined;
	} catch {
		host = undefined;
	}
	if (model.provider !== "opencode" && model.provider !== "opencode-go" && host !== "opencode.ai") {
		return {};
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/**
 * Replace image blocks with the main loop's placeholder when `images.blockImages`
 * is on, mirroring its `convertToLlmWithBlockImages` wrapper (consecutive
 * placeholders collapse the same way). Without this, an image in the history
 * would diverge the prefix and a vision-less model could reject the request.
 */
function withoutImageBlocks(messages: Message[]): Message[] {
	return messages.map((message) => {
		if (message.role !== "user" && message.role !== "toolResult") return message;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content) || !content.some((part) => (part as { type?: string }).type === "image")) {
			return message;
		}
		const filtered = content
			.map((part) => ((part as { type?: string }).type === "image" ? { type: "text", text: IMAGE_BLOCKED_TEXT } : part))
			.filter(
				(part, index, all) =>
					!(
						(part as { type?: string }).type === "text" &&
						(part as { text?: string }).text === IMAGE_BLOCKED_TEXT &&
						index > 0 &&
						(all[index - 1] as { type?: string }).type === "text" &&
						(all[index - 1] as { text?: string }).text === IMAGE_BLOCKED_TEXT
					),
			);
		return { ...message, content: filtered } as Message;
	});
}

export interface BtwRequestParts {
	context: Context;
	/** The session's thinking level, forwarded as the request's `reasoning`. */
	thinkingLevel: string | undefined;
}

/**
 * The exact context the side request sends, plus the session thinking level.
 *
 * `buildSessionContext` is the same projection pi resolves for its own next
 * request, and `convertToLlm` is the same conversion the agent loop runs before
 * streaming. `leafId: null` is normalized to `undefined` ("the current leaf")
 * because `null` means an empty path - the question alone, with no history.
 * Passing `systemPrompt` or `tools` would prepend a second, different leading
 * system message and break the cache, so neither is set.
 */
export function buildBtwRequestParts(
	entries: readonly SessionEntry[],
	leafId: string | null | undefined,
	question: string,
	now = Date.now(),
	options: { blockImages?: boolean } = {},
): BtwRequestParts {
	const projection = buildSessionContext(entries as SessionEntry[], leafId ?? undefined);
	const converted = convertToLlm(projection.messages);
	return {
		context: {
			messages: [
				...(options.blockImages === true ? withoutImageBlocks(converted) : converted),
				{
					role: "user",
					content: [{ type: "text", text: `${BTW_INSTRUCTION}\n\n${question}` }],
					timestamp: now,
				},
			],
		},
		thinkingLevel: projection.thinkingLevel,
	};
}

/** The context alone, for callers that do not need the thinking level. */
export function buildBtwContext(
	entries: readonly SessionEntry[],
	leafId: string | null | undefined,
	question: string,
	now = Date.now(),
	options: { blockImages?: boolean } = {},
): Context {
	return buildBtwRequestParts(entries, leafId, question, now, options).context;
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
	| { status: "ok"; text: string; usage?: Usage; ignoredToolCalls?: number }
	| { status: "cancelled"; usage?: Usage; ignoredToolCalls?: number }
	| { status: "error"; message: string; usage?: Usage; ignoredToolCalls?: number };

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
 * outcome instead of letting a failure masquerade as an answer. Tool calls are
 * never executed; a response that carries them reports how many were ignored,
 * so an answer that says it did work cannot read as done. A failure to record a
 * delta stops the run rather than throwing out of the outcome contract. The
 * returned `text` is trimmed for validation; the streamed deltas are not, so
 * the answer file can differ from it in surrounding whitespace.
 */
interface BtwStreamResult {
	outcome: BtwOutcome;
	/** The response's final message, when the stream produced one. */
	final?: AssistantMessage;
	/** Tool calls the model made; they are never executed. */
	toolCalls: { id: string; name: string }[];
}

async function runBtwStreamDetailed(stream: AssistantMessageEventStream, run: BtwStreamRun): Promise<BtwStreamResult> {
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
					return { outcome: { status: "error", message: `could not record the answer: ${messageOf(error)}` }, toolCalls: [] };
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

	const source = failure ?? final;
	const toolCalls =
		source?.content
			.filter((block): block is { type: "toolCall"; id: string; name: string } => block.type === "toolCall")
			.map((block) => ({ id: block.id, name: block.name })) ?? [];
	const ignored = toolCalls.length > 0 ? toolCalls.length : undefined;

	if (run.signal?.aborted || final?.stopReason === "aborted" || failure?.stopReason === "aborted") {
		return { outcome: withIgnored({ status: "cancelled" as const, usage: source?.usage }, ignored), final, toolCalls };
	}
	if (failure !== undefined || final?.stopReason === "error") {
		return {
			outcome: withIgnored(
				{
					status: "error" as const,
					message: failure?.errorMessage ?? final?.errorMessage ?? "the model call failed",
					usage: source?.usage,
				},
				ignored,
			),
			final,
			toolCalls,
		};
	}
	if (final === undefined) {
		return { outcome: { status: "error", message: "the stream ended without a response" }, toolCalls };
	}
	const text = chunks.join("").trim();
	if (text.length === 0) {
		return {
			outcome: withIgnored(
				{
					status: "error" as const,
					message:
						final.stopReason === "toolUse"
							? "the model tried to use a tool; the side panel is text-only, so ask again"
							: "the model returned no text",
					usage: final.usage,
				},
				ignored,
			),
			final,
			toolCalls,
		};
	}
	return { outcome: withIgnored({ status: "ok" as const, text, usage: final.usage }, ignored), final, toolCalls };
}

/** The outcome alone, for tests and callers with no continuation. */
export async function runBtwStream(stream: AssistantMessageEventStream, run: BtwStreamRun): Promise<BtwOutcome> {
	return (await runBtwStreamDetailed(stream, run)).outcome;
}

export interface BtwRequestDeps {
	modelRegistry: ModelRegistry;
	model: Model<Api>;
	/** The MAIN session id: opencode routes its prompt cache by it. */
	sessionId: string;
	entries: readonly SessionEntry[];
	leafId?: string | null;
	question: string;
	signal?: AbortSignal;
	/** Mirror the main loop's image-blocking wrapper when the setting is on. */
	blockImages?: boolean;
	onText: (text: string) => void | Promise<void>;
}

/**
 * One-shot side request on the session's model.
 *
 * The auth lookup and the `streamSimple` call live here, with `runBtwStream`,
 * so the whole request shape — the session routing headers, the session
 * thinking level, the image-blocking mirror and the deliberate absence of
 * `tool_choice` — is tested as one unit.
 */
export async function runBtwRequest(deps: BtwRequestDeps): Promise<BtwOutcome> {
	let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
	try {
		auth = await deps.modelRegistry.getApiKeyAndHeaders(deps.model);
	} catch (error) {
		return { status: "error", message: messageOf(error) };
	}
	if (auth.ok === false) return { status: "error", message: auth.error };

	const parts = buildBtwRequestParts(deps.entries, deps.leafId, deps.question, Date.now(), {
		blockImages: deps.blockImages,
	});
	const headers = {
		...providerSessionHeaders(deps.model, deps.sessionId),
		...(auth.headers ?? {}),
	};
	const options = {
		apiKey: auth.apiKey,
		headers,
		signal: deps.signal,
		// The same routing/thinking fields the main request carries. The
		// sessionId feeds provider session affinity (OpenRouter's headers);
		// reasoning mirrors the session's thinking level, which Anthropic's
		// cache key also includes.
		sessionId: deps.sessionId,
		reasoning: parts.thinkingLevel as never,
		// No toolChoice: setting it changes the provider's cache key (see the
		// module header). The declared tools stay in the prefix; the
		// instruction asks the model not to use them.
	};

	// Tool calls are never executed. A tool-calling response is continued once
	// with a synthetic refusal, so the model answers text-only; the cached
	// prefix survives, which makes the continuation nearly free. A second
	// tool-calling response is reported instead of looping.
	const MAX_ATTEMPTS = 2;
	let messages: Message[] = parts.context.messages;
	let usage: Usage | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		let stream: AssistantMessageEventStream;
		try {
			stream = deps.modelRegistry.streamSimple(deps.model, { messages }, options);
		} catch (error) {
			return { status: "error", message: messageOf(error), usage };
		}
		const result = await runBtwStreamDetailed(stream, { onText: deps.onText, signal: deps.signal });
		usage = addUsage(usage, result.outcome.usage);
		if (result.toolCalls.length === 0 || result.final === undefined || result.outcome.status === "cancelled") {
			return { ...result.outcome, usage };
		}
		if (attempt === MAX_ATTEMPTS - 1) {
			return {
				status: "error",
				message: "the model kept trying to use tools; the side panel is text-only, so ask again",
				usage,
				ignoredToolCalls: result.toolCalls.length,
			};
		}
		const toolResults = result.toolCalls.map((call) => ({
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text: TOOL_REFUSAL }],
			isError: false,
			timestamp: Date.now(),
		}));
		messages = [...messages, result.final, ...toolResults] as Message[];
		await deps.onText(TOOL_RETRY_MARKER);
	}
	return { status: "error", message: "the model kept trying to use tools", usage };
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
