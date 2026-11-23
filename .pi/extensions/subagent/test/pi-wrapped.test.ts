// `bin/pi-wrapped` is the launcher half of the agent-dir split: the ~/.bashrc
// hook `bin/pi-agent-dir --shell` installs covers a human in a terminal, and
// nothing else. A tmux child, a CI step or any launcher that bypasses a login
// shell gets an environment without the rc, so `pi` starts on the shared,
// package-installed agent dir — and a `pi` rooted in a linked worktree then
// discovers that tree's `.pi/extensions` while the package resolves the main
// checkout's copy, which pi treats as a load error before any model call
// (`docs/specs/2026-11-13-subagent-rooted-in-a-worktree.md`, geometry 3, README
// "One copy of the extensions, never two").
//
// These tests run the real wrapper with a stub `pi` first on PATH, because
// every property that matters is something an argument could break in transit:
// a wrapper that parses flags swallows `--` or eats `@file`, one that builds a
// command line instead of forwarding `"$@"` splits a value with a space, and one
// that exports over an existing `PI_CODING_AGENT_DIR` overrides an explicit
// choice. The stub records the argv it actually received and the agent dir it
// actually saw, so each of those is asserted directly rather than inferred from
// the wrapper's own output.
//
// The worktree case creates a real `git worktree add`, because the resolution
// goes through `--git-common-dir`: a `--show-toplevel` implementation passes in
// the main checkout and gets the worktree's own (unseeded) name here. Each
// sandbox, worktree included, is removed when the file's tests finish.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const WRAPPER = path.join(REPO_ROOT, "bin/pi-wrapped");
const AGENT_DIR_CLI = path.join(REPO_ROOT, "bin/pi-agent-dir");

// What the wrapper must hand to `pi`, and nothing else. The record is a file
// rather than stdout so it cannot be confused with what pi printed: the test
// asserts the passthrough of stdout separately.
const PI_STUB = `#!/usr/bin/env bash
{
	printf 'cwd=%s\\n' "$PWD"
	printf 'agent_dir=%s\\n' "\${PI_CODING_AGENT_DIR-<unset>}"
	printf 'argc=%s\\n' "$#"
	for arg in "$@"; do
		printf 'arg=%s\\n' "$arg"
	done
} >"\${PI_WRAPPED_LOG:?}"
printf 'stub-pi\\n'
exit "\${PI_WRAPPED_EXIT:-0}"
`;

type Sandbox = { root: string; home: string; repo: string; worktree: string; stubDir: string; log: string };

const sandboxes: Sandbox[] = [];
after(() => {
	for (const box of sandboxes) {
		// Removing the sandbox would take the worktree with it, but a linked
		// worktree is a git object until it is unregistered: do that first so a
		// run leaves no `.git/worktrees` entry behind either.
		spawnSync("git", ["-C", box.repo, "worktree", "remove", "--force", box.worktree], { encoding: "utf8" });
		rmSync(box.root, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
	});
}

/** A throwaway HOME, a stub `pi` on PATH, a git repo and one linked worktree — no agent dir yet. */
function sandbox(): Sandbox {
	const root = mkdtempSync(path.join(tmpdir(), "pi-wrapped-"));
	const home = path.join(root, "home");
	const repo = path.join(root, "work", "demo-repo");
	const worktree = path.join(root, "work", "demo-repo-wt");
	const stubDir = path.join(root, "stubs");
	const log = path.join(root, "pi.log");
	mkdirSync(home, { recursive: true });
	mkdirSync(stubDir, { recursive: true });
	writeFileSync(path.join(stubDir, "pi"), PI_STUB);
	chmodSync(path.join(stubDir, "pi"), 0o755);

	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(path.join(repo, "README.md"), "demo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	git(repo, "worktree", "add", "-q", worktree, "-b", "wt");

	const box = { root, home, repo, worktree, stubDir, log };
	sandboxes.push(box);
	return box;
}

/** The dir the wrapper must select, derived the way `pi-agent-dir` derives it. */
const expectedDir = (box: Sandbox) => path.join(box.home, ".pi", `agent-${path.basename(box.repo)}`);

/** Seed what `bin/pi-agent-dir` would create — enough of it for the selection rule. */
function seedAgentDir(box: Sandbox): string {
	const dir = expectedDir(box);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "settings.json"), "{}\n");
	return dir;
}

