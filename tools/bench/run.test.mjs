// Tests for tools/bench/run.mjs's workspace resolution, through the CLI.
//
// Risk covered: every task file hardcoded one machine's agent directory as its
// `repo`, so the recorded set ran nowhere else — not in this repository's own
// container, not on CI — while the README promised a `--repo` override the
// runner did not have. So the contract asserted here is the CLI's: what the
// effective repo is, which of `--repo` / the task's own field wins, and which
// broken workspace the runner refuses to run rather than quietly skipping.
//
// Resolution is asserted on `--list` because that is the catalogue view: it
// prints and exits without touching the filesystem, which is why it works before
// the fixture worktrees exist (they do not exist in a fresh checkout). The
// failure cases are asserted on `--dry-run`, which resolves *and* validates —
// the same preflight a real run uses, so the assertion covers what a real run
// would do without spending a token. Nothing here starts a cell.
//
// Fixtures are real `git init` repositories in the OS temp dir, under the same
// isolated git environment `tools/branch-base.test.mjs` uses, so a developer's
// own git config cannot change the answer.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRepo } from "./lib/tasks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const CLI = path.join(HERE, "run.mjs");

const SCRATCH = [];
after(() => {
	for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix) {
	const dir = mkdtempSync(path.join(os.tmpdir(), `bench-run-${prefix}-`));
	SCRATCH.push(dir);
	return dir;
}

// Deterministic, isolated git: no user config, no credential prompts, fixed
// identity, and no inherited GIT_* variable pointing at the wrong repository.
function isolatedEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "bench run test",
		GIT_AUTHOR_EMAIL: "bench-run@example.invalid",
		GIT_COMMITTER_NAME: "bench run test",
		GIT_COMMITTER_EMAIL: "bench-run@example.invalid",
	};
}

const ENV = isolatedEnv();

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A clean git work tree with one commit — the shape `--repo` must accept. */
function cleanRepo() {
	const dir = scratchDir("clean");
	git(dir, "init", "-q");
	writeFileSync(path.join(dir, "README.md"), "# fixture\n");
	git(dir, "add", "README.md");
	git(dir, "commit", "-q", "-m", "fixture");
	return dir;
}

function run(args) {
	const result = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: ENV });
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `--list` prints `id\trepo\ttimeout ms` per task, then one `models\t...` line. */
function listRows(stdout) {
	const rows = new Map();
	for (const line of stdout.split("\n")) {
		const cells = line.split("\t");
		if (cells.length >= 3 && cells[0] !== "models") rows.set(cells[0], { repo: cells[1], timeoutMs: cells[2] });
	}
	return rows;
}

// A fresh --out per run: without one, a stored result under the default
// tools/bench/results would put the head-hash cell in skip scope, and the
// preflight refusals below assert on cells that will actually run.
function dryRunArgs() {
	return ["--state", "baseline", "--tasks", "head-hash", "--models", "deepseek-v4.1-flash", "--dry-run", "--out", scratchDir("dry-run-out")];
}

test("every recorded task repo resolves inside this repository, not one machine's agent directory", () => {
	const { status, stdout, stderr } = run(["--list"]);
	assert.equal(status, 0, stderr);
	const rows = listRows(stdout);
	assert.equal(rows.size, 14, "expected all 14 task definitions");

	for (const [id, row] of rows) {
		assert.ok(path.isAbsolute(row.repo), `${id}: ${row.repo} is not absolute`);
		assert.ok(
			row.repo === REPO_ROOT || row.repo.startsWith(`${REPO_ROOT}${path.sep}`),
			`${id} resolves outside the repository (${row.repo}), so the recorded set is not portable`,
		);
	}

	// The relative form, resolved: the same two fixture worktrees the tasks mean.
	assert.equal(rows.get("head-hash").repo, path.join(REPO_ROOT, ".worktrees", "bench-fixture"));
	assert.equal(rows.get("count-extensions").repo, path.join(REPO_ROOT, ".worktrees", "bench-fixture"));
	assert.equal(rows.get("tdd-cli-flag").repo, path.join(REPO_ROOT, ".worktrees", "bench-tdd-baseline"));
});

