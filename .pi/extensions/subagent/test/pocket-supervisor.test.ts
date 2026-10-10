// Behaviour tests for pocket's supervisor, run against the fake pi child in
// pocket-fake-pi.ts.
//
// These are the tests that matter, because durability is the whole feature. What
// they pin:
//
//   - a child that dies is respawned against the recorded session file, and the
//     conversation continues (get_messages still returns what was written)
//   - the session file the child names is what the respawn resumes
//   - a detach is respected: no respawn, no autostart
//   - a child that never starts is reported, not respawned forever
//   - the daemon-restart case: a new Supervisor over the same root re-attaches
//     every autostart session, with the transcript still there
//
// Everything here is a real process tree, so cleanup happens in `t.after`: a test
// that fails mid-body still has its children stopped and its temp trees removed,
// because a leaked child holding a pipe open would hang the whole file.

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { readPocketConfig, type PocketConfig } from "../../pocket/config.ts";
import { SessionJournal } from "../../pocket/journal.ts";
import { SessionStore } from "../../pocket/store.ts";
import { Supervisor } from "../../pocket/supervisor.ts";

const FAKE_PI = fileURLToPath(new URL("./pocket-fake-pi.ts", import.meta.url));

/**
 * The supervisor takes a binary path, and a test needs a binary it can point at
 * a TypeScript file with — so write one, once, in this test's own temp tree.
 */
let wrapperPromise: Promise<string> | undefined;
async function fakePiBin(): Promise<string> {
	wrapperPromise ??= (async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "pocket-pi-"));
		const script = path.join(directory, "pi");
		await writeFile(script, `#!/bin/sh\nexec ${process.execPath} --experimental-strip-types ${JSON.stringify(FAKE_PI)} "$@"\n`, { mode: 0o755 });
		await chmod(script, 0o755);
		return script;
	})();
	return wrapperPromise;
}

function testConfig(overrides: Partial<PocketConfig> = {}): PocketConfig {
	const base = readPocketConfig();
	return { ...base, respawnMax: 2, requestTimeoutMs: 5_000, piBin: "", ...overrides };
}

/** Every supervisor a test creates, so even a failed one gets shut down. */
const supervisors: Supervisor[] = [];
after(async () => {
	for (const supervisor of supervisors) await supervisor.shutdown().catch(() => undefined);
});

async function boot(dataRoot: string, overrides: Partial<PocketConfig> = {}): Promise<{ store: SessionStore; journal: SessionJournal; supervisor: Supervisor }> {
	// piBin defaults to the real pi; every test here overrides it with the fake.
	const config = testConfig({ piBin: await fakePiBin(), ...overrides });
	const store = new SessionStore(dataRoot);
	const journal = new SessionJournal(dataRoot, 100);
	const supervisor = new Supervisor(store, journal, config);
	supervisors.push(supervisor);
	return { store, journal, supervisor };
}

/** Poll until a condition holds, with a deadline. */
async function until(check: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Tear a test down.
 *
 * Order matters: the children go first, then the trees. A respawned child holds
 * its session directory open, and removing that directory underneath it produces
 * an ENOTEMPTY that has nothing to do with what the test was checking.
 */
async function teardown(instances: Supervisor[], root: string, project: string): Promise<void> {
	for (const supervisor of instances) await supervisor.shutdown().catch(() => undefined);
	for (const supervisor of instances) await until(async () => supervisor.liveIds().length === 0, 2_000).catch(() => undefined);
	for (const directory of [root, project]) await rm(directory, { recursive: true, force: true, retryDelay: 50 });
}

/** One test's data root, project directory and the supervisor over them. */
async function setup(overrides: Partial<PocketConfig> = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "pocket-sup-"));
	const project = await mkdtemp(path.join(tmpdir(), "pocket-proj-"));
	const booted = await boot(root, overrides);
	return { ...booted, root, project, entry: () => booted.store.create({ name: "work", cwd: project }) };
}

