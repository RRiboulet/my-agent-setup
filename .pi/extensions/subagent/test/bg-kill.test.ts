// Behaviour pin for `bg kill` (ticket 04): a job's process GROUP is stopped,
// SIGTERM first and SIGKILL after the grace, and the record says `killed`.
//
// Risk covered: the kill half of the tool, where a mistake is invisible until it
// matters. A kill that signals the pid and not the group leaves the command's
// children running under a dead shell (the poll watcher then reports the job
// finished while `sleep`, a build, or a server still holds the CPU). A kill that
// gives up at SIGTERM never stops the processes that ignore it — a trap, a shell
// blocked in a read. A kill that lets the watcher settle the job afterwards
// records `exited`, losing the only fact the caller asked for. And a kill of a
// job that is already done must not be an error, because "kill it again" is the
// natural thing to do after a race.
//
// Real detached shell processes throughout: pid liveness, process groups, the
// five-second grace and a grandchild's death are the behaviour under test, and a
// mock would only assert our beliefs about them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_KILL_GRACE_MS } from "../../bg/spawn.ts";
import { BG_POLL_INTERVAL_MS } from "../../bg/watch.ts";
import { withBgHarness, type BgToolResult } from "./bg-harness.ts";
import { waitFor } from "./helpers.ts";

/** Long enough that nothing here can accidentally wait a job out. */
const SLOW_COMMAND = "sleep 30";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Whether the process group led by `pid` still has members. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function jobOf(result: BgToolResult): Record<string, unknown> {
	const job = result.details.job as Record<string, unknown> | undefined;
	assert.ok(job, `the result must carry the job: ${result.text}`);
	return job;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("kill stops a running job's process group and records killed, not exited", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: SLOW_COMMAND });
		const job = jobOf(start);
		const id = job.id as string;
		const pid = job.pid as number;
		assert.equal(isAlive(pid), true, "the job is running before the kill");

		const startedAt = Date.now();
		const result = await h.call({ action: "kill", id });
		const elapsed = Date.now() - startedAt;
		assert.doesNotMatch(result.text, /^Error:/, result.text);
		assert.equal(result.details.action, "kill");
		assert.equal(result.details.killed, true);
		assert.equal(result.details.alreadyFinished, false);
		assert.equal(result.details.escalated, false, "a plain `sleep` takes SIGTERM");
		assert.match(result.text, /Killed/);
		assert.match(result.text, new RegExp(id));

		// "Gone within the grace period", not "gone after it": the common case must
		// not sit out the five seconds.
		assert.ok(elapsed < BG_KILL_GRACE_MS, `kill took ${elapsed}ms, which is not a grace-period kill`);
		assert.equal(isAlive(pid), false, "the direct pid is gone");
		assert.equal(groupAlive(pid), false, "the whole process group is gone, not just the leader");

		const stored = await h.readJob(id);
		assert.equal(stored.state, "killed", "killed is the recorded state");
		assert.equal(stored.exitCode, null, "a signal death has no exit code to claim");
		assert.ok(stored.finishedAt !== null && stored.finishedAt >= stored.startedAt, "the finish time is recorded");

		// The watcher holds its own copy of the record and would settle it as
		// `exited` on its next tick if the kill had not taken the job away from it.
		// Several ticks is far longer than that would take.
		await sleep(BG_POLL_INTERVAL_MS * 3);
		assert.equal((await h.readJob(id)).state, "killed", "the watcher must not rewrite killed as exited");

		const status = await h.call({ action: "status", id });
		assert.equal(jobOf(status).state, "killed");
		assert.match(status.text, /killed/);
	});
});

test("a grandchild dies with its job: the kill reaches the process group", async () => {
	await withBgHarness(async (h) => {
		// The shell reports the pid of the `sleep` it forked, so the test can watch a
		// process that is NOT the job's own pid die.
		const start = await h.call({ action: "start", command: "sleep 30 & echo $!; wait" });
		const job = jobOf(start);
		const id = job.id as string;
		const pid = job.pid as number;

		let grandchild = 0;
		await waitFor(async () => {
			const match = /(\d+)/.exec(await h.readLog(id));
			if (!match) return false;
			grandchild = Number(match[1]);
			return grandchild > 0;
		});
		assert.notEqual(grandchild, pid, "the reported pid is the child's, not the job's own");
		assert.equal(isAlive(grandchild), true, "the grandchild exists and outlives nothing yet");

		const result = await h.call({ action: "kill", id });
		assert.equal(result.details.killed, true, result.text);

		await waitFor(() => !isAlive(grandchild), 10_000);
		assert.equal(isAlive(pid), false, "the job's own process is gone");
		assert.equal((await h.readJob(id)).state, "killed");
	});
});

