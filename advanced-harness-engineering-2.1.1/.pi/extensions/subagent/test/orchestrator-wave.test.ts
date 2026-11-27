// TDD tests for `.pi/extensions/orchestrator/wave.ts` and its integration with
// `gate.ts`, `config.ts`, and `compact-snapshot.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	WAVE_ENTRY_TYPE,
	applyWaveAction,
	canRunGitCommit,
	evaluateWaveGate,
	formatWaveSummary,
	hasReadyToCommitTicket,
	isGitCommitCommand,
	planWaveDispatch,
	reconstructWaveState,
	type WaveLadder,
	type WaveState,
	type WaveTicketGraph,
} from "../../orchestrator/wave.ts";
import { DEFAULT_LADDER } from "../../orchestrator/wave-ladder.mjs";
import { evaluateGate } from "../../orchestrator/gate.ts";
import { normalizeGateConfig } from "../../orchestrator/config.ts";
import { buildCompactSnapshot } from "../../orchestrator/compact-snapshot.ts";

const LADDER = DEFAULT_LADDER as unknown as WaveLadder;

function makeGraph(
	tickets: Array<{
		id: string;
		status?: string;
		blockedBy?: string[];
		tierOverride?: number;
		title?: string;
	}>,
	issues: WaveTicketGraph["issues"] = [],
): WaveTicketGraph {
	const nodes = tickets.map((t) => ({
		id: t.id,
		file: `/repo/docs/tickets/feat/${t.id}-task.md`,
		title: t.title ?? `Ticket ${t.id}`,
		status: t.status ?? "ready",
		blockedBy: t.blockedBy ?? [],
		...(t.tierOverride !== undefined ? { tierOverride: t.tierOverride } : {}),
	}));
	return {
		dir: "/repo/docs/tickets/feat",
		tickets: nodes,
		byId: new Map(nodes.map((n) => [n.id, n])),
		issues,
	};
}

// --- Start & Initialization ------------------------------------------------

test("start initializes ticket map from graph, honoring done/blocked and blocking issues", () => {
	// Refuses when graph has blocking issues (cycle / dangling blocker)
	const badGraph = makeGraph(
		[{ id: "01", blockedBy: ["09"] }],
		[{ code: "dangling-blocker", severity: "error", message: "missing 09" }],
	);
	const refused = applyWaveAction(
		null,
		{ type: "start", folder: "docs/tickets/feat" },
		{ graph: badGraph },
		LADDER,
		100,
	);
	assert.equal(refused.ok, false);
	assert.match(refused.error ?? "", /missing 09|blocking/i);

	// Starts cleanly with mixed statuses and preserves startHeadSha
	const graph = makeGraph([
		{ id: "01", status: "done" },
		{ id: "02", status: "ready", blockedBy: ["01"] },
		{ id: "03", status: "blocked" },
	]);
	const started = applyWaveAction(
		null,
		{ type: "start", folder: "docs/tickets/feat", ladderSource: "file", startHeadSha: "base1234" },
		{ graph },
		LADDER,
		100,
	);
	assert.equal(started.ok, true);
	assert.ok(started.state);
	assert.equal(started.state.status, "active");
	assert.equal(started.state.startHeadSha, "base1234");
	assert.equal(started.state.tickets["01"]?.phase, "done");
	assert.equal(started.state.tickets["02"]?.phase, "pending");
	assert.equal(started.state.tickets["03"]?.phase, "blocked");
	assert.equal(started.state.startedAt, 100);
	assert.equal(started.state.eventCount, 1);
	assert.deepEqual(reconstructWaveState([{ type: "custom", customType: WAVE_ENTRY_TYPE, data: started.entry }]), started.state);

	// Refuses starting a second active wave
	const second = applyWaveAction(
		started.state,
		{ type: "start", folder: "docs/tickets/other" },
		{ graph },
		LADDER,
		101,
	);
	assert.equal(second.ok, false);
	assert.match(second.error ?? "", /active wave/i);

	// Starts as completed immediately if all tickets are already done or blocked
	const doneGraph = makeGraph([
		{ id: "01", status: "done" },
		{ id: "02", status: "blocked" },
	]);
	const alreadyDone = applyWaveAction(
		null,
		{ type: "start", folder: "docs/tickets/done" },
		{ graph: doneGraph },
		LADDER,
		200,
	);
	assert.equal(alreadyDone.ok, true);
	assert.equal(alreadyDone.state?.status, "completed");
});

// --- Happy Path: Tier 1 (with reviewer gate) & Tier 2 (skips reviewer) -----

