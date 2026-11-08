// Static checks on the worktree skill, mirroring tmux-skill-socket.test.ts:
// the failures that actually happen are documentation drift (a future edit
// re-introducing a broken recipe), so pin the safe forms. Every assertion below
// traces to a failure reproduced in a scratch repo, not to a preference - a test
// that only checks a token appears passes just as happily on a broken recipe.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SKILL = readFileSync(path.join(REPO_ROOT, ".pi/skills/worktree/SKILL.md"), "utf8");
const GITIGNORE = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

test("worktree skill: ignore guard is exact-line and newline-safe", () => {
	assert.ok(SKILL.includes("grep -qxF '.worktrees/'"), "guard must match the exact line");
	// Appending to a file with no trailing newline glues the entry onto its last
	// line, yielding `node_modules.worktrees/`.
	assert.ok(SKILL.includes("tail -c 1 .gitignore"), "guard must add a newline first");
	assert.ok(GITIGNORE.includes(".worktrees/"), ".worktrees/ must be ignored");
});

test("worktree skill: never tells the agent to commit on dev", () => {
	assert.ok(!/commit that change on `dev`/.test(SKILL), "must not instruct committing on dev");
	assert.ok(SKILL.includes("feature branch off `dev`"), "must direct commits to a feature branch");
});

test("worktree skill: recipes resolve the main checkout, not the cwd", () => {
	// --show-toplevel inside a linked worktree is that worktree, so $WT becomes
	// <worktree>/.worktrees/<slug> and every command fails with "cannot change
	// to". Only Create's guard may use it, to compare the two roots.
	const toplevel = SKILL.match(/git rev-parse --show-toplevel/g) ?? [];
	assert.equal(toplevel.length, 1, "only Create's guard may use --show-toplevel");
	assert.ok(
		SKILL.includes("--path-format=absolute --git-common-dir"),
		"recipes must derive the main root from the common git dir",
	);
	assert.ok(SKILL.includes("while IFS= read -r wt"), "porcelain loop must use while read");
});

test("worktree skill: base check measures BASE against origin/dev", () => {
	assert.ok(SKILL.includes("git fetch origin"), "create must fetch first");
	assert.ok(SKILL.includes("origin/dev"), "default base should be origin/dev");
	// Comparing BASE to HEAD refuses a legitimate create whenever the main
	// checkout sits on `main`, which is behind `dev` by definition.
	assert.ok(
		!/--is-ancestor\s+"?\$BASE"?\s+HEAD/.test(SKILL),
		"must not compare BASE to HEAD",
	);
	assert.ok(SKILL.includes('--is-ancestor origin/dev "$BASE"'), "must compare BASE to origin/dev");
	assert.ok(SKILL.includes('"origin/$BASE^{commit}"'), "must accept a remote-only base name");
	assert.ok(SKILL.includes("--track"), "remote-tracking checkout must use -b ... --track");
});

test("worktree skill: removal never runs the force delete unconditionally", () => {
	// A block with both lines deletes a dirty tree, and the edit in it, on paste
	// (line 1 fails, line 2 succeeds) while still exiting 0.
	assert.ok(!/^git worktree remove -f/m.test(SKILL), "the force removal must stay commented out");
	assert.ok(SKILL.includes('git worktree remove "$WT"'), "must try the safe removal first");
	assert.ok(SKILL.includes("kill-session"), "removal must stop tmux sessions rooted in the tree");
	// A space in the repo root makes `$2` match nothing, leaking the session.
	assert.ok(SKILL.includes("awk -F'\\t'"), "session sweep must split on a tab, not a space");
	assert.ok(SKILL.includes("prune -n"), "removal must dry-run prune");
});

test("worktree skill: end-state check defines SLUG", () => {
	// `git branch --list ""` prints nothing and exits 0, so an unset SLUG makes
	// "must print nothing" vacuously true.
	assert.ok(
		SKILL.includes('SLUG="task-name"\ngit worktree list'),
		"the end-state block must set SLUG",
	);
	assert.ok(SKILL.includes('git branch --list "$SLUG"'), "end state must check the branch");
});

test("worktree skill: attach command is expanded and verified", () => {
	assert.ok(SKILL.includes('NAME="pi-wt-$(printf'), "attach command must use the sanitized name");
	// Sanitizing maps feature/x and feature-x to one name, so the existing
	// session branch must verify the pane path too, not just the new one.
	const openBlock = SKILL.slice(
		SKILL.indexOf("Persistent shell (tmux)"),
		SKILL.indexOf("Then tell the user the expanded attach command"),
	);
	const paneChecks = openBlock.match(/#\{pane_current_path\}/g) ?? [];
	assert.equal(paneChecks.length, 2, "both the existing-session and new-session paths must be verified");
});

test("worktree skill: settings and todos caveats are documented", () => {
	assert.ok(SKILL.includes(".pi/settings.json"), "must note project settings are gitignored");
	assert.ok(SKILL.includes("per-cwd") || SKILL.includes("per cwd"), "must note todos are per-cwd");
});

test("worktree skill: git clean advice names the form that actually deletes", () => {
	// `git clean -xdf` skips a linked worktree as a nested repository; only
	// -xdff recurses into it.
	assert.ok(SKILL.includes("-xdff"), "only -xdff deletes linked worktrees");
});

test("worktree skill: the subagent recipe resolves the worktree root", () => {
	const openBlock = SKILL.slice(SKILL.indexOf("## Open"), SKILL.indexOf("## Review"));
	// A hardcoded /workspace pins the recipe to one machine's clone, and a
	// worktree cwd is what surfaced the extension flag conflict below.
	assert.ok(!/cwd: "\/workspace/.test(openBlock), "the subagent cwd must not hardcode /workspace");
	assert.ok(
		openBlock.includes("--path-format=absolute --git-common-dir"),
		"the recipe must resolve the root the way every other recipe does",
	);
	assert.ok(openBlock.includes('echo "$WT"'), "the recipe must print the resolved path to pass as cwd");
	assert.ok(openBlock.includes('cwd: "<the path printed above>"'), "the expanded path is what cwd takes");
});

test("worktree skill: names the extension conflict a worktree cwd used to cause", () => {
	// The parent only reports "Child Pi exited before reporting a result", so the
	// pane text is the only thing that identifies this failure.
	assert.ok(SKILL.includes('Flag "--attach-subagent" conflicts with'), "must quote the error a reader sees");
	assert.ok(
		SKILL.includes("cd` into the worktree inside each command"),
		"must give the workaround for a checkout without the launcher fix",
	);
});
