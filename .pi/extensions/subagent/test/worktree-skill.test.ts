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
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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
	assert.ok(SKILL.includes('worktree remove "$WT"'), "must try the safe removal first");
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
	const endState = recipe("Remove", 3);
	assert.match(endState, /^SLUG="task-name"/m, "the end-state block must set SLUG");
	// Deliberately not `includes('git -C "$R" …')`: the `-C` contract belongs to
	// the executable test below ("every end-state check runs at the resolved main
	// root"), which asserts the argv git received. A substring match here would
	// pass even if the harness stopped running the block.
	assert.ok(endState.includes("worktree list"), "end state must list worktrees");
	assert.ok(endState.includes('branch --list "$SLUG"'), "end state must check the branch");
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

test("worktree skill: names the package copy as the case the launcher cannot dedupe", () => {
	// A child whose tree has its own copy is deduped by the launcher (#103). A host
	// that also installs this repo as a package defeats that: pi discovers the
	// package copy too, and that one is the main checkout's file. Verified by
	// running the real child argv in tmux; see
	// docs/specs/2026-11-13-subagent-rooted-in-a-worktree.md.
	assert.ok(
		SKILL.includes("The package copy is the one case that fix cannot cover."),
		"must name the package copy as a second, unfixable conflict",
	);
	assert.ok(SKILL.includes('Tool "get_goal" conflicts with'), "must quote the per-extension conflict a reader sees");
	assert.ok(
		SKILL.includes("uninstall the package before working in this repo's worktrees"),
		"must give the remedy a host can act on",
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
	}
});

// ---------------------------------------------------------------------------
// The same sweep, against a real tmux server
// ---------------------------------------------------------------------------
//
// The fake above answers from a fixture we wrote, so it can only catch what we
// already knew to reproduce: change the recipe's `-F` field order, or the way it
// calls `kill-session`, and the fake happily answers anyway. A real server is
// the only thing that turns "one row per pane", the survivors of a kill and the
// wording of a second kill into facts rather than assumptions.

/**
 * The sweep's own listing format, spelled the way the recipe spells it: one row
 * per *pane*, `#{session_name}` then `#{pane_current_path}`, tab-separated.
 */
const LIVE_PANE_FORMAT = "#{session_name}\t#{pane_current_path}";

interface LiveTmux {
	/** `tmux -S <socket> <args>`, captured rather than thrown. */
	run(...args: string[]): { status: number | null; stdout: string; stderr: string };
	/** One row per pane, straight from the server - not from a fixture. */
	panes(): Array<{ session: string; panePath: string }>;
	/** Stop the server. Safe to call when it never started. */
	stop(): void;
}

/**
 * A real tmux server on `<root>/tmux-sockets/pi.sock`, under the scratch repo,
 * so this test cannot reach this host's ambient sessions. `node --test` runs test *files* in
 * parallel, and the socket lives under this file's own `mkdtemp` root, so two
 * files cannot end up sharing one server.
 *
 * No TTY: everything is created detached.
 */
function liveTmux(root: string): LiveTmux {
	const socket = path.join(root, "tmux-sockets", "pi.sock");
	mkdirSync(path.dirname(socket), { recursive: true });

	const run = (...args: string[]) => {
		// `cwd: root`, not the repo: a tmux client that has to start the server
		// gives the server its own cwd, which must not be the tree under test.
		const result = spawnSync("tmux", ["-S", socket, ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
		});
		if (result.error) throw result.error;
		return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};

	return {
		run,
		panes: () => {
			const listing = run("list-panes", "-a", "-F", LIVE_PANE_FORMAT);
			assert.equal(listing.status, 0, `live tmux: list-panes failed:\n${listing.stderr}`);
			return listing.stdout
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => {
					const [session, panePath] = line.split("\t");
					return { session, panePath };
				});
		},
		stop: () => {
			run("kill-server");
		},
	};
}