test("Tier 1 ticket passes through triage -> implement -> review -> verify -> commit -> done", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready", blockedBy: ["01"] },
	]);
	let res = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10);
	assert.equal(res.ok, true);
	let state = res.state!;

	// Triage 01 as Tier 1
	res = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1, reason: "small" }, { graph }, LADDER, 20);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.tier, 1);
	assert.equal(state.tickets["01"]?.tierSource, "triage");

	// Start implement 01 -> returns Tier 1 model & emits set-ticket-status("in-progress")
	res = applyWaveAction(state, { type: "start_implement", ticketId: "01", runId: "run-1" }, { graph }, LADDER, 30);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "implementing");
	assert.equal(state.tickets["01"]?.activeRunId, "run-1");
	assert.deepEqual(res.dispatch, { provider: "opencode-go", model: "hy4-flash-free", thinking: "max" });
	assert.deepEqual(res.sideEffects, [
		{ kind: "set-ticket-status", file: "/repo/docs/tickets/feat/01-task.md", status: "in-progress" },
	]);

	// Implement completed -> Tier 1 <= throughTier(1), so goes to reviewing with inherited reviewer pin
	res = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, LADDER, 40);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "reviewing");
	assert.deepEqual(res.nextPin, { inheritModel: true, thinking: "high" });

	// Mechanically impossible to skip reviewer gate!
	const skipVerify = applyWaveAction(
		state,
		{ type: "record_verify", ticketId: "01", verdict: "pass", evidence: "all green" },
		{ graph },
		LADDER,
		45,
	);
	assert.equal(skipVerify.ok, false);
	assert.match(skipVerify.error ?? "", /reviewing/);

	// Record review pass -> moves to verifying with verifier pin
	res = applyWaveAction(state, { type: "record_review", ticketId: "01", verdict: "pass" }, { graph }, LADDER, 50);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "verifying");
	assert.deepEqual(res.nextPin, { provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "high" });

	// Cannot git commit while in verifying
	assert.equal(canRunGitCommit(state).allowed, false);

	// Record verify pass -> ready_to_commit
	res = applyWaveAction(
		state,
		{ type: "record_verify", ticketId: "01", verdict: "pass", evidence: "fail 0" },
		{ graph },
		LADDER,
		60,
	);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "ready_to_commit");
	assert.equal(state.tickets["01"]?.verifierEvidence, "fail 0");
	assert.equal(canRunGitCommit(state).allowed, true);

	// Empty commitSha is refused
	const emptySha = applyWaveAction(state, { type: "record_commit", ticketId: "01", commitSha: "   " }, { graph }, LADDER, 65);
	assert.equal(emptySha.ok, false);

	// Record commit -> done, emits set-ticket-status("done"), wave still active because 02 pending
	res = applyWaveAction(state, { type: "record_commit", ticketId: "01", commitSha: "abc1234" }, { graph }, LADDER, 70);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "done");
	assert.equal(state.tickets["01"]?.commitSha, "abc1234");
	assert.equal(state.status, "active");
	assert.deepEqual(res.sideEffects, [
		{ kind: "set-ticket-status", file: "/repo/docs/tickets/feat/01-task.md", status: "done" },
	]);
});

test("Tier 2 ticket skips reviewer gate directly to verifying and auto-completes wave on last commit", () => {
	const graph = makeGraph([{ id: "01", status: "ready", tierOverride: 2 }]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;

	// start_implement directly from pending because tier-override is valid on disk
	let res = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 20);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.tier, 2);
	assert.equal(state.tickets["01"]?.tierSource, "tier-override");
	assert.deepEqual(res.dispatch, { provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "medium" });

	// implement_result completed at Tier 2 (> throughTier 1) -> verifying directly
	res = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, LADDER, 30);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "verifying");
	assert.deepEqual(res.nextPin, { provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "high" });

	res = applyWaveAction(state, { type: "record_verify", ticketId: "01", verdict: "pass" }, { graph }, LADDER, 40);
	state = res.state!;
	res = applyWaveAction(state, { type: "record_commit", ticketId: "01", commitSha: "def5678" }, { graph }, LADDER, 50);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "done");
	assert.equal(state.status, "completed");
});

// --- Dependencies & Illegal Transitions ------------------------------------

