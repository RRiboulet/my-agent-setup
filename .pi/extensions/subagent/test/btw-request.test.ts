// Tests for the /btw request core.
//
// Risk covered: this module is the entire cache story. If the context is not
// the session projection *converted to LLM messages* plus one user message — or
// if a `systemPrompt`/`tools` override creeps in, or `toolChoice` stops being
// `none` — the provider prefix stops matching the main request and every
// question silently re-bills the whole conversation. The stream mapping is the
// second risk: an aborted or failed response must never be presented as an
// answer.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Usage,
} from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	BTW_INSTRUCTION,
	buildBtwContext,
	buildBtwRequestParts,
	providerSessionHeaders,
	reasoningOption,
	runBtwRequest,
	runBtwStream,
	sanitizeAnswerText,
} from "../../btw/request.ts";

const SESSION_ID = "01a14e96-1111-7000-8000-000000000001";
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "opencode-go",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

// A session with the entry types that make the projection differ from the wire
// transcript: a system delta, a normal exchange, a compaction summary and a
// custom message. Without convertToLlm those last two reach the provider as
// `compactionSummary` and `custom` roles.
const ENTRIES = [
	{
		type: "message",
		id: "s1",
		parentId: null,
		timestamp: "2026-10-18T00:00:00.000Z",
		message: {
			role: "system",
			content: "",
			sections: { preamble: "SYS", tools: "- read: read a file" },
			toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
			timestamp: 0,
		},
	},
	{
		type: "thinking_level_change",
		id: "t1",
		parentId: "s1",
		timestamp: "2026-10-18T00:00:00.500Z",
		thinkingLevel: "max",
	},
	{
		type: "message",
		id: "u1",
		parentId: "t1",
		timestamp: "2026-10-18T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-10-18T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "opencode-go",
			model: "test-model",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 2,
		},
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "a1",
		timestamp: "2026-10-18T00:00:03.000Z",
		summary: "Earlier we discussed the parser.",
		tokensBefore: 100,
		systemMessage: {
			role: "system",
			content: "",
			sections: { preamble: "SYS", tools: "- read: read a file" },
			toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
			timestamp: 3,
		},
	},
	{
		type: "custom_message",
		id: "cm1",
		parentId: "c1",
		timestamp: "2026-10-18T00:00:04.000Z",
		customType: "note",
		content: [{ type: "text", text: "remember the flag" }],
		display: true,
	},
] as unknown as SessionEntry[];

const LLM_ROLES = new Set(["system", "user", "assistant", "toolResult"]);

test("the context is the converted projection plus one user message", () => {
	const context = buildBtwContext(ENTRIES, "cm1", "why?", 123);

	assert.equal(context.systemPrompt, undefined, "no second system prompt is prepended");
	assert.equal(context.tools, undefined, "no tools override is prepended");
	assert.equal(context.messages[0]?.role, "system", "the projection's own system message leads");

	const roles = new Set(context.messages.map((message) => message.role));
	for (const role of roles) {
		assert.ok(LLM_ROLES.has(role), `role ${role} is not an LLM message role`);
	}
	assert.ok(!roles.has("compactionSummary"), "the summary must be converted, not sent raw");
	assert.ok(!roles.has("custom"), "custom messages must be converted, not sent raw");
	assert.ok(
		context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("Earlier we discussed the parser."),
		),
		"the compaction summary survives as a user message",
	);
	assert.ok(
		context.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("remember the flag"),
		),
		"the custom message survives as a user message",
	);

	const last = context.messages.at(-1);
	assert.equal(last?.role, "user");
	const text = (last?.content as { type: string; text: string }[])[0]?.text ?? "";
	assert.ok(text.startsWith(BTW_INSTRUCTION));
	assert.ok(text.endsWith("why?"));
	assert.equal((last as { timestamp?: number } | undefined)?.timestamp, 123);
});