/**
 * Whether a pane's reported cwd is the tree itself or inside it.
 *
 * A pane whose directory has since been removed is reported as `<path>
 * (deleted)` - precisely the state a leaked session is in once the removal has
 * run - so that suffix is stripped first. Without it, a session whose only pane
 * sat at the tree's root slips past a prefix comparison on the one run that
 * matters (verified with the `awk -v` mutation).
 */
function insideTree(panePath: string, wt: string): boolean {
	const at = panePath.replace(/ \(deleted\)$/, "");
	return at === wt || at.startsWith(wt + path.sep);
}

test("remove recipe: a live tmux server loses the tree's sessions and keeps the decoy", async (t) => {
	// tmux missing is an environment fact, not a failure of the recipe: the fake
	// above still pins the argv shape and the no-server path on such a host, and
	// the skip says out loud that the live coverage did not run.
	const probe = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		t.skip("tmux is not installed on this host, so the live sweep coverage did not run");
		return;
	}

	// The scratch root carries a backslash for the same reason the fake test's
	// does: `awk -v` rewrites `\t` in its value, so only a path with a literal
	// backslash shows that the recipe hands the path to awk through ENVIRON.
	const repo = await scratchRepo({ rootPrefix: "worktree-skill-live-back\\tslash-" });
	// tmux reports a pane's cwd as the OS resolved it, while the sweep compares it
	// with the recipe's raw `$WT`. A scratch root behind a symlink would differ, so
	// this fails here for a filesystem reason rather than letting the sweep look
	// broken. (Verified on this host: `/tmp` is not a symlink.)
	if (realpathSync(repo.root) !== repo.root) {
		t.skip(`the scratch root resolves to ${realpathSync(repo.root)}, so a pane's cwd cannot match the recipe's raw path`);
		return;
	}

	const slug = "live-sweep";
	const wt = repo.pathOf(slug);
	const session = `pi-wt-${slug}`;
	const decoy = "pi-unrelated";
	const tmux = liveTmux(repo.root);
	try {
		repo.git("worktree", "add", "-q", wt, "-b", slug, "origin/dev");
		assert.ok(wt.includes("\\"), "fixture: the worktree path must contain a backslash");

		// A second pane in a subdirectory of the tree. The directory has to exist:
		// `split-window -c` silently falls back to the server's own cwd for a
		// missing path, which would put this pane outside the tree and turn the
		// whole test into a single-pane case that passes for the wrong reason.
		const sub = path.join(wt, "sub");
		await mkdir(sub);
		assert.equal(tmux.run("new", "-d", "-s", session, "-c", wt).status, 0, "fixture: new-session");
		assert.equal(tmux.run("split-window", "-d", "-t", session, "-c", sub).status, 0, "fixture: split-window");
		assert.equal(tmux.run("new", "-d", "-s", decoy, "-c", repo.root).status, 0, "fixture: decoy session");

		// Before the sweep: one row per *pane*, so the deduplication the recipe
		// needs is actually exercised. A single-pane listing would not catch its
		// absence.
		const before = tmux.panes();
		const targetRows = before.filter((pane) => pane.session === session);
		assert.equal(targetRows.length, 2, `fixture: expected two rows for ${session}, got:\n${before.map((p) => `${p.session}\t${p.panePath}`).join("\n")}`);
		assert.deepEqual(
			targetRows.map((pane) => pane.panePath).sort(),
			[wt, sub].sort(),
			"fixture: both panes of the target session must be rooted inside the tree",
		);
		assert.deepEqual(
			before.filter((pane) => pane.session === decoy).map((pane) => pane.panePath),
			[repo.root],
			"fixture: the decoy session must be rooted outside the tree",
		);

		const result = runScript(retarget(recipe("Remove", 0), { SLUG: slug }), {
			cwd: repo.main,
			env: isolatedTmux(repo),
		});

		assert.equal(result.status, 0, `remove failed:\n${result.stderr}`);
		assert.ok(!existsSync(wt), "the worktree directory must be gone");

		const after = tmux.panes();
		assert.deepEqual(
			after.filter((pane) => insideTree(pane.panePath, wt)).map((pane) => `${pane.session}\t${pane.panePath}`),
			[],
			"no session with a pane inside the removed tree may survive the sweep",
		);
		assert.ok(
			!after.some((pane) => pane.session === session),
			`${session}, whose panes were all inside the tree, must not survive the sweep`,
		);
		assert.ok(
			after.some((pane) => pane.session === decoy),
			"the decoy session is rooted outside the tree and must survive",
		);
		// The sweep tolerates its own failure with `|| true`, so a second
		// `kill-session` against the real server is only visible as its wording.
		assert.doesNotMatch(result.stderr, /can't find session/, `the sweep killed a session twice:\n${result.stderr}`);
	} finally {
		// The server must be gone even when an assertion above failed: a surviving
		// server keeps its panes alive on a cwd that no longer exists, and the next
		// run on this host inherits sessions it did not create. `list-sessions`
		// exits 1 with "no server running" - it never starts one - so this is the
		// check, and it runs before the scratch repo (socket included) is deleted.
		tmux.stop();
		const sessions = tmux.run("list-sessions");
		assert.equal(sessions.status, 1, `live tmux: kill-server left a server behind:\n${sessions.stdout}`);
		await repo.cleanup();
	}
});

