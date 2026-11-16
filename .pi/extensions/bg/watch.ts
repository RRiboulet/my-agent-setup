// bg/watch.ts — the poll watcher that observes job records.
//
// Watch by poll, not by the child's `exit` event, for one reason: a job adopted
// after a restart has no handle and no event, so it must follow exactly the same
// state machine as one started in this process. One timer, one tick, one
// question per job: is this pid still alive? When it is not, the record is
// settled (state, exit code, finish time), persisted, and handed to the settle
// hook — which is the one seam ticket 05's coalesced notifications attach to.
//
// The watcher takes RECORDS, not pids, and is given a process handle only when
// the job was started here. That is what lets ticket 06 adopt a live job from a
// previous session with `watch(record)` alone, and it is why the exit code is
// null for such a job: this process never reaped that child.
//
// The same tick also bounds the job's log: `enforceLogCap` (logs.ts) truncates
// from the front once the file is past its cap, and is a `stat` otherwise. It
// runs here rather than in a timer of its own for the same reason the liveness
// check does — one beat, one per-job question — and it is idempotent, so a tick
// that finds a log it has already capped changes nothing.
//
// Shutdown: `stop()` clears the timer and sets a flag the tick checks before it
// re-arms. The suite depends on it — a live timer keeps node's event loop alive,
// so a watcher that re-armed after `session_shutdown` would hang the run until
// the test runner's timeout instead of exiting.

import { enforceLogCap } from "./logs.ts";
import { isProcessAlive, type BgProcessHandle } from "./spawn.ts";
import { writeJobMeta, type BgJobRecord } from "./store.ts";

/** How often a watched job's process is checked. Same 500ms beat as the subagent watcher. */
export const BG_POLL_INTERVAL_MS = 500;

/**
 * Called once per job, after the settled record has been persisted.
 *
 * Deliberately one call per job rather than one per settle window: coalescing is
 * the notify module's job (ticket 05), and a hook that decided delivery for
 * itself could not be reused for anything else.
 */
export type BgSettleHook = (job: BgJobRecord) => void | Promise<void>;

export interface BgJobWatcherOptions {
	/** Override for `BG_POLL_INTERVAL_MS` (tests that would rather not wait half a second). */
	intervalMs?: number;
	/** The completion hook point. Unset is valid: the watcher still settles and persists. */
	onSettled?: BgSettleHook;
}

export interface BgJobWatcher {
	/**
	 * Observe a running job. `handle` is present only for a job this process
	 * spawned; an adopted record is watched by pid, exactly like a live one.
	 *
	 * Watching the same id twice is a no-op — the first registration wins, so a
	 * re-delivered session_start cannot install a second timer for one job.
	 */
	watch: (job: BgJobRecord, handle?: BgProcessHandle) => void;
	/** Stop observing a job, without touching its record. */
	unwatch: (id: string) => void;
	isWatching: (id: string) => boolean;
	/** Stop every timer. Idempotent; the session's shutdown calls it. */
	stop: () => void;
}

interface WatchedJob {
	job: BgJobRecord;
	handle: BgProcessHandle | undefined;
}

export function createJobWatcher(options: BgJobWatcherOptions = {}): BgJobWatcher {
	const intervalMs = options.intervalMs ?? BG_POLL_INTERVAL_MS;
	const watched = new Map<string, WatchedJob>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;

	const arm = (): void => {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			void tick();
		}, intervalMs);
		// A watcher must never be the reason pi cannot exit.
		timer.unref?.();
	};

	const settle = async (entry: WatchedJob): Promise<void> => {
		const { job } = entry;
		if (job.state !== "running") return;
		// The handle, when we have one, is authoritative: this process reaped the
		// child, so its exit status exists. An adopted job has no handle, and its
		// exit code is genuinely unknown — null says so.
		const exitCode = entry.handle?.exitCode() ?? null;
		job.state = "exited";
		job.exitCode = exitCode;
		job.finishedAt = Date.now();
		try {
			await writeJobMeta(job);
		} catch (error) {
			// A record we cannot write is bad, but a watcher that stops ticking is
			// worse: the next tick retries, and the process is already gone.
			console.error(`[bg] could not persist job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Once more before unwatching: the last burst of output may have arrived
		// after the previous tick and pushed the log past its cap, and nothing polls
		// this job again.
		await capLog(job);
		try {
			await options.onSettled?.(job);
		} catch (error) {
			console.error(`[bg] settle hook failed for job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/**
	 * Bound one job's log. Best effort by design: a log that cannot be capped is
	 * worth a line on stderr and nothing else, because a watcher that threw here
	 * would stop settling every other job too.
	 */
	const capLog = async (job: BgJobRecord): Promise<void> => {
		try {
			await enforceLogCap(job.logPath);
		} catch (error) {
			console.error(`[bg] could not cap the log of job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const tick = async (): Promise<void> => {
		timer = undefined;
		if (stopped) return;
		try {
			for (const [id, entry] of [...watched]) {
				// Anything but running has already been settled by whoever changed
				// it (the kill action records its own outcome); stop watching, do not
				// rewrite the record.
				if (entry.job.state !== "running") {
					watched.delete(id);
					continue;
				}
				if (isProcessAlive(entry.job.pid)) {
					// Still running, so its log may still be growing: bound it now, and
					// leave the liveness question to the next tick.
					await capLog(entry.job);
					continue;
				}
				watched.delete(id);
				await settle(entry);
			}
		} catch (error) {
			// One bad record must not stop the others: the loop above deletes as it
			// goes, so the next tick only sees what is left.
			console.error(`[bg] watcher tick failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Checked again, not just at entry: a tick awaits filesystem writes, and
		// session_shutdown can land in that window.
		if (!stopped) arm();
	};

	return {
		watch: (job, handle) => {
			if (stopped) return;
			if (watched.has(job.id)) return;
			watched.set(job.id, { job, handle });
			arm();
		},
		unwatch: (id) => {
			watched.delete(id);
			if (watched.size === 0 && timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
		isWatching: (id) => watched.has(id),
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
			watched.clear();
		},
	};
}