test("--list shows the effective repo, and --repo wins over every task's own field", () => {
	const override = cleanRepo();
	const { status, stdout, stderr } = run(["--list", "--repo", override]);
	assert.equal(status, 0, stderr);
	const rows = listRows(stdout);
	assert.equal(rows.size, 14);
	for (const [id, row] of rows) assert.equal(row.repo, override, `${id} did not take the --repo override`);
});

test("resolveRepo: --repo wins, an absolute field is kept, a relative one resolves against the repo root", () => {
	assert.equal(
		resolveRepo(".worktrees/bench-fixture", { repoOverride: "/tmp/override", repoRoot: "/repo" }),
		path.resolve("/tmp/override"),
		"--repo did not win over a relative task repo",
	);
	assert.equal(
		resolveRepo("/elsewhere/bench-fixture", { repoOverride: "/tmp/override", repoRoot: "/repo" }),
		path.resolve("/tmp/override"),
		"--repo did not win over an absolute task repo",
	);
	assert.equal(resolveRepo(".worktrees/bench-fixture", { repoRoot: "/repo" }), path.resolve("/repo/.worktrees/bench-fixture"));
	assert.equal(resolveRepo("/elsewhere/bench-fixture", { repoRoot: "/repo" }), path.resolve("/elsewhere/bench-fixture"));
});

test("--dry-run prints the resolved repo for every cell", () => {
	const override = cleanRepo();
	const { status, stdout, stderr } = run([...dryRunArgs(), "--repo", override]);
	assert.equal(status, 0, stderr);
	assert.ok(stdout.includes(`\thead-hash\t${override}`), `dry-run did not print the resolved repo:\n${stdout}`);
	assert.match(stdout, /1 cell\(s\)/);
});

test("a --repo that does not exist exits non-zero, naming the task and the fix", () => {
	const missing = path.join(scratchDir("missing"), "not-there");
	const { status, stderr } = run([...dryRunArgs(), "--repo", missing]);
	assert.equal(status, 1, "a missing repo must fail the run, not skip the cell");
	assert.ok(stderr.includes("head-hash"), `stderr does not name the task:\n${stderr}`);
	assert.ok(stderr.includes(missing), `stderr does not name the path:\n${stderr}`);
	assert.match(stderr, /does not exist/);
	assert.ok(stderr.includes("--repo"), `stderr does not name the --repo fix:\n${stderr}`);
});

test("a --repo that is not inside a git work tree exits non-zero, naming the task and the fix", () => {
	const plain = scratchDir("plain");
	const { status, stderr } = run([...dryRunArgs(), "--repo", plain]);
	assert.equal(status, 1, "a non-git repo must fail the run, not skip the cell");
	assert.ok(stderr.includes("head-hash"), `stderr does not name the task:\n${stderr}`);
	assert.ok(stderr.includes(plain), `stderr does not name the path:\n${stderr}`);
	assert.match(stderr, /not inside a git work tree/);
	assert.match(stderr, /--repo/);
});

test("a dirty --repo exits non-zero unless --allow-dirty, naming the task and the fix", () => {
	const dirty = cleanRepo();
	writeFileSync(path.join(dirty, "scratch.txt"), "uncommitted\n");

	const refused = run([...dryRunArgs(), "--repo", dirty]);
	assert.equal(refused.status, 1, "a dirty repo must fail the run, not skip the cell");
	assert.ok(refused.stderr.includes("head-hash"), `stderr does not name the task:\n${refused.stderr}`);
	assert.match(refused.stderr, /dirty/);
	assert.ok(refused.stderr.includes("--allow-dirty"), `stderr does not name the --allow-dirty fix:\n${refused.stderr}`);

	const allowed = run([...dryRunArgs(), "--repo", dirty, "--allow-dirty"]);
	assert.equal(allowed.status, 0, allowed.stderr);
});

test("--repo requires a value", () => {
	const { status, stderr } = run(["--state", "baseline", "--repo"]);
	assert.equal(status, 1);
	assert.match(stderr, /--repo needs a value/);
});

// --- allowDirty: the devc tasks run in the checkout being edited ---