test("start_implement refuses pending ticket without tier-override and refuses unmet blockedBy", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready", blockedBy: ["01"], tierOverride: 1 },
	]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;

	// Pending 01 has no tier-override
	const noTriage = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 20);
	assert.equal(noTriage.ok, false);
	assert.match(noTriage.error ?? "", /triaged/);

	// 02 has tierOverride, but blocker 01 is not done
	const blockedDep = applyWaveAction(state, { type: "start_implement", ticketId: "02" }, { graph }, LADDER, 25);
	assert.equal(blockedDep.ok, false);
	assert.match(blockedDep.error ?? "", /01/);

	// If blocker 01 is only marked done on disk, 02 remains blocked (branch state is single owner)
	const updatedGraph = makeGraph([
		{ id: "01", status: "done" },
		{ id: "02", status: "ready", blockedBy: ["01"], tierOverride: 1 },
	]);
	const stillBlocked = applyWaveAction(state, { type: "start_implement", ticketId: "02" }, { graph: updatedGraph }, LADDER, 30);
	assert.equal(stillBlocked.ok, false);
	assert.match(stillBlocked.error ?? "", /01/);

	// Once 01 is marked done in wave state via record_commit, 02 becomes dispatchable
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 2 }, { graph }, LADDER, 31).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 32).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, LADDER, 33).state!;
	state = applyWaveAction(state, { type: "record_verify", ticketId: "01", verdict: "pass" }, { graph }, LADDER, 34).state!;
	state = applyWaveAction(state, { type: "record_commit", ticketId: "01", commitSha: "sha-01" }, { graph }, LADDER, 35).state!;

	const unblocked = applyWaveAction(state, { type: "start_implement", ticketId: "02" }, { graph }, LADDER, 36);
	assert.equal(unblocked.ok, true);
});

test("record_commit rejects startHeadSha and duplicate SHAs across tickets", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready", tierOverride: 2 },
		{ id: "02", status: "ready", tierOverride: 2 },
	]);
	let state = applyWaveAction(
		null,
		{ type: "start", folder: "docs/tickets/feat", startHeadSha: "base-head-sha" },
		{ graph },
		LADDER,
		10,
	).state!;

	for (const id of ["01", "02"]) {
		state = applyWaveAction(state, { type: "start_implement", ticketId: id }, { graph }, LADDER, 20).state!;
		state = applyWaveAction(state, { type: "implement_result", ticketId: id, outcome: "completed" }, { graph }, LADDER, 30).state!;
		state = applyWaveAction(state, { type: "record_verify", ticketId: id, verdict: "pass" }, { graph }, LADDER, 40).state!;
	}

	const baselineReject = applyWaveAction(
		state,
		{ type: "record_commit", ticketId: "01", commitSha: "base-head-sha" },
		{ graph },
		LADDER,
		50,
	);
	assert.equal(baselineReject.ok, false);
	assert.match(baselineReject.error ?? "", /baseline|startHeadSha|pre-wave|new commit/i);

	const commit1 = applyWaveAction(state, { type: "record_commit", ticketId: "01", commitSha: "new-sha-1" }, { graph }, LADDER, 60);
	assert.equal(commit1.ok, true);
	state = commit1.state!;

	const dupReject = applyWaveAction(state, { type: "record_commit", ticketId: "02", commitSha: "new-sha-1" }, { graph }, LADDER, 70);
	assert.equal(dupReject.ok, false);
	assert.match(dupReject.error ?? "", /01|already recorded|unique/i);
});

test("triage allows unstarted re-triage but refuses after start_implement, crash retry, or escalation", () => {
	const graph = makeGraph([{ id: "01", status: "ready" }]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;

	// Initial triage and unstarted re-triage both succeed
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1, reason: "initial" }, { graph }, LADDER, 20).state!;
	const retriaged = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 2, reason: "adjusted" }, { graph }, LADDER, 25);
	assert.equal(retriaged.ok, true);
	state = retriaged.state!;
	assert.equal(state.tickets["01"]?.tier, 2);

	// Reset to T1 and run start_implement + first crash (crashesAtTier = 1)
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 26).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 30).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed", error: "oom" }, { graph }, LADDER, 40).state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.crashesAtTier, 1);

	const afterCrash = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 45);
	assert.equal(afterCrash.ok, false);
	assert.match(afterCrash.error ?? "", /attempted|escalated|cannot be/i);

	// Escalate to T2 (tierSource: "escalation", crashesAtTier: 0) -> still refused
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 50).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed", error: "oom2" }, { graph }, LADDER, 60).state!;
	assert.equal(state.tickets["01"]?.tierSource, "escalation");
	assert.equal(state.tickets["01"]?.crashesAtTier, 0);

	const afterEscalation = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 65);
	assert.equal(afterEscalation.ok, false);
	assert.match(afterEscalation.error ?? "", /attempted|escalated|cannot be/i);

	// Synthetic triaged ticket with start_implement in history (even with crashesAtTier=0, tierSource="triage") -> refused
	const syntheticState: WaveState = {
		...state,
		tickets: {
			"01": {
				id: "01",
				file: "/repo/docs/tickets/feat/01-task.md",
				title: "Ticket 01",
				phase: "triaged",
				tier: 1,
				tierSource: "triage",
				crashesAtTier: 0,
				history: [{ at: 30, action: "start_implement", from: "triaged", to: "implementing", tier: 1 }],
			},
		},
	};
	const afterStartImpl = applyWaveAction(syntheticState, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 70);
	assert.equal(afterStartImpl.ok, false);
});

