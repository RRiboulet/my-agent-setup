// bg/index.ts — the `bg` tool: run a command that outlives the tool call.
//
// Long commands take a session hostage: `bash` blocks until the command exits,
// and the documented workaround (`nohup … &`, then `sleep` and `tail`) is a
// polling loop the model pays for in wall-clock. This tool is the other half of
// that: `start` returns in milliseconds with a job id and a log path, the job
// runs detached in its own process group, and `status` answers later without
// waiting on anything.
//
// Shape, because the rest of the change is built on it:
//
//   - The tool is registered with `exposure: "deferred"` and `defaultActive:
//     false`, so it costs nothing in the prompt until the model reaches it
//     through `tool_search`. Both are pinned by bg-start-status.test.ts.
//   - One dispatch entry per action (`actions`, below). Each later ticket adds or
//     replaces exactly one entry and touches nothing else here: `logs` (03),
//     `kill` (04), completion notifications (05, via the watcher's settle hook),
//     restart repair (06, from `session_start`).
//   - Job state lives under the pi agent directory, one directory per job; see
//     store.ts. The watcher is poll-based and takes records, so a job adopted
//     after a restart follows the same state machine as one started here; see
//     watch.ts.
//
// `logs` is declared in the schema from the start but answers with a clean "not
// implemented yet" error: a model that has learned the tool should get a sentence
// it can act on, not a missing-action failure.

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createKillJob } from "./kill.ts";
import { readLogsAction } from "./logs.ts";
import { createBgNotifier } from "./notify.ts";
import { buildJobEnv, signalProcessGroup, spawnBgJob, type BgProcessHandle } from "./spawn.ts";
import {
	commandFirstLine,
	createJobDir,
	ensureSessionJobsDir,
	listJobs,
	loadJob,
	logPathFor,
	writeJobMeta,
	type BgJobRecord,
} from "./store.ts";
import { createJobWatcher } from "./watch.ts";

const BgParams = Type.Object({
	action: StringEnum(["start", "status", "logs", "kill"] as const, {
		description: "start a command in the background, or inspect one: status (list or one job), logs, kill",
	}),
	id: Type.Optional(Type.String({ description: "The job id from `start` (status/logs/kill). Omit it on `status` to list this session's jobs." })),
	command: Type.Optional(Type.String({ description: "The command to run in the background (start). Run by the same shell as bash, in the session's cwd." })),
});

type BgParamsType = { action: string; id?: string; command?: string };
type BgAction = "start" | "status" | "logs" | "kill";

interface BgToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

type BgActionHandler = (params: BgParamsType, ctx: ExtensionContext) => Promise<BgToolResult>;

/** A failure the model should read and act on, in the repo's `Error: …` / `details.error` shape. */
function bgError(action: string, message: string): BgToolResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { action, error: message } };
}

/** "0s", "42s", "3m 7s" — the same shape the subagent tool reports. */
function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function elapsedMs(job: BgJobRecord): number {
	return Math.max(0, (job.finishedAt ?? Date.now()) - job.startedAt);
}

/** "exit 0", "exit unknown", "still running", "never started" — the listing column. */
function exitColumn(job: BgJobRecord): string {
	if (job.state === "running") return "still running";
	if (job.state === "failed-to-start") return "never started";
	if (job.exitCode === null) return job.state === "killed" ? "killed" : "exit unknown";
	return job.state === "killed" ? `killed (exit ${job.exitCode})` : `exit ${job.exitCode}`;
}

/** The same fact for one job's detail block, where there is room for the reason. */
function exitDetail(job: BgJobRecord): string {
	if (job.state === "running") return "(still running)";
	if (job.state === "failed-to-start") return "(never started)";
	if (job.exitCode === null) {
		// A job adopted after a restart, or one killed by a signal: no process in
		// this session reaped it, so there is no status to report. Null is "not
		// known", never zero.
		return job.state === "killed" ? "(killed)" : "(unknown — no exit status was observed)";
	}
	return job.state === "killed" ? `${job.exitCode} (killed)` : String(job.exitCode);
}

