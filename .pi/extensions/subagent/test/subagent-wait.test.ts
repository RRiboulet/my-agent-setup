// Behaviour tests for `subagent_wait` (ticket 03: wait for a run instead of
// polling its status).
//
// The extension talks to tmux exclusively through `pi.exec`, so the same fake
// ExtensionAPI the lifecycle tests use — rebuilt here, trimmed to what a wait
// needs and with `mode: "rpc"` so no widget ticker runs — is enough to drive the
// whole path without spawning real tmux sessions or child pi processes.
//
// Risk covered: `subagent_wait` must resolve from the terminal transitions the
// EXISTING settle watcher already drives (`finalizeRun`, `markRunFailed`,
// `subagent_cancel`, `noteInterrupt`), never from a second poll loop of its own;
// a timeout must return the current record plus the latest pane, never an error;
// and the tool descriptions must teach "start, then wait once" rather than
// polling, which is what the 681-status-calls measurement bought this change.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { withEnv, withTempAgentDir } from "./helpers.ts";

const SESSION_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

interface WaitHarness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	tools: Map<string, Record<string, unknown>>;
	/** Every tool call made through the harness, in order: the scripted acceptance reads this. */
	toolCalls: { tool: string; params: Record<string, unknown> }[];
	execCalls: { command: string; args: string[] }[];
	messages: { message: Record<string, unknown> }[];
	shutdown: () => Promise<void>;
	call: (tool: string, params: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>;
	readRuns: () => Promise<RunRecord[]>;
	writeResult: (run: RunRecord, result: Record<string, unknown>) => Promise<void>;
	/** How many times each tool was called so far — the scripted-acceptance counter. */
	countCalls: (tool: string) => number;
}

interface WaitHarnessOptions {
	maxConcurrent?: string;
	paneText?: string;
	/** Report the child's pane dead, so the watcher fails the run. */
	paneDead?: boolean;
	/** Fail the `tmux -V` probe, so the launch itself throws: a failed-to-start run. */
	failVersionProbe?: boolean;
}

