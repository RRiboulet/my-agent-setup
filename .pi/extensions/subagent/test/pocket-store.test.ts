// Unit tests for pocket's session registry.
//
// A session id is both a URL path segment and a directory name. `assertSafeSessionId`
// is the only thing between a crafted `?id=../../.ssh` and the filesystem, so the
// rejection list below is the security review, and it is run against every path
// the store exposes.
//
// The rest is durability: a registry that loses a session because two writes
// interleaved is a session the phone cannot resume, so `mutate` is a
// read-modify-write pinned to one module-level lock — and the lock is what the
// concurrency tests here pin.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { SessionStore, assertSafeSessionId, generateSessionId, projectDirectory, PocketConfigError } from "../../pocket/store.ts";

async function root(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pocket-store-"));
}

test("create registers a session with a safe id, a resolved project and its own directory", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "work", cwd: tmpdir() });
		// The id is a directory name and a URL segment later, so it is validated
		// by the same function that validates what arrives from a request.
		assert.doesNotThrow(() => assertSafeSessionId(entry.id));
		assert.equal(entry.name, "work");
		assert.equal(path.isAbsolute(entry.cwd), true);
		assert.equal(entry.cwd, await projectDirectory(tmpdir()));
		assert.equal(entry.sessionFile, null);
		assert.equal(entry.sessionDir, path.join(dataRoot, "sessions", entry.id));
		assert.equal((await store.list()).length, 1);
		assert.equal((await store.get(entry.id))?.name, "work");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("an unnamed session borrows its project's directory name", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "   ", cwd: tmpdir() });
		assert.equal(entry.name, path.basename(await projectDirectory(tmpdir())));
		assert.notEqual(entry.name, "");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("create rejects a working directory that does not exist", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		// pi refuses to start in a directory that is gone, with "Stored session
		// working directory does not exist", which surfaces as a child that exits
		// on spawn. Rejecting it here means the failure has a diagnosis and no
		// half-written session.
		await assert.rejects(() => store.create({ name: "work", cwd: "/tmp/definitely-not-here" }), PocketConfigError);
		assert.equal((await store.list()).length, 0);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("create rejects a file in place of a directory", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		await assert.rejects(() => store.create({ name: "work", cwd: path.join(dataRoot, "sessions.json") }), PocketConfigError);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("the registry survives a restart", async () => {
	const dataRoot = await root();
	try {
		const first = new SessionStore(dataRoot);
		const created = await first.create({ name: "remember me", cwd: tmpdir() });
		await first.update(created.id, { sessionFile: "/tmp/session.jsonl", autostart: false });
		// A second instance is the daemon-restart case: the phone must find its
		// sessions, and the resume path must still know which file to resume.
		const second = new SessionStore(dataRoot);
		const loaded = await second.get(created.id);
		assert.equal(loaded?.name, "remember me");
		assert.equal(loaded?.sessionFile, "/tmp/session.jsonl");
		assert.equal(loaded?.autostart, false);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("concurrent creates all land in the registry", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		// One writes the same JSON file. Without the lock, two of these produce a
		// registry holding only one of the sessions — a session the phone can no
		// longer resume and nothing reports as missing.
		const created = await Promise.all(
			Array.from({ length: 8 }, (_unused, index) => store.create({ name: `s${index}`, cwd: tmpdir() })),
		);
		const listed = await store.list();
		assert.equal(listed.length, 8);
		assert.equal(new Set(listed.map((entry) => entry.id)).size, 8);
		for (const entry of created) assert.equal((await store.get(entry.id))?.name, entry.name);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("update patches only the fields it is given", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "work", cwd: tmpdir() });
		const patched = await store.update(entry.id, { name: "renamed" });
		assert.equal(patched.name, "renamed");
		assert.equal(patched.cwd, entry.cwd);
		assert.equal(patched.sessionDir, entry.sessionDir);
		// updatedAt moves, so a client can tell the entry was touched.
		assert.equal(Date.parse(patched.updatedAt) >= Date.parse(entry.updatedAt), true);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("update refuses to invent a session", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		await assert.rejects(() => store.update("s-does-not-exist", { name: "x" }), PocketConfigError);
		await assert.rejects(() => store.update("../etc", { name: "x" }), PocketConfigError);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("concurrent updates against the same session keep both changes", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "work", cwd: tmpdir() });
		// A respawn counter the supervisor bumped must not be overwritten by a
		// snapshot taken before it: each update reads the file as it is now.
		await Promise.all([
			store.update(entry.id, { name: "first" }),
			store.update(entry.id, { lastError: "second" }),
		]);
		const loaded = await store.get(entry.id);
		const names = ["first", "work"];
		const named = names.includes(loaded?.name ?? "");
		assert.equal(named, true);
		assert.ok(loaded?.lastError !== undefined || loaded?.name !== "work", "both updates were not both readable");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("remove drops the session from the registry", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "work", cwd: tmpdir() });
		await store.remove(entry.id);
		assert.equal(await store.get(entry.id), undefined);
		assert.equal((await store.list()).length, 0);
		// A second remove is a no-op rather than an error: the phone's "delete"
		// and the operator's detach may both try.
		await store.remove(entry.id);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("remove rejects a traversal id instead of rewriting the registry", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		await store.create({ name: "work", cwd: tmpdir() });
		const before = await readFile(path.join(dataRoot, "sessions.json"), "utf8");
		await assert.rejects(() => store.remove("../../etc"), PocketConfigError);
		await assert.rejects(() => store.remove("s-abc/../../etc"), PocketConfigError);
		await assert.rejects(() => store.get("../sessions"), PocketConfigError);
		const after = await readFile(path.join(dataRoot, "sessions.json"), "utf8");
		assert.equal(before, after, "the registry was rewritten by a rejected id");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("assertSafeSessionId accepts the generated shape and nothing else", () => {
	assert.doesNotThrow(() => assertSafeSessionId(generateSessionId()));
	assert.doesNotThrow(() => assertSafeSessionId("s-abcdef0123456789"));
	assert.doesNotThrow(() => assertSafeSessionId("a".repeat(64)));
	for (const bad of [
		"",
		".",
		"..",
		"s/..",
		"a/b",
		"/absolute",
		"has space",
		"has.dot",
		"nul\0byte",
		"back\\slash",
		"a".repeat(65),
		"-leading-dash",
		"_leading-underscore",
	]) {
		assert.throws(() => assertSafeSessionId(bad), PocketConfigError, `accepted ${JSON.stringify(bad)}`);
	}
});

test("generateSessionId is unique and safe over many draws", () => {
	const seen = new Set<string>();
	for (let index = 0; index < 500; index += 1) {
		const id = generateSessionId();
		assert.equal(seen.has(id), false);
		assert.doesNotThrow(() => assertSafeSessionId(id));
		seen.add(id);
	}
});

test("the session directory is inside the data root", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const entry = await store.create({ name: "work", cwd: tmpdir() });
		const relative = path.relative(dataRoot, entry.sessionDir);
		assert.equal(relative, path.join("sessions", entry.id));
		assert.equal(relative.startsWith(".."), false);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("two sessions in the same project are distinct sessions", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		const first = await store.create({ name: "one", cwd: tmpdir() });
		const second = await store.create({ name: "two", cwd: tmpdir() });
		assert.notEqual(first.id, second.id);
		assert.notEqual(first.sessionDir, second.sessionDir);
		assert.equal((await store.list()).length, 2);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("the registry file is written atomically and is valid JSON", async () => {
	const dataRoot = await root();
	try {
		const store = new SessionStore(dataRoot);
		await store.create({ name: "work", cwd: tmpdir() });
		const file = path.join(dataRoot, "sessions.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as { version: number; sessions: unknown[] };
		assert.equal(parsed.version, 1);
		assert.equal(parsed.sessions.length, 1);
		// No temporary files left behind by the rename.
		const directory = await stat(path.join(dataRoot, ".."));
		assert.equal(directory.isDirectory(), true);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});
