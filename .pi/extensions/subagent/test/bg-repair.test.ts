// Behaviour pins for session-start repair (ticket 06).
//
// Risk covered: the state a session inherits from a session that ended — or from
// a container that was rebuilt mid-job. Three failures are silent in use and all
// three are tested here:
//
//   - a record that claims `running` after its process is gone, which makes the
//     job look alive forever and `status` lie;
//   - a record whose process IS alive but which nobody watches, so the work
//     finishes and the completion is never reported (the adoption path);
//   - job directories that are never removed, which grow the agent directory
//     without bound.
//
// Two rules from the ticket shape the tests: a dead pid is a RECORDED one (we
// spawn a real process, let it be reaped, and keep its pid, rather than inventing
// an unused number), and the live case is a REAL detached process, because pid
// liveness is the fact under test and a mock would only restate our beliefs.
//
// The last test boots the real extension factory and fires `session_start`, which
// is the only way to see the call in index.ts — the module tests above would pass
// with nothing wired into the session at all.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import bgExtension from "../../bg/index.ts";
import { BG_JOB_RETENTION_MS, repairSession } from "../../bg/repair.ts";
import { signalProcessGroup, spawnBgJob } from "../../bg/spawn.ts";
import {
	jobDirFor,
	logPathFor,
	readJobMeta,
	sessionJobsDir,
	writeJobMeta,
	type BgJobRecord,
} from "../../bg/store.ts";
import { createJobWatcher } from "../../bg/watch.ts";
import { waitFor, withTempAgentDir } from "./helpers.ts";

const DEAD_PID_SESSION = "bg-repair-dead-pid";
const ADOPT_SESSION = "bg-repair-adopt";
const PRUNE_SESSION = "bg-repair-prune";
const CORRUPT_SESSION = "bg-repair-corrupt";
const IDEMPOTENT_SESSION = "bg-repair-idempotent";
const SESSION_START_SESSION = "bg-repair-session-start";

/**
 * A pid that named a real process and does not name one any more: the child is
 * spawned, exited and reaped synchronously, so its number is free again.
 */
function recordedDeadPid(): number {
	const result = spawnSync(process.execPath, ["-e", "0"]);
	assert.equal(result.status, 0, result.stderr?.toString());
	assert.equal(typeof result.pid, "number");
	const pid = result.pid as number;
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "the pid must be genuinely free before the record claims it");
	return pid;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function record(sessionId: string, overrides: Partial<BgJobRecord> & { id: string }): BgJobRecord {
	const id = overrides.id;
	return {
		id,
		sessionId,
		pid: null,
		pgid: null,
		command: "sleep 30",
		cwd: process.cwd(),
		logPath: logPathFor(sessionId, id),
		state: "running",
		exitCode: null,
		startedAt: Date.now(),
		finishedAt: null,
		...overrides,
	};
}

/** Write a job directory's `job.json` by hand, the way a crash or a bug would leave it. */
async function writeRawMeta(dir: string, raw: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(path.join(dir, "job.json"), raw, "utf8");
}

test("a record claiming a dead pid is repaired to exited, with an unknown exit code", async () => {
	await withTempAgentDir(async () => {
		const pid = recordedDeadPid();
		const job = record(DEAD_PID_SESSION, {
			id: "dead0001",
			pid,
			pgid: pid,
			startedAt: Date.now() - 60_000,
		});
		await writeJobMeta(job);

		const watcher = createJobWatcher({ intervalMs: 20 });
		try {
			const result = await repairSession({ sessionId: DEAD_PID_SESSION, watcher });

			assert.deepEqual(result.repaired.map((entry) => entry.id), [job.id], "the stale record is reported as repaired");
			assert.deepEqual(result.adopted, [], "a dead job is not adopted");
			assert.deepEqual(result.pruned, [], "nothing is old enough to prune");
			assert.deepEqual(result.problems, []);

			const stored = await readJobMeta(jobDirFor(DEAD_PID_SESSION, job.id));
			assert.ok(stored.ok, "the repaired record must still be readable");
			assert.equal(stored.job.state, "exited", "a running record with no process is exited");
			assert.equal(stored.job.exitCode, null, "the exit code is unknown, and null says so — never 0");
			assert.ok(
				typeof stored.job.finishedAt === "number" && stored.job.finishedAt >= job.startedAt,
				"the record is settled: a finish time was written",
			);
			assert.equal(watcher.isWatching(job.id), false, "there is no process left to watch");
		} finally {
			watcher.stop();
		}
	});
});