test("the request parts carry the session thinking level", () => {
	assert.equal(buildBtwRequestParts(ENTRIES, "a1", "why?", 0).thinkingLevel, "max");
});

test("the thinking level drops 'off', the way the main loop does", () => {
	// Forwarding the literal "off" makes the Anthropic adapter enable a
	// thinking budget the main request does not have.
	assert.equal(reasoningOption("off"), undefined);
	assert.equal(reasoningOption(undefined), undefined);
	assert.equal(reasoningOption("max"), "max");
	assert.equal(reasoningOption("medium"), "medium");
});

test("the prefix is exactly the main pipeline's converted projection", () => {
	const projection = buildSessionContext(ENTRIES, "cm1");
	const context = buildBtwContext(ENTRIES, "cm1", "why?");
	assert.deepEqual(context.messages.slice(0, -1), convertToLlm(projection.messages));
});

test("a null leaf means the current leaf, not an empty path", () => {
	assert.deepEqual(
		buildBtwContext(ENTRIES, null, "why?", 7),
		buildBtwContext(ENTRIES, undefined, "why?", 7),
		"null must not silently drop the whole history",
	);
});

const IMAGE_ENTRIES = [
	{
		type: "message",
		id: "s1",
		parentId: null,
		timestamp: "2026-10-18T00:00:00.000Z",
		message: { role: "system", content: "", sections: { preamble: "SYS" }, timestamp: 0 },
	},
	{
		type: "message",
		id: "u1",
		parentId: "s1",
		timestamp: "2026-10-18T00:00:01.000Z",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "image", mimeType: "image/png", data: "BBBB" },
			],
			timestamp: 1,
		},
	},
] as unknown as SessionEntry[];

test("blockImages mirrors the main loop's image filter", () => {
	const blocked = buildBtwContext(IMAGE_ENTRIES, "u1", "why?", 0, { blockImages: true });
	const kept = buildBtwContext(IMAGE_ENTRIES, "u1", "why?", 0, { blockImages: false });
	assert.ok(
		JSON.stringify(blocked).includes("Image reading is disabled."),
		"the image becomes the main loop's placeholder",
	);
	assert.ok(!JSON.stringify(blocked).includes('"type":"image"'), "no image block survives the filter");
	const placeholders = JSON.stringify(blocked).match(/Image reading is disabled\./g) ?? [];
	assert.equal(placeholders.length, 1, "consecutive images collapse to one placeholder, like the main loop");
	assert.ok(JSON.stringify(kept).includes('"type":"image"'), "without the setting the image is sent");
});

test("terminal sequences, C0/C1 controls and bidi overrides are stripped", () => {
	assert.equal(sanitizeAnswerText("a\x1b[31mred\x1b[0m b"), "ared b");
	assert.equal(sanitizeAnswerText("x\u0000y\u0007z"), "xyz");
	assert.equal(sanitizeAnswerText("a\rb"), "ab", "CR is a C0 control and must not survive");
	assert.equal(sanitizeAnswerText("\u009B2J"), "2J", "the 8-bit CSI introducer is a C1 control");
	assert.equal(sanitizeAnswerText("\u202Eevil\u202C"), "evil", "bidi overrides are not display text");
	assert.equal(sanitizeAnswerText("line\nnext\tend"), "line\nnext\tend");
	assert.equal(sanitizeAnswerText("x\x1b[3"), "x[3", "a split sequence loses its ESC and becomes inert text");
});

test("text deltas stream through and the final usage is returned", async () => {
	const stream = createAssistantMessageEventStream();
	const chunks: string[] = [];
	const run = runBtwStream(stream, { onText: (text) => chunks.push(text) });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "Hel", partial: assistant() });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial: assistant() });
	const usage: Usage = { ...ZERO_USAGE, input: 10, cacheRead: 500, output: 3, totalTokens: 513 };
	stream.push({
		type: "done",
		reason: "stop",
		message: assistant({ content: [{ type: "text", text: "Hello" }], usage }),
	});

	const outcome = await run;
	assert.equal(outcome.status, "ok");
	assert.deepEqual(chunks, ["Hel", "lo"]);
	assert.equal(outcome.status === "ok" ? outcome.text : "", "Hello");
	assert.deepEqual(outcome.status === "ok" ? outcome.usage : undefined, usage);
});