// --- Remove: the failure this section exists to stop -----------------------
//
// `recipe("Remove", 0)` ended with `rmdir -p ... || true`, so a *refused*
// removal of a dirty worktree (git exits 128, the tree survives) exited 0. An
// agent reads that as success and moves on with the branch still checked out.
// The fix is `set -e` plus a resolved main root; these tests pin the exit
// statuses and the guidance a reader gets, not the tokens.

/**
 * Point tmux at an isolated socket under the scratch repo. Whether tmux is
 * installed here or not, that socket has no server: the sweep's `list-panes`
 * fails, which the block must tolerate without aborting the removal - and it
 * must not touch this host's real sessions.
 */
function isolatedTmux(repo: { root: string }): Record<string, string> {
	return { PI_TMUX_SOCKET_DIR: path.join(repo.root, "tmux-sockets") };
}

/**
 * Run `code` from a cwd that no longer exists. The directory is created and
 * removed inside the script, so the recipe runs exactly as a shell would run it
 * after the cwd vanished - the case where `rev-parse` prints nothing and fails
 * 128. `where` only seeds the shell's starting directory, outside any repo.
 */
function runWithDeletedCwd(
	code: string,
	where: string,
	env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
	return runScript(`d="$(mktemp -d)"; cd "$d"; rmdir "$d"; ${code}`, { cwd: where, env });
}

test("remove recipe: a refused dirty removal exits non-zero and leaves the tree alone", async () => {
	const repo = await scratchRepo();
	try {
		const slug = "dirty-one";
		const wt = repo.pathOf(slug);
		repo.git("worktree", "add", "-q", wt, "-b", slug, "origin/dev");
		writeFileSync(path.join(wt, "untracked.txt"), "not committed\n");

		const result = runScript(retarget(recipe("Remove", 0), { SLUG: slug }), {
			cwd: repo.main,
			env: isolatedTmux(repo),
		});

		assert.notEqual(result.status, 0, "a refused removal must not exit 0 - that is the bug");
		assert.match(
			result.stderr,
			/contains modified or untracked files|use --force/,
			`stderr must name the refusal:\n${result.stderr}`,
		);
		assert.ok(existsSync(wt), "the worktree must survive the refusal");
		assert.ok(existsSync(path.join(wt, "untracked.txt")), "so must its uncommitted file");
		assert.ok(repo.worktrees().includes(`worktree ${wt}`), "it must stay registered");
		assert.equal(linkedCount(repo.worktrees()), 1, "nothing else may be removed");
	} finally {
		await repo.cleanup();
	}
});

