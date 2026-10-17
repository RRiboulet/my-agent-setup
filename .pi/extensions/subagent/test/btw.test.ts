// Behaviour tests for /btw.
//
// /btw answers a side question with a one-shot nested model call and must
// never write to the session. These tests pin the transcript serialization
// (roles, tool markers, truncation, size budget), the request shape sent
// through streamSimple(), the outcome mapping for aborted/error/empty
// responses, and the answer overlay's scrolling, copy and close keys.
//
// Risk covered: a transcript that leaks unbounded tool output or runtime
// bookkeeping into the side question, or an overlay that loses text or
// copies nothing, would degrade the feature silently.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
// The overlay renders the answer through pi-tui's Markdown, whose theme
// functions read pi's global theme; initialize the default so renderer tests
// do not depend on a live TUI session.
import { initTheme } from "@earendil-works/pi-coding-agent";
import { BtwAnswerComponent, askBtw, buildBtwRequest, formatTranscript } from "../../btw.ts";

initTheme();

const MODEL = { provider: "openrouter", id: "test/model", api: "openai-completions" };

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const ESC = "\x1b";

function messageEntry(role: string, content: unknown, extra: Record<string, unknown> = {}) {
	return { type: "message", message: { role, content, timestamp: 0, ...extra } };
}

function assistantMessage(stopReason: string, text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test/model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

/** A ModelRegistry whose streamSimple replays `deltas` and then terminates the stream. */
function fakeRegistry(deltas: string[], final: AssistantMessage) {
	const calls: unknown[] = [];
	return {
		calls,
		registry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			streamSimple: (model: unknown, context: unknown, options: unknown) => {
				calls.push({ model, context, options });
				const stream = createAssistantMessageEventStream();
				const message = assistantMessage(final.stopReason, "", final.errorMessage);
				for (const delta of deltas) {
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
				}
				if (final.stopReason === "stop") {
					stream.push({ type: "done", reason: "stop", message: final });
				} else {
					stream.push({ type: "error", reason: final.stopReason, error: final });
				}
				return stream;
			},
		},
	};
}

async function run(deltas: string[], final: AssistantMessage, branch: readonly unknown[] = []) {
	const { registry, calls } = fakeRegistry(deltas, final);
	const outcome = await askBtw(MODEL as never, registry as never, branch as never, "why did the test fail?", new AbortController().signal);
	return { outcome, calls };
}

// ---------------------------------------------------------------------------
// Transcript serialization

test("formatTranscript serializes user, assistant and tool-result messages in order", () => {
	const branch = [
		messageEntry("user", "Fix the failing test in src/math.ts"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
					{ type: "text", text: "I ran the suite." },
					{ type: "toolCall", id: "t2", name: "read", arguments: {} },
				],
				timestamp: 0,
			},
		},
		messageEntry("toolResult", "3 tests, 1 failure", { toolName: "bash" }),
		{ type: "custom", customType: "goal", data: {} },
		messageEntry("system", "runtime bookkeeping"),
	];

	const transcript = formatTranscript(branch as never);

	assert.match(transcript, /^User:\nFix the failing test/);
	assert.match(transcript, /Assistant \[tool: bash\] \[tool: read\]:\nI ran the suite\./);
	assert.match(transcript, /Tool result \(bash\):\n3 tests, 1 failure/);
	assert.doesNotMatch(transcript, /hidden reasoning/);
	assert.doesNotMatch(transcript, /runtime bookkeeping/);
	assert.doesNotMatch(transcript, /customType/);
	assert.ok(!transcript.endsWith("\n\n"));
});

test("formatTranscript accepts string user content and notes images", () => {
	const branch = [
		messageEntry("user", "plain string prompt"),
		messageEntry("user", [{ type: "image", data: "base64", mimeType: "image/png" }]),
	];
	const transcript = formatTranscript(branch as never);
	assert.match(transcript, /User:\nplain string prompt/);
	assert.match(transcript, /User:\n\[image\]/);
	assert.doesNotMatch(transcript, /base64/);
});

test("formatTranscript truncates oversized tool results", () => {
	const branch = [messageEntry("toolResult", "x".repeat(2600), { toolName: "bash" })];
	const transcript = formatTranscript(branch as never);
	assert.match(transcript, /… \[truncated\]/);
	assert.ok(transcript.length < 2600);
});

