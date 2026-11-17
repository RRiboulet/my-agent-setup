// bg/wait.ts — `wait`: block the tool call until a job settles, or the timeout
// expires.
//
// Why this action exists, in one sentence: the completion notification is
// delivered by a timer inside the pi process that started the job, so a caller
// that ends its turn before the job finishes exits, the timer dies with it, and
// the job runs on as an orphan with its record stuck at `running` — the caller
// believed it would be woken and never was. A caller that may not outlive the job
// therefore needs a way to wait INSIDE the tool call: while the call is blocked,
// this process and its watcher are alive for exactly as long as the job needs.
//
// One state machine, reused. `wait` decides nothing about a job's state: it polls
// the record the watcher persists (`loadJob`, from store.ts) and the one liveness
// fact this repository has (`isProcessAlive`, from spawn.ts), and it takes a
// record nobody is watching and hands it to the watcher (`watch`) rather than
// settling it here. That is what keeps the exit code honest — the watcher holds
// the process handle for a job this session spawned, so its settle is the only
// one that can report the command's real status — and what keeps a second settle
// path from existing.
//
// Bounded, deliberately:
//
//   - The poll is a delay, not a spin: one record read and one `kill(pid, 0)` per
//     `BG_WAIT_POLL_MS`. Half the watcher's own beat would only make an already
//     settled record visible sooner than the settle that produced it.
//   - The wait itself is bounded by `timeoutMs`, which defaults to
//     `BG_WAIT_DEFAULT_TIMEOUT_MS` and may not exceed `BG_WAIT_MAX_TIMEOUT_MS`, so
//     no caller can pin a turn for longer than the ceiling by accident or on
//     purpose.
//   - A timeout is not an error: the job was not killed, the record says
//     `running`, and the result carries how long this call waited plus the log so
//     far. Waiting is a question about the job, not an instruction to it.
//
// This module owns no notification logic. The settle window is notify.ts's, and
// index.ts — the one file that wires the watcher to the notifier — hands this
// action the notifier's `suppress`/`release` pair as well. See the comment at the
// suppress call for why the window has to be told before the first poll.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatLogNotice, readLogTail, type LogTail } from "./logs.ts";
import { isProcessAlive } from "./spawn.ts";
import { formatDuration, loadJob, type BgJobRecord } from "./store.ts";
import type { BgJobWatcher } from "./watch.ts";

/**
 * How long `wait` waits when the caller does not say, in milliseconds.
 *
 * Five minutes, because of what a caller is waiting for. The documented full test
 * suite takes 143–178 s on this machine and is the single most expensive call the
 * `bg` tool exists to replace (52 % of all bash wall-clock in the measurement that
 * motivated it), so a default below ~3 minutes would time out on the exact
 * command it is meant to serve. A container rebuild and a migration are minutes
 * too. Five minutes clears all of them with headroom while staying short enough
 * that a caller who forgets `timeoutMs` cannot hold a turn for very long — and a
 * timeout is cheap to recover from: the job keeps running, and the caller waits
 * again or reads `status`.
 */
export const BG_WAIT_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The largest timeout a caller may ask for, in milliseconds.
 *
 * Twice the default and longer than any single command measured in this
 * repository's own logs. It exists so "wait for it" can never become "wait
 * forever": a model that passes a day, or an hour, is told the ceiling and has to
 * choose. Ten minutes is also about as long as one tool call should occupy a turn
 * before the agent checks in with the user.
 */
export const BG_WAIT_MAX_TIMEOUT_MS = 600_000;

/**
 * How often the record and the process are re-read, in milliseconds.
 *
 * Deliberately slower than a spin and faster than the watcher's 500 ms beat: the
 * record only becomes terminal when the watcher writes it (or when a kill does),
 * so polling much faster than that would re-read the same file to no purpose.
 * Two hundred milliseconds bounds how long a settle already on disk can take to
 * be noticed while costing five record reads a second.
 */
export const BG_WAIT_POLL_MS = 200;

export interface WaitParams {
	action: string;
	id?: string;
	command?: string;
	timeoutMs?: number;
}

export interface WaitToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export type WaitJobHandler = (params: WaitParams, ctx: ExtensionContext) => Promise<WaitToolResult>;

export interface WaitJobDeps {
	/**
	 * The session's watcher, narrowed to what waiting needs: whether this job is
	 * already being observed, and handing it over when it is not.
	 */
	watcher: Pick<BgJobWatcher, "isWatching" | "watch">;
	/**
	 * Take a job out of the completion-notification path (notify.ts's settle
	 * window, wired by index.ts). Present in the real tool; a direct caller may
	 * omit it, and then nothing is suppressed.
	 */
	suppress?: (id: string) => void;
	/** Undo `suppress`, for a wait that returned without the settle. */
	release?: (id: string) => void;
	/**
	 * How the rest of the tool spells a record's state: `jobDetails` and
	 * `formatJobDetail` from index.ts, passed in rather than copied so a `wait`
	 * result and a `status` result cannot drift into two shapes or two sentences.
	 */
	jobDetails: (job: BgJobRecord) => Record<string, unknown>;
	formatJobDetail: (job: BgJobRecord) => string;
	/** Override for `BG_WAIT_POLL_MS`; tests that would rather not wait a beat. */
	pollMs?: number;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failure the model should read and act on, in the repo's `Error: …` / `details.error` shape. */
function waitError(message: string): WaitToolResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { action: "wait", error: message } };
}

/**
 * The effective timeout, or a sentence saying what is wrong with the one asked
 * for. `undefined` is the default; anything the schema would not produce is
 * still checked, because `execute` can be called from code as well as by a model.
 */
