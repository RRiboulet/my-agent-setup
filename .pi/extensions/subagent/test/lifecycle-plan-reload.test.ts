// Reload and resume for dependency plans (ticket 06, R23).
//
// `plan.test.ts` pins the pure reconciliation rules. These tests drive the real
// factory over the scripted-exec harness, because the interesting question is
// not "what does reconcilePlan decide" but "what does a reload do to a plan and
// the children it owns": a live child must be left running, a dead one reported,
// and a completed step never launched twice.
//
// Two ways of simulating a reload, used deliberately:
//   - two harnesses over one temp agent dir, which is the real thing (shutdown
//     persists, a fresh factory loads) and is the only way to prove a child that
//     outlives the parent is not reconciled away;
//   - a hand-seeded `runs.json` + `plans.json`, which is the only way to produce
//     the crash window (a run index NEWER than the plan index) on demand.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import type { RunRecord } from "../index.ts";
import type { PlanRecord, PlanStepState } from "../plan.ts";
import { ORCHESTRATION_EVENTS, type RunsSnapshotPayload } from "../../orchestrator/events.ts";
import { SESSION_ID, createHarness } from "./lifecycle-harness.ts";
import { waitFor, withTempAgentDir } from "./helpers.ts";

const completed = (output = "ok") => ({ version: 1, status: "completed", output, finishedAt: Date.now() });

function sessionDir(agentDir: string): string {
	return path.join(agentDir, "tmux-subagents", SESSION_ID);
}

interface StepFixture {
	id: string;
	status?: PlanStepState["status"];
	runIds?: string[];
	dependsOn?: string[];
	attempts?: number;
	retries?: number;
	handoff?: string;
	error?: string;
}

/** A complete-enough plan record: what `reconcilePlan` reads, plus what renders. */
function planFixture(id: string, steps: StepFixture[], overrides: Partial<PlanRecord> = {}): PlanRecord {
	return {
		id,
		policy: "continue",
		status: "running",
		createdAt: Date.now() - 60_000,
		steps: steps.map((step) => ({
			id: step.id,
			task: `task ${step.id}`,
			cwd: process.cwd(),
			provider: "openrouter",
			model: "parent/model",
			thinking: "medium",
			handoff: step.handoff ?? "standalone",
			trusted: false,
			dependsOn: step.dependsOn ?? [],
			retries: step.retries ?? 0,
			attempts: step.attempts ?? step.runIds?.length ?? 0,
			status: step.status ?? "pending",
			runIds: step.runIds ?? [],
			...(step.error === undefined ? {} : { error: step.error }),
		})),
		...overrides,
	};
}

function runFixture(agentDir: string, overrides: Partial<RunRecord> & { id: string }): RunRecord {
	const runDir = path.join(sessionDir(agentDir), overrides.id);
	return {
		task: "task",
		cwd: process.cwd(),
		provider: "openrouter",
		model: "parent/model",
		thinking: "medium",
		tmuxSession: `pi-agent-${overrides.id}`,
		tmuxTarget: `pi-agent-${overrides.id}:0.0`,
		attachCommand: "",
		captureCommand: "",
		runDir,
		resultPath: path.join(runDir, "result.json"),
		trusted: false,
		status: "running",
		createdAt: Date.now() - 30_000,
		mode: "standalone",
		attempt: 1,
		...overrides,
	};
}