test("a live job is adopted and its completion still notifies", async () => {
	await withTempAgentDir(async () => {
		const logPath = logPathFor(ADOPT_SESSION, "addy0001");
		// The job directory exists before the process does: `spawnBgJob` opens the log
		// inside it, exactly as `start` would after `createJobDir`.
		await mkdir(jobDirFor(ADOPT_SESSION, "addy0001"), { recursive: true, mode: 0o700 });
		// A real detached process, still running when repair sees it.
		const handle = await spawnBgJob({
			command: "sleep 0.4; exit 3",
			cwd: process.cwd(),
			logPath,
			env: process.env,
		});
		const job = record(ADOPT_SESSION, {
			id: "addy0001",
			pid: handle.pid,
			pgid: handle.pid,
			command: "sleep 0.4; exit 3",
		});
		await writeJobMeta(job);
		assert.equal(isAlive(handle.pid), true, "the job is alive before repair runs");

		// The settle hook is the notification seam: item 05's coalescing message is
		// attached to exactly this callback, so "the completion still notifies" is
		// observable here without a terminal.
		const settled: BgJobRecord[] = [];
		const watcher = createJobWatcher({ intervalMs: 25, onSettled: (settledJob) => void settled.push(settledJob) });
		try {
			// Retention 0 puts every directory past the window, which is what proves a
			// live job is never pruned: its record and log are the only handle on it.
			const result = await repairSession({ sessionId: ADOPT_SESSION, watcher, retentionMs: 0 });
			assert.deepEqual(result.adopted.map((entry) => entry.id), [job.id], "the live job is adopted");
			assert.deepEqual(result.repaired, [], "a live job is not repaired");
			assert.deepEqual(result.pruned, [], "a live job's directory is never pruned, however old");
			assert.equal(watcher.isWatching(job.id), true, "adoption means the watcher holds the record");
			assert.ok(existsSync(jobDirFor(ADOPT_SESSION, job.id)), "the adopted job's directory survives the prune pass");

			await waitFor(() => settled.length > 0, 20_000);
			assert.equal(settled.length, 1, "the adopted job settles once");
			const notified = settled[0] as BgJobRecord;
			assert.equal(notified.id, job.id);
			assert.equal(notified.state, "exited");
			assert.equal(notified.exitCode, null, "no process here reaped that child, so the code is unknown");

			const stored = await readJobMeta(jobDirFor(ADOPT_SESSION, job.id));
			assert.ok(stored.ok);
			assert.equal(stored.job.state, "exited", "the settle is persisted, not only handed to the hook");
			assert.equal(stored.job.exitCode, null);
			assert.equal(await readFile(logPath, "utf8"), "", "the job ran to completion: it wrote nothing, but it ran");
		} finally {
			watcher.stop();
			signalProcessGroup(handle.pid, "SIGKILL");
		}
	});
});

test("job directories past the retention window are removed and younger ones are kept", async () => {
	await withTempAgentDir(async () => {
		assert.equal(BG_JOB_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, "one week, by decision — a constant, not a setting");
		const hour = 60 * 60 * 1000;
		const old = record(PRUNE_SESSION, {
			id: "old00001",
			state: "exited",
			exitCode: 0,
			startedAt: Date.now() - 8 * 24 * hour,
			finishedAt: Date.now() - 7 * 24 * hour - hour,
		});
		const young = record(PRUNE_SESSION, {
			id: "young001",
			state: "exited",
			exitCode: 0,
			startedAt: Date.now() - 2 * hour,
			finishedAt: Date.now() - hour,
		});
		await writeJobMeta(old);
		await writeJobMeta(young);
		await writeFile(old.logPath, "old job output\n", "utf8");
		await writeFile(young.logPath, "young job output\n", "utf8");

		const watcher = createJobWatcher({ intervalMs: 20 });
		try {
			const result = await repairSession({ sessionId: PRUNE_SESSION, watcher });
			assert.deepEqual(result.pruned, [jobDirFor(PRUNE_SESSION, old.id)], "only the expired directory is removed");
			assert.ok(!existsSync(jobDirFor(PRUNE_SESSION, old.id)), "the expired directory is gone");
			assert.ok(!existsSync(old.logPath), "and its log went with it");
			assert.ok(existsSync(jobDirFor(PRUNE_SESSION, young.id)), "the younger directory is kept");
			assert.ok(existsSync(young.logPath), "and so is its log");
			// Pruning is about age, not state: neither job was `running`, so repair
			// had nothing to do and said so.
			assert.deepEqual(result.repaired, []);
			assert.deepEqual(result.problems, []);
		} finally {
			watcher.stop();
		}
	});
});

