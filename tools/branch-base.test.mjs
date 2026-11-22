// Tests for tools/branch-base.mjs.
//
// The contract is the process: an exit code and one line naming the
// classification, read the way CI and prove-it-works read it. So every test
// spawns the CLI against a real scratch repository rather than importing a
// function that could pass while the binary fails.
//
// Each fixture builds its own bare origin, a seed clone on `dev`, and a work
// clone, because the check is about refs: `origin/dev` has to be a real remote
// ref that the check's own fetch updates, not a stubbed SHA.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "branch-base.mjs");

// Deterministic, isolated git: no user config, no credential prompts, fixed
// identity. Inherited GIT_* variables are dropped, because a test process can
// carry GIT_DIR from a hook or a wrapper and would then act on the wrong repo.
function baseEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "branch-base test",
		GIT_AUTHOR_EMAIL: "branch-base@example.invalid",
		GIT_COMMITTER_NAME: "branch-base test",
		GIT_COMMITTER_EMAIL: "branch-base@example.invalid",
	};
}

const ENV = baseEnv();

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV, timeout: 60_000 });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`);
	return result.stdout.trim();
}

let fileCounter = 0;

/** A commit that changes one file, so two commits are never empty or identical. */
function commit(cwd, subject) {
	fileCounter += 1;
	writeFileSync(path.join(cwd, `change-${fileCounter}.txt`), `${subject}\n`);
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-qm", subject]);
}

const scratchRoots = [];

after(() => {
	for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * A scratch repository shaped like this one: a bare `origin`, `dev` as its
 * default and integration branch, `main` parked at the first commit so a branch
 * cut from it is behind `dev`, and a clone that tracks `origin/dev`.
 */
function scratch(label) {
	const root = mkdtempSync(path.join(os.tmpdir(), `branch-base-${label}-`));
	scratchRoots.push(root);

	const origin = path.join(root, "origin.git");
	git(root, ["init", "-q", "--bare", origin]);

	const seed = path.join(root, "seed");
	mkdirSync(seed);
	git(seed, ["init", "-q", "-b", "dev"]);
	writeFileSync(path.join(seed, "README.md"), "seed\n");
	git(seed, ["add", "-A"]);
	git(seed, ["commit", "-qm", "seed: origin/dev starts here"]);
	git(seed, ["remote", "add", "origin", origin]);
	git(seed, ["push", "-q", origin, "dev"]);
	// Releases live on main, so main exists and is behind dev by design.
	git(seed, ["push", "-q", origin, "dev:main"]);
	// A bare repo's HEAD still points at whatever `git init` defaulted to, so a
	// clone would check out nothing; point it at dev, the integration branch.
	git(origin, ["symbolic-ref", "HEAD", "refs/heads/dev"]);

	const work = path.join(root, "work");
	git(root, ["clone", "-q", origin, work]);

	return { root, origin, seed, work };
}

/**
 * Run the check with `cwd` inside a scratch tree. The ceiling is the temp
 * directory itself, so git never discovers a repository above it when TMPDIR
 * happens to sit inside one; the check then acts on the repository the test
 * means, and a plain directory with no repository above it still reads as one.
 */
function run(cwd, overrides = {}) {
	const env = { ...ENV, GIT_CEILING_DIRECTORIES: os.tmpdir(), ...overrides };
	const result = spawnSync(process.execPath, [CLI], { cwd, encoding: "utf8", env, timeout: 60_000 });
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The one classification line, asserting there is exactly one and stderr is quiet. */
function line(result) {
	const lines = result.stdout.split("\n").filter((entry) => entry !== "");
	assert.equal(lines.length, 1, `expected one line, got:\n${result.stdout}`);
	if (result.code === 0 || result.code === 1) {
		assert.equal(result.stderr, "", "a classification writes stdout, not stderr");
	}
	return lines[0];
}

// ---------------------------------------------------------------------------
// The three passing shapes
// ---------------------------------------------------------------------------

test("a branch cut from origin/dev with its own commits is correct", () => {
	const repo = scratch("correct");
	git(repo.work, ["checkout", "-q", "-b", "fix-a-typo"]);
	commit(repo.work, "fix: a typo");

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: correct — fix-a-typo descends from origin\/dev \([0-9a-f]{7}\)/);
	assert.match(output, /carries 1 commit of its own/);
	assert.match(output, /next: git push -u origin fix-a-typo && gh pr create --base dev --fill$/);
});

test("a branch is correct from a linked worktree and from a subdirectory", () => {
	const repo = scratch("worktree");
	const worktree = path.join(repo.root, "linked");
	git(repo.work, ["worktree", "add", "-q", "-b", "feature-linked", worktree]);
	commit(worktree, "feat: work in a linked worktree");
	const nested = path.join(worktree, "some", "nested", "directory");
	mkdirSync(nested, { recursive: true });

	const result = run(nested);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: correct — feature-linked descends from origin\/dev/);
});

test("HEAD being origin/dev itself is correct: dev has no base of its own", () => {
	const repo = scratch("on-dev");

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: correct — HEAD is exactly origin\/dev \([0-9a-f]{7}\)/);
	assert.match(output, /there is no branch base to check/);
	// The checkout IS the integration branch, so feature-branch advice — start a
	// branch for this changeset — is not what the line should say (v1.15.1
	// review finding: the changelog claimed this and the two dev paths below
	// still printed it).
	assert.doesNotMatch(output, /git checkout -b/);
	assert.match(output, /start the next change on a branch cut from origin\/dev/);
});

test("a detached HEAD that is origin/dev keeps the checkout-a-branch advice", () => {
	// Detached is a pull-request checkout, not the integration branch, so its
	// line is pinned byte-for-byte: the dev-specific wording above must not
	// leak into it.
	const repo = scratch("detached-equal");
	git(repo.work, ["checkout", "-q", "--detach"]);

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.match(line(result), /next: git checkout -b <change-name> origin\/dev$/);
});

test("dev with unpushed commits is correct and does not tell dev to open a PR into dev", () => {
	// Work landing directly on the integration branch is not a feature branch:
	// `gh pr create --base dev` would ask dev to review a pull request from dev
	// into dev, and "git checkout -b" would treat the work as a changeset that
	// needs one. dev's own commits reach the remote with a push; the release
	// flow in AGENTS.md is the only path to main.
	const repo = scratch("dev-ahead");
	commit(repo.work, "feat: work committed straight onto dev");

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: correct — dev descends from origin\/dev \([0-9a-f]{7}\) and carries 1 commit of its own/);
	assert.doesNotMatch(output, /gh pr create/);
	assert.doesNotMatch(output, /git checkout -b/);
	assert.match(output, /next: git push -u origin dev$/);
});

test("dev itself, with origin/dev one push ahead, is superseded rather than behind-dev", () => {
	// The race CI actually hit (run 44956803480, push event, commit 805e79e on
	// dev): the checkout is on `dev` and the next commit landed on origin/dev
	// while the run was still going. HEAD is then an ancestor of origin/dev, but
	// `dev` is the integration branch itself, so it has no base to be behind —
	// and "start a branch" is advice for a branch that needs a base.
	const repo = scratch("superseded");
	const head = git(repo.work, ["rev-parse", "HEAD"]);
	commit(repo.seed, "chore(release): the next commit lands while the run is going");
	git(repo.seed, ["push", "-q", "origin", "dev"]);
	const moved = git(repo.seed, ["rev-parse", "HEAD"]);

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(
		output,
		new RegExp(
			`^branch-base: superseded — dev is origin/dev's own branch: HEAD ${head.slice(0, 7)} is already contained in origin/dev ${moved.slice(0, 7)}`,
		),
	);
	assert.match(output, /a newer push landed while this run was still going/);
	assert.match(output, /there is no branch base to check/);
	assert.doesNotMatch(output, /git checkout -b/);
	assert.doesNotMatch(output, /behind-dev/);
});

