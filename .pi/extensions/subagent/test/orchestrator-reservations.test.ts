// Ticket 12: a reserved path refuses a colliding write, and names who holds it.
//
// Path normalisation and matching are pure and tested directly; the guard is
// driven through the runtime's real `tool_call` handler; the lock is exercised
// with concurrent reservers. The tests use real temporary repositories so the
// relative/absolute/symlink spellings are real filesystem spellings, not
// strings that happen to agree.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { registerWorkspace } from "../../orchestrator/workspace-runtime.ts";
import {
	buildReservationPath,
	buildReservationPaths,
	canonicalPath,
	liveReservations,
	readReservations,
	reservationPath,
	reservationPathMatches,
	reservePaths,
	withWorkspaceLock,
	reservationPathsOverlap,
	resolveWorkspaceScope,
	type ReservationPath,
} from "../../orchestrator/workspace.ts";
import {
	callTool,
	gitIn,
	fakeCtx,
	fakePi,
	makeRepoFixture,
	makeRunner,
	resetRegistries,
	type FakePi,
	type RepoFixture,
} from "./workspace-harness.ts";

let fixture: RepoFixture;

before(async () => {
	fixture = await makeRepoFixture("orchestrator-reservations-");
});

after(async () => {
	await fixture.cleanup();
});

beforeEach(async () => {
	await resetRegistries(fixture);
	// The fixture repositories are shared by this file's tests, and two tests
	// deliberately touch the working tree (a shell write and a symlink). Put
	// both trees back so "the tree is clean" is a real assertion, not an order
	// dependency.
	gitIn(fixture.root, "checkout", "--", ".");
	gitIn(fixture.linked, "checkout", "--", ".");
	await rm(path.join(fixture.root, "src-link"), { recursive: true, force: true });
});

async function registryDir(): Promise<string> {
	const scope = await resolveWorkspaceScope(fixture.root, makeRunner());
	assert.equal(scope.ok, true);
	return (scope as { ok: true; scope: { registryDir: string } }).scope.registryDir;
}

async function joinedRuntime(
	sessionId: string,
	cwd = fixture.root,
	options: { now?: () => number; run?: ReturnType<typeof makeRunner> } = {},
): Promise<{ pi: FakePi; runtime: ReturnType<typeof registerWorkspace>; ctx: ReturnType<typeof fakeCtx> }> {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, { run: options.run ?? makeRunner(), now: options.now });
	const ctx = fakeCtx(pi, sessionId, cwd);
	await runtime.join(ctx as never);
	return { pi, runtime, ctx };
}

// --- Path normalisation and matching --------------------------------------

test("relative, dotted and absolute spellings of one file canonicalise together", async () => {
	const absolute = path.join(fixture.root, "src/a.ts");
	assert.equal(canonicalPath(fixture.root, "src/a.ts"), absolute);
	assert.equal(canonicalPath(fixture.root, "./src/../src/a.ts"), absolute);
	assert.equal(canonicalPath(fixture.root, absolute), absolute);
});

test("a symlinked spelling cannot reserve the same file under a second name", async () => {
	const link = path.join(fixture.root, "src-link");
	await symlink(path.join(fixture.root, "src"), link).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	assert.equal(
		canonicalPath(fixture.root, "src-link/a.ts"),
		canonicalPath(fixture.root, "src/a.ts"),
		"the guard compares real paths, so a symlink is not a second reservation",
	);
});

