// Pure rules for dependency plans: readiness, graph rejection, the failure
// policy and the retry cap. No tmux, no watcher and no filesystem: plan.ts is
// deliberately structural, so these are the tests that pin its contract.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildPlan,
	cancelPlan,
	cancelPlanStep,
	failPlanStep,
	markStepLaunched,
	queuedStopCandidates,
	readyStepIds,
	reconcilePlan,
	resolvePlan,
	settlePlanStep,
	type PlanOptions,
	type PlanRecord,
	type PlanStepRun,
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

function step(plan: PlanRecord, id: string) {
	const found = plan.steps.find((candidate) => candidate.id === id);
	assert.ok(found, `plan has no step ${id}`);
	return found;
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

// --- Cancellation: the second settlement source (ticket 06) ------------------

test("cancelling a step's run settles a continue plan instead of wedging it", () => {
	const plan = build([spec("a")]);
	launch(plan, "a", "run-a");

	const advance = cancelPlanStep(plan, "a", "Cancelled: the user cancelled it.");
	assert.equal(advance.changed, true);
	assert.equal(advance.terminal, "cancelled");
	assert.equal(plan.status, "cancelled");
	assert.equal(plan.steps[0].status, "cancelled");
	assert.equal(plan.steps[0].error, "Cancelled: the user cancelled it.");
	assert.match(plan.reason ?? "", /step "a" was cancelled/);
	assert.ok(plan.finishedAt, "a plan ended by a cancel records when");
});

test("continue cancels only the cancelled step's dependents and keeps independent branches", () => {
	const plan = build([spec("a"), spec("b", { dependsOn: ["a"] }), spec("c")]);
	launch(plan, "a", "run-a");
	launch(plan, "c", "run-c");

	const advance = cancelPlanStep(plan, "a", "Cancelled.");
	assert.deepEqual(advance.cancelled, ["b"]);
	assert.deepEqual(advance.launch, []);
	assert.equal(plan.status, "running", "an independent branch is still live");
	assert.equal(step(plan, "b").status, "cancelled");
	assert.deepEqual(step(plan, "b").runIds, [], "a dependent that never ran is not launched now");
	assert.equal(step(plan, "c").status, "running");

	settlePlanStep(plan, { stepId: "c", runId: "run-c", outcome: "completed" });
	assert.equal(plan.status, "cancelled", "a plan with a cancelled step and nothing live is cancelled");
	assert.equal(step(plan, "c").status, "completed");
});

test("stop cancels everything pending and ends the plan as cancelled, not failed", () => {
	const plan = build([spec("a"), spec("b", { dependsOn: ["a"] })], { policy: "stop" });
	launch(plan, "a", "run-a");

	const advance = cancelPlanStep(plan, "a", "Cancelled.");
	assert.deepEqual(advance.cancelled, ["b"]);
	assert.equal(advance.terminal, "cancelled");
	assert.equal(plan.status, "cancelled");
	assert.deepEqual(readyStepIds(plan), [], "nothing further is ready");
});

test("cancelling a whole plan takes live and pending steps and keeps completed records", () => {
	const plan = build([spec("a"), spec("b"), spec("c")]);
	launch(plan, "a", "run-a");
	settlePlanStep(plan, { stepId: "a", runId: "run-a", outcome: "completed" });
	launch(plan, "b", "run-b");

	const result = cancelPlan(plan, "Cancelled: the plan was cancelled.");
	assert.equal(result.changed, true);
	assert.deepEqual(result.live, ["b"]);
	assert.deepEqual(result.cancelled, ["b", "c"]);
	assert.equal(plan.status, "cancelled");
	assert.equal(step(plan, "a").status, "completed");
	assert.deepEqual(step(plan, "a").runIds, ["run-a"], "a completed step keeps its record");
	assert.equal(step(plan, "b").status, "cancelled");
	assert.equal(step(plan, "c").status, "cancelled");
});

// --- Reload reconciliation (R23) ---------------------------------------------

function relaid(specs: PlanStepSpec[], launches: [string, string][], options: PlanOptions = {}): PlanRecord {
	const plan = build(specs, options);
	for (const [stepId, runId] of launches) launch(plan, stepId, runId);
	return plan;
}

function run(runId: string, status: string, createdAt: number, error?: string): PlanStepRun {
	return { runId, status, createdAt, ...(error === undefined ? {} : { error }) };
}

test("reload leaves a step whose run is still live running and launches nothing", () => {
	const plan = relaid([spec("a"), spec("b", { dependsOn: ["a"] })], [["a", "run-a"]]);

	const { advance } = reconcilePlan(plan, { a: [run("run-a", "running", 1)] }, 2_000);
	assert.equal(advance.changed, false, "a live child is not a reconciliation");
	assert.deepEqual(advance.launch, []);
	assert.equal(step(plan, "a").status, "running");
	assert.deepEqual(step(plan, "a").runIds, ["run-a"]);
});

test("an interrupted run still counts as live across a reload", () => {
	const plan = relaid([spec("a")], [["a", "run-a"]]);
	const { advance } = reconcilePlan(plan, { a: [run("run-a", "interrupted", 1)] }, 2_000);
	assert.equal(advance.changed, false);
	assert.equal(step(plan, "a").status, "running");
});

test("a run the plan never recorded is adopted instead of launched a second time", () => {
	// The plan index is older than the run index: the launch was written to
	// runs.json and the crash came before plans.json.
	const plan = build([spec("a")]);
	const { advance, recovered } = reconcilePlan(plan, { a: [run("run-a", "completed", 1)] }, 2_000);
	assert.equal(advance.changed, true);
	assert.deepEqual(advance.launch, []);
	assert.deepEqual(step(plan, "a").runIds, ["run-a"]);
	assert.equal(step(plan, "a").status, "completed", "a completed step is never launched again");
	assert.equal(plan.status, "completed");
	assert.match(recovered.join("\n"), /adopted 1 run/);
});

test("a settlement that landed only in the run index is folded in, and the next wave launches", () => {
	const plan = relaid([spec("a"), spec("b", { dependsOn: ["a"] })], [["a", "run-a"]]);
	const { advance } = reconcilePlan(plan, { a: [run("run-a", "completed", 1)] }, 2_000);
	assert.equal(step(plan, "a").status, "completed");
	assert.deepEqual(advance.launch, ["b"], "the plan resumes at the first unfinished step");
	assert.equal(step(plan, "b").status, "pending", "plan.ts launches nothing itself");
});

test("a running step with no live run is reported interrupted, never complete", () => {
	const plan = relaid([spec("a"), spec("b", { dependsOn: ["a"] }), spec("c")], [
		["a", "run-a"],
		["c", "run-c"],
	]);
	const { advance, recovered } = reconcilePlan(plan, { c: [run("run-c", "running", 2)] }, 2_000);
	assert.equal(step(plan, "a").status, "failed");
	assert.match(step(plan, "a").error ?? "", /Interrupted: the session ended while step "a" was running/);
	assert.equal(step(plan, "b").status, "cancelled", "continue cancels what can never run");
	assert.equal(step(plan, "c").status, "running", "the live branch is untouched");
	assert.equal(plan.status, "running");
	assert.match(recovered.join("\n"), /no live run/);
	assert.deepEqual(advance.launch, []);
});

test("an orphaned attempt spends the retry budget like any other failure", () => {
	const plan = relaid([spec("a", { retries: 1 })], [["a", "run-a"]]);
	const { advance } = reconcilePlan(plan, {}, 2_000);
	assert.deepEqual(advance.launch, ["a"], "a retry is the policy's answer, not a silent relaunch");
	assert.equal(step(plan, "a").status, "pending");
	assert.equal(step(plan, "a").attempts, 1);

	launch(plan, "a", "run-a2");
	const capped = reconcilePlan(plan, {}, 3_000);
	assert.equal(step(plan, "a").status, "failed");
	assert.deepEqual(capped.advance.launch, []);
});

test("a cancelled run is folded in as a cancelled step", () => {
	const plan = relaid([spec("a"), spec("b", { dependsOn: ["a"] })], [["a", "run-a"]]);
	reconcilePlan(plan, { a: [run("run-a", "cancelled", 1)] }, 2_000);
	assert.equal(step(plan, "a").status, "cancelled");
	assert.equal(step(plan, "b").status, "cancelled");
	assert.equal(plan.status, "cancelled");
});

test("reconciliation is idempotent: a second pass launches and settles nothing", () => {
	const plan = relaid([spec("a"), spec("b", { dependsOn: ["a"] })], [["a", "run-a"]]);
	const first = reconcilePlan(plan, { a: [run("run-a", "completed", 1)] }, 2_000);
	assert.deepEqual(first.advance.launch, ["b"]);

	// The settle path got there first: b was launched before a second pass could.
	launch(plan, "b", "run-b");
	const second = reconcilePlan(plan, { a: [run("run-a", "completed", 1)], b: [run("run-b", "running", 2)] }, 2_000);
	assert.equal(second.advance.changed, false);
	assert.deepEqual(second.advance.launch, []);
	assert.equal(plan.steps.length, 2);
});

test("a plan whose last settlement landed only in the run index becomes terminal", () => {
	const plan = relaid([spec("a")], [["a", "run-a"]]);
	reconcilePlan(plan, { a: [run("run-a", "failed", 1, "boom")] }, 2_000);
	assert.equal(plan.status, "failed");
	assert.match(plan.reason ?? "", /Step "a" failed: boom/);
});
