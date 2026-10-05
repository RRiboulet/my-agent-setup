// Unit tests for shell quoting, env parsing, path containment, model
// resolution and the activity-read to status-observation bridge.
//
// Risk covered: shellQuote feeds the tmux/attach command strings that are
// executed in a shell; isSameOrDescendant decides whether a child pi may run in
// a given cwd; the env readers gate concurrency, auto-reap and notification.
//
// observationFromRead is here for the same reason as the rest: it is the only
// bridge from what the child wrote (an ActivityReadResult) to what the
// classifier consumes (a StatusObservation), and a mangled crossing is
// indistinguishable from a child that went quiet. Its failure reason decides
// whether a run looks like it has not started, is corrupt, or belongs to a
// different child.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { __test__ } from "../index.ts";
import { classifyStatus, createStatusState, DEFAULT_STALL_AFTER_MS, observeStatus } from "../status.ts";
import { withEnv } from "./helpers.ts";

const { isSameOrDescendant, observationFromRead, readBooleanEnv, readIntEnv, readNonNegativeIntEnv, resolveModel, shellQuote, validateCwd } =
	__test__;

const T0 = 1_700_000_000_000;

test("shellQuote quotes a value for POSIX shells", () => {
	assert.equal(shellQuote(""), "''");
	assert.equal(shellQuote("plain"), "'plain'");
	assert.equal(shellQuote("with space"), "'with space'");
	assert.equal(shellQuote("it's"), `'it'"'"'s'`);
	assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
	assert.equal(shellQuote("a'b'c"), `'a'"'"'b'"'"'c'`);
});

test("readIntEnv falls back for missing, blank and non-positive values", async () => {
	await withEnv({ PI_TEST_INT: undefined }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 7);
	});
	await withEnv({ PI_TEST_INT: "  " }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 7);
	});
	await withEnv({ PI_TEST_INT: "abc" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 7);
	});
	await withEnv({ PI_TEST_INT: "0" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 7, "zero is rejected by readIntEnv");
	});
	await withEnv({ PI_TEST_INT: "-3" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 7, "negative is rejected by readIntEnv");
	});
	await withEnv({ PI_TEST_INT: "12" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 12);
	});
	// Unit suffixes and exponent notation are rejected rather than truncated.
	// `parseInt` would read "3" out of "3m" and "1" out of "1e9", so a threshold
	// (PI_SUBAGENT_STALL_SECONDS) could be silently turned into seconds instead of
	// minutes — or into "stall immediately". The default is the safe answer.
	await withEnv({ PI_TEST_INT: "  12  " }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 12, "surrounding whitespace is still a number");
	});
	for (const bad of ["3.9", "3m", "1e9", "12x", "+12", "0x10", "1_000"]) {
		await withEnv({ PI_TEST_INT: bad }, () => {
			assert.equal(readIntEnv("PI_TEST_INT", 7), 7, `"${bad}" must be rejected, not truncated`);
		});
	}
});

test("readIntEnv rejects zero while readNonNegativeIntEnv accepts it", async () => {
	await withEnv({ PI_TEST_INT: "0" }, () => {
		assert.equal(readNonNegativeIntEnv("PI_TEST_INT", 7), 0);
	});
	await withEnv({ PI_TEST_INT: "-1" }, () => {
		assert.equal(readNonNegativeIntEnv("PI_TEST_INT", 7), 7);
	});
	await withEnv({ PI_TEST_INT: undefined }, () => {
		assert.equal(readNonNegativeIntEnv("PI_TEST_INT", 0), 0);
	});
});

test("readBooleanEnv treats only 0/false/no/off as disabled", async () => {
	for (const value of ["0", "false", "FALSE", "no", "off"]) {
		await withEnv({ PI_TEST_BOOL: value }, () => {
			assert.equal(readBooleanEnv("PI_TEST_BOOL", true), false, `${value} disables`);
		});
	}
	for (const value of ["1", "true", "yes", "on", "anything"]) {
		await withEnv({ PI_TEST_BOOL: value }, () => {
			assert.equal(readBooleanEnv("PI_TEST_BOOL", false), true, `${value} enables`);
		});
	}
	await withEnv({ PI_TEST_BOOL: undefined }, () => {
		assert.equal(readBooleanEnv("PI_TEST_BOOL", true), true);
	});
	await withEnv({ PI_TEST_BOOL: "   " }, () => {
		assert.equal(readBooleanEnv("PI_TEST_BOOL", false), false, "blank falls back");
	});
});

test("isSameOrDescendant allows the base and its children only", () => {
	assert.equal(isSameOrDescendant("/a/b", "/a/b"), true);
	assert.equal(isSameOrDescendant("/a/b", "/a/b/c"), true);
	assert.equal(isSameOrDescendant("/a/b", "/a/b/c/d"), true);
	assert.equal(isSameOrDescendant("/a/b", "/a/bc"), false, "prefix sibling is not a descendant");
	assert.equal(isSameOrDescendant("/a/b", "/a"), false);
	assert.equal(isSameOrDescendant("/a/b", "/a/b/../c"), false, "traversal is rejected");
	assert.equal(isSameOrDescendant("/a/b", "/a/b/../../etc"), false);
	assert.equal(isSameOrDescendant("/a/b", "/x/y"), false);
});