test("formatTranscript keeps the newest blocks within the budget and marks the omission", () => {
	const branch = [
		messageEntry("user", "a".repeat(10)),
		messageEntry("user", "b".repeat(10)),
		messageEntry("user", "c".repeat(10)),
	];
	// Budget fits two "User:\n" blocks (16 chars each) plus one separator.
	const transcript = formatTranscript(branch as never, 34);
	assert.match(transcript, /^\[earlier messages omitted\]\n\n/);
	assert.match(transcript, /User:\nb{10}/);
	assert.match(transcript, /User:\nc{10}/);
	assert.doesNotMatch(transcript, /a{10}/);
});

test("formatTranscript keeps the tail of a single block that alone exceeds the budget", () => {
	// The newest block alone exceeds the budget: keep only its tail.
	const branch = [messageEntry("user", "a".repeat(200))];
	const transcript = formatTranscript(branch as never, 50);
	assert.match(transcript, /^… \[truncated\]\n/);
	assert.ok(transcript.length <= 50 + "… [truncated]\n".length);
	assert.ok(transcript.includes("a".repeat(50)));
});

test("formatTranscript returns empty for an empty branch", () => {
	assert.equal(formatTranscript([]), "");
});

// ---------------------------------------------------------------------------
// Request shape

test("buildBtwRequest sends the transcript and the question as two user messages", () => {
	const branch = [messageEntry("user", "hello"), messageEntry("assistant", "hi")];
	const now = 1_234_567;
	const request = buildBtwRequest(branch as never, "what changed?", now);

	assert.match(request.systemPrompt, /side question/);
	assert.equal(request.messages.length, 2);
	assert.deepEqual(
		request.messages.map((m) => m.role),
		["user", "user"],
	);
	assert.match((request.messages[0].content as { type: string; text: string }[])[0].text, /^Session transcript so far:/);
	assert.equal((request.messages[1].content as { type: string; text: string }[])[0].text, "what changed?");
	assert.ok(request.messages.every((m) => m.timestamp === now));
});

test("buildBtwRequest sends only the question when the session is empty", () => {
	const request = buildBtwRequest([], "what changed?");
	assert.equal(request.messages.length, 1);
	assert.equal((request.messages[0].content as { type: string; text: string }[])[0].text, "what changed?");
});

// ---------------------------------------------------------------------------
// askBtw outcomes

test("askBtw streams the answer through streamSimple with the session model", async () => {
	const { outcome, calls } = await run(["Answer ", "text"], assistantMessage("stop", "Answer text"), [
		messageEntry("user", "hello"),
	]);

	assert.deepEqual(outcome, { status: "ok", answer: "Answer text" });
	assert.equal(calls.length, 1);
	const call = calls[0] as {
		model: unknown;
		context: { systemPrompt: string; messages: { role: string }[] };
		options: { apiKey?: string; signal: AbortSignal };
	};
	assert.equal(call.model, MODEL);
	assert.match(call.context.systemPrompt, /side question/);
	assert.deepEqual(
		call.context.messages.map((m) => m.role),
		["user", "user"],
	);
	assert.equal(call.options.apiKey, "test-key");
	assert.ok(call.options.signal instanceof AbortSignal);
});

test("askBtw reports an aborted stream as cancelled", async () => {
	const { outcome } = await run(["partial"], assistantMessage("aborted", "partial"));
	assert.deepEqual(outcome, { status: "cancelled" });
});

test("askBtw surfaces the error message of a failed stream", async () => {
	const { outcome } = await run([], assistantMessage("error", "", "429 rate limited"));
	assert.deepEqual(outcome, { status: "error", message: "429 rate limited" });
});

test("askBtw reports an answerless response as an error", async () => {
	const { outcome } = await run([], assistantMessage("stop", ""));
	assert.deepEqual(outcome, { status: "error", message: "the model returned no text" });
});

