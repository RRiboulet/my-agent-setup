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
// todos.ts was previously deliberately absent: it used a TypeScript parameter
// property, which node's strip-only loader rejects
// (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) even though pi's jiti loader accepts it.
// Removing that property for the todos-tool dedup also uncovered a genuine
// strict-ESM bug the exclusion had been hiding — `TUI` is a type-only export of
// pi-tui and was imported as a value — so todos.ts is listed here now.

import assert from "node:assert/strict";
import { test } from "node:test";

const EXTENSIONS = [
	"../../answer.ts",
	"../../continue.ts",
	"../../goal.ts",
	"../../native-web-search.ts",
	"../../opencode-go-provider/index.ts",
	"../../repo-explorer/index.ts",
	"../../review.ts",
	"../../session-breakdown.ts",
	"../../todos.ts",
	"../index.ts",
] as const;

// Extension tree files that are not entry points themselves but get imported
// by one at runtime; same rationale, they must link under the real ESM
// loader. The exports an importer will use are named, so an accidental drop
// of one fails here instead of at wiring time.
const MODULES: Record<string, string[]> = {
	"../../repo-explorer/git.ts": ["openGit", "RepoGitError"],
	"../../repo-explorer/runner.ts": ["makeGitRunner"],
	"../../repo-explorer/branch-menu.ts": ["buildBranchMenu", "resolveBranchChoice", "chooseBranch"],
	"../../repo-explorer/file-browser.ts": ["createFileBrowser", "listDirectory", "parentPath"],
};

for (const relative of EXTENSIONS) {
	test(`extension ${relative} loads under strict ESM`, async () => {
		const specifier = new URL(relative, import.meta.url).href;
		const module = (await import(specifier)) as { default?: unknown };
		assert.equal(typeof module.default, "function", `${relative} must export a default extension factory`);
	});
}

for (const [relative, exports] of Object.entries(MODULES)) {
	test(`module ${relative} loads under strict ESM`, async () => {
		const specifier = new URL(relative, import.meta.url).href;
		const module = (await import(specifier)) as Record<string, unknown>;
		for (const name of exports) {
			assert.equal(typeof module[name], "function", `${relative} must export ${name}`);
		}
	});
}
