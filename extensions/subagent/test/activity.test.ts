// Unit tests for the child activity snapshot.
//
// Risk covered: this file is the only liveness signal the parent has. A wrong
// phase, a lost write, or a stale snapshot attributed to the wrong child would
// make the parent report a run that is not doing what it says it is doing.
// Nothing here may throw on bad input — the watcher calls it on every tick.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	createActivityRecorder,
	getActivityFilePath,
	readActivityFile,
	validateActivityState,
	type SubagentActivityState,
} from "../activity.ts";

interface RecorderHarness {
	recorder: ReturnType<typeof createActivityRecorder>;
	writes: SubagentActivityState[];
	advance: (ms: number) => void;
	errors: unknown[];
}

function createHarness(overrides: Partial<Parameters<typeof createActivityRecorder>[0]> = {}): RecorderHarness {
	let clock = 1_000;
	const writes: SubagentActivityState[] = [];
	const errors: unknown[] = [];
	const recorder = createActivityRecorder({
		filePath: "/tmp/does-not-matter.json",
		childId: "run-1",
		now: () => clock,
		write: async (_filePath, value) => {
			writes.push(value as SubagentActivityState);
		},
		onError: (error) => errors.push(error),
		...overrides,
	});
	return {
		recorder,
		writes,
		errors,
		advance: (ms) => {
			clock += ms;
		},
	};
}

test("the snapshot starts in the starting phase", () => {
	const { recorder } = createHarness();
	const state = recorder.current();
	assert.equal(state.version, 1);
	assert.equal(state.runningChildId, "run-1");
	assert.equal(state.phase, "starting");
	assert.equal(state.sequence, 0);
	assert.equal(state.agentActive, false);
	assert.equal(state.providerActive, false);
	assert.equal(state.toolActive, false);
});

test("provider and streaming work move the phase to active and record the scope", async () => {
	const h = createHarness();
	await h.recorder.sessionStart();
	await h.recorder.providerRequest();
	assert.equal(h.recorder.current().phase, "active");
	assert.equal(h.recorder.current().activeScope, "provider");
	assert.equal(h.recorder.current().providerActive, true);

	h.advance(1_000);
	await h.recorder.providerResponse();
	assert.equal(h.recorder.current().providerActive, false);
	assert.equal(h.recorder.current().phase, "active", "the turn is still going");

	h.advance(1_000);
	await h.recorder.messageUpdate();
	assert.equal(h.recorder.current().activeScope, "streaming");
	assert.ok((h.recorder.current().activeSince ?? 0) > 0, "activeSince is stamped once");
});

test("tool activity records the tool name and returns to the agent scope", async () => {
	const h = createHarness();
	await h.recorder.toolStart("bash");
	let state = h.recorder.current();
	assert.equal(state.phase, "active");
	assert.equal(state.activeScope, "tool");
	assert.equal(state.toolName, "bash");
	assert.equal(state.toolActive, true);

	h.advance(1_000);
	await h.recorder.toolUpdate("bash");
	assert.equal(h.recorder.current().toolActive, true, "a long tool keeps reporting activity");

	h.advance(1_000);
	await h.recorder.toolEnd("bash");
	state = h.recorder.current();
	assert.equal(state.toolActive, false);
	assert.equal(state.activeScope, "agent");
});

test("a message update does not override an in-flight tool", async () => {
	const h = createHarness();
	await h.recorder.toolStart("read");
	h.advance(1_000);
	await h.recorder.messageUpdate();
	assert.equal(h.recorder.current().activeScope, "tool", "the tool scope wins");
});

test("agent_end parks the run in waiting with a waitingSince stamp", async () => {
	const h = createHarness();
	await h.recorder.providerRequest();
	h.advance(1_000);
	await h.recorder.agentEnd();
	const state = h.recorder.current();
	assert.equal(state.phase, "waiting");
	assert.equal(state.agentActive, false);
	assert.equal(state.providerActive, false);
	assert.equal(state.activeScope, undefined);
	assert.equal(state.activeSince, undefined);
	assert.equal(state.waitingSince, 2_000);
});

