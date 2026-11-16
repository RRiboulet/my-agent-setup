// Behaviour pin for the `bg` tool's foundation: the job exists, it starts without
// blocking, and `status` can see it (ticket 01).
//
// Risk covered: everything later tickets build on. A `start` that quietly waits
// for the command, a job that is not detached (so `kill` cannot reach its
// process group), metadata that is written non-atomically, a watcher that stops
// observing, and a spawn failure that leaves a phantom `running` record are all
// silent failures in use — the tool would look fine and strand the work. Real
// detached shell processes are used throughout: pid liveness, process groups and
// exit codes are the behaviour under test, and a mock would only assert our
// beliefs about them.
//
// `logs` is declared but owned by ticket 03; `kill` is implemented, and
// bg-kill.test.ts pins its behaviour. This file pins only that the remaining
// placeholder answers cleanly and promptly — never its wording, which is not
// desired behaviour.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { signalProcessGroup, spawnBgJob } from "../../bg/spawn.ts";
import { jobDirFor, readJobMeta, writeJobMeta, type BgJobRecord } from "../../bg/store.ts";
import { createJobWatcher } from "../../bg/watch.ts";
import { BG_TEST_SESSION_ID, withBgHarness, type BgToolResult } from "./bg-harness.ts";
import { waitFor, withTempAgentDir } from "./helpers.ts";

/** Long enough that nothing about these tests can accidentally wait it out. */
const SLOW_COMMAND = "sleep 30";

function jobOf(result: BgToolResult): Record<string, unknown> {
	const job = result.details.job as Record<string, unknown> | undefined;
	assert.ok(job, `the result must carry the job: ${result.text}`);
	return job;
}

