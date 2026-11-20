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
function run(cwd) {
	const env = { ...ENV, GIT_CEILING_DIRECTORIES: os.tmpdir() };
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
	assert.match(output, /^branch-base: behind-dev — not-started-yet has no commits of its own/);
	assert.match(output, /next: git rebase origin\/dev \(or start again with git checkout -b <change-name> origin\/dev\)$/);
	assert.doesNotMatch(output, /wrong-base/);
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