test("an error event maps to an error outcome, never an answer", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	stream.push({ type: "error", reason: "error", error: assistant({ stopReason: "error", errorMessage: "boom" }) });
	assert.deepEqual(await run, { status: "error", message: "boom", usage: ZERO_USAGE });
});

test("an aborted response maps to cancelled", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	stream.push({ type: "error", reason: "aborted", error: assistant({ stopReason: "aborted" }) });
	assert.deepEqual(await run, { status: "cancelled", usage: ZERO_USAGE });
});

test("an aborted signal cancels even after a normal stop", async () => {
	const controller = new AbortController();
	controller.abort();
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined, signal: controller.signal });
	stream.push({ type: "done", reason: "stop", message: assistant({ content: [{ type: "text", text: "x" }] }) });
	assert.deepEqual(await run, { status: "cancelled", usage: ZERO_USAGE });
});

test("a response with no text is an error, not an empty answer", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	stream.push({ type: "done", reason: "stop", message: assistant() });
	assert.deepEqual(await run, { status: "error", message: "the model returned no text", usage: ZERO_USAGE });
});

test("a tool-only response is reported with its usage, never executed", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	const usage: Usage = { ...ZERO_USAGE, input: 3, cacheRead: 800_000, output: 2, totalTokens: 800_005 };
	stream.push({
		type: "done",
		reason: "toolUse",
		message: assistant({
			stopReason: "toolUse",
			usage,
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
		}),
	});
	const outcome = await run;
	assert.equal(outcome.status, "error");
	assert.match(outcome.status === "error" ? outcome.message : "", /tool/);
	assert.deepEqual(outcome.status === "error" ? outcome.usage : undefined, usage);
	assert.equal(outcome.ignoredToolCalls, 1);
});

test("a text answer that also called a tool is kept, with the ignored call reported", async () => {
	const stream = createAssistantMessageEventStream();
	const chunks: string[] = [];
	const run = runBtwStream(stream, { onText: (text) => chunks.push(text) });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: assistant() });
	stream.push({
		type: "done",
		reason: "toolUse",
		message: assistant({
			content: [
				{ type: "text", text: "done" },
				{ type: "toolCall", id: "c1", name: "write", arguments: {} },
			],
			stopReason: "toolUse",
		}),
	});
	const outcome = await run;
	assert.equal(outcome.status, "ok");
	assert.equal(outcome.status === "ok" ? outcome.text : "", "done");
	assert.equal(outcome.ignoredToolCalls, 1, "the dropped call is disclosed");
});

