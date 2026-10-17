// Behaviour tests for /btw.
//
// /btw answers a side question with a one-shot nested model call and must
// never write to the session. The tests pin four layers, matching the risks
// the extension carries:
//   - the transcript serialization (roles, tool markers, pinned compaction
//     and branch summaries, custom-message notes, truncation, size budget,
//     and surrogate-safe cutting),
//   - the request shape sent through streamSimple() (system prompt, two user
//     messages, toolChoice "none", auth, signal),
//   - the outcome mapping for ok/aborted/error/empty responses, including
//     the terminal-sequence stripping the answer gets on its way to the UI,
//   - and the factory wiring itself, driven with a fake pi API the way
//     continue.test.ts does: the guards, the single-flight rule, the
//     abort-on-session-switch wiring, and the status indicator lifecycle.
//
// The overlay component is exercised through its real render and input
// handling, with an identity fake theme so assertions do not thread ANSI.
// The answer's Markdown still renders through pi's global theme, so the
// global default is initialized up front.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
// Poll instead of a fixed flush: copy handling resolves through promise
// callbacks whose timing belongs to the outcome, not the scheduler (the
// suite's waitFor exists for exactly this).
import { waitFor } from "./helpers.ts";
import { BtwAnswerComponent, askBtw, buildBtwRequest, formatTranscript } from "../../btw.ts";

initTheme();

const MODEL = { provider: "openrouter", id: "test/model", api: "openai-completions" };
const THEME = { fg: (_token: string, text: string) => text };

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const END = "\x1b[F";
const ESC = "\x1b";

function messageEntry(role: string, content: unknown, extra: Record<string, unknown> = {}) {
	return { type: "message", message: { role, content, timestamp: 0, ...extra } };
}

function compactionEntry(summary: string) {
	return { type: "compaction", summary, timestamp: 0 };
}

function branchSummaryEntry(summary: string) {
	return { type: "branch_summary", summary, timestamp: 0 };
}

