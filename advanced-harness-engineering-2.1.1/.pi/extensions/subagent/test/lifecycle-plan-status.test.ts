// Plan status inside the `subagent_status` list budget (ticket 06, R25).
//
// The rules under test are about what a POLLER pays: a plan is one row whatever
// its step count, its step runs are folded into that row rather than listed
// again, and the whole list still spends at most `LIST_DETAIL_BUDGET` detail
// blocks. `listview.test.ts` pins the budget policy itself; this file pins the
// projection — which rows exist, what the one-line form says, and where a
// failure reason can be read.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunRecord } from "../index.ts";
import type { PlanRecord } from "../plan.ts";
import { LIST_DETAIL_BUDGET } from "../listview.ts";
import { withHarness, type Harness } from "./lifecycle-harness.ts";
import { waitFor } from "./helpers.ts";

const completed = (output = "ok") => ({ version: 1, status: "completed", output, finishedAt: Date.now() });
const failed = (error = "boom") => ({ version: 1, status: "failed", output: "", error, finishedAt: Date.now() });

async function callPlan(
	h: Harness,
	tasks: Record<string, unknown>[],
	options: Record<string, unknown> = {},
): Promise<{ plan: PlanRecord; runs: RunRecord[] }> {
	const result = await h.call("subagent", { tasks, ...options });
	return {
		plan: result.details.plan as unknown as PlanRecord,
		runs: result.details.runs as unknown as RunRecord[],
	};
}

/** Lines that begin a row rather than continuing one: no leading whitespace. */
function rowLines(text: string): string[] {
	return text.split("\n").filter((line) => line.length > 0 && !line.startsWith(" "));
}

/** How many detail blocks the list rendered, run or plan. */
function detailBlocks(text: string): number {
	const runBlocks = (text.match(/^\s{2}task: /gm) ?? []).length;
	const planBlocks = (text.match(/^\s{2}policy: /gm) ?? []).length;
	return runBlocks + planBlocks;
}

test("the list shows a plan as one row and folds its step runs into it", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
		]);
		const standalone = (await h.call("subagent", { task: "alone" })).details as unknown as RunRecord;
		const stepRun = runs.find((run) => run.stepId === "a");
		assert.ok(stepRun);

		const listed = await h.call("subagent_status", {});
		const rows = rowLines(listed.text);

		assert.ok(
			rows.some((line) => line.includes(plan.id)),
			`the plan has a row of its own: ${JSON.stringify(rows)}`,
		);
		assert.ok(rows.some((line) => line.includes(standalone.id)), "the standalone run still has its row");
		assert.ok(
			!rows.some((line) => line.includes(stepRun.id)),
			"the step's run is not a row of its own: a plan does not list its work twice",
		);
		assert.equal((listed.details.plans as PlanRecord[])[0].id, plan.id, "the machine-readable list still holds the plan");
		assert.ok(
			(listed.details.runs as RunRecord[]).some((run) => run.id === stepRun.id),
			"and the machine-readable list still holds every run",
		);
	});
});

test("a ten-step plan spends the detail budget once, not once per step", async () => {
	await withHarness({ maxConcurrent: "10" }, async (h) => {
		const { plan } = await callPlan(
			h,
			Array.from({ length: 10 }, (_, index) => ({ id: `s${index + 1}`, task: `task ${index + 1}` })),
		);

		const listed = await h.call("subagent_status", {});
		const text = listed.text;

		// The single plan block names every step, and the list spends one detail
		// block on it — not ten.
		for (const step of plan.steps) assert.match(text, new RegExp(`${step.id}  running`));
		assert.equal((text.match(/^\s{2}policy: /gm) ?? []).length, 1, "one plan block");
		assert.equal(detailBlocks(text), LIST_DETAIL_BUDGET > 0 ? 1 : 0);
		// Ten rows would have been the old cost; one row is the new one.
		assert.equal(rowLines(text).length, 1);
	});
});

test("a plan and standalone runs are both reported without exceeding the budget", async () => {
	await withHarness({ maxConcurrent: "8" }, async (h) => {
		const { plan } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b" },
			{ id: "c", task: "task c" },
		]);
		const standalones: RunRecord[] = [];
		for (const name of ["one", "two", "three"]) {
			standalones.push((await h.call("subagent", { task: name })).details as unknown as RunRecord);
		}

		const listed = await h.call("subagent_status", {});
		assert.ok(detailBlocks(listed.text) <= LIST_DETAIL_BUDGET, `at most ${LIST_DETAIL_BUDGET} detail blocks`);
		const rows = rowLines(listed.text);
		assert.equal(rows.length, 4, "one row for the plan and one per standalone run");
		assert.ok(rows.some((line) => line.includes(plan.id)));
		for (const run of standalones) assert.ok(rows.some((line) => line.includes(run.id)));
	});
});