test("reconstructWaveState derives completed status when all tickets settle even without waveCompleted flag", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready", tierOverride: 2 },
		{ id: "02", status: "ready", tierOverride: 2 },
	]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;
	const branch: Array<Record<string, unknown>> = [
		{
			type: "custom",
			customType: WAVE_ENTRY_TYPE,
			data: {
				version: 1,
				type: "start",
				at: 10,
				folder: "docs/tickets/feat",
				ladderSource: "file",
				status: "active",
				tickets: Object.values(state.tickets).map((t) => ({ id: t.id, file: t.file, title: t.title, phase: t.phase })),
			},
		},
		{
			type: "custom",
			customType: WAVE_ENTRY_TYPE,
			data: { version: 1, type: "record_commit", at: 20, ticketId: "01", commitSha: "sha-1", waveCompleted: false },
		},
		{
			type: "custom",
			customType: WAVE_ENTRY_TYPE,
			data: { version: 1, type: "record_commit", at: 30, ticketId: "02", commitSha: "sha-2", waveCompleted: false },
		},
	];
	const reconstructed = reconstructWaveState(branch);
	assert.equal(reconstructed?.status, "completed");
	assert.equal(canRunGitCommit(reconstructed!).allowed, true);
});

// --- Failure Ladder: Crashes, Review Escalation, Verify Fail, Top Tier Block ---

test("failure ladder: first crash retries same tier, second crash escalates, top tier crash blocks", () => {
	const graph = makeGraph([{ id: "01", status: "ready" }]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 20).state!;

	// First crash at T1 -> retry at T1 (crashesAtTier = 1)
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 30).state!;
	let res = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed", error: "oom" }, { graph }, LADDER, 40);
	assert.equal(res.ok, true);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.tier, 1);
	assert.equal(state.tickets["01"]?.crashesAtTier, 1);
	assert.deepEqual(res.sideEffects, []);

	// Second crash at T1 -> escalate to T2 (crashesAtTier = 0)
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 50).state!;
	res = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed" }, { graph }, LADDER, 60);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.tier, 2);
	assert.equal(state.tickets["01"]?.crashesAtTier, 0);

	// Reviewer escalate? Let's test verifier fail at T2 -> escalates to T3
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 70).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, LADDER, 80).state!;
	assert.equal(state.tickets["01"]?.phase, "verifying");
	res = applyWaveAction(state, { type: "record_verify", ticketId: "01", verdict: "fail", reason: "tests failed" }, { graph }, LADDER, 90);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.tier, 3);
	assert.equal(state.tickets["01"]?.crashesAtTier, 0);

	// Tier 3 dispatches the Mistral GLM Flash escalation model.
	const tier3Start = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 100);
	assert.equal(tier3Start.ok, true);
	assert.deepEqual(tier3Start.dispatch, { provider: "mistral", model: "zai-glm-5-3-flash", thinking: "high" });
	state = tier3Start.state!;

	// Crash twice at T3 -> blocked with explicit reason & side effect
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed" }, { graph }, LADDER, 110).state!;
	assert.equal(state.tickets["01"]?.tier, 3);
	assert.equal(state.tickets["01"]?.crashesAtTier, 1);

	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 120).state!;
	res = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "crashed", error: "timeout" }, { graph }, LADDER, 130);
	state = res.state!;
	assert.equal(state.tickets["01"]?.phase, "blocked");
	assert.ok(state.tickets["01"]?.blockedReason);
	assert.equal(res.sideEffects[0]?.kind, "set-ticket-status");
	assert.equal(res.sideEffects[0]?.status, "blocked");
	assert.equal(state.status, "completed");
});

test("record_review escalate promotes T1 -> T2 and blocks if at top tier", () => {
	const graph = makeGraph([{ id: "01", status: "ready" }]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 20).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01" }, { graph }, LADDER, 30).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, LADDER, 40).state!;
	assert.equal(state.tickets["01"]?.phase, "reviewing");

	const escalated = applyWaveAction(
		state,
		{ type: "record_review", ticketId: "01", verdict: "escalate", reason: "needs stronger model" },
		{ graph },
		LADDER,
		50,
	);
	assert.equal(escalated.ok, true);
	assert.equal(escalated.state?.tickets["01"]?.phase, "triaged");
	assert.equal(escalated.state?.tickets["01"]?.tier, 2);

	// Top-tier reviewer gate escalation -> blocked
	const strictLadder: WaveLadder = { ...structuredClone(LADDER), gates: { reviewer: { throughTier: 3 } } };
	let topState = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, strictLadder, 10).state!;
	topState = applyWaveAction(topState, { type: "triage", ticketId: "01", tier: 3 }, { graph }, strictLadder, 20).state!;
	topState = applyWaveAction(topState, { type: "start_implement", ticketId: "01" }, { graph }, strictLadder, 30).state!;
	topState = applyWaveAction(topState, { type: "implement_result", ticketId: "01", outcome: "completed" }, { graph }, strictLadder, 40).state!;
	const topEsc = applyWaveAction(
		topState,
		{ type: "record_review", ticketId: "01", verdict: "escalate", reason: "still broken" },
		{ graph },
		strictLadder,
		50,
	);
	assert.equal(topEsc.state?.tickets["01"]?.phase, "blocked");
	assert.equal(topEsc.sideEffects[0]?.status, "blocked");
});

