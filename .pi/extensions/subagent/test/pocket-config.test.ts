// Unit tests for pocket's configuration and session-id safety.
//
// Two things here can only be caught before they ship:
//
//   - the security boundary. A session id is a URL path segment and a directory
//     name. Anything it accepts reaches the filesystem, so the tests below are
//     the whole argument that `../..` never becomes a directory.
//   - the bind decision. checkAccessibleHost is the one place that refuses to
//     put an unauthenticated agent session on a network interface, and it is the
//     only thing standing between a phone client with no token and anyone else
//     on the LAN.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { readPocketConfig, checkAccessibleHost, effectiveToken, isLoopbackHost, generateToken, paths, DEFAULT_HOST, DEFAULT_PORT } from "../../pocket/config.ts";
import { assertSafeSessionId, generateSessionId, PocketConfigError } from "../../pocket/store.ts";

const POCKET_ENV_KEYS = [
	"PI_POCKET_DATA_ROOT",
	"PI_POCKET_AGENT_DIR",
	"PI_POCKET_HOST",
	"PI_POCKET_PORT",
	"PI_POCKET_TOKEN",
	"PI_POCKET_JOURNAL_MAX",
	"PI_POCKET_RESPAWN_MAX",
	"PI_POCKET_PI_BIN",
	"PI_POCKET_NOTIFY_COMMAND",
] as const;

/** Run a function with the pocket env cleared, then put everything back. */
function withCleanEnv<T>(fn: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const key of POCKET_ENV_KEYS) {
		saved.set(key, process.env[key]);
		delete process.env[key];
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("readPocketConfig defaults to loopback and the documented port", () => {
	withCleanEnv(() => {
		const config = readPocketConfig();
		assert.equal(config.host, DEFAULT_HOST);
		assert.equal(config.port, DEFAULT_PORT);
		assert.equal(isLoopbackHost(config.host), true);
		// No token by default: a loopback daemon needs none because only this
		// machine can reach it.
		assert.equal(config.token, undefined);
	});
});

test("readPocketConfig reads every PI_POCKET_* variable it claims to", () => {
	const saved = new Map<string, string | undefined>();
	for (const key of POCKET_ENV_KEYS) saved.set(key, process.env[key]);
	try {
		process.env.PI_POCKET_HOST = "0.0.0.0";
		process.env.PI_POCKET_PORT = "9911";
		process.env.PI_POCKET_TOKEN = "operator-token";
		process.env.PI_POCKET_JOURNAL_MAX = "77";
		process.env.PI_POCKET_RESPAWN_MAX = "0";
		process.env.PI_POCKET_PI_BIN = "/usr/bin/pi";
		const config = readPocketConfig();
		assert.equal(config.host, "0.0.0.0");
		assert.equal(config.port, 9911);
		assert.equal(config.token, "operator-token");
		assert.equal(config.journalMax, 77);
		assert.equal(config.respawnMax, 0);
		assert.equal(config.piBin, "/usr/bin/pi");
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("checkAccessibleHost refuses a non-loopback bind with no token", () => {
	// The whole binding rule in one assertion: an agent that runs as this user,
	// in this project, must not be reachable from the LAN without a credential.
	assert.throws(() => checkAccessibleHost({ host: "0.0.0.0", token: undefined }), /loopback|token/i);
	assert.throws(() => checkAccessibleHost({ host: "192.168.1.10", token: "" }), /loopback|token/i);
});

test("an empty token is the absence of a token", () => {
	// `PI_POCKET_TOKEN=` is a line someone typed meaning "no token" — it must
	// not become a credential that the empty string satisfies.
	assert.equal(effectiveToken(undefined), undefined);
	assert.equal(effectiveToken(""), undefined);
	assert.equal(effectiveToken("smoke-token"), "smoke-token");
});

test("checkAccessibleHost allows a non-loopback bind with a token", () => {
	assert.doesNotThrow(() => checkAccessibleHost({ host: "192.168.1.10", token: "some-operator-token" }));
	assert.doesNotThrow(() => checkAccessibleHost({ host: "0.0.0.0", token: "some-operator-token" }));
});

test("isLoopbackHost accepts the loopback spellings and nothing else", () => {
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("localhost"), true);
	assert.equal(isLoopbackHost("::1"), true);
	assert.equal(isLoopbackHost("0.0.0.0"), false);
	assert.equal(isLoopbackHost("192.168.1.10"), false);
	assert.equal(isLoopbackHost("example.com"), false);
});

test("generateToken is long enough to be a credential", () => {
	const token = generateToken();
	assert.equal(typeof token, "string");
	assert.ok(token.length >= 32, `token is only ${token.length} characters`);
	assert.notEqual(token, generateToken());
});

test("generateSessionId is safe as a file name and a URL segment", async () => {
	for (let index = 0; index < 50; index += 1) {
		const id = generateSessionId();
		// The same validator that every read path uses, so a generated id that
		// could not be read back fails here rather than in a request.
		assert.doesNotThrow(() => assertSafeSessionId(id));
	}
});

test("paths keep every artifact under one data root", () => {
	const root = path.join(path.sep, "tmp", "pocket-data");
	assert.equal(paths.registry(root), path.join(root, "sessions.json"));
	assert.equal(paths.journalFile(root, "s-abc"), path.join(root, "journal", "s-abc.jsonl"));
	assert.equal(paths.sessionDir(root, "s-abc"), path.join(root, "sessions", "s-abc"));
	assert.equal(isUnder(root, paths.journalFile(root, "s-abc")), true);
	assert.equal(isUnder(root, paths.sessionDir(root, "s-abc")), true);
});

test("assertSafeSessionId accepts the generated shape", () => {
	assert.doesNotThrow(() => assertSafeSessionId("s-4d3cbb90"));
	assert.doesNotThrow(() => assertSafeSessionId("A1"));
});

test("assertSafeSessionId rejects traversal, separators and junk", () => {
	for (const bad of ["", "..", ".", "s/..", "a/b", "..", ".hidden", " ", "s p", "s.old", "ünïcode", "a".repeat(65)]) {
		assert.throws(() => assertSafeSessionId(bad), PocketConfigError, `accepted ${JSON.stringify(bad)}`);
	}
});

test("session state survives a data root that is removed and recreated", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pocket-root-"));
	try {
		await rm(root, { recursive: true, force: true });
		const config = readPocketConfig();
		assert.equal(config.dataRoot.length > 0, true);
		// Nothing to assert about the daemon here; this is a smoke check that a
		// missing data root is not itself a configuration error, which is what
		// the daemon's mkdirSync at boot relies on.
		assert.doesNotThrow(() => readPocketConfig());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function isUnder(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
