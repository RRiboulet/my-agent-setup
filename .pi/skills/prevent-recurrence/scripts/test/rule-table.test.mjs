// Tests for the rule-table checker.
//
// The contract is the process: an exit code, a human line per violation, and one
// JSON object under --json. So every test spawns the CLI the way a project's gate
// would, rather than importing a function that could pass while the binary fails.
//
// Fixtures under ./fixtures cover the rejection classes the checker documents.
// Cases that need a git repository — a linked worktree, resolved refs, and the
// no-git degrade — are built in a temporary directory at test time, because a
// worktree cannot be committed inside the repository it belongs to.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "rule-table.mjs");
const FIXTURES = path.join(HERE, "fixtures");

const HAS_GIT = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

const scratch = [];

function scratchDir(label) {
	const dir = mkdtempSync(path.join(os.tmpdir(), `rule-table-${label}-`));
	scratch.push(dir);
	return dir;
}

after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function run(args, options = {}) {
	const result = spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: options.env ?? process.env,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// A scratch directory can sit inside a repository when TMPDIR points into one,
// which would make the checker resolve refs the test wants left unresolved. The
// ceiling makes git stop at the directory's parent instead of trusting whatever
// happens to be above TMPDIR.
function noGitEnv(dir) {
	return { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
}

function check(target, extra = [], options = {}) {
	return run(["check", ...extra, target], options);
}

function fixture(name) {
	return path.join(FIXTURES, name, "AGENTS.md");
}

function checkFixture(name, extra = []) {
	return check(fixture(name), extra);
}

function jsonOf(result) {
	assert.equal(result.stderr, "", "only usage errors write to stderr");
	return JSON.parse(result.stdout);
}

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "rule-table test",
	GIT_AUTHOR_EMAIL: "rule-table@example.invalid",
	GIT_COMMITTER_NAME: "rule-table test",
	GIT_COMMITTER_EMAIL: "rule-table@example.invalid",
};

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(dir) {
	git(dir, ["init", "-q"]);
	git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
}

function commit(dir, subject) {
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", subject]);
}

// The table shape the checker documents, so a fixture reads as a table rather
// than as escaped pipes.
function agentsMd(rows) {
	const lines = [
		"# AGENTS.md",
		"",
		"## Rules and enforcement",
		"",
		"| Rule | Level | Enforced by | Proof |",
		"|---|---|---|---|",
		...rows.map((cells) => `| ${cells.join(" | ")} |`),
	];
	return `${lines.join("\n")}\n`;
}

const SNIPPET_ROW = [
	"Groundedness keeps the first violating draft",
	"test",
	"`node --test`",
	"bad=50a8260 good=7f3c5de",
];

// ---------------------------------------------------------------------------
// The valid fixture
// ---------------------------------------------------------------------------

test("a valid table exits 0 and reports its row count", () => {
	const result = checkFixture("valid");

	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout.trim(), `${fixture("valid")}: 4 rule rows valid`);
});

test("--json output has stable fields", () => {
	const result = checkFixture("valid", ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);

	const report = jsonOf(result);
	assert.deepEqual(Object.keys(report).sort(), [
		"checker",
		"git",
		"ok",
		"path",
		"rows",
		"summary",
		"version",
		"violations",
	]);
	assert.equal(report.checker, "rule-table");
	assert.equal(report.version, 1);
	assert.equal(report.path, fixture("valid"));
	assert.equal(report.ok, true);
	assert.equal(report.git, true, "the fixtures live in this repository's work tree");
	assert.deepEqual(report.violations, []);
	assert.deepEqual(report.summary, { rows: 4, violations: 0 });

	assert.equal(report.rows.length, 4);
	assert.deepEqual(Object.keys(report.rows[0]).sort(), [
		"enforcedBy",
		"level",
		"line",
		"proof",
		"row",
		"rule",
	]);
	assert.deepEqual(
		report.rows.map((row) => row.level),
		["architecture", "lint", "test", "prose"],
	);
	assert.deepEqual(
		report.rows.map((row) => row.row),
		[1, 2, 3, 4],
	);
	for (const row of report.rows) {
		assert.equal(typeof row.line, "number");
		assert.equal(typeof row.rule, "string");
		assert.equal(typeof row.enforcedBy, "string");
		assert.equal(typeof row.proof, "string");
	}
});