async function createWaitHarness(options: WaitHarnessOptions = {}): Promise<WaitHarness> {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const execCalls: { command: string; args: string[] }[] = [];
	const messages: { message: Record<string, unknown> }[] = [];
	const toolCalls: { tool: string; params: Record<string, unknown> }[] = [];

	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: (tool: Record<string, unknown>) => {
			tools.set(tool.name as string, tool);
		},
		registerMessageRenderer: () => undefined,
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		getThinkingLevel: () => "medium",
		// The management tools' exposure is resolved from the active set; report a
		// plain set so they are registered direct (the default, always-correct way).
		getActiveTools: () => ["read", "bash", "edit", "write"],
		sendMessage: (message: Record<string, unknown>) => {
			messages.push({ message });
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			const joined = args.join(" ");
			if (args.length === 1 && args[0] === "-V") {
				return options.failVersionProbe
					? { code: 1, stdout: "", stderr: "tmux not found" }
					: { code: 0, stdout: "tmux 3.3a", stderr: "" };
			}
			if (joined.includes("capture-pane")) {
				return { code: 0, stdout: `${options.paneText ?? "child working"}\n`, stderr: "" };
			}
			if (joined.includes("display-message")) {
				return { code: 0, stdout: options.paneDead ? "1" : "0", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	const ctx = {
		cwd: process.cwd(),
		// RPC, not TUI: no widget to install or tick, so the event loop stays quiet.
		mode: "rpc",
		hasUI: false,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", `${SESSION_ID}.jsonl`),
			getBranch: () => [],
		},
		model: { provider: "openrouter", id: "parent/model" },
		ui: {
			notify: () => undefined,
			custom: async () => undefined,
			setWidget: () => undefined,
		},
		shutdown: () => undefined,
	};

	await withEnv(
		{
			// Same reason as the lifecycle harness: a reviewer subagent runs inside a
			// child that already has these set, and the factory branches on them.
			PI_TMUX_SUBAGENT_CHILD: undefined,
			PI_TMUX_SUBAGENT_RESULT: undefined,
			PI_TMUX_SUBAGENT_INTERRUPT: undefined,
			PI_SUBAGENT_MAX_CONCURRENT: options.maxConcurrent ?? "4",
			PI_SUBAGENT_NOTIFY: "true",
			PI_SUBAGENT_AUTO_REAP: "true",
			PI_SUBAGENT_REAP_DELAY_MS: "0",
			PI_SUBAGENT_GC_DAYS: "7",
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
		toolCalls,
		execCalls,
		messages,
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		call: async (tool, params) => {
			toolCalls.push({ tool, params });
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
		countCalls: (tool) => toolCalls.filter((entry) => entry.tool === tool).length,
	};
}

async function withWaitHarness<T>(
	options: WaitHarnessOptions | undefined,
	fn: (harness: WaitHarness, agentDir: string) => Promise<T>,
): Promise<T> {
	// withTempAgentDir points PI_CODING_AGENT_DIR at a fresh temp directory for the
	// whole body, so the runs index and the tmux socket path never touch ~/.pi/agent.
	return withTempAgentDir(async (agentDir) => {
		const harness = await createWaitHarness(options);
		try {
			return await fn(harness, agentDir);
		} finally {
			await harness.shutdown();
		}
	});
}

/** A terminal child result, as a real child writes it. */
const completedResult = (output: string) => ({
	version: 1,
	status: "completed",
	output,
	sessionFile: "/tmp/child.jsonl",
	provider: "openrouter",
	model: "child/model",
	thinking: "low",
	finishedAt: Date.now(),
});

/**
 * Wait for a run to reach `status`, saying WHY it did not when it never does —
 * the same reporting the lifecycle tests rely on to tell "slow machine" from
 * "the watcher died".
 */
async function waitForRunStatus(h: WaitHarness, id: string, status: string): Promise<RunRecord> {
	const deadline = Date.now() + 30_000;
	let last: RunRecord | undefined;
	while (Date.now() < deadline) {
		last = (await h.readRuns()).find((run) => run.id === id);
		if (last?.status === status) return last;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	const probes = h.execCalls.filter((call) => call.args.includes("capture-pane")).length;
	assert.fail(`run never reached "${status}"; last record=${JSON.stringify(last)}; ${probes} capture-pane calls`);
}

test("the scripted three-child fan-out: 3 starts, 1 wait, zero status calls", async () => {
	// The acceptance the ticket scripts: start three children, then wait ONCE for
	// all of them. No subagent_status call anywhere — that is the 17-per-run poll
	// this tool exists to delete.
	await withWaitHarness(undefined, async (h) => {
		const first = (await h.call("subagent", { task: "first child" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "second child" })).details as unknown as RunRecord;
		const third = (await h.call("subagent", { task: "third child" })).details as unknown as RunRecord;

		const waiting = h.call("subagent_wait", { ids: [first.id, second.id, third.id], timeoutMs: 30_000 });
		await h.writeResult(first, completedResult("answer one"));
		await h.writeResult(second, completedResult("answer two"));
		await h.writeResult(third, completedResult("answer three"));
		const waited = await waiting;

		// Every run settles, in the requested order, with its output.
		const details = waited.details as { runs: RunRecord[]; timedOut: boolean };
		assert.equal(details.timedOut, false);
		assert.deepEqual(
			details.runs.map((run) => run.id),
			[first.id, second.id, third.id],
			"the runs come back in the order the caller named them",
		);
		assert.ok(details.runs.every((run) => run.status === "completed"), "every run is settled");
		assert.match(waited.text, /answer one/);
		assert.match(waited.text, /answer two/);
		assert.match(waited.text, /answer three/);
		assert.match(waited.text, /All 3 run\(s\) settled/);

		// The count IS the acceptance: 3 starts, 1 wait, zero polls.
		assert.equal(h.countCalls("subagent"), 3);
		assert.equal(h.countCalls("subagent_wait"), 1);
		assert.equal(h.countCalls("subagent_status"), 0);
	});
});

test("subagent_wait resolves within about a second of the settle event", async () => {
	// The watcher ticks every 500ms (POLL_INTERVAL_MS), so the honest tolerance is
	// ~1s, not the 250ms a tighter number would flake on. Two seconds keeps the
	// bound machine-kind while still failing a wait that polls nothing at all.
	await withWaitHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "settles soon" })).details as unknown as RunRecord;
		const started = Date.now();
		const waiting = h.call("subagent_wait", { id: run.id, timeoutMs: 30_000 });
		await h.writeResult(run, completedResult("the answer is 42"));
		const waited = await waiting;
		const elapsed = Date.now() - started;

		assert.equal((waited.details as { timedOut: boolean }).timedOut, false);
		assert.match(waited.text, /the answer is 42/);
		assert.match(waited.text, /completed/);
		assert.ok(elapsed < 2_000, `the wait must resolve from the watcher's transition, not its timeout (${elapsed}ms)`);
	});
});

