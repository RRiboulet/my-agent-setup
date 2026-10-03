// Unit tests for the status classifier (local patch 14).
//
// Risk covered: the classifier is fed by another process through a file, out of
// order and possibly stale, and it feeds the one surface the user is watching
// while several subagents run. A monotonicity slip makes a busy run look idle; a
// stall threshold that is too tight makes healthy long tools look hung; and an
// `interrupted` run that gets overwritten by an inference is worse than not
// having the feature, because the agent then trusts a status that is a guess.
//
// Everything here is pure: no TUI, no tmux, no child process.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	advanceStatusState,
	classifyStatus,
	createStatusState,
	DEFAULT_STALL_AFTER_MS,
	DEFAULT_TOOL_STALL_AFTER_MS,
	formatElapsedDuration,
	observeStatus,
	observationFromActivity,
	withRunStatus,
	type StatusObservation,
	type SubagentStatusState,
} from "../status.ts";

const T0 = 1_700_000_000_000;

function state(overrides: Partial<SubagentStatusState> = {}): SubagentStatusState {
	return { ...createStatusState({ runStatus: "running", startTimeMs: T0 }), ...overrides };
}

function present(overrides: Partial<Extract<StatusObservation, { snapshot: "present" }>> = {}): StatusObservation {
	return {
		snapshot: "present",
		updatedAt: T0,
		sequence: 1,
		phase: "active",
		...overrides,
	};
}

/** Fold one observation and advance, the way the parent's tick does. */
function step(current: SubagentStatusState, observation: StatusObservation, now: number) {
	const advanced = advanceStatusState(observeStatus(current, observation, now), now);
	return advanced;
}

test("formatElapsedDuration keeps seconds until the clock is coarse", () => {
	// The same format subagent_status uses. A widget that only changes once a
	// minute looks broken even when it is correct.
	assert.equal(formatElapsedDuration(-5_000), "0s", "a clock that runs backwards cannot produce a negative age");
	assert.equal(formatElapsedDuration(0), "0s");
	assert.equal(formatElapsedDuration(42_400), "42s");
	assert.equal(formatElapsedDuration(59_900), "1m 0s");
	assert.equal(formatElapsedDuration(200_000), "3m 20s");
	assert.equal(formatElapsedDuration(3_599_000), "59m 59s");
	assert.equal(formatElapsedDuration(3_600_000), "1h 0m");
	assert.equal(formatElapsedDuration(3_900_000), "1h 5m");
});

test("a run with no snapshot yet reads as starting", () => {
	const fresh = createStatusState({ runStatus: "running", startTimeMs: T0 });
	assert.equal(classifyStatus(fresh, T0).kind, "starting");
	// Only once the stall threshold passes does silence become a claim.
	assert.equal(classifyStatus(fresh, T0 + DEFAULT_STALL_AFTER_MS).kind, "stalled");
});

test("the phase in the snapshot decides active and waiting", () => {
	const now = T0 + 10_000;
	const active = step(state(), present({ updatedAt: now - 1_000, sequence: 5, phase: "active", activeScope: "tool", toolName: "bash" }), now);
	assert.equal(active.snapshot.kind, "active");
	assert.equal(active.snapshot.activeScope, "tool");
	assert.equal(active.snapshot.toolName, "bash");

	const waiting = step(
		active.nextState,
		present({ updatedAt: now - 1_000, sequence: 6, phase: "waiting", waitingSince: now - 4_000 }),
		now,
	);
	assert.equal(waiting.snapshot.kind, "waiting");
	assert.equal(waiting.snapshot.waitingDurationText, "4s");
	assert.equal(waiting.snapshot.activeSinceMs, null, "leaving the active phase clears its since-marker");
});

test("a settled-but-unread child reads as waiting, labelled done", () => {
	// The gap between the child settling and the parent seeing result.json is
	// seconds. Calling it active or stalled would be wrong; "done" is the truth.
	const now = T0 + 5_000;
	const settled = step(state(), present({ updatedAt: now, sequence: 2, phase: "done" }), now);
	assert.equal(settled.snapshot.kind, "waiting");
	assert.equal(settled.snapshot.statusLabel, "done");
});

