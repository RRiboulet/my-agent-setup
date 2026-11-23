// Ticket 11: sessions in one repository can see each other.
//
// The store is exercised against real temporary git repositories, including a
// linked worktree whose `.git` is a file — the case that makes
// `--git-common-dir` load-bearing rather than decorative. The runtime tests
// drive the real extension half with a fake pi host and a real git runner; the
// store tests write and read concurrently so an atomicity regression is a
// failure here, not a puzzling one in production.

import assert from "node:assert/strict";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import { registerWorkspace } from "../../orchestrator/workspace-runtime.ts";
import { waitFor } from "./helpers.ts";
import {
	DEFAULT_PRESENCE_TTL_MS,
	MAX_PRESENCE_TTL_MS,
	touchPresence,
	buildPresence,
	listPresence,
	presenceDir,
	presenceHeartbeatMs,
	presenceIsLive,
	presencePath,
	readPresence,
	readWorkspaceBranch,
	resolveWorkspaceScope,
	validatePresence,
	writePresence,
	type GitRun,
	type PresenceRecord,
	type WorkspaceScope,
} from "../../orchestrator/workspace.ts";
const execFileP = promisify(execFileCb);

function gitIn(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A real git runner, shaped like pi.exec's result. */
function makeRunner(): GitRun {
	return async (args, cwd) => {
		try {
			const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
			return { stdout, stderr: "", code: 0, killed: false };
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? "",
				code: typeof failure.code === "number" ? failure.code : 1,
				killed: false,
			};
		}
	};
}

let root = "";
let linked = "";
let other = "";
let outside = "";
let mainRegistry = "";
let otherRegistry = "";

before(async () => {
	const base = await mkdtemp(path.join(tmpdir(), "orchestrator-workspace-"));
	root = path.join(base, "main");
	linked = path.join(base, "linked");
	other = path.join(base, "other");
	outside = path.join(base, "outside");
	await mkdir(outside, { recursive: true });

	await mkdir(root, { recursive: true });
	gitIn(root, "init", "-b", "main", "-q");
	gitIn(root, "config", "user.name", "Workspace Harness");
	gitIn(root, "config", "user.email", "workspace@harness.invalid");
	await writeFile(path.join(root, "README.md"), "workspace fixture\n");
	gitIn(root, "add", "-A");
	gitIn(root, "commit", "-q", "-m", "initial");
	gitIn(root, "worktree", "add", "-q", "-b", "linked-branch", linked);

	await mkdir(other, { recursive: true });
	gitIn(other, "init", "-b", "trunk", "-q");
	gitIn(other, "config", "user.name", "Workspace Harness");
	gitIn(other, "config", "user.email", "workspace@harness.invalid");
	await writeFile(path.join(other, "x.txt"), "other\n");
	gitIn(other, "add", "-A");
	gitIn(other, "commit", "-q", "-m", "other initial");

	mainRegistry = path.join(root, ".git", "pi-agents");
	otherRegistry = path.join(other, ".git", "pi-agents");
});

beforeEach(async () => {
	// The fixture repositories are shared by the file's tests, so each test
	// starts from an empty store. That is isolation, not a shortcut: no test
	// depends on another's records.
	await rm(mainRegistry, { recursive: true, force: true });
	await rm(otherRegistry, { recursive: true, force: true });
});

after(async () => {
	await rm(path.dirname(root), { recursive: true, force: true });
});

interface FakePi {
	tools: Map<string, Record<string, unknown>>;
	handlers: Map<string, ((...args: unknown[]) => unknown)[]>;
	entries: { type: string; data: unknown }[];
	messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[];
	notifications: string[];
	registerTool: (definition: Record<string, unknown>) => void;
	appendEntry: (type: string, data: unknown) => void;
	sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
	on: (event: string, handler: (...args: unknown[]) => unknown) => void;
}

function fakePi(): FakePi {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	const entries: { type: string; data: unknown }[] = [];
	const messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];
	const notifications: string[] = [];
	return {
		tools,
		handlers,
		entries,
		messages,
		notifications,
		registerTool: (definition) => {
			tools.set(String(definition.name), definition);
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
		sendMessage: (message, options) => {
			messages.push({ message, options });
		},
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
}

interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	ui: { notify: (message: string, type?: string) => void };
	isIdle: () => boolean;
	hasPendingMessages: () => boolean;
	signal: AbortSignal | undefined;
	sessionManager: { getSessionId: () => string };
}