// ---------------------------------------------------------------------------
// Rejection classes: one fixture each, one violation each
// ---------------------------------------------------------------------------

const REJECTIONS = [
	{
		fixture: "missing-column",
		code: "missing-column",
		row: null,
		message: /missing required column "Proof"/,
	},
	{
		fixture: "unknown-level",
		code: "unknown-level",
		row: 2,
		message: /level "review" is not one of architecture, type, lint, test, prose/,
	},
	{
		fixture: "empty-enforcer",
		code: "empty-enforcer",
		row: 2,
		message: /"Enforced by" is empty/,
	},
	{
		fixture: "missing-proof-path",
		code: "proof-missing",
		row: 2,
		message: /proof\/missing\.md does not exist/,
	},
	{
		fixture: "proof-directory",
		code: "proof-not-file",
		row: 1,
		message: /is not a file/,
	},
	{
		fixture: "duplicate-rule",
		code: "duplicate-rule",
		row: 2,
		message: /rule duplicates row 1/,
	},
	{
		fixture: "prose-without-judgment",
		code: "prose-without-judgment",
		row: 2,
		message: /needs "judgment: <reason>"/,
	},
	{
		fixture: "prose-placeholder-judgment",
		code: "prose-without-judgment",
		row: 2,
		message: /needs "judgment: <reason>".*got "judgment: -"/,
	},
	{
		fixture: "second-table",
		code: "content-after-table",
		row: null,
		message: /a second table starts after the rule table/,
	},
	{
		fixture: "row-missing-pipe",
		code: "row-missing-pipe",
		row: null,
		message: /table rows start with '\|'/,
	},
	{
		fixture: "separator-count",
		code: "separator-count",
		row: null,
		message: /the separator has 2 cells but the header has 4/,
	},
	{
		fixture: "proof-mixed",
		code: "proof-mixed",
		row: 1,
		message: /use one proof form/,
	},
	{
		fixture: "pair-comma",
		code: "proof-format",
		row: 1,
		message: /must be exactly bad=<ref> good=<ref> separated by whitespace/,
	},
];

for (const rejection of REJECTIONS) {
	test(`rejects ${rejection.fixture} with a row-specific message`, () => {
		const target = fixture(rejection.fixture);
		const result = checkFixture(rejection.fixture, ["--json"]);
		assert.equal(result.code, 1, result.stdout + result.stderr);

		const report = jsonOf(result);
		assert.equal(report.ok, false);
		assert.equal(report.violations.length, 1, JSON.stringify(report.violations));

		const [violation] = report.violations;
		assert.equal(violation.code, rejection.code);
		assert.equal(violation.row, rejection.row);
		assert.equal(typeof violation.line, "number");
		assert.match(violation.message, rejection.message);

		const human = checkFixture(rejection.fixture);
		assert.equal(human.code, 1);
		const where =
			rejection.row === null
				? `${target}:${violation.line}: ${rejection.code}: `
				: `${target}:${violation.line}: row ${rejection.row}: ${rejection.code}: `;
		assert.ok(
			human.stdout.startsWith(where),
			`expected a line starting with "${where}", got "${human.stdout}"`,
		);
		assert.equal(human.stderr, "");
	});
}

// ---------------------------------------------------------------------------
// Usage errors
// ---------------------------------------------------------------------------

const USAGE_ERRORS = [
	{ label: "no arguments", args: [], reason: /missing command/ },
	{ label: "check without a path", args: ["check"], reason: /needs the path to an AGENTS\.md/ },
	{
		label: "an unknown option",
		args: ["check", "--nope", fixture("valid")],
		reason: /unknown option: --nope/,
	},
	{
		label: "an unknown command",
		args: ["validate", fixture("valid")],
		reason: /unknown command: validate/,
	},
	{
		label: "two paths",
		args: ["check", fixture("valid"), fixture("unknown-level")],
		reason: /takes one path, got 2/,
	},
	{
		label: "a missing file",
		args: ["check", path.join(FIXTURES, "valid", "nope.md")],
		reason: /no such file or directory/,
	},
	{
		label: "a directory",
		args: ["check", path.join(FIXTURES, "valid")],
		reason: /is a directory/,
	},
];

