// Behavior tests for the branch-selection step of /explore: branch-menu.ts's
// row ordering, labelling and ambiguity resolution, runner.ts's child
// handling, and the /explore handler's wiring of the menu, the file list and
// the browser.
//
// Three things are worth the reader's attention.
//
// First, the collision case. `update-ref` allows a local branch literally
// named "origin/main", whose display name is identical to the remote-tracking
// ref's, so the menu cannot key on labels alone — and picking the wrong row
// browses the wrong tree with nothing to show that it did. The tests here pin
// that both rows stay listed, that each is qualified, and that the choice the
// flow carries is the full refname in every case.
//
// Second, the runner. It deliberately does not go through pi.exec, because
// pi's executor decodes stdout per stream chunk and a 64 KiB boundary inside a
// multi-byte UTF-8 sequence becomes U+FFFD — which git.ts's readFile would then
// refuse, turning a perfectly readable large non-ASCII file into an error. The
// straddle test below is that case end to end, against a real `git`. The
// runner's two shutdown bounds are pinned the same way, with a shim `git`: a
// silent descendant holding the pipe must not hold the call open, and a git
// that ignores SIGTERM must die at the grace period rather than hang.
//
// Third, the handler tests drive the real extension factory with a fake
// ExtensionAPI, which is what proves the wiring: that the branch step is
// reached at all, that its failures surface as one notify rather than a thrown
// error into the runtime, and that a non-TUI mode never spawns git.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, chmod, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { getKeybindings } from "@earendil-works/pi-tui";

import { buildBranchMenu, chooseBranch, resolveBranchChoice, type ExploreBranchState } from "../../repo-explorer/branch-menu.ts";
import type { FileBrowserResult } from "../../repo-explorer/file-browser.ts";
import type { BranchList, GitRunner } from "../../repo-explorer/git.ts";
import { openGit, RepoGitError } from "../../repo-explorer/git.ts";
import { makeGitRunner } from "../../repo-explorer/runner.ts";

