// Behaviour tests for the subagent lifecycle: launch, concurrency queueing,
// result finalisation, failure detection, cancel, status and clean.
//
// The extension talks to tmux exclusively through `pi.exec`, so a fake
// ExtensionAPI that scripts `exec` is enough to drive the whole state machine
// without spawning real tmux sessions or child pi processes.
//
// Risk covered: the watcher and the concurrency queue are fire-and-forget async
// (`void watchTick(run)`, `void drainQueue()`), which is exactly where a race or
// a lost timer silently strands a run. The shutdown test at the bottom pins the
// other half of that race: a tick in flight must not re-arm its timer after
// `session_shutdown` has cleared the timer map.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { getActivityFilePath, readActivityFile } from "../activity.ts";
import { getInterruptFilePath } from "../interrupt.ts";
import { LIST_DETAIL_BUDGET } from "../listview.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	tools: Map<string, Record<string, unknown>>;
	execCalls: { command: string; args: string[] }[];
	messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[];
	/** Make every tmux call against the run's pane fail as if the session were gone. */
	removeTarget: () => void;
	/** Fail pane calls once with an unclassifiable error, then behave normally. */
	failPaneOnce: () => void;
	/** Fail every pane call with an unclassifiable error (an unreachable socket). */
	failPaneAlways: () => void;
	/** Ticks in which the mock served an unclassifiable failure. */
	paneFailureTicks: () => number;
	resetPaneFailureTicks: () => void;
	/** setWidget calls, in order. An `undefined` content is a clear. */
	widgetCalls: { key: string; hasContent: boolean; placement: string | undefined }[];
	/** Every registerTool call, in order, with the exposure it was given. */
	toolRegistrations: { name: string; exposure: string | undefined }[];
	/** The exposure a tool's CURRENT definition carries. */
	toolExposure: (name: string) => string | undefined;
	/** Whether pi would declare this tool to the model — the thing the saving is about. */
	declared: (name: string) => boolean;
	/** Simulate a host changing the tool set mid-session, as `/tools` does. */
	setActiveTools: (names: string[]) => void;
	/** Fire pi's before_agent_start, which the extension re-checks exposure on. */
	fireBeforeAgentStart: () => Promise<void>;
	/** Render the installed widget with the given width and return its lines. */
	renderWidget: (width?: number) => string[] | undefined;
	/** How many times the widget asked the TUI to re-render. */
	renderRequests: () => number;
	shutdown: () => Promise<void>;
	call: (tool: string, params: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>;
	readRuns: () => Promise<RunRecord[]>;
	writeResult: (run: RunRecord, result: Record<string, unknown>) => Promise<void>;
	writeActivity: (run: RunRecord, activity: Record<string, unknown>) => Promise<void>;
	writeInterrupt: (run: RunRecord, marker?: Record<string, unknown>) => Promise<void>;
}