test("order comes from the child's sequence, not from its clock", () => {
	// `sequence` is the child's write counter: monotonic by construction, so it
	// survives a replayed file. `updatedAt` is only a clock — the same child on
	// the same host cannot disagree with itself by more than a rounding error, so
	// ordering by it buys nothing and loses the replay protection. This is the
	// same rule index.ts applies to run.activity; if the two ever disagreed,
	// subagent_status and the widget would disagree in the same tick.
	const now = T0 + 60_000;
	const current = observeStatus(
		state(),
		present({ updatedAt: now, sequence: 10, phase: "waiting", waitingSince: now - 5_000 }),
		now,
	);

	const replay = observeStatus(current, present({ updatedAt: now - 30_000, sequence: 10, phase: "active" }), now);
	assert.equal(replay, current, "an identical sequence is a replay and changes nothing");

	const older = observeStatus(current, present({ updatedAt: now, sequence: 4, phase: "active" }), now);
	assert.equal(older, current, "a lower sequence is a torn or reordered read, not new activity");

	const newer = observeStatus(current, present({ updatedAt: now, sequence: 11, phase: "active" }), now + 1);
	assert.equal(newer.phase, "active");
	assert.equal(newer.lastActivitySequence, 11);
	assert.equal(newer.activeNow, true);
});

test("a broken snapshot keeps the last known phase until it stalls", () => {
	const now = T0 + 200_000;
	const healthy = observeStatus(state(), present({ updatedAt: now - 1_000, sequence: 3, phase: "active" }), now);

	// The file went missing. That is not the same as "the child is idle".
	const broken = observeStatus(healthy, { snapshot: "missing" }, now);
	assert.equal(broken.snapshotState, "missing");
	assert.equal(classifyStatus(broken, now + 1_000).kind, "active", "a run that was working stays working");

	// Long enough and the silence becomes a claim — with a duration for it.
	const stalled = classifyStatus(broken, now + DEFAULT_STALL_AFTER_MS);
	assert.equal(stalled.kind, "stalled");
	assert.equal(stalled.snapshotProblemText, "3m 0s");
	assert.equal(stalled.statusLabel, null, "a missing snapshot is normal early on, so it gets no label");
});

test("a snapshot that is valid but stale is a stall, which is the case that matters", () => {
	// The headline case: a child that is alive in tmux but wedged keeps writing
	// nothing while its last snapshot cheerfully says "active". Reading only the
	// file would report that run as working forever.
	const now = T0 + 5_000;
	const active = observeStatus(state(), present({ updatedAt: now, sequence: 3, phase: "active", activeScope: "provider" }), now);

	assert.equal(classifyStatus(active, now + DEFAULT_STALL_AFTER_MS - 1).kind, "active");
	const stalled = classifyStatus(active, now + DEFAULT_STALL_AFTER_MS);
	assert.equal(stalled.kind, "stalled");
	assert.equal(stalled.statusLabel, "no activity", "the reason distinguishes this from an unreadable file");
	assert.equal(stalled.snapshotState, "present", "the file is fine; it is the child that stopped");
	assert.equal(stalled.snapshotProblemText, null, "so there is no snapshot-problem clock to report");
	// The duration is the SILENCE, not the run's age: a run that worked for an hour
	// and then wedged has been quiet for seconds.
	assert.equal(stalled.quietDurationText, "3m 0s");
	assert.equal(stalled.elapsedText, "3m 5s", "which is a different number, and the row must not confuse them");
});

test("a silent TOOL is not a stalled child", () => {
	// Regression, and the mistake a status display must not make: pi fires
	// tool_execution_update only when a tool produces output, so `npm ci`, `make`
	// or a deliberate `sleep` are silent for minutes while working perfectly
	// well. Under the ordinary threshold the widget would report them hung.
	const now = T0 + 5_000;
	const running = observeStatus(
		state(),
		present({ updatedAt: now, sequence: 2, phase: "active", activeScope: "tool", toolName: "bash" }),
		now,
	);

	assert.equal(classifyStatus(running, now + DEFAULT_STALL_AFTER_MS).kind, "active", "a quiet tool is still working");
	assert.equal(classifyStatus(running, now + DEFAULT_TOOL_STALL_AFTER_MS - 1).kind, "active");
	const wedged = classifyStatus(running, now + DEFAULT_TOOL_STALL_AFTER_MS);
	assert.equal(wedged.kind, "stalled", "a tool silent for a quarter of an hour is genuinely stuck");
	assert.equal(wedged.statusLabel, "no activity");

	// The same silence outside a tool is judged by the ordinary threshold: a
	// streaming child that stops is a problem in three minutes, not fifteen.
	const streaming = observeStatus(
		state(),
		present({ updatedAt: now, sequence: 2, phase: "active", activeScope: "provider" }),
		now,
	);
	assert.equal(classifyStatus(streaming, now + DEFAULT_STALL_AFTER_MS).kind, "stalled");

	// The exemption follows the LAST KNOWN scope, so a tool that has finished and
	// left the run streaming is judged by the short threshold again.
	const resumed = observeStatus(streaming, present({ updatedAt: now + DEFAULT_STALL_AFTER_MS + 1, sequence: 3, phase: "active", activeScope: "tool" }), now + DEFAULT_STALL_AFTER_MS + 1);
	assert.equal(classifyStatus(resumed, now + DEFAULT_STALL_AFTER_MS + 1).kind, "active");
});

