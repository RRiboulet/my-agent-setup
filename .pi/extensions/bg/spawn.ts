// bg/spawn.ts — starting a job, asking whether it is still alive, and signalling
// its process group.
//
// The job is an ordinary detached child process, not a wrapper: the shell pi's
// own bash tool would use (`getShellConfig`, so `/bin/bash -c` on this machine)
// runs the command, `detached: true` puts it in a new process group whose id is
// its pid, and its stdout and stderr are the job's log file. Nothing about the
// call waits on the command; the one thing awaited is the `spawn` event, which
// fires once the child exists (or its `error`, which is the failed-to-start
// case). That is what lets `start` answer in milliseconds with a pid it can
// truthfully call running.
//
// Two consequences worth stating:
//
//   - The child is unref'd, so it does not keep pi's event loop alive. A session
//     that exits leaves its jobs running, which is the point; the next session
//     adopts them by pid (and cannot know their exit code — see BgJobRecord).
//   - Waiters do not exist. `isProcessAlive` is the only liveness fact, and
//     `process.kill(pid, 0)` reports a zombie as alive, so a child that has
//     exited but not been reaped yet is never mistaken for one whose exit status
//     we could still read.

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";

/** Grace between SIGTERM and SIGKILL, matching pi's own executor and the repo-explorer runner. */
export const BG_KILL_GRACE_MS = 5_000;

/**
 * A running job's process, as far as the process that spawned it can tell.
 *
 * `exitCode()` is only meaningful here: an adopted job (ticket 06) has no handle,
 * because the process that spawned it is gone.
 */
export interface BgProcessHandle {
	readonly pid: number;
	/** The exit code, once this process has reaped the child; null while it runs. */
	exitCode(): number | null;
}

export interface SpawnBgJobOptions {
	command: string;
	cwd: string;
	/** Where stdout and stderr are written (appended), one file for both. */
	logPath: string;
	env: NodeJS.ProcessEnv;
}

/**
 * Start `command` detached, with its output going to `logPath`.
 *
 * Resolves as soon as the child exists; rejects when it cannot start at all
 * (missing cwd, missing shell, no permission), with the reason the record keeps
 * as `error`. It never waits for the command, and there is no timeout: a job that
 * runs for an hour is the normal case.
 */
export async function spawnBgJob(options: SpawnBgJobOptions): Promise<BgProcessHandle> {
	// Fail with the caller's own words before spawning anything: a nonexistent
	// cwd surfaces from `spawn` as a bare ENOENT, which reads like a missing
	// binary and sends the reader looking in the wrong place.
	let cwdIsDirectory = false;
	try {
		cwdIsDirectory = (await stat(options.cwd)).isDirectory();
	} catch {
		cwdIsDirectory = false;
	}
	if (!cwdIsDirectory) {
		throw new Error(`working directory does not exist: ${options.cwd}`);
	}

	const shell = getShellConfig();
	// Legacy WSL bash cannot take the command as an argv word; pi's own shell
	// config says so with `commandTransport: "stdin"`.
	const commandOnStdin = shell.commandTransport === "stdin";

	// "a" so a job's log is never clobbered if a record outlives its process.
	// 0600: a job's output is the session's business, not the machine's.
	const logFd = openSync(options.logPath, "a", 0o600);
	let child: ChildProcess | undefined;
	try {
		child = spawn(shell.shell, commandOnStdin ? [...shell.args] : [...shell.args, options.command], {
			cwd: options.cwd,
			env: options.env,
			// Its own process group: one negative-pid signal reaches the command
			// and everything it started, which is what `kill` needs.
			detached: true,
			// stdin is closed on purpose: a job that decides to prompt would
			// otherwise sit waiting on a terminal that is not its own.
			stdio: [commandOnStdin ? "pipe" : "ignore", logFd, logFd],
			shell: false,
		});
		// "spawn", not "exit": this fires when the process exists. `once` rejects
		// on "error", which is also the spawn-failure path.
		await once(child, "spawn");
		if (commandOnStdin && child.stdin) {
			await new Promise<void>((resolve, reject) => {
				child.stdin?.end(options.command, (error) => (error ? reject(error) : resolve()));
			});
		}
	} finally {
		// The child holds its own duplicate of the descriptor; ours would only
		// leak for the lifetime of the session.
		closeSync(logFd);
	}

	if (!child || typeof child.pid !== "number") {
		throw new Error("the shell started but reported no pid");
	}
	const pid = child.pid;
	// Detached and unreferenced: the job outlives the turn, and pi's event loop
	// is free to empty.
	child.unref();
	return { pid, exitCode: () => child.exitCode };
}

/**
 * Whether a pid names a live process.
 *
 * Signal 0 checks permission without delivering anything: ESRCH means gone,
 * EPERM means it exists but belongs to someone else. A zombie reports as alive
 * until it is reaped, which is what makes this safe to pair with a held child
 * handle — see the file header.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Signal a job's process group.
 *
 * The negative pid is the whole group, which a detached job leads: the command,
 * anything it forked, and anything those forked, all in one call. Returns whether
 * the signal was delivered — `false` when the group is already gone (ESRCH) or
 * cannot be signalled from here (EPERM), both of which mean "nothing more this
 * call can do", not an exception. Any other errno is a real error and propagates.
 *
 * Exported for the `kill` action (ticket 04), which must not need to edit this
 * module to stop a job.
 */
export function signalProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM"): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
}

/** `signalProcessGroup` on a job record, so callers pass the record they already have. */
export function signalJobGroup(job: { pid: number | null }, signal: NodeJS.Signals = "SIGTERM"): boolean {
	return signalProcessGroup(job.pid, signal);
}

/**
 * The environment pi's own bash tool would give a command.
 *
 * Mirrors `getShellEnv()` + `resolveSpawnContext()` in pi's bash tool: the
 * session's environment with the agent's `bin` directory on PATH, then the
 * session variables re-set from the session (deleted first, so a stale value
 * inherited from a parent pi cannot leak into a child job).
 *
 * `getShellEnv` is not part of pi's public exports, so the PATH edit is mirrored
 * here rather than imported; `getAgentDir` is, and it is what makes
 * `PI_CODING_AGENT_DIR` — and therefore a test's temp agent dir — the source of
 * that path.
 */
export interface SessionEnvSource {
	sessionManager: {
		getSessionId: () => string;
		getSessionFile?: () => string | undefined;
	};
	model?: { provider?: string; id?: string } | undefined;
	thinkingLevel?: string | undefined;
}

export function buildJobEnv(source: SessionEnvSource, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDir = join(getAgentDir(), "bin");
	const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
	if (!entries.includes(binDir)) env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(delimiter);

	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;

	env.PI_SESSION_ID = source.sessionManager.getSessionId();
	const sessionFile = source.sessionManager.getSessionFile?.();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (source.model?.provider) env.PI_PROVIDER = source.model.provider;
	if (source.model?.id) env.PI_MODEL = source.model.id;
	if (source.thinkingLevel) env.PI_REASONING_LEVEL = source.thinkingLevel;
	return env;
}
