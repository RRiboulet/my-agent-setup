// Unit tests for the pi child's command line.
//
// These tests exist because a mistake here kills the child before it starts, and
// the failure mode is a session that silently never comes back. Two facts about
// the installed pi pin the whole file:
//
//   1. `--session-id` and `--session` are mutually exclusive — passing both
//      exits 1 with "Error: --session-id cannot be combined with --session".
//   2. There is no `--cwd` flag; pi takes its working directory from its process
//      cwd, so a caller must set that itself.
//
// Both are load-bearing rather than incidental: pocket's resume path depends on
// (1) choosing one mode per spawn, and its working-directory contract depends on
// nothing in this list being assumed to change it.

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resumeArgs, spawnArgs } from "../../pocket/spawn-args.ts";

async function scratch(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pocket-spawn-"));
}

test("a session with no recorded file names a new one", () => {
	assert.deepEqual(resumeArgs("s-abc", "/tmp/dir", undefined), ["--session-dir", "/tmp/dir", "--session-id", "s-abc"]);
});

test("a session with a missing file falls back to naming a new one", async () => {
	const root = await scratch();
	try {
		// pi writes its session file lazily, after the first turn, so a recorded
		// path very often does not exist yet. Resuming it would be a child that
		// dies with "No project session found".
		assert.deepEqual(resumeArgs("s-abc", "/tmp/dir", path.join(root, "never-written.jsonl")), [
			"--session-dir",
			"/tmp/dir",
			"--session-id",
			"s-abc",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a session with an existing file resumes it and never names it too", async () => {
	const root = await scratch();
	try {
		const file = path.join(root, "session.jsonl");
		await writeFile(file, "{}\n");
		const args = resumeArgs("s-abc", "/tmp/dir", file);
		// The mutual exclusion is not a style preference: if both flags appear,
		// pi exits before answering a single request.
		assert.deepEqual(args, ["--session", file]);
		assert.equal(args.includes("--session-id"), false);
		assert.equal(countOf(args, "--session"), 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("spawnArgs always starts in rpc mode", () => {
	const args = spawnArgs({ sessionId: "s-abc", sessionDir: "/tmp/dir", sessionFile: undefined });
	assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
});

test("spawnArgs passes model and thinking through as separate arguments", () => {
	const args = spawnArgs({
		sessionId: "s-abc",
		sessionDir: "/tmp/dir",
		sessionFile: undefined,
		model: "anthropic/claude-sonnet-4-5",
		thinkingLevel: "low",
	});
	assert.deepEqual(args, [
		"--mode",
		"rpc",
		"--session-dir",
		"/tmp/dir",
		"--session-id",
		"s-abc",
		"--model",
		"anthropic/claude-sonnet-4-5",
		"--thinking",
		"low",
	]);
});

test("an absent model or thinking level adds no flags", () => {
	const args = spawnArgs({ sessionId: "s-abc", sessionDir: "/tmp/dir", sessionFile: undefined });
	assert.equal(args.includes("--model"), false);
	assert.equal(args.includes("--thinking"), false);
});

test("spawnArgs never tells pi where to run: that is spawn's cwd", () => {
	const args = spawnArgs({ sessionId: "s-abc", sessionDir: "/tmp/dir", sessionFile: undefined });
	// No --cwd flag exists in pi, so a caller that relied on one would have a
	// session running in the daemon's directory instead of the project's.
	assert.equal(args.includes("--cwd"), false);
});

test("every value is a single argv element, even when it contains a space", () => {
	const args = spawnArgs({ sessionId: "s-abc", sessionDir: "/tmp/dir with space", sessionFile: undefined });
	// spawn() passes these through without a shell, so a space inside a value is
	// only a bug if something is doing its own splitting.
	assert.equal(args.includes("/tmp/dir with space"), true);
});

function countOf(values: string[], wanted: string): number {
	return values.filter((value) => value === wanted).length;
}