/** One listing row: id, state, elapsed, exit, first line of the command. */
function formatJobRow(job: BgJobRecord): string {
	return [
		job.id,
		job.state.padEnd(15),
		formatElapsed(elapsedMs(job)).padStart(6),
		exitColumn(job).padEnd(22),
		commandFirstLine(job.command),
	].join("  ");
}

function formatJobDetail(job: BgJobRecord): string {
	const lines = [
		`Job ${job.id}: ${job.state}, ${formatElapsed(elapsedMs(job))}`,
		`Command: ${commandFirstLine(job.command)}`,
		`Cwd: ${job.cwd}`,
		job.pid === null ? "Pid: (none)" : `Pid: ${job.pid} (process group ${job.pgid ?? job.pid})`,
		`Exit: ${exitDetail(job)}`,
		`Log: ${job.logPath}`,
	];
	if (job.error) lines.push(`Error: ${job.error}`);
	return lines.join("\n");
}

/**
 * The machine-readable half of every result. Kept in one place so `start`,
 * `status` and (later) `logs`/`kill` cannot drift into three shapes.
 */
function jobDetails(job: BgJobRecord): Record<string, unknown> {
	return {
		id: job.id,
		state: job.state,
		pid: job.pid,
		pgid: job.pgid,
		exitCode: job.exitCode,
		command: job.command,
		commandLine: commandFirstLine(job.command),
		cwd: job.cwd,
		logPath: job.logPath,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		elapsedMs: elapsedMs(job),
		...(job.error ? { error: job.error } : {}),
	};
}

/**
 * Placeholder for an action a later ticket owns. The job record stays readable
 * meanwhile — `status` and the log path reported by `start` are enough to follow
 * the job — so the message says that instead of leaving the caller stuck.
 */
function notImplemented(action: BgAction): BgActionHandler {
	return async () => bgError(action, `${action} is not implemented yet; follow the job with status, and read its log at the path start reported.`);
}