/** Local liveness check, so the process-group test does not depend on /proc. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("the tool registers deferred and inactive, so it costs no prompt tokens", async () => {
	await withBgHarness(async (h) => {
		const registration = h.registrations.find((entry) => entry.name === "bg");
		assert.ok(registration, "bg must be registered");
		assert.equal(registration.exposure, "deferred", "deferred is what tool_search can find and the prompt omits");
		assert.equal(registration.defaultActive, false, "it must not activate on registration");

		// The metadata is the claim; the declared set is the consequence. Both are
		// asserted, because a change that alters one and not the other has passed
		// this suite before.
		assert.ok(!h.declared().includes("bg"), `pi must not declare bg to the model: ${h.declared().join(", ")}`);
		const definition = h.tools.get("bg") as { description?: string; parameters?: unknown };
		assert.ok(definition.description, "the tool keeps a description for tool_search to rank on");
		assert.ok(definition.parameters, "the tool keeps its schema");
	});
});

test("start returns immediately with a job id and log path, and status reports it running", async () => {
	await withBgHarness(async (h) => {
		const startedAt = Date.now();
		const result = await h.call({ action: "start", command: SLOW_COMMAND });
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 2_000, `start must not wait on the command (took ${elapsed}ms)`);
		assert.doesNotMatch(result.text, /^Error:/, result.text);

		const job = jobOf(result);
		const id = job.id as string;
		assert.match(id, /^[0-9a-f]{8}$/, "a job id is eight hex characters");
		const logPath = job.logPath as string;
		assert.equal(logPath, path.join(h.jobDir(id), "output.log"), "the log lives in the job directory");
		assert.ok(existsSync(logPath), "the log file exists as soon as the job does");
		assert.equal(job.state, "running");
		const pid = job.pid as number;
		assert.equal(job.pgid, pid, "a detached job leads its own process group");
		assert.equal(result.text.includes(id), true, "the result names the job it started");

		// The two facts `kill` (ticket 04) will rely on: the pid is alive, and the
		// process group is addressable by the negative pid.
		process.kill(pid, 0);
		process.kill(-pid, 0);

		const status = await h.call({ action: "status", id });
		assert.equal(jobOf(status).state, "running", "status reports the job running straight after start");
		assert.equal(jobOf(status).exitCode, null, "a running job has no exit code");

		const listing = await h.call({ action: "status" });
		assert.match(listing.text, new RegExp(id), "the listing includes the job");
		assert.match(listing.text, /running/);
		assert.match(listing.text, /sleep 30/, "the listing shows the first line of the command");
	});
});

test("the watcher observes running -> exited and records the exit code on disk", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "sleep 0.2; exit 7" });
		const id = jobOf(start).id as string;
		assert.equal((await h.readJob(id)).state, "running", "it starts as a running job");

		const settled = await h.waitForJob(id, (job) => job.state === "exited");
		assert.equal(settled.exitCode, 7, "the exit code is the command's own");
		assert.ok(settled.finishedAt !== null && settled.finishedAt >= settled.startedAt, "the finish time is recorded");

		// Persisted, not merely held in memory: a second status reads the file.
		const status = await h.call({ action: "status", id });
		const job = jobOf(status);
		assert.equal(job.state, "exited");
		assert.equal(job.exitCode, 7);
		assert.match(status.text, /Exit: 7/);
	});
});

test("a job gets the session's cwd and the environment the bash tool exposes", async () => {
	const command = 'printf "cwd=%s\\nsession=%s\\nvar=%s\\n" "$PWD" "$PI_SESSION_ID" "$BG_TEST_VAR"';
	await withBgHarness(
		async (h) => {
			const start = await h.call({ action: "start", command });
			const id = jobOf(start).id as string;
			await h.waitForJob(id, (job) => job.state === "exited");

			const log = await h.readLog(id);
			assert.match(log, new RegExp(`cwd=${process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), log);
			assert.match(log, new RegExp(`session=${BG_TEST_SESSION_ID}`), "PI_SESSION_ID is the session's");
			assert.match(log, /var=bg-harness-value/, "the session's environment reaches the job");
		},
		{ env: { BG_TEST_VAR: "bg-harness-value" } },
	);
});

test("a command that cannot start is failed-to-start, never a phantom running job", async () => {
	const missingCwd = path.join(tmpdir(), "bg-test-no-such-directory");
	await withBgHarness(
		async (h) => {
			const result = await h.call({ action: "start", command: "echo hello" });
			assert.match(result.text, /^Error: /, result.text);
			const job = jobOf(result);
			const id = job.id as string;
			assert.equal(job.state, "failed-to-start");
			assert.equal(job.pid, null, "no process exists, so no pid is claimed");
			assert.match(String(job.error), /working directory does not exist/, "the reason names the real cause");

			const stored = await h.readJob(id);
			assert.equal(stored.state, "failed-to-start", "the failure is persisted, not only reported");
			assert.equal(stored.exitCode, null);

			// No half-written metadata: the record is whole and there is no temp file
			// left over from the atomic write.
			assert.deepEqual(await h.jobFiles(id), ["job.json"], "the job directory holds only a complete record");

			const status = await h.call({ action: "status", id });
			assert.equal(jobOf(status).state, "failed-to-start");
			assert.match(status.text, /failed-to-start/);

			const listing = await h.call({ action: "status" });
			const listed = listing.details.jobs as { state: string }[];
			assert.equal(listed.length, 1, "the failed job is listed");
			assert.equal(listed[0]?.state, "failed-to-start", "and it is not shown as running");
		},
		{ cwd: missingCwd },
	);
});

test("status explains a missing job instead of failing", async () => {
	await withBgHarness(async (h) => {
		const empty = await h.call({ action: "status" });
		assert.equal((empty.details.jobs as unknown[]).length, 0);
		assert.match(empty.text, /No background jobs/);

		const missing = await h.call({ action: "status", id: "deadbeef" });
		assert.match(missing.text, /^Error: /, missing.text);
		assert.match(String(missing.details.error), /no job deadbeef/);
	});
});

test("logs is declared but fails cleanly and promptly", async () => {
	await withBgHarness(async (h) => {
		for (const action of ["logs"] as const) {
			const startedAt = Date.now();
			const result = await h.call({ action, id: "deadbeef" });
			assert.ok(Date.now() - startedAt < 1_000, `${action} must not hang`);
			assert.match(result.text, /^Error: /, result.text);
			assert.equal(result.details.action, action);
			assert.match(String(result.details.error), /not implemented/i);
		}
	});
});

test("stop() ends the watcher: no tick runs after shutdown", async () => {
	await withTempAgentDir(async () => {
		const sessionId = "bg-watcher-stop-test";
		const dir = await mkdtemp(path.join(tmpdir(), "bg-watcher-log-"));
		const logPath = path.join(dir, "output.log");
		// A job that exits on its own a moment from now: if the watcher were still
		// polling, it would settle this record within a couple of 20ms ticks.
		const handle = await spawnBgJob({ command: "sleep 0.15", cwd: process.cwd(), logPath, env: process.env });
		const job: BgJobRecord = {
			id: "aaaa0001",
			sessionId,
			pid: handle.pid,
			pgid: handle.pid,
			command: "sleep 0.15",
			cwd: process.cwd(),
			logPath,
			state: "running",
			exitCode: null,
			startedAt: Date.now(),
			finishedAt: null,
		};
		await writeJobMeta(job);

		const settled: string[] = [];
		const watcher = createJobWatcher({ intervalMs: 20, onSettled: (settledJob) => void settled.push(settledJob.id) });
		try {
			watcher.watch(job, handle);
			assert.equal(watcher.isWatching(job.id), true);
			watcher.stop();
			assert.equal(watcher.isWatching(job.id), false, "stop() drops the watched set");

			// Well past the child's exit and several poll intervals.
			await new Promise((resolve) => setTimeout(resolve, 600));
			assert.deepEqual(settled, [], "no settle hook after stop");
			const stored = await readJobMeta(jobDirFor(sessionId, job.id));
			assert.ok(stored.ok);
			assert.equal(stored.job.state, "running", "the record was not settled by a stopped watcher");
		} finally {
			watcher.stop();
			signalProcessGroup(job.pid, "SIGKILL");
			await rm(dir, { recursive: true, force: true });
		}
	});
});

test("a job's process group dies with one signalling call", async () => {
	// The contract ticket 04 builds on: the pid IS the process group, so a
	// negative-pid signal reaches the whole tree. A grandchild proves the group
	// really is shared rather than the signal being delivered to one process.
	await withBgHarness(async (h) => {
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
		assert.ok(grandchild > 0, "the job reported its grandchild's pid");
		assert.equal(isAlive(grandchild), true, "the grandchild exists");

		assert.equal(signalProcessGroup(pid, "SIGKILL"), true, "the group accepted the signal");
		await waitFor(() => !isAlive(grandchild), 10_000);
	});
});