test("two commits on a branch are correct and counted", () => {
	const repo = scratch("two-commits");
	git(repo.work, ["checkout", "-q", "-b", "two-changes"]);
	commit(repo.work, "feat: first");
	commit(repo.work, "feat: second");

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.match(line(result), /carries 2 commits of its own/);
});

// ---------------------------------------------------------------------------
// The three failing shapes
// ---------------------------------------------------------------------------

test("a branch cut from main is wrong-base and the line names the branch point", () => {
	const repo = scratch("wrong-base");
	// dev moves on, so main and dev no longer share their tip: this is exactly
	// the branch-off-main mistake AGENTS.md records.
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);

	git(repo.work, ["fetch", "-q", "origin"]);
	git(repo.work, ["checkout", "-q", "-b", "from-main", "origin/main"]);
	commit(repo.work, "feat: work stacked on main");

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: wrong-base — from-main does not descend from origin\/dev/);
	assert.match(output, /the branch point is [0-9a-f]{7} "seed: origin\/dev starts here"/);
	assert.match(output, /next: git rebase --onto origin\/dev [0-9a-f]{7} from-main$/);
});

test("a branch that merged dev in instead of rebasing onto it is foreign-commits", () => {
	const repo = scratch("foreign");
	git(repo.work, ["checkout", "-q", "-b", "feature-a"]);
	commit(repo.work, "feat(a): first");
	// dev moves on after the branch was cut.
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);
	// The branch merges dev in rather than rebasing onto it. origin/dev is now an
	// ancestor of HEAD, so the ancestor check passes, but the oldest commit the
	// branch carries still sits on the dev it was cut from — which is what the
	// parent test exists to see.
	git(repo.work, ["fetch", "-q", "origin"]);
	git(repo.work, ["merge", "-q", "--no-edit", "origin/dev"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: foreign-commits — the oldest commit on top of origin\/dev is [0-9a-f]{7} "feat\(a\): first"/);
	assert.match(output, /not origin\/dev [0-9a-f]{7}: the branch merged dev in instead of being rebased onto it/);
	assert.match(output, /next: git rebase --onto origin\/dev [0-9a-f]{7} feature-a, /);
});