test("file, directory and wildcard reservations are classified, and matching follows the kind", () => {
	const file = buildReservationPath(fixture.root, "src/a.ts");
	assert.equal(file.kind, "file");
	assert.equal(reservationPathMatches(file, path.join(fixture.root, "src/a.ts")), true);
	assert.equal(reservationPathMatches(file, path.join(fixture.root, "src/a.ts.bak")), false);

	const dir = buildReservationPath(fixture.root, "src/");
	assert.equal(dir.kind, "dir");
	assert.equal(reservationPathMatches(dir, path.join(fixture.root, "src/nested/b.ts")), true);
	assert.equal(reservationPathMatches(dir, path.join(fixture.root, "src2/a.ts")), false);

	const flat = buildReservationPath(fixture.root, "src/*.ts");
	assert.equal(flat.kind, "glob");
	assert.equal(reservationPathMatches(flat, path.join(fixture.root, "src/a.ts")), true);
	assert.equal(reservationPathMatches(flat, path.join(fixture.root, "src/nested/b.ts")), false);

	const deep = buildReservationPath(fixture.root, "src/**/*.ts");
	assert.equal(reservationPathMatches(deep, path.join(fixture.root, "src/nested/b.ts")), true);
	assert.equal(reservationPathMatches(deep, path.join(fixture.root, "src/a.ts")), true);

	const rootGlob = buildReservationPath(fixture.root, "*.md");
	assert.equal(reservationPathMatches(rootGlob, path.join(fixture.root, "README.md")), true);

	const paths = buildReservationPaths(fixture.root, ["src/a.ts", "./src/a.ts", "src/"]);
	assert.equal(paths.length, 2, "duplicate spellings collapse; a file and its directory remain distinct");
});

test("overlap detection is conservative for wildcards and exact for files", () => {
	const a: ReservationPath = { pattern: path.join(fixture.root, "src/a.ts"), kind: "file" };
	const b: ReservationPath = { pattern: path.join(fixture.root, "src/a.ts"), kind: "file" };
	const dir: ReservationPath = { pattern: path.join(fixture.root, "src"), kind: "dir" };
	const glob: ReservationPath = { pattern: path.join(fixture.root, "src/*.ts"), kind: "glob" };
	assert.equal(reservationPathsOverlap(a, b), true);
	assert.equal(reservationPathsOverlap(a, dir), true);
	assert.equal(reservationPathsOverlap(a, glob), true);
	assert.equal(reservationPathsOverlap({ pattern: path.join(fixture.root, "docs/x"), kind: "file" }, glob), false);
});

// --- The guard -------------------------------------------------------------

test("another session's write and edit to a reserved path are refused with holder and reason", async () => {
	const holder = await joinedRuntime("holder-session");
	const writer = await joinedRuntime("writer-session");
	const target = path.join(fixture.root, "src/a.ts");

	const reserved = await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "rewriting the module exporter" }, holder.ctx);
	assert.match(reserved.text, /Reserved file:.*src\/a\.ts/);

	for (const tool of ["write", "edit"]) {
		const blocked = await writer.runtime.checkToolCall({ toolName: tool, input: { path: target } }, writer.ctx as never);
		assert.ok(blocked?.block, `${tool} must be refused before execution`);
		assert.match(blocked.reason, /holder-session/);
		assert.match(blocked.reason, /rewriting the module exporter/);
		assert.match(blocked.reason, /advisory/i);
		assert.match(blocked.reason, /orchestrator_reserve/);
	}

	// The guard is a refusal, not a filesystem change: the file is untouched.
	assert.equal(await readFile(target, "utf8"), "export const a = 1;\n");
});

test("two spellings of one file cannot both be reserved", async () => {
	const holder = await joinedRuntime("spelling-holder");
	const writer = await joinedRuntime("spelling-writer");
	const first = await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "canonical claim" }, holder.ctx);
	assert.match(first.text, /^Reserved /m);
	const second = await callTool(writer.pi, "orchestrator_reserve", { action: "reserve", paths: ["./src/../src/a.ts"], reason: "same file, other spelling" }, writer.ctx);
	assert.match(second.text, /^Reservation refused:/m);

	const treeHolder = await joinedRuntime("tree-spelling-holder", fixture.linked);
	await callTool(treeHolder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "worktree claim" }, treeHolder.ctx);
	const treeSecond = await callTool(writer.pi, "orchestrator_reserve", { action: "reserve", paths: [path.join(fixture.linked, "src/a.ts")], reason: "absolute worktree spelling" }, writer.ctx);
	assert.match(treeSecond.text, /^Reservation refused:/m, "the linked worktree's relative and absolute spellings are one path");
});