test("a still-running child does not resolve the wait early; the timeout returns the record plus the latest pane", async () => {
	// The inverse timing check: a 30s child (a result that never arrives) must not
	// be reported settled. The timeout path returns the CURRENT record plus the
	// latest pane — a result, never an error, and never the child's final output.
	// Two watcher ticks (500ms each) fit inside the bound, so the pane is on the
	// record well before the timeout fires.
	await withWaitHarness({ paneText: "child still working" }, async (h) => {
		const run = (await h.call("subagent", { task: "thirty seconds" })).details as unknown as RunRecord;
		const started = Date.now();
		const waited = await h.call("subagent_wait", { id: run.id, timeoutMs: 1_200 });
		const elapsed = Date.now() - started;

		assert.equal((waited.details as { timedOut: boolean }).timedOut, true);
		assert.ok(elapsed >= 1_000, `the wait must run to its timeout, not return early (${elapsed}ms)`);
		assert.ok(elapsed < 5_000, `the timeout must fire, not hang (${elapsed}ms)`);
		assert.match(waited.text, /did not settle within 1200ms \(status: running\)/);
		// The current record, not a settlement: no output, and the latest pane.
		assert.match(waited.text, /running/);
		assert.match(waited.text, /child still working/, "the pane the watcher captured is included");
		assert.doesNotMatch(waited.text, /the answer/);
	});
});

test("a run still queued at the timeout is reported as queued", async () => {
	// A queued run has no child, no watcher and no pane, so there is nothing to
	// wait on: the timeout reports `queued`, never `running` and never a hang.
	await withWaitHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "holds the only slot" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "still queued" })).details as unknown as RunRecord;
		const runs = await h.readRuns();
		assert.equal(runs.find((run) => run.id === second.id)?.status, "queued", "precondition: the second run is queued");

		const waited = await h.call("subagent_wait", { id: second.id, timeoutMs: 400 });
		assert.equal((waited.details as { timedOut: boolean }).timedOut, true);
		assert.match(waited.text, /did not settle within 400ms \(status: queued\)/);
		assert.match(waited.text, /queued/, "the record says queued, not running");
	});
});