test("compact gives one line per plan and per run", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
		]);
		const standalone = (await h.call("subagent", { task: "alone" })).details as unknown as RunRecord;

		const listed = await h.call("subagent_status", { compact: true });
		const rows = rowLines(listed.text);
		assert.equal(rows.length, 2, "one line per plan, one per run");
		const planRow = rows.find((line) => line.includes(plan.id));
		assert.ok(planRow, "the plan is one of them");
		assert.match(planRow, /^plan /, "the row labels itself as a plan rather than hiding behind an id");
		assert.match(planRow, /running/);
		assert.match(planRow, /step\(s\) done/, "the one-liner carries progress");
		assert.ok(rows.some((line) => line.includes(standalone.id)));
		assert.doesNotMatch(listed.text, /policy:/, "compact renders no detail block");
	});
});

test("a finished plan's stop reason reaches the one-line row and the plan block", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { runs } = await callPlan(h, [{ id: "a", task: "task a" }], { failurePolicy: "stop" });
		const run = runs[0];
		await h.writeResult(run, failed("the child hit a wall"));
		await waitFor(async () => (await h.readPlans())[0]?.status === "failed");

		const listed = await h.call("subagent_status", { compact: true });
		assert.match(listed.text, /Step "a" failed: the child hit a wall/, "the stop reason is on the one-line row");

		const inspected = await h.call("subagent_status", { id: (await h.readPlans())[0].id });
		assert.match(inspected.text, /^plan /);
		assert.match(inspected.text, /reason: Step "a" failed: the child hit a wall/);
		// The step's own error is visible too, not only the plan's summary of it.
		assert.match(inspected.text, /a  failed .*the child hit a wall/);
		assert.match(inspected.text, new RegExp(run.id));
	});
});

test("the status tool inspects a plan by id, including every step's run id", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
		]);
		const runA = runs.find((run) => run.stepId === "a");
		assert.ok(runA);

		const inspected = await h.call("subagent_status", { id: plan.id });
		assert.match(inspected.text, new RegExp(`plan ${plan.id}  running`));
		assert.match(inspected.text, /policy: continue/);
		assert.match(inspected.text, new RegExp(`1\\. a  running  ${runA.id}`));
		assert.match(inspected.text, /2\. b  pending \(waits for a\)  —/);
		assert.equal((inspected.details.plan as PlanRecord).id, plan.id);

		await assert.rejects(() => h.call("subagent_status", { id: "no-such-thing" }), /Unknown subagent run or plan/);
	});
});

test("the plan-level wait resolves only when every wave is over", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [
			{ id: "a", task: "task a" },
			{ id: "b", task: "task b", dependsOn: ["a"] },
		]);
		const runA = runs[0];

		// The plan id is the only handle that covers step b: its run does not exist
		// yet, so no list of ids in the reply could have named it.
		const waiting = h.call("subagent_wait", { plan: plan.id, timeoutMs: 30_000 });
		await h.writeResult(runA, completed("a done"));

		let runB: RunRecord | undefined;
		await waitFor(async () => {
			runB = (await h.readRuns().catch(() => [] as RunRecord[])).find(
				(candidate) => candidate.stepId === "b" && candidate.status === "running",
			);
			return Boolean(runB);
		});
		assert.ok(runB, "the dependent step launched");
		await h.writeResult(runB, completed("b done"));

		const waited = await waiting;
		assert.match(waited.text, /Plan .* finished: completed/, "the wait returned only when the plan was over");
		assert.match(waited.text, new RegExp(`1\\. a  completed  ${runA.id}`));
		assert.match(waited.text, new RegExp(`2\\. b  completed  ${runB.id}`));
		assert.equal((waited.details.plan as PlanRecord).status, "completed");
	});
});

test("a timed-out plan wait reports the plan as it stands instead of failing", async () => {
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const { plan, runs } = await callPlan(h, [{ id: "a", task: "task a" }]);

		const waited = await h.call("subagent_wait", { plan: plan.id, timeoutMs: 0 });
		assert.match(waited.text, /did not finish within 0ms/);
		assert.match(waited.text, new RegExp(runs[0].id));
		assert.equal(waited.details.timedOut, true);

		await assert.rejects(() => h.call("subagent_wait", { plan: "no-such-plan" }), /Unknown subagent plan/);
		await assert.rejects(
			() => h.call("subagent_wait", { ids: [plan.id] }),
			/That is a plan id: pass it as plan/,
		);
	});
});
