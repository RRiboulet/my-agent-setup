/**
 * The ssh transport for the voice extension: one `ssh` child per remote shell
 * string.
 *
 * stdout is collected as Buffers — the fetch streams an m4a through it, and
 * `pi.exec` cannot, because it accumulates strings. Both streams are capped,
 * because the phone is only semi-trusted: a compromised sshd writes to stderr
 * as freely as to stdout, so capping only the audio stream would move the
 * out-of-memory hole rather than close it. This lives apart from `index.ts`
 * (registration and presentation) so the process transport is a module of its
 * own, the way the recorder's `Run` seam already treats it.
 */

import { spawn } from "node:child_process";

import type { Run } from "./recorder.ts";
import { MAX_UPLOAD_BYTES } from "./transcribe.ts";

/** Slack above the upload cap before a stream is killed. It only needs to be
 * positive, so that a recording merely over the cap reaches `assertUploadSize`
 * (whose message names the size and keeps the audio) rather than being killed;
 * the size is chosen generously rather than derived. */
const FETCH_SLACK_BYTES = 4 * 1024 * 1024;

/** Hard ceiling on buffered stdout from one ssh command. The fetch is the only
 * command that streams a file, so a buffer past the upload cap plus slack is a
 * phone that will not stop (or `cat` on the wrong file), not a recording. */
export const MAX_SSH_STDOUT_BYTES = MAX_UPLOAD_BYTES + FETCH_SLACK_BYTES;

/** Ceiling on retained stderr. Only the head is kept; stderr is diagnostics,
 * not data, so an overflow is truncated rather than fatal. */
export const MAX_SSH_STDERR_BYTES = 64 * 1024;

/**
 * Build the `Run` that shells out to `ssh <target> <command>`. `maxStdoutBytes`
 * is a test seam — production uses the default — but it keeps the value a
 * parameter so a test can prove the cap without streaming 25 MB through a pipe.
 */
export function makeSshRun(target: string, maxStdoutBytes: number = MAX_SSH_STDOUT_BYTES): Run {
	// Defense-in-depth: `loadConfig` already degrades a dash-leading sshTarget,
	// so this only fires for a direct caller. `spawn` passes no shell, which
	// makes the leading `-` the only way to smuggle an ssh option — a prefix
	// check on the single argv element is the whole guard.
	if (target.startsWith("-")) {
		throw new Error(
			`voice: refusing ssh target ${JSON.stringify(target)}: must not start with '-' (ssh would read it as an option)`,
		);
	}
	return (command, signal) =>
		new Promise((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("voice: aborted before ssh started"));
				return;
			}
			const child = spawn("ssh", [target, command], { stdio: ["ignore", "pipe", "pipe"] });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let overflowed = false;
			child.stdout.on("data", (chunk: Buffer) => {
				if (overflowed) return;
				if (stdoutBytes + chunk.length > maxStdoutBytes) {
					// Drop what was held and kill the child. The `overflowed` guard,
					// not the kill, is what stops the heap growing; the synthesized
					// stderr below is what the caller reads, so the partial bytes are
					// no use — releasing them is the point of the cap.
					overflowed = true;
					stdout.length = 0;
					child.kill();
					return;
				}
				stdoutBytes += chunk.length;
				stdout.push(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				// Keep the head and discard the rest. Draining the pipe (rather than
				// pausing it) matters: an unread stream would back-pressure the child
				// and could hang it.
				if (stderrBytes >= MAX_SSH_STDERR_BYTES) return;
				const room = MAX_SSH_STDERR_BYTES - stderrBytes;
				stderr.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
				stderrBytes += Math.min(chunk.length, room);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (overflowed) {
					// Resolve rather than reject: the command ran and was killed, which
					// is the `RunResult` vocabulary the recorder already reads as a
					// failed fetch. A rejection would read as "did not run". The notice
					// leads so `firstLine(stderr)` surfaces it, with any earlier
					// diagnostics kept after it rather than discarded.
					const notice = `voice: the ssh command produced more than ${maxStdoutBytes} bytes of stdout; killed`;
					const diagnostics = Buffer.concat(stderr).toString("utf8");
					resolve({
						code: -1,
						stdout: Buffer.alloc(0),
						stderr: diagnostics ? `${notice}\n${diagnostics}` : notice,
					});
					return;
				}
				resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
			});
			signal.addEventListener("abort", () => child.kill(), { once: true });
		});
}