test("user input resumes activity from waiting", async () => {
	const h = createHarness();
	await h.recorder.agentEnd();
	h.advance(1_000);
	await h.recorder.input();
	const state = h.recorder.current();
	assert.equal(state.phase, "active");
	assert.equal(state.activeScope, "agent");
	assert.equal(state.waitingSince, undefined);
});

test("settled forces a durable write even inside the throttle window", async () => {
	// The parent treats result.json as the completion signal, so the terminal
	// snapshot has to be on disk first.
	const h = createHarness();
	await h.recorder.sessionStart();
	const before = h.writes.length;
	await h.recorder.settled();
	assert.equal(h.writes.length, before + 1);
	const snapshot = h.writes.at(-1);
	assert.equal(snapshot?.phase, "done");
	assert.equal(snapshot?.toolActive, false);
	assert.equal(snapshot?.activeScope, undefined);
	assert.equal(snapshot?.latestEvent, "agent_settled");
});

test("shutdown records the done phase and stays idempotent", async () => {
	const h = createHarness();
	await h.recorder.sessionStart();
	await h.recorder.shutdown();
	assert.equal(h.writes.length, 2, "the transition to done is written");
	assert.equal(h.writes.at(-1)?.latestEvent, "session_shutdown");
	assert.equal(h.writes.at(-1)?.phase, "done");

	// Already done inside the throttle window: no extra write, state unchanged.
	await h.recorder.shutdown();
	assert.equal(h.writes.length, 2);
	assert.equal(h.recorder.current().phase, "done");
});

test("a phase transition is never throttled away", async () => {
	const h = createHarness();
	await h.recorder.sessionStart();
	assert.equal(h.writes.length, 1);
	// Same clock tick, so the throttle window has not elapsed. The transition
	// starting -> active is the signal the parent must not miss.
	await h.recorder.providerRequest();
	assert.equal(h.writes.length, 2);
	assert.equal(h.writes.at(-1)?.phase, "active");
});

test("repeated updates inside one phase are throttled", async () => {
	const h = createHarness();
	await h.recorder.sessionStart();
	await h.recorder.providerRequest();
	assert.equal(h.writes.length, 2);
	await h.recorder.messageUpdate();
	assert.equal(h.writes.length, 2, "same phase inside the window, no write");
	assert.equal(h.recorder.current().sequence, 3, "the sequence still advances");

	h.advance(600);
	await h.recorder.messageUpdate();
	assert.equal(h.writes.length, 3, "past the window, the state lands");
	assert.equal(h.writes.at(-1)?.sequence, 4);
});

test("a failing write is retried and the recorder disables itself after the limit", async () => {
	let attempts = 0;
	const h = createHarness({
		write: async () => {
			attempts += 1;
			throw new Error("disk on fire");
		},
		maxWriteFailures: 2,
	});
	await h.recorder.sessionStart();
	await h.recorder.sessionStart();
	assert.equal(attempts, 1, "a repeat inside the window is swallowed by the throttle");
	assert.equal(h.errors.length, 1);

	h.advance(10_000);
	await h.recorder.settled();
	assert.equal(attempts, 2, "forced writes still try");

	h.advance(10_000);
	await h.recorder.settled();
	assert.equal(attempts, 2, "disabled after reaching the failure limit");
	// The write that tripped the limit still recorded its own state change, but
	// from here on the recorder is inert.
	assert.equal(h.recorder.current().phase, "done");
	const frozen = h.recorder.current().sequence;
	h.advance(10_000);
	await h.recorder.input();
	await h.recorder.settled();
	assert.equal(h.recorder.current().phase, "done", "a disabled recorder stops mutating state");
	assert.equal(h.recorder.current().sequence, frozen, `and stops counting events (was ${frozen})`);
});

