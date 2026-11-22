// The fake-window harness the lifecycle tests drive: a fake ExtensionAPI whose
// `exec` scripts tmux, plus the waits and fixtures every lifecycle file needs.
//
// The extension talks to tmux exclusively through `pi.exec`, so a fake that
// scripts `exec` is enough to drive the whole state machine without spawning
// real tmux sessions or child pi processes. Nothing here is a test: the files
// beside this one are, and each of them passes on its own.
//
// Cross-test state is the thing to keep out of here. Everything mutable lives
// inside one `createHarness` call (the exec scripts, the pane-failure counters,
// the widget registry), `PI_CODING_AGENT_DIR` is redirected to a fresh temp
// directory by `withTempAgentDir`, and the factory is invoked per test, so no
// two tests share a session id, an index file or a tmux name.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import subagentExtension, { type RunRecord } from "../index.ts";
import type { PlanRecord } from "../plan.ts";
import { getActivityFilePath } from "../activity.ts";
import { getInterruptFilePath } from "../interrupt.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

export const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export interface CompletionMessage {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

export interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	tools: Map<string, Record<string, unknown>>;
	execCalls: { command: string; args: string[] }[];
	messages: CompletionMessage[];
	/** Every ctx.ui.notify call, so guard messages can be asserted. */
	notifications: { message: string; type: string | undefined }[];
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
	/**
	 * Drive one left press/release/click through the installed widget's mouse
	 * region, as pi's fullscreen dispatcher would. Uses a single component
	 * instance for the three events, because the press state lives on it.
	 */
	clickWidgetRow: (y: number) => void;
	shutdown: () => Promise<void>;
	call: (tool: string, params: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>;
	readRuns: () => Promise<RunRecord[]>;
	/** The persisted plan records beside the runs (`plans.json`). */
	readPlans: () => Promise<PlanRecord[]>;
	writeResult: (run: RunRecord, result: Record<string, unknown>) => Promise<void>;
	writeActivity: (run: RunRecord, activity: Record<string, unknown>) => Promise<void>;
	writeInterrupt: (run: RunRecord, marker?: Record<string, unknown>) => Promise<void>;
}

export interface HarnessOptions {
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
	 * Invoked while a child's submission (`send-keys … Enter`) is in flight. Lets a
	 * test settle a sibling inside that window, which is the only way to reproduce
	 * a stop policy abandoning a run mid-launch deterministically.
	 */
	duringEnterSent?: () => Promise<void>;
	/**
	 * Invoked when the pane probe reports the pane dead (`paneDead: true`), before
	 * `finalizeMissingChild` runs. Lets a test write a result into the window
	 * between the watcher's first result read and its post-probe re-read.
	 */
	afterPaneDeadProbe?: () => Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const execCalls: { command: string; args: string[] }[] = [];
	const messages: CompletionMessage[] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
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
			if (options.duringEnterSent && joined.includes("send-keys") && args.includes("Enter")) {
				await options.duringEnterSent();
			}
			// The version probe is the only tmux call with no socket in its argv, and
			// the socket path can itself contain "-V" (mkdtemp may name the agent dir
			// `subagent-test-Vxxxxx`), so match the argv exactly. A substring match
			// here once answered EVERY tmux call as a version probe whenever the
			// random name started with V: pane_dead never read as "1", the pane-probe
			// hook never fired, and the run being tested polled for 30s.
			if (args.length === 1 && args[0] === "-V") return { code: 0, stdout: "tmux 3.3a", stderr: "" };
			// Panel calls (local patch 17) are answered before the pane-call machinery,
			// which they must not disturb: the client probe is not a liveness poll.
			// The failure variants of these guards are unit-tested in panel.test.ts.
			if (joined.includes("list-clients")) return { code: 0, stdout: "/dev/pts/1\t@1\t100\n", stderr: "" };
			if (joined.includes("#{window_id}")) return { code: 0, stdout: "@1\n", stderr: "" };
			if (joined.includes("has-session") || joined.includes("detach-client")) return { code: 0, stdout: "", stderr: "" };
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
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
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

	const sessionDir = path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", "tmux-subagents", SESSION_ID);
	const runsIndex = path.join(sessionDir, "runs.json");
	const plansIndex = path.join(sessionDir, "plans.json");

	return {
		pi,
		ctx,
		tools,
		execCalls,
		messages,
		notifications,
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
		clickWidgetRow: (y: number) => {
			const factory = [...widgetComponents.values()].at(-1);
			assert.ok(factory, "a widget must be installed before it can be clicked");
			// A fresh instance from the installed factory: pi calls the factory once and
			// keeps the instance, so this is the same code with the same per-install
			// state (none survives between the press and the click beyond the closure).
			const instance = factory({ requestRender: () => (renderRequests += 1) }, fakeTheme) as unknown as {
				handleMouse?: (event: Record<string, unknown>) => unknown;
			};
			const base = { button: "left", x: 0, y, screenX: 0, screenY: y, width: 80, height: 5, shift: false, alt: false, ctrl: false };
			instance.handleMouse?.({ ...base, type: "press" });
			instance.handleMouse?.({ ...base, type: "release" });
			instance.handleMouse?.({ ...base, type: "click" });
		},
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
		readPlans: async () => {
			try {
				return JSON.parse(await readFile(plansIndex, "utf8")) as PlanRecord[];
			} catch {
				return [];
			}
		},
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
export async function waitForRunStatus(h: Harness, status: string, note = ""): Promise<RunRecord> {
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
 * Wait for the completion message a settled run reports, and return it.
 *
 * The persisted status and the session transcript are two separate observables.
 * `settleRun` writes the status first — `await persist()` — and calls
 * `notifyCompletion` only afterwards, so a run can be observed as `completed`
 * while `sendMessage` has not been called yet. A test that waits for the status
 * and reads `messages` on the very next statement is asserting a simultaneity
 * the product never promises: that shape flaked on `dev` in CI run 44714766416,
 * with the status recorded correctly and `messages.length` still 0.
 *
 * Waits for the message rather than assuming it, and says which half is missing
 * when it never arrives, so a run that genuinely stops notifying still fails and
 * fails with the record rather than with a bare `0 !== 1`.
 */
export async function waitForCompletionMessage(h: Harness): Promise<CompletionMessage> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const first = h.messages[0];
		if (first) return first;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	// readRuns() lists runs in file order; these tests create one, so [0] is the
	// run under test. Named for what it is rather than "last", which would be a
	// trap for the first caller that has more than one.
	const record = (await h.readRuns())[0];
	assert.fail(
		`the run reached "${record?.status}" but reported no completion message; the record=${JSON.stringify(record)}; ` +
			`${h.execCalls.length} exec calls total`,
	);
}

/**
 * Write a child session file under the run dir, as a standalone child would.
 *
 * The parent does not learn this path until the child reports a result, so a run
 * stopped before that — cancel, tmux failure — has to discover it to report the
 * usage it burned.
 */
export async function writeChildSession(
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

/**
 * A failed run must stop the watcher, not keep polling tmux every 500ms.
 *
 * Counts pane probes only: a failed run still reaps its tmux session (one
 * kill-session, which may land after this snapshot), and that is not a poll.
 */
export async function assertWatcherStopped(h: Harness): Promise<void> {
	const probes = () =>
		h.execCalls.filter((call) => call.args.includes("capture-pane") || call.args.includes("display-message")).length;
	const settled = probes();
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	assert.equal(probes(), settled, "the watcher must stop with the run instead of polling forever");
}

/**
 * Write a `result.json` this parent cannot use and assert it fails the run.
 *
 * The file protocol crosses extension versions — a child may run another
 * branch's build, via trusted-copy resolution — so a shape the parent does not
 * understand is expected rather than a hypothetical. It must end the run with a
 * visible error, once: before, `finalizeRun` threw inside the watch tick, the
 * error was logged, the tick rescheduled, and the run stayed `running` forever
 * while its result was never consumed.
 *
 * The invalid read is tolerated for MAX_TRANSIENT_RESULT_FAILURES ticks, so this
 * waits rather than assuming the first tick fails it. Only the canonical
 * unparseable-JSON test asserts the watcher stops afterwards; the property is the
 * same for every shape, and re-proving it in each case costs seconds.
 */
export async function assertUnusableResultFailsRun(h: Harness, raw: string, expected: RegExp): Promise<void> {
	const run = (await h.call("subagent", { task: "unusable result" })).details as unknown as RunRecord;
	await writeFile(run.resultPath, raw, "utf8");
	const failed = await waitForRunStatus(h, "failed", "an unusable result.json must fail the run, not stall it");
	assert.match(failed.error ?? "", expected);
	assert.ok((failed.error ?? "").includes(run.resultPath), "the failure names the file a human must inspect");
	// The session is reaped the moment the run settles, so the last captured pane
	// is the only readable trace of what the child was doing when its result file
	// turned out unusable. It must ride in the error, not live only in a record a
	// fan-out wait no longer renders.
	assert.ok((failed.error ?? "").includes("child working"), "the failure carries the last pane");
}

export async function withHarness<T>(
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

export function activitySnapshot(run: RunRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** A parent session manager presenting a live branch whose last-written entry is a different branch. */
export function liveBranchSessionManager(agentDir: string) {
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

/** Complete a run the way the child would, so it is eligible for resume. */
export async function completeRun(h: Harness, run: RunRecord): Promise<void> {
	await h.writeResult(run, {
		version: 1,
		status: "completed",
		output: "ok",
		finishedAt: Date.now(),
		sessionFile: run.sessionFile,
	});
	await waitFor(async () => (await h.readRuns()).find((candidate) => candidate.id === run.id)?.status === "completed");
}
