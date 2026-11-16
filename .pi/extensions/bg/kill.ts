// bg/kill.ts — stop a job: SIGTERM its process group, SIGKILL after the grace.
//
// The unit of stopping is the process GROUP, not the pid, because the pid is
// only the shell: `cmd &`, a pipeline, or a sub-shell's children are reachable
// through the group id and by nothing else. A detached job leads its own group
// (spawn.ts), so one negative-pid signal reaches the whole tree — see
// `signalJobGroup`, which this module calls rather than signals for itself.
//
// Grace, then escalation. SIGTERM is a request: a shell blocked in a read, or one
// that traps the signal, ignores it. `BG_KILL_GRACE_MS` is the same five seconds
// pi's own executor and the repo-explorer runner allow before SIGKILL, so
// "kill" means the same thing everywhere in this repository. Once the group is
// gone, one more SIGKILL is sent on purpose: a member that ignores SIGTERM can
// outlive the leader that exited, and a job is not stopped while any of it runs.
//
// The record is written as `killed`, never `exited`, and only after the process
// is gone — `exited` is what the watcher records for a job that ended on its own,
// and conflating the two would lose the one fact this action exists to record.
//
// Why the watcher has to be involved: it holds its own in-memory copy of the
// record it was given at `start` and settles THAT copy when the pid disappears
// (watch.ts). Rewriting `job.json` therefore does not stop it — its next tick,
// at most 500 ms later, would settle the stale copy and overwrite `killed` with
// `exited`. So a kill takes the job out of the watcher first and owns the record
// from then on. `unwatch` rather than a new watcher API: the watcher's own
// `unwatch` is exactly "stop observing this job, do not touch its record", which
// is the handover this needs.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BG_KILL_GRACE_MS, isProcessAlive, signalJobGroup } from "./spawn.ts";
import { loadJob, writeJobMeta, type BgJobRecord } from "./store.ts";
import type { BgJobWatcher } from "./watch.ts";

/** How often the job's liveness is re-checked while waiting out a signal. */
export const BG_KILL_POLL_MS = 25;
/**
 * How long SIGKILL is given to take effect. It cannot be caught or ignored, so
 * this only covers the scheduler: a process that is gone at all is gone in
 * milliseconds. Bounded anyway, so a kill cannot hang on a kernel oddity.
 */
export const BG_KILL_SIGKILL_WAIT_MS = 2_000;

export interface KillJobOptions {
	/** Grace between SIGTERM and SIGKILL. Overridden only by tests that call `killJobRecord` directly. */
	graceMs?: number;
	pollMs?: number;
	killWaitMs?: number;
}

/**
 * How a kill ended.
 *
 * `already-finished`: the record did not say `running`, so nothing was signalled
 * — the no-op the ticket asks for. `already-exited`: the record DID say running
 * but its process was already gone (the watcher had not ticked yet, or the job
 * was adopted in a later session); the record is settled as `exited` because
 * that is what happened, and claiming `killed` would be a lie about a process
 * this call never signalled. `killed`: the group is gone and the record says so.
 * `survived`: SIGKILL did not end it — left `running`, and reported as an error,
 * because a record that says `killed` over a live process is worse than one that
 * still says `running`.
 */
export type KillOutcome =
	| { kind: "already-finished"; job: BgJobRecord }
	| { kind: "already-exited"; job: BgJobRecord }
	| { kind: "killed"; job: BgJobRecord; escalated: boolean }
	| { kind: "survived"; job: BgJobRecord; escalated: boolean };

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `pid` is gone, or the bound expires. Returns whether it is gone.
 *
 * `isProcessAlive` is the only liveness fact this repository has (spawn.ts), and
 * a zombie reports as alive until it is reaped; a job this process spawned is
 * reaped by node itself, and an adopted one by init, so this converges either
 * way. The last check is repeated after the deadline so "gone just now" is not
 * reported as survived.
 */
async function waitForExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return true;
		await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
	return !isProcessAlive(pid);
}

/**
 * Record a job whose process was gone before this call could signal it.
 *
 * `exited` with an unknown exit code is the honest shape: no process in this
 * session reaped that job, so there is no status to report, and `null` is "not
 * known", never zero (see `BgJobRecord`). The watcher, the repair path on session
 * start, and this all converge on the same record, so the order they happen in
 * does not matter.
 */
async function settleAsExited(job: BgJobRecord): Promise<BgJobRecord> {
	const exited: BgJobRecord = { ...job, state: "exited", exitCode: null, finishedAt: Date.now() };
	try {
		await writeJobMeta(exited);
	} catch (error) {
		console.error(`[bg] could not record job ${job.id} as exited: ${error instanceof Error ? error.message : String(error)}`);
	}
	return exited;
}

/**
 * Stop one job's process group and persist the outcome. Does not read or write
 * anything the caller owns, beyond the job's own record, so it is usable from the
 * tool action and directly from a test.
 *
 * Signalling a group this call has just emptied is harmless: `signalJobGroup`
 * reports a group that is already gone as `false` rather than throwing.
 */