/** Write both indexes before any extension loads: the state a crash leaves behind. */
async function seedSession(agentDir: string, runs: RunRecord[], plans: PlanRecord[]): Promise<void> {
	const dir = sessionDir(agentDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(path.join(dir, "runs.json"), JSON.stringify(runs), "utf8");
	await writeFile(path.join(dir, "plans.json"), JSON.stringify(plans), "utf8");
}

async function readPlansFrom(agentDir: string): Promise<PlanRecord[]> {
	return JSON.parse(await readFile(path.join(sessionDir(agentDir), "plans.json"), "utf8")) as PlanRecord[];
}

async function readRunsFrom(agentDir: string): Promise<RunRecord[]> {
	return JSON.parse(await readFile(path.join(sessionDir(agentDir), "runs.json"), "utf8")) as RunRecord[];
}

function stepOf(plan: PlanRecord, id: string): PlanStepState {
	const found = plan.steps.find((step) => step.id === id);
	assert.ok(found, `plan ${plan.id} has no step ${id}`);
	return found;
}

/** Wait for the persisted plan to satisfy `predicate`, and say what it was if not. */
async function waitForPlan(
	agentDir: string,
	predicate: (plan: PlanRecord) => boolean,
	note: string,
): Promise<PlanRecord> {
	let last: PlanRecord | undefined;
	await waitFor(async () => {
		const plans = await readPlansFrom(agentDir).catch(() => [] as PlanRecord[]);
		last = plans[0];
		return Boolean(last && predicate(last));
	});
	assert.ok(last, note);
	return last;
}

test("a reload resumes at the first unfinished step and never relaunches a completed one", async () => {
	// The crash window this reproduces: the plan index still says `b` is pending
	// while the run index already has `a` completed. The step that already ran
	// must be adopted, not launched a second time.
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture("plan-resume", [
			{ id: "a", status: "completed", runIds: ["run-a"], attempts: 1 },
			{ id: "b", dependsOn: ["a"] },
			{ id: "c", dependsOn: ["b"] },
		]);
		await seedSession(agentDir, [runFixture(agentDir, { id: "run-a", status: "completed", planId: plan.id, stepId: "a" })], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const resumed = await waitForPlan(agentDir, (candidate) => stepOf(candidate, "b").status === "running", "the plan never resumed at b");
			assert.equal(stepOf(resumed, "a").status, "completed");
			assert.deepEqual(stepOf(resumed, "a").runIds, ["run-a"], "a completed step keeps the run it already had");
			assert.equal(stepOf(resumed, "c").status, "pending", "c waits for b, so it is not launched with it");

			const runs = await readRunsFrom(agentDir);
			assert.equal(runs.filter((run) => run.stepId === "a").length, 1, "a was not launched again");
			assert.equal(runs.filter((run) => run.stepId === "b").length, 1);
			assert.deepEqual(stepOf(resumed, "b").runIds, [runs.find((run) => run.stepId === "b")?.id]);
		} finally {
			await h.shutdown();
		}
	});
});

test("a step whose child is still alive across the reload is left running, not reconciled away", async () => {
	// The trap: the watcher re-arms for a `running` run on load, so a child that
	// outlived the parent reload is genuinely still live. Reconciling it away
	// would either relaunch the work or abandon a running child.
	await withTempAgentDir(async (agentDir) => {
		const first = await createHarness({ maxConcurrent: "4" });
		let planId = "";
		let stepRunId = "";
		try {
			const result = await first.call("subagent", { tasks: [{ id: "a", task: "task a" }] });
			planId = (result.details.plan as unknown as PlanRecord).id;
			stepRunId = (result.details.runs as unknown as RunRecord[])[0]?.id ?? "";
			assert.ok(stepRunId, "the step launched before the reload");
		} finally {
			// Not kill-on-shutdown: the child keeps running in its own tmux session,
			// exactly as a real reload of the parent leaves it.
			await first.shutdown();
		}

		const second = await createHarness({ maxConcurrent: "4" });
		try {
			const plans = await readPlansFrom(agentDir);
			assert.equal(plans.length, 1);
			assert.equal(plans[0].id, planId);
			assert.equal(stepOf(plans[0], "a").status, "running", "a live child is not abandoned by a reload");
			assert.deepEqual(stepOf(plans[0], "a").runIds, [stepRunId]);
			assert.equal((await readRunsFrom(agentDir)).filter((run) => run.stepId === "a").length, 1, "and it is not relaunched");

			// The re-armed watcher is what settles it: the child finally reports.
			const liveRun = await second.readRuns();
			assert.equal(liveRun.length, 1);
			await second.writeResult(liveRun[0], completed("a done"));
			const finished = await waitForPlan(agentDir, (candidate) => candidate.status === "completed", "the resumed plan never completed");
			assert.equal(stepOf(finished, "a").status, "completed");
		} finally {
			await second.shutdown();
		}
	});
});

test("a step that was running with no live run left is reported failed under stop, never complete", async () => {
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture(
			"plan-orphan-stop",
			[
				{ id: "a", status: "running", runIds: ["run-gone"], attempts: 1 },
				{ id: "b" },
			],
			{ policy: "stop" },
		);
		// `run-gone` has no record at all: the child died with the session and the
		// run dir was pruned (or the crash landed between the two indexes).
		await seedSession(agentDir, [], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const reconciled = await waitForPlan(agentDir, (candidate) => candidate.status === "failed", "the plan never settled");
			assert.equal(stepOf(reconciled, "a").status, "failed", "an interrupted attempt is a failure, never a completion");
			assert.match(stepOf(reconciled, "a").error ?? "", /Interrupted: the session ended while step "a" was running/);
			assert.equal(stepOf(reconciled, "b").status, "cancelled");
			assert.match(reconciled.reason ?? "", /step "a"/i);
			assert.equal((await readRunsFrom(agentDir)).length, 0, "nothing is launched for an interrupted step under stop");
		} finally {
			await h.shutdown();
		}
	});
});