test("repair never throws on a corrupt or half-written metadata file", async () => {
	await withTempAgentDir(async () => {
		const truncated = jobDirFor(CORRUPT_SESSION, "corrupt1");
		const wrongShape = jobDirFor(CORRUPT_SESSION, "corrupt2");
		const empty = jobDirFor(CORRUPT_SESSION, "corrupt3");
		const noMeta = jobDirFor(CORRUPT_SESSION, "corrupt4");
		// A record cut off mid-write, a record that is valid JSON of the wrong shape,
		// an empty file, and a directory whose metadata never landed.
		await writeRawMeta(truncated, '{"id":"corrupt1","sessionId":"bg-repair-corrupt","sta');
		await writeRawMeta(wrongShape, '{"id":5}\n');
		await writeRawMeta(empty, "");
		await mkdir(noMeta, { recursive: true });
		// A healthy-but-dead record in the same pass: the corrupt files must not stop
		// the repair of everything after them.
		const pid = recordedDeadPid();
		const dead = record(CORRUPT_SESSION, { id: "dead0002", pid, pgid: pid, startedAt: Date.now() - 60_000 });
		await writeJobMeta(dead);

		const watcher = createJobWatcher({ intervalMs: 20 });
		try {
			const result = await repairSession({ sessionId: CORRUPT_SESSION, watcher });

			assert.deepEqual(result.repaired.map((entry) => entry.id), [dead.id], "the readable record is still repaired");
			assert.equal(result.problems.length, 4, `every corrupt directory is reported: ${JSON.stringify(result.problems)}`);
			const reported = result.problems.map((problem) => path.basename(problem.dir)).sort();
			assert.deepEqual(reported, ["corrupt1", "corrupt2", "corrupt3", "corrupt4"]);
			assert.match(result.problems[0]?.error ?? "", /^(invalid|missing|unreadable): /, "each problem says why");

			// Reported, not deleted: a young unreadable directory is left alone, so a
			// human can still look at it.
			for (const dir of [truncated, wrongShape, empty, noMeta]) {
				assert.ok(existsSync(dir), `${dir} is kept`);
			}
			assert.match(await readFile(path.join(truncated, "job.json"), "utf8"), /"sta$/, "the half-written file is untouched");
		} finally {
			watcher.stop();
		}
	});
});

test("an expired directory whose metadata is unreadable is pruned rather than kept forever", async () => {
	await withTempAgentDir(async () => {
		const stale = jobDirFor(CORRUPT_SESSION, "corrupt5");
		const young = jobDirFor(CORRUPT_SESSION, "corrupt6");
		await writeRawMeta(stale, "not json at all");
		await writeRawMeta(young, "not json at all");
		// No record to age these by, so the directory's own mtime decides.
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		await utimes(stale, old, old);

		const watcher = createJobWatcher({ intervalMs: 20 });
		try {
			const result = await repairSession({ sessionId: CORRUPT_SESSION, watcher });
			assert.deepEqual(result.pruned, [stale], "the expired unreadable directory is removed");
			assert.ok(existsSync(young), "the young unreadable one is kept and reported");
			assert.deepEqual(
				result.problems.map((problem) => path.basename(problem.dir)).sort(),
				["corrupt5", "corrupt6"],
				"both were reported as unreadable, including the one that was then removed",
			);
		} finally {
			watcher.stop();
		}
	});
});

test("repair is idempotent: a second pass changes nothing", async () => {
	await withTempAgentDir(async () => {
		const pid = recordedDeadPid();
		const dead = record(IDEMPOTENT_SESSION, { id: "idem0001", pid, pgid: pid, startedAt: Date.now() - 60_000 });
		await writeJobMeta(dead);
		const expired = record(IDEMPOTENT_SESSION, {
			id: "idem0002",
			state: "exited",
			exitCode: 0,
			startedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
			finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
		});
		await writeJobMeta(expired);
		const corruptDir = jobDirFor(IDEMPOTENT_SESSION, "idem0003");
		await writeRawMeta(corruptDir, '{"id":"idem0003"');

		const watcher = createJobWatcher({ intervalMs: 20 });
		try {
			const first = await repairSession({ sessionId: IDEMPOTENT_SESSION, watcher });
			assert.deepEqual(first.repaired.map((entry) => entry.id), [dead.id]);
			assert.deepEqual(first.pruned, [jobDirFor(IDEMPOTENT_SESSION, expired.id)]);
			assert.equal(first.problems.length, 1);

			const repairedPath = path.join(jobDirFor(IDEMPOTENT_SESSION, dead.id), "job.json");
			const before = await stat(repairedPath);
			const beforeBody = await readFile(repairedPath, "utf8");
			const corruptBody = await readFile(path.join(corruptDir, "job.json"), "utf8");

			const second = await repairSession({ sessionId: IDEMPOTENT_SESSION, watcher });
			assert.deepEqual(second.repaired, [], "nothing left to repair");
			assert.deepEqual(second.adopted, [], "nothing left to adopt");
			assert.deepEqual(second.pruned, [], "nothing left to prune");
			assert.equal(second.problems.length, 1, "the corrupt record is still reported — reporting is not a change");

			// Not merely "the same values": the files were not rewritten at all.
			const after = await stat(repairedPath);
			assert.equal(after.mtimeMs, before.mtimeMs, "the settled record is not rewritten on a second pass");
			assert.equal(await readFile(repairedPath, "utf8"), beforeBody, "and its contents are unchanged");
			assert.equal(
				await readFile(path.join(corruptDir, "job.json"), "utf8"),
				corruptBody,
				"the corrupt record is left exactly as it was found",
			);
		} finally {
			watcher.stop();
		}
	});
});

/** Boot the real extension factory, with the handlers `session_start`/`shutdown` live in. */
function bootFactory(sessionId: string) {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const messages: Record<string, unknown>[] = [];
	const pi = {
		registerTool: (tool: Record<string, unknown>) => void tools.set(String(tool.name), tool),
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		sendMessage: (message: Record<string, unknown>) => void messages.push(message),
		getActiveTools: () => [],
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: false,
		isProjectTrusted: () => true,
		isIdle: () => true,
		signal: undefined,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getBranch: () => [],
		},
		ui: { notify: () => undefined, setStatus: () => undefined },
		shutdown: () => undefined,
	};
	bgExtension(pi as never);
	return { tools, handlers, messages, ctx };
}