for (const usage of USAGE_ERRORS) {
	test(`exits 2 on ${usage.label}`, () => {
		const result = run(usage.args);
		assert.equal(result.code, 2, result.stdout + result.stderr);
		assert.equal(result.stdout, "", "a usage error prints no report");
		assert.match(result.stderr, /^rule-table\.mjs: /);
		assert.match(result.stderr, usage.reason);
		assert.match(result.stderr, /usage: rule-table\.mjs check/);
	});
}

test("--help documents the table format and the exit codes", () => {
	for (const flag of ["--help", "-h"]) {
		const result = run([flag]);
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /^rule-table\.mjs — validate/);
		assert.ok(result.stdout.includes("## Rules and enforcement"));
		assert.ok(result.stdout.includes("bad=<ref> good=<ref>"));
		assert.ok(result.stdout.includes("architecture, type, lint, test, prose"));
		assert.ok(result.stdout.includes("judgment: <reason>"));
		assert.ok(result.stdout.includes("0  the table is valid"));
		assert.ok(result.stdout.includes(".pi/skills/prevent-recurrence/references/rule-table.md"));
	}
});

test("--json output stays machine-readable on a violation", () => {
	const result = checkFixture("unknown-level", ["--json"]);
	assert.equal(result.code, 1);
	assert.equal(result.stderr, "");
	const report = jsonOf(result);
	assert.equal(report.ok, false);
	assert.deepEqual(Object.keys(report).sort(), [
		"checker",
		"git",
		"ok",
		"path",
		"rows",
		"summary",
		"version",
		"violations",
	]);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["unknown-level"],
	);
});

// ---------------------------------------------------------------------------
// Snippet proof: no git, then git
// ---------------------------------------------------------------------------

test("a directory without git history accepts a bad/good snippet proof", () => {
	const dir = scratchDir("no-git");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, agentsMd([SNIPPET_ROW]));

	const env = noGitEnv(dir);
	const insideWorkTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: dir,
		encoding: "utf8",
		env,
	});
	assert.notEqual(insideWorkTree.status, 0, `git discovery should stop at ${dir}`);

	const result = check(target, ["--json"], { env });
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const report = jsonOf(result);
	assert.equal(report.git, false, "the checker must say it did not resolve the refs");
	assert.equal(report.ok, true);
});

test("a snippet proof needs both refs", () => {
	const dir = scratchDir("half-ref");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		agentsMd([["Groundedness keeps the first violating draft", "test", "`node --test`", "bad=50a8260"]]),
	);

	const result = check(target, ["--json"], { env: noGitEnv(dir) });
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-format"],
	);
	assert.match(report.violations[0].message, /must be exactly bad=<ref> good=<ref> separated by whitespace/);
});

test("a malformed snippet ref fails without git", () => {
	const dir = scratchDir("bad-ref-format");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		agentsMd([["Groundedness keeps the first violating draft", "test", "`node --test`", "bad=ba..d good=7f3c5de"]]),
	);

	const result = check(target, ["--json"], { env: noGitEnv(dir) });
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-ref-invalid"],
	);
	assert.match(report.violations[0].message, /bad=ba\.\.d is not a valid git ref name/);
});

test("a proof that is neither a path nor a snippet pair is rejected", () => {
	const dir = scratchDir("no-proof-form");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, agentsMd([["The suite runs", "test", "`node --test`", "see the review"]]));

	const result = check(target, ["--json"], { env: noGitEnv(dir) });
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-format"],
	);
});

test("a git work tree resolves the snippet refs", { skip: !HAS_GIT }, () => {
	const repo = scratchDir("git-refs");
	initRepo(repo);
	writeFileSync(path.join(repo, "a.txt"), "one\n");
	commit(repo, "one");
	const bad = git(repo, ["rev-parse", "HEAD"]);
	writeFileSync(path.join(repo, "a.txt"), "two\n");
	commit(repo, "two");
	const good = git(repo, ["rev-parse", "HEAD"]);

	writeFileSync(
		path.join(repo, "AGENTS.md"),
		agentsMd([["Groundedness keeps the first violating draft", "test", "`node --test`", `bad=${bad} good=${good}`]]),
	);
	const pass = check(path.join(repo, "AGENTS.md"), ["--json"]);
	assert.equal(pass.code, 0, pass.stdout + pass.stderr);
	assert.equal(jsonOf(pass).git, true);

	// A well-formed ref that does not exist is a violation, not a format error.
	writeFileSync(
		path.join(repo, "dead.md"),
		agentsMd([
			["Groundedness keeps the first violating draft", "test", "`node --test`", `bad=deadbeef good=${good}`],
		]),
	);
	const fail = check(path.join(repo, "dead.md"), ["--json"]);
	assert.equal(fail.code, 1);
	const report = jsonOf(fail);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-ref-missing"],
	);
	assert.match(report.violations[0].message, /bad=deadbeef does not resolve to a commit/);
});

