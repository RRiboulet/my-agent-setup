// Ticket 13: a targeted message reaches a peer at the right moment.
//
// The store tests pin the message contract, expiry and replay; the runtime
// tests drive the actual poller decisions — idle wakes, busy steers, pending
// human input waits, one release per turn, shutdown stops the timer. Nothing
// here sleeps on a production timer: the runtime exposes `tick`, and the
// shutdown test uses a deliberately tiny poll interval to prove the timer is
// gone rather than merely idle.

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { registerWorkspace } from "../../orchestrator/workspace-runtime.ts";
import {
	buildPeerMessage,
	inboxDir,
	readInbox,
	resolveWorkspaceScope,
	sortMessages,
	validatePeerMessage,
	writePeerMessage,
	type PeerMessage,
} from "../../orchestrator/workspace.ts";
import {
	callTool,
	fakeCtx,
	fakePi,
	gitIn,
	makeRepoFixture,
	makeRunner,
	resetRegistries,
	type FakeCtx,
	type FakePi,
	type RepoFixture,
} from "./workspace-harness.ts";

let fixture: RepoFixture;
let registry = "";

before(async () => {
	fixture = await makeRepoFixture("orchestrator-steering-");
	const scope = await resolveWorkspaceScope(fixture.root, makeRunner());
	assert.equal(scope.ok, true);
	registry = (scope as { ok: true; scope: { registryDir: string } }).scope.registryDir;
});

after(async () => {
	await fixture.cleanup();
});

beforeEach(async () => {
	await resetRegistries(fixture);
	gitIn(fixture.root, "checkout", "--", ".");
});

interface Session {
	pi: FakePi;
	runtime: ReturnType<typeof registerWorkspace>;
	ctx: FakeCtx;
}

async function session(
	sessionId: string,
	options: Partial<{ idle: boolean; hasPending: boolean; now: () => number; pollMs: number; heartbeatMs: number; hasUI: boolean }> = {},
): Promise<Session> {
	const pi = fakePi();
	const runtime = registerWorkspace(pi as never, {
		run: makeRunner(),
		now: options.now,
		pollMs: options.pollMs ?? 60_000,
		heartbeatMs: options.heartbeatMs ?? 60_000,
	});
	const ctx = fakeCtx(pi, sessionId, fixture.root, {
		hasUI: options.hasUI ?? false,
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.hasPending ?? false,
	});
	await runtime.join(ctx as never);
	return { pi, runtime, ctx };
}

async function messageFor(
	from: string,
	to: string,
	body: string,
	at = Date.now(),
	ttlMs = 60_000,
	id?: string,
): Promise<PeerMessage> {
	return buildPeerMessage({
		id,
		sessionId: from,
		cwd: fixture.root,
		branch: "main",
		to,
		body,
		now: at,
		ttlMs,
	});
}

function sentMessages(sessionState: Session): { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] {
	return sessionState.pi.messages.filter((entry) => entry.message.customType === "orchestrator-peer-message");
}

// --- The message contract ---------------------------------------------------

test("a peer message validates, is bounded, and sorts oldest first", async () => {
	const older = await messageFor("sender-a", "receiver", "first", 1_000, 60_000, "00000000-0000-4000-8000-000000000001");
	const newer = await messageFor("sender-a", "receiver", "second", 2_000, 60_000, "00000000-0000-4000-8000-000000000002");
	assert.deepEqual(validatePeerMessage(JSON.parse(JSON.stringify(older))), older);
	assert.equal(validatePeerMessage({ ...older, body: "" }), null);
	assert.equal(validatePeerMessage({ ...older, to: "../escape" }), null);
	assert.throws(() => buildPeerMessage({ sessionId: "s", cwd: fixture.root, branch: null, to: "r", body: "x".repeat(9_000), now: 0 }), /at most/);
	assert.deepEqual(sortMessages([newer, older]).map((message) => message.body), ["first", "second"]);
});

test("an inbox reports live and expired messages separately, and a delivered id is never live twice", async () => {
	const receiver = "inbox-receiver";
	const live = await messageFor("sender", receiver, "live", Date.now(), 60_000);
	const expired = await messageFor("sender", receiver, "old", Date.now() - 10_000, 5_000);
	await writePeerMessage(registry, live);
	await writePeerMessage(registry, expired);

	const first = await readInbox(registry, receiver, Date.now());
	assert.deepEqual(first.live.map((message) => message.id), [live.id]);
	assert.deepEqual(first.expired.map((message) => message.id), [expired.id]);

	// A replayed file after delivery is removed by the marker, not delivered.
	const { markMessageDelivered, deliveredMarkerPath } = await import("../../orchestrator/workspace.ts");
	await markMessageDelivered(registry, receiver, live, Date.now());
	assert.equal(await import("node:fs").then((fs) => fs.existsSync(deliveredMarkerPath(registry, receiver, live.id))), true);
	await writePeerMessage(registry, live);
	const second = await readInbox(registry, receiver, Date.now());
	assert.equal(second.live.some((message) => message.id === live.id), false, "the delivered id is not offered again");
});

