// bg/repair.ts — what a session start does about state it did not observe.
//
// A session inherits job directories it did not create: its own from an earlier
// run of the same session, and every earlier session's under the same agent
// directory. Trust none of it, and check it in one pass:
//
//   - A record that claims `running` whose pid is gone was left behind by a
//     session that ended (or a container that was rebuilt). It is settled to
//     `exited` on disk. The exit code stays null — no process here reaped that
//     child, so there is no status to report; null means unknown, never zero.
//     `finishedAt` is the repair time, which is the last moment the job is known
//     to have been alive, not an observed exit.
//   - A record whose pid is still alive is adopted: handed to the watcher with no
//     process handle, exactly as `watch.ts` documents. It then follows the same
//     poll → settle → settle-hook path as a job started in this process, which is
//     why an adopted job's completion still notifies (the hook is the
//     notification seam) even though its exit code is unknown.
//   - Job directories older than `BG_JOB_RETENTION_MS` are removed, across every
//     session rather than only this one: a session pruned only its own directory
//     and then ended would leave that directory to be pruned by nobody. A live
//     job is never removed however old it is — its record and log are the only
//     way to find it again.
//
// Nothing here throws. A half-written, truncated or otherwise unreadable
// `job.json` is a value (`readJobMeta`'s whole design), so it is reported in
// `problems` and skipped: the rest of the repair still happens, and the next
// session start reports it again rather than failing.
//
// Retention is a constant, not a setting (the spec's "one cap, not a corpus"):
// one week is long enough that a job from before a weekend or a container rebuild
// is still there, and short enough that the agent directory is bounded by the
// jobs of the last week rather than by everything ever run. Logs are capped
// separately, so a week of them is bounded too.

