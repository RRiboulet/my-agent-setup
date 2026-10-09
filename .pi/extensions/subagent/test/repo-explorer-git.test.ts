// Behavior tests for .pi/extensions/repo-explorer/git.ts — the read-only git
// plumbing behind /explore.
//
// These run the helpers against a real `git` binary and real repositories
// built in a temp directory: the plumbing's own output is the fixture.
// `listBranches`'s ordering, the per-branch tree cache keyed on the branch tip
// (reused when the tip holds, refetched when it moves), the binary/too-large
// refusals and the 2000-line transcript clip are all pinned here — they are
// the contracts the branch menu, the file browser and the print banner consume.
//
// The runner is injected, so every test observes exactly which git subcommands
// ran — that is how "cache hit → no second ls-tree" and "too-large → never
// fetched" are asserted, not by spying on anything.

import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import type { GitRunResult, GitRunner } from "../../repo-explorer/git.ts";
import { LINE_CAP, MAX_BLOB_BYTES, MAX_TEXT_BYTES, openGit, RepoGitError } from "../../repo-explorer/git.ts";

const execFileP = promisify(execFileCb);

/** A GitRunner backed by the real `git` binary that also records every argv, per test. */
function makeRunner() {
	const calls: string[][] = [];
	const run: GitRunner = async (args, cwd): Promise<GitRunResult> => {
		calls.push(args);
		try {
			const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
			return { stdout, stderr: "", code: 0, killed: false };
		} catch (err) {
			const failure = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
			return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1, killed: false };
		}
	};
	return {
		run,
		calls,
		count: (command: string) => calls.filter((argv) => argv[0] === command).length,
	};
}