test("under continue the interrupted branch fails, its dependents are cancelled and the plan is failed", async () => {
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture("plan-orphan-continue", [
			{ id: "a", status: "running", runIds: ["run-gone"], attempts: 1 },
			{ id: "b", dependsOn: ["a"] },
			{ id: "c", dependsOn: ["b"] },
		]);
		await seedSession(agentDir, [], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const reconciled = await waitForPlan(agentDir, (candidate) => candidate.status === "failed", "the plan never settled");
			assert.deepEqual(
				reconciled.steps.map((step) => step.status),
				["failed", "cancelled", "cancelled"],
			);
			assert.match(reconciled.reason ?? "", /Interrupted/);
		} finally {
			await h.shutdown();
		}
	});
});

test("a run index newer than the plan index is tolerated: the completed step is adopted, not relaunched", async () => {
	await withTempAgentDir(async (agentDir) => {
		// The plan has no record of the launch at all — exactly the state a crash
		// between the two renames leaves.
		const plan = planFixture("plan-skew", [{ id: "a" }]);
		await seedSession(agentDir, [runFixture(agentDir, { id: "run-a", status: "completed", planId: plan.id, stepId: "a" })], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const reconciled = await waitForPlan(agentDir, (candidate) => candidate.status === "completed", "the plan never completed");
			assert.equal(stepOf(reconciled, "a").status, "completed");
			assert.deepEqual(stepOf(reconciled, "a").runIds, ["run-a"]);
			assert.equal(stepOf(reconciled, "a").attempts, 1);
			const runs = await readRunsFrom(agentDir);
			assert.equal(runs.length, 1, "the adopted run is not launched a second time");
		} finally {
			await h.shutdown();
		}
	});
});

test("a cancellation recorded only in the run index is folded in as a cancelled step", async () => {
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture("plan-cancel-skew", [
			{ id: "a", status: "running", runIds: ["run-a"], attempts: 1 },
			{ id: "b", dependsOn: ["a"] },
		]);
		await seedSession(agentDir, [runFixture(agentDir, { id: "run-a", status: "cancelled", planId: plan.id, stepId: "a" })], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const reconciled = await waitForPlan(agentDir, (candidate) => candidate.status === "cancelled", "the plan never settled");
			assert.equal(stepOf(reconciled, "a").status, "cancelled");
			assert.equal(stepOf(reconciled, "b").status, "cancelled");
			assert.equal((await readRunsFrom(agentDir)).length, 1, "nothing new is launched");
		} finally {
			await h.shutdown();
		}
	});
});

test("a resumed step that completes right after session_start settles once", async () => {
	// Idempotency against the settle path: reconciliation launches `b`, and a
	// settlement landing in the same window must not produce a second attempt or
	// leave the plan running forever.
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture("plan-settle-race", [
			{ id: "a", status: "completed", runIds: ["run-a"], attempts: 1 },
			{ id: "b", dependsOn: ["a"] },
		]);
		await seedSession(agentDir, [runFixture(agentDir, { id: "run-a", status: "completed", planId: plan.id, stepId: "a" })], [plan]);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			await waitForPlan(agentDir, (candidate) => stepOf(candidate, "b").status === "running", "b never resumed");
			const bRuns = (await readRunsFrom(agentDir)).filter((run) => run.stepId === "b");
			assert.equal(bRuns.length, 1);

			await h.writeResult(bRuns[0], completed("b done"));
			const finished = await waitForPlan(agentDir, (candidate) => candidate.status === "completed", "the plan never completed");
			assert.deepEqual(
				finished.steps.map((step) => step.status),
				["completed", "completed"],
			);
			assert.equal((await readRunsFrom(agentDir)).filter((run) => run.stepId === "b").length, 1, "no duplicate attempt");
		} finally {
			await h.shutdown();
		}
	});
});

test("a resumed fork step hands off from the current session's branch, not the one that created the plan", async () => {
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture("plan-fork", [{ id: "a", handoff: "fork" }]);
		await seedSession(agentDir, [], [plan]);

		const h = await createHarness({ maxConcurrent: "4", sessionManager: "liveBranch" });
		try {
			await waitForPlan(agentDir, (candidate) => stepOf(candidate, "a").status === "running", "the fork step never resumed");
			const run = (await readRunsFrom(agentDir)).find((candidate) => candidate.stepId === "a");
			assert.ok(run, "the resumed step has a run");
			assert.equal(run.mode, "fork");
			assert.ok(run.sessionFile, "the fork seeded a child session file");
			const seeded = await readFile(run.sessionFile as string, "utf8");
			// The live branch ends at the answer; the abandoned sibling is another
			// branch of the same file and must not be inherited.
			assert.match(seeded, /live answer/);
			assert.doesNotMatch(seeded, /ABANDONED SIBLING/);
		} finally {
			await h.shutdown();
		}
	});
});