test("a linked worktree resolves proofs from the worktree root", { skip: !HAS_GIT }, () => {
	const base = scratchDir("worktree");
	const main = path.join(base, "main");
	mkdirSync(main);
	initRepo(main);
	writeFileSync(path.join(main, "README.md"), "main checkout\n");
	commit(main, "one");

	const worktree = path.join(base, "worktree");
	git(main, ["worktree", "add", "-q", worktree, "HEAD"]);

	mkdirSync(path.join(worktree, "proof"));
	writeFileSync(path.join(worktree, "proof", "proof.md"), "the check that fails on the bad revision\n");
	writeFileSync(
		path.join(worktree, "AGENTS.md"),
		agentsMd([["Groundedness keeps the first violating draft", "test", "`node --test`", "`proof/proof.md`"]]),
	);

	// The main checkout has no proof/proof.md, so a checker that resolved from
	// the main checkout instead of the worktree would report proof-missing.
	assert.equal(existsSync(path.join(main, "proof", "proof.md")), false);

	const result = check(path.join(worktree, "AGENTS.md"), ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const report = jsonOf(result);
	assert.equal(report.ok, true);
	assert.equal(report.path, path.join(worktree, "AGENTS.md"));
	assert.equal(report.git, true);
});

test("a fresh git repository with no commits checks the refs' format only", { skip: !HAS_GIT }, () => {
	const repo = scratchDir("fresh-git");
	initRepo(repo);
	writeFileSync(
		path.join(repo, "AGENTS.md"),
		agentsMd([
			["Groundedness keeps the first violating draft", "test", "`node --test`", "bad=abc good=def"],
		]),
	);

	const result = check(path.join(repo, "AGENTS.md"), ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const report = jsonOf(result);
	assert.equal(report.ok, true);
	assert.equal(report.git, false, "a work tree with no commits cannot resolve a ref");
});

test("a work tree where git init has not chosen a branch is also format-only", { skip: !HAS_GIT }, () => {
	// No symbolic-ref and no commits: HEAD is unborn, which is the other way a
	// fresh repository can look.
	const repo = scratchDir("fresh-git-unborn");
	git(repo, ["init", "-q"]);
	writeFileSync(
		path.join(repo, "AGENTS.md"),
		agentsMd([
			["Groundedness keeps the first violating draft", "test", "`node --test`", "bad=abc good=def"],
		]),
	);

	const report = jsonOf(check(path.join(repo, "AGENTS.md"), ["--json"]));
	assert.equal(report.git, false);
});

// ---------------------------------------------------------------------------
// Structure: heading, table shape, duplicates, line endings
// ---------------------------------------------------------------------------

test("a heading inside a fenced block is an example, not the table", () => {
	const dir = scratchDir("fenced");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		["# AGENTS.md", "", "```markdown", agentsMd([SNIPPET_ROW]).trim(), "```", ""].join("\n"),
	);

	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["missing-heading"],
	);
});

test("a missing heading is a violation, not a usage error", () => {
	const dir = scratchDir("no-heading");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, "# AGENTS.md\n\nNo rules here.\n");

	const result = check(target, ["--json"]);
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["missing-heading"],
	);
	assert.match(report.violations[0].message, /no "## Rules and enforcement" heading/);
});

test("a heading with no table after it is a violation", () => {
	const dir = scratchDir("no-table");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, "# AGENTS.md\n\n## Rules and enforcement\n\nProse instead.\n");

	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["no-table"],
	);
});