test("a branch with no commits of its own that dev has moved past is behind-dev, not wrong-base", () => {
	const repo = scratch("behind");
	git(repo.work, ["checkout", "-q", "-b", "not-started-yet"]);
	// dev moves on after the branch was cut; the branch has nothing of its own.
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: behind-dev — not-started-yet adds no commit of its own/);
	assert.match(output, /next: git checkout -b <change-name> origin\/dev \(or git rebase origin\/dev to continue on this branch\)$/);
	assert.doesNotMatch(output, /wrong-base/);
});

test("a feature branch whose name merely starts with dev is still behind-dev", () => {
	// `superseded` is about the integration branch itself, so the comparison is
	// the whole branch name: a feature branch that happens to be called
	// `development` is behind origin/dev and stays a red build.
	const repo = scratch("dev-prefix");
	git(repo.work, ["checkout", "-q", "-b", "development"]);
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: behind-dev — development adds no commit of its own/);
	assert.doesNotMatch(output, /superseded/);
});

test("a detached HEAD that dev has moved past is still behind-dev", () => {
	// A pull-request checkout is detached and is not the integration branch, so
	// it keeps the classification the tool always gave it.
	const repo = scratch("detached-behind");
	git(repo.work, ["checkout", "-q", "--detach"]);
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: behind-dev — HEAD \(detached\) adds no commit of its own/);
	assert.doesNotMatch(output, /superseded/);
});

// ---------------------------------------------------------------------------
// Exit 2: the check could not run, so it says nothing about the branch
// ---------------------------------------------------------------------------

test("a repository with no origin/dev exits 2 with the fix", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "branch-base-no-origin-"));
	scratchRoots.push(root);
	git(root, ["init", "-q", "-b", "dev"]);
	commit(root, "chore: a commit with no remote");

	const result = run(root);
	assert.equal(result.code, 2, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^branch-base: cannot resolve origin\/dev in /);
	assert.match(result.stderr, /fetch origin dev/);
});

test("a directory outside any work tree exits 2", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "branch-base-no-repo-"));
	scratchRoots.push(root);

	const result = run(root);
	assert.equal(result.code, 2, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^branch-base: not a git work tree: /);
});

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

test("--help exits 0 without checking anything", () => {
	const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8", env: ENV });
	assert.equal(result.status, 0);
	assert.match(result.stdout, /^usage: node tools\/branch-base\.mjs/);
});

test("an unknown option exits 2 with the usage", () => {
	const result = spawnSync(process.execPath, [CLI, "--json"], { encoding: "utf8", env: ENV });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /unknown option: --json/);
	assert.match(result.stderr, /usage: node tools\/branch-base\.mjs/);
});

// ---------------------------------------------------------------------------
// Shapes a single "oldest commit" test cannot see (review findings 1-6)
// ---------------------------------------------------------------------------