// --- Abort & Branch Reconstruction -----------------------------------------

test("reconstructWaveState replays entries and skips malformed entries safely", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready", blockedBy: ["01"] },
	]);
	const e1 = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat", ladderSource: "env" }, { graph }, LADDER, 100);
	const e2 = applyWaveAction(e1.state!, { type: "triage", ticketId: "01", tier: 1, reason: "tiny" }, { graph }, LADDER, 200);
	const e3 = applyWaveAction(e2.state!, { type: "start_implement", ticketId: "01", runId: "r1" }, { graph }, LADDER, 300);

	const branch = [
		{ type: "message", message: { role: "user", content: "go" } },
		{ type: "custom", customType: "other-entry", data: { foo: 1 } },
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: null },
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: { type: "unknown-action" } },
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: { version: 1, type: "triage", ticketId: "01" } }, // before start -> skipped
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: e1.entry },
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: e2.entry },
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: { version: 1, type: "triage", ticketId: "missing" } }, // unknown ticket -> skipped
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: e3.entry },
	];

	const reconstructed = reconstructWaveState(branch);
	assert.deepEqual(reconstructed, e3.state);

	// Abort also reconstructs cleanly
	const e4 = applyWaveAction(e3.state!, { type: "abort" }, { graph }, LADDER, 400);
	assert.equal(e4.ok, true);
	assert.equal(e4.state?.status, "aborted");
	const abortedReconstructed = reconstructWaveState([
		...branch,
		{ type: "custom", customType: WAVE_ENTRY_TYPE, data: e4.entry },
	]);
	assert.deepEqual(abortedReconstructed, e4.state);
	assert.equal(evaluateWaveGate(abortedReconstructed), null);
	assert.equal(canRunGitCommit(abortedReconstructed).allowed, true);
});

// --- planWaveDispatch ------------------------------------------------------

test("planWaveDispatch uses state.tickets as single owner and warns on mid-wave disk additions or mismatches", () => {
	const initialGraph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready", blockedBy: ["01"] },
	]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph: initialGraph }, LADDER, 10).state!;
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph: initialGraph }, LADDER, 20).state!;

	// Disk now has 01 manually marked done (mismatch with branch triaged), 02 blocked on 01, 03 newly added on disk, 04 already done on disk
	const liveGraph = makeGraph([
		{ id: "01", status: "done" },
		{ id: "02", status: "ready", blockedBy: ["01"] },
		{ id: "03", status: "ready" },
		{ id: "04", status: "done" },
	]);

	const plan = planWaveDispatch(state, liveGraph, LADDER);
	assert.equal(plan.blockingErrors.length, 0);
	assert.deepEqual(
		plan.ready.map((r) => [r.id, r.action]),
		[["01", "start_implement"]],
	);
	assert.equal(plan.ready[0]?.dispatch?.model, "hy4-flash-free");
	assert.deepEqual(
		plan.waiting.map((w) => w.id),
		["02"],
	);
	assert.deepEqual(
		plan.nextActions.map((a) => [a.ticketId, a.action]),
		[["01", "start_implement"]],
	);
	assert.match(plan.summary, /1 ready, 0 in-flight, 1 waiting, 0 done, 0 blocked/);
	assert.ok(
		plan.warnings.some((w) => /03/.test(w.message)),
		"warns about newly added disk ticket 03 outside active wave",
	);
	assert.ok(
		plan.warnings.some((w) => /04/.test(w.message)),
		"warns about newly added disk ticket 04 outside active wave",
	);
	assert.ok(
		plan.warnings.some((w) => /01/.test(w.message) && /disagree|mismatch|done/i.test(w.message)),
		"warns about disk status disagreeing with branch phase for 01",
	);
});