test("terminal runs return immediately: cancelled and interrupted", async () => {
	// A terminal run must never wait out its timeout — not even the 30s default.
	// Two transitions, two sources: the cancel tool, and the interrupt marker the
	// watcher folds into the record on its tick.
	await withWaitHarness(undefined, async (h) => {
		// Cancelled.
		const cancelled = (await h.call("subagent", { task: "will be cancelled" })).details as unknown as RunRecord;
		await h.call("subagent_cancel", { id: cancelled.id });
		const cancelledStart = Date.now();
		const cancelledWait = await h.call("subagent_wait", { id: cancelled.id, timeoutMs: 30_000 });
		assert.ok(Date.now() - cancelledStart < 2_000, "a cancelled run is terminal: the wait returns at once");
		assert.equal((cancelledWait.details as { timedOut: boolean }).timedOut, false);
		assert.match(cancelledWait.text, /cancelled/);

		// Interrupted: the watcher folds the marker into the record on its tick.
		const interrupted = (await h.call("subagent", { task: "will be interrupted" })).details as unknown as RunRecord;
		await writeFile(
			path.join(interrupted.runDir, "interrupt.json"),
			`${JSON.stringify({ version: 1, runId: interrupted.id, interruptedAt: Date.now(), interrupts: 1, stopReason: "aborted" })}\n`,
			"utf8",
		);
		await waitForRunStatus(h, interrupted.id, "interrupted");
		const interruptedStart = Date.now();
		const interruptedWait = await h.call("subagent_wait", { id: interrupted.id, timeoutMs: 30_000 });
		assert.ok(Date.now() - interruptedStart < 2_000, "an interrupted run is terminal: the wait returns at once");
		assert.equal((interruptedWait.details as { timedOut: boolean }).timedOut, false);
		assert.match(interruptedWait.text, /interrupted/);
	});
});

test("a dead child is terminal for the wait", async () => {
	// The watcher's pane_dead probe fails the run (finalizeMissingChild), so the
	// wait must return the failed record, not hang out its timeout.
	await withWaitHarness({ paneDead: true }, async (h) => {
		const dead = (await h.call("subagent", { task: "dies with the pane" })).details as unknown as RunRecord;
		await waitForRunStatus(h, dead.id, "failed");
		const deadStart = Date.now();
		const deadWait = await h.call("subagent_wait", { id: dead.id, timeoutMs: 30_000 });
		assert.ok(Date.now() - deadStart < 2_000, "a dead run is terminal: the wait returns at once");
		assert.equal((deadWait.details as { timedOut: boolean }).timedOut, false);
		assert.match(deadWait.text, /failed/);
	});
});

test("a failed-to-start run is terminal for the wait", async () => {
	// markRunFailed is the failed-to-start path: the launch throws before any
	// child exists, so there is no watcher and no pane — only the terminal record.
	await withWaitHarness({ failVersionProbe: true }, async (h) => {
		const run = (await h.call("subagent", { task: "cannot launch" })).details as unknown as RunRecord;
		await waitForRunStatus(h, run.id, "failed");
		const started = Date.now();
		const waited = await h.call("subagent_wait", { id: run.id, timeoutMs: 30_000 });
		assert.ok(Date.now() - started < 2_000, "a failed-to-start run is terminal: the wait returns at once");
		assert.equal((waited.details as { timedOut: boolean }).timedOut, false);
		assert.match(waited.text, /failed/);
	});
});

test("with ids, a timeout returns every settled run plus the still-running ones", async () => {
	await withWaitHarness(undefined, async (h) => {
		const settledRun = (await h.call("subagent", { task: "settles" })).details as unknown as RunRecord;
		const runningRun = (await h.call("subagent", { task: "keeps running" })).details as unknown as RunRecord;
		await h.writeResult(settledRun, completedResult("settled answer"));

		const waited = await h.call("subagent_wait", { ids: [settledRun.id, runningRun.id], timeoutMs: 1_500 });
		const details = waited.details as { runs: RunRecord[]; timedOut: boolean };
		assert.equal(details.timedOut, true, "one run never settled, so the wait times out");
		assert.equal(details.runs.length, 2, "both runs come back, not just the settled one");
		assert.match(waited.text, /1 of 2 run\(s\) settled/);
		assert.match(waited.text, /1 still running/);
		assert.match(waited.text, /settled answer/, "the settled run carries its output");
		assert.match(waited.text, /running/, "the still-running run is reported as running");
	});
});

