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
// What that costs is pi.exec's abort/timeout plumbing, so the parts these
// read-only git calls need are reimplemented here: the session's abort signal
// (ctx.signal, which kills the child), a timeout with SIGTERM then SIGKILL,
// and a bound on settling. That last one is not free either: a short-lived
// child can exit while a detached descendant still holds the stdout pipe, and
// then "close" never fires and neither the timeout nor the kill would resolve
// the call. So after the process exits, the pipes are destroyed once they fall
// idle for DRAIN_GRACE_MS, re-armed on every chunk — the same shape as pi's own
// waitForChildProcess, which keeps reading an actively writing descendant and
// releases a quiet inherited handle. Nothing else about the git layer changes:
// the runner stays injected, so the unit tests drive a real `git` through
// execFile, and this file is pinned by repo-explorer-menu.test.ts.

import { spawn } from "node:child_process";
import { once } from "node:events";
import type { GitRunResult, GitRunner } from "./git.ts";

/** Ceiling on any single git call. A ls-tree of a very large repository is the slow one; everything else answers in milliseconds. Generous on purpose: killing a listing that is merely slow is worse than waiting for it. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Grace between SIGTERM and SIGKILL, matching pi's own executor. */
const KILL_GRACE_MS = 5_000;
/** How long the pipes may stay idle after the process exits before they are destroyed; mirrors pi's own executor. */
const DRAIN_GRACE_MS = 100;

export interface GitRunnerOptions {
	/** Abort signal, normally the session's (ctx.signal, which is undefined for a command run while the agent is idle — the timeout, not this, is the live bound in practice). Aborting kills the child and reports it killed rather than hanging the menu. */
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
	// Deliberately blanket by prefix rather than a blocklist: every GIT_*
	// variable aims at the git process, none is needed for a local read-only
	// call (stdin is ignored, so the prompt-related ones cannot matter), and a
	// blocklist would go stale as git grows variables. The cost is that a
	// caller whose only git config lives in GIT_CONFIG_* loses it for these
	// reads; that is the trade for never resolving against the wrong repo.
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}

	return async (args, cwd): Promise<GitRunResult> => {
		if (options.signal?.aborted) {
			return { stdout: "", stderr: "", code: 1, killed: true };
		}

		// stdin is ignored on purpose: every call here is a local object read,
		// so a prompt (a credential helper, an editor) can only hang the menu.
		const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		// stderr is decoded like stdout: git quotes paths in its messages, and a
		// per-chunk decode would mangle exactly the non-ASCII path a message is
		// about.
		const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");

		// The post-exit drain described in the header. `exited` gates it so the
		// timer is never armed for a process still running, and re-arming on
		// data is what keeps a descendant's late output from being truncated.
		let exited = false;
		let drain: NodeJS.Timeout | undefined;
		const armDrain = (): void => {
			if (!exited) return;
			if (drain) clearTimeout(drain);
			drain = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, DRAIN_GRACE_MS);
			drain.unref();
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			armDrain();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			armDrain();
		});
		child.on("exit", () => {
			exited = true;
			armDrain();
		});

		// `killed` records that *we* killed it (timeout or abort), not that it
		// died by any signal; git.ts reacts to the non-zero code either way.
		let killed = false;
		let escalate: NodeJS.Timeout | undefined;
		const kill = (): void => {
			if (killed) return;
			killed = true;
			child.kill("SIGTERM");
			// A git that ignores SIGTERM (blocked in a pager, a stalled read on
			// a smart remote ref) still has to go.
			escalate = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			escalate.unref();
		};
		const onAbort = (): void => kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(kill, timeoutMs);
		timer.unref();

		try {
			// "close", not "exit": it fires once stdio has drained (or the drain
			// above destroyed it), which is what makes the accumulated stdout
			// complete. events.once rejects on "error", which is also the spawn
			// failure path (git missing from PATH, an unreadable cwd).
			const [code] = (await once(child, "close")) as [number | null];
			return { stdout: decode(stdout), stderr: decode(stderr), code: code ?? 1, killed };
		} catch (err) {
			// 127 is the conventional "command not found": a spawn failure (git
			// missing from PATH, an unreadable cwd) must not look like git's own
			// non-zero exit, or openGit would misreport it as "not a repo".
			return { stdout: "", stderr: err instanceof Error ? err.message : String(err), code: 127, killed };
		} finally {
			clearTimeout(timer);
			if (escalate) clearTimeout(escalate);
			if (drain) clearTimeout(drain);
			options.signal?.removeEventListener("abort", onAbort);
		}
	};
}
