// Unit tests for repo-explorer/quick-open.ts — the `/explore <path>` argument
// grammar and the branch resolution behind it.
//
// Both layers are pure over strings and a `BranchList`, so these run without a
// terminal or a repository. The handler wiring (quick-open reaching the real
// `readFile`/browser) is pinned in repo-explorer-menu.test.ts, where the
// temporary repositories already live.
//
// The cases worth the reader's attention are the ones the grammar deliberately
// resolves one way: a single token is always a path (so `main` is a filename,
// not a branch), `branch:path` splits only on a single token (so a path that
// contains a colon survives the two-token form), and a short branch name that
// matches both a local branch and a remote-tracking ref is refused rather than
// guessed — the `origin/main` shadow branch-menu.ts exists to disambiguate.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { BranchList } from "../../repo-explorer/git.ts";
import { normalizeRepoPath, parseExploreArgs, resolveQuickBranch, tokenizeArgs } from "../../repo-explorer/quick-open.ts";

// ---------------------------------------------------------------------------
// tokenizeArgs
// ---------------------------------------------------------------------------

test("tokenizeArgs splits on whitespace and honours single and double quotes", () => {
	assert.deepEqual(tokenizeArgs("src/foo.ts"), ["src/foo.ts"]);
	assert.deepEqual(tokenizeArgs("  a   b  "), ["a", "b"]);
	assert.deepEqual(tokenizeArgs('"my file.ts"'), ["my file.ts"]);
	assert.deepEqual(tokenizeArgs("'my file.ts'"), ["my file.ts"]);
	assert.deepEqual(tokenizeArgs('"a b" c'), ["a b", "c"]);
	assert.deepEqual(tokenizeArgs('"a \\"quoted\\" name"'), ['a "quoted" name']);
	assert.deepEqual(tokenizeArgs(""), []);
});

// ---------------------------------------------------------------------------
// normalizeRepoPath
// ---------------------------------------------------------------------------

test("normalizeRepoPath folds the spellings a person types into the canonical form", () => {
	assert.equal(normalizeRepoPath("src/foo.ts"), "src/foo.ts");
	assert.equal(normalizeRepoPath("./src/foo.ts"), "src/foo.ts");
	assert.equal(normalizeRepoPath("././src/foo.ts"), "src/foo.ts");
	assert.equal(normalizeRepoPath("src//foo.ts"), "src/foo.ts");
	assert.equal(normalizeRepoPath("src/"), "src");
	assert.equal(normalizeRepoPath("."), "");
	assert.equal(normalizeRepoPath("./"), "");
});

// ---------------------------------------------------------------------------
// parseExploreArgs
// ---------------------------------------------------------------------------

test("no arguments means no path: the menu flow keeps the command", () => {
	assert.deepEqual(parseExploreArgs(undefined), {});
	assert.deepEqual(parseExploreArgs(""), {});
	assert.deepEqual(parseExploreArgs("   "), {});
});

test("a single token is a path, never a branch", () => {
	assert.deepEqual(parseExploreArgs("src/foo.ts"), { path: "src/foo.ts" });
	assert.deepEqual(parseExploreArgs("./src/foo.ts"), { path: "src/foo.ts" });
	assert.deepEqual(parseExploreArgs("."), { path: "" }, "the root is an empty path, not undefined");
	// `main` is a file named main here, not a branch: the branch spellings are
	// `main:` / `main:.` and the menu. This is the documented reading.
	assert.deepEqual(parseExploreArgs("main"), { path: "main" });
});

test("two tokens are path then branch", () => {
	assert.deepEqual(parseExploreArgs("src/foo.ts feature"), { path: "src/foo.ts", branch: "feature" });
	assert.deepEqual(parseExploreArgs('"my file.ts" feature'), { path: "my file.ts", branch: "feature" });
});

test("branch:path splits on the first colon of a single token", () => {
	assert.deepEqual(parseExploreArgs("feature:src/foo.ts"), { path: "src/foo.ts", branch: "feature" });
	assert.deepEqual(parseExploreArgs("origin/main:docs/readme.md"), { path: "docs/readme.md", branch: "origin/main" });
	assert.deepEqual(parseExploreArgs("main:"), { path: "", branch: "main" }, "an empty path after the colon is the root");
	assert.deepEqual(parseExploreArgs("feature:a:b"), { path: "a:b", branch: "feature" }, "only the first colon splits");
});

test("a path containing a colon survives the two-token form", () => {
	// Colon splitting is applied only to a single token, so the two-token form
	// is the escape hatch for a colon in a filename.
	assert.deepEqual(parseExploreArgs("weird:name.txt main"), { path: "weird:name.txt", branch: "main" });
});

test("more than two tokens and absolute paths are reported as errors", () => {
	assert.match(parseExploreArgs("a b c").error ?? "", /too many arguments/);
	assert.match(parseExploreArgs("/etc/passwd").error ?? "", /absolute paths are not supported/);
	assert.match(parseExploreArgs("main:/etc/passwd").error ?? "", /absolute paths are not supported/);
	assert.equal(parseExploreArgs("a b c").path, undefined);
});

