// Tests for the /btw request core.
//
// Risk covered: this module is the entire cache story. If the context is not
// exactly the session projection plus one user message — or if a `systemPrompt`
// or `tools` override creeps in — the provider prefix stops matching the main
// request and every question silently re-bills the whole conversation. The
// stream mapping is the second risk: an aborted or failed response must never
// be presented as an answer.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
	BTW_INSTRUCTION,
	buildBtwContext,
	formatBtwUsage,
	runBtwStream,
	sanitizeAnswerText,
} from "../../btw/request.ts";

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
		type: "message",
		id: "u1",
		parentId: "s1",
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
] as unknown as SessionEntry[];

test("the request context is the session projection plus one user message", () => {
	const projection = buildSessionContext(ENTRIES, "a1");
	const context = buildBtwContext(ENTRIES, "a1", "why?", 123);

	assert.equal(context.systemPrompt, undefined, "no second system prompt is prepended");
	assert.equal(context.tools, undefined, "no tools override is prepended");
	assert.equal(context.messages.length, projection.messages.length + 1);
	assert.deepEqual(context.messages.slice(0, -1), projection.messages, "the cached prefix is untouched");
	assert.equal(context.messages[0]?.role, "system", "the projection's own system message leads");

	const last = context.messages.at(-1);
	assert.equal(last?.role, "user");
	const text = (last?.content as { type: string; text: string }[])[0]?.text ?? "";
	assert.ok(text.startsWith(BTW_INSTRUCTION), "the side instruction rides in the new message");
	assert.ok(text.endsWith("why?"), "the question follows the instruction");
	assert.equal((last as { timestamp?: number } | undefined)?.timestamp, 123);
});

test("terminal sequences and C0 controls are stripped, newlines and tabs kept", () => {
	assert.equal(sanitizeAnswerText("a\x1b[31mred\x1b[0m b"), "ared b");
	assert.equal(sanitizeAnswerText("x\u0000y\u0007z"), "xyz");
	assert.equal(sanitizeAnswerText("line\nnext\tend"), "line\nnext\tend");
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
	assert.deepEqual(await run, { status: "error", message: "boom" });
});

test("an aborted response maps to cancelled", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	stream.push({ type: "error", reason: "aborted", error: assistant({ stopReason: "aborted" }) });
	assert.deepEqual(await run, { status: "cancelled" });
});

test("an aborted signal cancels even after a normal stop", async () => {
	const controller = new AbortController();
	controller.abort();
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined, signal: controller.signal });
	stream.push({ type: "done", reason: "stop", message: assistant({ content: [{ type: "text", text: "x" }] }) });
	assert.deepEqual(await run, { status: "cancelled" });
});

test("a response with no text is an error, not an empty answer", async () => {
	const stream = createAssistantMessageEventStream();
	const run = runBtwStream(stream, { onText: () => undefined });
	stream.push({ type: "done", reason: "stop", message: assistant() });
	assert.deepEqual(await run, { status: "error", message: "the model returned no text" });
});

test("deltas are sanitized before they reach the viewer", async () => {
	const stream = createAssistantMessageEventStream();
	const chunks: string[] = [];
	const run = runBtwStream(stream, { onText: (text) => chunks.push(text) });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "a\x1b[31m", partial: assistant() });
	stream.push({ type: "done", reason: "stop", message: assistant({ content: [{ type: "text", text: "a" }] }) });
	const outcome = await run;
	assert.equal(outcome.status, "ok");
	assert.deepEqual(chunks, ["a"]);
});

test("the usage footer names the cache read", () => {
	const text = formatBtwUsage({
		input: 1354,
		output: 510,
		cacheRead: 591232,
		cacheWrite: 0,
		totalTokens: 593096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.match(text, /input 1,354/);
	assert.match(text, /cache read 591,232/);
	assert.match(text, /output 510/);
	assert.equal(formatBtwUsage(undefined), "");
});