function fakeCtx(pi: FakePi, sessionId: string, cwd: string, overrides: Partial<FakeCtx> = {}): FakeCtx {
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: (message) => {
				pi.notifications.push(message);
			},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		signal: undefined,
		sessionManager: { getSessionId: () => sessionId },
		...overrides,
	};
}

async function scopes(): Promise<{ main: WorkspaceScope; linked: WorkspaceScope; other: WorkspaceScope }> {
	const run = makeRunner();
	const main = await resolveWorkspaceScope(root, run);
	const tree = await resolveWorkspaceScope(linked, run);
	const second = await resolveWorkspaceScope(other, run);
	assert.equal(main.ok, true);
	assert.equal(tree.ok, true);
	assert.equal(second.ok, true);
	return {
		main: (main as { ok: true; scope: WorkspaceScope }).scope,
		linked: (tree as { ok: true; scope: WorkspaceScope }).scope,
		other: (second as { ok: true; scope: WorkspaceScope }).scope,
	};
}

// --- Scope -----------------------------------------------------------------

test("the main checkout and a linked worktree share one registry; another repository does not", async () => {
	const { main, linked: tree, other: second } = await scopes();
	assert.equal(main.registryDir, tree.registryDir, "a linked worktree must resolve to the main checkout's store");
	assert.equal(main.commonDir, tree.commonDir);
	assert.notEqual(main.registryDir, second.registryDir, "unrelated repositories must not share state");
	assert.equal(path.basename(main.commonDir), ".git");
	assert.equal(main.registryDir, path.join(main.commonDir, "pi-agents"));
	assert.equal(main.branch, "main");
	assert.equal(tree.branch, "linked-branch", "the worktree keeps its own branch name");
	// The linked worktree's `.git` is a file; --git-common-dir is what makes the
	// shared store work, so pin the shape the fixture actually has.
	assert.ok(existsSync(path.join(linked, ".git")));
	assert.equal(gitIn(linked, "rev-parse", "--is-inside-work-tree").trim(), "true");
});

test("outside a git repository resolution is a reported no-op, not an error", async () => {
	const result = await resolveWorkspaceScope(outside, makeRunner());
	assert.equal(result.ok, false);
	assert.match((result as { ok: false; reason: string }).reason, /not a git repository/);
});

// --- Presence records ------------------------------------------------------

function recordFor(sessionId: string, at: number, ttlMs = DEFAULT_PRESENCE_TTL_MS): PresenceRecord {
	return buildPresence({ sessionId, pid: process.pid, cwd: root, branch: "main", now: at, ttlMs });
}

test("presence validates, round-trips and expires on its own TTL", async () => {
	const { main } = await scopes();
	const at = 1_000_000;
	const record = recordFor("session-ttl", at, 10_000);
	assert.deepEqual(validatePresence(JSON.parse(JSON.stringify(record))), record);
	assert.equal(validatePresence({ ...record, version: 99 }), null, "a foreign version is ignored, not misread");
	assert.equal(validatePresence({ ...record, sessionId: "../escape" }), null, "an id that is a path is rejected");

	assert.equal(presenceIsLive(record, at + 9_999), true);
	assert.equal(presenceIsLive(record, at + 10_001), false);

	await writePresence(main.registryDir, record);
	assert.deepEqual(await readPresence(main.registryDir, record.sessionId), record);

	const fresh = await listPresence(main.registryDir, at + 1_000);
	assert.deepEqual(fresh.expired, []);
	assert.equal(fresh.peers.some((peer) => peer.sessionId === record.sessionId), true);

	const stale = await listPresence(main.registryDir, at + 10_001);
	assert.deepEqual(stale.expired.map((peer) => peer.sessionId), [record.sessionId]);
	assert.equal(stale.peers.some((peer) => peer.sessionId === record.sessionId), false);
	assert.equal(existsSync(presencePath(main.registryDir, record.sessionId)), false, "a sweep removes the file");
});

test("a per-join TTL always gets a heartbeat that fits inside it", () => {
	// The default beat is 20s. Join with ttlSeconds 10 and a beat of 20s would
	// leave the record expired for half of every cycle, and a peer's sweep would
	// delete it — a live session flickering out of the peer list.
	assert.equal(presenceHeartbeatMs(10_000, 20_000), 3_333);
	assert.ok(presenceHeartbeatMs(10_000, 20_000) < 10_000);
	assert.equal(presenceHeartbeatMs(5_000, 20_000), 1_667);
	assert.equal(presenceHeartbeatMs(600_000, 20_000), 20_000, "a long TTL keeps the preferred beat");
});