// ---------------------------------------------------------------------------
// resolveQuickBranch
// ---------------------------------------------------------------------------

/** The menu fixture, hand-built: current main, feature, a remote for each, and the detached tip absent. */
function baseList(): BranchList {
	return {
		branches: [
			{ refname: "refs/heads/feature", name: "feature", isRemote: false, isCurrent: false },
			{ refname: "refs/heads/main", name: "main", isRemote: false, isCurrent: true },
			{ refname: "refs/remotes/origin/feature", name: "origin/feature", isRemote: true, isCurrent: false },
			{ refname: "refs/remotes/origin/main", name: "origin/main", isRemote: true, isCurrent: false },
		],
		current: "main",
	};
}

test("an explicit refname resolves to itself; a short name and the menu label resolve to the refname", () => {
	const list = baseList();
	assert.deepEqual(resolveQuickBranch(list, {}, "refs/heads/feature").choice, { refname: "refs/heads/feature", label: "feature" });
	assert.deepEqual(resolveQuickBranch(list, {}, "feature").choice, { refname: "refs/heads/feature", label: "feature" });
	assert.deepEqual(resolveQuickBranch(list, {}, "origin/feature").choice, {
		refname: "refs/remotes/origin/feature",
		label: "origin/feature",
	});
	assert.deepEqual(resolveQuickBranch(list, {}, "main").choice, { refname: "refs/heads/main", label: "main (current)" });
	assert.deepEqual(
		resolveQuickBranch(list, {}, "main (current)").choice,
		{ refname: "refs/heads/main", label: "main (current)" },
		"the label the menu would offer is accepted too",
	);
});

test("an argument matching no listed branch is handed back raw for tipOf to try", () => {
	// A tag or a sha is not in the listing; git.ts's tipOf is what resolves it,
	// and unknown-branch if it does not.
	assert.deepEqual(resolveQuickBranch(baseList(), {}, "v1.2.0").choice, { refname: "v1.2.0", label: "v1.2.0" });
	assert.deepEqual(resolveQuickBranch(baseList(), {}, "abc1234").choice, { refname: "abc1234", label: "abc1234" });
});

test("a short name matching both a local and a remote-tracking ref is ambiguous, not guessed", () => {
	const list: BranchList = {
		branches: [
			{ refname: "refs/heads/main", name: "main", isRemote: false, isCurrent: true },
			{ refname: "refs/heads/origin/main", name: "origin/main", isRemote: false, isCurrent: false },
			{ refname: "refs/remotes/origin/main", name: "origin/main", isRemote: true, isCurrent: false },
		],
		current: "main",
	};
	const result = resolveQuickBranch(list, {}, "origin/main");
	assert.equal(result.choice, undefined);
	assert.match(result.error ?? "", /ambiguous/);
	assert.match(result.error ?? "", /origin\/main \[local\]/);
	assert.match(result.error ?? "", /origin\/main \[remote\]/);

	// The explicit forms still resolve unambiguously.
	assert.equal(resolveQuickBranch(list, {}, "refs/heads/origin/main").choice?.refname, "refs/heads/origin/main");
	assert.equal(resolveQuickBranch(list, {}, "origin/main [remote]").choice?.refname, "refs/remotes/origin/main");
});

test("with no explicit branch the last pick wins, else the listing's default", () => {
	const list = baseList();
	assert.deepEqual(resolveQuickBranch(list, { refname: "refs/heads/feature", label: "feature" }).choice, {
		refname: "refs/heads/feature",
		label: "feature",
	});
	assert.deepEqual(
		resolveQuickBranch(list, {}).choice,
		{ refname: "refs/heads/main", label: "main (current)" },
		"the guessed default is the current branch, labelled as the menu would",
	);
	// A remembered refname with no label (state written by hand) still resolves.
	assert.deepEqual(resolveQuickBranch(list, { refname: "refs/heads/feature" }).choice, {
		refname: "refs/heads/feature",
		label: "refs/heads/feature",
	});
});

test("a detached HEAD is the guessed default, and an empty repository has none", () => {
	const tip = "a".repeat(40);
	assert.deepEqual(resolveQuickBranch({ branches: [], detachedTip: tip }, {}).choice, {
		refname: tip,
		label: `HEAD (detached at ${tip.slice(0, 7)})`,
	});

	const empty = resolveQuickBranch({ branches: [] }, {});
	assert.equal(empty.choice, undefined);
	assert.match(empty.error ?? "", /no branch to browse/);
});

test("the explicit argument takes precedence over the last pick", () => {
	const picked = resolveQuickBranch(baseList(), { refname: "refs/heads/feature", label: "feature" }, "main");
	assert.deepEqual(picked.choice, { refname: "refs/heads/main", label: "main (current)" });
});