test("session start repairs this session's state before the tool is ever used", async () => {
	await withTempAgentDir(async () => {
		// Seed the agent directory the way a previous session would have left it,
		// then start a session: only the call in index.ts can settle these.
		const pid = recordedDeadPid();
		const dead = record(SESSION_START_SESSION, { id: "start001", pid, pgid: pid, startedAt: Date.now() - 120_000 });
		await writeJobMeta(dead);
		const corruptDir = jobDirFor(SESSION_START_SESSION, "start002");
		await writeRawMeta(corruptDir, '{"id":"start002",');
		assert.equal((await readJobMeta(jobDirFor(SESSION_START_SESSION, dead.id))).ok, true);

		const boot = bootFactory(SESSION_START_SESSION);
		try {
			const handler = boot.handlers.get("session_start");
			assert.ok(handler, "the extension registers a session_start handler");
			// Must resolve: a corrupt sibling record cannot stop a session starting.
			await handler({}, boot.ctx);

			const stored = await readJobMeta(jobDirFor(SESSION_START_SESSION, dead.id));
			assert.ok(stored.ok);
			assert.equal(stored.job.state, "exited", "session start settled the record claiming a dead pid");
			assert.equal(stored.job.exitCode, null);
			assert.match(
				await readFile(path.join(corruptDir, "job.json"), "utf8"),
				/"start002",$/,
				"the corrupt record was reported and left alone",
			);

			// Read back through the tool, which is what the model would see: unknown,
			// and specifically not a zero exit code.
			const execute = boot.tools.get("bg")?.execute as (
				id: string,
				params: Record<string, unknown>,
				signal: unknown,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise<{ content: { text?: string }[] }>;
			assert.ok(execute, "the tool is registered");
			const status = await execute("call", { action: "status", id: dead.id }, undefined, undefined, boot.ctx);
			const text = status.content[0]?.text ?? "";
			assert.match(text, /state: exited|exited/, text);
			assert.match(text, /unknown — no exit status was observed/, "an adopted-and-repaired job reports an unknown code");
			assert.doesNotMatch(text, /Exit: 0\b/, "and never claims zero");
			assert.ok(sessionJobsDir(SESSION_START_SESSION).length > 0);
			assert.deepEqual(boot.messages, [], "repair itself sends no message: notification is ticket 05's job");
		} finally {
			await boot.handlers.get("session_shutdown")?.({}, boot.ctx);
		}
	});
});