interface HarnessOptions {
	maxConcurrent?: string;
	paneText?: string;
	paneDead?: boolean;
	/** Grace period subagent_interrupt waits for the child to confirm, in ms. */
	interruptConfirmMs?: string;
	/** Artificial delay (ms) added to every tmux call, so a shutdown can land while a watcher tick is mid-flight. */
	execDelayMs?: number;
	/** Start with the tmux target missing, as if the session had been killed by hand. */
	missingTarget?: boolean;
	stallSeconds?: string;
	/** pi's active tool set at session start, so the exposure decisions can be exercised. */
	activeTools?: string[];
	/** Tools a host names by hand; only these activate for a non-declarable exposure. */
	requestedTools?: string[];
	/** Simulate an unbound extension runtime: `getActiveTools` throws. */
	unbound?: boolean;
	/** `PI_SUBAGENT_TOOL_STALL_SECONDS`, distinct from `stallSeconds`. */
	toolStallSeconds?: string;
	/** Override ctx.mode, so the TUI-only widget guard can be exercised. */
	mode?: string;
	/**
	 * Present a real live branch as the parent session (fork/lineage tests). The
	 * manager is built from the temp agent dir `withHarness` has already set, so
	 * callers do not thread `agentDir` through the options by hand.
	 */
	sessionManager?: "liveBranch";
	/**
	 * Invoked when the Escape key is sent to a child, while the tool's confirmation
	 * poll is still suspended on that exec. Lets a test fold the interrupt marker
	 * through the watcher BEFORE the tool reads it, deterministically reproducing
	 * the watcher-wins race instead of hoping the 100ms poll and 500ms tick land in
	 * that order.
	 */
	afterEscapeSent?: () => Promise<void>;
	/**
	 * Invoked when the pane probe reports the pane dead (`paneDead: true`), before
	 * `finalizeMissingChild` runs. Lets a test write a result into the window
	 * between the watcher's first result read and its post-probe re-read.
	 */
	afterPaneDeadProbe?: () => Promise<void>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const execCalls: { command: string; args: string[] }[] = [];
	const messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];
	// Flipped by removeTarget() to simulate the user killing the tmux session (or
	// the server dying) out from under a run.
	let targetMissing = options.missingTarget === true;
	// Unclassifiable failures, counted down: `once` for a single blip.
	let paneFailures = 0;
	let paneFailureMode = "";
	// True while the in-flight tick is inside a budgeted failure.
	let paneTickFailing = false;
	// Ticks, not pane calls, in which an unclassifiable failure was served. A
	// watcher tick makes exactly one capture-pane and one display-message, and
	// banks at most one failure, so tests synchronise on this instead of
	// sleeping and hoping the poll clock got there first.
	let paneFailureTicks = 0;
	let countedThisTick = false;
	// Widget plumbing (local patch 14).
	const widgetCalls: { key: string; hasContent: boolean; placement: string | undefined }[] = [];
	// Every registration, in order, so a test can see the load-time one and the
	// corrected one separately.
	const toolRegistrations: { name: string; exposure: string | undefined }[] = [];
	// The set pi would declare to the model, and the subset a host named by hand.
	const activeToolNames: string[] = [...(options.activeTools ?? ["read", "bash", "edit", "write"])];
	const requestedToolNames: string[] = options.requestedTools ?? [];
	const widgetComponents = new Map<string, (tui: unknown, theme: unknown) => { render: (width: number) => string[] }>();
	let renderRequests = 0;
	const fakeTheme = { fg: (_color: string, text: string) => text };

	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: (tool: Record<string, unknown>) => {
			const name = tool.name as string;
			tools.set(name, tool);
			const exposure = (tool as { exposure?: string }).exposure ?? "direct";
			toolRegistrations.push({ name, exposure });
			// pi activates a tool on registration only when its exposure is declarable
			// (`direct` | `model-only`) and `defaultActive` is not false. Everything
			// else has to be named explicitly. This is the rule that decides what the
			// model actually SEES, so the harness models it rather than trusting a
			// test's read of `definition.exposure`.
			if (exposure === "direct" || exposure === "model-only") {
				if (!activeToolNames.includes(name)) activeToolNames.push(name);
			} else if (!activeToolNames.includes(name) && requestedToolNames.includes(name)) {
				activeToolNames.push(name);
			}
		},
		registerMessageRenderer: () => undefined,
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		getThinkingLevel: () => "medium",
		// Local patch 15 asks pi what is active before it decides a tool's exposure.
		getActiveTools: () => {
			if (options.unbound) throw new Error("Extension runtime not initialized.");
			return [...activeToolNames];
		},
		sendMessage: (message: Record<string, unknown>, opts?: Record<string, unknown>) => {
			messages.push({ message, options: opts });
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (options.execDelayMs) await new Promise((resolve) => setTimeout(resolve, options.execDelayMs));
			const joined = args.join(" ");
			if (options.afterEscapeSent && joined.includes("send-keys") && args.includes("Escape")) {
				await options.afterEscapeSent();
			}
			if (joined.includes("-V")) return { code: 0, stdout: "tmux 3.3a", stderr: "" };
			const paneCall = joined.includes("capture-pane") || joined.includes("display-message");
			// A tick starts at its capture-pane, so the counter resets there.
			if (joined.includes("capture-pane")) countedThisTick = false;
			if (paneCall && targetMissing) {
				return { code: 1, stdout: "", stderr: "can't find pane: pi-agent-gone" };
			}
			if (paneCall && (paneFailures > 0 || paneTickFailing)) {
				// A budgeted failure covers the WHOLE tick, not just its first pane
				// call: watchTick only counts a failure when BOTH its tmux calls
				// fail, so failing capture-pane alone would recover on display-message
				// and never reach countTmuxFailure at all.
				if (paneFailureMode !== "always" && !paneTickFailing) {
					paneFailures -= 1;
					paneTickFailing = true;
				}
				if (!countedThisTick) {
					paneFailureTicks += 1;
					countedThisTick = true;
				}
				return { code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-subagents.sock (No such file or directory)" };
			}
			if (paneCall) paneTickFailing = false;
			if (joined.includes("capture-pane")) {
				return { code: 0, stdout: options.paneText ?? "child working\n", stderr: "" };
			}
			if (joined.includes("display-message")) {
				if (options.afterPaneDeadProbe && options.paneDead) await options.afterPaneDeadProbe();
				return { code: 0, stdout: options.paneDead ? "1" : "0", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	const ctx = {
		cwd: process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager:
			options.sessionManager === "liveBranch"
				? liveBranchSessionManager(process.env.PI_CODING_AGENT_DIR ?? "/tmp")
				: {
						getSessionId: () => SESSION_ID,
						getSessionFile: () => path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", `${SESSION_ID}.jsonl`),
						getBranch: () => [],
					},
		model: { provider: "openrouter", id: "parent/model" },
		ui: {
			notify: () => undefined,
			custom: async () => undefined,
			setWidget: (key: string, content: unknown, opts?: { placement?: string }) => {
				widgetCalls.push({ key, hasContent: content !== undefined, placement: opts?.placement });
				if (typeof content === "function") widgetComponents.set(key, content as never);
				else widgetComponents.delete(key);
			},
		},
		shutdown: () => undefined,
	};

	await withEnv(
		{
			// The factory branches on these to decide whether it is running as a
			// child reporter or as the parent. They must be cleared from the
			// ambient environment: a reviewer subagent, or any pi subagent child,
			// already has them set, and without this the harness would silently
			// exercise the child branch and register no parent tools at all.
			PI_TMUX_SUBAGENT_CHILD: undefined,
			PI_TMUX_SUBAGENT_RESULT: undefined,
			PI_TMUX_SUBAGENT_INTERRUPT: undefined,
			PI_SUBAGENT_MAX_CONCURRENT: options.maxConcurrent ?? "4",
			PI_SUBAGENT_INTERRUPT_CONFIRM_MS: options.interruptConfirmMs,
			PI_SUBAGENT_NOTIFY: "true",
			PI_SUBAGENT_AUTO_REAP: "true",
			PI_SUBAGENT_REAP_DELAY_MS: "0",
			PI_SUBAGENT_GC_DAYS: "7",
			PI_SUBAGENT_STALL_SECONDS: options.stallSeconds,
			PI_SUBAGENT_TOOL_STALL_SECONDS: options.toolStallSeconds,
		},
		async () => {
			subagentExtension(pi as never);
			await handlers.get("session_start")?.({}, ctx);
		},
	);

	const runsIndex = path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", "tmux-subagents", SESSION_ID, "runs.json");

	return {
		pi,
		ctx,
		tools,
		execCalls,
		messages,
		removeTarget: () => {
			targetMissing = true;
		},
		failPaneOnce: () => {
			// One whole tick, not one pane call: see the exec mock.
			paneFailureMode = "once";
			paneFailures = 1;
			paneTickFailing = false;
		},
		paneFailureTicks: () => paneFailureTicks,
		resetPaneFailureTicks: () => {
			paneFailureTicks = 0;
		},
		failPaneAlways: () => {
			paneFailureMode = "always";
			paneFailures = Number.MAX_SAFE_INTEGER;
		},
		widgetCalls,
		toolRegistrations,
		toolExposure: (name: string) => {
			const definition = tools.get(name) as { exposure?: string } | undefined;
			return definition?.exposure;
		},
		declared: (name: string) => activeToolNames.includes(name) && tools.get(name)?.exposure !== "hidden",
		setActiveTools: (names: string[]) => {
			activeToolNames.length = 0;
			activeToolNames.push(...names);
		},
		fireBeforeAgentStart: async () => {
			await handlers.get("before_agent_start")?.({}, ctx);
		},
		renderWidget: (width = 200) => {
			const component = [...widgetComponents.values()].at(-1);
			if (!component) return undefined;
			// Calling the factory is how the extension gets its TUI, the object it
			// pokes to re-render; observing that request needs the same call.
			return component({ requestRender: () => (renderRequests += 1) }, fakeTheme).render(width);
		},
		renderRequests: () => renderRequests,
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		call: async (tool, params) => {
			const definition = tools.get(tool);
			assert.ok(definition, `tool ${tool} must be registered`);
			const execute = definition.execute as (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
			const result = await execute(`call-${tool}`, params, undefined, undefined, ctx);
			return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
		},
		readRuns: async () => JSON.parse(await readFile(runsIndex, "utf8")) as RunRecord[],
		writeResult: async (run, result) => {
			await writeFile(run.resultPath, `${JSON.stringify(result)}\n`, "utf8");
		},
		writeActivity: async (run, activity) => {
			await writeFile(getActivityFilePath(run.runDir), `${JSON.stringify(activity)}\n`, "utf8");
		},
		writeInterrupt: async (run, overrides = {}) => {
			await writeFile(
				getInterruptFilePath(run.runDir),
				`${JSON.stringify({
					version: 1,
					runId: run.id,
					interruptedAt: Date.now(),
					interrupts: 1,
					turnIndex: 0,
					stopReason: "aborted",
					...overrides,
				})}\n`,
				"utf8",
			);
		},
	};
}

/**
 * Wait for a run to reach `status`, reporting WHY it did not if it never does.
 *
 * A plain timeout on a watcher-driven assertion cannot distinguish "the watcher
 * stopped" from "the machine was slow", and those are completely different bugs.
 */
async function waitForRunStatus(h: Harness, status: string, note = ""): Promise<RunRecord> {
	const deadline = Date.now() + 30_000;
	let last: RunRecord | undefined;
	while (Date.now() < deadline) {
		last = (await h.readRuns())[0];
		if (last?.status === status) return last;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const panes = h.execCalls.filter((call) => call.args.includes("capture-pane")).length;
	const displays = h.execCalls.filter((call) => call.args.includes("display-message")).length;
	assert.fail(
		`run never reached "${status}"${note ? ` (${note})` : ""}; last record=${JSON.stringify(last)}; ` +
			`since the target was broken: ${panes} capture-pane, ${displays} display-message, ${h.execCalls.length} exec calls total`,
	);
}

/**
 * Write a child session file under the run dir, as a standalone child would.
 *
 * The parent does not learn this path until the child reports a result, so a run
 * stopped before that — cancel, tmux failure — has to discover it to report the
 * usage it burned.
 */
async function writeChildSession(
	run: RunRecord,
	usage: { input: number; output: number; cost?: number }[],
): Promise<string> {
	const file = path.join(run.runDir, "session", `2026-01-01T00-00-00-000Z_${run.id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: run.id, timestamp: "2026-01-01T00:00:00.000Z", cwd: run.cwd }),
		...usage.map((u) =>
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input: u.input, output: u.output, totalTokens: u.input + u.output, cost: { total: u.cost ?? 0 } },
				},
			}),
		),
	];
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

async function withHarness<T>(
	options: HarnessOptions | undefined,
	fn: (harness: Harness, agentDir: string) => Promise<T>,
): Promise<T> {
	return withTempAgentDir(async (agentDir) => {
		// withTempAgentDir already points PI_CODING_AGENT_DIR at a fresh temp
		// directory and restores the previous value afterwards.
		const harness = await createHarness(options);
		try {
			return await fn(harness, agentDir);
		} finally {
			await harness.shutdown();
		}
	});
}

test("the harness exercises the parent branch even inside a pi subagent child", async () => {
	// This guards the harness, not the extension: createHarness clears
	// PI_TMUX_SUBAGENT_CHILD, which the extension factory branches on. Without
	// that, every test would silently register the child reporter instead of the
	// parent tools. Re-run the suite with PI_TMUX_SUBAGENT_CHILD=1 in the ambient
	// environment to check this holds.
	await withEnv(
		{ PI_TMUX_SUBAGENT_CHILD: "1", PI_TMUX_SUBAGENT_RESULT: "/tmp/should-not-be-used.jsonl" },
		async () => {
			await withTempAgentDir(async () => {
				const harness = await createHarness();
				try {
					assert.ok(harness.tools.has("subagent"), "parent tools are registered");
					assert.ok(harness.tools.has("subagent_status"), "parent tools are registered");
				} finally {
					await harness.shutdown();
				}
			});
		},
	);
});

test("subagent launches a child in a detached tmux session and returns immediately", async () => {
	await withHarness(undefined, async (h) => {
		const { text, details } = await h.call("subagent", { task: "Do the thing" });
		const run = details as unknown as RunRecord;

		assert.match(text, new RegExp(`Subagent ${run.id} started\\.`));
		assert.ok(text.includes("Model: openrouter/parent/model (medium)"));
		assert.ok(text.includes(`pi --attach-subagent '${run.id}'`));

		const launched = h.execCalls.some((call) => call.command === "tmux" && call.args.includes("new-session"));
		assert.ok(launched, "a tmux session is created");
		const keys = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.ok(keys.length >= 2, "the child command is typed and submitted");
		assert.ok(
			keys.some((call) => call.args.some((arg) => arg.includes("--provider"))),
			"the child invocation carries the provider",
		);

		const runs = await h.readRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].status, "running");
		assert.equal(runs[0].task, "Do the thing");
	});
});

test("subagent rejects an empty task and a missing cwd", async () => {
	await withHarness(undefined, async (h) => {
		await assert.rejects(() => h.call("subagent", { task: "   " }), /must not be empty/);
		await assert.rejects(() => h.call("subagent", { task: "x", cwd: "/definitely/not/here" }), /does not exist/);
	});
});

test("runs beyond the concurrency cap are queued and start when a slot frees", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "first" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "second" })).details as unknown as RunRecord;

		const runs = await h.readRuns();
		assert.equal(runs.find((run) => run.id === first.id)?.status, "running");
		assert.equal(runs.find((run) => run.id === second.id)?.status, "queued");

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

test("a child result finalizes the run and notifies the main session", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "long task" })).details as unknown as RunRecord;
		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "the answer is 42",
			sessionFile: "/tmp/child.jsonl",
			provider: "openrouter",
			model: "child/model",
			thinking: "low",
			finishedAt: Date.now(),
		});

		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finalized = (await h.readRuns())[0];
		assert.equal(finalized.output, "the answer is 42");
		assert.equal(finalized.model, "child/model");
		assert.ok(finalized.finishedAt);

		const notification = h.messages.at(-1);
		assert.equal(notification?.message.customType, "subagent-result");
		// No options at all: neither `triggerTurn` nor `deliverAs`, so pi appends the
		// message rather than starting or queueing a turn. See the dedicated test
		// below and the comment in notifyCompletion for why.
		assert.equal(notification?.options, undefined);
		// The notification points at the run rather than inlining its output, and says
		// how to collect it: subagent_status({ id }) is now the only route.
		assert.ok(!String(notification?.message.content).includes("the answer is 42"));
		assert.ok(String(notification?.message.content).includes(`subagent_status({ id: "${finalized.id}" })`));
	});
});

test("a failed child result keeps the error visible", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "will fail" })).details as unknown as RunRecord;
		await h.writeResult(run, {
			version: 1,
			status: "failed",
			output: "",
			error: "provider exploded",
			finishedAt: Date.now(),
		});

		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		assert.match((await h.readRuns())[0].error ?? "", /provider exploded/);
		assert.ok(String(h.messages.at(-1)?.message.content).includes("provider exploded"));
	});
});

test("a dead pane without a result fails the run with capture guidance", async () => {
	await withHarness({ paneDead: true }, async (h) => {
		const run = (await h.call("subagent", { task: "dies early" })).details as unknown as RunRecord;
		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		const failed = (await h.readRuns())[0];
		assert.match(failed.error ?? "", /exited before reporting a result/);
		assert.match(failed.error ?? "", /capture-pane/);
		assert.equal(failed.id, run.id);
	});
});

test("an unreadable result file does not finalize the run", async () => {
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "corrupt result" });
		const run = (await h.readRuns())[0];
		await writeFile(run.resultPath, "{not json", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.equal((await h.readRuns())[0].status, "running", "a parse failure must not be read as completion");
	});
});

test("subagent_cancel kills the tmux session and is idempotent once terminal", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel me" })).details as unknown as RunRecord;
		const killed = await h.call("subagent_cancel", { id: run.id });
		assert.match(killed.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"the tmux session is killed",
		);

		const again = await h.call("subagent_cancel", { id: run.id });
		assert.match(again.text, /already cancelled/);
		await assert.rejects(() => h.call("subagent_cancel", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("subagent_status lists runs and inspects one", async () => {
	await withHarness(undefined, async (h) => {
		const empty = await h.call("subagent_status", {});
		assert.match(empty.text, /No subagent runs/);

		const run = (await h.call("subagent", { task: "inspect me" })).details as unknown as RunRecord;
		const listed = await h.call("subagent_status", {});
		assert.ok(listed.text.includes(run.id));
		assert.ok(listed.text.includes("inspect me"));

		const inspected = await h.call("subagent_status", { id: run.id });
		assert.ok(inspected.text.includes(`model: openrouter/parent/model (medium)`));
		await assert.rejects(() => h.call("subagent_status", { id: "nope" }), /Unknown subagent run/);
	});
});

test("the list view caps its pane output across the whole list", async () => {
	// Local patch 16. Polling this tool is the only way to collect a result, so the
	// list is a per-turn cost. It used to carry PANE_PREVIEW_LINES for EVERY live
	// run; now the pane budget is on the LIST, and the runs outside it get one line.
	await withHarness({ paneText: "CHILD-PANE" }, async (h) => {
		const ids: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			const run = (await h.call("subagent", { task: `bounded ${index}` })).details as unknown as RunRecord;
			ids.push(run.id);
		}
		// Wait for the CONTENT of every pane: the watcher can record an empty capture
		// on an early tick, and a `pane !== undefined` check would let this race
		// ahead of the assertions below (a flake seen before it was tightened).
		await waitFor(async () => (await h.readRuns()).filter((run) => run.pane?.includes("CHILD-PANE")).length === 4);

		const listed = await h.call("subagent_status", {});
		for (const id of ids) assert.ok(listed.text.includes(id), `every run is listed: ${id}`);
		assert.equal(
			listed.text.split("CHILD-PANE").length - 1,
			2,
			`pane output is capped for the list as a whole, not per run (budget ${LIST_DETAIL_BUDGET}): ${listed.text}`,
		);
		assert.equal(listed.text.split("task: bounded").length - 1, 2);

		const compact = await h.call("subagent_status", { compact: true });
		assert.ok(!compact.text.includes("CHILD-PANE"), `compact carries no pane: ${compact.text}`);
		assert.ok(!compact.text.includes("task: bounded"), `compact carries no detail block: ${compact.text}`);
		assert.equal(
			compact.text.split("\n").filter((line) => line.trim().length > 0).length,
			4,
			`compact is one line per run, so every run appears exactly once: ${compact.text}`,
		);
		// A run that did not earn a block is still legible: id, status, then usage.
		assert.match(compact.text, new RegExp(`${ids[0]}  running`));
	});
});

test("include_output says which finished outputs the budget left out", async () => {
	// The list's budget caps the detail blocks, and the output lives inside one. A
	// bound that withholds an answer silently is worse than an expensive list: a
	// model that cannot tell "left out" from "there is none" will not go and ask.
	await withHarness(undefined, async (h) => {
		const ids: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const run = (await h.call("subagent", { task: `answer ${index}` })).details as unknown as RunRecord;
			ids.push(run.id);
			await h.writeResult(run, { version: 1, status: "completed", output: `ANSWER-${index}`, finishedAt: Date.now() });
		}
		await waitFor(async () => (await h.readRuns()).every((run) => run.status === "completed"));

		const listed = await h.call("subagent_status", { include_output: true });
		assert.equal(listed.text.split("ANSWER-").length - 1, 1, `one answer fits the budget: ${listed.text}`);
		assert.match(listed.text, /2 finished run\(s\) have output that this list's detail budget left out/);
		assert.match(listed.text, /subagent_status\(\{ id \}\)/, "and it says how to get the rest");

		// Each one is still reachable by id, which is the point of the note.
		for (const [index, id] of ids.entries()) {
			const inspected = await h.call("subagent_status", { id });
			assert.ok(inspected.text.includes(`ANSWER-${index}`), `${id} still has its answer`);
		}
	});
});

test("subagent_clean reaps finished runs but leaves active ones alone", async () => {
	await withHarness(undefined, async (h) => {
		const done = (await h.call("subagent", { task: "finishes" })).details as unknown as RunRecord;
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === done.id)?.status === "completed");

		const cleaned = await h.call("subagent_clean", {});
		assert.match(cleaned.text, /Cleaned 1 tmux session\(s\), deleted 0 run dir\(s\), skipped 1/);

		const stillThere = (await h.readRuns()).find((run) => run.id === active.id);
		assert.equal(stillThere?.status, "running");
	});
});

test("session_shutdown stops the watcher from polling tmux again", async () => {
	// Regression test for the post-shutdown timer leak (local patch 10).
	// A run that is still `running` has a live 500ms watcher. Shutting down while
	// a tick is in flight used to leave an orphan timer behind that nothing would
	// ever clear: the parent kept calling `pi.exec` (capture-pane) forever and kept
	// the event loop alive, so the suite needed `--test-force-exit`. The delay makes
	// the race deterministic: shutdown happens while the tick awaits `pi.exec`.
	// Assert on observable behaviour, not on timer internals.
	await withTempAgentDir(async () => {
		const harness = await createHarness({ execDelayMs: 400 });
		try {
			await harness.call("subagent", { task: "watched at shutdown" });
			// A capture-pane call is recorded before the fake applies the delay, so
			// this returns while that tick is still awaiting.
			await waitFor(async () => harness.execCalls.some((call) => call.args.includes("capture-pane")));

			await harness.shutdown();
			// The in-flight tick legitimately finishes its remaining calls after the
			// shutdown flag is set; what must not happen is a *new* poll.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const callsAfterTick = harness.execCalls.length;
			await new Promise((resolve) => setTimeout(resolve, 2_000));

			const after = harness.execCalls.slice(callsAfterTick);
			assert.equal(after.length, 0, `no tmux calls after shutdown, got: ${JSON.stringify(after)}`);
			assert.ok(!after.some((call) => call.args.includes("capture-pane")), "the watcher must not poll the pane again");
		} finally {
			await harness.shutdown();
		}
	});
});

test("the shutdown flag is per extension load, not global", async () => {
	// The fix lives in the factory closure. If it leaked across loads, a session
	// that shut down would leave every later extension instance permanently
	// unable to watch a run. createHarness calls the factory again, so a fresh
	// instance must poll normally after the previous one was shut down.
	await withTempAgentDir(async () => {
		const first = await createHarness();
		try {
			await first.call("subagent", { task: "old instance" });
			await waitFor(async () => first.execCalls.some((call) => call.args.includes("capture-pane")));
			await first.shutdown();
		} finally {
			await first.shutdown();
		}

		const second = await createHarness();
		try {
			await second.call("subagent", { task: "new instance" });
			await waitFor(async () => second.execCalls.some((call) => call.args.includes("capture-pane")));
		} finally {
			await second.shutdown();
		}
	});
});

test("session_shutdown persists state without killing running children by default", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "survives reload" })).details as unknown as RunRecord;
		h.execCalls.length = 0;
		await h.shutdown();
		assert.ok(!h.execCalls.some((call) => call.args.includes("kill-session")), "PI_SUBAGENT_KILL_ON_SHUTDOWN is off by default");
		assert.equal((await h.readRuns()).find((entry) => entry.id === run.id)?.status, "running");
	});
});
// ---------------------------------------------------------------------------
// Liveness (local patch 11): the parent reads the child's activity snapshot.
// ---------------------------------------------------------------------------

function activitySnapshot(run: RunRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		runningChildId: run.id,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		activeSince: Date.now(),
		sequence: 3,
		latestEvent: "tool_execution_start",
		phase: "active",
		agentActive: true,
		providerActive: false,
		toolActive: true,
		activeScope: "tool",
		toolName: "bash",
		...overrides,
	};
}

test("subagent_status surfaces the child's live activity phase", async () => {
	// Constant pane text on purpose: with a changing pane the watcher persists
	// runs.json on every tick, which would let this pass even if the activity
	// branch never persisted anything.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "watch me" })).details as unknown as RunRecord;
		await waitFor(async () => (await h.readRuns())[0].pane !== undefined);
		const before = await h.call("subagent_status", { id: run.id });
		assert.ok(!before.text.includes("activity:"), "no activity line until a snapshot exists");
		assert.equal((await h.readRuns())[0].activity, undefined, "nothing persisted yet");

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");
		const after = await h.call("subagent_status", { id: run.id });
		assert.ok(after.text.includes("activity: active tool (bash)"), after.text);

		const persisted = (await h.readRuns())[0].activity;
		assert.deepEqual(persisted, {
			phase: "active",
			scope: "tool",
			toolName: "bash",
			sequence: 3,
			updatedAt: persisted?.updatedAt,
		});
	});
});

test("an older activity snapshot never overwrites a newer one", async () => {
	// Regression coverage for the monotonicity guard. Without it, a stale file
	// (or one left over from before a reload) could roll the parent backwards.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "monotonic" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { sequence: 10, toolName: "bash" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 10);

		await h.writeActivity(run, activitySnapshot(run, { sequence: 4, toolName: "grep" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const stored = (await h.readRuns())[0].activity;
		assert.equal(stored?.sequence, 10, "the older sequence is ignored");
		assert.equal(stored?.toolName, "bash", "and it does not clobber the newer detail");

		// Equal sequence is ignored too: the contract is strictly "newer only",
		// so a replayed or hand-edited file at the same sequence cannot rewrite
		// what the parent already recorded.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 10, toolName: "grep" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity?.toolName, "bash", "a replayed snapshot is ignored");

		await h.writeActivity(run, activitySnapshot(run, { sequence: 11, toolName: "grep" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 11);
		assert.equal((await h.readRuns())[0].activity?.toolName, "grep", "a genuinely newer snapshot still lands");
	});
});

test("runs.json is only rewritten when the rendered activity changes", async () => {
	// Regression coverage for the signature dedupe: a chatty child must not
	// rewrite the index twice a second.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "dedupe" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { sequence: 5, toolName: "bash" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 5);

		// Same rendered value, newer sequence: recorded in memory, not persisted.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 6, toolName: "bash" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity?.sequence, 5, "no rewrite for an unchanged rendering");

		// A visible change must still reach disk.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 7, toolName: "grep" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.toolName === "grep");
		assert.equal((await h.readRuns())[0].activity?.sequence, 7);
	});
});

test("a snapshot for a different child is ignored rather than trusted", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "stale snapshot" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { runningChildId: "a-previous-child" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity, undefined, "a wrong-id snapshot is not recorded");
		const status = await h.call("subagent_status", { id: run.id });
		assert.ok(!status.text.includes("activity:"));
	});
});

test("a malformed snapshot never breaks the watcher", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "broken snapshot" })).details as unknown as RunRecord;
		await writeFile(getActivityFilePath(run.runDir), "{ not json", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].status, "running", "the run is unaffected");
		assert.equal((await h.readRuns())[0].activity, undefined);
	});
});

test("the child branch writes an activity snapshot and a terminal done phase", async (t) => {
	// Exercises the real child branch: PI_TMUX_SUBAGENT_CHILD makes the factory
	// register only the reporter, with the run id derived from the result path.
	await withTempAgentDir(async () => {
		const runId = "child-run-1";
		const runDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "tmux-subagents", SESSION_ID, runId);
		await mkdir(runDir, { recursive: true });
		const resultPath = path.join(runDir, "result.json");

		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const shutdownCalls: number[] = [];
		const pi = {
			registerFlag: () => undefined,
			getFlag: () => undefined,
			registerTool: () => {
				throw new Error("the child must not register parent tools");
			},
				registerMessageRenderer: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			getThinkingLevel: () => "medium",
			sendMessage: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		};
		const ctx = {
			sessionManager: { getSessionFile: () => path.join(runDir, "child.jsonl"), getBranch: () => [] },
			sessionManagerId: SESSION_ID,
			model: { provider: "openrouter", id: "child/model" },
			shutdown: () => shutdownCalls.push(1),
		};

		await withEnv(
			{ PI_TMUX_SUBAGENT_CHILD: "1", PI_TMUX_SUBAGENT_RESULT: resultPath },
			async () => {
				subagentExtension(pi as never);
			},
		);

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("tool_execution_start")?.({ toolName: "bash" }, ctx);
		const midFlight = await readActivityFile(getActivityFilePath(runDir), runId);
		assert.equal(midFlight.ok, true);
		assert.equal(midFlight.ok === true && midFlight.activity.phase, "active");
		assert.equal(midFlight.ok === true && midFlight.activity.toolName, "bash");

		// Prove the ordering rather than assume it: watch the run directory and
		// capture the activity phase at the instant result.json appears. If the
		// result were written before the terminal snapshot, this would read
		// "active" and fail.
		//
		// The watch is bounded on purpose. fs.watch may report filename === null,
		// and inotify may coalesce the two renames, so a missed event must fail
		// loudly rather than hang: node --test has no default per-test timeout.
		let watcher: ReturnType<typeof watch> | undefined;
		t.after(() => watcher?.close());
		const phaseWhenResultAppeared = new Promise<string>((resolve) => {
			watcher = watch(runDir, (_event, filename) => {
				if (filename !== "result.json") return;
				void (async () => {
					const snapshot = await readActivityFile(getActivityFilePath(runDir), runId);
					watcher?.close();
					resolve(snapshot.ok ? snapshot.activity.phase : "unreadable");
				})();
			});
		});
		const withDeadline = Promise.race([
			phaseWhenResultAppeared,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no result.json rename was observed")), 5_000)),
		]);

		await handlers.get("agent_settled")?.({}, {
			...ctx,
			sessionManager: {
				getSessionFile: () => path.join(runDir, "child.jsonl"),
				getBranch: () => [
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" } },
				],
			},
		});

		assert.equal(await withDeadline, "done", "the done phase is durable before result.json appears");
		const done = await readActivityFile(getActivityFilePath(runDir), runId);
		assert.equal(done.ok === true && done.activity.phase, "done");
		const result = JSON.parse(await readFile(resultPath, "utf8")) as { status: string; output: string };
		assert.equal(result.status, "completed");
		assert.equal(result.output, "child answer");
		assert.equal(shutdownCalls.length, 1, "the child exits after reporting");
	});
});

test("a settled run reports its status, not a stale activity phase", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "finish cleanly" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");

		await h.writeResult(run, { version: 1, status: "completed", output: "done", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");

		const status = await h.call("subagent_status", { id: run.id });
		assert.ok(!status.text.includes("activity:"), "activity is a live signal, not a final result");
		assert.ok(status.text.includes("completed"));
	});
});

// --- Context handoff (subagent `handoff` parameter and subagent_resume) ---
//
// Risk covered: a resumed run keeps its transcript in its ANCESTOR's run dir,
// so the run dir and the transcript have different lifetimes. That mismatch is
// where silent data loss lives, and none of it is reachable from the
// standalone tests above.

/** A parent session manager presenting a live branch whose last-written entry is a different branch. */
function liveBranchSessionManager(agentDir: string) {
	const parentFile = path.join(agentDir, "parent.jsonl");
	const entries = [
		{ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "live question" }] } },
		{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "live answer" }] } },
		{ type: "message", id: "e3", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED SIBLING" }] } },
	];
	// The live leaf is e2; the file's last line is e3. getLeafId() must be
	// consulted, never "the last entry".
	return {
		getSessionId: () => SESSION_ID,
		getSessionFile: () => parentFile,
		getLeafId: () => "e2",
		getBranch: (leafId?: string) => entries.filter((entry) => entry.id === "e1" || entry.id === (leafId ?? "e2")),
	};
}

test("handoff=fork seeds the child with the parent's LIVE branch", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const run = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		assert.equal(run.mode, "fork");

		const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
		assert.equal(JSON.parse(lines[0]).type, "session");
		assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
		const body = lines.slice(1).map((line) => JSON.parse(line));
		assert.deepEqual(
			body.map((entry) => entry.id),
			["e1", "e2"],
			"only the live branch is inherited",
		);
		assert.ok(!lines.join("\n").includes("ABANDONED SIBLING"), "the abandoned sibling must not leak");
		// The live leaf must be the last line, because pi derives the active
		// branch from file order.
		assert.equal(body.at(-1)?.id, "e2");
		assert.equal(run.usageFromLine, 3, "header + two inherited entries");

		// fork mode addresses the child with --session, never --session-id:
		// pi hard-exits on the combination.
		const childCommand = harness.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.find((arg) => arg.includes("--provider"));
		assert.ok(childCommand?.includes("'--session'"), childCommand);
		assert.ok(!childCommand?.includes("--session-id"), childCommand);
	});
});

test("handoff=lineage links the child to the parent without sharing context", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const run = (await harness.call("subagent", { task: "lineage work", handoff: "lineage" })).details as unknown as RunRecord;
		assert.equal(run.mode, "lineage");
		const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
		assert.equal(lines.length, 1, "header only: no inherited conversation");
		assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
		assert.equal(run.usageFromLine, 1);
	});
});

/** Complete a run the way the child would, so it is eligible for resume. */
async function completeRun(h: Harness, run: RunRecord): Promise<void> {
	await h.writeResult(run, {
		version: 1,
		status: "completed",
		output: "ok",
		finishedAt: Date.now(),
		sessionFile: run.sessionFile,
	});
	await waitFor(async () => (await h.readRuns()).find((candidate) => candidate.id === run.id)?.status === "completed");
}

test("subagent_resume continues the same transcript and counts only its own turns", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const beforeResume = (await readFile(first.sessionFile as string, "utf8")).trim().split("\n").length;

		const resumed = (await harness.call("subagent_resume", {
			id: first.id,
			message: "carry on",
		})).details as unknown as RunRecord;

		assert.equal(resumed.sessionFile, first.sessionFile, "the same transcript is continued");
		assert.notEqual(resumed.id, first.id);
		assert.equal(resumed.mode, "resume");
		assert.equal(resumed.attempt, 2);
		assert.equal(resumed.usageFromLine, beforeResume, "the baseline is the transcript as it stood");
		assert.notEqual(resumed.runDir, first.runDir, "the attempt gets its own run dir");

		const childCommand = harness.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.filter((arg) => arg.includes("'--session'"))
			.at(-1);
		assert.ok(childCommand?.includes("'--session'"));
		assert.ok(!childCommand?.includes("--session-id"), childCommand);
	});
});

test("subagent_resume refuses a second concurrent resume of the same transcript", async () => {
	// Regression test: a finished run stays terminal forever, so the "is it
	// still running" guard passed for both resumes and two pi processes
	// appended to one JSONL, forking branches and scrambling baselines.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const a = (await harness.call("subagent_resume", { id: first.id, message: "one" })).details as unknown as RunRecord;
		await assert.rejects(
			() => harness.call("subagent_resume", { id: first.id, message: "two" }),
			/already using this session file/,
		);
		const runs = await harness.readRuns();
		assert.equal(runs.filter((run) => run.sessionFile === first.sessionFile && run.status !== "cancelled").length >= 1, true);
		assert.equal(a.attempt, 2);
	});
});

test("two resumes fired in parallel cannot both launch on one transcript", async () => {
	// The guard scans `runs`, but a resume does I/O (`mkdir`, `countSessionLines`)
	// before its run lands there, so two calls fired without awaiting each other
	// both passed it and two pi processes appended to one JSONL. The synchronous
	// claim on the session file is what stops the second.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);

		const results = await Promise.allSettled([
			harness.call("subagent_resume", { id: first.id, message: "one" }),
			harness.call("subagent_resume", { id: first.id, message: "two" }),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		assert.equal(fulfilled.length, 1, "exactly one resume may launch");
		assert.equal(rejected.length, 1, "the second must be refused, not launched");
		assert.match(String(rejected[0].reason), /already starting|already using this session file/);

		const appending = (await harness.readRuns()).filter(
			(run) => run.sessionFile === first.sessionFile && ["queued", "running", "interrupted"].includes(run.status),
		);
		assert.equal(appending.length, 1, "one live appender on the transcript");
	});
});

test("the single-run status path always returns the output, finished or not", async () => {
	// With no blocking wait this is the only way to collect a result, so the
	// obvious call — subagent_status({ id }) — has to be the right one, with
	// include_output reserved for the list view where many answers would otherwise
	// arrive at once. `compact` is a list-view control for the same reason.
	await withHarness({ paneText: "LIVE-PANE-CONTENT" }, async (h) => {
		const live = (await h.call("subagent", { task: "collect me" })).details as unknown as RunRecord;
		// Wait for the CONTENT, not merely for a pane field: the watcher can record
		// an empty capture on an early tick, and `pane !== undefined` would then let
		// the test race ahead of the assertions below (a flake seen on main).
		await waitFor(async () => (await h.readRuns())[0].pane?.includes("LIVE-PANE-CONTENT") === true);
		for (const flag of [undefined, false, true]) {
			const inspected = await h.call("subagent_status", { id: live.id, ...(flag === undefined ? {} : { include_output: flag }) });
			assert.ok(inspected.text.includes("LIVE-PANE-CONTENT"), `a live run's pane is the only view of it (include_output: ${flag}): ${inspected.text}`);
		}

		await h.writeResult(live, {
			version: 1,
			status: "completed",
			output: "THE-ACTUAL-OUTPUT",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readRuns())[0].status === "completed");

		const withoutOutput = await h.call("subagent_status", { id: live.id, include_output: false });
		assert.ok(withoutOutput.text.includes("THE-ACTUAL-OUTPUT"), `the default call must return the answer: ${withoutOutput.text}`);
		assert.match(withoutOutput.text, /completed/);

		// A list-view flag must never reach the collection path.
		const compactInspect = await h.call("subagent_status", { id: live.id, compact: true });
		assert.ok(compactInspect.text.includes("THE-ACTUAL-OUTPUT"), `compact does not apply to an id: ${compactInspect.text}`);
	});
});

test("a run that finishes no longer wakes the main agent", async () => {
	// The notification used to be { deliverAs: "followUp", triggerTurn: true },
	// which pi turns into a full extra turn with the conversation re-sent. It is
	// now inert: sent, and recorded as a message, but with no options that let pi
	// take the turn.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "quiet finish" })).details as unknown as RunRecord;
		await h.writeResult(run, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");

		assert.equal(h.messages.length, 1, "the model still learns of the completion");
		assert.deepEqual(h.messages[0]?.options, undefined, "no deliverAs and no triggerTurn: pi must not start or queue a turn");
		assert.match(String(h.messages[0]?.message.content), new RegExp(`subagent_status\\({ id: "${run.id}" }\\)`), "and it is told how to collect the result");
	});
});

test("subagent_resume refuses to resume a run that is still going", async () => {
	await withHarness(undefined, async (h) => {
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		const result = await h.call("subagent_resume", { id: active.id, message: "are you there" });
		assert.match(result.text, /still has a live child \(running\)/);
	});
});

test("subagent_clean does not delete a run dir that still owns a live run's transcript", async () => {
	// Regression test: subagent_resume keeps the ANCESTOR's transcript, so
	// deleting the ancestor's run dir pulled the file out from under a run that
	// was still running. pi holds the descriptor open, so the child kept
	// writing to an unlinked inode and lost every entry silently.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await harness.writeResult(first, {
			version: 1,
			status: "completed",
			output: "ok",
			finishedAt: Date.now(),
			sessionFile: first.sessionFile,
		});
		await waitFor(async () => (await harness.readRuns()).find((run) => run.id === first.id)?.status === "completed");

		// Resume it: the new run points at the old run's transcript and is running.
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;

		const cleaned = await harness.call("subagent_clean", { delete_files: true });
		assert.match(cleaned.text, /still hold the session file of a live run/);
		assert.match(cleaned.text, new RegExp(first.id));

		// The ancestor's transcript must still be on disk for the live run.
		assert.ok(existsSync(resumed.sessionFile as string), "live run's transcript survives the clean");
		assert.ok(existsSync(first.runDir), "the owning run dir is retained");
	});
});