test("planWaveDispatch emits zero disk-status-mismatch warnings for retried/escalated triaged tickets already in-progress on disk", () => {
	const initialGraph = makeGraph([{ id: "01", status: "ready" }]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph: initialGraph }, LADDER, 10).state!;
	state = applyWaveAction(state, { type: "triage", ticketId: "01", tier: 1 }, { graph: initialGraph }, LADDER, 20).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01", runId: "run-1" }, { graph: initialGraph }, LADDER, 30).state!;

	// Disk was updated to in-progress by start_implement; implementer crashes once -> phase returns to "triaged"
	state = applyWaveAction(
		state,
		{ type: "implement_result", ticketId: "01", outcome: "crashed", error: "timeout" },
		{ graph: initialGraph },
		LADDER,
		40,
	).state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.crashesAtTier, 1);

	const inProgressGraph = makeGraph([{ id: "01", status: "in-progress" }]);
	const retryPlan = planWaveDispatch(state, inProgressGraph, LADDER);
	assert.equal(
		retryPlan.warnings.filter((w) => w.code === "disk-status-mismatch").length,
		0,
		"retried triaged ticket with in-progress disk status must not trigger disk-status-mismatch",
	);

	// Second start_implement + crash -> escalated to tier 2, phase "triaged", crashesAtTier reset to 0
	state = applyWaveAction(state, { type: "start_implement", ticketId: "01", runId: "run-2" }, { graph: inProgressGraph }, LADDER, 50).state!;
	state = applyWaveAction(
		state,
		{ type: "implement_result", ticketId: "01", outcome: "crashed", error: "oom" },
		{ graph: inProgressGraph },
		LADDER,
		60,
	).state!;
	assert.equal(state.tickets["01"]?.phase, "triaged");
	assert.equal(state.tickets["01"]?.tierSource, "escalation");
	assert.equal(state.tickets["01"]?.crashesAtTier, 0);

	const escalatedPlan = planWaveDispatch(state, inProgressGraph, LADDER);
	assert.equal(
		escalatedPlan.warnings.filter((w) => w.code === "disk-status-mismatch").length,
		0,
		"escalated triaged ticket with in-progress disk status must not trigger disk-status-mismatch",
	);
});

// --- isGitCommitCommand & canRunGitCommit ----------------------------------

test("isGitCommitCommand detects actual git commit invocations and avoids false positives", () => {
	// True cases
	assert.equal(isGitCommitCommand("git commit -m 'feat: x'"), true);
	assert.equal(isGitCommitCommand("git -C repo commit -m 'msg'"), true);
	assert.equal(isGitCommitCommand("git --git-dir=/tmp/g --work-tree=/tmp/w commit"), true);
	assert.equal(isGitCommitCommand("git -c user.name=Bot commit --amend"), true);
	assert.equal(isGitCommitCommand("env VAR=1 git commit -m 'x'"), true);
	assert.equal(isGitCommitCommand("FOO=bar env -u BAZ git commit"), true);
	assert.equal(isGitCommitCommand('env "FOO=bar" git commit -m foo'), true);
	assert.equal(isGitCommitCommand('GIT_AUTHOR_NAME="Bot" git commit -m "msg"'), true);
	assert.equal(isGitCommitCommand("GIT_COMMITTER_DATE='2026-01-01' git commit -m \"msg\""), true);
	assert.equal(isGitCommitCommand("FOO=$'bar' git commit -m \"msg\""), true);
	assert.equal(isGitCommitCommand("npm test && git commit -m 'ok'"), true);
	assert.equal(isGitCommitCommand("git add -A; git commit -m 'ok'"), true);
	assert.equal(isGitCommitCommand("echo running\ngit commit -m 'multiline'"), true);
	assert.equal(isGitCommitCommand("/usr/bin/git commit -m 'abs'"), true);

	// ANSI-C quoting, command substitution, backticks, compound/keyword/redirection/nested shells
	assert.equal(isGitCommitCommand("echo $'a\\''; git commit -m foo"), true);
	assert.equal(isGitCommitCommand("echo $'a\\' && git commit'"), false);
	assert.equal(isGitCommitCommand('echo "$(git commit -m foo)"'), true);
	assert.equal(isGitCommitCommand("`git commit -m foo`"), true);
	assert.equal(isGitCommitCommand('echo "`git commit -m foo`"'), true);
	assert.equal(isGitCommitCommand("{ git commit -m foo; }"), true);
	assert.equal(isGitCommitCommand("! git commit -m foo"), true);
	assert.equal(isGitCommitCommand("if git commit -m foo; then true; fi"), true);
	assert.equal(isGitCommitCommand("exec git commit -m foo"), true);
	assert.equal(isGitCommitCommand("time git commit -m foo"), true);
	assert.equal(isGitCommitCommand("nohup git commit -m foo"), true);
	assert.equal(isGitCommitCommand("command git commit -m foo"), true);
	assert.equal(isGitCommitCommand(">/dev/null git commit -m foo"), true);
	assert.equal(isGitCommitCommand("sh -c 'git commit -m foo'"), true);
	assert.equal(isGitCommitCommand('bash -c "git commit -m foo"'), true);
	assert.equal(isGitCommitCommand("zsh -c 'git commit -m foo'"), true);
	assert.equal(isGitCommitCommand("\\2>/dev/null; FOO=bar git commit -m x"), true);

	// False cases
	assert.equal(isGitCommitCommand("git status"), false);
	assert.equal(isGitCommitCommand("git log"), false);
	assert.equal(isGitCommitCommand("git log -n 5"), false);
	assert.equal(isGitCommitCommand("git log --grep='git commit'"), false);
	assert.equal(isGitCommitCommand("git diff"), false);
	assert.equal(isGitCommitCommand("git diff HEAD~1"), false);
	assert.equal(isGitCommitCommand("git show HEAD"), false);
	assert.equal(isGitCommitCommand('echo "git commit"'), false);
	assert.equal(isGitCommitCommand('echo "a && git commit"'), false);
	assert.equal(isGitCommitCommand("echo 'git commit -m foo'"), false);
	assert.equal(isGitCommitCommand("echo '$(git commit -m foo)'"), false);
	assert.equal(isGitCommitCommand('grep "git commit"'), false);
	assert.equal(isGitCommitCommand('grep "git commit" README.md'), false);
	assert.equal(isGitCommitCommand("# git commit -m commented"), false);
	assert.equal(isGitCommitCommand("git commit-tree"), false);
	assert.equal(isGitCommitCommand("git commit-tree HEAD^{tree}"), false);
	assert.equal(isGitCommitCommand("command -v git commit"), false);
	assert.equal(isGitCommitCommand("bash -c 'git status'"), false);
	assert.equal(isGitCommitCommand('"FOO=bar" git commit'), false);
});