test("resolveModel inherits the parent provider and model", () => {
	const ctx = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } as never;
	assert.deepEqual(resolveModel(ctx, undefined, undefined), {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	});
});

test("resolveModel prefers explicit overrides over inherited values", () => {
	const ctx = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } as never;
	assert.deepEqual(resolveModel(ctx, "openrouter", "deepseek/deepseek-v4"), {
		provider: "openrouter",
		model: "deepseek/deepseek-v4",
	});
});

test("resolveModel splits an openrouter/ prefixed model only when it is an explicit override", () => {
	const ctx = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } as never;
	// Inherited model id whose slash belongs to the id must survive intact.
	assert.deepEqual(resolveModel(ctx, undefined, undefined), {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	});
	// Explicit openrouter/<id> with no provider selects openrouter and strips it.
	assert.deepEqual(resolveModel(ctx, undefined, "openrouter/deepseek/deepseek-v4"), {
		provider: "openrouter",
		model: "deepseek/deepseek-v4",
	});
});

test("resolveModel honours environment overrides", async () => {
	const ctx = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } } as never;
	await withEnv({ PI_SUBAGENT_PROVIDER: "openrouter", PI_SUBAGENT_MODEL: "env-model" }, () => {
		assert.deepEqual(resolveModel(ctx, undefined, undefined), { provider: "openrouter", model: "env-model" });
	});
	await withEnv({ PI_SUBAGENT_PROVIDER: "  ", PI_SUBAGENT_MODEL: "  " }, () => {
		assert.deepEqual(resolveModel(ctx, undefined, undefined), {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});
});

test("resolveModel defaults the provider to openrouter when the parent has no model", () => {
	assert.deepEqual(resolveModel({} as never, undefined, "some/model"), {
		provider: "openrouter",
		model: "some/model",
	});
});

test("resolveModel throws when no model can be determined", async () => {
	await withEnv({ PI_MODEL: undefined, PI_SUBAGENT_MODEL: undefined }, () => {
		assert.throws(() => resolveModel({} as never, undefined, undefined), /No model is active/);
	});
});

test("validateCwd accepts a directory and rejects missing paths and files", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-cwd-"));
	try {
		const file = path.join(dir, "not-a-dir.txt");
		await writeFile(file, "x", "utf8");
		await mkdir(path.join(dir, "nested"));
		await validateCwd(dir);
		await validateCwd(path.join(dir, "nested"));
		await assert.rejects(() => validateCwd(path.join(dir, "missing")), /does not exist/);
		await assert.rejects(() => validateCwd(file), /not a directory/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("observationFromRead is the only bridge from an activity read to an observation", () => {
	// The read failure reason must survive the crossing verbatim: it is the only
	// thing that tells a run that has not started yet (missing) from one whose
	// file is corrupt (invalid) or was written by a different child (wrong-id),
	// and the parse error is what describeSnapshotError later renders.
	// Field by field, not deepEqual: an observation with no error carries no
	// `snapshotError` at all, and pinning the key's presence would fail a
	// refactor to `{ snapshot: read.reason }` for no behavioural reason.
	const missingObs = observationFromRead({ ok: false, reason: "missing" });
	assert.equal(missingObs.snapshot, "missing");
	assert.equal(missingObs.snapshotError, undefined);
	const invalidObs = observationFromRead({ ok: false, reason: "invalid", error: "activity is not valid JSON: nope" });
	assert.equal(invalidObs.snapshot, "invalid");
	assert.equal(invalidObs.snapshotError, "activity is not valid JSON: nope");
	const wrongId = observationFromRead({ ok: false, reason: "wrong-id" });
	assert.equal(wrongId.snapshot, "wrong-id");
	assert.equal(wrongId.snapshotError, undefined);

	assert.deepEqual(
		observationFromRead({
			ok: true,
			activity: {
				version: 1,
				runningChildId: "run-1",
				createdAt: T0,
				updatedAt: T0 + 5_000,
				sequence: 7,
				latestEvent: "tool_execution_start",
				phase: "active",
				agentActive: true,
				providerActive: false,
				toolActive: true,
				activeScope: "tool",
				activeSince: T0 + 1_000,
				toolName: "bash",
			},
		}),
		{
			snapshot: "present",
			updatedAt: T0 + 5_000,
			sequence: 7,
			phase: "active",
			activeScope: "tool",
			activeSince: T0 + 1_000,
			toolName: "bash",
			latestEvent: "tool_execution_start",
		},
	);

	// End to end, so the one labelled branch of snapshotProblemLabel is reachable
	// from a real read rather than only from a hand-built observation.
	const state = createStatusState({ runStatus: "running", startTimeMs: T0 });
	const healthy = observeStatus(state, observationFromRead({ ok: false, reason: "missing" }), T0);
	const broke = observeStatus(healthy, observationFromRead({ ok: false, reason: "wrong-id" }), T0 + 1_000);
	assert.equal(classifyStatus(broke, T0 + 1_000 + DEFAULT_STALL_AFTER_MS).statusLabel, "wrong activity id");
	const invalid = observeStatus(state, observationFromRead({ ok: false, reason: "invalid", error: "boom" }), T0);
	assert.equal(classifyStatus(invalid, T0).snapshotError, "boom", "the parse error is kept for the renderer");
});