test("re-reserving supersedes the same session's earlier overlapping record", async () => {
	const holder = await joinedRuntime("extend-holder");
	const first = await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "short claim", ttlSeconds: 5 }, holder.ctx);
	assert.match(first.text, /^Reserved /m);
	const second = await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "longer claim", ttlSeconds: 600 }, holder.ctx);
	assert.match(second.text, /Superseded 1 earlier reservation/);
	const records = await readReservations(await registryDir());
	assert.equal(records.reservations.length, 1, "re-reserving extends the claim rather than leaking a second record");
});

test("a session's own reservation never blocks its own writes", async () => {
	const holder = await joinedRuntime("self-session");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "my own edit" }, holder.ctx);
	const result = await holder.runtime.checkToolCall(
		{ toolName: "write", input: { path: path.join(fixture.root, "src/a.ts") } },
		holder.ctx as never,
	);
	assert.equal(result, undefined);
});

test("directory and wildcard reservations block the paths beneath them", async () => {
	const holder = await joinedRuntime("scope-holder");
	const writer = await joinedRuntime("scope-writer");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/nested/"], reason: "directory work" }, holder.ctx);
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["README.*"], reason: "readme rewrite" }, holder.ctx);

	const nested = await writer.runtime.checkToolCall(
		{ toolName: "edit", input: { path: path.join(fixture.root, "src/nested/b.ts") } },
		writer.ctx as never,
	);
	assert.match(nested?.reason ?? "", /directory work/);
	const readme = await writer.runtime.checkToolCall(
		{ toolName: "write", input: { path: path.join(fixture.root, "README.md") } },
		writer.ctx as never,
	);
	assert.match(readme?.reason ?? "", /readme rewrite/);
});

test("a relative reservation in a linked worktree is matched by its absolute spelling", async () => {
	const holder = await joinedRuntime("tree-holder", fixture.linked);
	const writer = await joinedRuntime("tree-writer", fixture.linked);
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "worktree edit" }, holder.ctx);
	const blocked = await writer.runtime.checkToolCall(
		{ toolName: "write", input: { path: path.join(fixture.linked, "src/a.ts") } },
		writer.ctx as never,
	);
	assert.ok(blocked?.block, "the same file under the worktree's absolute spelling is one path");
	assert.match(blocked.reason, /tree-holder/);
});

test("the override lets one blocked write proceed and is recorded", async () => {
	const holder = await joinedRuntime("override-holder");
	const writer = await joinedRuntime("override-writer");
	const target = path.join(fixture.root, "src/a.ts");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "held" }, holder.ctx);

	const granted = await callTool(writer.pi, "orchestrator_reserve", { action: "override", reason: "the holder is idle and I am taking over" }, writer.ctx);
	assert.match(granted.text, /override granted/i);

	const allowed = await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never);
	assert.equal(allowed, undefined, "the granted override lets this call through");
	const use = writer.pi.entries.find((entry) => entry.type === "orchestrator-workspace-reservation-override" && (entry.data as { action?: string }).action === "use");
	assert.ok(use, "using the override is recorded");
	assert.equal((use.data as { holder?: string }).holder, "override-holder");
	assert.equal((use.data as { reason?: string }).reason, "the holder is idle and I am taking over");

	const second = await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never);
	assert.ok(second?.block, "the override is one-shot");
});

test("a released reservation stops blocking immediately, and an expired one does too", async () => {
	let clock = Date.now();
	const holder = await joinedRuntime("ttl-holder", fixture.root, { now: () => clock });
	const writer = await joinedRuntime("ttl-writer", fixture.root, { now: () => clock });
	const target = path.join(fixture.root, "src/a.ts");
	const reserved = await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "short claim", ttlSeconds: 5 }, holder.ctx);
	assert.match(reserved.text, /Reserved/);

	clock += 6_000;
	const expired = await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never);
	assert.equal(expired, undefined, "a TTL that passed stops blocking before any sweep");

	clock -= 6_000;
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "second claim", ttlSeconds: 600 }, holder.ctx);
	assert.ok((await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never))?.block);
	const released = await callTool(holder.pi, "orchestrator_reserve", { action: "release" }, holder.ctx);
	assert.match(released.text, /Released/);
	assert.equal(
		await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never),
		undefined,
		"an explicit release unblocks immediately",
	);
});