test("a shell that ignores SIGTERM is still gone after the SIGKILL grace", async () => {
	await withBgHarness(async (h) => {
		// `trap '' TERM` makes the shell ignore SIGTERM, and the disposition is
		// inherited by the `sleep` it runs: only the escalation can end this.
		const start = await h.call({ action: "start", command: "trap '' TERM; sleep 30" });
		const job = jobOf(start);
		const id = job.id as string;
		const pid = job.pid as number;

		const startedAt = Date.now();
		const result = await h.call({ action: "kill", id });
		const elapsed = Date.now() - startedAt;

		assert.doesNotMatch(result.text, /^Error:/, result.text);
		assert.equal(result.details.killed, true);
		assert.equal(result.details.escalated, true, "the result must say SIGKILL was needed");
		assert.match(result.text, /SIGKILL/);

		// It survived SIGTERM, so the kill cannot have finished before the grace,
		// and it cannot hang on the trapped process either.
		assert.ok(elapsed >= BG_KILL_GRACE_MS, `escalated at ${elapsed}ms, before the grace elapsed`);
		assert.ok(elapsed < BG_KILL_GRACE_MS + 5_000, `kill took ${elapsed}ms, which is not a bounded escalation`);
		assert.equal(isAlive(pid), false, "SIGKILL cannot be trapped");
		assert.equal(groupAlive(pid), false);

		const stored = await h.readJob(id);
		assert.equal(stored.state, "killed");
		assert.equal(stored.exitCode, null);
	});
});

test("killing a finished job is a no-op with a message, not an error, and changes nothing", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "exit 3" });
		const id = jobOf(start).id as string;
		const settled = await h.waitForJob(id, (job) => job.state === "exited");
		assert.equal(settled.exitCode, 3);

		const result = await h.call({ action: "kill", id });
		assert.doesNotMatch(result.text, /^Error:/, `a finished job is a no-op, not a failure: ${result.text}`);
		assert.match(result.text, /already exited \(exit 3\)/);
		assert.match(result.text, /nothing to kill/i);
		assert.equal(result.details.killed, false);
		assert.equal(result.details.alreadyFinished, true);
		assert.equal(result.details.state, "exited");

		// Not rewritten: the exit code and finish time a no-op has no business
		// touching are the same ones the watcher recorded.
		await sleep(BG_POLL_INTERVAL_MS * 2);
		const stored = await h.readJob(id);
		assert.equal(stored.state, "exited", "the no-op did not relabel the job as killed");
		assert.equal(stored.exitCode, 3);
		assert.equal(stored.finishedAt, settled.finishedAt);
	});
});

test("killing twice in a row is safe", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: SLOW_COMMAND });
		const id = jobOf(start).id as string;

		const first = await h.call({ action: "kill", id });
		assert.equal(first.details.killed, true, first.text);
		const killed = await h.readJob(id);
		assert.equal(killed.state, "killed");

		const second = await h.call({ action: "kill", id });
		assert.doesNotMatch(second.text, /^Error:/, `the second kill must be a no-op: ${second.text}`);
		assert.match(second.text, /already killed/);
		assert.match(second.text, /nothing to kill/i);
		assert.equal(second.details.killed, false);
		assert.equal(second.details.state, "killed");

		const again = await h.readJob(id);
		assert.equal(again.state, "killed", "still killed");
		assert.equal(again.finishedAt, killed.finishedAt, "the no-op did not re-time the job");
	});
});

test("kill explains a missing job, and a missing id, instead of failing", async () => {
	await withBgHarness(async (h) => {
		const missing = await h.call({ action: "kill", id: "deadbeef" });
		assert.match(missing.text, /^Error: /, missing.text);
		assert.match(String(missing.details.error), /no job deadbeef/);

		const noId = await h.call({ action: "kill" });
		assert.match(noId.text, /^Error: /, noId.text);
		assert.match(String(noId.details.error), /id required/);
	});
});
