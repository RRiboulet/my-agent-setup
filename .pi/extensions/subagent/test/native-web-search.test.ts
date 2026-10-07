// Pins native-web-search's script lookup, and guards the bug in it.
//
// Before this test, resolveScriptPath probed `here/../../skills/...` — `here`
// is the extensions dir (`.pi/extensions`), so that resolved to `<repo>/skills`,
// but the script actually lives at `<repo>/.pi/skills`, so the candidate could
// never exist and the failure message advertised a path that cannot. The `.pi`
// is the whole reason a git-sourced pi package is discoverable at all.
//
// The candidate list is derived by `scriptCandidates(here, cwd)`, so the test
// can pin it (and the `.pi` fix) against fixture paths without depending on
// where this file happens to live on disk.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { __test__ } from "../../native-web-search.ts";

const { resolveScriptPath, scriptCandidates } = __test__;

function restoreEnv(saved: string | undefined): void {
	if (saved === undefined) delete process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	else process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = saved;
}

test("the candidate list pins the repo and installed-package layouts", () => {
	const here = join("proj", ".pi", "extensions");
	const cwd = join("proj");
	// Candidates 2 and 3 coincide here because cwd === the repo root: candidate
	// 2 is the repo/package-root `.pi/skills` and candidate 3 reaches the same
	// path via cwd. That collision is deliberate and pinned, not something to
	// dedupe away — candidate 3 is load-bearing for agent-dir installs.
	assert.deepEqual(scriptCandidates(here, cwd), [
		join("proj", ".pi", "extensions", "search.mjs"),
		join("proj", ".pi", "skills", "native-web-search", "search.mjs"),
		join("proj", ".pi", "skills", "native-web-search", "search.mjs"),
	]);
	// The whole point of the fix: every skills candidate carries `.pi`. A
	// regression back to `<root>/skills/...` (which can never exist, because
	// dot-prefixed dirs are the pi package layout) fails this assertion.
	for (const candidate of scriptCandidates(here, cwd)) {
		if (candidate.includes(`${sep}skills${sep}`)) {
			assert.ok(candidate.includes(`${sep}.pi${sep}skills${sep}`),
				`candidate must reference .pi/skills, not bare skills: ${candidate}`);
		}
	}
});

test("the skill resolves from the repo layout on a fixture tree", () => {
	const root = mkdtempSync(join(tmpdir(), "nws-test-"));
	try {
		// A real tree: the extension dir has no co-located script; the skill lives
		// in `.pi/skills/native-web-search/` at the repo root.
		mkdirSync(join(root, ".pi", "skills", "native-web-search"), { recursive: true });
		writeFileSync(join(root, ".pi", "skills", "native-web-search", "search.mjs"), "// fixture\n");

		const here = join(root, ".pi", "extensions");
		const found = scriptCandidates(here, root).find((candidate) => existsSync(candidate));
		assert.equal(found, join(root, ".pi", "skills", "native-web-search", "search.mjs"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("PI_NATIVE_WEB_SEARCH_SCRIPT is honoured verbatim when absolute", () => {
	const saved = process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	const custom = resolve("/", "some", "custom", "search.mjs");
	process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = custom;
	try {
		assert.equal(resolveScriptPath(), custom);
	} finally {
		restoreEnv(saved);
	}
});

test("a relative PI_NATIVE_WEB_SEARCH_SCRIPT resolves against cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "nws-env-"));
	const saved = process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	const oldCwd = process.cwd();
	try {
		process.chdir(root);
		process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = "custom/search.mjs";
		assert.equal(resolveScriptPath(), resolve(root, "custom", "search.mjs"));
	} finally {
		process.chdir(oldCwd);
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});