test("a branch that merges another branch in is foreign-commits, not correct", () => {
	const repo = scratch("multi-root");
	git(repo.work, ["checkout", "-q", "-b", "feature-a"]);
	commit(repo.work, "feat(a): own commit");
	// feature-b is cut from the same dev tip, so every root of the range has
	// origin/dev as its parent — the shape an only-the-oldest-commit test calls
	// "correct" while the foreign commits ride along.
	git(repo.work, ["checkout", "-q", "-b", "feature-b", "origin/dev"]);
	commit(repo.work, "feat(b): foreign commit");
	git(repo.work, ["checkout", "-q", "feature-a"]);
	git(repo.work, ["merge", "-q", "--no-ff", "feature-b", "-m", "Merge feature-b"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: foreign-commits — feature-a carries 2 root commits in origin\/dev\.\.HEAD: /);
	assert.match(output, /"feat\(a\): own commit"/);
	assert.match(output, /"feat\(b\): foreign commit"/);
	assert.match(output, /only one lineage may sit on origin\/dev/);
	assert.match(output, /next: git log --oneline --graph origin\/dev\.\.HEAD/);
});

test("a failed fetch exits 2 instead of classifying against a stale origin\/dev", () => {
	const repo = scratch("stale-fetch");
	git(repo.work, ["checkout", "-q", "-b", "fresh"]);
	commit(repo.work, "feat: own commit");
	// dev moves on, then the remote becomes unreachable. The last known
	// origin/dev still resolves, which is exactly why a stale base must not pass.
	commit(repo.seed, "feat(dev): dev moves on");
	git(repo.seed, ["push", "-q", "origin", "dev"]);
	git(repo.work, ["remote", "set-url", "origin", path.join(repo.root, "gone.git")]);

	const result = run(repo.work);
	assert.equal(result.code, 2, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^branch-base: cannot refresh origin\/dev: /);
	assert.match(result.stderr, /may be stale, so this check cannot tell whether the base is right/);
});

test("a shallow clone exits 2 instead of calling a correct branch wrong-base", () => {
	const repo = scratch("shallow");
	git(repo.work, ["checkout", "-q", "-b", "shallow-me"]);
	commit(repo.work, "feat: own commit");
	git(repo.work, ["push", "-q", "origin", "shallow-me"]);

	const clone = path.join(repo.root, "shallow-clone");
	git(repo.root, ["clone", "-q", "--depth", "1", "-b", "shallow-me", `file://${repo.origin}`, clone]);

	const result = run(clone);
	assert.equal(result.code, 2, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /is a shallow clone, so its grafted history cannot say what descends from origin\/dev/);
	assert.match(result.stderr, /git fetch --unshallow/);
});

test("a branch with no common ancestor is wrong-base and says so", () => {
	const repo = scratch("unrelated");
	git(repo.work, ["checkout", "-q", "--orphan", "rogue"]);
	commit(repo.work, "feat: an unrelated root");

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: wrong-base — rogue does not descend from origin\/dev/);
	assert.match(output, /the branch point is no common ancestor with origin\/dev/);
	assert.match(output, /next: git rebase --onto origin\/dev <base> rogue$/);
});

test("a branch whose commits dev already has is behind-dev without claiming they do not exist", () => {
	const repo = scratch("merged");
	git(repo.work, ["checkout", "-q", "-b", "already-merged"]);
	commit(repo.work, "feat: about to be merged");
	git(repo.work, ["push", "-q", "origin", "already-merged"]);
	git(repo.seed, ["fetch", "-q", "origin"]);
	git(repo.seed, ["merge", "-q", "--no-ff", "-m", "Merge branch 'already-merged'", "origin/already-merged"]);
	git(repo.seed, ["push", "-q", "origin", "dev"]);

	const result = run(repo.work);
	assert.equal(result.code, 1, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: behind-dev — already-merged adds no commit of its own/);
	assert.match(output, /is already contained in origin\/dev/);
	assert.doesNotMatch(output, /has no commits of its own/);
});

test("a detached HEAD with its own commits is correct and does not suggest pushing HEAD", () => {
	const repo = scratch("detached");
	git(repo.work, ["checkout", "-q", "-b", "detach-me"]);
	commit(repo.work, "feat: own commit");
	git(repo.work, ["checkout", "-q", "--detach"]);

	const result = run(repo.work);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const output = line(result);
	assert.match(output, /^branch-base: correct — HEAD \(detached\) descends from origin\/dev/);
	assert.match(output, /git switch -c <change-name> to reattach/);
	assert.doesNotMatch(output, /git push -u origin HEAD/);
});

// ---------------------------------------------------------------------------
// Environment the check must not trust
// ---------------------------------------------------------------------------

test("an inherited GIT_DIR does not redirect the check to another repository", () => {
	const repo = scratch("git-dir");
	git(repo.work, ["checkout", "-q", "-b", "own-work"]);
	commit(repo.work, "feat: own commit");
	const elsewhere = scratch("git-dir-other");
	git(elsewhere.work, ["checkout", "-q", "-b", "other-work"]);
	commit(elsewhere.work, "feat: other commit");

	const result = run(repo.work, { GIT_DIR: path.join(elsewhere.work, ".git") });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.match(line(result), /own-work descends from origin\/dev/);
});

test("a repository whose HEAD has no commit exits 2", () => {
	const repo = scratch("unborn");
	git(repo.work, ["symbolic-ref", "HEAD", "refs/heads/not-created-yet"]);

	const result = run(repo.work);
	assert.equal(result.code, 2, result.stdout + result.stderr);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /has no HEAD commit to check/);
});

test("an argument that is not an option exits 2", () => {
	const result = spawnSync(process.execPath, [CLI, "unexpected"], { encoding: "utf8", env: ENV });
	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /takes no arguments, got unexpected/);
});
