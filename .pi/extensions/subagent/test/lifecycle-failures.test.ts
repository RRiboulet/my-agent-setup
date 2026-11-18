// Failure detection: every way a run can end without a usable result, and the
// `result.json` shapes this parent must refuse instead of throwing in the
// watcher or stalling the run.
//
// The file protocol crosses extension versions — a child may run another
// branch's build — so an unusable result is expected, not hypothetical. What
// matters in every case here is that the run reaches a terminal status ONCE,
// with an error a human can act on, and that the watcher then stops.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { waitFor } from "./helpers.ts";
import { assertUnusableResultFailsRun, assertWatcherStopped, waitForRunStatus, withHarness, type Harness } from "./lifecycle-harness.ts";

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

test("an unparseable result file fails the run instead of stalling it", async () => {
	await withHarness(undefined, async (h) => {
		await assertUnusableResultFailsRun(h, "{not json", /not valid JSON/);
		// The canonical no-watchdog-loop assertion: the other shapes below share it.
		await assertWatcherStopped(h);
	});
});

test("a newer protocol version with the wrong shape is reported as likely skew", async () => {
	await withHarness(undefined, async (h) => {
		const raw = JSON.stringify({ version: 2, status: "completed", finishedAt: Date.now() });
		await assertUnusableResultFailsRun(h, raw, /protocol version 2.*different build of this extension/);
	});
});

test("a result without its output fails the run instead of throwing in the watcher", async () => {
	await withHarness(undefined, async (h) => {
		const raw = JSON.stringify({ version: 1, status: "completed", finishedAt: Date.now() });
		await assertUnusableResultFailsRun(h, raw, /output is missing or is not a string/);
	});
});

test("a result with an unknown status fails the run instead of mislabelling it", async () => {
	await withHarness(undefined, async (h) => {
		const raw = JSON.stringify({ version: 1, status: "done", output: "hello", finishedAt: Date.now() });
		await assertUnusableResultFailsRun(h, raw, /not "completed" or "failed"/);
	});
});

test("an unreadable result path fails the run instead of polling a directory forever", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "unreadable result" })).details as unknown as RunRecord;
		// A directory where the file should be: the read fails with EISDIR, which
		// (unlike ENOENT) will not fix itself on the next tick.
		await mkdir(run.resultPath);
		const failed = await waitForRunStatus(h, "failed", "an unreadable result path must fail the run");
		assert.match(failed.error ?? "", /could not be read/);
	});
});

test("a non-string optional field fails the run instead of reaching finalizeRun", async () => {
	// `error` is trimmed and the rest are copied into runs.json through `??`, so a
	// wrong type here is either a throw in the watch tick or wrong persisted data.
	await withHarness(undefined, async (h) => {
		const raw = JSON.stringify({ version: 1, status: "failed", output: "x", error: 42, finishedAt: Date.now() });
		await assertUnusableResultFailsRun(h, raw, /error is not a string/);
	});
});

test("a result without a usable finishedAt fails the run", async () => {
	await withHarness(undefined, async (h) => {
		const raw = JSON.stringify({ version: 1, status: "completed", output: "x" });
		await assertUnusableResultFailsRun(h, raw, /finishedAt is missing or is not a finite number/);
	});
});

test("an unusable result from a child that already died reports both facts", async () => {
	// finalizeMissingChild has its own unusable-result branch: the child exited AND
	// its result cannot be read. Saying only one of those would hide the other.
	let harness: Harness | undefined;
	await withHarness(
		{
			paneDead: true,
			afterPaneDeadProbe: async () => {
				// The hook gets no arguments; the harness is captured above, and is set
				// before the launch that makes this probe possible.
				assert.ok(harness, "the harness must exist before the probe fires");
				const run = (await harness.readRuns())[0];
				await writeFile(run.resultPath, "{half", "utf8");
			},
		},
		async (h) => {
			harness = h;
			await h.call("subagent", { task: "dies with a bad result" });
			const failed = await waitForRunStatus(h, "failed", "a dead child with an unreadable result must fail");
			assert.match(failed.error ?? "", /exited before reporting a result/);
			assert.match(failed.error ?? "", /is unusable: result is not valid JSON/);
		},
	);
});

test("a cancel that lands while the watcher is settling it is not overwritten", async () => {
	// The tick that decides the run is dead awaits a tmux probe, and subagent_cancel
	// can land inside that await. Without the terminal guard in markRunFailed the
	// cancelled run is flipped back to failed and announced a second time.
	let harness: Harness | undefined;
	let runId: string | undefined;
	await withHarness(
		{
			paneDead: true,
			afterPaneDeadProbe: async () => {
				assert.ok(harness && runId, "the run must exist before the probe fires");
				await harness.call("subagent_cancel", { id: runId });
			},
		},
		async (h) => {
			harness = h;
			const run = (await h.call("subagent", { task: "cancelled mid-settle" })).details as unknown as RunRecord;
			runId = run.id;
			await waitForRunStatus(h, "cancelled", "the cancel must win");
			await new Promise((resolve) => setTimeout(resolve, 900));
			const settled = (await h.readRuns())[0];
			assert.equal(settled.status, "cancelled", "the watcher must not overwrite a cancel with a failure");
			assert.equal(settled.error, undefined);
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