test("subagent_clean counts only transcripts it actually deletes", async () => {
	// A resumed record's sessionFile lives in its ancestor's run dir, so
	// counting "has a sessionFile" over-reports: here the ancestor is skipped
	// as too recent while the resumed record is deleted, and the resumed
	// record's own dir contains no transcript at all. Deleting it destroys
	// nothing resumable, so the count must stay at 0.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;
		await harness.writeResult(resumed, {
			version: 1,
			status: "completed",
			output: "ok",
			// Old enough to be cleaned; the ancestor stays recent.
			finishedAt: Date.now() - 7_200_000,
			sessionFile: resumed.sessionFile,
		});
		await waitFor(async () => (await harness.readRuns()).find((run) => run.id === resumed.id)?.status === "completed");

		const cleaned = await harness.call("subagent_clean", { delete_files: true, older_than_hours: 1 });
		assert.match(cleaned.text, /deleted 1 run dir\(s\)/, cleaned.text);
		assert.doesNotMatch(
			cleaned.text,
			/child session transcript/,
			`deleting the resumed run's empty dir must not be reported as a lost transcript: ${cleaned.text}`,
		);
		// The ancestor's transcript is untouched, because it was skipped.
		assert.ok(existsSync(resumed.sessionFile as string));
	});
});

// --- Turn-level interrupt (local patch 13): subagent_interrupt and the
// "terminal but still alive" contract of the interrupted status. ---