/** Synchronous git against fixture repositories; used to build them, not by the code under test. */
function gitIn(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

async function initRepo(name: string): Promise<string> {
	// realpath: on a macOS tmpdir symlink the root git reports is the resolved
	// path, and every `repo.root === root` assertion below would be comparing
	// two spellings of the same directory.
	const root = await realpath(await mkdtemp(path.join(tmpdir(), `repo-explorer-menu-${name}-`)));
	gitIn(root, "init", "-q", "-b", "main");
	gitIn(root, "config", "user.name", "Test Harness");
	gitIn(root, "config", "user.email", "test@harness.invalid");
	return root;
}

/** The menu fixture: main (current), feature, remote-tracking refs for both, and origin/HEAD as a symref. */
let menuRoot = "";
/** Same, plus a local branch literally named "origin/main" shadowing the tracking ref. */
let shadowRoot = "";
/** One branch, one commit: the menu has a single candidate. */
let soloRoot = "";
/** No commit at all: no refs, so there is nothing to browse. */
let emptyRoot = "";

before(async () => {
	menuRoot = await initRepo("menu");
	await writeFile(path.join(menuRoot, "README.md"), "menu root\n");
	gitIn(menuRoot, "add", "-A");
	gitIn(menuRoot, "commit", "-q", "-m", "initial");
	// A commit that exists only on `feature`, so a test can prove the picked
	// branch's tree (not merely some tree) is what reached the file list.
	gitIn(menuRoot, "checkout", "-q", "-b", "feature");
	await writeFile(path.join(menuRoot, "note.txt"), "feature note\n");
	gitIn(menuRoot, "add", "-A");
	gitIn(menuRoot, "commit", "-q", "-m", "feature change");
	gitIn(menuRoot, "checkout", "-q", "main");
	gitIn(menuRoot, "update-ref", "refs/remotes/origin/main", gitIn(menuRoot, "rev-parse", "main").trim());
	gitIn(menuRoot, "update-ref", "refs/remotes/origin/feature", gitIn(menuRoot, "rev-parse", "feature").trim());
	gitIn(menuRoot, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

	shadowRoot = await initRepo("shadow");
	await writeFile(path.join(shadowRoot, "README.md"), "shadow root\n");
	gitIn(shadowRoot, "add", "-A");
	gitIn(shadowRoot, "commit", "-q", "-m", "initial");
	gitIn(shadowRoot, "branch", "origin/main");
	gitIn(shadowRoot, "update-ref", "refs/remotes/origin/main", gitIn(shadowRoot, "rev-parse", "main").trim());

	soloRoot = await initRepo("solo");
	await writeFile(path.join(soloRoot, "README.md"), "solo root\n");
	gitIn(soloRoot, "add", "-A");
	gitIn(soloRoot, "commit", "-q", "-m", "initial");

	emptyRoot = await initRepo("empty");
});

after(async () => {
	await Promise.all(
		[menuRoot, shadowRoot, soloRoot, emptyRoot].map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/** A ctx.ui slice that records what the menu asked and what it answered. */
function makeUI(answer: string | undefined) {
	const asked: { title: string; options: string[] }[] = [];
	const notes: string[] = [];
	return {
		asked,
		notes,
		ui: {
			async select(title: string, options: string[]): Promise<string | undefined> {
				asked.push({ title, options });
				return answer;
			},
			notify(message: string, type?: "info" | "warning" | "error"): void {
				notes.push(`${type ?? "info"}: ${message}`);
			},
		},
	};
}

// ---------------------------------------------------------------------------
// buildBranchMenu — ordering, labelling, ambiguity
// ---------------------------------------------------------------------------

test("the menu lists the detached tip first, then locals, then remotes, and marks the current branch", async () => {
	const repo = await openGit(makeGitRunner(), menuRoot);
	const list = await repo.listBranches();
	const menu = buildBranchMenu(list);

	assert.deepEqual(
		menu.entries,
		[
			{ refname: "refs/heads/feature", label: "feature" },
			{ refname: "refs/heads/main", label: "main (current)" },
			{ refname: "refs/remotes/origin/feature", label: "origin/feature" },
			{ refname: "refs/remotes/origin/main", label: "origin/main" },
		],
		"locals in refname order before remotes, only the current branch marked, origin/HEAD (a symref) not offered",
	);
	assert.equal(menu.defaultRef, "refs/heads/main", "the default is the current branch's full refname, not its short name");
});

test("a local branch named like a remote-tracking ref keeps both rows, qualified", async () => {
	const repo = await openGit(makeGitRunner(), shadowRoot);
	const list = await repo.listBranches();
	const menu = buildBranchMenu(list);

	assert.deepEqual(
		menu.entries,
		[
			{ refname: "refs/heads/main", label: "main (current)" },
			// Both members of the colliding set are qualified, not just the
			// second: a bare "origin/main" next to "origin/main [remote]" would
			// read as if the local one were the tracking ref.
			{ refname: "refs/heads/origin/main", label: "origin/main [local]" },
			{ refname: "refs/remotes/origin/main", label: "origin/main [remote]" },
		],
	);
	assert.equal(new Set(menu.entries.map((entry) => entry.label)).size, menu.entries.length, "every label maps back to exactly one row");
	assert.equal(resolveBranchChoice(menu, "origin/main [local]")?.refname, "refs/heads/origin/main");
	assert.equal(resolveBranchChoice(menu, "origin/main [remote]")?.refname, "refs/remotes/origin/main");
});

test("a branch named like an already-qualified label is settled by its refname", async () => {
	// Hand-built, because the only way to reach it is `update-ref
	// refs/heads/'origin/main [local]'` — a legal ref name whose label
	// collides with the qualifier the first sweep would produce.
	const list: BranchList = {
		branches: [
			{ refname: "refs/heads/origin/main [local]", name: "origin/main [local]", isRemote: false, isCurrent: false },
			// The collision that matters: HEAD is on a local branch whose short
			// name is the tracking ref's, so the default has to be the refname —
			// the short name resolves to the remote-tracking ref.
			{ refname: "refs/heads/origin/main", name: "origin/main", isRemote: false, isCurrent: true },
			{ refname: "refs/remotes/origin/main", name: "origin/main", isRemote: true, isCurrent: false },
		],
		current: "origin/main",
	};
	const menu = buildBranchMenu(list);
	assert.equal(new Set(menu.entries.map((entry) => entry.label)).size, menu.entries.length, "labels stay unique");
	for (const entry of menu.entries) {
		assert.equal(resolveBranchChoice(menu, entry.label)?.refname, entry.refname, `${entry.label} resolves to its own refname`);
	}
	assert.equal(menu.defaultRef, "refs/heads/origin/main", "the current branch is found by refname, not display name");
});

test("the default falls back to the detached tip, and is absent when neither resolves", () => {
	const tip = "a".repeat(40);
	assert.equal(buildBranchMenu({ branches: [], detachedTip: tip }).defaultRef, tip);
	assert.equal(buildBranchMenu({ branches: [] }).defaultRef, undefined);
});

test("resolveBranchChoice returns undefined for a cancel and for an unrecognized label", () => {
	const menu = buildBranchMenu({ branches: [{ refname: "refs/heads/main", name: "main", isRemote: false, isCurrent: true }] });
	assert.equal(resolveBranchChoice(menu, undefined), undefined, "Esc cancels the flow");
	assert.equal(resolveBranchChoice(menu, "no-such-label"), undefined, "a label the menu never offered stays refused");
});

// ---------------------------------------------------------------------------
// chooseBranch — the menu step against a real repository
// ---------------------------------------------------------------------------

test("picking a row returns its full refname, which listFiles then accepts", async () => {
	const repo = await openGit(makeGitRunner(), menuRoot);
	const state: ExploreBranchState = {};
	const label = "origin/main";
	const { ui } = makeUI(label);

	const choice = await chooseBranch(repo, ui, state);

	assert.deepEqual(choice, { refname: "refs/remotes/origin/main", label });
	assert.deepEqual(state, { refname: "refs/remotes/origin/main", label }, "the pick is remembered for the later steps");
	// The refname, not the display name: `listFiles "origin/main"` would work
	// by luck here, but only the full refname is unambiguous in every repo.
	const files = await repo.listFiles(choice?.refname as string);
	assert.ok(files.includes("README.md"));
});

test("picking the current branch remembers its full refname, not its short name", async () => {
	const repo = await openGit(makeGitRunner(), menuRoot);
	const state: ExploreBranchState = {};
	const choice = await chooseBranch(repo, makeUI("main (current)").ui, state);
	assert.equal(choice?.refname, "refs/heads/main");
	assert.equal(state.label, "main (current)");
});

test("cancelling the menu returns undefined and leaves the remembered branch alone", async () => {
	const repo = await openGit(makeGitRunner(), menuRoot);
	const state: ExploreBranchState = {};
	const { ui, notes } = makeUI(undefined);

	assert.equal(await chooseBranch(repo, ui, state), undefined);
	assert.deepEqual(state, {}, "a cancelled menu must not overwrite the last pick");
	assert.deepEqual(notes, ["info: repo-explorer: no branch selected"]);
});

test("a single candidate is not a choice: the menu is not shown at all", async () => {
	const repo = await openGit(makeGitRunner(), soloRoot);
	const state: ExploreBranchState = {};
	const { ui, asked } = makeUI("anything");

	const choice = await chooseBranch(repo, ui, state);

	assert.equal(asked.length, 0, "no select call for a one-branch repository");
	assert.deepEqual(choice, { refname: "refs/heads/main", label: "main (current)" });
	assert.deepEqual(state, { refname: "refs/heads/main", label: "main (current)" });
});

test("a repository with no branches warns instead of opening an empty menu", async () => {
	const repo = await openGit(makeGitRunner(), emptyRoot);
	const state: ExploreBranchState = {};
	const { ui, asked, notes } = makeUI(undefined);

	assert.equal(await chooseBranch(repo, ui, state), undefined);
	assert.equal(asked.length, 0);
	assert.deepEqual(notes, [`warning: repo-explorer: no branches to browse in ${path.basename(emptyRoot)}`]);
});

test("a git failure listing branches propagates for the handler to report", async () => {
	// The notify policy lives in the command handler (one catch for the whole
	// flow), so this asserts the throw rather than a message.
	const ok = (stdout = ""): { stdout: string; stderr: string; code: number; killed: boolean } => ({
		stdout,
		stderr: "",
		code: 0,
		killed: false,
	});
	const run: GitRunner = async (args) => {
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok("/repo\n");
		if (args[0] === "for-each-ref") return { stdout: "", stderr: "fatal: unable to read refs", code: 1, killed: false };
		throw new Error(`unexpected argv: ${args.join(" ")}`);
	};
	const repo = await openGit(run, "/repo");
	await assert.rejects(
		chooseBranch(repo, makeUI(undefined).ui, {}),
		(err: unknown) => err instanceof RepoGitError && err.kind === "git-failed",
	);
});

// ---------------------------------------------------------------------------
// The command handler — the wiring between the pieces
// ---------------------------------------------------------------------------

/**
 * Load the extension and hand back the registered /explore handler plus what
 * its pi calls captured: a message renderer registration and any transcript
 * messages it sent.
 */
async function loadExplore(): Promise<{
	handler: (args: string, ctx: Record<string, unknown>) => Promise<void>;
	sent: { customType: string; content: string; display: boolean; details: unknown }[];
	renderers: string[];
}> {
	const module = (await import("../../repo-explorer/index.ts")) as {
		default: (pi: Record<string, unknown>) => void;
	};
	const registered: Record<string, { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }> = {};
	const sent: { customType: string; content: string; display: boolean; details: unknown }[] = [];
	const renderers: string[] = [];
	module.default({
		registerCommand: (name: string, options: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) => {
			registered[name] = options;
		},
		registerMessageRenderer: (customType: string) => {
			renderers.push(customType);
		},
		sendMessage: (message: { customType: string; content: string; display: boolean; details: unknown }) => {
			sent.push(message);
		},
	});
	const handler = registered.explore?.handler;
	assert.equal(typeof handler, "function");
	return { handler: handler as (args: string, ctx: Record<string, unknown>) => Promise<void>, sent, renderers };
}

/** A stand-in for pi's Theme: `fg`/`bold` return the text unchanged, so assertions stay readable. */
const uiTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

/**
 * A command context whose UI records notifications, answers the menu from the
 * labels offered, and stands in for `ctx.ui.custom`.
 *
 * The fake custom builds the *real* browser component (so the wiring is
 * exercised, not mocked) and resolves with a canned pick. The built component
 * is handed back so a test can render it and see the branch label and the file
 * list that reached it.
 */
function makeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const notes: string[] = [];
	const menus: string[][] = [];
	const browsers: { render(width: number): string[] }[] = [];
	let answer: string | undefined = "";
	let picked: FileBrowserResult = null;
	const ctx = {
		cwd,
		mode: "tui",
		signal: undefined,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => notes.push(`${type ?? "info"}: ${message}`),
			select: async (_title: string, options: string[]) => {
				menus.push(options);
				return answer;
			},
			custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: FileBrowserResult) => void) => unknown) => {
				const component = (await factory({ requestRender: () => undefined }, uiTheme, getKeybindings(), () => undefined)) as {
					render(width: number): string[];
				};
				browsers.push(component);
				return picked;
			},
		},
		...overrides,
	};
	return {
		ctx,
		notes,
		menus,
		browsers,
		answerWith: (pick: string | undefined) => (answer = pick),
		pickInBrowser: (result: FileBrowserResult) => (picked = result),
	};
}

