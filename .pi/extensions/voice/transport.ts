/**
 * The ssh transport for the voice extension: one `ssh` child per remote shell
 * string.
 *
 * stdout is collected as Buffers — the fetch streams an m4a through it, and
 * `pi.exec` cannot, because it accumulates strings. Abort kills the child; the
 * resulting non-zero close is ignored by the caller, which checks its own signal
 * first. This lives apart from `index.ts` (registration and presentation) so the
 * process transport is a module of its own, the way the recorder's `Run` seam
 * already treats it.
 */

import { spawn } from "node:child_process";

import type { Run } from "./recorder.ts";

export function makeSshRun(target: string): Run {
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
			child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.on("error", reject);
			child.on("close", (code) => {
				resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
			});
			signal.addEventListener("abort", () => child.kill(), { once: true });
		});
}
