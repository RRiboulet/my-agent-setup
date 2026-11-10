// Checks on the worktree skill.
//
// Two layers, and both are load-bearing:
//
// - Static assertions pin the shape of a recipe where the shape *is* the fix
//   (the commented-out force removal, the tab-separated sweep). They cannot
//   catch a block that no longer runs, which is how a Create block that died on
//   its first command and a Remove block that exited 0 after refusing to remove
//   a dirty tree both shipped.
// - Executable tests run the fenced blocks against a scratch repository
//   (`worktree-recipes.ts`) and assert real exit statuses and real filesystem
//   state. Anything about "does this recipe work" belongs here.
//
// Prefer the executable form for new assertions: a substring check passes just
// as happily on a broken recipe.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { blocks, REPO_ROOT, recipe, retarget, runScript, scratchRepo } from "./worktree-recipes.ts";

const SKILL = readFileSync(path.join(REPO_ROOT, ".pi/skills/worktree/SKILL.md"), "utf8");
const GITIGNORE = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");

/** Number of linked worktrees (main checkout excluded) in a `--porcelain` listing. */
function linkedCount(porcelain: string): number {
	return Math.max(0, (porcelain.match(/^worktree /gm) ?? []).length - 1);
}

// ---------------------------------------------------------------------------
// A `tmux` stand-in for the Remove recipe's session sweep
// ---------------------------------------------------------------------------

interface FakeTmux {
	/** `PATH` (fake bin first) plus the fake's own file locations, for `runScript`. */
	env: Record<string, string>;
	/** Every `kill-session -t <name>` the fake received, in call order. */
	kills(): Promise<string[]>;
	cleanup(): Promise<void>;
}

/**
 * The fake answers exactly two subcommands of the Remove recipe - `list-panes -a
 * -F` and `kill-session -t` - and fails loudly on anything else, so it cannot
 * quietly satisfy a recipe that starts talking to a real server.
 *
 * It is faithful where the sweep's two bugs live:
 *
 * - `list-panes` emits **one row per pane**, tab-separated in the order the
 *   recipe's own `-F` format names the fields (the fake checks that the format
 *   still asks for both placeholders, then answers from a fixture), so a session
 *   with two panes appears twice - which is what `tmux list-panes -a` really
 *   prints.
 * - A second `kill-session -t` for the same name fails with tmux's own wording
 *   (`can't find session: <name>`), because the session is gone by then. That is
 *   the failure the recipe's missing `sort -u` produced. Each attempt is logged
 *   *before* that check, so the log records every kill the block asked for, not
 *   only the ones that would have succeeded.
 */
