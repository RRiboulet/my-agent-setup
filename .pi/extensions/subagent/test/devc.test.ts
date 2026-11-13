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
// these tests failed there. Tests added later (the lock's location and key, the
// uid guard, `--no-cache`, `doctor`'s stale report) were mutation-checked: the
// behaviour is removed from a scratch copy of the script and the test turns red.
//
// The lock is keyed on the resolved workspace path and lives under
// `$XDG_STATE_HOME/devc/locks`, so the stubs find it by hashing the
// `--workspace-folder` they were given (`devc-lockprobe` below). That is
// deliberate: a script that keys the lock on the basename again reports
// `no-lock`, and the lock assertions fail rather than quietly probing some
// other file.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const DEVC = path.join(REPO_ROOT, "bin/devc");

// `docker` only has to answer the questions devc asks: is the daemon up, is
// there a container matching this workspace, and what does it publish. A real
// daemon is never involved.
//
// `DEVC_TEST_CONTAINER` is needed for `devc doctor`, whose running-container
// branch (the stale-config report lives in it) is only reached when a container
// is found; without it every project looks stopped and the report is skipped.
const DOCKER_STUB = `#!/usr/bin/env bash
case "\${1:-}" in
info) exit 0 ;;
ps)
	if [ -n "\${DEVC_TEST_CONTAINER:-}" ]; then
		case " $* " in
		*" -q "*) printf 'container-id\\n' ;;
		esac
	fi
	exit 0
	;;
esac
exit 0
`;

// Is the lock devc uses for this workspace held right now? Keyed the same way
// devc keys it — the first 16 hex characters of the resolved workspace path —
// so a lock keyed on the project's basename reports `no-lock` and the assertions
// that depend on it fail. A separate open asking for LOCK_EX|LOCK_NB succeeds
// exactly when nobody holds it, and the caller's inherited fd 9 counts as
// holding it, which is what makes the tmux probe a pin on the release.
//
// `$1` is the workspace dir, `$2` the log to append one word to:
// `locked`, `unlocked` (nobody holds it), or `no-lock` (no such file).
const LOCKPROBE_STUB = `#!/usr/bin/env bash
key="$(printf '%s' "$1" | sha256sum | cut -c1-16)"
state=no-lock
for f in "\${DEVC_TEST_LOCKDIR:?}"/devc-*-$key.lock; do
	if [ -e "$f" ]; then
		state=unlocked
		flock -n "$f" true 2>/dev/null || state=locked
	fi
done
printf '%s\\n' "$state" >> "$2"
`;

// The CLI stub records its argv one NUL-separated field per argument, because
// `$*` joins on spaces: an argument-boundary change (one argument containing
// spaces versus two arguments) reads identically through the join, and the
// dry-run parity tests exist to catch exactly that.
//
// It records the lock state during `up` and during the `exec … true` probe —
// the build-time half of a run, while the lock is meant to be held — and
// `id -u` answers with this host's uid unless `DEVC_TEST_CONT_UID` says
// otherwise, so devc's own uid guard can be exercised.
const DEVCONTAINER_STUB = `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$DEVC_TEST_LOG"
printf '\\n' >> "$DEVC_TEST_LOG"
workspace=''
prev=''
for arg in "$@"; do
	[ "$prev" = --workspace-folder ] && workspace="$arg"
	prev="$arg"
done
case " $* " in
*" id -u "*) printf '%s\\n' "\${DEVC_TEST_CONT_UID:-$(id -u)}" ;;
esac
if [ -n "\${DEVC_TEST_LOCKLOG:-}" ] && [ -n "$workspace" ]; then
	case "\${1:-} $* " in
	"up "*) devc-lockprobe "$workspace" "$DEVC_TEST_LOCKLOG" ;;
	*" true "*) devc-lockprobe "$workspace" "$DEVC_TEST_LOCKLOG" ;;
	esac
fi
exit 0
`;