test("the tool threshold is configurable and independent of the ordinary one", () => {
	const state = createStatusState({ runStatus: "running", startTimeMs: T0, stallAfterMs: 1_000, toolStallAfterMs: 60_000 });
	const running = observeStatus(state, present({ updatedAt: T0, sequence: 1, phase: "active", activeScope: "tool", toolName: "bash" }), T0);
	assert.equal(classifyStatus(running, T0 + 30_000).kind, "active");
	assert.equal(classifyStatus(running, T0 + 60_000).kind, "stalled");
	// Both defaults are generous by design.
	assert.equal(DEFAULT_STALL_AFTER_MS, 180_000);
	assert.equal(DEFAULT_TOOL_STALL_AFTER_MS, 900_000);
});

test("the stall clock starts at the first problem, not the latest", () => {
	// A snapshot that keeps failing must not look like it just started failing,
	// or a long stall would never be reached.
	const start = T0;
	let current = observeStatus(state(), present({ updatedAt: start, sequence: 1, phase: "active" }), start);
	for (let tick = 1; tick <= 10; tick++) {
		const now = start + tick * 10_000;
		current = observeStatus(current, { snapshot: "invalid", snapshotError: "not valid JSON" }, now);
		assert.equal(current.snapshotProblemSinceMs, start + 10_000, `tick ${tick} must not restart the clock`);
	}
	assert.equal(classifyStatus(current, start + 10_000 + DEFAULT_STALL_AFTER_MS).kind, "stalled");
	assert.equal(classifyStatus(current, start + 10_000 + DEFAULT_STALL_AFTER_MS - 1).kind, "active");
});

test("a wrong-id snapshot is labelled, because it means the wrong child", () => {
	const broke = T0 + 10_000;
	let current = observeStatus(state(), present({ updatedAt: T0, sequence: 1, phase: "active" }), T0);
	current = observeStatus(current, { snapshot: "wrong-id" }, broke);
	// Not stalled yet: the problem clock starts now, and a run that has been
	// healthy a moment ago keeps its last known phase.
	assert.equal(classifyStatus(current, broke).kind, "active");
	assert.equal(classifyStatus(current, broke).statusLabel, "wrong activity id");
	assert.equal(classifyStatus(current, broke + DEFAULT_STALL_AFTER_MS).kind, "stalled");
});

test("recovery clears the stall and reports the transition once", () => {
	const stallAfterMs = 60_000;
	const start = T0;
	let current = observeStatus(
		createStatusState({ runStatus: "running", startTimeMs: start, stallAfterMs }),
		present({ updatedAt: start, sequence: 1, phase: "active" }),
		start,
	);

	const broke = observeStatus(current, { snapshot: "missing" }, start + 10_000);
	const stalled = advanceStatusState(broke, start + 10_000 + stallAfterMs);
	assert.equal(stalled.snapshot.kind, "stalled");
	assert.equal(stalled.transition, "stalled");

	// Still stalled on the next tick: no repeated transition.
	const again = advanceStatusState(stalled.nextState, start + 10_000 + stallAfterMs + 1_000);
	assert.equal(again.snapshot.kind, "stalled");
	assert.equal(again.transition, null, "a transition is an edge, not a level");

	// The snapshot comes back.
	const recovered = observeStatus(stalled.nextState, present({ updatedAt: start + 90_000, sequence: 9, phase: "active" }), start + 90_000);
	const back = advanceStatusState(recovered, start + 90_000);
	assert.equal(back.snapshot.kind, "active");
	assert.equal(back.transition, "recovered");
	assert.equal(classifyStatus(back.nextState, start + 90_100).kind, "active", "and it stays recovered");
});

test("a recovering run does not claim to have been active the whole time", () => {
	// activeSinceMs must come from the snapshot, not be carried across the outage.
	const start = T0;
	let current = observeStatus(state(), present({ updatedAt: start, sequence: 1, phase: "active" }), start);
	current = observeStatus(current, { snapshot: "missing" }, start + 1_000);
	const now = start + 30_000;
	current = observeStatus(current, present({ updatedAt: now, sequence: 4, phase: "active", activeSince: now }), now);
	const snapshot = classifyStatus(current, now + 3_000);
	assert.equal(snapshot.activeDurationText, "3s");
});

