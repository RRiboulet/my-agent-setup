// Liveness (local patch 11) and the stall rule built on it: the parent reads
// the child's activity snapshot from the run dir, and the widget turns a
// silent snapshot into a visible claim.
//
// The snapshot is a second, softer channel than `result.json`: it may be
// stale, replayed, malformed or belong to a previous child, and none of that
// may move the run's status. Only its absence, past a threshold, is reported —
// and only as a display fact, never as a failure.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { getActivityFilePath, readActivityFile } from "../activity.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { SESSION_ID, activitySnapshot, withHarness } from "./lifecycle-harness.ts";

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