export function resolveWaitTimeout(raw: unknown): number | string {
	if (raw === undefined || raw === null) return BG_WAIT_DEFAULT_TIMEOUT_MS;
	if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
		return `timeoutMs must be a whole number of milliseconds; got ${JSON.stringify(raw)}`;
	}
	if (raw <= 0) {
		return `timeoutMs must be greater than 0; got ${raw}. Omit it to wait up to ${BG_WAIT_DEFAULT_TIMEOUT_MS}ms.`;
	}
	if (raw > BG_WAIT_MAX_TIMEOUT_MS) {
		return `timeoutMs must be at most ${BG_WAIT_MAX_TIMEOUT_MS}ms (${formatDuration(BG_WAIT_MAX_TIMEOUT_MS)}); got ${raw}. A wait may not pin a turn longer than that.`;
	}
	return raw;
}

/**
 * The log tail, cut by the repository's own helper (logs.ts), plus its notices —
 * the same body and the same words `bg({ action: "logs" })` answers with, so the
 * result needs no second call.
 */
function tailBody(tail: LogTail, logPath: string, running: boolean): string[] {
	const lines = [tail.content.length > 0 ? tail.content : running ? "(no output yet)" : "(no output)"];
	const notices = formatLogNotice(tail, logPath);
	if (notices.length > 0) lines.push("", ...notices);
	return lines;
}

/** The log facts, under the same names `logs` reports them, kept nested so they cannot collide with the record's. */
function tailDetails(tail: LogTail): Record<string, unknown> {
	return {
		truncated: tail.truncated,
		truncatedBy: tail.truncatedBy,
		totalLines: tail.totalLines,
		outputLines: tail.outputLines,
		capped: tail.capped,
		windowed: tail.windowed,
	};
}

/**
 * `bg({ action: "wait", id, timeoutMs? })` — block until the job settles or the
 * timeout expires, then report the record, the duration and the log tail.
 *
 * Returns on four things, and only four: a terminal record (`exited`, `killed`,
 * `failed-to-start`), the timeout, a job id this session does not have, and a
 * nonsensical `timeoutMs`. An already-terminal job returns on the first pass,
 * without polling: the record is the answer.
 */
export function createWaitJob(deps: WaitJobDeps): WaitJobHandler {
	const pollMs = deps.pollMs ?? BG_WAIT_POLL_MS;

	return async (params, ctx) => {
		const id = params.id;
		if (!id) return waitError("id required: pass the job id that start reported");

		const timeoutMs = resolveWaitTimeout(params.timeoutMs);
		if (typeof timeoutMs === "string") return waitError(timeoutMs);

		const sessionId = ctx.sessionManager.getSessionId();
		let job = await loadJob(sessionId, id);
		if (!job) return waitError(`no job ${id} in this session`);

		// Registered BEFORE the first poll, not when a settle is finally seen. The
		// watcher persists the settled record and only then calls the settle hook
		// (watch.ts), so "the record is terminal" can be observed while the
		// notification for that very settle is still on its way through the
		// debounce window. Suppressing at return time would leave that window open.
		// A timed-out wait releases it again: this call did not report the settle,
		// so the notice is not a duplicate, and the agent still hears about the
		// finish it stopped waiting for.
		deps.suppress?.(id);

		const startedAt = Date.now();
		for (;;) {
			if (job.state !== "running") {
				const waitedMs = Date.now() - startedAt;
				let tail: LogTail;
				try {
					tail = await readLogTail(job.logPath);
				} catch (error) {
					return waitError(`job ${id} is ${job.state}, but its log could not be read: ${error instanceof Error ? error.message : String(error)}`);
				}
				return {
					content: [{ type: "text", text: [deps.formatJobDetail(job), "", ...tailBody(tail, job.logPath, false)].join("\n") }],
					details: {
						action: "wait",
						sessionId,
						settled: true,
						timedOut: false,
						waitedMs,
						timeoutMs,
						job: deps.jobDetails(job),
						tail: tailDetails(tail),
					},
				};
			}

			// A running record whose pid is gone was not observed dying by anyone:
			// hand it to this session's watcher, which settles it (exit code unknown,
			// never zero) and still runs the settle hook. `watch` is a no-op for a job
			// already registered, but asking first keeps the intent legible.
			if (!isProcessAlive(job.pid) && !deps.watcher.isWatching(job.id)) deps.watcher.watch(job);

			const waitedMs = Date.now() - startedAt;
			if (waitedMs >= timeoutMs) {
				// Not an error, and not a kill: the job runs on. Released first, so the
				// completion this call stopped waiting for is still announced.
				deps.release?.(id);
				let tail: LogTail;
				try {
					tail = await readLogTail(job.logPath);
				} catch (error) {
					return waitError(`job ${id} is still running, but its log could not be read: ${error instanceof Error ? error.message : String(error)}`);
				}
				return {
					content: [
						{
							type: "text",
							text: [
								deps.formatJobDetail(job),
								"",
								...tailBody(tail, job.logPath, true),
								"",
								`[Job ${job.id} is still running after ${formatDuration(waitedMs)} of waiting (timeoutMs ${timeoutMs}). It was not killed: wait again with bg({ action: "wait", id: "${job.id}" }), or follow it with status.]`,
							].join("\n"),
						},
					],
					details: {
						action: "wait",
						sessionId,
						settled: false,
						timedOut: true,
						waitedMs,
						timeoutMs,
						job: deps.jobDetails(job),
						tail: tailDetails(tail),
					},
				};
			}

			await delay(Math.min(pollMs, timeoutMs - waitedMs));
			const next = await loadJob(sessionId, id);
			if (!next) return waitError(`job ${id} disappeared while waiting for it; it may have been pruned`);
			job = next;
		}
	};
}