test("leaving releases this session's reservations", async () => {
	const holder = await joinedRuntime("leave-holder");
	const writer = await joinedRuntime("leave-writer");
	const target = path.join(fixture.root, "src/a.ts");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "leaving soon" }, holder.ctx);
	assert.ok((await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never))?.block);
	await holder.runtime.leave();
	assert.equal(await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never), undefined);
});

test("concurrent reservers cannot both believe they hold the same path", async () => {
	const first = await joinedRuntime("race-a");
	const second = await joinedRuntime("race-b");
	const [a, b] = await Promise.all([
		callTool(first.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "first" }, first.ctx),
		callTool(second.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "second" }, second.ctx),
	]);
	const granted = [a, b].filter((result) => /^Reserved /m.test(result.text));
	const refused = [a, b].filter((result) => /^Reservation refused:/m.test(result.text));
	assert.equal(granted.length, 1, "exactly one reserver wins");
	assert.equal(refused.length, 1, "the other is told who holds it");
	const registry = await registryDir();
	const records = await readReservations(registry);
	assert.equal(records.reservations.length, 1);
});

test("concurrent reservers of distinct paths all succeed and the registry stays parsable", async () => {
	const writers = await Promise.all(Array.from({ length: 8 }, (_, index) => joinedRuntime(`distinct-${index}`)));
	const results = await Promise.all(
		writers.map((writer, index) =>
			callTool(writer.pi, "orchestrator_reserve", { action: "reserve", paths: [`src/nested/p${index}.ts`], reason: `path ${index}` }, writer.ctx),
		),
	);
	assert.equal(results.filter((result) => /^Reserved /m.test(result.text)).length, 8);
	const registry = await registryDir();
	const records = await readReservations(registry);
	assert.deepEqual(records.invalid, []);
	assert.equal(records.reservations.length, 8);
});

test("a shell command can still write a reserved path: the limit is stated, not implied away", async () => {
	const holder = await joinedRuntime("shell-holder");
	const writer = await joinedRuntime("shell-writer");
	const target = path.join(fixture.root, "src/a.ts");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "not a security boundary" }, holder.ctx);
	const bash = await writer.runtime.checkToolCall({ toolName: "bash", input: { command: `printf changed > ${JSON.stringify(target)}` } }, writer.ctx as never);
	assert.equal(bash, undefined, "the guard only sees write and edit");
	await writeFile(target, "changed by a shell command\n");
	assert.equal(await readFile(target, "utf8"), "changed by a shell command\n");
	const description = String(holder.pi.tools.get("orchestrator_reserve")?.description ?? "");
	assert.match(description, /shell commands/i);
	assert.match(description, /advisory/i);
});

test("a refused write leaves the host's per-file mutation queue usable and serialised", async () => {
	const holder = await joinedRuntime("queue-holder");
	const writer = await joinedRuntime("queue-writer");
	const target = path.join(fixture.root, "src/a.ts");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "queue check" }, holder.ctx);

	// A mutation is already in flight when the guard refuses a different call on
	// the same file. The refusal must not enter, replace or wedge that queue.
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let firstStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const order: string[] = [];
	const first = withFileMutationQueue(target, async () => {
		order.push("first:start");
		firstStarted();
		await firstGate;
		order.push("first:end");
	});
	await started;
	assert.ok((await writer.runtime.checkToolCall({ toolName: "write", input: { path: target } }, writer.ctx as never))?.block);
	const second = withFileMutationQueue(target, async () => {
		order.push("second");
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(order, ["first:start"], "the second mutation waits behind the first");
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"], "the guard did not bypass or break the host queue");
});

test("the workspace lock keeps two holders out even when the first is slow", async () => {
	const registry = await registryDir();
	let firstInside = false;
	let overlapped = false;
	const slow = withWorkspaceLock(
		registry,
		async () => {
			firstInside = true;
			await new Promise((resolve) => setTimeout(resolve, 120));
			firstInside = false;
		},
		{ staleMs: 20, timeoutMs: 3_000 },
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const quick = withWorkspaceLock(
		registry,
		async () => {
			if (firstInside) overlapped = true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		},
		{ staleMs: 20, timeoutMs: 3_000 },
	);
	await Promise.all([slow, quick]);
	assert.equal(overlapped, false, "a holder that is merely slow is refreshed, not mistaken for crashed");
});

test("a crashed holder's stale lock is broken so the registry cannot wedge", async () => {
	const registry = await registryDir();
	const dir = path.join(registry, "lock");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "owner.json"), JSON.stringify({ token: "dead-holder", pid: 2_147_483_646, at: 1 }));
	const old = new Date(Date.now() - 60_000);
	await utimes(dir, old, old);

	let ran = false;
	await withWorkspaceLock(registry, async () => {
		ran = true;
	}, { staleMs: 20, timeoutMs: 2_000 });
	assert.equal(ran, true, "a lock whose holder never refreshed is recoverable");
});

