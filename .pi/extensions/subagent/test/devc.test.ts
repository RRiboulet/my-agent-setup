// `bin/devc` had no test harness, and the bugs pinned here share a reason
// why: none of them is visible from the dry run. `cfg_hash` runs *after* the
// dry run has returned, the config stamp is written where only a real run
// reaches it, and the rebuild lock is only observable while a rebuild is in
// flight. So these tests run the real script with `docker`, `devcontainer` and
// `tmux` stubbed on PATH, against a throwaway project — the artefacts they
// assert on (exit status, the stamp file, what the CLI was actually called with)
// are the ones that were wrong.
//
// Every assertion below traces to a failure reproduced against HEAD of `dev`,
// not to a preference: the suite was run against the pre-fix script and each of
// these tests failed there.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const DEVC = path.join(REPO_ROOT, "bin/devc");

// `docker` only has to answer the two questions devc asks: is the daemon up, and
// does a container match this workspace. Both are "yes" and "no", which is what
// keeps the tests off a real daemon.
const DOCKER_STUB = `#!/usr/bin/env bash
case "\${1:-}" in
info) exit 0 ;;
ps) exit 0 ;;
esac
exit 0
`;

// The CLI stub records its argv and, for `up`, whether the project lock is held
// at that moment — opening the same lock file and asking for LOCK_EX|LOCK_NB
// fails exactly when devc holds it. `id -u` must answer with this host's uid or
// devc's own uid guard fires before the interesting lines are reached.
const DEVCONTAINER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$DEVC_TEST_LOG"
if [ "\${1:-}" = up ] && [ -n "\${DEVC_TEST_LOCKFILE:-}" ]; then
	if flock -n "$DEVC_TEST_LOCKFILE" true 2>/dev/null; then
		printf 'unlocked\\n' >> "$DEVC_TEST_LOCKLOG"
	else
		printf 'locked\\n' >> "$DEVC_TEST_LOCKLOG"
	fi