test("interrupted is authoritative and no snapshot can overwrite it", () => {
	const now = T0 + 30_000;
	let current = withRunStatus(state(), "interrupted");
	// Even a fresh, healthy, ACTIVELY WORKING snapshot must not flip the kind.
	current = observeStatus(current, present({ updatedAt: now, sequence: 12, phase: "active", activeScope: "provider" }), now);
	const snapshot = classifyStatus(current, now);
	assert.equal(snapshot.kind, "interrupted");
	assert.equal(snapshot.statusLabel, null);
	assert.equal(snapshot.elapsedText, "30s", "the elapsed clock keeps running: the child is still there");

	// Becoming interrupted stops the active clock, so a stall cannot be inferred
	// from a child that is deliberately sitting at its prompt.
	const interrupted = withRunStatus(state(), "interrupted");
	assert.equal(interrupted.activeNow, false);
	assert.equal(interrupted.activeSinceMs, null);
	assert.equal(interrupted.currentKind, "interrupted");

	// And the snapshot the child writes as it winds down clears it for good.
	const afterInterrupt = observeStatus(interrupted, present({ updatedAt: now, sequence: 13, phase: "waiting" }), now);
	assert.equal(afterInterrupt.activeNow, false);
	assert.equal(afterInterrupt.activeSinceMs, null);
	assert.equal(classifyStatus(afterInterrupt, now + DEFAULT_STALL_AFTER_MS).kind, "interrupted", "still never a stall");
});

test("withRunStatus keeps history when nothing about the kind changed", () => {
	const now = T0 + 5_000;
	const active = observeStatus(state(), present({ updatedAt: now, sequence: 2, phase: "active", activeScope: "tool" }), now);
	const same = withRunStatus(active, "running");
	assert.equal(same, active, "an unchanged status returns the same object");

	const queued = withRunStatus(active, "queued");
	assert.equal(queued.runStatus, "queued");
	assert.equal(queued.activeScope, "tool", "queued does not erase what the child was doing");
	// A run is never demoted back to queued while it holds a child, so this is
	// unreachable in practice; the assertion is that the status is honoured
	// rather than overridden by the leftover activity.
	assert.equal(classifyStatus(queued, now).kind, "queued");
});

test("the stall threshold is the extension's, not the reference's 60s", () => {
	// A legitimately silent long `bash` must not be called stalled, so the
	// default is generous and configurable rather than hard-coded.
	assert.equal(DEFAULT_STALL_AFTER_MS, 180_000);
	const eager = createStatusState({ runStatus: "running", startTimeMs: T0, stallAfterMs: 60_000 });
	assert.equal(classifyStatus(eager, T0 + 60_000).kind, "stalled");
	assert.equal(classifyStatus(createStatusState({ runStatus: "running", startTimeMs: T0 }), T0 + 60_000).kind, "starting");
});

test("a queued run waits for a slot and never stalls, however long it takes", () => {
	// Regression: a queued run has no watcher and therefore no snapshot by
	// definition, so a stall rule that only watches the snapshot called it stalled
	// after the threshold — inventing a hung child for something that is merely
	// waiting its turn, and contradicting subagent_status, which says "queued".
	const queued = createStatusState({ runStatus: "queued", startTimeMs: T0 });
	for (const waited of [60_000, DEFAULT_STALL_AFTER_MS, 10 * DEFAULT_STALL_AFTER_MS]) {
		assert.equal(classifyStatus(queued, T0 + waited).kind, "queued", `after ${waited}ms`);
	}
	// Nor once it has somehow seen a snapshot (a stale one from an earlier life).
	const stale = observeStatus(queued, present({ updatedAt: T0, sequence: 1, phase: "active" }), T0);
	assert.equal(classifyStatus(stale, T0 + 10 * DEFAULT_STALL_AFTER_MS).kind, "queued");
});

test("observationFromActivity carries only what it was given", () => {
	const observation = observationFromActivity({ phase: "waiting", updatedAt: T0, sequence: 7 });
	assert.deepEqual(observation, { snapshot: "present", updatedAt: T0, sequence: 7, phase: "waiting" });

	const withScope = observationFromActivity({ phase: "active", updatedAt: T0, sequence: 8, scope: "tool", toolName: "read" });
	assert.equal(withScope.snapshot === "present" && withScope.activeScope, "tool");
	assert.equal(withScope.snapshot === "present" && withScope.toolName, "read");
});