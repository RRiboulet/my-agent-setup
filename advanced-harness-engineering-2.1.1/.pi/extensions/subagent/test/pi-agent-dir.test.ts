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
// The last test covers the devcontainer's half of the naming rule on its own: the
// dir it declares is `agent-<project name>`, derived from `package.json`. It does
// not claim to pin the script's half — that is `agent-<main checkout directory
// name>`, pinned by the sandbox tests above — because the two sources are
// different and agree only by the coincidence of a clone made into a directory
// named after the repo. Nor does it use `basename(REPO_ROOT)`: that is the
// *checkout* directory, and this container mounts the repo at `/workspace`, where
// the checkout-basename form of the assertion failed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SCRIPT = path.join(REPO_ROOT, "bin/pi-agent-dir");

type Sandbox = { root: string; home: string; agentRoot: string; base: string; repo: string; worktree: string; rc: string };

const sandboxes: Sandbox[] = [];
const scratchDirs: string[] = [];
after(() => {
	for (const box of sandboxes) rmSync(box.root, { recursive: true, force: true });
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
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

function runScript(script: string, box: Sandbox, ...args: string[]) {
	return spawnSync(script, args, {
		encoding: "utf8",
		env: { ...process.env, HOME: box.home, PI_SHELL_RC: box.rc },
	});
}

function run(box: Sandbox, ...args: string[]) {
	return runScript(SCRIPT, box, ...args);
}

/** The dir the script must produce for a sandbox: derived, never hard-coded. */
const expectedDir = (box: Sandbox) => path.join(box.agentRoot, `agent-${path.basename(box.repo)}`);

/** The catalogue this package ships, which the seed step copies from. */
const catalogue = () =>
	JSON.parse(readFileSync(path.join(REPO_ROOT, "mcp", "catalogue.json"), "utf8")) as {
		mcpServers: Record<string, { enabled?: boolean; exposure?: string }>;
	};

/**
 * A copy of the script with its own catalogue module, for the one case the real
 * checkout cannot supply: a catalogue that cannot be read. The module resolves
 * `mcp/catalogue.json` relative to *its own* location, so the only way to break
 * it for one run is a copied tree — the alternative, editing the repo's
 * catalogue, is the file the other tests assert against.
 */
function scriptWithBrokenCatalogue(how: "missing" | "invalid"): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-agent-dir-cli-"));
	scratchDirs.push(root);
	for (const dir of ["bin", "tools", "mcp"]) mkdirSync(path.join(root, dir), { recursive: true });
	copyFileSync(SCRIPT, path.join(root, "bin", "pi-agent-dir"));
	copyFileSync(path.join(REPO_ROOT, "tools", "mcp-catalogue.mjs"), path.join(root, "tools", "mcp-catalogue.mjs"));
	if (how === "invalid") writeFileSync(path.join(root, "mcp", "catalogue.json"), "{ not json\n");
	return path.join(root, "bin", "pi-agent-dir");
}

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

// --- the MCP catalogue seed (spec R5, host half) ----------------------------
//
// Seeding and installing are deliberately different semantics: this step runs
// unattended on every invocation, so it may only ever *create* the file. An
// entry someone deleted has to stay deleted, which is why a pre-existing file is
// asserted byte for byte rather than field by field.

test("a fresh agent dir starts with the catalogue, every server disabled", () => {
	const box = sandbox();
	const result = run(box, "--project", box.repo);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), expectedDir(box), "the script's stdout is the dir, never the module's report");

	const seeded = JSON.parse(readFileSync(path.join(expectedDir(box), "mcp.json"), "utf8")) as {
		mcpServers: Record<string, { enabled?: boolean; exposure?: string }>;
	};
	const names = Object.keys(catalogue().mcpServers);
	assert.ok(names.length > 0, "the catalogue must ship at least one server");
	assert.deepEqual(Object.keys(seeded.mcpServers).sort(), [...names].sort(), "every catalogue server, seeded");
	for (const name of names) {
		assert.equal(seeded.mcpServers[name]?.enabled, false, `${name} must seed disabled: nothing may connect on its own`);
		assert.equal(seeded.mcpServers[name]?.exposure, "codemode", `${name} must state its exposure rather than inherit a default`);
	}
	assert.match(result.stderr, /created {2}.*mcp\.json/u, "the seeding note belongs on stderr, beside the settings note");
});

test("an existing mcp.json is the project's own: neither merged into nor rewritten", () => {
	const box = sandbox();
	const dir = expectedDir(box);
	mkdirSync(dir, { recursive: true });
	// Hand-written on purpose, and deliberately not what the catalogue says: one
	// catalogue name absent (Playwright, deleted), `figma` switched on by the
	// person using the dir, an unrelated server of their own, and indentation the
	// module would not have produced. Any of these coming back means the step
	// merged instead of seeding.
	const edited = [
		"{",
		'    "mcpServers": {',
		'        "figma": { "url": "https://mcp.figma.com/mcp", "enabled": true, "exposure": "direct" },',
		'        "mine": { "command": "my-own-server", "enabled": true, "exposure": "codemode" }',
		"    }",
		"}",
		"",
	].join("\n");
	writeFileSync(path.join(dir, "mcp.json"), edited);

	const result = run(box, "--project", box.repo);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(path.join(dir, "mcp.json"), "utf8"), edited);
	assert.doesNotMatch(result.stderr, /mcp\.json/u, "the file exists: there is nothing to report about it");
});

