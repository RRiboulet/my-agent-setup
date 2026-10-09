// repo-explorer/runner.ts — the only place /explore spawns a process.
//
// Not pi.exec, and this is the one deliberate departure from the repo's usual
// "go through pi.exec" shape. Pi's executor decodes stdout chunk-wise
// (`stdout += data.toString()` in its core exec), so every multi-byte UTF-8
// sequence that straddles a stream chunk boundary arrives as U+FFFD. Measured
// against `cat` on a file whose 64 KiB boundary falls inside "é☃": two
// replacement characters per-chunk, zero when the stdout Buffers are
// accumulated and decoded once. `git show` of a large non-ASCII file is
// exactly that case, and git.ts's readFile promises text that is an exact
// prefix of the blob — which a per-chunk decode cannot deliver. Its U+FFFD
// refusal stays, but as a tripwire for real corruption rather than for our own
// buffering.
//
// What that costs is pi.exec's abort/timeout plumbing, so the two parts these
// read-only git calls need are reimplemented here: the session's abort signal
// (ctx.signal, which kills the child) and a timeout, after which the child gets
// SIGTERM and then SIGKILL. Nothing else about the git layer changes — the
// runner stays injected, so the unit tests keep driving a real `git` through
// execFile, and this file is pinned by repo-explorer-menu.test.ts.

import { spawn } from "node:child_process";
import type { GitRunResult, GitRunner } from "./git.ts";

/** Ceiling on any single git call. A ls-tree of a very large repository is the slow one; everything else answers in milliseconds. Generous on purpose: killing a listing that is merely slow is worse than waiting for it. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Grace between SIGTERM and SIGKILL, matching pi's own executor. */
const KILL_GRACE_MS = 5_000;

export interface GitRunnerOptions {
	/** Abort signal, normally the session's (ctx.signal). Aborting kills the child and reports it killed rather than hanging the menu. */
	signal?: AbortSignal;
	/** Override for DEFAULT_TIMEOUT_MS (tests, and a slower machine). */
	timeoutMs?: number;
}

export function makeGitRunner(options: GitRunnerOptions = {}): GitRunner {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// A GIT_DIR/GIT_WORK_TREE left in the environment by the shell would
	// redirect every read to another repository: the plumbing resolves the
	// root from cwd, would report the *other* repo's root as this session's,
	// and the menu would then browse a repository the user never named.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}

	return (args, cwd) =>
		new Promise<GitRunResult>((resolve) => {
			let settled = false;
			const finish = (result: GitRunResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};

			if (options.signal?.aborted) {
				finish({ stdout: "", stderr: "", code: 1, killed: true });
				return;
			}

			// stdin is ignored on purpose: every call here is a local object
			// read, so a prompt (a credential helper, an editor) can only hang
			// the menu.
			const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			// stderr is decoded the same way as stdout: git quotes paths in its
			// messages, and a per-chunk decode would mangle exactly the
			// non-ASCII path the message is about.
			const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

			let killed = false;
			const kill = (): void => {
				if (killed) return;
				killed = true;
				child.kill("SIGTERM");
				// A git that ignores SIGTERM (blocked in a pager, a stalled
				// network read on a smart remote ref) still has to go.
				setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
			};
			const onAbort = (): void => kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			const timer = setTimeout(kill, timeoutMs);
			// The timer and the abort listener only exist for the lifetime of
			// the call, so neither may hold the event loop open.
			timer.unref();

			// Clearing before resolving matters for the error path below: a
			// spawn failure resolves the call, and the timer must not outlive it.
			const done = (): void => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
			};

			child.on("error", (err: Error) => {
				done();
				finish({ stdout: "", stderr: err.message, code: 1, killed });
			});
			// "close", not "exit": it fires once stdio has drained, which is
			// what makes the accumulated stdout complete.
			child.on("close", (code) => {
				done();
				finish({ stdout: decode(stdout), stderr: decode(stderr), code: code ?? 1, killed });
			});
		});
};
