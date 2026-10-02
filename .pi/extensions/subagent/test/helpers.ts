// Shared helpers for the subagent extension tests.
//
// Node 24 runs these `.ts` files directly (native type stripping, no build
// step). `npm root -g` symlinks created by ./setup-deps.sh make the extension's
// package imports resolvable.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Run `fn` with `vars` applied to process.env, restoring the previous state
 * afterwards. Extension config is read from PI_SUBAGENT_* at factory time, so
 * every test that tweaks configuration must go through here.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * Run `fn` with PI_CODING_AGENT_DIR pointed at a fresh temp directory, so
 * tests never read or write the real ~/.pi/agent tree (run dirs, tmux socket
 * path, persisted runs.json).
 */
export async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await mkdtemp(path.join(tmpdir(), "subagent-test-"));
	try {
		return await withEnv({ PI_CODING_AGENT_DIR: agentDir }, () => fn(agentDir));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

/** Poll `predicate` until it is true or the timeout expires. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("waitFor: condition not met within timeout");
}

/** A regex-free escape for tmux display-message output. */
export function paneResult(stdout: string): { code: number; stdout: string; stderr: string } {
	return { code: 0, stdout, stderr: "" };
}