// Unit tests for shell quoting, env parsing, path containment and model
// resolution.
//
// Risk covered: shellQuote feeds the tmux/attach command strings that are
// executed in a shell; isSameOrDescendant decides whether a child pi may run in
// a given cwd; the env readers gate concurrency, auto-reap and notification.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { __test__ } from "../index.ts";
import { withEnv } from "./helpers.ts";

const { isSameOrDescendant, readBooleanEnv, readIntEnv, readNonNegativeIntEnv, resolveModel, shellQuote, validateCwd } =
	__test__;

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
	await withEnv({ PI_TEST_INT: "3.9" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 3, "parses the leading integer");
	});
	await withEnv({ PI_TEST_INT: "12" }, () => {
		assert.equal(readIntEnv("PI_TEST_INT", 7), 12);
	});
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