/** Synchronous git against `gittest_identity` fixtures; used to build repositories, not by the code under test. */
function gitIn(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

let baseRoot = "";
let bigRoot = "";
/** Tip of `feature` before the cache-invalidation test moves it; restored afterwards. */
let featureOriginalTip = "";
let mainTip = "";

before(async () => {
	// The standard fixture: modules on `main`, an extra file only on
	// `feature`, remote-tracking refs for both, and origin/HEAD as a symbolic
	// ref pointing at origin/main (which must stay out of the branch list).
	baseRoot = await mkdtemp(path.join(tmpdir(), "repo-explorer-git-test-"));
	gitIn(baseRoot, "init", "-b", "main", "-q");
	gitIn(baseRoot, "config", "user.name", "Test Harness");
	gitIn(baseRoot, "config", "user.email", "test@harness.invalid");
	await mkdir(path.join(baseRoot, "assets"), { recursive: true });
	await mkdir(path.join(baseRoot, "src/lib"), { recursive: true });
	await mkdir(path.join(baseRoot, "docs"), { recursive: true });
	await writeFile(path.join(baseRoot, "README.md"), "root readme\n");
	await writeFile(path.join(baseRoot, "src/main.ts"), "export const main = 1;\n");
	await writeFile(path.join(baseRoot, "src/lib/depth.ts"), "export const deep = 2;\n");
	await writeFile(path.join(baseRoot, "docs/café América.txt"), "unicode path\n");
	await writeFile(path.join(baseRoot, "big.txt"), `${Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
	await writeFile(path.join(baseRoot, "empty.txt"), "");
	await writeFile(path.join(baseRoot, "corrupt.txt"), `before ${"\uFFFD"} after\n`);
	await writeFile(path.join(baseRoot, "minified.js"), "A".repeat(MAX_TEXT_BYTES + 1024));
	await writeFile(
		path.join(baseRoot, "wide.txt"),
		`${"A".repeat(MAX_TEXT_BYTES - 128)}\n${"B".repeat(MAX_TEXT_BYTES - 128)}\n`,
	);
	await writeFile(path.join(baseRoot, "assets/logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47, 0x00]));
	gitIn(baseRoot, "add", "-A", "-f");
	gitIn(baseRoot, "commit", "-q", "-m", "initial");
	mainTip = gitIn(baseRoot, "rev-parse", "HEAD").trim();
	gitIn(baseRoot, "branch", "feature");
	gitIn(baseRoot, "checkout", "-q", "feature");
	await writeFile(path.join(baseRoot, "note.txt"), "feature note\n");
	gitIn(baseRoot, "add", "-A");
	gitIn(baseRoot, "commit", "-q", "-m", "feature change");
	featureOriginalTip = gitIn(baseRoot, "rev-parse", "HEAD").trim();
	gitIn(baseRoot, "checkout", "-q", "main");
	gitIn(baseRoot, "update-ref", "refs/remotes/origin/main", mainTip);
	gitIn(baseRoot, "update-ref", "refs/remotes/origin/feature", featureOriginalTip);
	gitIn(baseRoot, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

	// A second, minimal repo for the too-large refusal: 17 MiB so nothing is
	// fetched even with a generous buffer; the byte-cap work rides in the base
	// fixture, where a one-line page and a two-line one exceed MAX_TEXT_BYTES
	// by construction.
	bigRoot = await mkdtemp(path.join(tmpdir(), "repo-explorer-git-big-"));
	gitIn(bigRoot, "init", "-b", "main", "-q");
	gitIn(bigRoot, "config", "user.name", "Test Harness");
	gitIn(bigRoot, "config", "user.email", "test@harness.invalid");
	await writeFile(path.join(bigRoot, "huge.txt"), Buffer.alloc(MAX_BLOB_BYTES + 1024 * 1024, 0x41));
	gitIn(bigRoot, "add", "-A");
	gitIn(bigRoot, "commit", "-q", "-m", "huge");
});

after(async () => {
	await Promise.all([rm(baseRoot, { recursive: true, force: true }), rm(bigRoot, { recursive: true, force: true })]);
});

test("openGit refuses a directory that is not a repository", async () => {
	const { run } = makeRunner();
	await assert.rejects(
		openGit(run, tmpdir()),
		(err: unknown) => err instanceof RepoGitError && err.kind === "not-a-repo" && err.message.includes("Not a git work-tree"),
	);
});

test("openGit resolves the repository root and lists branches with HEAD flagged", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	assert.equal(repo.root, baseRoot);

	const list = await repo.listBranches();
	assert.deepEqual(
		list.branches,
		[
			{ refname: "refs/heads/feature", name: "feature", isRemote: false, isCurrent: false },
			{ refname: "refs/heads/main", name: "main", isRemote: false, isCurrent: true },
			{ refname: "refs/remotes/origin/feature", name: "origin/feature", isRemote: true, isCurrent: false },
			{ refname: "refs/remotes/origin/main", name: "origin/main", isRemote: true, isCurrent: false },
		],
		"locals first in refname order, remotes as <remote>/<name>, every entry carries its full refname, origin/HEAD (a symref) left out, HEAD flagged",
	);
	assert.equal(list.current, "main");
	assert.equal(list.detachedTip, undefined);
});

test("a detached HEAD reports the tip instead of a current branch, still browsable", async () => {
	const { run } = makeRunner();
	gitIn(baseRoot, "checkout", "-q", "--detach");
	try {
		const repo = await openGit(run, baseRoot);
		const list = await repo.listBranches();
		assert.equal(list.current, undefined);
		assert.equal(list.detachedTip, mainTip);
		assert.ok(!list.branches.some((branch) => branch.isCurrent), "no branch is flagged current while HEAD is detached");
		// The menu flow needs the fixed tip to work as a branch argument.
		const files = await repo.listFiles(list.detachedTip as string);
		assert.ok(files.includes("README.md"));
	} finally {
		gitIn(baseRoot, "checkout", "-q", "main");
	}
});

test("listFiles is recursive, directory-free and byte-faithful (unquoted via -z)", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	assert.deepEqual(await repo.listFiles("main"), [
		"README.md",
		"assets/logo.png",
		"big.txt",
		"corrupt.txt",
		"docs/café América.txt",
		"empty.txt",
		"minified.js",
		"src/lib/depth.ts",
		"src/main.ts",
		"wide.txt",
	]);
	const content = await repo.readFile("main", "docs/café América.txt");
	assert.equal(content.text, "unicode path\n");
});

test("readFile shows each branch's own tree, remote refs included", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	assert.equal((await repo.readFile("main", "README.md")).text, "root readme\n");
	assert.equal((await repo.readFile("feature", "note.txt")).text, "feature note\n");
	assert.equal((await repo.readFile("origin/main", "README.md")).text, "root readme\n");
});

test("readFile refuses missing paths, directories and unknown branches with a kind", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	await assert.rejects(
		repo.readFile("main", "note.txt"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "not-found" && err.message.includes("note.txt"),
	);
	await assert.rejects(
		repo.readFile("main", "src"),
		(err: unknown) =>
			err instanceof RepoGitError && err.kind === "not-a-file" && err.message.includes("is a tree"),
	);
	await assert.rejects(
		repo.listFiles("no-such-branch"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "unknown-branch",
	);
});

test("readFile reports an empty file as zero lines, not as a truncated line", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	const empty = await repo.readFile("main", "empty.txt");
	assert.deepEqual(
		{ text: empty.text, totalLines: empty.totalLines, shownLines: empty.shownLines, truncated: empty.truncated },
		{ text: "", totalLines: 0, shownLines: 0, truncated: false },
	);
});

test("readFile clips at LINE_CAP with banner-ready metadata and the real blob size", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	const big = await repo.readFile("main", "big.txt");
	const lines = big.text.split("\n");
	assert.equal(big.totalLines, 3000);
	assert.equal(big.shownLines, LINE_CAP);
	assert.equal(big.truncated, true);
	assert.ok(big.note?.includes(`first ${LINE_CAP}`) && big.note?.includes("3000"), `note: ${big.note}`);
	assert.equal(lines[0], "line 1");
	assert.equal(lines[lines.length - 1], "", "the file's terminator is restored on the clip");
	assert.equal(lines[lines.length - 2], `line ${LINE_CAP}`);
	assert.ok(!big.text.includes("line 2001"), "no clipped line leaks past the cap");
	assert.equal(big.sizeBytes, Buffer.byteLength(`${Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n")}\n`));
});

test("readFile refuses binary content instead of printing escape soup", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	await assert.rejects(
		repo.readFile("main", "assets/logo.png"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "binary" && err.message.includes("binary"),
	);
});

test("readFile refuses blobs above MAX_BLOB_BYTES before fetching them", async () => {
	const { run, count } = makeRunner();
	const repo = await openGit(run, bigRoot);
	await assert.rejects(
		repo.readFile("main", "huge.txt"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "too-large" && err.message.includes("-byte cap"),
	);
	assert.equal(count("show"), 0, "the blob body must never be piped out for a too-large file");
});

test("readFile refuses a page whose first line alone exceeds the byte cap", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	await assert.rejects(
		repo.readFile("main", "minified.js"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "too-large" && err.message.includes("page cap"),
	);
});

test("readFile byte-caps the page and cuts at a complete line", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	const wide = await repo.readFile("main", "wide.txt");
	const firstLine = `${"A".repeat(MAX_TEXT_BYTES - 128)}\n`;
	assert.equal(wide.totalLines, 2);
	assert.equal(wide.shownLines, 1);
	assert.equal(wide.truncated, true);
	assert.ok(wide.note?.includes("KB") && wide.note?.includes("1 of 2 lines"), `note: ${wide.note}`);
	assert.equal(wide.text, firstLine, "only the first line survives, restored with its terminator");
	assert.equal(wide.sizeBytes, 2 * (MAX_TEXT_BYTES - 128) + 2);
});

test("readFile refuses mojibake-corrupted output rather than serving it", async () => {
	const { run } = makeRunner();
	const repo = await openGit(run, baseRoot);
	await assert.rejects(
		repo.readFile("main", "corrupt.txt"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "mojibake" && err.message.includes("U+FFFD"),
	);
});

test("listFiles refuses a mojibake-corrupted listing", async () => {
	// node's execFile decodes stdout in one shot, so the real runner can never
	// produce this; the refusal is exercised against a runner that returns a
	// hand-mangled listing, the shape pi.exec's chunked decode could give.
	const ok = (stdout = ""): GitRunResult => ({ stdout, stderr: "", code: 0, killed: false });
	const run: GitRunner = async (args) => {
		if (args[0] === "ls-tree") return ok(`caf${"\uFFFD"}.doc\0f.txt\0`);
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
		if (args[0] === "rev-parse") return ok("a1b2c3\n");
		throw new Error(`unexpected argv: ${args.join(" ")}`);
	};
	const repo = await openGit(run, "/repo");
	await assert.rejects(
		repo.listFiles("main"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "mojibake",
	);
});

test("listFiles reuses the cache while the branch tip holds", async () => {
	const { run, count } = makeRunner();
	const repo = await openGit(run, baseRoot);
	const first = await repo.listFiles("main");
	assert.equal(count("ls-tree"), 1);
	const second = await repo.listFiles("main");
	assert.equal(count("ls-tree"), 1, "an unchanged tip must not refetch the tree");
	assert.deepEqual(second, first);
	assert.notEqual(second, first, "callers get a copy, so nobody can mutate the cached tree");
});

test("listFiles invalidates the cache when the branch tip moves", async () => {
	const { run, count } = makeRunner();
	const repo = await openGit(run, baseRoot);
	const before = await repo.listFiles("feature");
	assert.equal(count("ls-tree"), 1);
	assert.ok(!before.includes("moved.txt"));

	// Move the tip the ordinary way, then restore the ref so the fixture is
	// left as found. Defensive only — this is the file's last test and after()
	// deletes the repo — but node:test may grow or reorder this file later.
	try {
		gitIn(baseRoot, "checkout", "-q", "feature");
		await writeFile(path.join(baseRoot, "moved.txt"), "moved\n");
		gitIn(baseRoot, "add", "-A");
		gitIn(baseRoot, "commit", "-q", "-m", "cache invalidation");
		gitIn(baseRoot, "checkout", "-q", "main");
		assert.notEqual(gitIn(baseRoot, "rev-parse", "feature").trim(), featureOriginalTip);

		const after = await repo.listFiles("feature");
		assert.equal(count("ls-tree"), 2, "the moved tip must refetch the tree");
		assert.ok(after.includes("moved.txt"));

		await repo.listFiles("feature");
		assert.equal(count("ls-tree"), 2, "listing again on the new tip reuses the refreshed cache");
	} finally {
		gitIn(baseRoot, "update-ref", "refs/heads/feature", featureOriginalTip);
	}
});