test("a reservation held by a dead process stops blocking immediately", async () => {
	// A killed writer leaves a record whose TTL has not passed. Presence already
	// treats a dead pid as expired; reservations must do the same or a crash blocks
	// every peer for the reservation's full TTL (default 15 minutes).
	const registry = await registryDir();
	const result = await reservePaths(registry, {
		sessionId: "dead-reserver",
		pid: 2_147_483_646,
		cwd: fixture.root,
		branch: "main",
		paths: buildReservationPaths(fixture.root, ["src/a.ts"]),
		reason: "the holder was killed",
		now: Date.now(),
	});
	assert.equal(result.ok, true);
	const reservation = (result as { ok: true; reservation: { id: string } }).reservation;

	const live = await liveReservations(registry, Date.now());
	assert.equal(live.live.length, 0, "a dead holder's claim is not live");
	assert.equal(live.expired.some((record) => record.sessionId === "dead-reserver"), true);
	assert.equal(existsSync(reservationPath(registry, reservation.id)), false, "the dead record is swept, not just ignored");
});

test("the lock holds across processes, not just across promises", async () => {
	// One process's `Promise.all` only proves the event loop serialised the two
	// checks. The reservation decision is a read-modify-write against the shared
	// store, so two real processes are the honest test of the lock.
	const { execFile: execFileCb } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileP = promisify(execFileCb);
	const modulePath = path.resolve(new URL("../../orchestrator/workspace.ts", import.meta.url).pathname);
	const script = `
		const m = await import(process.env.WORKSPACE_MODULE);
		const paths = m.buildReservationPaths(process.env.CWD, ["src/a.ts"]);
		const result = await m.reservePaths(process.env.REGISTRY, {
			sessionId: process.env.SESSION_ID,
			cwd: process.env.CWD,
			branch: null,
			paths,
			reason: "cross-process race",
			now: Date.now(),
		});
		// Stay alive until the other process has had its turn: a reservation is
		// held by a live pid, so exiting immediately would (correctly) expire this
		// claim before the contender's check.
		await new Promise((resolve) => setTimeout(resolve, 400));
		console.log(JSON.stringify({ ok: result.ok }));
	`;
	const runChild = (sessionId: string) =>
		execFileP(process.execPath, ["--input-type=module", "-e", script], {
			env: {
				...process.env,
				WORKSPACE_MODULE: modulePath,
				CWD: fixture.root,
				REGISTRY: `${fixture.root}/.git/pi-agents`,
				SESSION_ID: sessionId,
			},
		});
	const [a, b] = await Promise.all([runChild("process-a"), runChild("process-b")]);
	const results = [a, b].map((result) => JSON.parse(result.stdout.trim()) as { ok: boolean });
	assert.equal(results.filter((result) => result.ok).length, 1, "exactly one process wins the lock race");
	const records = await readReservations(`${fixture.root}/.git/pi-agents`);
	assert.equal(records.reservations.length, 1);
});

test("nothing is written into the working tree, and the registry is not git-visible", async () => {
	const holder = await joinedRuntime("clean-session");
	await callTool(holder.pi, "orchestrator_reserve", { action: "reserve", paths: ["src/a.ts"], reason: "clean tree" }, holder.ctx);
	assert.equal(gitIn(fixture.root, "status", "--porcelain").trim(), "");
	const registry = await registryDir();
	assert.ok(registry.startsWith(path.join(fixture.root, ".git")));
	assert.equal(existsSync(path.join(fixture.root, "pi-agents")), false);
});