fi
case " $* " in
*" id -u "*) id -u ;;
esac
exit 0
`;

const TMUX_STUB = `#!/usr/bin/env bash
printf 'tmux %s\\n' "$*" >> "$DEVC_TEST_LOG"
exit 0
`;

interface Sandbox {
	root: string;
	project: string;
	env: NodeJS.ProcessEnv;
	state: string;
	calls: () => string[];
	lockCalls: () => string[];
	reset: () => void;
}

function sandbox(): Sandbox {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "devc-test-")));
	const home = path.join(root, "home");
	const project = path.join(home, "proj");
	mkdirSync(path.join(project, ".devcontainer"), { recursive: true });
	writeFileSync(path.join(project, ".devcontainer", "devcontainer.json"), "{}\n");

	const configDir = path.join(root, "config", "devc");
	mkdirSync(configDir, { recursive: true });
	// Seeding the roots file keeps devc from writing into the real home.
	writeFileSync(path.join(configDir, "roots"), `${project}\n`);

	const binDir = path.join(root, "bin");
	mkdirSync(binDir);
	for (const [name, body] of [
		["docker", DOCKER_STUB],
		["devcontainer", DEVCONTAINER_STUB],
		["tmux", TMUX_STUB],
	] as const) {
		const file = path.join(binDir, name);
		writeFileSync(file, body);
		chmodSync(file, 0o755);
	}

	const tmp = path.join(root, "tmp");
	mkdirSync(tmp, { recursive: true });
	const log = path.join(root, "calls.log");
	const lockLog = path.join(root, "lock.log");
	const state = path.join(root, "state");

	const env: NodeJS.ProcessEnv = {
		PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
		HOME: home,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: state,
		TMPDIR: tmp,
		DEVC_TEST_LOG: log,
		DEVC_TEST_LOCKLOG: lockLog,
		DEVC_TEST_LOCKFILE: path.join(tmp, "devc-proj.lock"),
		NO_COLOR: "1",
	};

	const reset = () => {
		writeFileSync(log, "");
		writeFileSync(lockLog, "");
	};
	reset();

	const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);

	return {
		root,
		project,
		env,
		state,
		calls: () => lines(log),
		lockCalls: () => lines(lockLog),
		reset,
	};
}

function devc(sb: Sandbox, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
	const result = spawnSync("bash", [DEVC, ...args], {
		env: { ...sb.env, ...extraEnv },
		encoding: "utf8",
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

const stampPath = (sb: Sandbox) => path.join(sb.state, "devc", "proj.cfgsha");
const stamp = (sb: Sandbox) => readFileSync(stampPath(sb), "utf8").trim();

// sha256 of an empty stream. `cfg_hash` produced exactly this, forever, for any
// project it failed to read — so it is the one value that proves "nothing was
// hashed" rather than "this config was hashed".
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// A 000 file is readable by root regardless, so the unreadable-file cases cannot
// be constructed there; skip rather than assert something the kernel overrides.
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const SKIP_ROOT = AS_ROOT ? "running as root: a 000 file is still readable" : false;

// `+` marks the argv that would execute, and nothing else: `ensure_up` prints its
// conditional step as a note. So the preview is the last `+` line.
const previewLines = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("+ "));
const preview = (stderr: string) => (previewLines(stderr).at(-1) ?? "").slice(2).trim();

test("devc: a project without .dockerignore does not abort the run", () => {
	// Before the fix `cfg_hash` ended in `[ -f .dockerignore ] && cat ...`, so
	// the group returned 1, and under `set -e` in a command substitution the
	// whole run died with rc=1 and no output at all.
	const sb = sandbox();
	const run = devc(sb, ["up", "proj"]);
	assert.equal(run.status, 0, `devc up must succeed without .dockerignore; stderr: ${run.stderr}`);
	assert.match(run.stderr, /is already running/);
	assert.match(stamp(sb), /^[0-9a-f]{64}$/, "the config stamp must still be written");
});

test("devc: .dockerignore still feeds the config hash when it exists", () => {
	const sb = sandbox();
	assert.equal(devc(sb, ["up", "proj"]).status, 0);
	const without = stamp(sb);

	writeFileSync(path.join(sb.project, ".dockerignore"), "node_modules\n");
	assert.equal(devc(sb, ["up", "proj"]).status, 0);
	const withIgnore = stamp(sb);

	// The point of hashing the ignore file is that a change to it changes what
	// the build context means, so the container has to be reconciled.
	assert.notEqual(withIgnore, without, "a new .dockerignore must change the config hash");

	assert.equal(devc(sb, ["up", "proj"]).status, 0);
	assert.equal(stamp(sb), withIgnore, "the hash must be stable across identical runs");
});

test("devc: a root-style .devcontainer.json is hashed, and editing it moves the hash", () => {
	// `has_devcontainer` accepts a repo-root `.devcontainer.json` as well as
	// `.devcontainer/devcontainer.json`, but `cfg_hash` used to walk only
	// `.devcontainer/`. For the root style it therefore hashed an empty stream
	// (`e3b0c442…`) forever: `ensure_up` never saw a config change and `devc
	// doctor` could never call the container stale.
	const sb = sandbox();
	rmSync(path.join(sb.project, ".devcontainer"), { recursive: true, force: true });
	const rootConfig = path.join(sb.project, ".devcontainer.json");
	writeFileSync(rootConfig, '{"image":"alpine"}\n');

	const first = devc(sb, ["up", "proj"]);
	assert.equal(first.status, 0, `devc up must succeed for the root style; stderr: ${first.stderr}`);
	assert.match(stamp(sb), /^[0-9a-f]{64}$/);
	assert.notEqual(stamp(sb), EMPTY_SHA256, "an empty stream is not a hash of this project's config");
	const base = stamp(sb);

	assert.equal(devc(sb, ["up", "proj"]).status, 0);
	assert.equal(stamp(sb), base, "the hash must be stable across identical runs");

	writeFileSync(rootConfig, '{"image":"ubuntu"}\n');
	const changed = devc(sb, ["up", "proj"]);
	assert.equal(changed.status, 0);
	assert.notEqual(stamp(sb), base, "editing the root .devcontainer.json must change the hash");
	// The hash is only worth having if a change reaches the container.
	assert.match(changed.stderr, /config changed since this container was created; recreating/);
});