test("subagent_interrupt sends Escape to the child's pane and nothing else", async () => {
	await withHarness({ interruptConfirmMs: "300" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1, "one key, one send: a second Enter would submit whatever the child had typed");
		assert.deepEqual(sent[0].args.slice(-3), ["-t", run.tmuxTarget, "Escape"]);
		assert.ok(!sent[0].args.includes("-l"), "Escape is a key, not a literal string");
		assert.ok(!sent[0].args.includes("C-c"), "app.clear quits the child on the second press");
		assert.match(interrupted.text, /did not confirm an interrupt/, "an idle child cannot confirm");

		// The record says a request is outstanding, so subagent_status can explain
		// a run whose child never answered.
		const stored = (await h.readRuns())[0];
		assert.ok(stored.interruptRequestedAt);
		assert.equal(stored.status, "running");
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: Escape sent .*not confirmed yet/s);
	});
});

test("subagent_interrupt confirms once the child writes the marker", async () => {
	await withHarness({ interruptConfirmMs: "5000" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		// The child needs a moment to abort its provider stream, so the marker
		// lands after Escape was sent.
		setTimeout(() => {
			void h.writeInterrupt(run).catch(() => undefined);
		}, 300);

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		assert.match(interrupted.text, new RegExp(`Subagent ${run.id} interrupted\\.`));
		assert.match(interrupted.text, /attach/);
		assert.match(interrupted.text, /subagent_cancel/);

		const stored = (await h.readRuns())[0];
		assert.equal(stored.status, "interrupted");
		assert.equal(stored.interrupts, 1);
		assert.ok(stored.interruptedAt);
		assert.equal(stored.interruptRequestedAt, undefined, "a confirmed request is no longer outstanding");
		assert.equal(stored.finishedAt, undefined, "the child is still running, so elapsed time keeps counting");
		assert.equal(h.messages.length, 0, "an interrupted turn is not a completion");

		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: turn aborted/);
		assert.match(status.text, /idle at its prompt/);
	});
});