test("remove recipe: a clean removal exits 0 and leaves nothing behind", async () => {
	const repo = await scratchRepo();
	try {
		const slug = "clean-one";
		const wt = repo.pathOf(slug);
		repo.git("worktree", "add", "-q", wt, "-b", slug, "origin/dev");

		const result = runScript(retarget(recipe("Remove", 0), { SLUG: slug }), {
			cwd: repo.main,
			env: isolatedTmux(repo),
		});

		assert.equal(result.status, 0, `clean removal failed:\n${result.stderr}`);
		assert.ok(!existsSync(wt), "the directory must be gone");
		assert.equal(linkedCount(repo.worktrees()), 0, "only the main worktree may remain");
		// The listing failure is tolerated only for the sweep: no tmux noise (a
		// missing server, or a missing binary) may reach the reader as if it were
		// part of the removal.
		assert.ok(
			!/tmux/i.test(result.stderr + result.stdout),
			`the tolerated sweep must stay quiet:\n${result.stderr}`,
		);
	} finally {
		await repo.cleanup();
	}
});

test("remove recipe: the end-state check fails loudly when the cwd is gone", async () => {
	// With a deleted cwd, `rev-parse --path-format=absolute --git-common-dir`
	// fails 128 and prints nothing, so a recipe that keeps going runs git against
	// ".", or against "". The reader must be told to run from a live checkout.
	const repo = await scratchRepo();
	try {
		const result = runWithDeletedCwd(
			retarget(recipe("Remove", 3), { SLUG: "any-slug" }),
			repo.root,
			isolatedTmux(repo),
		);
		assert.notEqual(result.status, 0, "a vanished cwd must not read as a clean end state");
		assert.match(
			result.stderr,
			/run from a live checkout/,
			`stderr must say what to do instead:\n${result.stderr}`,
		);
	} finally {
		await repo.cleanup();
	}
});

test("remove recipe: branch cleanup fails loudly when the cwd is gone", async () => {
	const repo = await scratchRepo();
	try {
		const result = runWithDeletedCwd(
			retarget(recipe("Remove", 1), { SLUG: "any-slug" }),
			repo.root,
			isolatedTmux(repo),
		);
		assert.notEqual(result.status, 0, "branch cleanup must not report success for a no-op");
		assert.match(
			result.stderr,
			/run from a live checkout/,
			`stderr must say what to do instead:\n${result.stderr}`,
		);
	} finally {
		await repo.cleanup();
	}
});

// --- Remove: the resolved-root contract ------------------------------------
//
// `Remove[1]` and `Remove[3]` run git as `git -C "$R" ...`, where `$R` is the
// main checkout resolved from `--git-common-dir`. That contract is invisible to
// every behavioural test in this file: linked worktrees share refs, so a bare
// `git branch -D <slug>` and a `git -C <main> branch -D <slug>` delete the same
// ref with the same output and exit status from any cwd inside the repository
// (verified), and the end-state checks likewise read the same shared refs. A
// future edit that drops `-C` - or resolves something other than the checkout
// the block just resolved - would therefore pass the whole suite while these
// blocks stopped acting on the root they resolved and started acting on wherever
// the reader happens to stand.
//
// `GIT_TRACE=1` cannot see it either: `-C` is consumed before tracing, so the
// trace prints `built-in: git branch -D task-name` whether the flag was passed
// or not (git 2.56.0). The argv git actually receives is the only seam, so that
// is what these two tests assert - never the text of `SKILL.md`, which would
// pass even if the harness stopped running the block.

interface GitRecorder {
	/** `PATH` (wrapper bin first) plus the wrapper's own file locations. */
	env: Record<string, string>;
	/** One line per `git` invocation: that call's arguments, space-joined, in order. */
	calls(): Promise<string[]>;
	cleanup(): Promise<void>;
}

