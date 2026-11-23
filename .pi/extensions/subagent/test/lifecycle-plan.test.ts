// Lifecycle coverage for fan-out and dependency plans (ticket 05).
//
// plan.test.ts pins the pure readiness/cycle/policy/retry rules. These tests
// drive the real extension factory over the scripted-exec harness: one request
// launches several children, the existing concurrency queue is shared with
// standalone runs, and the EXISTING settle path is what advances the plan.

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import type { RunRecord } from "../index.ts";
import type { PlanRecord } from "../plan.ts";
import { createHarness, withHarness, type Harness } from "./lifecycle-harness.ts";
import { waitFor, withTempAgentDir } from "./helpers.ts";

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

async function readRunsOrEmpty(h: Harness): Promise<RunRecord[]> {
	try {
		return await h.readRuns();
	} catch {
		return [];
	}
}

async function runForStep(h: Harness, stepId: string): Promise<RunRecord> {
	let found: RunRecord | undefined;
	await waitFor(async () => {
		found = (await readRunsOrEmpty(h)).find((run) => run.stepId === stepId && run.status === "running");
		return Boolean(found);
	});
	assert.ok(found, `step ${stepId} never started`);
	return found;
}

function step(plan: PlanRecord, id: string) {
	const found = plan.steps.find((candidate) => candidate.id === id);
	assert.ok(found, `plan has no step ${id}`);
	return found;
}

const completed = (output = "ok", extra: Record<string, unknown> = {}) => ({
	version: 1,
	status: "completed",
	output,
	finishedAt: Date.now(),
	...extra,
});

const failed = (error = "boom") => ({
	version: 1,
	status: "failed",
	output: "",
	error,
	finishedAt: Date.now(),
});

test("one fan-out launches every child with its own overrides and returns runs in request order", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs, text } = await callPlan(h, [
			{ id: "alpha", task: "task alpha", cwd: ".pi", model: "model-a", thinking: "high" },
			{ id: "beta", task: "task beta", provider: "openrouter", model: "model-b", thinking: "low" },
		]);

		assert.deepEqual(
			runs.map((run) => run.stepId),
			["alpha", "beta"],
			"runs come back in the requested order, not completion order",
		);
		assert.deepEqual(
			runs.map((run) => run.task),
			["task alpha", "task beta"],
		);
		assert.equal(runs[0].cwd, path.resolve(process.cwd(), ".pi"));
		assert.equal(runs[0].model, "model-a");
		assert.equal(runs[0].thinking, "high");
		assert.equal(runs[1].provider, "openrouter");
		assert.equal(runs[1].model, "model-b");
		assert.equal(runs[1].thinking, "low");
		assert.equal(runs[0].planId, plan.id);
		assert.equal(runs[0].stepId, "alpha");

		assert.deepEqual(
			plan.steps.map((candidate) => candidate.status),
			["running", "running"],
		);
		assert.match(text, /Plan .* started: 2 step\(s\), policy continue/);
		assert.ok(text.includes("task alpha") === false, "the reply names ids, not task bodies");
	});
});

test("fan-out children share the standalone concurrency budget", async () => {
	await withHarness({ maxConcurrent: "2" }, async (h) => {
		const single = (await h.call("subagent", { task: "standalone" })).details as unknown as RunRecord;
		const { plan } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b" },
			{ id: "c", task: "task c" },
		]);

		await waitFor(async () => (await readRunsOrEmpty(h)).length === 4);
		let runs = await readRunsOrEmpty(h);
		assert.equal(runs.filter((run) => run.status === "running").length, 2, "one budget, not two: at most 2 children run");
		assert.equal(runs.filter((run) => run.status === "queued").length, 2);
		assert.equal(runs.find((run) => run.id === single.id)?.status, "running");
		assert.equal(step(plan, "a").status, "running");
		// A step is `running` in the plan once its run is admitted; the run itself
		// is still queued for a slot, which is the shared budget doing its job.
		assert.equal(step(plan, "b").status, "running");
		assert.equal(runs.find((run) => run.stepId === "b")?.status, "queued");

		// Free a slot by finishing the standalone run; the next QUEUED plan step
		// starts, so the plan shares the queue rather than opening its own.
		await h.writeResult(single, completed());
		await waitFor(async () => (await readRunsOrEmpty(h)).find((run) => run.id === single.id)?.status === "completed");
		await waitFor(async () => (await readRunsOrEmpty(h)).filter((run) => run.status === "running").length === 2);
		runs = await readRunsOrEmpty(h);
		assert.equal(runs.filter((run) => run.status === "queued").length, 1);
	});
});