test("a session is attached with a live child that reports its pid", async (t) => {
	const { store, supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();

	const status = await supervisor.attach(created.id);
	assert.equal(status.live, true);
	assert.equal(typeof status.pid, "number");
	// Attaching is idempotent: a second request reuses the child rather than
	// starting a second agent on the same session file.
	const again = await supervisor.attach(created.id);
	assert.equal(again.pid, status.pid);
	assert.deepEqual(supervisor.liveIds(), [created.id]);
	assert.equal((await store.get(created.id))?.id, created.id);
});

test("the child's own session file is recorded after the first start", async (t) => {
	const { store, supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id);
	// pi names the file after our id but prefixes a timestamp, so the supervisor
	// has to take it from the child rather than guess it.
	await until(async () => (await store.get(created.id))?.sessionFile != null);
	const recorded = (await store.get(created.id))?.sessionFile ?? "";
	assert.equal(recorded.startsWith(path.join(root, "sessions", created.id)), true);
	assert.equal(recorded.endsWith(".jsonl"), true);
});

test("a session with no history answers get_messages with an empty list", async (t) => {
	const { supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id);
	assert.deepEqual(await supervisor.messages(created.id), []);
});

test("a prompt reaches the child", async (t) => {
	const { supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id);
	const result = await supervisor.prompt(created.id, "hello");
	assert.equal(result.disposition, "started");
	// A prompt only starts the run; the answer is written once the child settles.
	await until(async () => (await supervisor.messages(created.id)).length === 2);
	const messages = await supervisor.messages(created.id);
	assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
	assert.equal(messages[0].content, "hello");
});

test("a prompt sent twice with the same key is answered once", async (t) => {
	const { supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id);
	const first = await supervisor.prompt(created.id, "hello", { idempotencyKey: "phone-1" });
	await until(async () => (await supervisor.messages(created.id)).length === 2);
	const replayed = await supervisor.prompt(created.id, "hello", { idempotencyKey: "phone-1" });
	// The phone resends what it was not sure arrived. Running the prompt again
	// would tell the agent the same thing twice.
	assert.deepEqual(first, replayed);
	const messages = await supervisor.messages(created.id);
	assert.equal(messages.filter((message) => message.content === "hello").length, 1);
});

test("a child that dies is respawned and resumes the same conversation", async (t) => {
	const { store, supervisor, root, project, entry } = await setup({ respawnMax: 3 });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	const first = await supervisor.attach(created.id);
	await until(async () => (await store.get(created.id))?.sessionFile != null);
	await supervisor.prompt(created.id, "before the crash");
	// Let the answer land first: the crash to test here is a laptop closing on
	// a finished run, not a kill in the middle of writing the transcript.
	await until(async () => (await supervisor.messages(created.id)).length === 2);

	// Kill the child the way a laptop lid does: no chance to clean up.
	process.kill(first.pid as number, "SIGKILL");
	await until(async () => (await supervisor.status(created.id)).pid !== first.pid);

	const status = await supervisor.status(created.id);
	assert.equal(status.live, true);
	assert.equal(status.respawns, 1);
	// The conversation survives the child: this is the whole feature.
	await until(async () => (await supervisor.messages(created.id)).length === 2);
	const messages = await supervisor.messages(created.id);
	assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
	assert.equal(messages[0].content, "before the crash");
});

test("a respawn is journaled so the phone can see it happened", async (t) => {
	const { store, journal, supervisor, root, project, entry } = await setup({ respawnMax: 3 });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	const first = await supervisor.attach(created.id);
	await until(async () => (await store.get(created.id))?.sessionFile != null);
	process.kill(first.pid as number, "SIGKILL");
	await until(async () => (await supervisor.status(created.id)).pid !== first.pid);

	const read = await journal.readSince(created.id, 0);
	const records = read.records.filter((record) => record.kind === "gateway_event").map((record) => record.event);
	assert.ok(records.includes("child_exited"), `journal has no child_exited: ${JSON.stringify(records)}`);
	assert.ok(records.includes("child_respawn"), `journal has no child_respawn: ${JSON.stringify(records)}`);
	// The exit record carries the signal, so a phone can tell a crash from a
	// clean stop rather than guessing.
	const exit = read.records.find((record) => record.event === "child_exited");
	assert.equal(exit?.signal, "SIGKILL");
});

test("a detached session is not respawned", async (t) => {
	const { supervisor, root, project, entry } = await setup({ respawnMax: 3 });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id);
	const pid = (await supervisor.status(created.id)).pid;
	await supervisor.detach(created.id);
	await until(async () => !(await supervisor.status(created.id)).live);
	// Give the exit handler every chance to misread the stop as a crash.
	await new Promise((resolve) => setTimeout(resolve, 150));
	const status = await supervisor.status(created.id);
	assert.equal(status.live, false);
	assert.notEqual(status.pid, pid);
	assert.equal(supervisor.liveIds().includes(created.id), false);
});

