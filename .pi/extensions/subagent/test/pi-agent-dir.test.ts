// `bin/pi-agent-dir` is the host-side half of the devcontainer's agent-dir
// split, and it exists for one failure: a child process rooted in
// `.worktrees/<slug>` discovers that tree's `.pi/extensions` while the installed
// package still resolves to the main checkout's copy, so pi exits 1 on duplicate
// tool registrations before any model call
// (`docs/specs/2026-11-13-subagent-rooted-in-a-worktree.md`, geometry 3, and the
// README section "One copy of the extensions, never two").
//
// These tests run the real script against throwaway HOME/repo trees, because
// every property that matters is a filesystem effect the script's own output
// cannot stand in for: a `settings.json` that still lists `.packages` recreates
// the conflict exactly, a `trust.json` missing the checkout yields a *silently
// empty* agent rather than a broken one, and a hook that resolved
// `--show-toplevel` instead of `--git-common-dir` would give each linked worktree
// a fresh, unseeded dir of its own. Each of those is asserted directly.
//
// The last test ties this convention to the one the devcontainer already
// declares, without repeating either literal: both are computed, so renaming one
// and not the other fails rather than drifting. It derives the container's name
// from `package.json` — the repo's identity — rather than from
// `basename(REPO_ROOT)`, which is the *checkout* directory and equals the repo's
// name only on a clone made into one; this container mounts the repo at
// `/workspace`, and the checkout-basename version of the assertion failed there.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SCRIPT = path.join(REPO_ROOT, "bin/pi-agent-dir");

type Sandbox = { root: string; home: string; agentRoot: string; base: string; repo: string; worktree: string; rc: string };

const sandboxes: Sandbox[] = [];
after(() => {
	for (const box of sandboxes) rmSync(box.root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** A throwaway HOME with a seeded base agent dir, a git repo and one linked worktree. */
function sandbox(): Sandbox {
	const root = mkdtempSync(path.join(tmpdir(), "pi-agent-dir-"));
	const home = path.join(root, "home");
	const agentRoot = path.join(home, ".pi");
	const base = path.join(agentRoot, "agent");
	const repo = path.join(root, "work", "demo-repo");
	const worktree = path.join(root, "work", "demo-repo-wt");
	const rc = path.join(home, ".bashrc");
	mkdirSync(base, { recursive: true });
	writeFileSync(
		path.join(base, "settings.json"),
		JSON.stringify({
			packages: ["/somewhere/else"],
			theme: "seed-theme",
			defaultProvider: "opencode-go",
			extensionChangelogVersions: { '{"source":"/somewhere/else"}': "0.0.0" },
		}),
	);
	writeFileSync(path.join(base, "auth.json"), '{"key":"seed"}\n');
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(path.join(repo, "README.md"), "demo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	git(repo, "worktree", "add", "-q", worktree, "-b", "wt");
	const box = { root, home, agentRoot, base, repo, worktree, rc };
	sandboxes.push(box);
	return box;
}

function run(box: Sandbox, ...args: string[]) {
	return spawnSync(SCRIPT, args, {
		encoding: "utf8",
		env: { ...process.env, HOME: box.home, PI_SHELL_RC: box.rc },
	});
}

/** The dir the script must produce for a sandbox: derived, never hard-coded. */
const expectedDir = (box: Sandbox) => path.join(box.agentRoot, `agent-${path.basename(box.repo)}`);

test("creates the per-project agent dir without packages and trusts the checkout", () => {
	const box = sandbox();
	const result = run(box, "--project", box.repo);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), expectedDir(box));

	const dir = expectedDir(box);
	const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
	assert.equal(settings.packages, undefined, "a packages entry here recreates the worktree conflict");
	assert.equal(settings.extensionChangelogVersions, undefined, "stale bookkeeping for a package that is not installed");
	assert.equal(settings.theme, "seed-theme");
	assert.equal(settings.defaultProvider, "opencode-go");

	const auth = path.join(dir, "auth.json");
	assert.equal(readFileSync(auth, "utf8"), '{"key":"seed"}\n');
	assert.equal(statSync(auth).mode & 0o777, 0o600, "credentials are reader-only");

	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "trust.json"), "utf8")), { [box.repo]: true });
});