test("a dependent step starts only after every dependency completed successfully", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "first", task: "task first" },
			{ id: "second", task: "task second", dependsOn: ["first"] },
		]);

		assert.equal(runs.length, 1, "only the dependency-free step launches at creation");
		assert.equal(runs[0].stepId, "first");
		assert.equal(step(plan, "second").status, "pending");
		assert.deepEqual(step(plan, "second").runIds, []);

		await h.writeResult(runs[0], completed("first done"));
		const second = await runForStep(h, "second");
		assert.equal(second.task, "task second");
		assert.equal(step(await waitForPlan(h, (candidate) => step(candidate, "first").status === "completed", "first never completed"), "second").status, "running");

		await h.writeResult(second, completed("second done"));
		const finished = await waitForPlan(h, (candidate) => candidate.status === "completed", "the plan never completed");
		assert.deepEqual(
			finished.steps.map((candidate) => candidate.status),
			["completed", "completed"],
		);
	});
});

test("a cycle or a self-dependency is rejected at creation and launches nothing", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		await assert.rejects(
			() =>
				callPlan(h, [
					{ id: "a", task: "task a", dependsOn: ["b"] },
					{ id: "b", task: "task b", dependsOn: ["a"] },
				]),
			/Plan rejected: Dependency cycle: a -> b -> a/,
		);
		assert.deepEqual(await readRunsOrEmpty(h), []);
		assert.deepEqual(await h.readPlans(), []);

		await assert.rejects(
			() => callPlan(h, [{ id: "self", task: "task self", dependsOn: ["self"] }]),
			/Plan rejected: Step "self" depends on itself/,
		);
		assert.deepEqual(await readRunsOrEmpty(h), []);
		assert.deepEqual(await h.readPlans(), []);
	});
});

test("stop abandons queued steps: no further step starts and the plan is failed", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const { plan, runs } = await callPlan(
			h,
			[
				{ id: "a", task: "task a" },
				{ id: "b", task: "task b" },
			],
			{ failurePolicy: "stop" },
		);

		assert.equal(runs.length, 2);
		assert.equal(runs[0].status, "running");
		assert.equal(runs[1].status, "queued");

		await h.writeResult(runs[0], failed("broken"));
		const failedPlan = await waitForPlan(h, (candidate) => candidate.status === "failed", "the stop plan never failed");
		assert.equal(step(failedPlan, "a").status, "failed");
		assert.equal(step(failedPlan, "b").status, "cancelled");
		assert.ok(failedPlan.finishedAt, "a terminal plan records when it stopped");

		await waitFor(async () => (await readRunsOrEmpty(h)).find((run) => run.stepId === "b")?.status === "cancelled");
		const after = await readRunsOrEmpty(h);
		assert.equal(after.length, 2, "no third run is created after the stop");
		assert.equal(after.find((run) => run.stepId === "b")?.status, "cancelled");
	});
});

test("continue cancels only the failed step's dependents and lets an independent branch finish", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
			{ id: "c", task: "task c" },
		]);

		const runA = runs.find((run) => run.stepId === "a");
		const runC = runs.find((run) => run.stepId === "c");
		assert.ok(runA && runC, "both independent steps start together");
		assert.equal(step(plan, "b").status, "pending");

		await h.writeResult(runA, failed("broken"));
		const advanced = await waitForPlan(h, (candidate) => step(candidate, "a").status === "failed", "a never failed");
		assert.equal(step(advanced, "b").status, "cancelled");
		assert.deepEqual(step(advanced, "b").runIds, [], "a dependent of a failure is never launched");
		assert.equal(step(advanced, "c").status, "running");

		await h.writeResult(runC, completed("c done"));
		const finished = await waitForPlan(h, (candidate) => candidate.status === "failed", "the plan never settled");
		assert.equal(step(finished, "c").status, "completed", "the independent sibling was not failed by a's failure");
		assert.equal(step(finished, "a").status, "failed");
	});
});

