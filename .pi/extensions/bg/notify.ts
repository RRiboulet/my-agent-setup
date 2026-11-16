// bg/notify.ts — telling the agent that jobs finished: once per settle window.
//
// The watcher (watch.ts) calls its settle hook once per job, deliberately: a
// parallel fan-out of five jobs would then produce five messages, each of which
// interrupts whatever the agent was doing, and the noise grows with the
// parallelism the tool exists to encourage. So this module is the one that
// coalesces. The first job to settle opens a window; every job that settles
// before the window closes joins it; the window closes and exactly one message
// names all of them. A job that finishes after it closed opens the next one.
//
// The window is anchored at the FIRST settle of a window, not reset by each
// further one. That is the difference between a debounce and a starve: a job
// finishing every 300ms would push a trailing-edge timer back forever and the
// agent would never hear about any of them. Here the delay a single job's
// completion can suffer is bounded by one window.
//
// Delivery follows the agent's state, read at flush time rather than at settle
// time, because that is when the message actually goes out:
//
//   - streaming: `deliverAs: "steer"`, and no `triggerTurn`. The running turn
//     picks the message up after its current tool calls, which is the point of a
//     steer; asking for a turn as well would queue a second one behind it.
//   - idle: `triggerTurn: true`. Nothing else would ever read the message — the
//     agent is not running — so the completion has to start the turn itself.
//
// Where the context comes from: the settle hook is called by a timer, which has
// no `ExtensionContext` of its own, and this extension builds the watcher before
// any handler has run. So the notifier captures the context from `session_start`
// itself. That is not a stale snapshot: `ctx.isIdle()` resolves against the live
// session on every call, so the capture answers today's question. No context at
// all (a settle before any session event) is treated as idle: delivering the
// message matters more than where it lands.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandFirstLine, type BgJobRecord } from "./store.ts";

/** `customType` of the completion message, so a renderer or a test can name it. */
export const BG_NOTIFY_MESSAGE_TYPE = "bg-jobs-settled";

/**
 * How long a settle window stays open, in milliseconds.
 *
 * One second, and the number is a compromise between two facts:
 *
 *   - The watcher polls every 500ms, so jobs that finish at nearly the same
 *     moment are already settled in the same tick. The window only has to cover
 *     a fan-out that straddles a tick boundary, which needs at least two poll
 *     intervals to be sure; 1000ms is exactly that.
 *   - It is also the worst-case delay a lone job's completion can suffer before
 *     the agent hears about it. A longer window buys nothing — no fan-out is more
 *     than a tick or two wide — and is felt directly by the model waiting on a
 *     test run.
 *
 * The spec calls one second a guess to be tuned against the replay tasks; if it
 * moves, it moves here.
 */
export const BG_NOTIFY_DEBOUNCE_MS = 1_000;

export interface BgNotifierOptions {
	/** Override for `BG_NOTIFY_DEBOUNCE_MS`. Tests that would rather not wait a second. */
	debounceMs?: number;
	/** Clock override, so a test can show a late flush reporting a job's true age. */
	now?: () => number;
}

export interface BgNotifier {
	/**
	 * Join a settled job to the current window, opening one if none is open.
	 * Idempotent per job id: settling the same job twice names it once.
	 */
	settled: (job: BgJobRecord) => void;
	/** Deliver the open window now instead of waiting for the timer. */
	flush: () => void;
	/** How many jobs are waiting for the next flush. */
	pending: () => number;
	/** Drop the timer and anything pending: nothing is delivered after this. */
	stop: () => void;
}

/** "0s", "42s", "3m 7s" — the same shape the tool's own listings use. */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/** How long the job ran: start to finish. */
export function jobDurationMs(job: BgJobRecord): number {
	return Math.max(0, (job.finishedAt ?? job.startedAt) - job.startedAt);
}

/**
 * How old the job is, at delivery: start to now.
 *
 * Distinct from the duration on purpose. A job that finished ten minutes ago and
 * is only reported now — a clock-skewed or delayed flush — has a ten-minute age
 * and its own, shorter duration, and the age is what tells the agent it is
 * reading a stale completion rather than one that just landed.
 */
export function jobAgeMs(job: BgJobRecord, at: number): number {
	return Math.max(0, at - job.startedAt);
}