test("a table without its separator row is a violation", () => {
	const dir = scratchDir("no-separator");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		["# AGENTS.md", "", "## Rules and enforcement", "", "| Rule | Level | Enforced by | Proof |", "| x | test | `node --test` | `README.md` |", ""].join("\n"),
	);

	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["no-separator"],
	);
});

test("an empty table is valid and reports zero rows", () => {
	const dir = scratchDir("empty-table");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, agentsMd([]));

	const result = check(target);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(result.stdout.trim(), `${target}: 0 rule rows valid`);
});

test("a row with the wrong number of cells is a violation", () => {
	const dir = scratchDir("column-count");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		["# AGENTS.md", "", "## Rules and enforcement", "", "| Rule | Level | Enforced by | Proof |", "|---|---|---|---|", "| x | test | `node --test` | `README.md` | extra |", ""].join("\n"),
	);

	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["column-count"],
	);
	assert.equal(report.violations[0].row, 1);
});

test("duplicate rules are compared after trimming, collapsing whitespace and case-folding", () => {
	const dir = scratchDir("duplicate-normalized");
	writeFileSync(path.join(dir, "README.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		agentsMd([
			["No   suppression to pass a new check", "lint", "`node --test`", "`README.md`"],
			["no suppression to pass a new check", "test", "`node --test`", "`README.md`"],
		]),
	);

	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["duplicate-rule"],
	);
	assert.equal(report.violations[0].row, 2);
});