test("subagent_wait validates its arguments", async () => {
	await withWaitHarness(undefined, async (h) => {
		await assert.rejects(() => h.call("subagent_wait", {}), /needs an id or a list of ids/);
		await assert.rejects(
			() => h.call("subagent_wait", { id: "a", ids: ["a"] }),
			/takes either id or ids, not both/,
		);
		await assert.rejects(() => h.call("subagent_wait", { ids: [] }), /at least one id/);
		await assert.rejects(() => h.call("subagent_wait", { id: "nope" }), /Unknown subagent run/);
		await assert.rejects(() => h.call("subagent_wait", { ids: ["nope"] }), /Unknown subagent run/);

		// A malformed timeout degrades to "check once", which for a still-running
		// run is a timed-out wait that returns the current record — never an error,
		// and never the default ten minutes.
		const run = (await h.call("subagent", { task: "bad timeout" })).details as unknown as RunRecord;
		const waited = await h.call("subagent_wait", { id: run.id, timeoutMs: -5 });
		assert.equal((waited.details as { timedOut: boolean }).timedOut, true);
		assert.match(waited.text, /did not settle/);
	});
});

test("the tool descriptions teach start-then-wait-once, not polling", async () => {
	// The description IS the teaching surface: the 681 status calls were 17 turns
	// per run of a model asking "done yet?", so the text must point at subagent_wait.
	await withTempAgentDir(async () => {
		const harness = await createWaitHarness();
		try {
			const subagent = harness.tools.get("subagent") as
				| { description?: string; promptGuidelines?: string[] }
				| undefined;
			const status = harness.tools.get("subagent_status") as { description?: string } | undefined;
			const wait = harness.tools.get("subagent_wait") as { description?: string } | undefined;

			assert.ok(wait, "subagent_wait is registered");
			assert.match(wait?.description ?? "", /subagent_wait/, "the new tool's own description names itself");

			// The launch tool: no more "poll subagent_status", and wait-once instead.
			assert.match(subagent?.description ?? "", /subagent_wait/);
			assert.match(subagent?.description ?? "", /wait once/i);
			assert.doesNotMatch(subagent?.description ?? "", /poll subagent_status/);
			assert.doesNotMatch(subagent?.description ?? "", /no blocking wait: poll/i);
			const guidelines = subagent?.promptGuidelines?.join("\n") ?? "";
			assert.match(guidelines, /subagent_wait/);
			assert.doesNotMatch(guidelines, /poll/i);

			// The status tool keeps its live-question job and points at wait.
			assert.match(status?.description ?? "", /subagent_wait/);
			assert.doesNotMatch(status?.description ?? "", /poll this instead/);
		} finally {
			await harness.shutdown();
		}
	});

	// The start reply must point at the wait tool, not at collecting via status:
	// a single call records the pointer the model reads right after starting.
	await withWaitHarness(undefined, async (h) => {
		const started = await h.call("subagent", { task: "reply points at wait" });
		const run = started.details as unknown as RunRecord;
		assert.match(started.text, new RegExp(`subagent_wait\\(\\{ id: "${run.id}" \\}\\)`));
		assert.doesNotMatch(started.text, /subagent_status/);
	});
});

test("a pending wait is released by shutdown instead of blocking it", async () => {
	// session_shutdown now releases waiters: without it, a wait pending against a
	// run nothing can settle any more would block out its whole timeout while the
	// session is going down.
	await withWaitHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "outlives the session" })).details as unknown as RunRecord;
		const waiting = h.call("subagent_wait", { id: run.id, timeoutMs: 60_000 });
		// Give the wait a moment to register, then shut the session down.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const shutdownStarted = Date.now();
		await h.shutdown();
		const waited = await waiting;
		assert.ok(Date.now() - shutdownStarted < 5_000, "shutdown must not be blocked by the pending wait");
		assert.match(waited.text, /Session ended before/, "shutdown says the session ended, not that the run settled");
		assert.match(waited.text, /running/, "the record still reports the run as running");
		assert.equal(waited.details.ended, true, "the wait details mark the release as a session end");
		assert.equal(waited.details.timedOut, false, "a session end is not a timeout");
	});
});