test("a successful write resets the failure counter", async () => {
	let fail = true;
	const h = createHarness({
		maxWriteFailures: 2,
		write: async () => {
			if (fail) throw new Error("nope");
		},
	});
	await h.recorder.sessionStart();
	assert.equal(h.errors.length, 1);
	fail = false;
	h.advance(1_000);
	await h.recorder.settled();
	assert.equal(h.errors.length, 1, "no new error");
	h.advance(1_000);
	await h.recorder.settled();
	assert.equal(h.errors.length, 1, "the recorder is still enabled");
});

test("flush waits for an in-flight write", async () => {
	let resolve: (() => void) | undefined;
	const gate = new Promise<void>((r) => {
		resolve = r;
	});
	let finished = false;
	const h = createHarness({
		write: async () => {
			await gate;
			finished = true;
		},
	});
	const pending = h.recorder.settled().then(() => {
		assert.equal(finished, true, "settled() resolves only after the write lands");
	});
	resolve?.();
	await pending;
});

test("waiting -> done drops the waiting stamp", async () => {
	// Regression (review finding): markDone used to leave waitingSince set, so a
	// finished run rendered as "done" with a stale wait time attached.
	const h = createHarness();
	await h.recorder.input();
	h.advance(1_000);
	await h.recorder.agentEnd();
	assert.equal(h.recorder.current().waitingSince, 2_000);
	h.advance(1_000);
	await h.recorder.settled();
	const state = h.recorder.current();
	assert.equal(state.phase, "done");
	assert.equal(state.waitingSince, undefined);
	assert.equal(state.activeSince, undefined);
});

test("tool -> done drops the trailing tool name", async () => {
	// Same finding: the parent used to render "done (bash)" for a run whose tool
	// had already returned.
	const h = createHarness();
	await h.recorder.toolStart("bash");
	h.advance(1_000);
	await h.recorder.settled();
	const state = h.recorder.current();
	assert.equal(state.phase, "done");
	assert.equal(state.toolName, undefined);
	assert.equal(state.toolActive, false);
	assert.equal(state.activeScope, undefined);
});

test("every snapshot the recorder produces satisfies the read-side invariants", async () => {
	// The validation rules are only worth trusting if our own writer cannot
	// violate them.
	const sequences: (() => Promise<void>)[] = [
		async () => {},
		(h) => h.recorder.sessionStart(),
		(h) => h.recorder.input(),
		(h) => h.recorder.providerRequest(),
		(h) => h.recorder.providerResponse(),
		(h) => h.recorder.messageUpdate(),
		(h) => h.recorder.toolStart("bash"),
		(h) => h.recorder.toolUpdate("read"),
		(h) => h.recorder.toolEnd("bash"),
		(h) => h.recorder.agentEnd(),
		(h) => h.recorder.input(),
		(h) => h.recorder.settled(),
		(h) => h.recorder.shutdown(),
	];

	for (const [index, step] of sequences.entries()) {
		const h = createHarness();
		await step(h);
		const state = h.recorder.current();
		const verdict = validateActivityState(state, "run-1");
		assert.equal(verdict.ok, true, `step ${index} produced an invalid snapshot: ${JSON.stringify(state)}`);
	}
});