test("a retried step stops at its cap and the attempts stay visible in plan state", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan } = await callPlan(h, [{ id: "flaky", task: "task flaky", retries: 1 }]);
		const first = (await readRunsOrEmpty(h))[0];
		assert.ok(first);
		assert.equal(step(plan, "flaky").attempts, 1);
		assert.equal(step(plan, "flaky").retries, 1);

		await h.writeResult(first, failed("first failure"));
		const retried = await waitForPlan(h, (candidate) => step(candidate, "flaky").runIds.length === 2, "the step was never retried");
		const secondId = step(retried, "flaky").runIds[1];
		assert.notEqual(secondId, first.id, "a retry is a new run, with its own report and usage");
		assert.equal(step(retried, "flaky").attempts, 2);
		assert.equal(step(retried, "flaky").status, "running");

		const second = (await readRunsOrEmpty(h)).find((run) => run.id === secondId);
		assert.ok(second);
		await h.writeResult(second, failed("second failure"));
		const capped = await waitForPlan(h, (candidate) => candidate.status === "failed", "the retry cap never stopped the step");
		const finalStep = step(capped, "flaky");
		assert.equal(finalStep.status, "failed");
		assert.equal(finalStep.attempts, 2);
		assert.equal(finalStep.retries, 1);
		assert.deepEqual(finalStep.runIds, [first.id, secondId]);
		assert.equal((await readRunsOrEmpty(h)).length, 2, "no attempt is created past the cap");
	});
});

test("task and tasks are mutually exclusive", async () => {
	await withHarness(undefined, async (h) => {
		await assert.rejects(
			() => h.call("subagent", { task: "one", tasks: [{ task: "two" }] }),
			/either `task` \(one run\) or `tasks`/,
		);
		assert.deepEqual(await readRunsOrEmpty(h), []);
	});
});

test("a plan record is persisted beside the runs and survives a reload", async () => {
	await withTempAgentDir(async () => {
		const first = await createHarness({ maxConcurrent: "1" });
		let planId = "";
		try {
			const { plan } = await callPlan(first, [
				{ id: "a", task: "task a" },
				{ id: "b", task: "task b" },
			]);
			planId = plan.id;
			assert.equal((await readRunsOrEmpty(first)).length, 2);
		} finally {
			await first.shutdown();
		}

		// A fresh factory over the same agent dir: plans.json must be read BEFORE
		// loading runs, because loading runs drains the queue and persists.
		const second = await createHarness({ maxConcurrent: "2" });
		try {
			const plans = await second.readPlans();
			assert.equal(plans.length, 1, "the plan record survived the reload");
			assert.equal(plans[0].id, planId);
			assert.deepEqual(
				plans[0].steps.map((candidate) => candidate.status),
				["running", "running"],
			);
			await waitFor(async () => (await readRunsOrEmpty(second)).filter((run) => run.stepId).length === 2);
			assert.equal((await readRunsOrEmpty(second)).length, 2, "the reload starts the admitted run, not a duplicate step");
		} finally {
			await second.shutdown();
		}
	});
});

test("a stop landing while a child is being submitted kills it instead of starting it", async () => {
	// The submission itself is a window: with two slots both steps are admitted at
	// once, so step a can fail while step b's `Enter` is in flight. The stop policy
	// then abandons b's run; without a re-check after the submission, launchRun
	// overwrites that cancellation with "running" and leaves a child the policy
	// refused. Holding Enter open until the plan records the abandonment makes the
	// race deterministic instead of hoping the watcher tick lands in the window.
	let enters = 0;
	let harness: Harness | undefined;
	await withHarness(
		{
			maxConcurrent: "2",
			async duringEnterSent() {
				enters += 1;
				if (enters !== 2 || !harness) return;
				const first = (await harness.readRuns()).find((run) => run.stepId === "a");
				if (!first) return;
				await harness.writeResult(first, failed("broken"));
				await waitForPlan(
					harness,
					(candidate) => step(candidate, "b").status === "cancelled",
					"the stop policy never abandoned b",
				);
			},
		},
		async (h) => {
			harness = h;
			const { runs } = await callPlan(
				h,
				[
					{ id: "a", task: "task a" },
					{ id: "b", task: "task b" },
				],
				{ failurePolicy: "stop" },
			);
			const b = runs.find((run) => run.stepId === "b");
			assert.ok(b, "the request returned b");

			const persisted = (await h.readRuns()).find((run) => run.id === b.id);
			// `startedAt` is set when the run is admitted to a tmux session, before its
			// command goes out, so the status is the discriminator: without the re-check
			// the abandoned run is written back as `running` and the child is left alive.
			assert.equal(persisted?.status, "cancelled", "an abandoned submission must not become running");
		},
	);
});