export default function bgExtension(pi: ExtensionAPI): void {
	// Completion notifications (ticket 05): the watcher hands one settled job at a
	// time to the notifier, which owns the settle window, the message, and the
	// delivery mode. The notifier registers its own session handlers — including
	// stopping its timer on shutdown — so this file has one line to get right.
	const notifier = createBgNotifier(pi);
	const watcher = createJobWatcher({ onSettled: (job) => notifier.settled(job) });

	const startJob = async (params: BgParamsType, ctx: ExtensionContext): Promise<BgToolResult> => {
		const command = params.command ?? "";
		if (command.trim().length === 0) return bgError("start", "command required");

		const sessionId = ctx.sessionManager.getSessionId();
		let id: string;
		let logPath: string;
		const startedAt = Date.now();
		try {
			const created = await createJobDir(sessionId);
			id = created.id;
			logPath = logPathFor(sessionId, id);
		} catch (error) {
			return bgError("start", `could not create the job directory: ${error instanceof Error ? error.message : String(error)}`);
		}

		// Phase 1: the process. A failure here means no process exists, and the
		// record says exactly that.
		let handle: BgProcessHandle;
		try {
			handle = await spawnBgJob({ command, cwd: ctx.cwd, logPath, env: buildJobEnv(ctx) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// A record that says what happened, rather than a directory with no
			// metadata in it: `status` must be able to say `failed-to-start` instead
			// of showing nothing, and no record may claim `running` with no process.
			// The write is atomic, so a failed start never leaves half a record.
			const failed: BgJobRecord = {
				id,
				sessionId,
				pid: null,
				pgid: null,
				command,
				cwd: ctx.cwd,
				logPath,
				state: "failed-to-start",
				exitCode: null,
				startedAt,
				finishedAt: Date.now(),
				error: message,
			};
			await writeJobMeta(failed);
			return {
				content: [{ type: "text", text: `Error: could not start ${id}: ${message}` }],
				details: { action: "start", error: message, sessionId, job: jobDetails(failed) },
			};
		}

		const job: BgJobRecord = {
			id,
			sessionId,
			pid: handle.pid,
			// Detached: the child leads the group, so the group id is the pid.
			pgid: handle.pid,
			command,
			cwd: ctx.cwd,
			logPath,
			state: "running",
			exitCode: null,
			startedAt,
			finishedAt: null,
		};

		// Phase 2: the record. A record we cannot write would leave a running process
		// nothing can find again, so the job is stopped instead of orphaned — the one
		// case where a failure to persist is worse than losing the work.
		try {
			await writeJobMeta(job);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			signalProcessGroup(handle.pid, "SIGKILL");
			return bgError("start", `started ${id} (pid ${handle.pid}) but could not record it, so it was killed: ${message}`);
		}

		watcher.watch(job, handle);
		return {
			content: [
				{
					type: "text",
					text: [
						`Started ${id} (pid ${handle.pid}).`,
						`Command: ${commandFirstLine(command)}`,
						`Cwd: ${ctx.cwd}`,
						`Log: ${logPath}`,
						`Follow it with bg({ action: "status", id: "${id}" }).`,
					].join("\n"),
				},
			],
			details: { action: "start", sessionId, job: jobDetails(job) },
		};
	};

	const statusJobs = async (params: BgParamsType, ctx: ExtensionContext): Promise<BgToolResult> => {
		const sessionId = ctx.sessionManager.getSessionId();

		if (params.id) {
			// Read from disk, not from memory: a job started by another process (or
			// by a session that has since restarted) is exactly as reportable.
			const job = await loadJob(sessionId, params.id);
			if (!job) return bgError("status", `no job ${params.id} in this session`);
			return {
				content: [{ type: "text", text: formatJobDetail(job) }],
				details: { action: "status", sessionId, job: jobDetails(job) },
			};
		}

		const { jobs, problems } = await listJobs(sessionId);
		if (jobs.length === 0 && problems.length === 0) {
			return {
				content: [{ type: "text", text: "No background jobs in this session." }],
				details: { action: "status", sessionId, jobs: [] },
			};
		}
		const lines = [jobs.length === 1 ? "1 background job:" : `${jobs.length} background jobs:`];
		for (const job of jobs) lines.push(formatJobRow(job));
		if (problems.length > 0) {
			lines.push(`(${problems.length} unreadable job record(s) skipped: ${problems.map((problem) => problem.dir).join(", ")})`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "status", sessionId, jobs: jobs.map(jobDetails), problems },
		};
	};

	// One entry per action. Later tickets replace one entry each; nothing else in
	// this file has to move for that.
	const actions: Record<BgAction, BgActionHandler> = {
		start: startJob,
		status: statusJobs,
		logs: readLogsAction, // ticket 03
		kill: createKillJob(watcher), // ticket 04
	};

	pi.on("session_start", async (_event, ctx) => {
		// Creating the session's job root up front keeps the first `start` from
		// racing on it and gives `status` somewhere to look. Ticket 06 adds its
		// repair/prune call here, next to this line.
		try {
			await ensureSessionJobsDir(ctx.sessionManager.getSessionId());
		} catch (error) {
			console.error(`[bg] could not create the job directory: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("session_shutdown", () => {
		// No timer may outlive the session: the suite cannot drain otherwise.
		watcher.stop();
	});

	pi.registerTool({
		name: "bg",
		label: "Background jobs",
		description: [
			"Run a command in the background and inspect it later (start, status, logs, kill).",
			"`start` returns as soon as the command is running: a job id, the log path, and the command. The job is detached in its own process group, writes combined stdout+stderr to its own log, and outlives the turn.",
			"`status` lists this session's jobs — state, exit code, elapsed, first line of the command — or reports one by id.",
			"Use it for anything slow enough to block the session: a full test suite, a container rebuild, a dev-server probe. Then keep working and check `status` instead of sleeping.",
		].join(" "),
		parameters: BgParams,
		// Deferred: absent from the prompt until tool_search loads it, so the tool
		// costs nothing until it is needed. `defaultActive: false` says the same
		// thing for the case where a host would otherwise activate it on
		// registration.
		exposure: "deferred",
		defaultActive: false,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = (params as BgParamsType).action as BgAction;
			const handler = actions[action];
			if (!handler) return bgError(String(action), `unknown action: ${String(action)}`);
			return handler(params as BgParamsType, ctx);
		},
	});
}