test("devc: an unreadable .dockerignore fails loudly, naming the file", { skip: SKIP_ROOT }, () => {
	// Missing and unreadable used to take different silent routes: missing was
	// tolerated (right), unreadable killed the run with rc=1 and no message
	// (wrong, and the same `set -e` shape as the bug the `if` fixed). An
	// unreadable config file means the config is unknown, so devc must say so.
	const sb = sandbox();
	const ignore = path.join(sb.project, ".dockerignore");
	writeFileSync(ignore, "node_modules\n");
	chmodSync(ignore, 0o000);
	try {
		const run = devc(sb, ["up", "proj"]);
		assert.equal(run.status, 1, `an unreadable .dockerignore must fail; stderr: ${run.stderr}`);
		assert.match(run.stderr, /cannot read (\.\/)?\.dockerignore/, "the failure must name the file");
		assert.equal(existsSync(stampPath(sb)), false, "no stamp: nothing was built from a config devc could not read");
		assert.deepEqual(sb.calls(), [], "the CLI must not be reached with an unknown config");
	} finally {
		chmodSync(ignore, 0o644);
	}
});

test("devc: an unreadable .devcontainer file fails loudly instead of hashing what it could read", { skip: SKIP_ROOT }, () => {
	// This one used to leak `cat: … Permission denied` to stderr *and* hash the
	// partial stream, so the next run reported "config changed; recreating" —
	// churn on every run, for a config devc never actually saw.
	const sb = sandbox();
	const cfg = path.join(sb.project, ".devcontainer", "devcontainer.json");
	chmodSync(cfg, 0o000);
	try {
		const run = devc(sb, ["up", "proj"]);
		assert.equal(run.status, 1, `an unreadable config must fail; stderr: ${run.stderr}`);
		assert.match(run.stderr, /cannot read .*devcontainer\.json/, "the failure must name the file");
		assert.equal(existsSync(stampPath(sb)), false, "no stamp for a config that was never fully read");
		assert.deepEqual(sb.calls(), [], "the CLI must not be reached with an unknown config");
	} finally {
		chmodSync(cfg, 0o644);
	}
});

test("devc: dry run prints the argv it would exec, --remote-env included", () => {
	const sb = sandbox();
	const previewRun = devc(sb, ["proj", "--", "echo", "hi"], { DEVC_DRY_RUN: "1" });
	assert.equal(previewRun.status, 0);
	assert.equal(previewLines(previewRun.stderr).length, 1, "only the real argv wears the `+` prefix");
	const printed = preview(previewRun.stderr);
	assert.match(printed, /--remote-env PI_TRUE_COLOR=1 --remote-env COLORTERM=truecolor echo hi$/);

	// The strongest form of "the preview is the command": run it, and the argv
	// the stub CLI received must be the one the real run produces.
	sb.reset();
	const previewed = spawnSync("bash", ["-c", printed], { env: sb.env, encoding: "utf8" });
	assert.equal(previewed.status, 0);
	const fromPreview = sb.calls().at(-1);

	sb.reset();
	assert.equal(devc(sb, ["proj", "--", "echo", "hi"]).status, 0);
	const fromRealRun = sb.calls().at(-1);

	assert.equal(fromPreview, fromRealRun);
});

test("devc: the tmux previews are the exec'd argv too", () => {
	const sb = sandbox();

	// Inside tmux: no second session, so the preview is the bare exec.
	const inside = devc(sb, ["proj"], { DEVC_DRY_RUN: "1", TMUX: "/tmp/tmux-test,1,0" });
	assert.equal(inside.status, 0);
	const insidePrinted = preview(inside.stderr);
	assert.match(insidePrinted, /^devcontainer exec .*--remote-env PI_TRUE_COLOR=1 --remote-env COLORTERM=truecolor bash -lc /);

	sb.reset();
	spawnSync("bash", ["-c", insidePrinted], { env: sb.env, encoding: "utf8" });
	const insidePreview = sb.calls().at(-1);
	sb.reset();
	assert.equal(devc(sb, ["proj"], { TMUX: "/tmp/tmux-test,1,0" }).status, 0);
	assert.equal(insidePreview, sb.calls().at(-1));

	// Outside tmux: the preview is the tmux wrapper around that same exec.
	const outside = devc(sb, ["proj"], { DEVC_DRY_RUN: "1" });
	assert.equal(outside.status, 0);
	const outsidePrinted = preview(outside.stderr);
	assert.match(outsidePrinted, /^tmux new-session -A -s dev-proj -- devcontainer exec /);

	sb.reset();
	spawnSync("bash", ["-c", outsidePrinted], { env: sb.env, encoding: "utf8" });
	const outsidePreview = sb.calls().at(-1);
	sb.reset();
	assert.equal(devc(sb, ["proj"]).status, 0);
	assert.equal(outsidePreview, sb.calls().at(-1));
});