function customMessageEntry(customType: string, content: unknown) {
	return { type: "custom_message", customType, content, display: true, timestamp: 0 };
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

async function run(deltas: string[], final: AssistantMessage, entries: readonly unknown[] = []) {
	const { registry, calls } = fakeRegistry(deltas, final);
	const outcome = await askBtw(MODEL as never, registry as never, entries as never, "why did the test fail?", new AbortController().signal);
	return { outcome, calls };
}

/** Strips paired surrogates, then asserts no lone surrogate remains. */
function assertNoLoneSurrogate(text: string): void {
	const withoutPairs = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
	assert.doesNotMatch(withoutPairs, /[\uD800-\uDFFF]/);
}

// ---------------------------------------------------------------------------
// Transcript serialization

test("formatTranscript serializes user, assistant and tool-result messages in order", () => {
	const entries = [
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

	const transcript = formatTranscript(entries as never);

	assert.match(transcript, /^User:\nFix the failing test/);
	assert.match(transcript, /Assistant \[tool: bash\] \[tool: read\]:\nI ran the suite\./);
	assert.match(transcript, /Tool result \(bash\):\n3 tests, 1 failure/);
	assert.doesNotMatch(transcript, /hidden reasoning/);
	assert.doesNotMatch(transcript, /runtime bookkeeping/);
	assert.doesNotMatch(transcript, /customType/);
	assert.ok(!transcript.endsWith("\n\n"));
});

test("formatTranscript accepts string user content and notes images", () => {
	const entries = [
		messageEntry("user", "plain string prompt"),
		messageEntry("user", [{ type: "image", data: "base64", mimeType: "image/png" }]),
	];
	const transcript = formatTranscript(entries as never);
	assert.match(transcript, /User:\nplain string prompt/);
	assert.match(transcript, /User:\n\[image\]/);
	assert.doesNotMatch(transcript, /base64/);
});

test("formatTranscript includes compaction and branch summaries as pinned blocks", () => {
	const entries = [
		compactionEntry("First ten steps compressed to a summary."),
		messageEntry("user", "hello after compaction"),
		branchSummaryEntry("Branch work summarized briefly."),
	];
	const transcript = formatTranscript(entries as never);
	assert.match(transcript, /Summary:\nFirst ten steps compressed to a summary\./);
	assert.match(transcript, /Summary:\nBranch work summarized briefly\./);
	// Summaries are pinned and lead the transcript, chronological between
	// themselves; the live conversation follows.
	assert.ok(transcript.indexOf("First ten steps") < transcript.indexOf("Branch work summarized"));
	assert.match(transcript, /User:\nhello after compaction/);
});

test("formatTranscript pins summaries so the newest-first trim cannot drop them", () => {
	// Three 36-char user blocks and a 30-char summary; budget 90 leaves the
	// flow only 60 chars after the pinned 30 — enough for exactly one block.
	const entries = [
		messageEntry("user", "o".repeat(30)),
		compactionEntry("first ten steps summary"),
		messageEntry("user", "n".repeat(30)),
		messageEntry("user", "m".repeat(30)),
	];
	const transcript = formatTranscript(entries as never, 90);

	assert.match(transcript, /^\[earlier messages omitted\]/);
	assert.ok(transcript.includes("first ten steps summary"));
	assert.match(transcript, /User:\nm{30}/);
	assert.ok(!transcript.includes("n".repeat(30)));
	assert.ok(!transcript.includes("o".repeat(30)));
	assert.ok(transcript.indexOf("first ten steps summary") < transcript.indexOf("User:"));
});

test("formatTranscript drops older summaries when pinned summaries overflow their half-budget", () => {
	const entries = [
		compactionEntry("first summary"),
		compactionEntry("second summary"),
		compactionEntry("third summary"),
	];
	const transcript = formatTranscript(entries as never, 60);

	assert.match(transcript, /^\[earlier summaries omitted\]/);
	assert.ok(transcript.includes("third summary"));
	assert.ok(!transcript.includes("first summary"));
	assert.ok(!transcript.includes("second summary"));
});

test("formatTranscript tail-keeps a single summary that alone exceeds the pinned budget", () => {
	const entries = [compactionEntry("s".repeat(40))];
	const transcript = formatTranscript(entries as never, 40);
	assert.match(transcript, /^… \[truncated\]\n/);
	assert.ok(transcript.includes("s".repeat(20)));
});

test("formatTranscript includes custom messages, which pi sends to the model too", () => {
	const entries = [customMessageEntry("answers", "I answered your questions in the following way."), messageEntry("user", "next")];
	const transcript = formatTranscript(entries as never);
	assert.match(transcript, /Note \(answers\):\nI answered your questions in the following way\./);
});

test("formatTranscript skips entries whose message is missing", () => {
	const entries = [{ type: "message", message: undefined }, messageEntry("user", "hi")];
	const transcript = formatTranscript(entries as never);
	assert.equal(transcript, "User:\nhi");
});

test("formatTranscript truncates oversized tool results", () => {
	const entries = [messageEntry("toolResult", "x".repeat(2600), { toolName: "bash" })];
	const transcript = formatTranscript(entries as never);
	assert.match(transcript, /… \[truncated\]/);
	assert.ok(transcript.length < 2600);
});

test("formatTranscript never cuts a surrogate pair in a truncated tool result", () => {
	// "x" + 1001 emoji: index 2000 falls inside the 1001st pair.
	const content = `x${"😀".repeat(1001)}`;
	const entries = [messageEntry("toolResult", content, { toolName: "bash" })];
	const transcript = formatTranscript(entries as never);

	assert.match(transcript, /… \[truncated\]/);
	// The cut steps back before the high surrogate: 999 whole emoji survive.
	assert.equal((transcript.match(/😀/gu) ?? []).length, 999);
	assertNoLoneSurrogate(transcript);
});

test("formatTranscript never cuts a surrogate pair in a tail-kept summary", () => {
	const entries = [compactionEntry(`y${"😀".repeat(1001)}`)];
	const transcript = formatTranscript(entries as never, 80);
	assert.match(transcript, /… \[truncated\]/);
	assertNoLoneSurrogate(transcript);
});

test("formatTranscript keeps the newest blocks within the budget and marks the omission", () => {
	const entries = [
		messageEntry("user", "a".repeat(10)),
		messageEntry("user", "b".repeat(10)),
		messageEntry("user", "c".repeat(10)),
	];
	// Budget fits two "User:\n" blocks (16 chars each) plus one 2-char separator.
	const transcript = formatTranscript(entries as never, 34);
	assert.match(transcript, /^\[earlier messages omitted\]\n\n/);
	assert.match(transcript, /User:\nb{10}/);
	assert.match(transcript, /User:\nc{10}/);
	assert.doesNotMatch(transcript, /a{10}/);
});

test("formatTranscript keeps the tail of a single block that alone exceeds the budget", () => {
	const entries = [messageEntry("user", "a".repeat(200))];
	const transcript = formatTranscript(entries as never, 50);
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
	const entries = [messageEntry("user", "hello"), messageEntry("assistant", "hi")];
	const now = 1_234_567;
	const request = buildBtwRequest(entries as never, "what changed?", now);

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
		options: { apiKey?: string; signal: AbortSignal; toolChoice?: string };
	};
	assert.equal(call.model, MODEL);
	assert.match(call.context.systemPrompt, /side question/);
	assert.deepEqual(
		call.context.messages.map((m) => m.role),
		["user", "user"],
	);
	assert.equal(call.options.apiKey, "test-key");
	assert.ok(call.options.signal instanceof AbortSignal);
	// The tool-free guarantee is pinned, not left to adapter defaults.
	assert.equal(call.options.toolChoice, "none");
});

test("askBtw strips terminal sequences from the returned answer", async () => {
	const hostile = "\x1b[2J\x1b[Hscreen cleared\x1b]0;retitle\x07then plain";
	const { outcome } = await run([hostile], assistantMessage("stop", hostile));

	assert.ok(outcome.status === "ok");
	if (outcome.status === "ok") {
		assert.equal(outcome.answer, "screen clearedthen plain");
		assert.doesNotMatch(outcome.answer, /\x1b/);
	}
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
	renders: number;
	requestRender: () => void;
}

function fakeTui(rows: number): FakeTui {
	const fake: FakeTui = {
		terminal: { rows },
		renders: 0,
		requestRender: () => {
			fake.renders++;
		},
	};
	return fake;
}

const SHORT_ANSWER = "The test failed because `src/math.ts` still used the old divisor.";
const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the long answer.`).join("\n\n");

function renderText(component: BtwAnswerComponent, width = 80): string {
	return component.render(width).join("\n");
}

function overlay(question: string, answer: string, rows: number, onDone: () => void = () => {}, copy?: (text: string) => Promise<void>) {
	return new BtwAnswerComponent(question, answer, fakeTui(rows) as never, THEME as never, onDone, copy);
}

test("overlay renders question, markdown answer and controls", () => {
	const text = renderText(overlay("why did it fail?", SHORT_ANSWER, 40));

	assert.match(text, /btw · why did it fail\?/);
	assert.match(text, /old divisor/); // markdown rendered the code span
	assert.match(text, /↑\/↓ scroll · C copy · Esc close/);
	assert.doesNotMatch(text, /lines \d+–\d+ of/); // short answer, no scroll hint
});

test("overlay collapses a multi-line question into a one-line title", () => {
	const text = renderText(overlay("why\ndid it\nfail?", SHORT_ANSWER, 40));
	assert.match(text, /btw · why did it fail\?/);
});

test("overlay strips terminal sequences from the question title", () => {
	const titleLine = renderText(overlay("why \x1b[2J\x1b[3Jdid it fail?\x1b]0;tab\x07", SHORT_ANSWER, 40))
		.split("\n")
		.find((line) => line.includes("btw ·"));
	assert.ok(titleLine);
	assert.doesNotMatch(titleLine, /\x1b/);
	assert.match(titleLine, /why did it fail\?/);
});

test("overlay scrolls within a viewport and clamps at both ends", () => {
	const component = overlay("q", LONG_ANSWER, 40);
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
	const component = overlay("q", LONG_ANSWER, 40);
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
	const component = overlay("q", LONG_ANSWER, 40);
	component.handleInput(END);
	assert.match(renderText(component), /Paragraph 59 of the long answer\./);
});

test("overlay C copies the raw answer and reports the result in the footer", async () => {
	const copies: string[] = [];
	const component = overlay("q", SHORT_ANSWER, 40, () => {}, async (text) => {
		copies.push(text);
	});

	component.handleInput("c");
	await waitFor(() => copies.length > 0);
	assert.deepEqual(copies, [SHORT_ANSWER]);
	assert.match(renderText(component), /copied ✓/);

	const failing = overlay("q", SHORT_ANSWER, 40, () => {}, async () => {
		throw new Error("no clipboard");
	});
	failing.handleInput("C");
	await waitFor(() => renderText(failing).includes("copy failed"));
	assert.match(renderText(failing), /copy failed/);
});

test("overlay closes on Escape", () => {
	let closed = 0;
	const component = overlay("q", SHORT_ANSWER, 40, () => {
		closed++;
	});
	component.handleInput(ESC);
	assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// Factory wiring (fake pi, the continue.test.ts pattern)

type Factory = (pi: unknown) => void;

async function loadFactory(): Promise<Factory> {
	const specifier = new URL("../../btw.ts", import.meta.url).href;
	const module = (await import(specifier)) as { default?: unknown };
	assert.equal(typeof module.default, "function", "btw.ts must export a default extension factory");
	return module.default as Factory;
}

interface Harness {
	handler: (args: string, ctx: unknown) => Promise<void>;
	ctx: unknown;
	notifications: { message: string; severity: string }[];
	statusCalls: [string, string | undefined][];
	overlay: () => unknown;
	lifecycle: { sessionStart: () => void; sessionShutdown: () => void };
}

async function harness(
	registry: unknown,
	entries: unknown[] = [],
	overrides: Partial<Record<"hasUI" | "mode" | "model", unknown>> = {},
): Promise<Harness> {
	const factory = await loadFactory();
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const lifecycle: Record<string, () => void> = {};
	factory({
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			assert.equal(name, "btw");
			handler = options.handler;
		},
		on(event: string, registration: () => void) {
			lifecycle[event] = registration;
			return () => {};
		},
	});
	assert.ok(handler, "the factory must register the btw command");
	assert.ok(lifecycle.session_start, "the factory must subscribe to session_start");
	assert.ok(lifecycle.session_shutdown, "the factory must subscribe to session_shutdown");

	const notifications: { message: string; severity: string }[] = [];
	const statusCalls: [string, string | undefined][] = [];
	let overlay: unknown;
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: MODEL,
		modelRegistry: registry,
		sessionManager: { buildContextEntries: () => entries },
		ui: {
			theme: THEME,
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
			setStatus(key: string, text: string | undefined) {
				statusCalls.push([key, text]);
			},
			custom(make: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) {
				overlay = make({ terminal: { rows: 40 }, requestRender() {} }, THEME, {}, () => {});
				return Promise.resolve(undefined);
			},
		},
		...overrides,
	};
	return {
		handler: handler as (args: string, ctx: unknown) => Promise<void>,
		ctx,
		notifications,
		statusCalls,
		overlay: () => overlay,
		lifecycle: { sessionStart: lifecycle.session_start, sessionShutdown: lifecycle.session_shutdown },
	};
}

function unresponsiveRegistry(): unknown {
	return {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		streamSimple: () => {
			throw new Error("must not be reached");
		},
	};
}

test("factory guards: usage, no-UI, non-TUI and no-model paths refuse before any model call", async () => {
	const noArgs = await harness(unresponsiveRegistry());
	await noArgs.handler("", noArgs.ctx);
	assert.deepEqual(noArgs.notifications, [{ message: "Usage: /btw <question>", severity: "info" }]);
	assert.equal(noArgs.statusCalls.length, 0);

	const whitespaceArgs = await harness(unresponsiveRegistry());
	await whitespaceArgs.handler("   ", whitespaceArgs.ctx);
	assert.deepEqual(whitespaceArgs.notifications, [{ message: "Usage: /btw <question>", severity: "info" }]);

	const noUi = await harness(unresponsiveRegistry(), [], { hasUI: false });
	await noUi.handler("q", noUi.ctx);
	assert.deepEqual(noUi.notifications, [{ message: "btw requires interactive mode", severity: "error" }]);

	const notTui = await harness(unresponsiveRegistry(), [], { mode: "rpc" });
	await notTui.handler("q", notTui.ctx);
	assert.match(notTui.notifications[0]?.message ?? "", /interactive TUI/);
	assert.equal(notTui.notifications[0]?.severity, "error");

	const noModel = await harness(unresponsiveRegistry(), [], { model: undefined });
	await noModel.handler("q", noModel.ctx);
	assert.deepEqual(noModel.notifications, [{ message: "No model selected", severity: "error" }]);

	// None of the refusals may have touched the status line.
	for (const refusal of [noArgs, whitespaceArgs, noUi, notTui, noModel]) {
		assert.equal(refusal.statusCalls.length, 0);
	}
});

test("factory: a second /btw while one runs is refused, and the guard fully releases after an abort", async () => {
	let release: (final: AssistantMessage) => void = () => {};
	const registry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => ({
			result: () =>
				new Promise((resolve) => {
					release = (final) => resolve(final);
					// Mirror the runtime: an abort resolves the stream as aborted.
					options.signal.addEventListener(
						"abort",
						() => resolve(assistantMessage("aborted", "")),
						{ once: true },
					);
				}),
		}),
	};

	const h = await harness(registry);
	h.statusCalls.length = 0;
	const first = h.handler("first question", h.ctx); // deliberately unawaited

	// The indicator runs for as long as the call does…
	await waitFor(() => h.statusCalls.some(([key, text]) => key === "btw" && text === "/btw thinking…"));
	assert.equal(h.overlay(), undefined);

	// …and a concurrent /btw is refused.
	await h.handler("second question", h.ctx);
	assert.ok(h.notifications.some(({ message }) => message === "A /btw question is already running"));

	// A session switch aborts the in-flight question.
	assert.equal(h.overlay(), undefined);
	h.lifecycle.sessionStart();
	await waitFor(() => h.notifications.some(({ message }) => message === "btw cancelled"));
	await first;

	// The guard is released: a fresh /btw runs to completion.
	h.statusCalls.length = 0;
	h.notifications.length = 0;
	const { registry: okRegistry } = fakeRegistry(["done"], assistantMessage("stop", "done"));
	await h.handler("third question", { ...h.ctx, modelRegistry: okRegistry });
	assert.ok(h.overlay() instanceof Object);
	assert.ok(h.notifications.every(({ message }) => message !== "A /btw question is already running"));
	assert.ok(h.statusCalls[0]?.[0] === "btw");
	assert.equal(h.statusCalls.at(-1)?.[1], undefined);
});

test("factory: the status indicator is set and cleared around the successful overlay", async () => {
	const h = await harness(fakeRegistry(["done"], assistantMessage("stop", "done")).registry);
	await h.handler("why?", h.ctx);

	// Three calls: set, clear (before the overlay takes focus), and the
	// finally-guard's clear after the dialog closes — still cleared throughout.
	assert.equal(h.statusCalls[0]?.[0], "btw");
	assert.equal(h.statusCalls[1]?.[1], undefined);
	assert.equal(h.statusCalls.at(-1)?.[1], undefined);
	assert.ok(h.overlay() instanceof Object);
	assert.deepEqual(h.notifications, []);
});

test("factory: a throwing stream reports btw failed and still releases the guard", async () => {
	const registry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		streamSimple: () => {
			throw new Error("boom");
		},
	};
	const h = await harness(registry);
	await h.handler("q", h.ctx);

	assert.deepEqual(h.notifications, [{ message: "btw failed: boom", severity: "error" }]);
	assert.equal(h.statusCalls.at(-1)?.[1], undefined);
	assert.equal(h.overlay(), undefined);

	// Released: the next /btw reaches the call again.
	const h2 = await harness(registry);
	await h2.handler("q", h2.ctx);
	assert.deepEqual(h2.notifications, [{ message: "btw failed: boom", severity: "error" }]);
});

test("factory: an error outcome reports the provider message as btw failed", async () => {
	const h = await harness(fakeRegistry([], assistantMessage("error", "", "429 rate limited")).registry);
	await h.handler("q", h.ctx);
	assert.deepEqual(h.notifications, [{ message: "btw failed: 429 rate limited", severity: "error" }]);
});