// The tmux stub is where the lock release is observable. `attach_shell` execs
// tmux from the devc shell, so the session inherits fd 9 — the open file
// description the flock lives on. If `ensure_up` released the lock, this
// process can take LOCK_EX on the same file; if the release is missing, the
// inherited description still holds it and the probe reports `locked`. That is
// regression #104: a lock fd surviving into the exec'd session kept every later
// `devc` run waiting on `flock -w 900` until it died.
const TMUX_STUB = `#!/usr/bin/env bash
printf '%s\\0' "$@" >> "$DEVC_TEST_LOG"
printf '\\n' >> "$DEVC_TEST_LOG"
workspace=''
prev=''
for arg in "$@"; do
	[ "$prev" = --workspace-folder ] && workspace="$arg"
	prev="$arg"
done
if [ -n "\${DEVC_TEST_SESSIONLOG:-}" ] && [ -n "$workspace" ]; then
	devc-lockprobe "$workspace" "$DEVC_TEST_SESSIONLOG"
fi
exit 0
`;

interface Sandbox {
	root: string;
	home: string;
	project: string;
	env: NodeJS.ProcessEnv;
	state: string;
	/** Add another project under `root/home`; returns its path. */
	addProject: (name: string, base?: string) => string;
	/** The argv of each stubbed CLI invocation, one element per argument. */
	calls: () => string[][];
	/** Lock state seen by the CLI during `up` / the `exec … true` probe. */
	lockCalls: () => string[];
	/** Lock state seen inside the spawned tmux session. */
	sessionLockCalls: () => string[];
	reset: () => void;
}

// Every sandbox root this file creates, removed when the file's tests finish.
const sandboxRoots: string[] = [];

after(() => {
	for (const root of sandboxRoots) {
		rmSync(root, { recursive: true, force: true });
	}
});

function sandbox(): Sandbox {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "devc-test-")));
	// A throwaway project per test is the point, but nothing here removes the
	// throwaway: measured, one run of this file left 33 directories and ~2MB in
	// `$TMPDIR` behind it, on every run. Collect the roots and remove them when
	// the file's tests finish — `after` runs even when a test fails.
	sandboxRoots.push(root);
	const home = path.join(root, "home");
	const project = path.join(home, "proj");

	const configDir = path.join(root, "config", "devc");
	mkdirSync(configDir, { recursive: true });
	// Seeding the roots file keeps devc from writing into the real home.
	const rootsFile = path.join(configDir, "roots");
	const roots: string[] = [];
	writeFileSync(rootsFile, "");

	const addProject = (name: string, base: string = home) => {
		const dir = path.join(base, name);
		mkdirSync(path.join(dir, ".devcontainer"), { recursive: true });
		writeFileSync(path.join(dir, ".devcontainer", "devcontainer.json"), "{}\n");
		roots.push(dir);
		writeFileSync(rootsFile, roots.map((dir) => `${dir}\n`).join(""));
		return dir;
	};
	addProject("proj");

	const binDir = path.join(root, "bin");
	mkdirSync(binDir);
	for (const [name, body] of [
		["docker", DOCKER_STUB],
		["devcontainer", DEVCONTAINER_STUB],
		["tmux", TMUX_STUB],
		["devc-lockprobe", LOCKPROBE_STUB],
	] as const) {
		const file = path.join(binDir, name);
		writeFileSync(file, body);
		chmodSync(file, 0o755);
	}

	const tmp = path.join(root, "tmp");
	mkdirSync(tmp, { recursive: true });
	const log = path.join(root, "calls.log");
	const lockLog = path.join(root, "lock.log");
	const sessionLog = path.join(root, "session.log");
	const state = path.join(root, "state");

	const env: NodeJS.ProcessEnv = {
		PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
		HOME: home,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: state,
		TMPDIR: tmp,
		DEVC_TEST_LOG: log,
		DEVC_TEST_LOCKLOG: lockLog,
		DEVC_TEST_SESSIONLOG: sessionLog,
		DEVC_TEST_LOCKDIR: path.join(state, "devc", "locks"),
		NO_COLOR: "1",
	};

	const reset = () => {
		writeFileSync(log, "");
		writeFileSync(lockLog, "");
		writeFileSync(sessionLog, "");
	};
	reset();

	const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);

	return {
		root,
		home,
		project,
		env,
		state,
		addProject,
		// Each recorded argv ends in a NUL, whose split artefact is the empty
		// trailing field; the newline that follows the NUL separates calls.
		calls: () => lines(log).map((line) => line.split("\0").slice(0, -1)),
		lockCalls: () => lines(lockLog),
		sessionLockCalls: () => lines(sessionLog),
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

const lockDirOf = (sb: Sandbox) => path.join(sb.state, "devc", "locks");
const lockKey = (dir: string) => createHash("sha256").update(dir).digest("hex").slice(0, 16);

/** The lock file devc created for `dir`, found by the key it must be named for. */
function lockFileFor(sb: Sandbox, dir: string): string {
	assert.ok(existsSync(lockDirOf(sb)), `no lock directory at ${lockDirOf(sb)}: devc took no lock`);
	const match = readdirSync(lockDirOf(sb)).filter((file) => file.endsWith(`-${lockKey(dir)}.lock`));
	assert.deepEqual(match.length, 1, `expected one lock file for ${dir}, found ${match.join(", ") || "none"}`);
	return path.join(lockDirOf(sb), match[0]);
}

/** Every lock file devc has taken, whatever it named them. */
const lockFilesIn = (sb: Sandbox) => (existsSync(lockDirOf(sb)) ? readdirSync(lockDirOf(sb)) : []);

/** Take an exclusive lock on `lockfile` from another process, and wait for it. */
function holdLock(sb: Sandbox, lockfile: string) {
	mkdirSync(path.dirname(lockfile), { recursive: true });
	const ready = path.join(sb.root, `held-${path.basename(lockfile)}`);
	const child = spawn("flock", ["-x", lockfile, "sh", "-c", `echo held > ${ready}; sleep 30`], { stdio: "ignore" });
	const deadline = Date.now() + 5_000;
	while (!existsSync(ready) && Date.now() < deadline) {
		spawnSync("sh", ["-c", "sleep 0.05"]);
	}
	return { child, ready };
}

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

	assert.deepEqual(fromPreview, fromRealRun);
});