test("validation rejects self-contradictory snapshots", async () => {
	const base: SubagentActivityState = {
		version: 1,
		runningChildId: "run-1",
		createdAt: 100,
		updatedAt: 200,
		sequence: 4,
		latestEvent: "tool_execution_start",
		phase: "active",
		agentActive: true,
		providerActive: false,
		toolActive: true,
		activeScope: "tool",
		activeSince: 150,
		toolName: "bash",
	};
	assert.equal(validateActivityState(base, "run-1").ok, true, "the coherent baseline passes");

	const incoherent: [string, Record<string, unknown>][] = [
		["active without a scope", { activeScope: undefined }],
		["active with waitingSince", { waitingSince: 150 }],
		["active with activeSince missing", { activeSince: undefined }],
		["done with work still flagged", { phase: "done", activeSince: undefined, activeScope: undefined, toolActive: true }],
		["done with a stale tool name", { phase: "done", activeSince: undefined, activeScope: undefined, toolActive: false, agentActive: false, toolName: "bash" }],
		["done keeping waitingSince", { phase: "done", activeSince: undefined, activeScope: undefined, toolActive: false, toolName: undefined, waitingSince: 150 }],
		["only active may carry activeSince", { phase: "waiting", activeSince: 150, agentActive: false, toolActive: false, activeScope: undefined, waitingSince: 200 }],
		["updatedAt before createdAt", { createdAt: 300, updatedAt: 200 }],
		["negative sequence", { sequence: -5 }],
	];
	for (const [label, patch] of incoherent) {
		const verdict = validateActivityState({ ...base, ...patch }, "run-1");
		assert.equal(verdict.ok, false, `${label} must be rejected`);
	}

	// waiting is the only phase allowed to carry waitingSince.
	assert.equal(
		validateActivityState(
			{
				...base,
				phase: "waiting",
				agentActive: false,
				toolActive: false,
				activeScope: undefined,
				activeSince: undefined,
				waitingSince: 200,
			},
			"run-1",
		).ok,
		true,
		"a coherent waiting snapshot still passes",
	);
});

test("validation rejects malformed snapshots and accepts a good one", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-activity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "activity.json");

	const good: SubagentActivityState = {
		version: 1,
		runningChildId: "run-1",
		createdAt: 1,
		updatedAt: 2,
		sequence: 4,
		latestEvent: "tool_execution_start",
		phase: "active",
		agentActive: true,
		providerActive: false,
		toolActive: true,
		activeScope: "tool",
		activeSince: 2,
		toolName: "bash",
	};

	assert.deepEqual(validateActivityState(good, "run-1"), { ok: true, activity: good });
	assert.equal(validateActivityState(null, "run-1").ok, false);
	assert.equal(validateActivityState([], "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, version: 2 }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, phase: "busy" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, activeScope: "vibes" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, latestEvent: "gossip" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, sequence: 1.5 }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, updatedAt: Number.NaN }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, toolActive: "yes" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, waitingSince: "soon" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, toolName: "two\nlines" }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, toolName: "x".repeat(201) }, "run-1").ok, false);
	assert.equal(validateActivityState({ ...good, runningChildId: "" }, "run-1").ok, false);

	const wrongId = validateActivityState(good, "other-run");
	assert.equal(wrongId.ok, false);
	assert.equal(wrongId.ok === false && wrongId.reason, "wrong-id");

	// Optional fields may be absent entirely, as long as the invariants hold.
	const minimal = { ...good, toolName: undefined };
	assert.equal(validateActivityState(minimal, "run-1").ok, true);

	await writeFile(file, JSON.stringify(good), "utf8");
	assert.equal((await readActivityFile(file, "run-1")).ok, true);
	assert.equal((await readActivityFile(file, "other-run")).ok, false);
	assert.equal((await readActivityFile(path.join(dir, "nope.json"), "run-1")).ok, false);

	await writeFile(file, "{ not json", "utf8");
	const broken = await readActivityFile(file, "run-1");
	assert.equal(broken.ok, false);
	assert.equal(broken.ok === false && broken.reason, "invalid");
});

test("getActivityFilePath places the snapshot beside result.json", () => {
	assert.equal(getActivityFilePath("/runs/abc"), path.join("/runs/abc", "activity.json"));
});

test("readActivityFile reports a directory as missing rather than throwing", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-activity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const result = await readActivityFile(dir, "run-1");
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.reason, "missing");
});

test("the recorder writes through the injected writer, not to disk itself", async (t) => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-activity-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const writes: string[] = [];
	const recorder = createActivityRecorder({
		filePath: path.join(dir, "activity.json"),
		childId: "run-1",
		write: async (filePath) => {
			writes.push(filePath);
		},
	});
	await recorder.sessionStart();
	assert.deepEqual(writes, [path.join(dir, "activity.json")]);
});