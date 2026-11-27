// Guards the `__test__` export block (local patch 9 in index.ts).
//
// The block is not used at runtime, so nothing else would notice if a future
// re-vendor from mitsuhiko/agent-stuff dropped it -- at which point the whole
// unit suite would fail with a confusing import error. Assert it explicitly.
//
// Uses a shape check so it cannot drift: if the block is dropped the import
// fails loudly; if it exists but is empty or wrong-shaped, this test fails.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__ } from "../index.ts";

test("__test__ is a plain object whose values are all functions", () => {
	assert.ok(__test__ != null, "__test__ must exist");
	assert.equal(typeof __test__, "object", "__test__ must be an object");
	const keys = Object.keys(__test__); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
	assert.ok(keys.length > 0, `__test__ must have exports (found ${keys.length})`);
	for (const key of keys) {
		assert.equal(typeof __test__[key], "function", `__test__.${key} must be a function`);
	}
});

test("the extension default export is still a factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});