// Session shutdown and reload: stopping every timer, persisting the index,
// and what survives an extension load.
//
// This is the timer-leak file. The watcher and the widget's ticker are
// fire-and-forget, so a timer that outlives `session_shutdown` keeps the event
// loop alive and keeps calling `pi.exec` — the shape that once needed
// `--test-force-exit`. The flag that stops it is closure state, so a fresh load
// must start with it clear.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { escalationDir, readEscalationHeartbeat, touchEscalationHeartbeat } from "../escalation.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { createHarness, withHarness, writeChildSession } from "./lifecycle-harness.ts";

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

test("session_shutdown clears escalation heartbeat even when pendingRequest is unset", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "escalation before pendingRequest" })).details as unknown as RunRecord;
		assert.equal(run.escalation, true);
		assert.equal(run.pendingRequest, undefined);

		const dir = escalationDir(run.runDir);
		await touchEscalationHeartbeat(dir);
		assert.ok(await readEscalationHeartbeat(dir), "heartbeat exists before shutdown");

		await h.shutdown();
		assert.equal(
			await readEscalationHeartbeat(dir),
			undefined,
			"shutdown must clear escalation heartbeat even if pendingRequest was not yet set",
		);
	});
});