test("devc: an unknown project fails, and never reaches the CLI with an empty path", () => {
	// `die` inside `$( )` in argument position does not abort under `set -e`: the
	// callee just gets "". So `devc rebuild nosuchproj` printed "no project named"
	// and then ran `devcontainer up --workspace-folder ''
	// --remove-existing-container` — recreating the container of whatever
	// directory the user was standing in.
	const sb = sandbox();
	for (const args of [["up", "nosuchproj"], ["rebuild", "nosuchproj"], ["stop", "nosuchproj"], ["doctor", "nosuchproj"]]) {
		sb.reset();
		const run = devc(sb, args);
		assert.equal(run.status, 1, `devc ${args.join(" ")} must fail`);
		assert.match(run.stderr, /no project named 'nosuchproj'/);
		assert.deepEqual(sb.calls(), [], `devc ${args.join(" ")} must not reach the CLI`);
		assert.deepEqual(sb.lockCalls(), []);
	}
});

test("devc: a dry-run rebuild does not queue behind a held lock", () => {
	// The lock waits up to `flock -w 900` in silence. A preview that blocks there
	// prints nothing for fifteen minutes, which reads as a hang — and a dry run
	// holds the lock for nothing, so it takes none.
	const sb = sandbox();
	const lockfile = path.join(sb.root, "tmp", "devc-proj.lock");
	const ready = path.join(sb.root, "held");
	const holder = spawn("flock", ["-x", lockfile, "sh", "-c", `echo held > ${ready}; sleep 30`], { stdio: "ignore" });
	const deadline = Date.now() + 5_000;
	while (!existsSync(ready) && Date.now() < deadline) {
		spawnSync("sh", ["-c", "sleep 0.05"]);
	}
	try {
		assert.ok(existsSync(ready), "the test could not take the lock it needs");
		const run = spawnSync("bash", [DEVC, "rebuild", "proj"], {
			env: { ...sb.env, DEVC_DRY_RUN: "1" },
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.equal(run.signal, null, "the dry run was killed by the timeout: it blocked on the lock");
		assert.equal(run.status, 0);
		assert.match(run.stderr, /would recreate the container/);
	} finally {
		holder.kill("SIGKILL");
	}
});

test("devc: rebuild holds the project lock while it replaces the container", () => {
	// Before the fix `cmd_rebuild` never called `lock_project`, so a rebuild and
	// a concurrent `devc up`/attach could interleave on the same container.
	const sb = sandbox();
	const run = devc(sb, ["rebuild", "proj"]);
	assert.equal(run.status, 0, `rebuild must succeed; stderr: ${run.stderr}`);
	assert.deepEqual(sb.lockCalls(), ["locked"], "the CLI must see the lock held during `up`");
	assert.match(stamp(sb), /^[0-9a-f]{64}$/, "a real rebuild updates the stamp");
});

test("devc: a dry-run rebuild executes nothing and writes no stamp", () => {
	// The stamp is the claim "this container was built from this config". A dry
	// run writes none, or `devc doctor` reports a stale container as current.
	const sb = sandbox();
	const run = devc(sb, ["rebuild", "proj"], { DEVC_DRY_RUN: "1" });
	assert.equal(run.status, 0);
	assert.deepEqual(sb.calls(), [], "dry run must not call the CLI");
	assert.deepEqual(sb.lockCalls(), []);
	assert.equal(existsSync(stampPath(sb)), false, "dry run must not write the config stamp");
	assert.match(run.stderr, /\+ devcontainer up .*--remove-existing-container/);
	// A dry run states a conditional, not a fact: the container is still there.
	assert.match(run.stderr, /would recreate the container/);
	assert.doesNotMatch(run.stderr, /^recreating the container/m);
});