test("is idempotent: existing settings, credentials and trust entries survive a re-run", () => {
	const box = sandbox();
	assert.equal(run(box, "--project", box.repo).status, 0);
	const dir = expectedDir(box);
	writeFileSync(path.join(dir, "settings.json"), '{"theme":"edited-by-hand"}\n');
	writeFileSync(path.join(dir, "auth.json"), '{"key":"rotated"}\n');
	writeFileSync(path.join(dir, "trust.json"), JSON.stringify({ "/other/project": true }));

	const second = run(box, "--project", box.repo);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(readFileSync(path.join(dir, "settings.json"), "utf8"), '{"theme":"edited-by-hand"}\n');
	assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), '{"key":"rotated"}\n');
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "trust.json"), "utf8")), {
		"/other/project": true,
		[box.repo]: true,
	});
});

test("a linked worktree resolves to its main checkout's dir, not one of its own", () => {
	const box = sandbox();
	const result = run(box, "--project", box.worktree);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), expectedDir(box));
	assert.equal(existsSync(path.join(box.base, `agent-${path.basename(box.worktree)}`)), false);
});

test("--print resolves the path and changes nothing", () => {
	const box = sandbox();
	const result = run(box, "--print", "--project", box.worktree);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), expectedDir(box));
	assert.equal(existsSync(expectedDir(box)), false);
});

test("--shell installs the hook once, and the hook resolves a worktree to that dir", () => {
	const box = sandbox();
	assert.equal(run(box, "--project", box.repo, "--shell").status, 0);
	assert.equal(run(box, "--project", box.repo, "--shell").status, 0);

	const rc = readFileSync(box.rc, "utf8");
	assert.equal(rc.match(/# >>> pi-agent-dir >>>/gu)?.length, 1, "the block is appended once, not once per run");
	assert.equal(rc.match(/# <<< pi-agent-dir <<</gu)?.length, 1);

	// The hook is the thing that has to be right, and only running it proves it:
	// a `--show-toplevel` implementation returns the worktree's own path here.
	const sourced = spawnSync(
		"bash",
		["-c", `. "${box.rc}"; cd "${box.worktree}"; __pi_agent_dir_for_pwd; printf '\\n'; cd "${box.repo}"; __pi_agent_dir_for_pwd`],
		{ encoding: "utf8", env: { ...process.env, HOME: box.home } },
	);
	assert.equal(sourced.status, 0, sourced.stderr);
	const [fromWorktree, fromMain] = sourced.stdout.trim().split("\n");
	assert.equal(fromWorktree, expectedDir(box));
	assert.equal(fromMain, expectedDir(box));

	// Outside any checkout it must fall through to the shared agent dir (empty
	// output), otherwise every unrelated project would silently lose its package.
	const outside = spawnSync("bash", ["-c", `. "${box.rc}"; cd "${box.root}"; __pi_agent_dir_for_pwd`], {
		encoding: "utf8",
		env: { ...process.env, HOME: box.home },
	});
	assert.equal(outside.status, 0, outside.stderr);
	assert.equal(outside.stdout, "");
});

test("--check fails while a package is still listed, and passes after the script has run", () => {
	const box = sandbox();
	assert.notEqual(run(box, "--check", "--project", box.repo).status, 0, "no dir yet: nothing to use");
	assert.equal(run(box, "--project", box.repo).status, 0);
	const checked = run(box, "--check", "--project", box.repo);
	assert.equal(checked.status, 0, checked.stderr);
});

test("the convention is the one devcontainer.json already declares", () => {
	// Computed on both sides: the guard in devcontainer-agent-dir.test.ts forbids
	// a second *literal*, and comparing derived values is what keeps the two
	// definitions from drifting apart.
	//
	// The name comes from `package.json` — the repo's identity — and deliberately
	// *not* from `basename(REPO_ROOT)`, which is the checkout's directory and only
	// equals the repo's name when the clone was made into one of that name. This
	// container mounts the repo at `/workspace`, so the checkout-basename form of
	// this assertion failed inside the very container the convention exists for,
	// while passing in a CI checkout (`.../my-agent-setup/my-agent-setup`). The
	// script's own rule, `agent-<main checkout name>`, is already pinned by the
	// sandbox tests above, which derive `expectedDir` from the sandbox's repo name.
	const { name: projectName } = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
		name: string;
	};
	const declared = /"PI_CODING_AGENT_DIR"\s*:\s*"([^"]+)"/u.exec(
		readFileSync(path.join(REPO_ROOT, ".devcontainer", "devcontainer.json"), "utf8"),
	)?.[1];
	assert.ok(declared, ".devcontainer/devcontainer.json must declare PI_CODING_AGENT_DIR");
	assert.equal(path.basename(declared), `agent-${projectName}`);
	// A sibling of the shared agent dir, never nested inside it: the script's
	// sandbox tests pin the same shape against a temp HOME.
	assert.equal(path.basename(path.dirname(declared)), ".pi");
});