/**
 * A `git` stand-in that appends its argv to a log, then `exec`s the real binary.
 *
 * Transparent by construction: the real git is resolved from `PATH` *before* the
 * wrapper's directory is prepended, so the wrapper cannot find itself and no
 * path is hardcoded (the devcontainer may put a shim first - that shim is what
 * gets recorded and executed). `exec "$REAL_GIT" "$@"` replaces the shell, so
 * exit status, stdout and stderr are git's own and nothing is buffered; argv is
 * forwarded verbatim, so a call with no arguments logs an empty line rather
 * than failing. The passthrough is asserted too (the branch is really deleted),
 * which is what catches a wrapper that dead-ends.
 */
async function recordGit(): Promise<GitRecorder> {
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	if (!path.isAbsolute(realGit)) throw new Error(`could not resolve git from PATH, got ${JSON.stringify(realGit)}`);

	const dir = await mkdtemp(path.join(tmpdir(), "record-git-"));
	const bin = path.join(dir, "bin");
	const log = path.join(dir, "argv.log");
	await mkdir(bin);

	const wrapper = path.join(bin, "git");
	await writeFile(
		wrapper,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_ARGV_LOG"
exec "$REAL_GIT" "$@"
`,
	);
	await chmod(wrapper, 0o755);

	return {
		env: {
			// Only `git` is shadowed: `bash`, `awk`, `sort` and `gh` still resolve normally.
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			GIT_ARGV_LOG: log,
			REAL_GIT: realGit,
		},
		calls: async () => {
			if (!existsSync(log)) return [];
			return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
		},
		cleanup: async () => {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

const ROOT_DISCOVERY = "rev-parse --path-format=absolute --git-common-dir";

/**
 * The main root the recipes resolve, from the same cwd and command they use.
 * Deliberately not a hardcoded path: the assertion has to move with git's own
 * answer, or it would pin this workspace's layout instead of the contract.
 */
function resolvedRoot(repo: { gitIn(dir: string, ...args: string[]): string }, cwd: string): string {
	return path.dirname(repo.gitIn(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
}

/**
 * Assert the resolved-root contract: the first call discovers the root (it has
 * no `-C` by design, there is nothing to point at yet), and every call after it
 * is rooted at exactly that checkout. Skipping the discovery call keeps the rule
 * "after resolution everything is rooted" rather than "every line contains -C",
 * which is false for the line that does the resolving.
 */
function assertRooted(calls: string[], root: string): string[] {
	assert.ok(calls.length > 0, "the block must have called git at all");
	assert.equal(calls[0], ROOT_DISCOVERY, "the first call is the root discovery and takes no -C");
	const afterResolution = calls.slice(1);
	assert.ok(afterResolution.length > 0, "the block must still call git once the root is known");
	for (const call of afterResolution) {
		assert.ok(
			call.startsWith(`-C ${root} `),
			`every call after the root discovery must carry -C ${root}, got: ${call}`,
		);
	}
	return afterResolution;
}

test("remove recipe: branch cleanup deletes the branch from the main root, not the cwd", async () => {
	// Run from a *linked worktree* on purpose: bare git works there too, which is
	// exactly why the -C contract needs a non-behavioural seam (see the section
	// comment above). The recorder is the seam; the deletion is the proof that the
	// wrapper passed through rather than swallowing the call.
	const repo = await scratchRepo();
	let recorder: GitRecorder | undefined;
	const slug = "task-branch-cleanup";
	try {
		const linked = path.join(repo.root, "linked-cwd");
		repo.git("worktree", "add", "-q", linked, "-b", "probe", "origin/dev");

		// The branch `Remove[1]` force-deletes must be *unmerged*: the recipe uses
		// `branch -D` deliberately (a squash merge leaves the branch unmerged as
		// far as git is concerned), so a merged fixture would not exercise it.
		repo.git("checkout", "-q", "-b", slug, "origin/dev");
		writeFileSync(path.join(repo.main, "unmerged.txt"), "not merged\n");
		repo.git("add", "unmerged.txt");
		repo.git("commit", "-q", "-m", `feat: unmerged work on ${slug}`);
		const tip = repo.git("rev-parse", "--short", "HEAD").trim();
		repo.git("checkout", "-q", "dev");
		assert.throws(
			() => repo.git("merge-base", "--is-ancestor", slug, "dev"),
			"fixture: the branch must not be merged, so -D is the path under test",
		);
		assert.equal(repo.git("branch", "--list", slug).trim().length > 0, true, "fixture: the branch exists");

		recorder = await recordGit();
		const result = runScript(retarget(recipe("Remove", 1), { SLUG: slug }), {
			cwd: linked,
			env: recorder.env,
		});

		// The wrapper passed through: git's own exit status, the branch is gone, and
		// the message git printed is the one the reader sees - nothing is swallowed
		// or retold by the wrapper.
		assert.equal(result.status, 0, `branch cleanup failed:\n${result.stderr}`);
		assert.equal(repo.git("branch", "--list", slug).trim(), "", "the branch must really be deleted");
		assert.match(
			result.stdout,
			new RegExp(`Deleted branch ${slug} \\(was ${tip}\\)`),
			`git's own stdout must reach the caller:\n${result.stdout}`,
		);
		assert.equal(result.stderr, "", "a transparent wrapper must not add stderr of its own");

		const root = resolvedRoot(repo, linked);
		assert.equal(root, repo.main, `fixture: the resolved root must be the main checkout, got ${root}`);
		const afterResolution = assertRooted(await recorder.calls(), root);
		assert.deepEqual(
			afterResolution,
			[`-C ${root} branch -D ${slug}`],
			"the force delete must be the one call made after resolving the root",
		);
	} finally {
		await recorder?.cleanup();
		await repo.cleanup();
	}
});

