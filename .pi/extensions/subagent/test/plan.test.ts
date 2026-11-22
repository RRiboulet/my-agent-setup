// Pure rules for dependency plans: readiness, graph rejection, the failure
// policy and the retry cap. No tmux, no watcher and no filesystem: plan.ts is
// deliberately structural, so these are the tests that pin its contract.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildPlan,
	failPlanStep,
	markStepLaunched,
	queuedStopCandidates,
	readyStepIds,
	settlePlanStep,
	type PlanOptions,
	type PlanRecord,
	type PlanStepSpec,
} from "../plan.ts";

function spec(id: string, overrides: Partial<PlanStepSpec> = {}): PlanStepSpec {
	return {
		id,
		task: `task ${id}`,
		cwd: "/tmp",
		provider: "p",
		model: "m",
		thinking: "off",
		handoff: "standalone",
		trusted: false,
		...overrides,
	};
}

function build(specs: PlanStepSpec[], options: PlanOptions = {}): PlanRecord {
	const built = buildPlan("plan-1", specs, options, 1_000);
	assert.equal(built.ok, true, built.ok ? undefined : built.error);
	return built.plan;
}

function launch(plan: PlanRecord, stepId: string, runId: string): void {
	assert.equal(markStepLaunched(plan, stepId, runId), true, `step ${stepId} must be launchable`);
}

test("fan-out with no edges makes every step ready in the requested order", () => {
	const plan = build([spec("a"), spec("b"), spec("c")]);
	assert.deepEqual(readyStepIds(plan), ["a", "b", "c"]);
	assert.deepEqual(
		plan.steps.map((step) => step.dependsOn),
		[[], [], []],
	);
});

test("steps without explicit ids are numbered in request order", () => {
	const built = buildPlan("plan-1", [spec(""), spec("")], {}, 1_000);
	assert.equal(built.ok, true);
	if (!built.ok) return;
	assert.deepEqual(
		built.plan.steps.map((step) => step.id),
		["step-1", "step-2"],
	);
});

test("rejects a cycle at creation, naming the cycle", () => {
	const built = buildPlan("plan-1", [spec("a", { dependsOn: ["b"] }), spec("b", { dependsOn: ["c"] }), spec("c", { dependsOn: ["a"] })]);
	assert.equal(built.ok, false);
	if (built.ok) return;
	assert.match(built.error, /Dependency cycle: a -> b -> c -> a/);
});

test("rejects a self-dependency at creation", () => {
	const built = buildPlan("plan-1", [spec("a", { dependsOn: ["a"] })]);
	assert.equal(built.ok, false);
	if (built.ok) return;
	assert.match(built.error, /Step "a" depends on itself/);
});

test("rejects an unknown dependency and a duplicate step id", () => {
	const unknown = buildPlan("plan-1", [spec("a", { dependsOn: ["ghost"] })]);
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.match(unknown.error, /depends on unknown step "ghost"/);

	const duplicate = buildPlan("plan-1", [spec("a"), spec("a")]);
	assert.equal(duplicate.ok, false);
	if (!duplicate.ok) assert.match(duplicate.error, /Duplicate step id "a"/);
});

test("a dependent is ready only after every dependency completed successfully", () => {
	const plan = build([spec("a"), spec("b"), spec("c", { dependsOn: ["a", "b"] })]);
	launch(plan, "a", "run-a");
	assert.deepEqual(settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "completed" }).launch, ["b"]);

	// One dependency completed is not enough: `a` is done but `b` is still pending.
	assert.equal(readyStepIds(plan).includes("c"), false);

	launch(plan, "b", "run-b");
	assert.deepEqual(settlePlanStep(plan, { stepId: "b", runId: "run-b", outcome: "completed" }).launch, ["c"]);
});

test("a diamond waits for both arms, not for the first one", () => {
	const plan = build([spec("root"), spec("left", { dependsOn: ["root"] }), spec("right", { dependsOn: ["root"] }), spec("join", { dependsOn: ["left", "right"] })]);
	launch(plan, "root", "r-root");
	const afterRoot = settlePlanStep(plan, { stepId: "root", runId: "r-root", outcome: "completed" });
	assert.deepEqual(afterRoot.launch, ["left", "right"]);
	// The caller starts everything the reduction named, then both arms run
	// concurrently.
	launch(plan, "left", "r-left");
	launch(plan, "right", "r-right");

	assert.deepEqual(settlePlanStep(plan, { stepId: "left", runId: "r-left", outcome: "completed" }).launch, []);
	assert.equal(readyStepIds(plan).includes("join"), false);

	assert.deepEqual(settlePlanStep(plan, { stepId: "right", runId: "r-right", outcome: "completed" }).launch, ["join"]);
});

test("stop cancels every pending step on a permanent failure and launches nothing", () => {
	const plan = build([spec("a"), spec("b", { dependsOn: ["a"] }), spec("c")], { policy: "stop" });
	launch(plan, "a", "run-a");

	const advance = settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "failed", error: "boom" });
	assert.equal(advance.changed, true);
	assert.equal(advance.stop, true);
	assert.deepEqual(advance.launch, []);
	assert.deepEqual(advance.cancelled, ["b", "c"]);
	assert.equal(plan.status, "failed");
	assert.equal(plan.steps.find((step) => step.id === "b")?.status, "cancelled");
	assert.equal(plan.steps.find((step) => step.id === "c")?.status, "cancelled");
});

