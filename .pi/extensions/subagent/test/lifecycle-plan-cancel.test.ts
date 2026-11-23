// Cancel cascade for dependency plans (ticket 06, R24), driven through the real
// factory over the scripted-exec harness.
//
// The finding this file exists for: `subagent_cancel` used to kill a run and
// nothing else, so a `continue` plan whose only step was cancelled sat `running`
// with a `running` step and nothing able to settle it. The cancel path is the
// second place (after the finaliser) that knows a step ended.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunRecord } from "../index.ts";
import type { PlanRecord, PlanStepState } from "../plan.ts";
import { withHarness, type Harness } from "./lifecycle-harness.ts";
import { waitFor } from "./helpers.ts";

const completed = (output = "ok") => ({ version: 1, status: "completed", output, finishedAt: Date.now() });

async function callPlan(
	h: Harness,
	tasks: Record<string, unknown>[],
	options: Record<string, unknown> = {},
): Promise<{ plan: PlanRecord; runs: RunRecord[]; text: string }> {
	const result = await h.call("subagent", { tasks, ...options });
	return {
		plan: result.details.plan as unknown as PlanRecord,
		runs: result.details.runs as unknown as RunRecord[],
		text: result.text,
	};
}

async function readPlan(h: Harness): Promise<PlanRecord | undefined> {
	return (await h.readPlans())[0];
}

async function waitForPlan(h: Harness, predicate: (plan: PlanRecord) => boolean, note: string): Promise<PlanRecord> {
	let found: PlanRecord | undefined;
	await waitFor(async () => {
		const plan = await readPlan(h);
		if (!plan || !predicate(plan)) return false;
		found = plan;
		return true;
	});
	assert.ok(found, note);
	return found;
}

function stepOf(plan: PlanRecord, id: string): PlanStepState {
	const found = plan.steps.find((step) => step.id === id);
	assert.ok(found, `plan has no step ${id}`);
	return found;
}

function runFor(runs: RunRecord[], stepId: string): RunRecord {
	const found = runs.find((run) => run.stepId === stepId);
	assert.ok(found, `no run for step ${stepId}`);
	return found;
}

async function waitForRunStatus(h: Harness, id: string, status: string): Promise<RunRecord> {
	let found: RunRecord | undefined;
	await waitFor(async () => {
		const runs = await h.readRuns().catch(() => [] as RunRecord[]);
		found = runs.find((run) => run.id === id);
		return found?.status === status;
	});
	assert.ok(found, `run ${id} never reached ${status}`);
	return found;
}

test("cancelling the only step of a continue plan settles the plan instead of wedging it", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [{ id: "a", task: "task a" }]);
		const run = runFor(runs, "a");

		const cancelled = await h.call("subagent_cancel", { id: run.id });
		assert.match(cancelled.text, /Plan .* step "a": cancelled/);
		assert.match(cancelled.text, /Plan status: cancelled/);

		const settled = await waitForPlan(h, (candidate) => candidate.status !== "running", "the plan was left running forever");
		assert.equal(settled.status, "cancelled");
		assert.equal(stepOf(settled, "a").status, "cancelled");
		assert.match(stepOf(settled, "a").error ?? "", /cancelled/i);
		assert.match(settled.reason ?? "", /step "a" was cancelled/);
		assert.ok(settled.finishedAt, "a plan ended by a cancel records when");
		assert.equal((await h.readRuns()).find((candidate) => candidate.id === run.id)?.status, "cancelled");
	});
});

test("cancelling one step keeps an independent branch running and cancels only its dependents", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
			{ id: "c", task: "task c" },
		]);
		const runA = runFor(runs, "a");
		const runC = runFor(runs, "c");

		const cancelled = await h.call("subagent_cancel", { id: runA.id });
		assert.match(cancelled.text, /Also cancelled, because they can never run now: b/);

		const advanced = await waitForPlan(
			h,
			(candidate) => stepOf(candidate, "a").status === "cancelled",
			"the cancelled step was never recorded",
		);
		assert.equal(stepOf(advanced, "b").status, "cancelled", "a dependent that can never run is not left pending");
		assert.deepEqual(stepOf(advanced, "b").runIds, [], "and it is not launched now either");
		assert.equal(stepOf(advanced, "c").status, "running", "the independent branch is untouched");
		assert.equal(advanced.status, "running", "the plan is not over while c is live");

		await h.writeResult(runC, completed("c done"));
		const finished = await waitForPlan(h, (candidate) => candidate.status !== "running", "the plan never settled");
		assert.equal(finished.status, "cancelled", "a plan with a cancelled step and nothing else to fail is cancelled");
		assert.equal(stepOf(finished, "c").status, "completed", "the independent branch still records its own outcome");
	});
});

test("under stop, cancelling one step starts nothing further and ends the plan as cancelled", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { runs } = await callPlan(
			h,
			[
				{ id: "a", task: "task a" },
				{ id: "b", task: "task b", dependsOn: ["a"] },
				{ id: "c", task: "task c", dependsOn: ["b"] },
			],
			{ failurePolicy: "stop" },
		);
		const runA = runFor(runs, "a");

		await h.call("subagent_cancel", { id: runA.id });
		const settled = await waitForPlan(h, (candidate) => candidate.status !== "running", "the stop plan never settled");
		assert.equal(settled.status, "cancelled", "a deliberate cancel is not a failure");
		assert.deepEqual(
			settled.steps.map((step) => step.status),
			["cancelled", "cancelled", "cancelled"],
		);
		const runsNow = await h.readRuns();
		assert.equal(runsNow.length, 1, "no further step is launched after the plan is cancelled");
	});
});