import { readdir, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { isProcessAlive } from "./spawn.ts";
import {
	bgRootDir,
	jobDirFor,
	listJobs,
	readJobMeta,
	sessionJobsDir,
	writeJobMeta,
	type BgJobProblem,
	type BgJobRecord,
} from "./store.ts";
import type { BgJobWatcher } from "./watch.ts";

/** How long a finished job's directory is kept. One week; see the file header. */
export const BG_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface BgRepairOptions {
	/** The session being started. Only its own records are repaired or adopted. */
	sessionId: string;
	/**
	 * The session's watcher. Adoption goes through `watch(record)`, so the settle
	 * hook — and therefore completion notification — is the one the session
	 * already uses. Narrowed to what repair needs, so a test can pass a stub.
	 */
	watcher: Pick<BgJobWatcher, "watch" | "isWatching">;
	/** Override for `Date.now`, for a test that wants to age a record without waiting. */
	now?: () => number;
	/** Override for `BG_JOB_RETENTION_MS`. */
	retentionMs?: number;
}

/** What one repair pass did. Every list holds the records/directories it touched. */
export interface BgRepairResult {
	/** Records that claimed a running process which was gone; now `exited`. */
	repaired: BgJobRecord[];
	/** Live jobs handed to the watcher. */
	adopted: BgJobRecord[];
	/** Job directories removed, as absolute paths, sorted. */
	pruned: string[];
	/** Metadata that could not be read or trusted, or a directory/filesystem step that failed. */
	problems: BgJobProblem[];
}

/**
 * Bring this session's job state in line with what is actually running, and drop
 * directories past the retention window.
 *
 * Order matters: pruning runs first, so repair never adopts a job whose directory
 * it is about to delete. Both passes are idempotent — a second call after the
 * first finds nothing to repair (the records are no longer `running`), nothing to
 * adopt (the watcher already holds them) and nothing to prune — so a re-delivered
 * `session_start` is harmless.
 */
export async function repairSession(options: BgRepairOptions): Promise<BgRepairResult> {
	const now = options.now ?? Date.now;
	const retentionMs = options.retentionMs ?? BG_JOB_RETENTION_MS;
	const result: BgRepairResult = { repaired: [], adopted: [], pruned: [], problems: [] };

	await pruneExpiredJobs(result, now, retentionMs);
	await adoptOrRepairSessionJobs(options, result, now);
	// Both passes read the same directories, so an unreadable record is seen twice.
	// One entry per directory: the problem is the directory, not the pass that
	// noticed it.
	const seen = new Set<string>();
	result.problems = result.problems.filter((problem) => {
		if (seen.has(problem.dir)) return false;
		seen.add(problem.dir);
		return true;
	});
	return result;
}

async function pruneExpiredJobs(result: BgRepairResult, now: () => number, retentionMs: number): Promise<void> {
	const root = bgRootDir();
	let sessionDirs: string[];
	try {
		const entries = await readdir(root, { withFileTypes: true });
		sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch (error) {
		// No job has ever run under this agent dir. Not a problem.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		result.problems.push({ dir: root, error: `unreadable: ${describe(error)}` });
		return;
	}

	for (const sessionName of sessionDirs) {
		const sessionDir = path.join(root, sessionName);
		let jobNames: string[];
		try {
			const entries = await readdir(sessionDir, { withFileTypes: true });
			jobNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		} catch (error) {
			// Vanished between the two readdirs, or unreadable: report the latter.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			result.problems.push({ dir: sessionDir, error: `unreadable: ${describe(error)}` });
			continue;
		}

		for (const jobName of jobNames) {
			const jobDir = path.join(sessionDir, jobName);
			// Read once: the record decides both how old the job is and whether a
			// process still owns it. Unreadable metadata is a value, so this cannot
			// throw; it is reported and the directory judged by its own mtime.
			const read = await readJobMeta(jobDir);
			if (!read.ok) result.problems.push({ dir: jobDir, error: `${read.reason}: ${read.error}` });

			const lastTouched = read.ok
				? (read.job.finishedAt ?? read.job.startedAt)
				: (await directoryMtimeMs(jobDir, result));
			if (lastTouched === undefined) continue;
			const age = now() - lastTouched;
			// A negative age is a clock that moved backwards; keeping the directory
			// is the safe side of that.
			if (age <= retentionMs) continue;

			// However old it is, a directory whose job still has a live process is
			// the only handle on that job. Removing it would strand the process.
			if (read.ok && read.job.state === "running" && isProcessAlive(read.job.pid)) continue;

			try {
				await rm(jobDir, { recursive: true, force: true });
				result.pruned.push(jobDir);
			} catch (error) {
				result.problems.push({ dir: jobDir, error: `could not remove: ${describe(error)}` });
			}
		}
	}
	result.pruned.sort();
}

async function directoryMtimeMs(jobDir: string, result: BgRepairResult): Promise<number | undefined> {
	try {
		return (await stat(jobDir)).mtimeMs;
	} catch (error) {
		// Gone between the readdir and here: nothing to prune. Anything else is worth
		// reporting, but the directory cannot be judged without a timestamp.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			result.problems.push({ dir: jobDir, error: `unreadable: ${describe(error)}` });
		}
		return undefined;
	}
}

async function adoptOrRepairSessionJobs(options: BgRepairOptions, result: BgRepairResult, now: () => number): Promise<void> {
	const { sessionId, watcher } = options;
	let listed: Awaited<ReturnType<typeof listJobs>>;
	try {
		listed = await listJobs(sessionId);
	} catch (error) {
		// `listJobs` only throws for something other than a missing directory, so
		// this is a real filesystem fault. Report it; the session still starts.
		result.problems.push({ dir: sessionJobsDir(sessionId), error: `unreadable: ${describe(error)}` });
		return;
	}
	// Corrupt records, as opposed to dead pids: report, keep, move on. The next
	// session start sees them again, which is the point of not deleting them.
	result.problems.push(...listed.problems);

	for (const job of listed.jobs) {
		if (job.state !== "running") continue;

		if (isProcessAlive(job.pid)) {
			// Adopted, not restarted: no handle exists, so the pid is the only
			// liveness fact and the exit code stays unknown. `isWatching` keeps a
			// second repair pass (or a re-delivered session_start) from reporting the
			// same adoption twice — `watch` would ignore it anyway.
			if (watcher.isWatching(job.id)) continue;
			watcher.watch(job);
			result.adopted.push(job);
			continue;
		}

		// The process is gone. `sessionId` comes from the directory the record was
		// read out of, so the correction lands where the stale record lives even if
		// the file's own `sessionId` disagrees with its directory.
		const repaired: BgJobRecord = {
			...job,
			sessionId,
			state: "exited",
			// Unknown, not zero: no process in this session reaped the child.
			exitCode: null,
			finishedAt: now(),
		};
		try {
			await writeJobMeta(repaired);
			result.repaired.push(repaired);
		} catch (error) {
			result.problems.push({
				dir: jobDirFor(sessionId, job.id),
				error: `could not repair: ${describe(error)}`,
			});
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