test("askBtw reports missing credentials without calling the model", async () => {
	let called = false;
	const registry = {
		getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key for provider: openrouter" }),
		streamSimple: () => {
			called = true;
			throw new Error("must not be called");
		},
	};
	const outcome = await askBtw(MODEL as never, registry as never, [], "q", new AbortController().signal);
	assert.deepEqual(outcome, { status: "error", message: "No API key for provider: openrouter" });
	assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// Answer overlay

interface FakeTui {
	terminal: { rows: number };
	requestRender: () => void;
	renders: number;
}

function fakeTui(rows: number): FakeTui & { tui: never } {
	const fake: FakeTui = {
		terminal: { rows },
		renders: 0,
		requestRender: () => {
			fake.renders++;
		},
	};
	return fake as never;
}

const SHORT_ANSWER = "The test failed because `src/math.ts` still used the old divisor.";
const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the long answer.`).join("\n\n");

function renderText(component: BtwAnswerComponent, width = 80): string {
	return component.render(width).join("\n");
}

test("overlay renders question, markdown answer and controls", () => {
	const tui = fakeTui(40);
	const component = new BtwAnswerComponent("why did it fail?", SHORT_ANSWER, tui as never, () => {});
	const text = renderText(component);

	assert.match(text, /btw/);
	assert.match(text, /why did it fail\?/);
	assert.match(text, /old divisor/); // markdown rendered the code span
	assert.match(text, /↑\/↓ scroll · C copy · Esc close/);
	assert.doesNotMatch(text, /lines \d+–\d+ of/); // short answer, no scroll hint
});

test("overlay scrolls within a viewport and clamps at both ends", () => {
	const tui = fakeTui(40);
	const component = new BtwAnswerComponent("q", LONG_ANSWER, tui as never, () => {});
	const first = renderText(component);
	assert.match(first, /Paragraph 0 of the long answer\./);
	assert.match(first, /lines \d+–\d+ of \d+ — more with ↓/);

	for (let i = 0; i < 100; i++) component.handleInput(DOWN);
	const atEnd = renderText(component);
	assert.match(atEnd, /Paragraph 59 of the long answer\./);
	assert.doesNotMatch(atEnd, /Paragraph 0 of the long answer\./);

	for (let i = 0; i < 100; i++) component.handleInput(UP);
	assert.match(renderText(component), /Paragraph 0 of the long answer\./);
});

test("overlay page keys move by the viewport height and page back", () => {
	const tui = fakeTui(40);
	const component = new BtwAnswerComponent("q", LONG_ANSWER, tui as never, () => {});
	const viewport = Math.max(6, Math.min(36, 40 - 12));

	const indicator = (text: string) => text.match(/lines (\d+)–(\d+) of (\d+)/)?.slice(1, 4).map(Number);
	const initial = indicator(renderText(component));
	assert.ok(initial);
	assert.equal(initial[0], 1);
	assert.equal(initial[1], viewport);

	component.handleInput(PAGE_DOWN);
	const paged = indicator(renderText(component));
	assert.ok(paged);
	assert.equal(paged[0], 1 + viewport);

	component.handleInput(PAGE_UP);
	const back = indicator(renderText(component));
	assert.ok(back);
	assert.deepEqual(back, initial);
});

test("overlay end jumps to the last paragraph", () => {
	const tui = fakeTui(40);
	const component = new BtwAnswerComponent("q", LONG_ANSWER, tui as never, () => {});
	component.handleInput(END);
	assert.match(renderText(component), /Paragraph 59 of the long answer\./);
});

test("overlay C copies the raw answer and reports the result in the footer", async () => {
	const tui = fakeTui(40);
	const copies: string[] = [];
	const component = new BtwAnswerComponent("q", SHORT_ANSWER, tui as never, () => {}, async (text) => {
		copies.push(text);
	});

	component.handleInput("c");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(copies, [SHORT_ANSWER]);
	assert.match(renderText(component), /copied ✓/);

	const failing = new BtwAnswerComponent("q", SHORT_ANSWER, tui as never, () => {}, async () => {
		throw new Error("no clipboard");
	});
	failing.handleInput("C");
	await new Promise((resolve) => setImmediate(resolve));
	assert.match(renderText(failing), /copy failed/);
});

test("overlay closes on Escape", () => {
	const tui = fakeTui(40);
	let closed = 0;
	const component = new BtwAnswerComponent("q", SHORT_ANSWER, tui as never, () => {
		closed++;
	});
	component.handleInput(ESC);
	assert.equal(closed, 1);
});