test("a rejected git call is reported, not cached as a throwing promise", async () => {
	const pi = fakePi();
	let reject = true;
	const run = async () => {
		if (reject) throw new Error("transport read fatal");
		return { stdout: `${path.join(root, ".git")}\n`, stderr: "", code: 0 };
	};
	const runtime = registerWorkspace(pi as never, { run });
	const ctx = fakeCtx(pi, "reject-session", root);
	const joined = await runtime.join(ctx as never);
	assert.match(joined, /Workspace not joined: git failed: transport read fatal/);
	const peers = await runtime.peers(ctx as never);
	assert.match(peers, /Workspace unavailable: git failed: transport read fatal/, "peers answers instead of rethrowing the cached rejection");
	reject = false;
	// `join` forces a retry, so the failure is not permanent.
	const retried = await runtime.join(ctx as never);
	assert.doesNotMatch(retried, /git failed/);
	await runtime.shutdown();
});

test("a failed join reports joined: false in the machine-readable result", async () => {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run: makeRunner() });
	const tool = pi.tools.get("orchestrator_workspace") as { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> };
	const result = await tool.execute("call", { action: "join" }, undefined, undefined, fakeCtx(pi, "outside-join", outside));
	assert.equal(result.details.joined, false);
	await runtime.shutdown();
});

test("a heartbeat already in flight cannot resurrect a left session", async () => {
	const pi = fakePi();
	let beatStarted = false;
	let releaseBeat: (() => void) | null = null;
	const gate = new Promise<void>((resolve) => {
		releaseBeat = resolve;
	});
	const runtime = registerWorkspace(pi as never, {
		run: makeRunner(),
		heartbeatMs: 10,
		touch: async (registry, record, at) => {
			beatStarted = true;
			await gate;
			return touchPresence(registry, record, at);
		},
	});
	const ctx = fakeCtx(pi, "beat-leave", root);
	await runtime.join(ctx as never, { ttlMs: 60_000 });
	const { main } = await scopes();
	const file = presencePath(main.registryDir, "beat-leave");
	await waitFor(() => beatStarted);
	await runtime.leave();
	releaseBeat!();
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(existsSync(file), false, "the in-flight beat's write is undone after leave");
});

test("a killed session's presence is swept immediately when its pid is gone", async () => {
	const { main } = await scopes();
	const dead = buildPresence({
		sessionId: "dead-session",
		pid: 2_147_483_646, // outside any real pid range
		cwd: root,
		branch: "main",
		now: Date.now(),
	});
	await writePresence(main.registryDir, dead);
	const result = await listPresence(main.registryDir, Date.now());
	assert.equal(result.peers.some((peer) => peer.sessionId === "dead-session"), false);
	assert.equal(result.expired.some((peer) => peer.sessionId === "dead-session"), true);
});

test("a heartbeat refreshes a branch that changed after join", async () => {
	const base = makeRunner();
	let branch = "main";
	const run = async (args: string[], cwd: string) => {
		const result = await base(args, cwd);
		if (args[0] === "symbolic-ref") return { ...result, stdout: `${branch}\n`, code: 0 };
		return result;
	};
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run, heartbeatMs: 10 });
	const ctx = fakeCtx(pi, "branch-refresh", root);
	await runtime.join(ctx as never, { ttlMs: 60_000 });
	try {
		const { main } = await scopes();
		const file = presencePath(main.registryDir, "branch-refresh");
		assert.equal((await readPresence(main.registryDir, "branch-refresh"))?.branch, "main");

		branch = "moved-after-join";
		await waitFor(async () => (await readPresence(main.registryDir, "branch-refresh"))?.branch === "moved-after-join");
		assert.equal((await readPresence(main.registryDir, "branch-refresh"))?.branch, "moved-after-join");
		assert.equal(existsSync(file), true);

		// A transient git failure must keep the last known branch, not advertise
		// a detached HEAD; readWorkspaceBranch throws for that reason.
		let failGit = true;
		const failing = async (args: string[], cwd: string) => {
			if (failGit && args[0] === "symbolic-ref") throw new Error("spawn EAGAIN");
			return run(args, cwd);
		};
		await assert.rejects(() => readWorkspaceBranch(root, failing), /spawn EAGAIN/);
		failGit = false;
		assert.equal(await readWorkspaceBranch(root, run), "moved-after-join");
	} finally {
		await runtime.shutdown();
	}
});