test("an interrupt the watcher folded first is still reported as confirmed", async () => {
	// Regression: the confirmation poll inferred staleness from `noteInterrupt`'s
	// return value. The watcher folds the SAME marker on its 500ms tick, so when it
	// won the race the tool read a marker that genuinely confirmed the interrupt
	// but reported "no new interrupt was reported" — telling the agent that a stop
	// it had just caused had not happened.
	//
	// `afterEscapeSent` blocks the Escape exec until the watcher has folded the
	// marker, so the race is deterministic: by the time the tool polls, the run is
	// already `interrupted` and `noteInterrupt` has nothing left to change.
	let foldMarker: (() => Promise<void>) | undefined;
	await withHarness(
		{
			interruptConfirmMs: "5000",
			afterEscapeSent: async () => {
				await foldMarker?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "watcher wins the race" })).details as unknown as RunRecord;
			foldMarker = async () => {
				await h.writeInterrupt(run);
				// Let the watcher drain the marker before the tool's poll resumes.
				await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
			};

			const interrupted = await h.call("subagent_interrupt", { id: run.id });
			assert.match(
				interrupted.text,
				new RegExp(`Subagent ${run.id} interrupted\\.`),
				`a marker newer than the baseline confirms even when the watcher folded it first: ${interrupted.text}`,
			);
			assert.doesNotMatch(interrupted.text, /no new interrupt was reported/);
			assert.equal((await h.readRuns())[0].interrupts, 1, "the interrupt is counted exactly once");
		},
	);
});

test("an interrupt whose run already ended is reported as superseded, not confirmed", async () => {
	// `noteInterrupt` refuses a run that is already terminal, so a newer marker
	// cannot fold. Claiming "interrupted" would assert a stop that is not the run's
	// state, and "stale" would blame the previous interrupt; the tool says what
	// actually happened instead.
	let lateRace: (() => Promise<void>) | undefined;
	await withHarness(
		{
			interruptConfirmMs: "5000",
			afterEscapeSent: async () => {
				await lateRace?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "ends before the abort lands" })).details as unknown as RunRecord;
			lateRace = async () => {
				await h.writeResult(run, { version: 1, status: "completed", output: "already done", finishedAt: Date.now() });
				await waitFor(async () => (await h.readRuns())[0].status === "completed");
				// A marker newer than the baseline, for a run that is already over.
				await h.writeInterrupt(run, { interrupts: 1, interruptedAt: Date.now() });
			};

			const outcome = await h.call("subagent_interrupt", { id: run.id });
			assert.match(outcome.text, /already reached completed/, outcome.text);
			assert.doesNotMatch(outcome.text, /Subagent .* interrupted\./, outcome.text);
			assert.equal((await h.readRuns())[0].status, "completed", "a terminal status is not resurrected by a later marker");
		},
	);
});

test("a stale marker cannot confirm a second interrupt", async () => {
	// Regression: the marker file is never deleted, so a second interrupt used to
	// read the FIRST one back within a millisecond and report "interrupted" while
	// the child kept streaming — the agent would then treat a live run as stopped.
	await withHarness({ interruptConfirmMs: "400" }, async (h) => {
		const run = (await h.call("subagent", { task: "steered twice" })).details as unknown as RunRecord;
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.doesNotMatch(second.text, new RegExp(`Subagent ${run.id} interrupted\\.`), second.text);
		assert.match(second.text, /no new interrupt was reported/, second.text);
		assert.match(second.text, /the previous interrupt/);
		assert.equal((await h.readRuns())[0].interrupts, 1, "the old marker must not be counted again");

		// Only a genuinely newer marker confirms. The double-escape guard blocks a
		// request sent inside pi's 500ms window, so wait it out first. A third
		// interrupt means the child's own counter reaches 3: rewriting the same
		// value is, correctly, still the second interrupt.
		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const lastRequest = (await h.readRuns())[0].interruptRequestedAt ?? 0;
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - lastRequest))));
		await h.writeInterrupt(run, { interrupts: 3, interruptedAt: Date.now() });
		const third = await h.call("subagent_interrupt", { id: run.id });
		assert.match(third.text, new RegExp(`Subagent ${run.id} interrupted\\.`), third.text);
		assert.equal((await h.readRuns())[0].interrupts, 3);
	});
});