test("/explore opens the menu, then hands the picked branch's files to the browser", async () => {
	const { handler } = await loadExplore();
	const { ctx, notes, menus, browsers, answerWith } = makeCtx(menuRoot);
	answerWith("feature");

	await handler("", ctx);

	assert.equal(menus.length, 1, "the menu is shown once");
	assert.ok(menus[0].includes("feature"), "the menu offers the branches of this repository");
	assert.equal(browsers.length, 1, "the browser is built with the picked branch");
	// The rendered view proves the whole chain: the branch label became the
	// breadcrumb, the refname reached listFiles, and its file list reached the
	// component (note.txt exists only on `feature`).
	const view = browsers[0].render(80).join("\n");
	assert.match(view, /Explore feature › \./);
	assert.match(view, /note\.txt/);
	assert.deepEqual(notes, [], "a cancelled browser reports nothing");
});

test("/explore prints the picked file into the transcript", async () => {
	const { handler, sent, renderers } = await loadExplore();
	const { ctx, answerWith, pickInBrowser } = makeCtx(menuRoot);
	answerWith("feature");
	pickInBrowser({ path: "note.txt" });

	await handler("", ctx);

	assert.ok(renderers.includes("repo-explorer-file"), "the file renderer is registered with pi");
	assert.equal(sent.length, 1);
	const message = sent[0];
	assert.equal(message.customType, "repo-explorer-file");
	assert.equal(message.display, true, "the message is shown in the transcript");
	assert.match(message.content, /^Explore feature › note\.txt/);
	assert.match(message.content, /1 │ feature note/, "the file body is numbered");
	assert.deepEqual(message.details, {
		branch: "feature",
		path: "note.txt",
		note: undefined,
		shownLines: 1,
		totalLines: 1,
		sizeBytes: 13,
	});
});

