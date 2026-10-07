// Regression guard: every vendored extension must load under a strict ESM
// loader.
//
// pi loads extensions through jiti, whose CJS interop resolves missing named
// exports lazily — a module importing a symbol that pi 1.0 removed (e.g.
// `complete` from pi-ai) still "loads" through jiti and only fails when the
// code path runs. Importing the modules here with `node --test` uses the real
// ESM linker, so a removed import fails at load time and this test goes red.
//
// Importing these modules has no side effects: each only evaluates its factory
// definition and its constant tables; nothing touches the filesystem, the
// network or pi's session state until the factory is called with an API.
//
// todos.ts is deliberately absent: it uses TypeScript parameter properties,
// which node's strip-only loader rejects (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`)
// even though pi's jiti loader accepts them. That is a loader limitation, not a
// removed export, and it is out of scope for this guard.

import assert from "node:assert/strict";
import { test } from "node:test";

const EXTENSIONS = [
	"../../answer.ts",
	"../../goal.ts",
	"../../native-web-search.ts",
	"../../review.ts",
	"../../session-breakdown.ts",
	"../index.ts",
] as const;

for (const relative of EXTENSIONS) {
	test(`extension ${relative} loads under strict ESM`, async () => {
		const specifier = new URL(relative, import.meta.url).href;
		const module = (await import(specifier)) as { default?: unknown };
		assert.equal(typeof module.default, "function", `${relative} must export a default extension factory`);
	});
}