test("an old unparsable presence file is swept; a fresh one is reported", async () => {
	const { main } = await scopes();
	const dir = presenceDir(main.registryDir);
	await mkdir(dir, { recursive: true });
	const oldFile = path.join(dir, "corrupt-old.json");
	const freshFile = path.join(dir, "corrupt-fresh.json");
	await writeFile(oldFile, "not json\n");
	await writeFile(freshFile, "not json\n");
	const old = new Date(Date.now() - MAX_PRESENCE_TTL_MS - 60_000);
	await utimes(oldFile, old, old);

	const listed = await listPresence(main.registryDir, Date.now());
	assert.equal(existsSync(oldFile), false, "a stale corrupt file is removed instead of re-reported forever");
	assert.equal(listed.invalid.includes("corrupt-old.json"), false);
	assert.equal(existsSync(freshFile), true, "a fresh record may belong to a newer build; leave it to its owner");
	assert.equal(listed.invalid.includes("corrupt-fresh.json"), true);
});

test("an unparsable presence entry that cannot be unlinked stays visible", async () => {
	const { main } = await scopes();
	const dir = presenceDir(main.registryDir);
	await mkdir(dir, { recursive: true });
	// A directory named like a record cannot be read or unlinked as a file; the
	// sweep must not claim it is gone just because removal failed.
	const stubborn = path.join(dir, "stubborn.json");
	await mkdir(stubborn, { recursive: true });
	const old = new Date(Date.now() - MAX_PRESENCE_TTL_MS - 60_000);
	await utimes(stubborn, old, old);
	const listed = await listPresence(main.registryDir, Date.now());
	assert.equal(listed.invalid.includes("stubborn.json"), true, "an unremovable stale entry is reported, not hidden");
	await rm(stubborn, { recursive: true, force: true });
});

test("the presence list cap is reported, not silent", async () => {
	const { main } = await scopes();
	const at = Date.now();
	await Promise.all(
		Array.from({ length: 205 }, (_, index) => writePresence(main.registryDir, recordFor(`cap-${index}`, at))),
	);
	const listed = await listPresence(main.registryDir, at + 100);
	assert.equal(listed.peers.length, 200);
	assert.equal(listed.truncated, 5, "the oldest five live peers are omitted and the count is reported");
});

test("the peers tool still names a joined self the cap dropped, and counts only omitted others", async () => {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run: makeRunner(), heartbeatMs: 60_000 });
	const ctx = fakeCtx(pi, "cap-self", root);
	await runtime.join(ctx as never, { ttlMs: 600_000 });
	const { main } = await scopes();
	const at = Date.now();
	// Make self the oldest record, then add more peers than the cap.
	await writePresence(main.registryDir, {
		...buildPresence({ sessionId: "cap-self", pid: process.pid, cwd: root, branch: "main", now: at - 100_000, ttlMs: 600_000 }),
	});
	await Promise.all(
		Array.from({ length: 205 }, (_, index) => writePresence(main.registryDir, recordFor(`cap-peer-${index}`, at + 1_000 + index))),
	);
	const text = await runtime.peers(ctx as never);
	assert.match(text, /You: cap-self .*outside this capped list/, "a joined session is never reported as not joined");
	assert.match(text, /omitted by the list cap/);
	// 206 live records, cap 200: 6 dropped, one is self, so 5 peers are omitted.
	assert.match(text, /5 older live peer\(s\) omitted/);
	await runtime.shutdown();
});