// --- Delivery policy -------------------------------------------------------

test("an idle peer is woken with a turn, and the message carries sender identity and directory", async () => {
	const sender = await session("idle-sender");
	const receiver = await session("idle-receiver", { idle: true });
	const sent = await callTool(sender.pi, "orchestrator_message", { to: "idle-receiver", body: "please take the docs branch" }, sender.ctx);
	assert.match(sent.text, /Queued message/);
	assert.match(sent.text, /idle-receiver/);

	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1);
	const delivered = sentMessages(receiver)[0]!;
	const content = String(delivered.message.content);
	assert.match(content, /idle-sender/);
	assert.match(content, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(content, /please take the docs branch/);
	assert.deepEqual(delivered.options, { deliverAs: "steer", triggerTurn: true }, "idle: steer with a turn so a race that flips idle cannot lose the wake");
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("a busy peer is steered at its next safe boundary rather than aborted", async () => {
	const sender = await session("busy-sender");
	const receiver = await session("busy-receiver", { idle: false });
	await callTool(sender.pi, "orchestrator_message", { to: "busy-receiver", body: "steer me" }, sender.ctx);
	await receiver.runtime.tick();
	const delivered = sentMessages(receiver)[0]!;
	assert.deepEqual(delivered.options, { deliverAs: "steer", triggerTurn: true });
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("a peer message waits for pending human input and is released afterwards", async () => {
	const sender = await session("human-sender");
	const receiver = await session("human-receiver", { idle: true });
	await callTool(sender.pi, "orchestrator_message", { to: "human-receiver", body: "after the human" }, sender.ctx);

	await receiver.pi.fire("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" });
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 0, "a human prompt owns the boundary");

	await receiver.pi.fire("ui_prompt_end");
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1, "released once the human is done");
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("queued human input also defers a peer message", async () => {
	const sender = await session("queued-sender");
	const receiver = await session("queued-receiver", { idle: true, hasPending: true });
	await callTool(sender.pi, "orchestrator_message", { to: "queued-receiver", body: "later" }, sender.ctx);
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 0);

	// `hasPendingMessages` is read on every tick; flipping it to false models the
	// host having drained its queue.
	receiver.ctx.hasPendingMessages = () => false;
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1);
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("several queued peer messages release one per turn", async () => {
	const receiver = await session("turn-receiver", { idle: true });
	for (const [index, body] of ["one", "two", "three"].entries()) {
		await writePeerMessage(registry, await messageFor("turn-sender", "turn-receiver", body, Date.now() + index, 60_000, `00000000-0000-4000-8000-00000000000${index}`));
	}
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1, "one release on the first turn");
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1, "no second release in the same turn");

	await receiver.pi.fire("turn_end");
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 2, "the next turn releases the next message");
	await receiver.runtime.shutdown();
});

test("a replayed message id is delivered once", async () => {
	const sender = await session("replay-sender");
	const receiver = await session("replay-receiver", { idle: true });
	const message = await messageFor("replay-sender", "replay-receiver", "only once", Date.now(), 60_000, "00000000-0000-4000-8000-0000000000aa");
	await writePeerMessage(registry, message);
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1);

	// Replay the file, as a sender retry or a crash between send and unlink would.
	await writePeerMessage(registry, message);
	await receiver.pi.fire("turn_end");
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 1, "the delivered marker suppresses the replay");
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("an expired message is reported as expired, not delivered", async () => {
	const receiver = await session("expiry-receiver", { idle: true, hasUI: true });
	const expired = await messageFor("expiry-sender", "expiry-receiver", "too late", Date.now() - 20_000, 5_000, "00000000-0000-4000-8000-0000000000ee");
	await writePeerMessage(registry, expired);
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 0);
	const report = receiver.pi.entries.find((entry) => entry.type === "orchestrator-peer-message-expired");
	assert.ok(report, "expiry is recorded");
	assert.equal((report.data as { kind?: string }).kind, "expired");
	assert.ok(receiver.pi.notifications.some((notification) => /expired/.test(notification.message)), "the human is told");
	await receiver.runtime.shutdown();
});

test("a message to a peer that left or expired reports the peer as gone", async () => {
	const sender = await session("gone-sender");
	const receiver = await session("gone-receiver", { idle: true });
	await receiver.runtime.leave();
	const gone = await callTool(sender.pi, "orchestrator_message", { to: "gone-receiver", body: "hello?" }, sender.ctx);
	assert.match(gone.text, /is gone/);
	assert.match(gone.text, /left, was killed, or its TTL passed/);
	await sender.runtime.shutdown();
});

