// Unit tests for the btw launch core.
//
// Risk covered: `launch.ts` decides everything the panel does before it touches
// tmux or the filesystem — the per-session socket, the run dir, the viewer
// command and the tmux argv. The panel itself needs a terminal and a tmux
// server, so the deterministic parts are pinned here: the exact argv, the
// base-index-free session targets, the `exec node viewer.mjs` command, and the
// path and question guards.

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { shellQuote } from "../shell.ts";

import {
	buildBtwKillServerArgs,
	buildBtwPaths,
	buildBtwRemainOnExitArgs,
	buildBtwSendKeysArgs,
	buildBtwSessionCreateArgs,
	buildBtwSubmitArgs,
	buildBtwViewerCommand,
	btwAnswerPath,
	btwOwnerPidPath,
	btwRootDir,
	btwRunDir,
	btwSessionName,
	btwSocketPath,
	btwTarget,
	requireBtwQuestion,
} from "../../btw/launch.ts";

const AGENT_DIR = "/home/x/.pi/agent";
const SID = "01a14e96-1111-7000-8000-000000000001";
const SOCKET = `${AGENT_DIR}/tmux-btw-${SID}.sock`;
const SESSION = `btw-${SID}`;
const RUN_DIR = `${AGENT_DIR}/btw/${SID}`;

test("the socket, session and target derive from the full session id", () => {
	assert.equal(btwSocketPath(AGENT_DIR, SID), SOCKET);
	assert.equal(btwSessionName(SID), SESSION);
	assert.equal(btwTarget(SID), SESSION, "a session target avoids the base-index assumption");
});

test("two UUIDv7 ids sharing a timestamp prefix do not collide", () => {
	// pi mints session ids with UUIDv7: the leading hex is a millisecond
	// timestamp, so the first 8 characters repeat for sessions started within
	// ~65 s. The socket and session name must carry the full id.
	const first = "01a14e96-1111-7000-8000-000000000001";
	const second = "01a14e96-2222-7000-8000-000000000002";
	assert.equal(first.slice(0, 8), second.slice(0, 8));
	assert.notEqual(btwSocketPath(AGENT_DIR, first), btwSocketPath(AGENT_DIR, second));
	assert.notEqual(btwSessionName(first), btwSessionName(second));
});

test("buildBtwPaths returns every path from one agent dir and session id", () => {
	assert.deepEqual(buildBtwPaths(AGENT_DIR, SID), {
		socket: SOCKET,
		session: SESSION,
		target: SESSION,
		runDir: RUN_DIR,
		answer: `${RUN_DIR}/answer.md`,
		ownerPid: `${RUN_DIR}/owner.pid`,
	});
	assert.equal(btwAnswerPath(AGENT_DIR, SID), `${RUN_DIR}/answer.md`);
	assert.equal(btwOwnerPidPath(AGENT_DIR, SID), `${RUN_DIR}/owner.pid`);
	assert.equal(btwRunDir(AGENT_DIR, SID), RUN_DIR);
});

test("the panel root is the btw directory under the agent dir", () => {
	assert.equal(btwRootDir(AGENT_DIR), `${AGENT_DIR}/btw`);
	assert.throws(() => btwRootDir("relative/agent"), /absolute agent directory/);
});

test("a relative agent dir or a multi-component session id is refused", () => {
	for (const builder of [
		() => btwSocketPath("~/.pi/agent", SID),
		() => btwRunDir("relative/agent", SID),
		() => btwAnswerPath("~/.pi/agent", SID),
	]) {
		assert.throws(builder, /absolute agent directory/);
	}
	for (const sessionId of ["", ".", "..", "../evil", "a/b", "/abs"]) {
		assert.throws(() => btwSocketPath(AGENT_DIR, sessionId), /one path component/);
		assert.throws(() => btwSessionName(sessionId), /one path component/);
		assert.throws(() => btwRunDir(AGENT_DIR, sessionId), /one path component/);
	}
});

test("an empty or whitespace question is refused", () => {
	assert.equal(requireBtwQuestion("  why did it fail?  "), "why did it fail?");
	for (const raw of ["", "   ", "\n\t "]) {
		assert.throws(() => requireBtwQuestion(raw), /cannot be empty/);
	}
	assert.throws(() => requireBtwQuestion("why?\u0000more"), /NUL/);
});

test("killing the panel tears down the whole per-session server", () => {
	assert.deepEqual(buildBtwKillServerArgs({ socket: SOCKET }), ["-S", SOCKET, "kill-server"]);
});

test("tmux session creation is detached, named and anchored to the main cwd", () => {
	assert.deepEqual(buildBtwSessionCreateArgs({ socket: SOCKET, session: SESSION, cwd: "/work/project" }), [
		"-S",
		SOCKET,
		"new-session",
		"-d",
		"-s",
		SESSION,
		"-n",
		"btw",
		"-c",
		"/work/project",
	]);
});

test("remain-on-exit targets the session, not window 0", () => {
	assert.deepEqual(buildBtwRemainOnExitArgs({ socket: SOCKET, session: SESSION }), [
		"-S",
		SOCKET,
		"set-window-option",
		"-t",
		SESSION,
		"remain-on-exit",
		"on",
	]);
});

test("send-keys is literal and option-safe; Enter is a separate call", () => {
	assert.deepEqual(buildBtwSendKeysArgs({ socket: SOCKET, target: SESSION, command: "--not-a-flag; echo hi" }), [
		"-S",
		SOCKET,
		"send-keys",
		"-t",
		SESSION,
		"-l",
		"--",
		"--not-a-flag; echo hi",
	]);
	assert.deepEqual(buildBtwSubmitArgs({ socket: SOCKET, target: SESSION }), [
		"-S",
		SOCKET,
		"send-keys",
		"-t",
		SESSION,
		"Enter",
	]);
});

test("the viewer renders the answer file with the bundled script and execs", () => {
	const viewer = path.join(import.meta.dirname, "..", "..", "btw", "viewer.mjs");
	assert.equal(buildBtwViewerCommand("/tmp/answer.md"), `exec node ${shellQuote(viewer)} '/tmp/answer.md'`);
	assert.equal(
		buildBtwViewerCommand("/tmp/my dir/it's.md"),
		`exec node ${shellQuote(viewer)} '/tmp/my dir/it'"'"'s.md'`,
		"the path stays one shell word",
	);
});
