// Behaviour tests for the subagent lifecycle: launch, concurrency queueing,
// result finalisation, failure detection, cancel, wait, status and clean.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { getActivityFilePath, readActivityFile } from "../activity.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	tools: Map<string, Record<string, unknown>>;
	execCalls: { command: string; args: string[] }[];
	messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[];
	shutdown: () => Promise<void>;
	call: (tool: string, params: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>;
	readRuns: () => Promise<RunRecord[]>;
	writeResult: (run: RunRecord, result: Record<string, unknown>) => Promise<void>;
	writeActivity: (run: RunRecord, activity: Record<string, unknown>) => Promise<void>;
}

interface HarnessOptions {
	maxConcurrent?: string;
	paneText?: string;
	paneDead?: boolean;
	/** Artificial delay (ms) added to every tmux call, so a shutdown can land while a watcher tick is mid-flight. */
	execDelayMs?: number;
	/** Overrides ctx.sessionManager, so fork/lineage tests can present a real live branch. */
	sessionManager?: Record<string, unknown>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const execCalls: { command: string; args: string[] }[] = [];
	const messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];

	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: (tool: Record<string, unknown>) => tools.set(tool.name as string, tool),
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		getThinkingLevel: () => "medium",
		sendMessage: (message: Record<string, unknown>, opts?: Record<string, unknown>) => {
			messages.push({ message, options: opts });
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (options.execDelayMs) await new Promise((resolve) => setTimeout(resolve, options.execDelayMs));
			const joined = args.join(" ");
			if (joined.includes("-V")) return { code: 0, stdout: "tmux 3.3a", stderr: "" };
			if (joined.includes("capture-pane")) {
				return { code: 0, stdout: options.paneText ?? "child working\n", stderr: "" };
			}
			if (joined.includes("display-message")) {
				return { code: 0, stdout: options.paneDead ? "1" : "0", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: options.sessionManager ?? {
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
			// The factory branches on these to decide whether it is running as a
			// child reporter or as the parent. They must be cleared from the
			// ambient environment: a reviewer subagent, or any pi subagent child,
			// already has them set, and without this the harness would silently
			// exercise the child branch and register no parent tools at all.
			PI_TMUX_SUBAGENT_CHILD: undefined,
			PI_TMUX_SUBAGENT_RESULT: undefined,
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
		execCalls,
		messages,
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
	};
}

async function withHarness<T>(
	options: HarnessOptions | undefined,
	fn: (harness: Harness) => Promise<T>,
): Promise<T> {
	return withTempAgentDir(async () => {
		// withTempAgentDir already points PI_CODING_AGENT_DIR at a fresh temp
		// directory and restores the previous value afterwards.
		const harness = await createHarness(options);
		try {
			return await fn(harness);
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
		assert.deepEqual(notification?.options, { deliverAs: "followUp", triggerTurn: true });
		// The notification points at the run rather than inlining its output; the
		// agent collects the text with subagent_status.
		assert.ok(!String(notification?.message.content).includes("the answer is 42"));
		assert.ok(String(notification?.message.content).includes(finalized.id));
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

test("subagent_wait blocks until the run finishes and returns its output", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "wait for me" })).details as unknown as RunRecord;
		setTimeout(() => {
			void h.writeResult(run, {
				version: 1,
				status: "completed",
				output: "finished output",
				finishedAt: Date.now(),
			});
		}, 300);

		const waited = await h.call("subagent_wait", { ids: [run.id], timeout_seconds: 10 });
		assert.ok(waited.text.includes("finished output"));
	});
});

test("subagent_wait returns immediately when nothing is outstanding", async () => {
	await withHarness(undefined, async (h) => {
		const waited = await h.call("subagent_wait", {});
		assert.match(waited.text, /No incomplete subagent runs/);
		await assert.rejects(() => h.call("subagent_wait", { ids: ["ghost"] }), /Unknown subagent run/);
	});
});

test("subagent_wait aborts when the tool call is cancelled", async () => {
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "hangs forever" });
		const controller = new AbortController();
		const tool = h.tools.get("subagent_wait");
		const execute = tool?.execute as (...args: unknown[]) => Promise<unknown>;
		const promise = execute("call-1", {}, controller.signal, undefined, h.ctx);
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
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
			registerCommand: () => undefined,
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
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
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
		} finally {
			await harness.shutdown();
		}
	});
});

test("handoff=lineage links the child to the parent without sharing context", async () => {
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const run = (await harness.call("subagent", { task: "lineage work", handoff: "lineage" })).details as unknown as RunRecord;
			assert.equal(run.mode, "lineage");
			const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
			assert.equal(lines.length, 1, "header only: no inherited conversation");
			assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
			assert.equal(run.usageFromLine, 1);
		} finally {
			await harness.shutdown();
		}
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
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
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
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_resume refuses a second concurrent resume of the same transcript", async () => {
	// Regression test: a finished run stays terminal forever, so the "is it
	// still running" guard passed for both resumes and two pi processes
	// appended to one JSONL, forking branches and scrambling baselines.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
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
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_resume refuses to resume a run that is still going", async () => {
	await withHarness(undefined, async (h) => {
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		const result = await h.call("subagent_resume", { id: active.id, message: "are you there" });
		assert.match(result.text, /still running; cancel it before resuming/);
	});
});

test("subagent_clean does not delete a run dir that still owns a live run's transcript", async () => {
	// Regression test: subagent_resume keeps the ANCESTOR's transcript, so
	// deleting the ancestor's run dir pulled the file out from under a run that
	// was still running. pi holds the descriptor open, so the child kept
	// writing to an unlinked inode and lost every entry silently.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
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
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_clean counts only transcripts it actually deletes", async () => {
	// A resumed record's sessionFile lives in its ancestor's run dir, so
	// counting "has a sessionFile" over-reports: here the ancestor is skipped
	// as too recent while the resumed record is deleted, and the resumed
	// record's own dir contains no transcript at all. Deleting it destroys
	// nothing resumable, so the count must stay at 0.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
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
		} finally {
			await harness.shutdown();
		}
	});
});