test("two Escapes are never sent inside pi's double-escape window", async () => {
	// On an idle child pi reads two Escapes within 500ms as its double-escape
	// action and opens the tree selector, which blocks the prompt without
	// touching the turn. The second request must be refused instead of sent.
	await withHarness({ interruptConfirmMs: "0" }, async (h) => {
		const run = (await h.call("subagent", { task: "double escape" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1);
		assert.match(sent[0].args.at(-1) as string, /Escape/);

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.equal(h.execCalls.filter((call) => call.args.includes("send-keys")).length, 1, "no second Escape");
		assert.match(second.text, /double escape/);
	});
});

test("two interrupts reported by the child are both recorded", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "twice interrupted" })).details as unknown as RunRecord;
		const firstAt = Date.now();
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 1);

		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: firstAt + 5_000 });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /2 so far/);

		// A marker that goes backwards must not rewind the count or the timestamp.
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const stored = (await h.readRuns())[0];
		assert.equal(stored.interrupts, 2);
		assert.equal(stored.interruptedAt, firstAt + 5_000);
	});
});

test("a working child stops being described as idle", async () => {
	// The status stays interrupted, but the child can be driven again afterwards,
	// so the summary must not keep claiming it is sitting at the prompt.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "driven again" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
		assert.match((await h.call("subagent_status", { id: run.id })).text, /idle at its prompt/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");
		const after = await h.call("subagent_status", { id: run.id });
		assert.match(after.text, /has been driven again and is working/, after.text);
		assert.doesNotMatch(after.text, /idle at its prompt/);
	});
});

test("a later result still finalizes an interrupted run", async () => {
	// The watcher must survive the status change: an interrupted child that is
	// steered onwards reports normally, and the run completes exactly as an
	// uninterrupted one would.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "corrected answer",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finalized = (await h.readRuns())[0];
		assert.equal(finalized.output, "corrected answer");
		assert.ok(finalized.finishedAt);
		assert.equal(finalized.interrupts, 1, "the interrupt history survives into the result");
		assert.equal(h.messages.length, 1, "and the run reports its completion normally");
	});
});

test("an interrupted run survives a reload and still finalizes", async () => {
	// loadPersistedRuns re-arms watchers for interrupted runs. Without that, a
	// result.json written after a reload would never be noticed and the run would
	// be stranded in `interrupted` forever.
	await withTempAgentDir(async () => {
		const firstHarness = await createHarness();
		let run!: RunRecord;
		try {
			run = (await firstHarness.call("subagent", { task: "outlives a reload" })).details as unknown as RunRecord;
			await firstHarness.writeInterrupt(run);
			await waitFor(async () => (await firstHarness.readRuns())[0].status === "interrupted");
		} finally {
			await firstHarness.shutdown();
		}

		// A fresh extension load over the same agent dir: loadPersistedRuns must
		// restore the interrupted run AND re-arm its watcher.
		const second = await createHarness();
		try {
			await waitFor(async () => second.execCalls.some((call) => call.args.includes("capture-pane")));
			assert.equal((await second.readRuns())[0].status, "interrupted", "the status is restored from disk");

			await second.writeResult(run, {
				version: 1,
				status: "completed",
				output: "finished after the reload",
				finishedAt: Date.now(),
			});
			await waitFor(async () => (await second.readRuns())[0].status === "completed");
			assert.equal((await second.readRuns())[0].output, "finished after the reload");
		} finally {
			await second.shutdown();
		}
	});
});

test("an interrupted run keeps its concurrency slot until it is cancelled", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "interrupted" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "queued behind it" })).details as unknown as RunRecord;
		await h.writeInterrupt(first);
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === first.id)?.status === "interrupted");

		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(
			(await h.readRuns()).find((run) => run.id === second.id)?.status,
			"queued",
			"the interrupted child still holds a process, so it still holds its slot",
		);

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

test("an interrupted run is not cleaned away, and its transcript survives shutdown", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "keep my session" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
		h.execCalls.length = 0;

		// subagent_clean must leave it alone while this session is live: the tmux
		// session is the only handle on a resumable transcript.
		const cleaned = await h.call("subagent_clean", { delete_files: true });
		assert.match(cleaned.text, /skipped 1/);
		assert.ok(
			!h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"cleaning must not kill the interrupted child",
		);
		assert.ok(existsSync(run.runDir), "its run dir survives");

		// Shutdown DOES release the child, because nothing could reach it afterwards
		// and it is idle. Killing the tmux session keeps the transcript, so the run
		// stays resumable — the same bargain auto-reap makes for a finished run.
		await h.shutdown();
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"shutdown releases the interrupted child instead of orphaning it",
		);
		assert.equal((await h.readRuns())[0].status, "interrupted");
		assert.ok(existsSync(run.runDir), "the transcript is still there for subagent_resume");
	});
});

test("subagent_cancel releases an interrupted child", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel an interrupted run" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const cancelled = await h.call("subagent_cancel", { id: run.id });
		assert.match(cancelled.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"cancelling an interrupted run must kill the child that is still alive",
		);
		// And it is now genuinely finished, so a second cancel is a no-op.
		assert.match((await h.call("subagent_cancel", { id: run.id })).text, /already cancelled/);
	});
});

test("a cancelled run reports the usage it burned before it was stopped", async () => {
	// A cancelled run is very often one that had already spent real tokens, so
	// reporting none understates what the session cost. The child never reported a
	// result, so the session file has to be discovered from the run dir.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "burns tokens, then cancelled" })).details as unknown as RunRecord;
		const sessionFile = await writeChildSession(run, [
			{ input: 300, output: 100, cost: 0.02 },
			{ input: 200, output: 50, cost: 0.03 },
		]);

		await h.call("subagent_cancel", { id: run.id });
		await waitFor(async () => (await h.readRuns())[0].status === "cancelled");
		const cancelled = (await h.readRuns())[0];
		assert.equal(cancelled.usage?.totalTokens, 650, "cancel must not discard what the child already spent");
		assert.equal(cancelled.usage?.turns, 2);
		assert.equal(cancelled.sessionFile, sessionFile, "the discovered session file is recorded, so status and clean can see it");
	});
});

test("a run failed at the tmux layer still reports its usage", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "socket dies after spending" })).details as unknown as RunRecord;
		await writeChildSession(run, [{ input: 400, output: 100 }]);

		h.failPaneAlways();
		await waitForRunStatus(h, "failed");
		const failed = (await h.readRuns())[0];
		assert.equal(failed.usage?.totalTokens, 500, "a tmux-level failure is not evidence of zero tokens");
	});
});

test("kill-on-shutdown cancels an interrupted run", async () => {
	await withTempAgentDir(async () => {
		await withEnv({ PI_SUBAGENT_KILL_ON_SHUTDOWN: "true" }, async () => {
			const harness = await createHarness();
			try {
				const run = (await harness.call("subagent", { task: "kill on exit" })).details as unknown as RunRecord;
				await harness.writeInterrupt(run);
				await waitFor(async () => (await harness.readRuns())[0].status === "interrupted");
				await harness.shutdown();
				assert.equal((await harness.readRuns())[0].status, "cancelled");
				assert.ok(harness.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)));
			} finally {
				await harness.shutdown();
			}
		});
	});
});

test("kill-on-shutdown records the usage a running child had burned", async () => {
	// Same bug class as subagent_cancel: shutting down cancels the run, so it must
	// report what the child spent before it was killed. Exercised on a RUNNING run,
	// not just an interrupted one.
	await withTempAgentDir(async () => {
		await withEnv({ PI_SUBAGENT_KILL_ON_SHUTDOWN: "true" }, async () => {
			const harness = await createHarness();
			try {
				const run = (await harness.call("subagent", { task: "killed from under it" })).details as unknown as RunRecord;
				await writeChildSession(run, [{ input: 250, output: 50 }]);
				await harness.shutdown();
				const killed = (await harness.readRuns())[0];
				assert.equal(killed.status, "cancelled");
				assert.equal(killed.usage?.totalTokens, 300, "a shutdown kill is a cancel, and cancels report their usage");
			} finally {
				await harness.shutdown();
			}
		});
	});
});

test("subagent_interrupt refuses a queued run and a finished one", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		await h.call("subagent", { task: "occupies the only slot" });
		const queued = (await h.call("subagent", { task: "never starts" })).details as unknown as RunRecord;
		await assert.rejects(() => h.call("subagent_interrupt", { id: queued.id }), /has not started yet/);

		const done = (await h.readRuns())[0];
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finished = await h.call("subagent_interrupt", { id: done.id });
		assert.match(finished.text, /already completed/);
		await assert.rejects(() => h.call("subagent_interrupt", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("an interrupted run is refused a resume while its child is alive", async () => {
	// Regression: resume opens a SECOND pi process on the transcript, and an
	// interrupted child's pi is still holding that file open. Two appenders
	// interleave branches and scramble usage baselines — the corruption the
	// "already using this session file" guard exists to prevent. So the tool's own
	// suggested next step (attach, or cancel first) must not include resuming.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await harness.writeInterrupt(first);
		await waitFor(async () => (await harness.readRuns())[0].status === "interrupted");

		const refused = await harness.call("subagent_resume", { id: first.id, message: "different plan" });
		assert.match(refused.text, /still has a live child \(interrupted\)/);
		assert.match(refused.text, /subagent_cancel/);
		assert.equal((await harness.readRuns()).length, 1, "no second attempt was started");

		// Cancelling releases the child (the transcript stays on disk), and then
		// resume works exactly as it does for any finished run.
		await harness.call("subagent_cancel", { id: first.id });
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "different plan" }))
			.details as unknown as RunRecord;
		assert.equal(resumed.sessionFile, first.sessionFile);
		assert.equal(resumed.attempt, 2);
		assert.equal(resumed.interrupts, undefined, "the new attempt does not inherit the interrupt history");
	});
});

test("an interrupted run fails when its tmux session disappears", async () => {
	// Regression: `pane_dead` cannot report a missing target — it needs a live
	// pane to ask. Without treating tmux's "can't find pane" as death, a run whose
	// session was killed by hand polled a target that cannot exist every 500ms for
	// the rest of the session while claiming its child was idle at its prompt.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "session killed by hand" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		h.removeTarget();
		h.execCalls.length = 0;
		// Generous: this needs the watcher's next pass, and the suite runs test files
		// in parallel, so timer resolution is not in our hands. Observed at ~2.3s
		// alone; the bound absorbs a loaded machine, not a stall. The poll count is
		// asserted alongside so a timeout says WHICH thing broke — a dead watcher
		// and a slow machine are very different failures.
		await waitForRunStatus(h, "failed", "tmux target removed");
		const failed = (await h.readRuns())[0];
		assert.match(failed.error ?? "", /exited before reporting a result/);
		assert.ok(failed.finishedAt);

		// And the watcher stops, rather than polling a dead target forever.
		h.execCalls.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(
			h.execCalls.filter((call) => call.args.includes("capture-pane")).length,
			0,
			`no further polls, got: ${JSON.stringify(h.execCalls.map((call) => call.args.join(" ")))}`,
		);
	});
});