test("remove recipe: every end-state check runs at the resolved main root", async () => {
	// Same complaint as above, three calls wide: `worktree list`, `prune -n` and
	// `branch --list` all read state shared by every worktree, so running them
	// from the reader's cwd looks identical - and is a different checkout.
	const repo = await scratchRepo();
	let recorder: GitRecorder | undefined;
	const slug = "task-end-state";
	try {
		const linked = path.join(repo.root, "linked-cwd");
		repo.git("worktree", "add", "-q", linked, "-b", "probe", "origin/dev");

		recorder = await recordGit();
		const result = runScript(retarget(recipe("Remove", 3), { SLUG: slug }), {
			cwd: linked,
			env: recorder.env,
		});
		assert.equal(result.status, 0, `end-state check failed:\n${result.stderr}`);
		// git's listing is what the reader is asked to inspect, so it has to be
		// git's own output, not something the wrapper consumed.
		assert.ok(
			result.stdout.includes(repo.main) && result.stdout.includes(linked),
			`the worktree listing must reach the caller:\n${result.stdout}`,
		);

		const root = resolvedRoot(repo, linked);
		assert.equal(root, repo.main, `fixture: the resolved root must be the main checkout, got ${root}`);
		const afterResolution = assertRooted(await recorder.calls(), root);
		assert.deepEqual(
			afterResolution,
			[`-C ${root} worktree list`, `-C ${root} worktree prune -n`, `-C ${root} branch --list ${slug}`],
			"all three end-state checks must run at the resolved root",
		);
	} finally {
		await recorder?.cleanup();
		await repo.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Repair: bookkeeping across a move
// ---------------------------------------------------------------------------

test("repair recipe: re-points a worktree after the whole root moves", async () => {
	// A remounted `/workspace` moves main and every linked tree at once, so both
	// recorded paths go stale: the tree's `.git` names the old main, and the main's
	// admin entry names the old tree. This is not the "create then rename" mistake
	// `scratchRepo({ rootPrefix })` exists to avoid - there a rename would
	// invalidate the fixture; here the move is the scenario under test.
	const repo = await scratchRepo();
	const moved = `${repo.root}-moved`;
	const slug = "task-moved";
	const newMain = path.join(moved, "main");
	const newWt = path.join(moved, "main", ".worktrees", slug);
	try {
		repo.git("worktree", "add", "-q", repo.pathOf(slug), "-b", slug, "origin/dev");
		renameSync(repo.root, moved);

		assert.notEqual(
			runScript("git status --short --branch", { cwd: newWt }).status,
			0,
			"the tree's .git still names the old main checkout",
		);
		const before = runScript("git worktree list --porcelain", { cwd: newMain });
		assert.ok(before.stdout.includes("prunable"), "the stale registration is marked prunable");
		assert.ok(!before.stdout.includes(`worktree ${newWt}`), "and is not listed at its current path");

		// Prune would delete the entry repair needs - the warning the skill gives
		// before anyone reaches for "clean up".
		const dryRun = runScript("git worktree prune -n", { cwd: newMain });
		assert.match(dryRun.stdout + dryRun.stderr, /Removing worktrees\//);

		const result = runScript(retarget(recipe("Repair", 0), { SLUG: slug }), { cwd: newMain });
		assert.equal(result.status, 0, `repair failed:\n${result.stderr}`);

		const after = runScript("git worktree list --porcelain", { cwd: newMain });
		assert.ok(after.stdout.includes(`worktree ${newWt}`), "must be listed at its current path");
		assert.equal(
			runScript("git rev-parse --abbrev-ref HEAD", { cwd: newWt }).stdout.trim(),
			slug,
			"and git must work in the tree again",
		);
	} finally {
		await rm(moved, { recursive: true, force: true });
		await repo.cleanup();
	}
});

test("repair: a repaired copy is not installed as a second worktree", async () => {
	// Backs the prose warning. The copy shares the original's administrative entry,
	// so repair re-points that one entry instead of adding the copy beside it.
	const repo = await scratchRepo();
	try {
		const slug = "task-copy";
		const wt = repo.pathOf(slug);
		repo.git("worktree", "add", "-q", wt, "-b", slug, "origin/dev");
		const copy = path.join(repo.root, "wt-copy");
		cpSync(wt, copy, { recursive: true });

		repo.git("worktree", "repair", copy);
		const listing = repo.worktrees();
		assert.ok(listing.includes(`worktree ${copy}`), "the registration follows the copy");
		assert.ok(!listing.includes(`worktree ${wt}`), "there is no second entry for the original");
	} finally {
		await repo.cleanup();
	}
});

test("repair: a bare repair is enough when only the main checkout moved", async () => {
	// The other half of the argument rule, and the reason the skill names it: a
	// tree whose directory did not move is still discoverable from its admin
	// entry, so bare `git worktree repair` rewrites its `.git` file. Reach for the
	// path form when the tree's own path is stale instead (the test above).
	const repo = await scratchRepo();
	const movedMain = `${repo.main}-moved`;
	const sibling = path.join(repo.root, "sibling-wt");
	try {
		repo.git("worktree", "add", "-q", sibling, "-b", "sibling", "origin/dev");
		renameSync(repo.main, movedMain);

		assert.notEqual(
			runScript("git status --short --branch", { cwd: sibling }).status,
			0,
			"the sibling's .git still names the old main checkout",
		);
		const repair = runScript("git worktree repair", { cwd: movedMain });
		assert.equal(repair.status, 0, repair.stderr);
		assert.equal(
			runScript("git rev-parse --abbrev-ref HEAD", { cwd: sibling }).stdout.trim(),
			"sibling",
			"bare repair must restore a tree that stayed put",
		);
	} finally {
		await rm(movedMain, { recursive: true, force: true });
		await repo.cleanup();
	}
});