test("devc: dry-run parity is by argv element, so argument boundaries survive", () => {
	// The parity check above compared the stub's `$*`, which joins on spaces: an
	// argument holding spaces and two arguments reading as the same string were
	// indistinguishable. Quoting a preview is exactly where that happens, so the
	// stub logs one NUL-terminated field per argument and this compares arrays.
	const sb = sandbox();
	const spaced = "one argument with spaces";
	const previewRun = devc(sb, ["proj", "--", "echo", spaced], { DEVC_DRY_RUN: "1" });
	assert.equal(previewRun.status, 0);
	const printed = preview(previewRun.stderr);

	sb.reset();
	assert.equal(spawnSync("bash", ["-c", printed], { env: sb.env, encoding: "utf8" }).status, 0);
	const fromPreview = sb.calls().at(-1);

	sb.reset();
	assert.equal(devc(sb, ["proj", "--", "echo", spaced]).status, 0);
	const fromRealRun = sb.calls().at(-1);

	assert.deepEqual(fromPreview, fromRealRun, "the preview must re-parse to the argv the real run uses");
	assert.deepEqual(
		fromRealRun?.slice(-2),
		["echo", spaced],
		"an argument containing spaces must stay one argument, not be split by the preview",
	);
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
	assert.deepEqual(insidePreview, sb.calls().at(-1));

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
	assert.deepEqual(outsidePreview, sb.calls().at(-1));
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

test("devc: the lock lives in the per-user state dir, not in TMPDIR", () => {
	// `${TMPDIR:-/tmp}/devc-$basename.lock` put the lock in a world-writable
	// directory: another local user could pre-create it, hold it (a denial of
	// service for up to `flock -w 900`) or symlink it to redirect devc's
	// `exec 9>` write. It now sits in the per-user state dir, created 0700.
	const sb = sandbox();
	assert.equal(devc(sb, ["up", "proj"]).status, 0);

	const lockfile = lockFileFor(sb, sb.project);
	assert.equal(path.dirname(lockfile), lockDirOf(sb));
	assert.equal(statSync(lockDirOf(sb)).mode & 0o777, 0o700, "the lock directory must be private to this user");
	assert.equal(
		readdirSync(sb.env.TMPDIR as string).filter((file) => file.endsWith(".lock")).length,
		0,
		"no lock file may be created in TMPDIR",
	);
});

test("devc: two projects that share a basename do not share a lock", () => {
	// The lock was keyed on the basename alone, so `~/a/web` and `~/b/web`
	// serialized against each other for up to `flock -w 900` on work with nothing
	// to do with either — and because `rebuild` takes this lock too, the stall was
	// not limited to `up`.
	const sb = sandbox();
	const a = sb.addProject("web", path.join(sb.home, "a"));
	const b = sb.addProject("web", path.join(sb.home, "b"));
	assert.equal(devc(sb, ["up", a]).status, 0);

	assert.equal(lockFilesIn(sb).length, 1, "the first project's run must have taken exactly one lock");
	const lockA = lockFilesIn(sb)[0];
	const { child, ready } = holdLock(sb, path.join(lockDirOf(sb), lockA));
	try {
		assert.ok(existsSync(ready), "the test could not take the lock it needs");
		sb.reset();
		const run = spawnSync("bash", [DEVC, "up", b], {
			env: sb.env,
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.equal(run.signal, null, "the second project blocked on the first project's lock");
		assert.equal(run.status, 0, `devc up must not wait on an unrelated project; stderr: ${run.stderr}`);
		assert.doesNotMatch(run.stderr, /another devc run holds/);
		assert.deepEqual(
			lockFilesIn(sb).filter((file) => file !== lockA).length,
			1,
			"the second project must have taken a lock file of its own, not the first one",
		);
	} finally {
		child.kill("SIGKILL");
	}
});

test("devc: a dry-run rebuild does not queue behind a held lock", () => {
	// The lock waits up to `flock -w 900` in silence. A preview that blocks there
	// prints nothing for fifteen minutes, which reads as a hang — and a dry run
	// holds the lock for nothing, so it takes none.
	const sb = sandbox();
	assert.equal(devc(sb, ["up", "proj"]).status, 0);
	const { child, ready } = holdLock(sb, lockFileFor(sb, sb.project));
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
		child.kill("SIGKILL");
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

test("devc: rebuild --no-cache reaches the CLI as --build-no-cache", () => {
	// devc's spelling is not the CLI's, and the mapping is one line that nothing
	// exercised: passing `--no-cache` through would make the CLI reject the
	// rebuild, and dropping it would silently rebuild from a warm cache.
	const sb = sandbox();
	assert.equal(devc(sb, ["rebuild", "proj"]).status, 0);
	const plain = sb.calls().at(-1) ?? [];
	assert.equal(plain[0], "up");
	assert.ok(plain.includes("--remove-existing-container"));
	assert.ok(!plain.includes("--build-no-cache"), "a plain rebuild must not discard the cache");

	sb.reset();
	assert.equal(devc(sb, ["rebuild", "proj", "--no-cache"]).status, 0);
	const noCache = sb.calls().at(-1) ?? [];
	assert.ok(noCache.includes("--build-no-cache"), `--no-cache must become --build-no-cache; got ${noCache.join(" ")}`);
	assert.ok(!noCache.includes("--no-cache"), "devc's own spelling must not be passed through");

	const previewRun = devc(sb, ["rebuild", "proj", "--no-cache"], { DEVC_DRY_RUN: "1" });
	assert.match(previewRun.stderr, /\+ devcontainer up .*--build-no-cache/);
});

test("devc: a container running as a different uid is refused, and nothing attaches", () => {
	// The uid guard is the fix the skill calls "the fix, not an obstacle": a
	// container user that does not match the host leaves the bind-mounted repo
	// unwritable, and the project's postCreate then chowns the host checkout.
	const sb = sandbox();
	const run = devc(sb, ["proj"], { DEVC_TEST_CONT_UID: "9999" });
	assert.equal(run.status, 1, "devc must refuse rather than attach");
	assert.match(run.stderr, /runs as uid 9999 but this host user is uid \d+/);
	assert.match(run.stderr, /postCreate would chown your checkout/);
	assert.match(run.stderr, /Do not pass --update-remote-user-uid-default never/);
	assert.deepEqual(
		sb.calls().filter((call) => call[0] === "tmux" || call.includes("bash")),
		[],
		"nothing may attach to a container with the wrong uid",
	);
	assert.deepEqual(sb.sessionLockCalls(), [], "no session may be spawned");
});

test("devc doctor reports a stale container, and only once the config moved", () => {
	// This is the failure the config-stamp fix exists for: `devcontainer up` on
	// 0.90 reports success and leaves the old container in place when the config
	// changed, so `doctor` is where a user finds out — and nothing asserted it.
	const sb = sandbox();
	assert.equal(devc(sb, ["up", "proj"]).status, 0);

	const fresh = devc(sb, ["doctor", "proj"], { DEVC_TEST_CONTAINER: "1" });
	assert.equal(fresh.status, 0, fresh.stderr);
	assert.match(fresh.stdout, /running    container uid \d+, host uid \d+/);
	assert.doesNotMatch(fresh.stdout, /stale /, "a container built from this config is not stale");

	writeFileSync(path.join(sb.project, ".devcontainer", "devcontainer.json"), '{"image":"other"}\n');
	const stale = devc(sb, ["doctor", "proj"], { DEVC_TEST_CONTAINER: "1" });
	assert.equal(stale.status, 0, stale.stderr);
	assert.match(stale.stdout, /stale      devcontainer config changed; devc up will recreate it/);
});

test("devc: a dry-run rebuild executes nothing and writes no stamp", () => {
	// The stamp is the claim "this container was built from this config". A dry
	// run writes none, or `devc doctor` reports a stale container as current.
	const sb = sandbox();
	const run = devc(sb, ["rebuild", "proj"], { DEVC_DRY_RUN: "1" });
	assert.equal(run.status, 0);
	assert.deepEqual(sb.calls(), [], "dry run must not call the CLI");
	assert.deepEqual(sb.lockCalls(), []);
	assert.equal(existsSync(lockDirOf(sb)), false, "dry run must not create, let alone take, a lock");
	assert.equal(existsSync(stampPath(sb)), false, "dry run must not write the config stamp");
	assert.match(run.stderr, /\+ devcontainer up .*--remove-existing-container/);
	// A dry run states a conditional, not a fact: the container is still there.
	assert.match(run.stderr, /would recreate the container/);
	assert.doesNotMatch(run.stderr, /^recreating the container/m);
});

test("devc: the lock is released before an interactive session attaches", () => {
	// #104: the lock fd survived `exec tmux`, so the session held the project lock
	// for as long as it lived and every later devc run for that project died on
	// `flock -w 900`. The promise is in the skill; this is the pin. The tmux stub
	// inherits fd 9 through the exec, so it can answer directly: the lock must be
	// held during the build-time half of the run, and acquirable inside the
	// session.
	const sb = sandbox();
	const run = devc(sb, ["proj"]);
	assert.equal(run.status, 0, `attach must succeed; stderr: ${run.stderr}`);
	assert.deepEqual(sb.lockCalls(), ["locked"], "the lock must be held while the container is being ensured");
	assert.deepEqual(sb.sessionLockCalls(), ["unlocked"], "the exec'd session must not inherit the held lock");
	// The stub's `$@` is the argv after the program name, which the kernel supplies.
	assert.match((sb.calls().at(-1) ?? []).join(" "), /^new-session -A -s dev-proj -- /);
});