// --- Gate, Config, and Compact Snapshot Integration ------------------------

test("config.ts block.wave defaults to true and can be explicitly disabled", () => {
	const defaults = normalizeGateConfig({ version: 1 });
	assert.equal(defaults.config.block.wave, true);
	assert.deepEqual(defaults.warnings, []);

	const disabled = normalizeGateConfig({ version: 1, block: { wave: false } });
	assert.equal(disabled.config.block.wave, false);
	assert.deepEqual(disabled.warnings, []);

	const bad = normalizeGateConfig({ version: 1, block: { wave: "nope" } });
	assert.equal(bad.config.block.wave, true);
	assert.match(bad.warnings.join(" "), /block\.wave must be a boolean/);
});

test("gate.ts blocks on active wave, re-arms on progress, parks when liveRuns present, and respects override & block.wave=false", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready" },
	]);
	let wave: WaveState = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;

	// Active wave blocks settlement by default
	const blocked = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		wave,
	});
	assert.equal(blocked.decision, "continue");
	assert.deepEqual(blocked.blockedBy, ["wave"]);
	assert.equal(blocked.attempts, 1);
	assert.ok(blocked.blockedEvidence.wave);

	// Same wave evidence still blocks (attempt 2)
	const blockedAgain = evaluateGate({
		outcome: "completed",
		attempts: 1,
		attemptCap: 3,
		wave,
		policy: {
			kinds: [],
			alreadyBlocked: blocked.blockedConditions,
			alreadyBlockedEvidence: blocked.blockedEvidence,
		},
	});
	assert.equal(blockedAgain.decision, "continue");
	assert.equal(blockedAgain.attempts, 2);

	// Progress updates evidence
	wave = applyWaveAction(wave, { type: "triage", ticketId: "01", tier: 1 }, { graph }, LADDER, 20).state!;
	const progressedGate = evaluateWaveGate(wave);
	assert.ok(progressedGate);
	assert.notEqual(progressedGate.evidence, blocked.blockedEvidence.wave);

	// Parks when live subagents exist and waitForSubagents is true
	const parked = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		wave,
		liveRuns: ["run-99"],
		waitForSubagents: true,
	});
	assert.equal(parked.parked, true);
	assert.equal(parked.decision, "report");
	assert.equal(parked.attempts, 0);

	// Respects override
	const overridden = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		wave,
		override: { reason: "pausing wave for user", at: 30 },
	});
	assert.equal(overridden.decision, "report");
	assert.equal(overridden.override?.reason, "pausing wave for user");
	assert.equal(overridden.attempts, 0);

	// Respects attemptCap
	const capped = evaluateGate({
		outcome: "completed",
		attempts: 3,
		attemptCap: 3,
		wave,
	});
	assert.equal(capped.decision, "report");

	// Respects policy.block.wave = false
	const optOut = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		wave,
		policy: { kinds: [], alreadyBlocked: [], block: { wave: false } },
	});
	assert.equal(optOut.decision, "report");
	assert.deepEqual(optOut.blockedBy, []);
});

