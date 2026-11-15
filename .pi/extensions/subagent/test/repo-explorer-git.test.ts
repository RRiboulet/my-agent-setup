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

test("openGit reports a spawn failure as git-unavailable, not not-a-repo", async () => {
	// The runner returns 127 when the child never ran (git absent from PATH, an
	// unreadable cwd); openGit must not lump that in with a directory that is
	// merely not a repository, or the headline diagnosis is wrong and the kind
	// cannot be reacted to.
	const run: GitRunner = async () => ({ stdout: "", stderr: "spawn git ENOENT", code: 127, killed: false });
	await assert.rejects(
		openGit(run, "/does/not/matter"),
		(err: unknown) =>
			err instanceof RepoGitError && err.kind === "git-unavailable" && err.message.includes("git is not available"),
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

test("a branch literally named HEAD does not corrupt HEAD detection", async () => {
	const { run } = makeRunner();
	// `git update-ref refs/heads/HEAD` is plumbing-legal (only `git branch
	// HEAD` refuses), and it makes HEAD an ambiguous refname: on the git
	// tested, `rev-parse --abbrev-ref HEAD` then exits 0 with EMPTY stdout and
	// only a warning on stderr, which read as "unresolved" — dropping the
	// detached tip, the one row whose point is browsing where HEAD actually is.
	gitIn(baseRoot, "update-ref", "refs/heads/HEAD", mainTip);
	try {
		// On a branch: the branch HEAD is on, not "" and not the ref named HEAD.
		let list = await (await openGit(run, baseRoot)).listBranches();
		assert.equal(list.current, "main");
		assert.equal(list.detachedTip, undefined);
		assert.ok(
			list.branches.some((branch) => branch.refname === "refs/heads/HEAD"),
			"the branch named HEAD is still listed",
		);

		// Detached: the tip must still come through.
		gitIn(baseRoot, "checkout", "-q", "--detach");
		try {
			list = await (await openGit(run, baseRoot)).listBranches();
			assert.equal(list.current, undefined);
			assert.equal(list.detachedTip, mainTip, "the detached tip survives an ambiguous HEAD");
		} finally {
			gitIn(baseRoot, "checkout", "-q", "main");
		}

		// HEAD itself pointing at the branch named HEAD: the name comes back
		// intact, because the full refname is read and stripped here — git's own
		// --short form of refs/heads/HEAD is "heads/HEAD", its disambiguation.
		gitIn(baseRoot, "symbolic-ref", "HEAD", "refs/heads/HEAD");
		try {
			list = await (await openGit(run, baseRoot)).listBranches();
			assert.equal(list.current, "HEAD");
		} finally {
			gitIn(baseRoot, "checkout", "-q", "main");
		}
	} finally {
		gitIn(baseRoot, "update-ref", "-d", "refs/heads/HEAD");
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

// ---------------------------------------------------------------------------
// changedFiles — the paths the browser paints red
// ---------------------------------------------------------------------------

/**
 * A fresh scratch repository with one commit on `main` (`keep.txt`), used by
 * the changed-files tests. Built per test rather than shared because these
 * tests deliberately move refs, dirty the working tree and unset upstream
 * config; a shared fixture would make them order-dependent.
 */
async function initScratchRepo(name: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), `repo-explorer-changed-${name}-`));
	gitIn(root, "init", "-q", "-b", "main");
	gitIn(root, "config", "user.name", "Test Harness");
	gitIn(root, "config", "user.email", "test@harness.invalid");
	await writeFile(path.join(root, "keep.txt"), "base\n");
	gitIn(root, "add", "-A");
	gitIn(root, "commit", "-q", "-m", "base");
	return root;
}

/** Every argv the shell-out recorded for a command that ended with `last`. */
const diffTargets = (calls: string[][], last: string): string[][] =>
	calls.filter((argv) => argv[0] === "diff" && argv.at(-1) === last);

test("changedFiles diffs against @{upstream} when set, and origin/<branch> when it is not", async () => {
	// This one names the branch the way the code used to probe for it (short),
	// and keeps doing so now that the probe converts the full refname first; the
	// shape production actually passes — `refs/heads/<name>` — is covered by the
	// "production full-refname call" test below, which is what failed before the
	// probe was fixed.
	const root = await initScratchRepo("upstream");
	try {
		const base = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "-b", "feature");
		await writeFile(path.join(root, "feature.txt"), "feature\n");
		// A non-ASCII name: `git diff --name-only` shell-quotes these without
		// `-z` (`"zz caf\303\251.txt"`), so a reader that dropped `-z` would
		// return the quoted spelling and fail here rather than only on a
		// repository that happens to contain one.
		await writeFile(path.join(root, "zz café.txt"), "accented\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "feature");
		const featureTip = gitIn(root, "rev-parse", "HEAD").trim();
		// origin/feature carries a commit the branch does not: the two candidate
		// answers are therefore disjoint sets, so an implementation that diffed
		// both refs and unioned the results would return two paths where the
		// preferred answer has one. (With origin/feature at the branch tip, the
		// union is identical to the upstream-only diff and the test could not
		// tell the two apart.)
		gitIn(root, "checkout", "-q", "--detach", featureTip);
		await writeFile(path.join(root, "only-on-origin.txt"), "remote\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "remote only");
		const originFeatureTip = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "main");
		// The configured upstream (origin/main, at the base commit) is the one
		// that has the branch's delta.
		gitIn(root, "update-ref", "refs/remotes/origin/feature", originFeatureTip);
		gitIn(root, "update-ref", "refs/remotes/origin/main", base);
		gitIn(root, "remote", "add", "origin", "https://example.invalid/repo.git");
		gitIn(root, "config", "branch.feature.remote", "origin");
		gitIn(root, "config", "branch.feature.merge", "refs/heads/main");

		const { run, calls } = makeRunner();
		const repo = await openGit(run, root);
		assert.deepEqual(
			await repo.changedFiles("feature"),
			["feature.txt", "zz café.txt"],
			"the configured upstream (origin/main) wins over the conventional origin/<branch> ref",
		);
		assert.ok(diffTargets(calls, "refs/remotes/origin/main").length > 0, "the diff names the configured upstream");

		gitIn(root, "config", "--unset", "branch.feature.remote");
		gitIn(root, "config", "--unset", "branch.feature.merge");
		assert.deepEqual(
			await repo.changedFiles("feature"),
			["only-on-origin.txt"],
			"with no upstream configured, origin/<branch> is the diff target, so only its extra commit shows",
		);
		assert.ok(diffTargets(calls, "refs/remotes/origin/feature").length > 0, "the fallback names origin/<branch>");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the production full-refname call still resolves @{upstream}, which git only accepts by short name", async () => {
	// The browser passes `choice.refname` ("refs/heads/feature"), and git accepts
	// only `<branchname>@{upstream}` — `refs/heads/feature@{upstream}` exits 128
	// with "no such branch". This is the shape that reaches `changedFiles` in
	// production; the test above exercises the short name the code happened to
	// probe with, which is why the gap survived it.
	//
	// The fixture makes the two possible answers differ, so a resolver that
	// misses the probe and falls through to the merge base cannot pass by luck:
	// origin/main carries a commit the branch does not, so diffing the tips (the
	// @{upstream} answer) names both paths, while diffing from the merge base
	// names only the branch's own. origin/feature does not exist, so the
	// conventional fallback cannot rescue the probe either.
	const root = await initScratchRepo("prod-refname");
	try {
		gitIn(root, "remote", "add", "origin", "https://example.invalid/repo.git");
		gitIn(root, "checkout", "-q", "-b", "feature");
		await writeFile(path.join(root, "feature.txt"), "feature\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "feature only");
		// The configured upstream, one commit ahead of the merge base.
		gitIn(root, "checkout", "-q", "main");
		await writeFile(path.join(root, "on-main.txt"), "upstream moved\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "upstream only");
		gitIn(root, "update-ref", "refs/remotes/origin/main", gitIn(root, "rev-parse", "HEAD").trim());
		gitIn(root, "config", "branch.feature.remote", "origin");
		gitIn(root, "config", "branch.feature.merge", "refs/heads/main");

		const { run, calls } = makeRunner();
		const repo = await openGit(run, root);
		assert.deepEqual(
			await repo.changedFiles("refs/heads/feature"),
			["feature.txt", "on-main.txt"],
			"the configured upstream is diffed, so the upstream's own commit shows too",
		);

		// The probe itself: git must be asked with the short name, because it
		// rejects the full refname. Asserted on argv, since a resolver that
		// probes wrongly and falls back can still produce paths in other shapes.
		const probes = calls.filter((argv) => argv.includes("--symbolic-full-name"));
		assert.equal(probes.length, 1, "exactly one upstream probe");
		assert.equal(probes[0]?.at(-1), "feature@{upstream}");
		assert.equal(diffTargets(calls, "refs/remotes/origin/main").length, 1, "the diff names the configured upstream");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a remote-tracking branch is never diffed, so browsing it cannot paint the whole tree red", async () => {
	const root = await initScratchRepo("remote");
	try {
		// A commit that exists only on the remote side: local main is behind
		// origin/main, so a diff of origin/main against the integration branch
		// would be non-empty if the guard ever let it through.
		gitIn(root, "checkout", "-q", "-b", "remote-state");
		await writeFile(path.join(root, "remote-only.txt"), "remote\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "remote only");
		const remoteTip = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "main");
		gitIn(root, "update-ref", "refs/remotes/origin/main", remoteTip);

		const { run, calls, count } = makeRunner();
		const repo = await openGit(run, root);
		// Positive control: the local branch behind its own origin reports the
		// path it is missing. Without this, the [] below could pass for the
		// wrong reason (an empty diff rather than the guard).
		assert.deepEqual(await repo.changedFiles("refs/heads/main"), ["remote-only.txt"]);

		const diffs = count("diff");
		const mergeBases = count("merge-base");
		assert.deepEqual(await repo.changedFiles("refs/remotes/origin/main"), [], "a remote-tracking ref reports no changes");
		assert.equal(count("diff"), diffs, "it is not diffed at all");
		assert.equal(count("merge-base"), mergeBases, "nor merge-based against the integration branches");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a remote-tracking ref gets no working-tree changes even when HEAD points at it", async () => {
	const root = await initScratchRepo("remote-head");
	try {
		const tip = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "update-ref", "refs/remotes/origin/main", tip);
		// A symref to a remote-tracking ref is unusual but legal (git accepts it,
		// and listBranches marks that row current). It is the one shape where the
		// early remote-tracking return is load-bearing on its own: without it,
		// headBranch equals branch and the working tree leaks in, painting a
		// ref that is not a working copy.
		gitIn(root, "symbolic-ref", "HEAD", "refs/remotes/origin/main");
		await writeFile(path.join(root, "keep.txt"), "dirty\n");

		const { run, calls } = makeRunner();
		const repo = await openGit(run, root);
		assert.deepEqual(
			await repo.changedFiles("refs/remotes/origin/main"),
			[],
			"a remote-tracking ref is never given the local working tree's changes",
		);
		assert.equal(diffTargets(calls, "HEAD").length, 0, "no HEAD diff is run for it");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("with no remote counterpart, changedFiles diffs from the merge base with origin/dev, dev, origin/main, then main", async () => {
	const root = await initScratchRepo("merge-base");
	try {
		const base = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "-b", "topic");
		await writeFile(path.join(root, "topic.txt"), "topic\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "topic");
		const topicTip = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "main");

		const { run, calls } = makeRunner();
		const repo = await openGit(run, root);
		/** The ref the last merge-base call resolved the base to. */
		const lastBase = (): string | undefined => [...calls].reverse().find((argv) => argv[0] === "merge-base")?.at(-1);

		// origin/dev exists and contains the topic tip, so the merge base is the
		// tip itself and the branch shows nothing. A local dev exists too, and
		// would give a different answer (the topic commit), so [] proves the
		// remote ref was preferred.
		gitIn(root, "update-ref", "refs/remotes/origin/dev", topicTip);
		gitIn(root, "branch", "dev", base);
		assert.deepEqual(await repo.changedFiles("refs/heads/topic"), [], "origin/dev is consulted before a local dev");
		assert.equal(lastBase(), "refs/remotes/origin/dev");

		gitIn(root, "update-ref", "-d", "refs/remotes/origin/dev");
		assert.deepEqual(await repo.changedFiles("refs/heads/topic"), ["topic.txt"], "without origin/dev, the local dev is the base");
		assert.equal(lastBase(), "refs/heads/dev");

		gitIn(root, "branch", "-D", "dev");
		gitIn(root, "update-ref", "refs/remotes/origin/main", base);
		assert.deepEqual(await repo.changedFiles("refs/heads/topic"), ["topic.txt"], "then origin/main");
		assert.equal(lastBase(), "refs/remotes/origin/main");

		gitIn(root, "update-ref", "-d", "refs/remotes/origin/main");
		assert.deepEqual(await repo.changedFiles("refs/heads/topic"), ["topic.txt"], "and finally the local main");
		assert.equal(lastBase(), "refs/heads/main");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uncommitted changes are added only for the checked-out branch", async () => {
	const root = await initScratchRepo("dirty");
	try {
		const base = gitIn(root, "rev-parse", "HEAD").trim();
		gitIn(root, "checkout", "-q", "-b", "feature");
		await writeFile(path.join(root, "feature.txt"), "feature\n");
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "feature");
		const featureTip = gitIn(root, "rev-parse", "HEAD").trim();
		// Committed branches are both level with their tracking refs, so every
		// path below comes from the working tree, not from a commit.
		gitIn(root, "update-ref", "refs/remotes/origin/feature", featureTip);
		gitIn(root, "update-ref", "refs/remotes/origin/main", base);
		await writeFile(path.join(root, "keep.txt"), "dirty\n");
		await writeFile(path.join(root, "untracked.txt"), "new\n");

		const { run, calls } = makeRunner();
		const repo = await openGit(run, root);
		const headDiffs = (): number => diffTargets(calls, "HEAD").length;

		const feature = await repo.changedFiles("refs/heads/feature");
		assert.deepEqual(feature, ["keep.txt"], "the checked-out branch gets its working-tree change");
		assert.ok(!feature.includes("untracked.txt"), "untracked files are not in `git diff HEAD`");
		assert.equal(headDiffs(), 1, "through git diff --name-only -z HEAD");

		assert.deepEqual(
			await repo.changedFiles("refs/heads/main"),
			[],
			"another branch must not be painted with the checked-out tree's changes",
		);
		assert.equal(headDiffs(), 1, "and no HEAD diff is run for it");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("changedFiles reports a failed diff as git-failed rather than swallowing it", async () => {
	// The notify policy lives in the command handler, which turns this kind into
	// one warning and an empty set; what git.ts owes it is the typed rejection,
	// not a silent [].
	const ok = (stdout = ""): GitRunResult => ({ stdout, stderr: "", code: 0, killed: false });
	const run: GitRunner = async (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
		if (args[0] === "rev-parse" && args.includes("--symbolic-full-name")) return ok("refs/remotes/origin/main\n");
		if (args[0] === "diff") return { stdout: "", stderr: "fatal: unable to read tree", code: 1, killed: false };
		throw new Error(`unexpected argv: ${args.join(" ")}`);
	};
	const repo = await openGit(run, "/repo");
	await assert.rejects(
		repo.changedFiles("refs/heads/main"),
		(err: unknown) => err instanceof RepoGitError && err.kind === "git-failed" && err.message.includes('git diff failed for "refs/heads/main"'),
	);
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