test("a re-run changes nothing, and says nothing about the catalogue", () => {
	const box = sandbox();
	const dir = expectedDir(box);
	assert.equal(run(box, "--project", box.repo).status, 0);
	const seeded = readFileSync(path.join(dir, "mcp.json"), "utf8");

	const second = run(box, "--project", box.repo);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(readFileSync(path.join(dir, "mcp.json"), "utf8"), seeded);
	assert.doesNotMatch(second.stderr, /mcp/iu, "a kept catalogue file is the expected state of a re-run, not a report");

	// Deleting an entry is how a project opts out of one server, so the next run
	// must not put it back. The name is asserted against the catalogue first, so a
	// renamed entry fails here with a reason instead of quietly passing.
	assert.ok(Object.hasOwn(catalogue().mcpServers, "playwright"), "the catalogue still ships playwright");
	const withoutPlaywright = seeded.replace(/,\n {4}"playwright": \{[\s\S]*?\n {4}\}/u, "");
	assert.notEqual(withoutPlaywright, seeded, "the edit must actually remove the entry");
	writeFileSync(path.join(dir, "mcp.json"), withoutPlaywright);
	assert.equal(run(box, "--project", box.repo).status, 0);
	assert.equal(readFileSync(path.join(dir, "mcp.json"), "utf8"), withoutPlaywright);
});

test("--check reports the catalogue, and warns rather than failing when it is absent", () => {
	const box = sandbox();
	const dir = expectedDir(box);
	assert.equal(run(box, "--project", box.repo).status, 0);

	const checked = run(box, "--check", "--project", box.repo);
	assert.equal(checked.status, 0, checked.stderr);
	assert.match(checked.stdout, new RegExp(`^catalogue: ${dir}/mcp\\.json$`, "mu"));

	// Legitimately deletable — the dir works without it and nothing connects — so
	// its absence is a WARN like the missing shell hook, not a FAIL like a dir
	// that would load no extensions.
	rmSync(path.join(dir, "mcp.json"));
	const missing = run(box, "--check", "--project", box.repo);
	assert.equal(missing.status, 0, "no catalogue is not a broken agent dir");
	assert.match(missing.stderr, /WARN no .*mcp\.json/u);
	assert.doesNotMatch(missing.stdout, /^catalogue:/mu);
});

test("--check refuses to bless a catalogue file that does not parse", () => {
	const box = sandbox();
	const dir = expectedDir(box);
	assert.equal(run(box, "--project", box.repo).status, 0);

	// A 0-byte file is what an interrupted write leaves behind, and it used to print
	// `catalogue:` like any other: seeding is `--if-missing`, so the seed step never
	// touches a file that exists and the broken one survives every re-run, while pi
	// reports the parse error in every session that reads it.
	writeFileSync(path.join(dir, "mcp.json"), "");
	const empty = run(box, "--check", "--project", box.repo);
	assert.equal(empty.status, 0, "a broken catalogue does not make the dir unusable: WARN, not FAIL");
	assert.match(empty.stderr, /WARN .*mcp\.json exists but is not valid JSON/u);
	assert.doesNotMatch(empty.stdout, /^catalogue:/mu, "a file that does not parse is not a catalogue");

	// The verdict is the parse, not the size: text that is neither empty nor JSON
	// takes the same line.
	writeFileSync(path.join(dir, "mcp.json"), "{ not json\n");
	const garbage = run(box, "--check", "--project", box.repo);
	assert.equal(garbage.status, 0);
	assert.match(garbage.stderr, /WARN .*mcp\.json exists but is not valid JSON/u);
	assert.doesNotMatch(garbage.stdout, /^catalogue:/mu);
});

test("a seed step that cannot run does not abort the rest of the seeding", () => {
	for (const how of ["missing", "invalid"] as const) {
		const box = sandbox();
		const script = scriptWithBrokenCatalogue(how);

		const result = runScript(script, box, "--project", box.repo);
		assert.equal(result.status, 0, `${how} catalogue: ${result.stderr}`);
		assert.equal(result.stdout.trim(), expectedDir(box));

		// Everything seeded after this step's position is still seeded: aborting
		// here would cost the settings, credentials and trust that make the dir
		// usable at all.
		const dir = expectedDir(box);
		const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as { packages?: unknown };
		assert.equal(settings.packages, undefined, `${how} catalogue: settings are still seeded`);
		assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), '{"key":"seed"}\n');
		assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "trust.json"), "utf8")), { [box.repo]: true });

		// Nothing half-written stands in for the catalogue: the file is absent, so a
		// later run with a working catalogue can still seed it.
		assert.equal(existsSync(path.join(dir, "mcp.json")), false);
		assert.match(result.stderr, /warning: could not seed .*mcp\.json from the catalogue/u);
		assert.match(result.stderr, /mcp-catalogue:/u, "the module's own reason is reported, not swallowed");
	}
});

test("the declared dir is named after the project, not the checkout directory", () => {
	// Computed on both sides: the guard in devcontainer-agent-dir.test.ts forbids
	// a second *literal*, and comparing derived values is what keeps the two
	// definitions from drifting apart.
	//
	// The name comes from `package.json` — the repo's identity — and deliberately
	// *not* from `basename(REPO_ROOT)`, which is the checkout's directory and only
	// equals the repo's name when the clone was made into one of that name. This
	// container mounts the repo at `/workspace`, so the checkout-basename form of
	// this assertion failed inside the very container the convention exists for,
	// while passing in a CI checkout (`.../advanced-harness-engineering/advanced-harness-engineering`). The
	// script's own rule, `agent-<main checkout directory name>`, is already pinned
	// by the sandbox tests above, which derive `expectedDir` from the sandbox's
	// repo name.
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