test("compact-snapshot.ts includes active wave block and omits completed/aborted waves", () => {
	const graph = makeGraph([
		{ id: "01", status: "done" },
		{ id: "02", status: "ready" },
		{ id: "03", status: "ready" },
	]);
	let wave = applyWaveAction(null, { type: "start", folder: "docs/tickets/feat" }, { graph }, LADDER, 10).state!;
	wave = applyWaveAction(wave, { type: "triage", ticketId: "02", tier: 2 }, { graph }, LADDER, 20).state!;

	const summary = formatWaveSummary(wave);
	assert.match(summary, /docs\/tickets\/feat/);
	assert.match(summary, /02:triaged\(T2\)/);

	const snapshot = buildCompactSnapshot({
		goal: null,
		openTodos: [],
		gate: { attempts: 0, attemptCap: 3, blocked: [], lastReason: null },
		liveRuns: [],
		advisor: null,
		wave,
	});
	assert.equal(snapshot.empty, false);
	assert.match(snapshot.text, /docs\/tickets\/feat/);
	assert.match(snapshot.text, /01:done/);
	assert.match(snapshot.text, /02:triaged\(T2\)/);
	assert.match(snapshot.text, /03:pending/);

	const aborted = applyWaveAction(wave, { type: "abort" }, { graph }, LADDER, 30).state!;
	const emptyAfterAbort = buildCompactSnapshot({
		goal: null,
		openTodos: [],
		gate: { attempts: 0, attemptCap: 3, blocked: [], lastReason: null },
		liveRuns: [],
		advisor: null,
		wave: aborted,
	});
	assert.equal(emptyAfterAbort.empty, true);
});

test("planWaveDispatch propagates canonical roles across all wave phases and hasReadyToCommitTicket tracks readiness", () => {
	const graph = makeGraph([
		{ id: "01", status: "ready" },
		{ id: "02", status: "ready", tierOverride: 1 },
		{ id: "03", status: "ready" },
		{ id: "04", status: "ready" },
		{ id: "05", status: "ready" },
		{ id: "06", status: "ready" },
	]);
	let state = applyWaveAction(null, { type: "start", folder: "docs/tickets/roles" }, { graph }, LADDER, 10).state!;
	assert.equal(hasReadyToCommitTicket(state), false);

	// 01 stays pending (triage -> explore), 02 stays pending with tierOverride (start_implement -> coder)
	// 03 -> triaged (start_implement -> coder)
	state = applyWaveAction(state, { type: "triage", ticketId: "03", tier: 1 }, { graph }, LADDER, 20).state!;
	// 04 -> implementing (implement_result -> coder)
	state = applyWaveAction(state, { type: "triage", ticketId: "04", tier: 1 }, { graph }, LADDER, 21).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "04" }, { graph }, LADDER, 22).state!;
	// 05 -> reviewing (record_review -> reviewer)
	state = applyWaveAction(state, { type: "triage", ticketId: "05", tier: 1 }, { graph }, LADDER, 23).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "05" }, { graph }, LADDER, 24).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "05", outcome: "completed" }, { graph }, LADDER, 25).state!;
	// 06 -> verifying (record_verify -> coder)
	state = applyWaveAction(state, { type: "triage", ticketId: "06", tier: 2 }, { graph }, LADDER, 26).state!;
	state = applyWaveAction(state, { type: "start_implement", ticketId: "06" }, { graph }, LADDER, 27).state!;
	state = applyWaveAction(state, { type: "implement_result", ticketId: "06", outcome: "completed" }, { graph }, LADDER, 28).state!;

	const plan = planWaveDispatch(state, graph, LADDER);
	const readyRoles = Object.fromEntries(plan.ready.map((r) => [r.id, r.role]));
	assert.deepEqual(readyRoles, {
		"01": "explore",
		"02": "coder",
		"03": "coder",
	});

	const nextActionRoles = Object.fromEntries(plan.nextActions.map((a) => [a.ticketId, a.role]));
	assert.deepEqual(nextActionRoles, {
		"01": "explore",
		"02": "coder",
		"03": "coder",
		"04": "coder",
		"05": "reviewer",
		"06": "coder",
	});

	// Advance 06 to ready_to_commit
	state = applyWaveAction(state, { type: "record_verify", ticketId: "06", verdict: "pass" }, { graph }, LADDER, 30).state!;
	assert.equal(hasReadyToCommitTicket(state), true);
	const readyPlan = planWaveDispatch(state, graph, LADDER);
	const commitAction = readyPlan.nextActions.find((a) => a.ticketId === "06");
	assert.equal(commitAction?.action, "record_commit");
	assert.equal(commitAction?.role, undefined);

	// After commit, hasReadyToCommitTicket becomes false
	state = applyWaveAction(state, { type: "record_commit", ticketId: "06", commitSha: "abc999" }, { graph }, LADDER, 40).state!;
	assert.equal(hasReadyToCommitTicket(state), false);
	assert.equal(hasReadyToCommitTicket(null), false);
});