test("a parked session does not come back on the next boot", async (t) => {
	const { store, supervisor, root, project, entry } = await setup({ respawnMax: 3 });
	const created = await entry();
	await supervisor.attach(created.id);
	await until(async () => (await store.get(created.id))?.sessionFile != null);
	await supervisor.park(created.id);
	await until(async () => !(await supervisor.status(created.id)).live);

	// A new supervisor is the daemon-restart case.
	const restarted = new Supervisor(store, supervisor.journal, supervisor.config);
	supervisors.push(restarted);
	t.after(() => teardown([supervisor, restarted], root, project));
	const revived = await restarted.reviveAll();
	assert.deepEqual(revived.attached, []);
	assert.equal((await restarted.status(created.id)).live, false);
});

test("a new supervisor re-attaches every session that wants to be running", async (t) => {
	const { store, journal, supervisor, root, project, entry } = await setup({ respawnMax: 3 });
	const created = await entry();
	await supervisor.attach(created.id);
	await until(async () => (await store.get(created.id))?.sessionFile != null);
	await supervisor.prompt(created.id, "before the reboot");
	await supervisor.shutdown();
	await until(async () => !(await supervisor.status(created.id)).live);

	// The reboot is not a reset: the next daemon brings every autostart session
	// back, on the recorded file, with the transcript still there.
	const restarted = new Supervisor(store, journal, supervisor.config);
	supervisors.push(restarted);
	t.after(() => teardown([supervisor, restarted], root, project));
	const revived = await restarted.reviveAll();
	assert.deepEqual(revived.attached, [created.id]);
	assert.deepEqual(revived.failed, []);
	assert.equal((await restarted.status(created.id)).live, true);
	const messages = await restarted.messages(created.id);
	assert.ok(messages.some((message) => message.content === "before the reboot"));
});

test("events reach a subscriber as they are journaled", async (t) => {
	const { supervisor, root, project, entry } = await setup();
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	const seen: string[] = [];
	const unsubscribe = supervisor.subscribe(created.id, (record) => seen.push(record.kind));
	await supervisor.attach(created.id);
	await supervisor.prompt(created.id, "hello");
	unsubscribe();
	// The live view and the replay are the same records: this is what makes a
	// phone's SSE stream and its reconnect identical in content.
	assert.ok(seen.includes("gateway_event"), `subscriber saw no gateway_event: ${seen.join(",")}`);
	assert.ok(seen.includes("pi_event"), `subscriber saw no pi_event: ${seen.join(",")}`);
});

test("a child that dies on start is reported, not respawned forever", async (t) => {
	// A pi path that is not there: the child never starts, so this is the
	// failure that would otherwise respawn in a tight loop.
	const { store, supervisor, root, project, entry } = await setup({ respawnMax: 2, piBin: "/nonexistent/pocket-pi-that-is-not-there" });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id).catch(() => undefined);
	await until(async () => ((await store.get(created.id))?.lastError ?? "").length > 0);

	const stored = await store.get(created.id);
	// The diagnosis has to name the cause, or an operator staring at a dead
	// session has nothing to act on.
	assert.match(stored?.lastError ?? "", /giving up/);
	assert.match(stored?.lastError ?? "", /ENOENT|spawn/i);
	assert.equal((await supervisor.status(created.id)).live, false);
});

test("a prompt that cannot be delivered is journaled, not swallowed", async (t) => {
	// A binary that exits before answering anything: the request fails the same
	// way a child that dies mid-run does.
	const { journal, supervisor, root, project, entry } = await setup({ respawnMax: 0, piBin: "/bin/true" });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await assert.rejects(() => supervisor.prompt(created.id, "will not arrive"));
	const read = await journal.readSince(created.id, 0);
	const failures = read.records.filter((record) => record.event === "prompt_failed");
	assert.ok(failures.length >= 1, "a failed prompt left no record");
	// Whichever way it failed, the record has to say the prompt did not land.
	assert.match(String(failures[0]?.error ?? ""), /exited|not running|not attached|prompt/i);
});

test("a child that died on start is journaled with the reason", async (t) => {
	const { store, journal, supervisor, root, project, entry } = await setup({ respawnMax: 1, piBin: "/nonexistent/pocket-pi-that-is-not-there" });
	t.after(() => teardown([supervisor], root, project));
	const created = await entry();
	await supervisor.attach(created.id).catch(() => undefined);
	await until(async () => ((await store.get(created.id))?.lastError ?? "").length > 0);

	const read = await journal.readSince(created.id, 0);
	const exits = read.records.filter((record) => record.event === "child_exited");
	assert.ok(exits.length >= 1, "no child_exited record");
	// Without the error text, a session that never started looks exactly like a
	// session that crashed, and the phone shows the wrong thing.
	assert.match(String(exits[exits.length - 1]?.error ?? ""), /ENOENT|spawn/i);
});