test("a tool-calling response is continued with a refusal and the final answer wins", async () => {
	const calls: { context: Context; options: Record<string, unknown> }[] = [];
	const usage1: Usage = { ...ZERO_USAGE, input: 2, cacheRead: 800_000, output: 4, totalTokens: 800_006 };
	const usage2: Usage = { ...ZERO_USAGE, input: 9, cacheRead: 800_100, output: 6, totalTokens: 800_115 };
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		streamSimple: (_model: unknown, context: Context, options: Record<string, unknown>) => {
			calls.push({ context, options });
			const stream = createAssistantMessageEventStream();
			if (calls.length === 1) {
				stream.push({ type: "text_delta", contentIndex: 0, delta: "let me check", partial: assistant() });
				stream.push({
					type: "done",
					reason: "toolUse",
					message: assistant({
						content: [
							{ type: "text", text: "let me check" },
							{ type: "toolCall", id: "c1", name: "grep", arguments: {} },
						],
						stopReason: "toolUse",
						usage: usage1,
					}),
				});
			} else {
				stream.push({ type: "text_delta", contentIndex: 0, delta: "the answer", partial: assistant() });
				stream.push({
					type: "done",
					reason: "stop",
					message: assistant({ content: [{ type: "text", text: "the answer" }], usage: usage2 }),
				});
			}
			return stream;
		},
	};
	const chunks: string[] = [];
	const outcome = await runBtwRequest({
		modelRegistry: modelRegistry as never,
		model: { provider: "opencode-go", id: "test-model" } as never,
		sessionId: SESSION_ID,
		entries: ENTRIES,
		leafId: "a1",
		question: "why?",
		onText: (text) => chunks.push(text),
	});

	assert.equal(calls.length, 2, "the tool-calling response is continued once");
	const retryMessages = (calls[1] as { context: Context }).context.messages;
	const firstMessages = (calls[0] as { context: Context }).context.messages;
	assert.deepEqual(
		retryMessages.slice(0, firstMessages.length),
		firstMessages,
		"the retried request resends attempt 1's messages unchanged",
	);
	assert.equal(retryMessages[retryMessages.length - 2]?.role, "assistant", "the model's call is kept");
	const retryResult = retryMessages[retryMessages.length - 1] as {
		role: string;
		toolCallId?: string;
		content?: { text?: string }[];
	};
	assert.equal(retryResult.role, "toolResult");
	assert.equal(retryResult.toolCallId, "c1");
	assert.match(retryResult.content?.[0]?.text ?? "", /disabled/i, "the refusal tells the model why");
	assert.equal(outcome.status, "ok");
	assert.equal(outcome.status === "ok" ? outcome.text : "", "the answer");
	assert.equal(outcome.usage?.input, usage1.input + usage2.input, "both attempts are billed");
	assert.equal(outcome.usage?.cacheRead, usage1.cacheRead + usage2.cacheRead);
	assert.ok(chunks.join("").includes("tried to use a tool"), "the false start is marked in the stream");
});

test("a model that keeps calling tools is cut off after one continuation", async () => {
	let calls = 0;
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		streamSimple: () => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "toolUse",
				message: assistant({
					content: [{ type: "toolCall", id: `c${calls}`, name: "read", arguments: {} }],
					stopReason: "toolUse",
				}),
			});
			return stream;
		},
	};
	const outcome = await runBtwRequest({
		modelRegistry: modelRegistry as never,
		model: { provider: "opencode-go", id: "test-model" } as never,
		sessionId: SESSION_ID,
		entries: ENTRIES,
		leafId: "a1",
		question: "why?",
		onText: () => undefined,
	});
	assert.equal(calls, 2, "the continuation is attempted exactly once");
	assert.equal(outcome.status, "error");
	assert.match(outcome.status === "error" ? outcome.message : "", /kept trying to use tools/);
	assert.equal(outcome.ignoredToolCalls, 1);
});

test("a failing onText handler is reported through the outcome and aborts the request", async () => {
	const stream = createAssistantMessageEventStream();
	let aborted = false;
	const run = runBtwStream(stream, {
		onText: () => {
			throw new Error("disk full");
		},
		abort: () => {
			aborted = true;
		},
	});
	stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: assistant() });
	const outcome = await run;
	assert.equal(outcome.status, "error");
	assert.match(outcome.status === "error" ? outcome.message : "", /disk full/);
	assert.equal(aborted, true, "the upstream request is not left running unbilled");
});

function fakeRegistry(auth: unknown = { ok: true, apiKey: "key", headers: { "x-test": "1" } }) {
	const calls: { model: unknown; context: Context; options: Record<string, unknown> }[] = [];
	const stream = createAssistantMessageEventStream();
	const modelRegistry = {
		getApiKeyAndHeaders: async () => auth,
		streamSimple: (model: unknown, context: Context, options: Record<string, unknown>) => {
			calls.push({ model, context, options });
			return stream;
		},
	};
	return { calls, stream, modelRegistry };
}