test("cancelling a plan by id cancels its live steps and keeps completed records", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b" },
			{ id: "c", task: "task c" },
		]);
		const runA = runFor(runs, "a");
		const runB = runFor(runs, "b");

		// a finishes, so b is admitted and running with one slot.
		await h.writeResult(runA, completed("a done"));
		await waitForRunStatus(h, runB.id, "running");
		const before = await waitForPlan(h, (candidate) => stepOf(candidate, "a").status === "completed", "a never completed");
		assert.equal(stepOf(before, "b").status, "running");
		// c was launched into the queue at creation, so it is `running` in the plan
		// with a `queued` run — a live step as far as cancellation is concerned.
		assert.equal(stepOf(before, "c").status, "running");
		assert.equal((await h.readRuns()).find((run) => run.stepId === "c")?.status, "queued");

		const cancelled = await h.call("subagent_cancel", { id: plan.id });
		assert.match(cancelled.text, /Plan .* cancelled/);
		assert.match(cancelled.text, /kept with their records: a/);
		assert.match(cancelled.text, new RegExp(`live steps cancelled: b \\(${runB.id}\\)`));

		const settled = await waitForPlan(h, (candidate) => candidate.status === "cancelled", "the plan never cancelled");
		assert.equal(stepOf(settled, "a").status, "completed", "a completed step keeps its status");
		assert.deepEqual(stepOf(settled, "a").runIds, [runA.id], "and its record");
		assert.equal(stepOf(settled, "b").status, "cancelled");
		assert.equal(stepOf(settled, "c").status, "cancelled");

		const runsNow = await h.readRuns();
		assert.equal(runsNow.find((run) => run.id === runA.id)?.status, "completed", "the finished child was not disturbed");
		assert.equal(runsNow.find((run) => run.id === runB.id)?.status, "cancelled");
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(runB.tmuxSession)),
			"the live child's tmux session was killed",
		);
	});
});

test("cancelling a plan that is already over reports it and changes nothing", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [{ id: "a", task: "task a" }]);
		const run = runFor(runs, "a");
		await h.writeResult(run, completed());
		await waitForPlan(h, (candidate) => candidate.status === "completed", "the plan never completed");

		const again = await h.call("subagent_cancel", { id: plan.id });
		assert.match(again.text, /already completed/);
		assert.equal((await readPlan(h))?.status, "completed");
	});
});

test("cancelling an interrupted step's run settles the plan that interrupt left running", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { runs } = await callPlan(h, [{ id: "a", task: "task a" }]);
		const run = runFor(runs, "a");

		// An interrupt keeps the child alive, so the step stays running on purpose:
		// the plan can still be steered. Cancelling is what releases it.
		await h.writeInterrupt(run);
		await waitForRunStatus(h, run.id, "interrupted");
		assert.equal(stepOf(await readPlan(h) as PlanRecord, "a").status, "running", "an interrupted child is still live");
		// The list must not hide the child's state behind the step's: the step is
		// `running` because the child is alive, and the run says what it is doing.
		const inspected = await h.call("subagent_status", { id: (await readPlan(h) as PlanRecord).id });
		assert.match(inspected.text, /1\. a  running .*· run interrupted/);

		await h.call("subagent_cancel", { id: run.id });
		const settled = await waitForPlan(h, (candidate) => candidate.status !== "running", "the plan never settled");
		assert.equal(settled.status, "cancelled");
		assert.equal(stepOf(settled, "a").status, "cancelled");
	});
});

test("the cancel reply names the plan effect, and a standalone cancel is unchanged", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const standalone = (await h.call("subagent", { task: "alone" })).details as unknown as RunRecord;
		const plain = await h.call("subagent_cancel", { id: standalone.id });
		assert.equal(plain.text, `Subagent ${standalone.id} cancelled.`);

		const { runs } = await callPlan(h, [{ id: "a", task: "task a" }]);
		const stepReply = await h.call("subagent_cancel", { id: runFor(runs, "a").id });
		assert.match(stepReply.text, /^Subagent .* cancelled\./);
		assert.match(stepReply.text, /Plan status: cancelled/);
	});
});

test("a plan-level cancel drops the steps that never started and the queued one", async () => {
	// maxConcurrent 1 keeps b and c pending-ish: b is a dependent that never
	// launched, so it must be DROPPED (not left pending, not launched later).
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
			{ id: "c", task: "task c", dependsOn: ["b"] },
		]);
		const runA = runFor(runs, "a");

		const cancelled = await h.call("subagent_cancel", { id: plan.id });
		assert.match(cancelled.text, /not started, cancelled: b, c/);
		assert.match(cancelled.text, new RegExp(`live steps cancelled: a \\(${runA.id}\\)`));

		await waitFor(async () => (await h.readRuns()).every((run) => run.status === "cancelled"));
		const runsNow = await h.readRuns();
		assert.equal(runsNow.length, 1, "the dropped steps are not launched by the queue drain");
		assert.equal(runsNow[0].id, runA.id);
		const settled = await waitForPlan(h, (candidate) => candidate.status === "cancelled", "the plan never cancelled");
		assert.deepEqual(
			settled.steps.map((step) => step.status),
			["cancelled", "cancelled", "cancelled"],
		);
	});
});