test("a plan that is already terminal is left alone by a reload", async () => {
	// Control case: reconciliation must not resurrect work, and a finished plan
	// must not be relaunched just because the session was reopened.
	await withTempAgentDir(async (agentDir) => {
		const first = await createHarness({ maxConcurrent: "4" });
		try {
			const result = await first.call("subagent", { tasks: [{ id: "a", task: "task a" }] });
			const run = (result.details.runs as unknown as RunRecord[])[0];
			await first.writeResult(run, completed());
			await waitForPlan(agentDir, (candidate) => candidate.status === "completed", "the plan never completed");
		} finally {
			await first.shutdown();
		}

		const second = await createHarness({ maxConcurrent: "4" });
		try {
			const plans = await readPlansFrom(agentDir);
			assert.equal(plans[0]?.status, "completed");
			assert.equal(stepOf(plans[0], "a").status, "completed");
			assert.equal((await readRunsFrom(agentDir)).length, 1, "a finished plan launches nothing on reload");
		} finally {
			await second.shutdown();
		}
	});
});

test("a stop plan's queued step is abandoned before the reload drain can launch it", async () => {
	// The crash window: `runs.json` was persisted with a failed run and a queued one,
	// `plans.json` still says both steps are running. If the load drains the queue
	// before reconciliation folds the failure in, the queued child is admitted and a
	// `stop` plan ends up with a live child it explicitly refused.
	await withTempAgentDir(async (agentDir) => {
		const plan = planFixture(
			"plan-stop",
			[
				{ id: "a", status: "running", runIds: ["run-a"] },
				{ id: "b", status: "running", runIds: ["run-b"] },
			],
			{ policy: "stop" },
		);
		await seedSession(
			agentDir,
			[
				runFixture(agentDir, { id: "run-a", status: "failed", planId: plan.id, stepId: "a" }),
				runFixture(agentDir, { id: "run-b", status: "queued", planId: plan.id, stepId: "b" }),
			],
			[plan],
		);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			await waitFor(async () => (await readPlansFrom(agentDir))[0]?.status === "failed");

			assert.equal(
				(await readRunsFrom(agentDir)).find((run) => run.id === "run-b")?.status,
				"cancelled",
				"the queued step must be abandoned, not launched",
			);
			const submitted = h.execCalls.some(
				(call) => call.command === "tmux" && call.args.includes("send-keys") && call.args.join(" ").includes("run-b"),
			);
			assert.equal(submitted, false, "no child may be submitted for a step the stop policy abandoned");
		} finally {
			await h.shutdown();
		}
	});
});

test("a reload publishes the live runs a parent's parking set is rebuilt from", async () => {
	await withTempAgentDir(async (agentDir) => {
		// The crash window a parked parent sees after a restart: a run index on disk
		// with a child that outlived the previous process. The snapshot is the only
		// way that parent learns it must park rather than spend its first attempt.
		const live = runFixture(agentDir, { id: "run-live", status: "running" });
		await seedSession(agentDir, [live], []);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const snapshots = h.events.filter(
				(event) => event.channel === ORCHESTRATION_EVENTS.runsSnapshot,
			);
			assert.equal(snapshots.length, 1, "one snapshot per session start");
			assert.deepEqual((snapshots[0]!.data as RunsSnapshotPayload).runs, [
				{ runId: "run-live", status: "running" },
			]);
		} finally {
			await h.shutdown();
		}
	});
});

test("a reload does not list an interrupted run as live", async () => {
	await withTempAgentDir(async (agentDir) => {
		// Interrupted is terminal for parking: its in-process settlement event
		// released the park. Listing it live after a reload would park a parent
		// whose interrupt event can no longer fire.
		await seedSession(agentDir, [runFixture(agentDir, { id: "run-int", status: "interrupted" })], []);

		const h = await createHarness({ maxConcurrent: "4" });
		try {
			const snapshots = h.events.filter((event) => event.channel === ORCHESTRATION_EVENTS.runsSnapshot);
			assert.equal(snapshots.length, 1, "one snapshot per session start");
			assert.deepEqual((snapshots[0]!.data as RunsSnapshotPayload).runs, []);
		} finally {
			await h.shutdown();
		}
	});
});