export async function killJobRecord(job: BgJobRecord, options: KillJobOptions = {}): Promise<KillOutcome> {
	if (job.state !== "running") return { kind: "already-finished", job };

	// Killed only once the group is gone, so a job that ends between this check
	// and the signal is reported (and recorded) as what it did: `exited`, with the
	// exit code nobody can still read. `isProcessAlive` answers `false` for a null
	// pid, which is the corrupt-record case and not a process to signal either.
	const pid = job.pid;
	if (pid === null || !isProcessAlive(pid)) return { kind: "already-exited", job: await settleAsExited(job) };

	const graceMs = options.graceMs ?? BG_KILL_GRACE_MS;
	const pollMs = options.pollMs ?? BG_KILL_POLL_MS;
	const killWaitMs = options.killWaitMs ?? BG_KILL_SIGKILL_WAIT_MS;

	signalJobGroup(job, "SIGTERM");
	let escalated = false;
	let gone = await waitForExit(pid, graceMs, pollMs);
	if (!gone) {
		// SIGTERM was ignored, or the leader is waiting on something that never
		// returns. SIGKILL cannot be caught or ignored; there is no third step.
		escalated = true;
		signalJobGroup(job, "SIGKILL");
		gone = await waitForExit(pid, killWaitMs, pollMs);
	}
	if (!gone) return { kind: "survived", job, escalated };

	// The leader is gone; a member that ignored SIGTERM need not be. Killing a
	// group with no members left (or no group at all, the leader being reaped) is
	// a no-op that reports `false`.
	signalJobGroup(job, "SIGKILL");

	const killed: BgJobRecord = {
		...job,
		state: "killed",
		// Killed by a signal: there is no exit status to report, and `null` says
		// exactly that rather than inventing 137.
		exitCode: null,
		finishedAt: Date.now(),
	};
	try {
		await writeJobMeta(killed);
	} catch (error) {
		// The job IS stopped; only the record is stale. Reported rather than
		// thrown, so the caller learns both facts in one result.
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[bg] killed job ${job.id} but could not record it: ${message}`);
		throw new Error(`the process group is gone, but its record could not be updated: ${message}`);
	}
	return { kind: "killed", job: killed, escalated };
}

/* ------------------------------------------------------------------ *
 * The tool action
 * ------------------------------------------------------------------ */

export interface KillParams {
	action: string;
	id?: string;
	command?: string;
}

export interface KillToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export type KillJobHandler = (params: KillParams, ctx: ExtensionContext) => Promise<KillToolResult>;

/** A failure the model should read and act on, in the repo's `Error: …` / `details.error` shape. */
function killError(message: string): KillToolResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { action: "kill", error: message } };
}

/** "exited (exit 3)", "killed", "never started: <reason>" — what the no-op message needs. */
function stateText(job: BgJobRecord): string {
	if (job.state === "failed-to-start") return job.error ? `failed-to-start: ${job.error}` : "failed-to-start";
	if (job.state === "running") return "still running";
	if (job.exitCode === null) return job.state;
	return `${job.state} (exit ${job.exitCode})`;
}

/** The machine-readable half of a kill result: the same names `status` uses, plus what this call did. */
function killDetails(job: BgJobRecord, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		action: "kill",
		id: job.id,
		sessionId: job.sessionId,
		state: job.state,
		pid: job.pid,
		pgid: job.pgid,
		exitCode: job.exitCode,
		finishedAt: job.finishedAt,
		...extra,
	};
}

/**
 * The `kill` action.
 *
 * Takes the watcher because a kill has to stop it observing this job before the
 * record changes: see the file header. Nothing else about the watcher is used.
 */
export function createKillJob(watcher: Pick<BgJobWatcher, "unwatch">): KillJobHandler {
	return async (params, ctx) => {
		const id = params.id;
		if (!id) return killError("id required: pass the job id that start reported");

		const sessionId = ctx.sessionManager.getSessionId();
		const job = await loadJob(sessionId, id);
		if (!job) return killError(`no job ${id} in this session`);

		// Before anything is signalled, and for every outcome: once this action is
		// responsible for the job's end, the watcher must not settle it too.
		watcher.unwatch(job.id);

		let outcome: KillOutcome;
		try {
			outcome = await killJobRecord(job);
		} catch (error) {
			// The only thing that throws here is a record that could not be written,
			// after the group was stopped: say both, so the caller does not retry a
			// kill that already happened.
			const message = `job ${id}: ${error instanceof Error ? error.message : String(error)}`;
			const result = killError(message);
			return { content: result.content, details: { ...result.details, killed: true } };
		}

		switch (outcome.kind) {
			case "already-finished":
				// A no-op, not a failure: the caller asked for a state the job is
				// already in, and there is nothing to report but which one.
				return {
					content: [{ type: "text", text: `Job ${job.id} is already ${stateText(outcome.job)}; nothing to kill.` }],
					details: killDetails(outcome.job, { killed: false, alreadyFinished: true, escalated: false }),
				};
			case "already-exited":
				return {
					content: [
						{
							type: "text",
							text: [
								`Job ${job.id} was recorded running, but its process was already gone; recorded it as exited.`,
								`Nothing was signalled. Log: ${outcome.job.logPath}`,
							].join("\n"),
						},
					],
					details: killDetails(outcome.job, { killed: false, alreadyFinished: true, escalated: false, wasRunning: true }),
				};
			case "survived":
				// A live process is not something to paper over with a record that
				// says otherwise, so the record keeps saying `running` and this is an
				// error the caller can act on.
				return killError(
					`job ${job.id} (process group ${job.pgid ?? job.pid}) is still alive after SIGKILL; its record still says running`,
				);
			case "killed": {
				const how = outcome.escalated
					? `SIGTERM was ignored, so SIGKILL followed after the ${Math.round(BG_KILL_GRACE_MS / 1000)}s grace`
					: "SIGTERM";
				return {
					content: [
						{
							type: "text",
							text: [
								`Killed ${outcome.job.id} (process group ${outcome.job.pgid ?? outcome.job.pid}): ${how}.`,
								`The process group is gone. Log: ${outcome.job.logPath}`,
							].join("\n"),
						},
					],
					details: killDetails(outcome.job, { killed: true, alreadyFinished: false, escalated: outcome.escalated }),
				};
			}
		}
	};
}