test("/explore sanitizes a control-byte path in the error it reports", async () => {
	// A missing file is the cheapest way to drive the notify with a hostile
	// path: readFile raises `not-found`, whose message embeds the path.
	const { handler, sent } = await loadExplore();
	const { ctx, notes, answerWith, pickInBrowser } = makeCtx(menuRoot);
	answerWith("main (current)");
	pickInBrowser({ path: "evil\u001b[2J.txt" });

	await handler("", ctx);

	assert.equal(sent.length, 0, "nothing is printed for a file that cannot be read");
	assert.equal(notes.length, 1);
	assert.match(notes[0], /^error: repo-explorer: Not found in .*evil\^\[\[2J\.txt/);
	assert.ok(!notes[0].includes("\u001b"), "no raw escape reaches the notification");
});

test("/explore with arguments warns about the missing quick-open and still opens the menu", async () => {
	const { handler } = await loadExplore();
	const { ctx, notes, answerWith } = makeCtx(menuRoot);
	answerWith("main (current)");

	await handler("src/main.ts", ctx);

	assert.equal(notes.length, 1);
	assert.match(notes[0], /^warning: repo-explorer: arguments are not supported yet \("src\/main\.ts"\)/);
});

test("/explore outside TUI mode refuses before touching git", async () => {
	const { handler } = await loadExplore();
	const { ctx, notes, menus, browsers } = makeCtx(menuRoot, { mode: "rpc" });

	await handler("", ctx);

	assert.deepEqual(notes, ["error: repo-explorer requires interactive TUI mode"]);
	assert.equal(menus.length, 0, "no git call, no menu");
	assert.equal(browsers.length, 0, "and no browser");
});

test("/explore outside a repository reports the plumbing's not-a-repo kind", async () => {
	const { handler } = await loadExplore();
	const { ctx, notes, browsers } = makeCtx(tmpdir());

	await handler("", ctx);

	assert.equal(notes.length, 1);
	assert.match(notes[0], /^error: repo-explorer: Not a git work-tree/);
	assert.equal(browsers.length, 0);
});

test("/explore with a cancelled menu stops without reporting an error", async () => {
	const { handler } = await loadExplore();
	const { ctx, notes, answerWith, browsers } = makeCtx(menuRoot);
	answerWith(undefined);

	await handler("", ctx);

	assert.deepEqual(notes, ["info: repo-explorer: no branch selected"]);
	assert.equal(browsers.length, 0, "no branch means no browser");
});

// ---------------------------------------------------------------------------
// makeGitRunner — byte-faithful stdout, environment hygiene, abort
// ---------------------------------------------------------------------------

test("the runner reads a file whose 64 KiB stream boundary falls inside a multi-byte character", async () => {
	const root = await initRepo("straddle");
	try {
		// The straddle is deliberate: per-chunk decoding turns the two bytes of
		// "é" split across the boundary into U+FFFD, and readFile would then
		// refuse a file that is perfectly readable.
		const content = `${"a".repeat(65535)}é☃${"b".repeat(10)}\nsecond line\n`;
		await writeFile(path.join(root, "straddle.txt"), content);
		gitIn(root, "add", "-A");
		gitIn(root, "commit", "-q", "-m", "straddle");

		const repo = await openGit(makeGitRunner(), root);
		const read = await repo.readFile("main", "straddle.txt");
		assert.equal(read.text, content, "stdout arrives byte-faithful, so the read is the whole file");
		assert.ok(!read.text.includes("\uFFFD"), "no replacement characters");
		assert.equal(read.truncated, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a GIT_DIR inherited from the shell does not redirect the reads", async () => {
	const previous = process.env.GIT_DIR;
	const stray = path.join(await initRepo("stray"), ".git");
	try {
		// Without the runner's GIT_* filter, git resolves against this
		// directory and every call below fails — the plumbing would report a
		// repository the session is not in.
		process.env.GIT_DIR = stray;
		const repo = await openGit(makeGitRunner(), menuRoot);
		assert.equal(repo.root, menuRoot, "the root still comes from the session cwd");
		const menu = buildBranchMenu(await repo.listBranches());
		assert.ok(menu.entries.some((entry) => entry.label === "main (current)"));
	} finally {
		if (previous === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = previous;
		await rm(path.dirname(stray), { recursive: true, force: true });
	}
});

test("an already-aborted signal resolves killed without spawning git", async () => {
	const aborted = AbortSignal.abort();
	const runner = makeGitRunner({ signal: aborted });
	// A cwd that cannot exist: if git had been spawned, the spawn error would
	// have put its message in stderr. Empty stderr is the proof it was not.
	const result = await runner(["rev-parse", "--show-toplevel"], path.join(tmpdir(), "repo-explorer-no-such-dir"));
	assert.deepEqual(result, { stdout: "", stderr: "", code: 1, killed: true });
});

test("a failing git call reports its exit code and stderr instead of throwing", async () => {
	const runner = makeGitRunner({ timeoutMs: 30_000 });
	const result = await runner(["rev-parse", "--verify", "refs/heads/no-such-branch^{commit}"], menuRoot);
	assert.equal(result.code, 128, "git's own fatal exit code is passed through, not flattened to 1");
	assert.match(result.stderr, /^fatal:/, "stderr carries git's own first line");
	assert.equal(result.killed, false);
});

/** Put an executable shim named `git` first on PATH for the duration of `body`. */
async function withShimGit(script: string, body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await realpath(await mkdtemp(path.join(tmpdir(), "repo-explorer-shim-")));
	const shim = path.join(dir, "git");
	await writeFile(shim, script);
	await chmod(shim, 0o755);
	const previous = process.env.PATH;
	try {
		// makeGitRunner copies the environment when it is constructed, so the
		// PATH must be in place before the runner is built, inside `body`.
		process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
		await body(dir);
	} finally {
		process.env.PATH = previous;
		await rm(dir, { recursive: true, force: true });
	}
}

test("a quiet descendant holding the pipe does not hold the call open", async () => {
	// The shim exits at once but leaves a silent forked `sleep` holding the
	// stdout pipe. Without the post-exit drain, "close" never fires and this
	// call waits the descendant's whole lifetime — the timeout would not bound
	// anything.
	await withShimGit("#!/bin/sh\necho hello\nsleep 30 &\nexit 0\n", async (dir) => {
		const runner = makeGitRunner({ timeoutMs: 30_000 });
		const started = Date.now();
		const result = await runner(["anything"], dir);
		const elapsed = Date.now() - started;
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "hello\n", "output written before the fork is kept");
		assert.ok(elapsed < 5_000, `settled in ${elapsed}ms, not the descendant's 30s sleep`);
	});
});

test("a git that ignores SIGTERM is killed after the grace period", async () => {
	// Ignores SIGTERM so only the escalation can end it: the call must settle
	// at timeout + KILL_GRACE (~5.2s here), never hang, and never at the
	// descendant's 30s.
	await withShimGit("#!/bin/sh\ntrap '' TERM\nexec sleep 30\n", async (dir) => {
		const runner = makeGitRunner({ timeoutMs: 200 });
		const started = Date.now();
		const result = await runner(["anything"], dir);
		const elapsed = Date.now() - started;
		assert.equal(result.killed, true);
		assert.ok(elapsed >= 5_000 && elapsed < 8_000, `escalated at ${elapsed}ms (expected ~5.2s, never unbounded)`);
	});
});