test("runBtwRequest sends the converted projection without tool_choice", async () => {
	const { calls, stream, modelRegistry } = fakeRegistry();
	const chunks: string[] = [];
	const running = runBtwRequest({
		modelRegistry: modelRegistry as never,
		model: { provider: "opencode-go", id: "test-model" } as never,
		sessionId: SESSION_ID,
		entries: ENTRIES,
		leafId: "cm1",
		question: "why?",
		onText: (text) => chunks.push(text),
	});
	stream.push({ type: "text_delta", contentIndex: 0, delta: "answer", partial: assistant() });
	const usage: Usage = { ...ZERO_USAGE, input: 1, cacheRead: 500, output: 2, totalTokens: 503 };
	stream.push({ type: "done", reason: "stop", message: assistant({ content: [{ type: "text", text: "answer" }], usage }) });
	const outcome = await running;

	assert.equal(calls.length, 1);
	const sent = calls[0] as { context: Context; options: Record<string, unknown> };
	assert.equal(sent.options["toolChoice"], undefined, "tool_choice would invalidate the message cache");
	assert.equal(sent.options["sessionId"], SESSION_ID, "session affinity uses the main session id");
	assert.equal(sent.options["reasoning"], "max", "the session thinking level is forwarded");
	assert.equal(sent.options["apiKey"], "key");
	const headers = sent.options["headers"] as Record<string, string>;
	assert.equal(headers["x-opencode-session"], SESSION_ID, "the MAIN session id pins the cache lineage");
	assert.equal(headers["x-opencode-client"], "pi");
	assert.equal(headers["x-test"], "1", "auth headers are preserved");
	assert.deepEqual(sent.context.messages.slice(0, -1), buildBtwContext(ENTRIES, "cm1", "why?").messages.slice(0, -1));
	assert.equal(sent.context.messages.at(-1)?.role, "user");
	assert.ok(JSON.stringify(sent.context.messages.at(-1)).includes("why?"));
	assert.deepEqual(chunks, ["answer"]);
	assert.equal(outcome.status, "ok");
	assert.deepEqual(outcome.status === "ok" ? outcome.usage : undefined, usage);
});

test("auth failure is an error outcome and never opens a stream", async () => {
	const { calls, modelRegistry } = fakeRegistry({ ok: false, error: "no key" });
	const outcome = await runBtwRequest({
		modelRegistry: modelRegistry as never,
		model: { provider: "opencode-go", id: "test-model" } as never,
		sessionId: SESSION_ID,
		entries: ENTRIES,
		leafId: "cm1",
		question: "why?",
		onText: () => undefined,
	});
	assert.deepEqual(outcome, { status: "error", message: "no key" });
	assert.equal(calls.length, 0);
});

test("a synchronous streamSimple failure is an error outcome", async () => {
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		streamSimple: () => {
			throw new Error("boom");
		},
	};
	const outcome = await runBtwRequest({
		modelRegistry: modelRegistry as never,
		model: { provider: "opencode-go", id: "test-model" } as never,
		sessionId: SESSION_ID,
		entries: ENTRIES,
		leafId: "cm1",
		question: "why?",
		onText: () => undefined,
	});
	assert.equal(outcome.status, "error");
	assert.match(outcome.status === "error" ? outcome.message : "", /boom/);
});

test("session routing headers are only added for opencode providers", () => {
	assert.deepEqual(providerSessionHeaders({ provider: "opencode-go", baseUrl: "https://opencode.ai/go" }, SESSION_ID), {
		"x-opencode-session": SESSION_ID,
		"x-opencode-client": "pi",
	});
	assert.deepEqual(providerSessionHeaders({ provider: "custom", baseUrl: "https://opencode.ai/v1" }, SESSION_ID), {
		"x-opencode-session": SESSION_ID,
		"x-opencode-client": "pi",
	});
	assert.deepEqual(providerSessionHeaders({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }, SESSION_ID), {});
});