/** The environment a launcher would have: no agent dir, no shell hook, the stub pi first. */
function environment(box: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "PI_AGENT_ROOT", "PI_AGENT_BASE", "PI_SHELL_RC"]) delete env[key];
	return {
		...env,
		HOME: box.home,
		PATH: `${box.stubDir}:${env.PATH ?? ""}`,
		PI_WRAPPED_LOG: box.log,
		...extra,
	};
}

type Invocation = { status: number | null; stdout: string; stderr: string; cwd: string; agentDir?: string; argv: string[] };

/** Run the wrapper (optionally from another cwd) and read back what the stub `pi` saw. */
function invoke(
	box: Sandbox,
	cwd: string,
	args: string[],
	extra: Record<string, string> = {},
	script = WRAPPER,
): Invocation {
	rmSync(box.log, { force: true });
	const result = spawnSync(script, args, { cwd, env: environment(box, extra), encoding: "utf8" });
	const record = existsSync(box.log) ? readFileSync(box.log, "utf8") : "";
	const field = (name: string) => new RegExp(`^${name}=(.*)$`, "mu").exec(record)?.[1];
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		cwd: field("cwd") ?? "<pi was never started>",
		agentDir: field("agent_dir"),
		argv: record.split("\n").filter((line) => line.startsWith("arg=")).map((line) => line.slice(4)),
	};
}

// --- acceptance criteria ---------------------------------------------------

test("forwards its arguments unchanged, including flags, `--`, spaces and @file", () => {
	const box = sandbox();
	seedAgentDir(box);
	// The awkward set on purpose: a flag of pi's that a wrapper might mistake for
	// its own, the end-of-options marker, a value with a space, an `@file`
	// argument, and a `=`-joined pair. A wrapper that re-parses any of these
	// changes the list; one that adds `-p` of its own changes it too.
	const args = ["--print", "-p", "--", "a value with spaces", "@notes.md", "--model", "some model", "--flag=value"];
	const result = invoke(box, box.repo, args);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.argv, args, "the argv pi receives is exactly the argv the wrapper was given");
	assert.equal(result.stdout, "stub-pi\n", "stdout belongs to pi, not to the wrapper");
	assert.equal(result.cwd, box.repo);
});

test("with no arguments it starts pi with none, adding no print or one-shot flag", () => {
	const box = sandbox();
	seedAgentDir(box);
	const result = invoke(box, box.repo, []);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.argv, [], "whether the invocation is interactive is the caller's decision");
});

test("an agent dir already in the environment wins and is not overwritten", () => {
	const box = sandbox();
	seedAgentDir(box);
	const chosen = path.join(box.root, "chosen-by-the-caller");
	const result = invoke(box, box.repo, [], { PI_CODING_AGENT_DIR: chosen });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, chosen, "an explicit choice outranks a derived one");
	assert.doesNotMatch(result.stderr, /pi-wrapped:/u, "there is nothing to report: the run was already fully specified");
});

test("a blank PI_CODING_AGENT_DIR counts as unset, as it does for pi", () => {
	const box = sandbox();
	seedAgentDir(box);
	// pi resolves a blank value to the home default (`tools/mcp-catalogue.mjs`
	// records the same rule), so the wrapper must not export an agent dir named ""
	// over a perfectly good project dir.
	const result = invoke(box, box.repo, [], { PI_CODING_AGENT_DIR: "" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, expectedDir(box));
});

test("inside the repository it selects the project's agent dir, from a subdirectory too", () => {
	const box = sandbox();
	const dir = seedAgentDir(box);
	const subdir = path.join(box.repo, "nested");
	mkdirSync(subdir, { recursive: true });

	const result = invoke(box, subdir, [], {});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, dir);
	assert.equal(result.cwd, subdir, "the wrapper runs pi where it was started, not in the checkout root");
	assert.equal(result.stderr, "");
});

test("inside a linked worktree it selects the main checkout's dir, not one of its own", () => {
	const box = sandbox();
	const dir = seedAgentDir(box);

	const result = invoke(box, box.worktree, [], {});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, dir, "--git-common-dir, so a worktree maps to its main checkout");
	assert.equal(existsSync(path.join(box.home, ".pi", `agent-${path.basename(box.worktree)}`)), false);
});