test("a result written as the session disappears still wins", async () => {
	// The late-result re-read must run on the missing-target path too, or a child
	// that reported and exited in the same instant would be recorded as failed.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "reports as it exits" })).details as unknown as RunRecord;
		h.removeTarget();
		await h.writeResult(run, { version: 1, status: "completed", output: "got out in time", finishedAt: Date.now() });

		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		assert.equal((await h.readRuns())[0].output, "got out in time");
	});
});

test("a result that lands during the pane probe still wins", async () => {
	// The re-read in finalizeMissingChild covers the window between the watcher's
	// FIRST result read and its pane probe. A test that writes the result before
	// the first tick (the one above) never enters that window — which is why
	// deleting the re-read left the whole suite green. `afterPaneDeadProbe` writes
	// into the window directly: the result exists only after the probe has run.
	let writeLate: (() => Promise<void>) | undefined;
	await withHarness(
		{
			paneDead: true,
			afterPaneDeadProbe: async () => {
				await writeLate?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "reports during the pane probe" })).details as unknown as RunRecord;
			writeLate = async () => {
				await h.writeResult(run, {
					version: 1,
					status: "completed",
					output: "landed in the window",
					finishedAt: Date.now(),
				});
			};

			await waitFor(async () => (await h.readRuns())[0].status === "completed");
			assert.equal((await h.readRuns())[0].output, "landed in the window");
		},
	);
});

test("an unclassifiable tmux failure fails the run only after a run of them", async () => {
	// A single hiccup must not fail a healthy child, but a persistently
	// unreachable socket must not leave the watcher polling forever either. The
	// failure is reported as "cannot be reached", not as "the child exited": the
	// two claims need different evidence.
	//
	// The constant is pinned from both sides: one failing tick is tolerated, and
	// the run dies on the MAX_TRANSIENT_TMUX_FAILURES-th consecutive one. Lowering
	// the constant would fail this run during the tolerated blip; raising it would
	// leave it polling past the tick counted below.
	//
	// Synchronised on the harness counter, not on a sleep: the first tick is armed
	// at POLL_INTERVAL_MS after the run starts, so a fixed wait either catches the
	// blip already banked (2) or not (3) — a wrong answer rather than a slow one.
	// Wait for the event instead.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "socket blips" })).details as unknown as RunRecord;
		h.failPaneOnce();
		await waitFor(() => h.paneFailureTicks() === 1);
		assert.equal((await h.readRuns())[0].status, "running", "one failure is tolerated");

		h.failPaneAlways();
		h.resetPaneFailureTicks();
		h.execCalls.length = 0;
		await waitForRunStatus(h, "failed", "unclassifiable tmux failure");
		assert.equal(h.paneFailureTicks(), 2, "one failure so far, so two more consecutive ones reach the limit of 3");
		assert.match((await h.readRuns())[0].error ?? "", /could not be reached over tmux/);
		assert.doesNotMatch((await h.readRuns())[0].error ?? "", /exited before reporting/);
	});
});

test("an unconfirmed Escape is forgotten once the child is seen working again", async () => {
	// Otherwise subagent_status keeps advertising "not confirmed yet" for an Escape
	// from minutes ago, and the field feeds the double-escape guard.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "ignores escape" })).details as unknown as RunRecord;
		await h.call("subagent_interrupt", { id: run.id });
		assert.ok((await h.readRuns())[0].interruptRequestedAt);
		assert.match((await h.call("subagent_status", { id: run.id })).text, /not confirmed yet/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].interruptRequestedAt === undefined);
		const status = await h.call("subagent_status", { id: run.id });
		assert.doesNotMatch(status.text, /not confirmed yet/);
	});
});

// --- Live widget (local patch 14): install, refresh, clear. ---

test("the widget is installed above the editor, only while a run is live, and only in TUI mode", async () => {
	await withHarness(undefined, async (h) => {
		assert.deepEqual(h.widgetCalls, [], "an idle session never touches the widget");

		await h.call("subagent", { task: "show a row" });
		assert.deepEqual(
			h.widgetCalls.at(-1),
			{ key: "subagent-status", hasContent: true, placement: "aboveEditor" },
			"installed lazily, when the first run goes live",
		);
		// A component factory, not a frozen string array: RPC ignores factories, so
		// the guard on ctx.mode is what keeps a dead widget out of RPC sessions.
		assert.equal(typeof h.renderWidget(), "object");
	});

	// RPC reports hasUI but forwards only string arrays, so a factory would be
	// dropped and the widget would never update.
	await withTempAgentDir(async () => {
		const harness = await createHarness({ mode: "rpc" });
		try {
			await harness.call("subagent", { task: "no widget here" });
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			assert.deepEqual(harness.widgetCalls, [], "no widget in a mode that cannot render one");
		} finally {
			await harness.shutdown();
		}
	});
});

test("a live run shows a row, and it follows the child's activity", async () => {
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		await h.call("subagent", { task: "investigate the flaky test" });
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		const [first] = h.renderWidget() as string[];
		assert.match(first, /starting · /, first);
		assert.match(first, /investigate the flaky test/, "the task tells the user which run this is");

		await h.writeActivity((await h.readRuns())[0], activitySnapshot((await h.readRuns())[0]));
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("active "));
		assert.match((h.renderWidget() as string[])[0], /active \d+s \(bash\) · /, h.renderWidget()?.join("\n"));
	});
});

test("confirming an interrupt updates the widget within one watcher tick", async () => {
	// noteInterrupt is the only writer of the interrupted status, so it is the
	// only thing that can refresh the widget at that moment. Asserted inside a
	// single 500ms watcher window: waiting longer would let the 1s ticker paper
	// over the omission.
	await withHarness({ interruptConfirmMs: "5000" }, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		h.renderWidget();
		setTimeout(() => {
			void h.writeInterrupt(run).catch(() => undefined);
		}, 50);

		await h.call("subagent_interrupt", { id: run.id });
		const row = (h.renderWidget() as string[])[0] as string;
		assert.match(row, /interrupted/, `the widget must not keep claiming the run is active: ${row}`);
	});
});

test("an interrupted run reads as interrupted even while the child works again", async () => {
	// The authoritative state beats the inference. If the widget said "active"
	// here, the user would see a contradiction with subagent_status, and the agent
	// reading it could believe the run is progressing when it is not.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("interrupted"));
		assert.match((h.renderWidget() as string[])[0], /‖ .*interrupted · /);

		// Even a fresh, actively-working snapshot must not flip the row.
		await h.writeActivity(run, activitySnapshot(run));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.match((h.renderWidget() as string[])[0], /interrupted/);
	});
});

test("a silent child is called stalled only after the configured threshold", async () => {
	await withHarness({ stallSeconds: "1", paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "silent child" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("active"));
		assert.doesNotMatch((h.renderWidget() as string[])[0], /stalled/, "one second of quiet is not a stall");

		// The snapshot goes away and stays away.
		await rm(getActivityFilePath(run.runDir), { force: true });
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("stalled"), 6_000);
		assert.match((h.renderWidget() as string[])[0], /stalled \d+s/);
	});
});

test("a queued run waits for a slot and is never called stalled", async () => {
	// Regression: a queued run has no watcher and so no snapshot by definition, so
	// a stall rule keyed on snapshot silence called it stalled after the threshold
	// — a hung child invented for something merely queueing, contradicting
	// subagent_status. The stall threshold is 1s here so the old bug shows up.
	await withHarness({ maxConcurrent: "1", stallSeconds: "1" }, async (h) => {
		await h.call("subagent", { task: "occupies the only slot" });
		await h.call("subagent", { task: "queued behind it" });
		await waitFor(() => (h.renderWidget() ?? []).length === 2);
		await new Promise((resolve) => setTimeout(resolve, 2_500));

		const rows = h.renderWidget() as string[];
		assert.match(rows[1] as string, /queued for a slot · /, rows.join("\n"));
		assert.doesNotMatch(rows[1] as string, /stalled/, rows.join("\n"));

		// And subagent_status agrees with the widget about this run.
		const queued = (await h.readRuns()).find((run) => run.status === "queued");
		assert.match((await h.call("subagent_status", { id: queued?.id as string })).text, /^\S+\s+queued/m);
	});
});

test("a valid but silent snapshot is called stalled, with a reason", async () => {
	// The case the feature exists for: the child is alive in tmux but has stopped
	// writing. Its last snapshot still says "active", so reading the file alone
	// reports the run as working forever.
	// The child is inside a tool, so the tool threshold applies — hence
	// toolStallSeconds rather than stallSeconds.
	await withHarness({ toolStallSeconds: "1", paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "wedged child" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("active"));
		assert.doesNotMatch((h.renderWidget() as string[])[0], /stalled/);

		// Freeze the snapshot: stop updating the file, exactly as a wedged child
		// would. The tmux pane is still alive, so nothing else fails the run.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		const row = (h.renderWidget() as string[])[0] as string;
		assert.match(row, /stalled/, `a silent child must not look active: ${row}`);
		assert.match(row, /no activity/, row);
		assert.equal((await h.readRuns())[0].status, "running", "a stall is a display claim, not a failure");
	});
});

test("the ticker keeps the widget alive when the watcher cannot", async () => {
	// The 500ms watcher is not a reliable ticker: each of its tmux calls can take
	// seconds when tmux is slow, so between passes nothing would move the elapsed
	// times or notice a stall. execDelayMs makes every watcher pass slow enough
	// that the 1s ticker is the only thing that can refresh within the window
	// asserted here — the previous version of this test passed with the ticker
	// removed, because the watcher was refreshing anyway.
	await withHarness({ execDelayMs: 2_000 }, async (h) => {
		await h.call("subagent", { task: "slow tmux, live widget" });
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		h.renderWidget(); // install the component so requestRender is observable
		const before = h.renderRequests();

		// A watcher pass takes 4s+ here, so three refreshes inside 2.5s can only
		// have come from the ticker.
		await waitFor(() => h.renderRequests() >= before + 3, 2_500);
	});
});