test("concurrent joins and heartbeats never leave an unparsable registry", async () => {
	const { main } = await scopes();
	const at = Date.now();
	const sessions = Array.from({ length: 24 }, (_, index) => `concurrent-${index}`);
	let reading = true;
	let reads = 0;
	const reader = (async () => {
		while (reading) {
			const result = await listPresence(main.registryDir, at);
			reads++;
			assert.deepEqual(result.invalid, [], "a reader never sees a half-written presence record");
			for (const peer of result.peers) {
				assert.equal(validatePresence(peer)?.sessionId, peer.sessionId);
			}
		}
	})();
	await Promise.all(
		sessions.map(async (sessionId, index) => {
			const record = recordFor(sessionId, at + index);
			await writePresence(main.registryDir, record);
			for (let beat = 1; beat <= 4; beat++) {
				await writePresence(main.registryDir, { ...record, lastSeenAt: at + index + beat });
			}
		}),
	);
	reading = false;
	await reader;
	assert.ok(reads > 0, "the reader actually raced the writers");
	const final = await listPresence(main.registryDir, at + 100);
	assert.deepEqual(final.invalid, []);
	for (const sessionId of sessions) {
		assert.ok(final.peers.some((peer) => peer.sessionId === sessionId), `${sessionId} survived every write`);
	}
});

// --- Runtime ---------------------------------------------------------------

test("two runtimes in one repository and a linked worktree see each other, and leaving is prompt", async () => {
	const run = makeRunner();
	const mainPi = fakePi();
	const treePi = fakePi();
	const main = registerWorkspace(mainPi as never, { run });
	const tree = registerWorkspace(treePi as never, { run, now: () => Date.now() });

	const mainText = await main.join(fakeCtx(mainPi, "main-session", root) as never);
	assert.match(mainText, /Joined the workspace/);
	assert.equal(main.isJoined(), true);

	const treeText = await tree.join(fakeCtx(treePi, "tree-session", linked) as never);
	assert.match(treeText, /tree-session/);
	assert.match(treeText, /main-session/, "the worktree sees the main checkout's session");
	assert.match(treeText, /linked-branch/, "the joining session's own branch is stated");

	const peersText = await main.peers(fakeCtx(mainPi, "main-session", root) as never);
	assert.match(peersText, /tree-session/);
	assert.match(peersText, /last seen/);
	assert.match(peersText, /linked/);

	// The registry is inside the git common dir, so the working tree stays clean.
	const { main: mainScope } = await scopes();
	assert.ok(mainScope.registryDir.startsWith(mainScope.commonDir));
	assert.equal(gitIn(root, "status", "--porcelain").trim(), "", "nothing is written into the working tree");

	assert.match(await tree.leave(), /presence removed/);
	const afterLeave = await main.peers(fakeCtx(mainPi, "main-session", root) as never);
	assert.doesNotMatch(afterLeave, /tree-session/);
	assert.equal(existsSync(presencePath(mainScope.registryDir, "tree-session")), false);

	await main.shutdown();
	assert.equal(main.isJoined(), false);
	assert.equal(existsSync(presencePath(mainScope.registryDir, "main-session")), false);
});

test("shutdown stops the heartbeat: the presence entry does not come back", async () => {
	const run = makeRunner();
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, {
		run,
		heartbeatMs: 5,
	});
	const ctx = fakeCtx(pi, "shutdown-session", root);
	await runtime.join(ctx as never, { ttlMs: 60_000 });
	const { main } = await scopes();
	const file = presencePath(main.registryDir, "shutdown-session");
	assert.equal(existsSync(file), true);

	await runtime.shutdown();
	assert.equal(existsSync(file), false);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(existsSync(file), false, "a cleared heartbeat must not recreate the record");
});

test("outside a git repository join is a no-op that reports why", async () => {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run: makeRunner() });
	const text = await runtime.join(fakeCtx(pi, "outside-session", outside) as never);
	assert.match(text, /Workspace not joined/);
	assert.match(text, /outside a git repository/);
	assert.equal(runtime.isJoined(), false);
});

test("the registry resolves through a linked worktree whose .git is a file", async () => {
	// Explicit regression for the resolution rule: a `--show-toplevel`-based
	// implementation would pass the main-checkout test and silently give each
	// worktree a private registry.
	const { linked: tree, main } = await scopes();
	assert.equal(tree.commonDir, main.commonDir);
	assert.equal(tree.registryDir, main.registryDir);
	assert.equal(gitIn(linked, "rev-parse", "--show-toplevel").trim(), linked);
});

test("the join command is idempotent and reports the same peers", async () => {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run: makeRunner() });
	const ctx = fakeCtx(pi, "idempotent-session", root);
	await runtime.join(ctx as never);
	const second = await runtime.join(ctx as never);
	assert.match(second, /Already joined/);
	assert.match(second, /idempotent-session/);
	await runtime.shutdown();
});