test("the dir it selects is the same one bin/pi-agent-dir creates", () => {
	const box = sandbox();
	// The real helper, not a copy of its rule: the two must agree about the name,
	// or a launcher gets a different dir from the one the person seeded.
	const created = spawnSync(AGENT_DIR_CLI, ["--project", box.repo], {
		encoding: "utf8",
		env: environment(box),
	});
	assert.equal(created.status, 0, created.stderr);
	const dir = created.stdout.trim();

	const result = invoke(box, box.repo, [], {});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, dir);
});

test("outside a git repository it still runs pi, with defaults, and says so on stderr", () => {
	const box = sandbox();
	seedAgentDir(box);
	// No checkout anywhere up the tree from the sandbox root, so a wrapper that
	// guessed a path (dirname "" is ".") would export one for the wrong repo.
	const result = invoke(box, box.root, [], {});

	assert.equal(result.status, 0, "a launcher that dies because a path could not be derived is worse than one with defaults");
	assert.equal(result.stdout, "stub-pi\n", "the command ran");
	assert.equal(result.agentDir, "<unset>", "no override is exported");
	// The helper names the actual cause ("not a git checkout: <dir>"); the wrapper
	// adds only what it is doing about it. Before this, the wrapper guessed at two
	// causes and got both wrong for a deleted cwd or an unrunnable helper.
	assert.match(result.stderr, /pi-agent-dir: not a git checkout/u);
	assert.match(result.stderr, /pi-wrapped: no per-project agent dir for .*defaults/u);
});

test("a project dir that was never created is not created here: fall back and name the fix", () => {
	const box = sandbox();
	const result = invoke(box, box.repo, [], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, "<unset>", "an unseeded agent is a silently empty one, no better than the shared default");
	assert.equal(existsSync(expectedDir(box)), false, "the wrapper must not seed the user's agent root as a side effect");
	assert.match(result.stderr, /pi-wrapped: no per-project agent dir at .*settings\.json/u);
	assert.match(result.stderr, /bin\/pi-agent-dir/u, "the note says what to run, since creating it is the person's step");
});

test("pi's exit status is the wrapper's, and a flag it does not know is pi's problem, not its own", () => {
	const box = sandbox();
	seedAgentDir(box);
	const result = invoke(box, box.repo, ["--not-a-pi-flag"], { PI_WRAPPED_EXIT: "3" });
	assert.equal(result.status, 3, "exec replaces the process, so the status is pi's");
	assert.deepEqual(result.argv, ["--not-a-pi-flag"], "the wrapper does not validate or filter arguments");
});

// --- repository hygiene (acceptance criterion: executable, LF) --------------

test("the script is executable and uses LF line endings", () => {
	const mode = statSync(WRAPPER).mode & 0o777;
	assert.ok(mode & 0o111, `bin/pi-wrapped must be executable, mode is ${mode.toString(8)}`);
	const bytes = readFileSync(WRAPPER);
	assert.equal(bytes.includes(0x0d), false, "a CRLF checkout would break the shebang line in a container");
	assert.match(bytes.toString("utf8"), /^#!\/usr\/bin\/env bash\n/u, "an LF shebang is what a launcher executes");
});

test("a project dir that exists but was never seeded falls back on the settings rule", () => {
	// The rule is `settings.json`, not "the directory exists": an unseeded dir has
	// no credentials, no extensions and no skills, so selecting it would be worse
	// than the shared default. A `-d` test would pass the case below and fail the
	// intent.
	const box = sandbox();
	const dir = expectedDir(box);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "auth.json"), "{}\n");

	const result = invoke(box, box.repo, [], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, "<unset>");
	assert.match(result.stderr, /no per-project agent dir at .*settings\.json/u);
	assert.equal(existsSync(path.join(dir, "settings.json")), false, "the wrapper never seeds");
});

test("a symlinked launcher still resolves the helper beside the real script", () => {
	// A launcher is the caller most likely to be reached through a symlink on
	// PATH. `$0` is then the link, so the helper has to be found beside the real
	// script; without the resolution this falls back instead of selecting the dir.
	const box = sandbox();
	const dir = seedAgentDir(box);
	const linkDir = path.join(box.root, "bin-link");
	mkdirSync(linkDir, { recursive: true });
	const link = path.join(linkDir, "pi-wrapped");
	symlinkSync(WRAPPER, link);

	const result = invoke(box, box.repo, [], {}, link);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.agentDir, dir, "the helper was found beside the real script, not beside the link");
});