const DRY_RUN_DEVC = ["--state", "baseline", "--tasks", "devc-doctor", "--models", "deepseek-v4.1-flash", "--dry-run"];

test("a task with allowDirty runs --dry-run in a dirty repo without --allow-dirty", () => {
	// The devc tasks read nothing from their workspace, but their preflight
	// checked the checkout the operator is editing, so --tasks all refused
	// while that checkout was dirty. The field is what exempts them; the
	// --out keeps stored results from skipping the cell, and --repo points the
	// recorded task at a disposable dirty fixture instead of this checkout.
	const dirty = cleanRepo();
	writeFileSync(path.join(dirty, "scratch.txt"), "uncommitted\n");
	const out = scratchDir("allow-dirty-out");

	const { status, stderr } = run([...DRY_RUN_DEVC, "--out", out, "--repo", dirty]);
	assert.equal(status, 0, `a task that opted into a dirty repo must not be refused:\n${stderr}`);
	assert.ok(stderr === "", stderr);
});

test("the two devc tasks record allowDirty: true because their repo is the checkout being edited", () => {
	for (const id of ["devc-doctor", "devc-ls"]) {
		const task = JSON.parse(readFileSync(path.join(HERE, "tasks", `${id}.json`), "utf8"));
		assert.equal(task.repo, ".", `${id} is expected to run against the repository root`);
		assert.equal(task.allowDirty, true, `${id} must set "allowDirty": true, or --tasks all refuses while the checkout is dirty`);
	}
});

// --- preflight scope: only cells that will actually run (v1.15.1 finding F3) ---

const MODEL_DIR = encodeURIComponent("opencode-go/deepseek-v4.1-flash");

function storeResult(out, task, modelDir, value = {}) {
	mkdirSync(path.join(out, "baseline", modelDir), { recursive: true });
	writeFileSync(path.join(out, "baseline", modelDir, `${task}.json`), `${JSON.stringify(value)}\n`);
}

test("a cell whose result already exists is skipped without preflighting its repo", () => {
	// A resumed grid holds stored results for tasks whose repo has since gone
	// missing or dirty; re-running the invocation with the default --tasks all
	// must skip those cells, not fail on repos the cells will never use. The
	// stored result is faked with --out rather than by editing tools/bench/results,
	// and --repo points at a path that does not exist, so a preflight would
	// refuse and the skip is provable only if the refusal is gone.
	const out = scratchDir("preflight-out");
	storeResult(out, "head-hash", MODEL_DIR);
	const missing = path.join(scratchDir("missing-repo"), "not-there");

	const skipped = run([...dryRunArgs(), "--out", out, "--repo", missing]);
	assert.equal(skipped.status, 0, `a stored result must cover the cell without preflighting its repo:\n${skipped.stderr}`);
	assert.ok(skipped.stdout.includes("skip"), `the skipped cell must be reported as skipped:\n${skipped.stdout}`);

	// --force rewrites the cell, so its repo is back in scope and the refusal
	// must return: preflighting late would mean discovering the bad workspace
	// only when the cell starts.
	const forced = run([...dryRunArgs(), "--out", out, "--repo", missing, "--force"]);
	assert.equal(forced.status, 1, "--force puts the cell back in preflight scope");
	assert.ok(forced.stderr.includes("head-hash"), forced.stderr);
});

test("a task that will run still fails the invocation on a bad repo before any cell starts", () => {
	// No --dry-run here: the refusal is the same preflight, and it must fire
	// before the first cell rather than when the cell comes up. Nothing spawns:
	// the bad repo is caught before a token is spent.
	const missing = path.join(scratchDir("bad-repo"), "not-there");
	const out = scratchDir("bad-repo-out");
	const { status, stderr } = run([
		"--state", "baseline", "--tasks", "head-hash", "--models", "deepseek-v4.1-flash", "--out", out, "--repo", missing,
	]);
	assert.equal(status, 1, "a cell that will run must still be preflighted");
	assert.ok(stderr.includes("head-hash"), `stderr does not name the task:\n${stderr}`);
	assert.match(stderr, /does not exist/);
});