test("an ambiguous recipient prefix is reported, not guessed", async () => {
	const sender = await session("prefix-sender");
	const first = await session("prefix-aaaa", { idle: true });
	const second = await session("prefix-bbbb", { idle: true });
	const result = await callTool(sender.pi, "orchestrator_message", { to: "prefix-", body: "who?" }, sender.ctx);
	assert.match(result.text, /ambiguous/);
	assert.match(result.text, /prefix-aaaa/);
	assert.match(result.text, /prefix-bbbb/);
	await sender.runtime.shutdown();
	await first.runtime.shutdown();
	await second.runtime.shutdown();
});

test("a self-send through an id prefix is refused too", async () => {
	const sender = await session("abcd-1234");
	const result = await callTool(sender.pi, "orchestrator_message", { to: "abcd", body: "talking to myself" }, sender.ctx);
	assert.match(result.text, /Refusing to message this session/);
	const inbox = await readInbox(registry, "abcd-1234", Date.now());
	assert.equal(inbox.live.length, 0, "nothing was queued");
	await sender.runtime.shutdown();
});

test("an invalid inbox file is reported once and removed, not re-reported every tick", async () => {
	const receiver = await session("invalid-receiver", { idle: true });
	const dir = inboxDir(registry, "invalid-receiver");
	await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
	await import("node:fs/promises").then((fs) => fs.writeFile(`${dir}/corrupt-message.json`, "not json\n"));
	await receiver.runtime.tick();
	const first = receiver.pi.entries.filter((entry) => entry.type === "orchestrator-peer-message-expired");
	assert.equal(first.length, 1);
	assert.equal((first[0]!.data as { kind?: string }).kind, "invalid");
	await receiver.runtime.tick();
	assert.equal(receiver.pi.entries.filter((entry) => entry.type === "orchestrator-peer-message-expired").length, 1, "removed after the first report");
	await receiver.runtime.shutdown();
});

test("shutdown clears the intervals it created, not merely makes tick inert", async () => {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	let created = 0;
	let cleared = 0;
	globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
		created++;
		return realSet(fn, ms, ...args) as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
		cleared++;
		realClear(id);
	}) as typeof clearInterval;
	try {
		const receiver = await session("timer-receiver", { idle: true, pollMs: 5, heartbeatMs: 60_000 });
		assert.ok(created >= 2, "join starts a heartbeat and a poller");
		await receiver.runtime.shutdown();
		assert.ok(cleared >= created, "shutdown clears every interval the join started");
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
});

test("a message body over the cap is refused before it is written", async () => {
	const sender = await session("cap-sender");
	const receiver = await session("cap-receiver", { idle: true });
	const result = await callTool(sender.pi, "orchestrator_message", { to: "cap-receiver", body: "x".repeat(9_000) }, sender.ctx);
	assert.match(result.text, /at most/);
	assert.equal(sentMessages(receiver).length, 0);
	await sender.runtime.shutdown();
	await receiver.runtime.shutdown();
});

test("after shutdown no poller remains to deliver a later message", async () => {
	const receiver = await session("shutdown-receiver", { idle: true, pollMs: 5, heartbeatMs: 60_000 });
	await receiver.runtime.shutdown();
	await writePeerMessage(registry, await messageFor("late-sender", "shutdown-receiver", "should never land", Date.now(), 60_000));
	await new Promise((resolve) => setTimeout(resolve, 50));
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 0, "the cleared poller is gone, not merely slow");
});

test("leaving clears the poller as well", async () => {
	const receiver = await session("leave-receiver", { idle: true, pollMs: 5, heartbeatMs: 60_000 });
	await receiver.runtime.leave();
	await writePeerMessage(registry, await messageFor("late-sender", "leave-receiver", "after leave", Date.now(), 60_000));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(sentMessages(receiver).length, 0);
});

test("one message is delivered to the named peer and not to another live session", async () => {
	const sender = await session("target-sender");
	const wanted = await session("target-wanted", { idle: true });
	const other = await session("target-other", { idle: true });
	await callTool(sender.pi, "orchestrator_message", { to: "target-wanted", body: "just you" }, sender.ctx);
	await wanted.runtime.tick();
	await other.runtime.tick();
	assert.equal(sentMessages(wanted).length, 1);
	assert.equal(sentMessages(other).length, 0);
	await sender.runtime.shutdown();
	await wanted.runtime.shutdown();
	await other.runtime.shutdown();
});

test("a message cannot be sent to this session itself", async () => {
	const sender = await session("self-message");
	const result = await callTool(sender.pi, "orchestrator_message", { to: "self-message", body: "me" }, sender.ctx);
	assert.match(result.text, /Refusing to message this session/);
	await sender.runtime.shutdown();
});

test("a runtime that is not joined cannot send, and neither side creates a message", async () => {
	const sender = await session("unjoined-sender");
	await sender.runtime.leave();
	const receiver = await session("unjoined-receiver", { idle: true });
	const result = await callTool(sender.pi, "orchestrator_message", { to: "unjoined-receiver", body: "hi" }, sender.ctx);
	assert.match(result.text, /joined workspace/);
	await receiver.runtime.tick();
	assert.equal(sentMessages(receiver).length, 0);
	await receiver.runtime.shutdown();
});