/** "exit 0", "exit 7", "killed", "exit unknown" — one fact, no column padding. */
function exitLabel(job: BgJobRecord): string {
	if (job.state === "killed") return job.exitCode === null ? "killed" : `killed (exit ${job.exitCode})`;
	if (job.exitCode === null) return "exit unknown";
	return `exit ${job.exitCode}`;
}

/**
 * The message body: a header, then one three-line block per job carrying every
 * fact the acceptance criteria ask for — id, exit code, runtime, age, the first
 * line of the command, and where the log is.
 *
 * The header counts the jobs, so a single job finishing and a fan-out of six are
 * distinguishable at a glance without reading the blocks.
 */
export function formatSettledNotice(jobs: readonly BgJobRecord[], at: number = Date.now()): string {
	const count = jobs.length;
	const lines: string[] = [count === 1 ? "1 background job finished." : `${count} background jobs finished.`];
	for (const job of jobs) {
		lines.push(
			`${job.id} · ${exitLabel(job)} · ran ${formatDuration(jobDurationMs(job))} · job age ${formatDuration(jobAgeMs(job, at))}`,
			`  command: ${commandFirstLine(job.command)}`,
			`  log: ${job.logPath}`,
		);
	}
	const only = jobs.length === 1 ? jobs[0] : undefined;
	if (only) lines.push(`Read it with bg({ action: "logs", id: "${only.id}" }).`);
	return lines.join("\n");
}

export function createBgNotifier(pi: ExtensionAPI, options: BgNotifierOptions = {}): BgNotifier {
	const debounceMs = options.debounceMs ?? BG_NOTIFY_DEBOUNCE_MS;
	const now = options.now ?? (() => Date.now());
	/** The open window, keyed by job id so a repeated settle cannot name a job twice. */
	const pending = new Map<string, BgJobRecord>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let ctx: ExtensionContext | undefined;

	const disarm = (): void => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};

	const isIdle = (): boolean => {
		// After shutdown `ctx.isIdle()` throws (pi asserts the runner is active),
		// so an unanswerable question is answered the safe way: deliver.
		try {
			return ctx ? ctx.isIdle() : true;
		} catch {
			return true;
		}
	};

	const stop = (): void => {
		stopped = true;
		disarm();
		pending.clear();
	};

	// Where the context comes from, and why it is captured rather than passed in:
	// see the file header. Every later settle reads today's answer off it.
	pi.on("session_start", (_event, sessionCtx) => {
		ctx = sessionCtx;
	});
	// No timer may outlive the session: a flush after shutdown would send into a
	// dead session, and a live timer keeps node's event loop alive, so the suite
	// could not drain.
	pi.on("session_shutdown", () => {
		stop();
	});

	const flush = (): void => {
		disarm();
		// Nothing finished in this window: no message at all, rather than an empty
		// one. A flush can only reach here with an empty map through `flush()`
		// itself or a window whose jobs were already delivered.
		if (stopped || pending.size === 0) return;

		// Oldest finish first, so a message reads in the order things happened
		// rather than in timer order.
		const jobs = [...pending.values()].sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
		pending.clear();

		const at = now();
		pi.sendMessage(
			{
				customType: BG_NOTIFY_MESSAGE_TYPE,
				content: formatSettledNotice(jobs, at),
				display: true,
				details: {
					jobs: jobs.map((job) => ({
						id: job.id,
						command: commandFirstLine(job.command),
						state: job.state,
						exitCode: job.exitCode,
						durationMs: jobDurationMs(job),
						ageMs: jobAgeMs(job, at),
						logPath: job.logPath,
					})),
				},
			},
			isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
		);
	};

	return {
		settled: (job) => {
			if (stopped) return;
			// A job that is somehow still running has not finished, and announcing it
			// would be a lie the agent acts on.
			if (job.state === "running") return;
			pending.set(job.id, job);
			// First settle of this window opens it; later ones join it rather than
			// pushing the edge back (see the file header).
			if (timer) return;
			timer = setTimeout(() => {
				flush();
			}, debounceMs);
			// A notification must never be the reason pi cannot exit.
			timer.unref?.();
		},
		flush,
		pending: () => pending.size,
		stop,
	};
}