test("the widget is cleared when the last run finishes", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "finish and clear" })).details as unknown as RunRecord;
		await h.writeResult(run, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		assert.deepEqual(
			h.widgetCalls.at(-1),
			{ key: "subagent-status", hasContent: false, placement: undefined },
			"a finished run must not leave a row behind the editor",
		);
		assert.equal(h.renderWidget(), undefined, "nothing left to render");
	});
});

test("interrupted rows sort last, so they cannot push a live run out of view", async () => {
	// Interrupted runs are long-lived by design (one holds its slot until it is
	// cancelled), so ordering purely by age lets four of them fill every row and
	// hide a run the user just started.
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const kept = [];
		for (const name of ["first", "second", "third", "fourth"]) {
			const run = (await h.call("subagent", { task: `${name} interrupted run` })).details as unknown as RunRecord;
			await h.writeInterrupt(run);
			await waitFor(async () => (await h.readRuns()).find((entry) => entry.id === run.id)?.status === "interrupted");
			kept.push(run.id);
		}
		assert.equal((await h.readRuns()).filter((run) => run.status === "interrupted").length, 4);

		const started = (await h.call("subagent", { task: "the run I just launched" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).length === 5, 8_000);
		const rows = h.renderWidget() as string[];
		assert.equal(rows.length, 5, "four rows plus the overflow line");
		assert.match(rows[0] as string, new RegExp(started.id.slice(0, 8)), `the newest live run must be visible: ${rows.join(" | ")}`);
		assert.match(rows[1] as string, new RegExp(kept[0]?.slice(0, 8) as string), `interrupted runs are shown, just after the live one: ${rows.join(" | ")}`);
	});
});

test("a run's elapsed time starts when it starts, not when it was queued", async () => {
	// subagent_status and /subagents both measure from run.startedAt. If the
	// widget measured from createdAt it would count the queue wait forever, and two
	// surfaces on screen would disagree about one number.
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "holds the slot" })).details as unknown as RunRecord;
		const queued = (await h.call("subagent", { task: "waits in the queue" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).some((line) => line.includes(queued.id.slice(0, 8)) && /queued for a slot/.test(line)));

		// Free the slot so the queued run actually starts.
		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === queued.id)?.status === "running");

		const row = (h.renderWidget() as string[]).find((line) => line.includes(queued.id.slice(0, 8))) as string;
		const elapsed = row?.match(/· (\d+s|[0-9]+m[^·]*) · /)?.[1];
		assert.equal(elapsed, "0s", `a run that just started must not report its queue wait as elapsed time: ${row}`);

		// And the widget agrees with subagent_status, which measures the same thing.
		const status = await h.call("subagent_status", { id: queued.id });
		assert.match(status.text, new RegExp(`${queued.id}\\s+running · \\d+s`), status.text);
	});
});

test("session_shutdown clears the widget and stops its ticker", async () => {
	// Regression coverage for the timer-leak shape of local patch 10: a widget
	// ticker that outlives the session would keep the event loop alive.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "outlives nothing" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		// Install the component so the TUI handle exists and requestRender counts.
		h.renderWidget();

		// Finish the run BEFORE shutting down, so no watcher survives to refresh the
		// widget: with a live run, renderRequests keeps growing through its 500ms
		// ticks and "the ticker stopped" is indistinguishable from "the ticker was
		// still firing but its work was ignored".
		await h.writeResult(run, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		await h.call("subagent", { task: "second run keeps a row alive" });
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		h.renderWidget();

		const before = h.renderRequests();
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.ok(h.renderRequests() > before, "precondition: the ticker is live while a run is");

		await h.shutdown();
		assert.deepEqual(h.widgetCalls.at(-1), { key: "subagent-status", hasContent: false, placement: undefined });

		const afterShutdown = h.renderRequests();
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		assert.equal(h.renderRequests(), afterShutdown, "no render can happen after shutdown: no ticker, no watcher, no live run");
	});
});

// --- Lazy tool exposure (local patch 15) ---
//
// The management tools stop being declared on every request once pi has a way to
// reach them on demand. What matters is not losing them: a tool the model cannot
// find is worse than one it pays for, so every path that cannot answer the
// question must leave them declared.

test("the management tools are declared when pi has no way to reach them on demand", async () => {
	await withHarness(undefined, async (h) => {
		for (const name of ["subagent", "subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} is registered direct without codemode or tool_search`);
			assert.equal(h.declared(name), true, `${name} must stay declared`);
		}
		// And the fallback is not a degraded extension: they still work.
		const run = (await h.call("subagent", { task: "still works" })).details as unknown as RunRecord;
		assert.match((await h.call("subagent_status", { id: run.id })).text, /still works/);
		await h.call("subagent_cancel", { id: run.id });
	});
});

test("codemode or tool_search hides the management tools but never `subagent`", async () => {
	// `subagent` stays declared: it is the entry point, and a model that cannot
	// start a run has no reason to search for the tools that manage one.
	for (const activeTools of [["read", "bash", "edit", "write", "codemode"], ["read", "tool_search"]]) {
		await withHarness({ activeTools }, async (h) => {
			assert.equal(h.toolExposure("subagent"), undefined, "the launch tool is always declared");
			for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
				assert.equal(h.toolExposure(name), "codemode", `${name} should be hidden from every request`);
				assert.equal(
					h.toolRegistrations.filter((entry) => entry.name === name).length,
					1,
					`${name} is registered exactly once: re-registering cannot un-declare a tool that was activated on registration`,
				);
			}
			// Hidden from the model, not gone: still registered and still callable.
			await h.call("subagent", { task: "reachable" });
			assert.match((await h.call("subagent_status", {})).text, /reachable/);
		});
	}
});

test("/tools switching discovery off mid-session does not strand the tools", async () => {
	// The regression that made "fails safe" untrue: registration happens once, and a
	// host can change the tool set afterwards. Without the before_agent_start
	// re-check, all five would be registered as codemode, no longer declared, and
	// no longer reachable — with `subagent` still declared, so the model could
	// start a run it then could not poll or cancel.
	await withHarness({ activeTools: ["read", "codemode", "tool_search"] }, async (h) => {
		for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.declared(name), false, `${name} starts hidden`);
		}

		// The host switches both discovery tools off, as /tools does.
		h.setActiveTools(["read", "bash", "edit", "write"]);
		await h.fireBeforeAgentStart();

		for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} must be re-registered direct`);
			assert.equal(h.declared(name), true, `${name} must be declared again, or the model cannot reach it at all`);
		}
		await h.call("subagent", { task: "still manageable" });
		assert.match((await h.call("subagent_status", {})).text, /still manageable/);
	});
});

test("the note about hidden tools only ships when they are hidden", async () => {
	// ~360 bytes of system prompt per request, and it is a lie in a session that
	// never enabled discovery — so it lives in prepareLoadout, not in the tool.
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "no discovery" });
		assert.doesNotMatch(h.tools.get("subagent")?.description as string, /not declared while/);
	});

	await withHarness({ activeTools: ["read", "codemode"] }, async (h) => {
		await h.call("subagent", { task: "with discovery" });
		// The hook is pi's, so exercise it the way pi does: with a loadout.
		const loadout = {
			declared: [{ name: "subagent", description: h.tools.get("subagent")?.description }],
			getExposure: (name: string) => h.toolExposure(name),
		};
		const changes = (h.tools.get("subagent") as { prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } }).prepareLoadout?.(loadout);
		const note = changes?.descriptions?.subagent;
		assert.ok(note?.includes("not declared while"), `the note must be added when the tools are hidden: ${note}`);
		assert.ok(note.startsWith(h.tools.get("subagent")?.description as string), "it extends the description rather than replacing it");

		// A loadout that does not list the tool at all: the hook must fall back to
		// the extension's own description rather than throwing. This branch was
		// unreachable while every test passed a declared `subagent`, and it did
		// throw — a bare `subagentDescription` that does not exist, hidden because pi
		// wraps prepareLoadout in a try/catch that only logs. pi would have shipped a
		// session with no note and no error.
		const empty = {
			declared: [] as Array<{ name: string; description?: string }>,
			getExposure: (name: string) => h.toolExposure(name),
		};
		const fallback = (h.tools.get("subagent") as { prepareLoadout?: (l: unknown) => { descriptions?: Record<string, string> } }).prepareLoadout?.(empty);
		assert.match(fallback?.descriptions?.subagent ?? "", /not declared while/);
		assert.match(fallback?.descriptions?.subagent ?? "", /delegated task/, "and falls back to the tool's own description");
	});
});

test("the exposure is re-checked without churning the tool registry", async () => {
	// The memo is what makes the per-turn re-check free; this is the case that
	// would catch it being removed (and the registry churn that follows).
	await withHarness({ activeTools: ["read", "codemode"] }, async (h) => {
		await h.call("subagent", { task: "one turn" });
		await h.fireBeforeAgentStart();
		await h.fireBeforeAgentStart();
		for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolRegistrations.filter((entry) => entry.name === name).length, 1, `${name} registered once`);
		}
	});
});

test("an unbound tool API leaves every tool declared instead of throwing", async () => {
	// pi.getActiveTools() throws before the runtime binds. Asking anyway must not
	// take the session down, and must not leave a half-applied exposure.
	await withHarness({ unbound: true }, async (h) => {
		for (const name of ["subagent", "subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolExposure(name), undefined, `${name} must stay direct`);
			assert.equal(h.declared(name), true, `${name} must stay declared`);
		}
		const run = (await h.call("subagent", { task: "unbound is survivable" })).details as unknown as RunRecord;
		assert.match((await h.call("subagent_status", { id: run.id })).text, /unbound is survivable/);
	});
});

test("the management tools are registered once, not on every tick", async () => {
	await withHarness({ activeTools: ["read", "tool_search"] }, async (h) => {
		await h.call("subagent", { task: "counts registrations" });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
			assert.equal(h.toolRegistrations.filter((entry) => entry.name === name).length, 1, `${name} must not churn the tool registry`);
		}
	});
});

test("a fresh extension load re-registers the management tools", async () => {
	// The registration memo is CLOSURE state, so a new load starts unregistered.
	// If it were hoisted to module scope, the second load in this same process
	// would skip registration and the new session would have no subagent_status at
	// all — and "registered once" would not notice, because it only ever looks at
	// one load.
	await withTempAgentDir(async () => {
		const first = await createHarness();
		await first.shutdown();
		const second = await createHarness();
		try {
			for (const name of ["subagent_status", "subagent_cancel", "subagent_interrupt", "subagent_resume", "subagent_clean"]) {
				assert.ok(second.tools.has(name), `${name} must be registered again after a fresh load, not skipped by a shared memo`);
			}
		} finally {
			await second.shutdown();
		}
	});
});