test("a CRLF table parses the same as an LF table", () => {
	const dir = scratchDir("crlf");
	writeFileSync(path.join(dir, "proof.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		agentsMd([["The suite runs", "test", "`node --test`", "`proof.md`"]]).replace(/\n/g, "\r\n"),
	);

	const result = check(target, ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(jsonOf(result).rows.length, 1);
});

test("a proof may name more than one file, and each must exist", () => {
	const dir = scratchDir("multi-path");
	writeFileSync(path.join(dir, "a.md"), "a\n");
	writeFileSync(path.join(dir, "b.md"), "b\n");
	const target = path.join(dir, "AGENTS.md");

	writeFileSync(target, agentsMd([["The suite runs", "test", "`node --test`", "`a.md` and `b.md`"]]));
	assert.equal(check(target).code, 0);

	writeFileSync(target, agentsMd([["The suite runs", "test", "`node --test`", "`a.md` and `c.md`"]]));
	const report = jsonOf(check(target, ["--json"]));
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-missing"],
	);
	assert.match(report.violations[0].message, /c\.md does not exist/);
});

// ---------------------------------------------------------------------------
// GFM-valid input is accepted
// ---------------------------------------------------------------------------

test("a double-backtick code span keeps a pipe inside one cell", () => {
	// `splitRow` used to toggle on every backtick, so ``a|b`` split into two
	// cells and a valid row failed column-count.
	const dir = scratchDir("double-backtick");
	writeFileSync(path.join(dir, "proof.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		agentsMd([["Double ``a|b`` span", "lint", "`node --test`", "`proof.md`"]]),
	);

	const result = check(target, ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	const report = jsonOf(result);
	assert.equal(report.violations.length, 0);
	assert.equal(report.rows.length, 1);
	assert.equal(report.rows[0].rule, "Double ``a|b`` span");
});

test("a separator cell may hold a single hyphen", () => {
	const dir = scratchDir("single-dash-separator");
	writeFileSync(path.join(dir, "proof.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		[
			"# AGENTS.md",
			"",
			"## Rules and enforcement",
			"",
			"| Rule | Level | Enforced by | Proof |",
			"|-|-|-|-|",
			"| The suite runs | test | `node --test` | `proof.md` |",
			"",
		].join("\n"),
	);

	const result = check(target, ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(jsonOf(result).rows.length, 1);
});

test("the heading is found with one to three leading spaces", () => {
	for (const indent of [1, 2, 3]) {
		const dir = scratchDir(`indented-heading-${indent}`);
		writeFileSync(path.join(dir, "proof.md"), "proof\n");
		const target = path.join(dir, "AGENTS.md");
		writeFileSync(
			target,
			agentsMd([["The suite runs", "test", "`node --test`", "`proof.md`"]]).replace(
				"## Rules and enforcement",
				`${" ".repeat(indent)}## Rules and enforcement`,
			),
		);

		const result = check(target, ["--json"]);
		assert.equal(result.code, 0, `indent ${indent}: ${result.stdout}${result.stderr}`);
		assert.equal(jsonOf(result).rows.length, 1);
	}
});

test("a four-space-indented fence-like line does not hide the heading", () => {
	// Four spaces make an indented code block in CommonMark, not a fence, so the
	// heading after it is real. Treating it as a fence reported missing-heading.
	const dir = scratchDir("indented-fence");
	writeFileSync(path.join(dir, "proof.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		[
			"# AGENTS.md",
			"",
			"    ```",
			"",
			agentsMd([["The suite runs", "test", "`node --test`", "`proof.md`"]]).trim(),
			"",
		].join("\n"),
	);

	const result = check(target, ["--json"]);
	assert.equal(result.code, 0, result.stdout + result.stderr);
	assert.equal(jsonOf(result).rows.length, 1);
});

// ---------------------------------------------------------------------------
// Codes that were implemented but untested
// ---------------------------------------------------------------------------

test("an empty Proof cell is a violation", () => {
	const dir = scratchDir("proof-empty");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(target, agentsMd([["The suite runs", "test", "`node --test`", ""]]));

	const result = check(target, ["--json"]);
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["proof-empty"],
	);
	assert.equal(report.violations[0].row, 1);
});

test("a second rules heading is a violation", () => {
	const dir = scratchDir("duplicate-heading");
	writeFileSync(path.join(dir, "proof.md"), "proof\n");
	const target = path.join(dir, "AGENTS.md");
	writeFileSync(
		target,
		`${agentsMd([["The suite runs", "test", "`node --test`", "`proof.md`"]])}\n## Rules and enforcement\n\nMoved here by mistake.\n`,
	);

	const result = check(target, ["--json"]);
	assert.equal(result.code, 1);
	const report = jsonOf(result);
	assert.deepEqual(
		report.violations.map((violation) => violation.code),
		["duplicate-heading"],
	);
	assert.equal(report.violations[0].row, null);
});

// ---------------------------------------------------------------------------
// Strict snippet pairs
// ---------------------------------------------------------------------------

test("a reversed or trailing-prose snippet pair is rejected", () => {
	const dir = scratchDir("pair-strict");
	const target = path.join(dir, "AGENTS.md");

	for (const proof of [
		"good=7f3c5de bad=50a8260",
		"bad=50a8260 good=7f3c5de see the review",
		"bad=50a8260,good=7f3c5de",
	]) {
		writeFileSync(target, agentsMd([["The suite runs", "test", "`node --test`", proof]]));
		const report = jsonOf(check(target, ["--json"]));
		assert.deepEqual(
			report.violations.map((violation) => violation.code),
			["proof-format"],
			`proof "${proof}" should be rejected`,
		);
	}
});

test("judgment reasons must be a real reason, not a placeholder", () => {
	const dir = scratchDir("judgment-reason");
	const target = path.join(dir, "AGENTS.md");

	const cases = [
		{ enforcer: "judgment: -", code: "prose-without-judgment" },
		{ enforcer: "judgment: tba", code: "prose-without-judgment" },
		{ enforcer: "judgment: --", code: "prose-without-judgment" },
		{ enforcer: "judgment: tbd", code: "prose-without-judgment" },
		{ enforcer: "judgment:  ", code: "prose-without-judgment" },
		{ enforcer: "judgment: ownership is a human fact", code: null },
		{ enforcer: "judgment: the maintainer reads it", code: null },
	];

	for (const sample of cases) {
		writeFileSync(
			target,
			agentsMd([["Every rule has a named owner", "prose", sample.enforcer, "`proof.md`"]]),
		);
		writeFileSync(path.join(dir, "proof.md"), "proof\n");

		const result = check(target, ["--json"]);
		const codes = jsonOf(result).violations.map((violation) => violation.code);
		if (sample.code === null) {
			assert.equal(result.code, 0, `"${sample.enforcer}" should pass: ${JSON.stringify(codes)}`);
		} else {
			assert.deepEqual(codes, [sample.code], `"${sample.enforcer}" should be rejected`);
			assert.match(jsonOf(result).violations[0].message, /"judgment: <reason>"/);
		}
	}
});