test("continue cancels dependents transitively and keeps independent branches", () => {
	const plan = build([spec("a"), spec("b", { dependsOn: ["a"] }), spec("c"), spec("d", { dependsOn: ["b"] })], { policy: "continue" });
	launch(plan, "a", "run-a");

	const advance = settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "failed", error: "boom" });
	assert.equal(advance.stop, false);
	assert.deepEqual(advance.cancelled, ["b", "d"]);
	assert.deepEqual(advance.launch, ["c"]);
	assert.equal(plan.status, "running");
	assert.equal(plan.steps.find((step) => step.id === "a")?.status, "failed");
});

test("a failure does not fail a sibling that does not depend on it", () => {
	const plan = build([spec("a"), spec("b")], { policy: "continue" });
	launch(plan, "a", "run-a");
	launch(plan, "b", "run-b");

	settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "failed", error: "boom" });
	assert.equal(plan.steps.find((step) => step.id === "b")?.status, "running");

	const done = settlePlanStep(plan, { stepId: "b", runId: "run-b", outcome: "completed" });
	assert.equal(done.terminal, "failed");
	assert.equal(plan.steps.find((step) => step.id === "b")?.status, "completed");
	assert.equal(plan.status, "failed");
});

test("retries are new attempts, stop at the cap, and stay visible in the plan", () => {
	const plan = build([spec("a", { retries: 1 })], { retryLimit: 5 });

	launch(plan, "a", "run-1");
	const first = settlePlanStep(plan, { stepId: "a", runId: "run-1", outcome: "failed", error: "boom" });
	assert.deepEqual(first.launch, ["a"]);
	assert.equal(plan.steps[0].status, "pending");
	assert.equal(plan.steps[0].attempts, 1);
	assert.equal(plan.steps[0].retries, 1);

	// The retry is a NEW run id; the first attempt's id stays on the record.
	launch(plan, "a", "run-2");
	assert.deepEqual(plan.steps[0].runIds, ["run-1", "run-2"]);
	assert.equal(plan.steps[0].attempts, 2);

	const second = settlePlanStep(plan, { stepId: "a", runId: "run-2", outcome: "failed", error: "still boom" });
	assert.deepEqual(second.launch, []);
	assert.equal(plan.steps[0].status, "failed");
	assert.equal(plan.steps[0].attempts, 2);
	assert.equal(plan.steps[0].retries, 1);
	assert.equal(plan.status, "failed");
});

test("a failed launch consumes retry budget instead of retrying forever", () => {
	const plan = build([spec("a", { retries: 1 })]);
	launch(plan, "a", "run-1");

	const retry = failPlanStep(plan, "a", "mkdir failed");
	assert.deepEqual(retry.launch, ["a"]);
	launch(plan, "a", "run-2");

	const capped = failPlanStep(plan, "a", "mkdir failed again");
	assert.deepEqual(capped.launch, []);
	assert.equal(plan.steps[0].status, "failed");
	assert.equal(plan.steps[0].attempts, 2);
});

test("a duplicate settlement (or a stale attempt) launches nothing", () => {
	const plan = build([spec("a", { retries: 1 }), spec("b", { dependsOn: ["a"] })]);
	launch(plan, "a", "run-1");
	const first = settlePlanStep(plan, { stepId: "a", runId: "run-1", outcome: "failed", error: "boom" });
	assert.deepEqual(first.launch, ["a"]);

	// The retry is in flight; a duplicate settlement of the FIRST attempt must not
	// cancel it or start anything twice.
	const duplicate = settlePlanStep(plan, { stepId: "a", runId: "run-1", outcome: "failed", error: "boom" });
	assert.equal(duplicate.changed, false);
	assert.deepEqual(duplicate.launch, []);

	launch(plan, "a", "run-2");
	settlePlanStep(plan, { stepId: "a", runId: "run-2", outcome: "completed" });
	const again = settlePlanStep(plan, { stepId: "a", runId: "run-2", outcome: "completed" });
	assert.equal(again.changed, false);
	assert.deepEqual(again.launch, []);
});

test("a stop plan names its still-running steps so queued runs are abandoned", () => {
	const plan = build([spec("a"), spec("b")], { policy: "stop" });
	launch(plan, "a", "run-a");
	launch(plan, "b", "run-b");
	settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "failed", error: "boom" });

	// `b` was admitted before the failure; the caller cancels it if it is still
	// queued. A live child is not in this list's control, so the step stays
	// running until it settles on its own.
	assert.deepEqual(queuedStopCandidates(plan), ["b"]);
	assert.equal(plan.status, "failed");

	settlePlanStep(plan, { stepId: "b", runId: "run-b", outcome: "completed" });
	assert.equal(plan.steps.find((step) => step.id === "b")?.status, "completed");
	assert.equal(plan.status, "failed");
});