async function fakeTmux(panes: Array<{ session: string; panePath: string }>): Promise<FakeTmux> {
	const dir = await mkdtemp(path.join(tmpdir(), "fake-tmux-"));
	const bin = path.join(dir, "bin");
	const listing = path.join(dir, "panes.tsv");
	const log = path.join(dir, "kills.log");
	const killed = path.join(dir, "killed.txt");
	await mkdir(bin);
	await writeFile(listing, panes.map((p) => `${p.session}\t${p.panePath}`).join("\n") + "\n");

	// One row per pane, in the order the recipe's format names the fields. Kept
	// in Node rather than substituted from the recipe's `-F` string so the
	// fixture survives a path full of backslashes without a second escaping
	// layer; the fake checks that the format still asks for both fields.
	const script = `#!/bin/sh
set -u
sub=""; fmt=""; target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -S|-c|-n|-F|-t)
      opt="$1"
      shift
      val=""
      if [ "$#" -gt 0 ]; then val="$1"; shift; fi
      case "$opt" in
        -F) fmt="$val" ;;
        -t) target="$val" ;;
      esac
      ;;
    *) if [ -z "$sub" ]; then sub="$1"; fi; shift ;;
  esac
done
case "$sub" in
  list-panes)
    case "$fmt" in
      *'#{session_name}'*'#{pane_current_path}'*) ;;
      *) printf 'fake tmux: unexpected -F format: %s\\n' "$fmt" >&2; exit 2 ;;
    esac
    cat "$FAKE_TMUX_PANES"
    ;;
  kill-session)
    if [ -z "$target" ]; then printf 'fake tmux: kill-session without -t\\n' >&2; exit 2; fi
    printf 'kill-session -t %s\\n' "$target" >> "$FAKE_TMUX_LOG"
    if grep -qxF -- "$target" "$FAKE_TMUX_KILLED" 2>/dev/null; then
      printf "can't find session: %s\\n" "$target" >&2
      exit 1
    fi
    printf '%s\\n' "$target" >> "$FAKE_TMUX_KILLED"
    ;;
  *)
    printf 'fake tmux: unsupported subcommand: %s\\n' "$sub" >&2
    exit 2
    ;;
esac
`;

	const tmuxPath = path.join(bin, "tmux");
	await writeFile(tmuxPath, script);
	await chmod(tmuxPath, 0o755);

	return {
		env: {
			// Fake first, then everything real the block also calls (`git`, `awk`, `sort`).
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FAKE_TMUX_PANES: listing,
			FAKE_TMUX_LOG: log,
			FAKE_TMUX_KILLED: killed,
		},
		kills: async () => {
			if (!existsSync(log)) return [];
			return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
		},
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Static: properties of the file itself
// ---------------------------------------------------------------------------

test("worktree skill: ignore guard is exact-line and newline-safe", () => {
	assert.ok(SKILL.includes("grep -qxF '.worktrees/'"), "guard must match the exact line");
	// Appending to a file with no trailing newline glues the entry onto its last
	// line, yielding `node_modules.worktrees/`.
	assert.ok(SKILL.includes('tail -c 1 "$MAIN/.gitignore"'), "guard must add a newline first");
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

	// Ancestry alone cannot see a base that is *ahead* of origin/dev: a branch
	// containing origin/dev passes --is-ancestor while carrying its own unmerged
	// commits, which the Create block used to accept as a base. AGENTS.md's
	// second half is the log check, and BASE_STACKED is the deliberate opt-in.
	const create = recipe("Create", 0);
	assert.ok(
		create.includes('git log --oneline "origin/dev..$BASE"'),
		"create must list the commits BASE carries beyond origin/dev",
	);
	assert.ok(create.includes("BASE_STACKED"), "create must offer the BASE_STACKED opt-in");
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

test("worktree skill: session sweep passes the path outside awk's escape rules", () => {
	const remove = recipe("Remove", 0);
	// `awk -v wt="$WT"` interprets C-style escapes in the value, so a worktree
	// path containing a backslash arrives corrupted, matches no pane, and leaks
	// the session while `git worktree remove` takes the tree out from under it.
	assert.ok(!remove.includes("-v wt="), "the path must not reach awk through -v");
	assert.ok(remove.includes('WT="$WT" awk'), "the path must reach awk through the environment");
	assert.ok(remove.includes('ENVIRON["WT"]'), "awk must read the path from ENVIRON");
	// `list-panes -a` prints one row per pane, so a multi-pane session appears
	// several times and the loop kills the already-dead session again.
	assert.ok(remove.includes("sort -u"), "the kill loop must receive deduplicated session names");
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

test("worktree skill: no recipe block carries a CR", () => {
	// AGENTS.md: a CRLF shell file makes bash fail with `$'\r': command not
	// found` while `git status` stays clean, so the recipes must stay LF-only.
	for (const block of blocks()) {
		assert.ok(!block.code.includes("\r"), `${block.section}[${block.index}] carries a CR`);
	}
});

// ---------------------------------------------------------------------------
// Executable: the recipes, run against a scratch repository
// ---------------------------------------------------------------------------

test("create recipe: makes a linked worktree on the new branch, based on origin/dev", async () => {
	const repo = await scratchRepo();
	try {
		const slug = "task-one";
		const result = runScript(retarget(recipe("Create", 0), { SLUG: slug }), { cwd: repo.main });
		assert.equal(result.status, 0, `create failed:\n${result.stderr}`);

		const wt = repo.pathOf(slug);
		assert.ok(existsSync(wt), `expected a worktree at ${wt}`);
		assert.equal(repo.gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD").trim(), slug);
		assert.equal(repo.gitIn(wt, "rev-parse", "HEAD").trim(), repo.originDev(), "must start at origin/dev");

		const listing = repo.worktrees();
		assert.ok(listing.includes(`worktree ${wt}`), "the worktree must be registered");
		assert.ok(listing.includes(`branch refs/heads/${slug}`), "on the new branch");
		assert.equal(linkedCount(listing), 1);
	} finally {
		await repo.cleanup();
	}
});

/** Create an unmerged `feature/x` one commit ahead of origin/dev in `repo`. */
function unmergedFeature(repo: Awaited<ReturnType<typeof scratchRepo>>): { tip: string } {
	repo.git("checkout", "-q", "-b", "feature/x", "origin/dev");
	writeFileSync(path.join(repo.main, "feature.txt"), "unpushed\n");
	repo.git("add", "feature.txt");
	repo.git("commit", "-q", "-m", "feat: unpushed work on feature/x");
	const tip = repo.git("rev-parse", "HEAD").trim();
	repo.git("checkout", "-q", "dev");
	return { tip };
}

test("create recipe: the default base, origin/dev, is still accepted", async () => {
	// Regression guard for the base-hygiene check: origin/dev carries no commits
	// the log check could find, so the default must be unaffected by it.
	const repo = await scratchRepo();
	try {
		const slug = "task-default-base";
		const result = runScript(retarget(recipe("Create", 0), { SLUG: slug }), { cwd: repo.main });
		assert.equal(result.status, 0, `create failed:\n${result.stderr}`);
		assert.ok(existsSync(repo.pathOf(slug)), "the worktree must exist");
		assert.equal(
			repo.gitIn(repo.pathOf(slug), "rev-parse", "HEAD").trim(),
			repo.originDev(),
			"must start at origin/dev",
		);
		// `git worktree add` writes "Preparing worktree ..." to stderr, so only the
		// warning itself can be asserted absent.
		assert.ok(!result.stderr.includes("warning:"), "a clean base must not warn");
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: refuses an unmerged feature branch as BASE", async () => {
	// feature/x contains origin/dev, so the ancestor check passes even though its
	// own commit has never been pushed. Cutting from it silently stacks the new
	// branch on unmerged work - the mistake AGENTS.md's log check catches.
	const repo = await scratchRepo();
	try {
		unmergedFeature(repo);
		const before = repo.worktrees();

		const result = runScript(retarget(recipe("Create", 0), { SLUG: "stacked-by-accident" }), {
			cwd: repo.main,
			env: { BASE: "feature/x" },
		});

		assert.notEqual(result.status, 0, "an unmerged BASE must fail the create");
		assert.match(result.stderr, /unpushed work on feature\/x/, "must print the foreign commit");
		assert.match(result.stderr, /BASE_STACKED=1/, "must name the deliberate opt-in");
		assert.ok(!existsSync(repo.pathOf("stacked-by-accident")), "must not create a worktree");
		assert.equal(repo.worktrees(), before, "the listing must not change");
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: BASE_STACKED=1 stacks on the unmerged base and warns on stderr", async () => {
	const repo = await scratchRepo();
	try {
		const { tip } = unmergedFeature(repo);
		const slug = "stacked-on-purpose";

		const result = runScript(retarget(recipe("Create", 0), { SLUG: slug }), {
			cwd: repo.main,
			env: { BASE: "feature/x", BASE_STACKED: "1" },
		});

		assert.equal(result.status, 0, `stacked create failed:\n${result.stderr}`);
		assert.ok(existsSync(repo.pathOf(slug)), "the worktree must exist");
		assert.equal(
			repo.gitIn(repo.pathOf(slug), "rev-parse", "HEAD").trim(),
			tip,
			"must be cut from feature/x, not origin/dev",
		);
		assert.notEqual(tip, repo.originDev(), "fixture: feature/x must be ahead of origin/dev");
		assert.match(result.stderr, /warning:.*feature\/x/, "the warning must name the base");
		assert.match(result.stderr, /1 commit/, "the warning must count the foreign commits");
		assert.ok(
			!result.stdout.includes("warning:"),
			"the warning must go to stderr, where the recipe's later output cannot swallow it",
		);
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: leaves no command that relies on errexit being off", async () => {
	// The failure the removal fix addresses is a block that only looks safe
	// because nothing sets -e. Create must also work when a caller does set it,
	// which catches an early `grep`/`[` probe whose non-zero status is ignored.
	const repo = await scratchRepo();
	try {
		const slug = "task-errexit";
		const result = runScript(retarget(recipe("Create", 0), { SLUG: slug }), {
			cwd: repo.main,
			errexit: true,
		});
		assert.equal(result.status, 0, `create failed under set -euo pipefail:\n${result.stderr}`);
		assert.ok(existsSync(repo.pathOf(slug)));
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: exits non-zero when the slug's branch is checked out elsewhere", async () => {
	// A branch can be checked out in at most one worktree. The block's last
	// command is the `git worktree add`, so its failure must be the exit status:
	// an agent that pasted it into a script would otherwise read success.
	const repo = await scratchRepo();
	try {
		const slug = "taken";
		repo.git("worktree", "add", "-q", path.join(repo.root, "linked"), "-b", slug, "origin/dev");

		const result = runScript(retarget(recipe("Create", 0), { SLUG: slug }), { cwd: repo.main });
		assert.notEqual(result.status, 0, "create must fail when the branch is checked out elsewhere");
		assert.match(result.stderr, /already used by worktree/);
		assert.ok(!existsSync(repo.pathOf(slug)), "must not leave a half-created worktree behind");
		assert.equal(linkedCount(repo.worktrees()), 1, "only the pre-existing worktree remains");
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: re-running it for the same slug fails instead of nesting", async () => {
	const repo = await scratchRepo();
	try {
		const slug = "task-twice";
		const script = retarget(recipe("Create", 0), { SLUG: slug });
		assert.equal(runScript(script, { cwd: repo.main }).status, 0);
		const before = repo.worktrees();

		const again = runScript(script, { cwd: repo.main });
		assert.notEqual(again.status, 0, "a second create must not exit 0");
		assert.match(again.stderr, /path already exists/);
		assert.equal(repo.worktrees(), before, "the listing must not change");
	} finally {
		await repo.cleanup();
	}
});

test("create recipe: refuses to run from inside a linked worktree", async () => {
	// Run from a linked worktree, `--show-toplevel` is that worktree and the new
	// tree would be nested inside it: `.worktrees/<slug>` under the wrong root.
	const repo = await scratchRepo();
	try {
		const linked = path.join(repo.root, "linked");
		repo.git("worktree", "add", "-q", linked, "-b", "probe", "origin/dev");

		const result = runScript(retarget(recipe("Create", 0), { SLUG: "nested" }), { cwd: linked });
		assert.notEqual(result.status, 0, "create must refuse a linked-worktree cwd");
		assert.match(result.stderr, /run this from the main checkout/);
		assert.ok(!existsSync(path.join(linked, ".worktrees", "nested")), "must not nest a worktree");
	} finally {
		await repo.cleanup();
	}
});

test("ignore guard recipe: newline-safe, and idempotent when actually executed", async () => {
	// The scratch clone's .gitignore is `node_modules` with no trailing newline,
	// which is the documented failure mode: appending directly yields
	// `node_modules.worktrees/`.
	const repo = await scratchRepo();
	try {
		const guard = recipe("Location convention", 0);
		const ignore = path.join(repo.main, ".gitignore");
		assert.equal(readFileSync(ignore, "utf8"), "node_modules", "fixture: no trailing newline");

		const first = runScript(guard, { cwd: repo.main });
		assert.equal(first.status, 0, first.stderr);
		assert.equal(readFileSync(ignore, "utf8"), "node_modules\n.worktrees/\n");

		const second = runScript(guard, { cwd: repo.main });
		assert.equal(second.status, 0, second.stderr);
		assert.equal(readFileSync(ignore, "utf8"), "node_modules\n.worktrees/\n", "must be idempotent");
	} finally {
		await repo.cleanup();
	}
});

test("ignore guard recipe: edits the main checkout's .gitignore when run from a linked worktree", async () => {
	// This section is the first thing an agent reads and the guard runs before
	// Create's main-checkout refusal, so it is routinely executed from inside a
	// linked worktree. A relative `.gitignore` then resolves to that worktree's
	// copy - the wrong file, untracked by the branch that will be committed.
	const repo = await scratchRepo();
	try {
		const linked = path.join(repo.root, "linked");
		repo.git("worktree", "add", "-q", linked, "-b", "probe", "origin/dev");

		const mainIgnore = path.join(repo.main, ".gitignore");
		const linkedIgnore = path.join(linked, ".gitignore");
		assert.equal(readFileSync(mainIgnore, "utf8"), "node_modules", "fixture: no trailing newline");
		assert.equal(readFileSync(linkedIgnore, "utf8"), "node_modules", "fixture: the checkout carries the same file");

		const guard = recipe("Location convention", 0);
		const result = runScript(guard, { cwd: linked });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(mainIgnore, "utf8"),
			"node_modules\n.worktrees/\n",
			"the main checkout's .gitignore must gain the entry, newline-safe",
		);
		assert.equal(
			readFileSync(linkedIgnore, "utf8"),
			"node_modules",
			"the linked worktree's own .gitignore must be left alone",
		);

		const again = runScript(guard, { cwd: linked });
		assert.equal(again.status, 0, again.stderr);
		assert.equal(readFileSync(mainIgnore, "utf8"), "node_modules\n.worktrees/\n", "must be idempotent");
		assert.equal(readFileSync(linkedIgnore, "utf8"), "node_modules", "still untouched on a second run");
	} finally {
		await repo.cleanup();
	}
});

test("ignore guard recipe: fails loudly outside a git repository instead of using an empty root", async () => {
	// `dirname ""` is `.`, so a failed --git-common-dir silently becomes the cwd
	// and the guard edits (or creates) a .gitignore it cannot vouch for.
	const dir = await mkdtemp(path.join(tmpdir(), "worktree-no-repo-"));
	try {
		await mkdir(path.join(dir, "empty"));
		const result = runScript(recipe("Location convention", 0), { cwd: path.join(dir, "empty") });
		assert.notEqual(result.status, 0, "must exit non-zero when the main root cannot be resolved");
		assert.ok(result.stderr.trim().length > 0, "must say why on stderr");
		assert.ok(!existsSync(path.join(dir, "empty", ".gitignore")), "must not invent a .gitignore");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("remove recipe: kills each session rooted in the tree once, even with a backslash in the path", async () => {
	// Two verified bugs in one sweep: `awk -v wt="$WT"` turns a backslash in the
	// path into an escape (so the pane never matches and the session leaks while
	// the tree is removed under a live shell), and `list-panes -a` prints one row
	// per pane (so a multi-pane session is killed once per pane and errors on the
	// second). Both are only visible by running the block against a listing.
	//
	// The backslash has to be in the *scratch root's* name: git records absolute
	// paths in the worktree's own metadata, so a tree cannot be renamed into shape
	// afterwards. `\t` rather than `\s` because `awk -v` only rewrites the escapes
	// it recognises - mawk leaves an unknown `\s` alone, which would let the bug
	// through.
	const repo = await scratchRepo({ rootPrefix: "worktree-skill-back\\tslash-" });
	const slug = "task-escaped";
	const session = "pi-wt-task-escaped";
	const wt = repo.pathOf(slug);
	let fake: FakeTmux | undefined;
	try {
		await mkdir(path.dirname(wt), { recursive: true });
		repo.git("worktree", "add", "-q", wt, "-b", slug, "origin/dev");
		assert.ok(wt.includes("\\"), "fixture: the worktree path must contain a backslash");
		assert.equal(linkedCount(repo.worktrees()), 1, "fixture: one linked worktree to remove");
		assert.ok(repo.worktrees().includes(`worktree ${wt}`), "fixture: the worktree must be registered");

		fake = await fakeTmux([
			// Two panes of one session: the exact path, and a descendant.
			{ session, panePath: wt },
			{ session, panePath: path.join(wt, ".pi") },
			// A session rooted elsewhere must survive the sweep.
			{ session: "pi-unrelated", panePath: path.join(repo.root, "elsewhere") },
		]);

		const result = runScript(retarget(recipe("Remove", 0), { SLUG: slug }), {
			cwd: repo.main,
			env: fake.env,
		});

		assert.equal(result.status, 0, `remove failed:\n${result.stderr}`);
		assert.ok(!existsSync(wt), "the worktree directory must be gone");
		assert.ok(!repo.worktrees().includes(`worktree ${wt}`), "git must no longer list the worktree");
		assert.deepEqual(await fake.kills(), [`kill-session -t ${session}`], "exactly one kill, of the matching session only");
		assert.doesNotMatch(result.stderr, /can't find session/, "no kill may target an already-dead session");
	} finally {
		await fake?.cleanup();
		await repo.cleanup();
	}
});
