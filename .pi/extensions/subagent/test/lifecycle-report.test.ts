// A settled run's report: the standalone artifact, the bounded copy in the run
// result, and what a child from another build leaves behind.
//
// The pure contract is `report.test.ts`; this file drives the real factory so
// the claim "the parent writes it at settlement" is proven rather than inferred.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

import type { RunRecord } from "../index.ts";
import { CHILD_REPORT_VERSION, REPORT_FENCE, REPORT_FILE_NAME } from "../report.ts";
import { completeRun, waitForRunStatus, withHarness } from "./lifecycle-harness.ts";

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: CHILD_REPORT_VERSION,
		status: "ok",
		summary: "the task is done",
		files: ["src/thing.ts"],
		commands: ["node --test"],
		unresolved: [],
		...overrides,
	};
}

function withEnvelope(value: unknown, body = "I did the thing."): string {
	return `${body}\n\n\`\`\`${REPORT_FENCE}\n${JSON.stringify(value)}\n\`\`\`\n`;
}

test("a settling run writes the complete report beside its result, beyond the display cap", async () => {
	await withHarness(undefined, async (h) => {
		const tail = "TAIL-OF-THE-REPORT";
		// Well past the 50KB display cap, so the artifact can only hold the tail if
		// it is the complete text rather than a copy of `run.output`.
		const body = "a line of the child's reasoning\n".repeat(3_000);
		const output = withEnvelope(report({ summary: "the complete story" }), `${body}${tail}`);
		const run = (await h.call("subagent", { task: "write a long report" })).details as unknown as RunRecord;

		await h.writeResult(run, { version: 1, status: "completed", output, finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed");

		const artifact = await readFile(path.join(run.runDir, REPORT_FILE_NAME), "utf8");
		assert.equal(artifact, output.trim(), "the artifact is the complete final text");
		assert.ok(artifact.includes(tail), "text beyond the display cap is in the artifact");
		assert.ok(Buffer.byteLength(artifact) > DEFAULT_MAX_BYTES, "the fixture must actually exceed the cap");
		assert.equal(completed.report?.artifactPath, path.join(run.runDir, REPORT_FILE_NAME));
		assert.equal(completed.report?.artifactBytes, Buffer.byteLength(artifact));
		assert.equal(completed.report?.status, "ok");
		assert.equal(completed.report?.summary, "the complete story");

		// The run index carries a bounded head and the pointer, never the tail.
		assert.equal(completed.report?.truncated, true);
		assert.ok(Buffer.byteLength(completed.report?.head ?? "") <= DEFAULT_MAX_BYTES);
		assert.ok(!completed.report?.head?.includes(tail));
		const persisted = JSON.stringify(await h.readRuns());
		assert.ok(!persisted.includes(tail), "a very long report must not be loaded whole into runs.json");
	});
});

test("the run result carries a bounded copy and leaves output's meaning unchanged", async () => {
	await withHarness(undefined, async (h) => {
		const output = withEnvelope(report({ files: ["a.ts", "b.ts"], unresolved: ["which release?"] }), "Short answer.");
		const run = (await h.call("subagent", { task: "short report" })).details as unknown as RunRecord;

		await h.writeResult(run, { version: 1, status: "completed", output, finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed");

		// The pre-existing field keeps its exact meaning and truncation.
		assert.equal(completed.output, output.trim());
		assert.equal(completed.report?.head, output.trim());
		assert.equal(completed.report?.truncated, false);
		assert.equal(completed.report?.degradation, undefined);
		assert.deepEqual(completed.report?.files, ["a.ts", "b.ts"]);
		assert.deepEqual(completed.report?.commands, ["node --test"]);
		assert.deepEqual(completed.report?.unresolved, ["which release?"]);
		assert.equal(completed.report?.version, CHILD_REPORT_VERSION);
	});
});

test("a child that ends with no report block still completes, degraded and visible", async () => {
	await withHarness(undefined, async (h) => {
		const output = "I finished the task but forgot the report block.";
		const run = (await h.call("subagent", { task: "no envelope" })).details as unknown as RunRecord;

		await h.writeResult(run, { version: 1, status: "completed", output, finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed");

		assert.equal(completed.output, output, "the plain final text is preserved");
		assert.equal(completed.report?.status, undefined);
		assert.match(completed.report?.degradation ?? "", /no subagent-report block/);
		assert.equal(await readFile(path.join(run.runDir, REPORT_FILE_NAME), "utf8"), output);
	});
});

test("a malformed report block still completes, degraded and visible", async () => {
	await withHarness(undefined, async (h) => {
		const output = `The answer.\n\n\`\`\`${REPORT_FENCE}\n{"version": 1, "status": "ok"\n\`\`\``;
		const run = (await h.call("subagent", { task: "broken envelope" })).details as unknown as RunRecord;

		await h.writeResult(run, { version: 1, status: "completed", output, finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed");

		assert.equal(completed.output, output, "the plain final text is preserved");
		assert.equal(completed.report?.status, undefined);
		assert.match(completed.report?.degradation ?? "", /not valid JSON/);
		assert.equal(await readFile(path.join(run.runDir, REPORT_FILE_NAME), "utf8"), output);
	});
});

test("a newer report version with a compatible shape is accepted and skew is visible", async () => {
	await withHarness(undefined, async (h) => {
		const newer = report({ version: CHILD_REPORT_VERSION + 1, summary: "from a newer build" });
		const run = (await h.call("subagent", { task: "newer report" })).details as unknown as RunRecord;

		// The child put it in the structured field, and its text deliberately has no
		// envelope: this proves the field is read, not re-parsed from prose.
		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "The plain answer.",
			report: newer,
			finishedAt: Date.now(),
		});
		const completed = await waitForRunStatus(h, "completed");

		assert.equal(completed.report?.status, "ok");
		assert.equal(completed.report?.summary, "from a newer build");
		assert.deepEqual(completed.report?.skew, { writer: CHILD_REPORT_VERSION + 1, reader: CHILD_REPORT_VERSION });
		assert.equal(completed.report?.degradation, undefined);
	});
});

test("an incompatible newer report version is reported as skew rather than failing the run", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "skewed shape" })).details as unknown as RunRecord;

		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "The plain answer.",
			report: { version: CHILD_REPORT_VERSION + 1, status: "ok" },
			finishedAt: Date.now(),
		});
		const completed = await waitForRunStatus(h, "completed");

		assert.equal(completed.status, "completed", "an unusable report never fails the run");
		assert.equal(completed.output, "The plain answer.");
		assert.match(completed.report?.degradation ?? "", /summary is missing/);
		assert.match(completed.report?.degradation ?? "", new RegExp(`report version ${CHILD_REPORT_VERSION + 1}`));
	});
});

test("a report in the final text is read when the child sent no structured field", async () => {
	await withHarness(undefined, async (h) => {
		const output = withEnvelope(report({ summary: "from the text" }), "The answer.");
		const run = (await h.call("subagent", { task: "text-only report" })).details as unknown as RunRecord;

		await h.writeResult(run, { version: 1, status: "completed", output, finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed");

		assert.equal(completed.report?.status, "ok");
		assert.equal(completed.report?.summary, "from the text");
	});
});

test("a run that fails before its child reports still leaves a readable artifact", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "never reports" })).details as unknown as RunRecord;
		h.failPaneAlways();

		const failed = await waitForRunStatus(h, "failed");
		const artifact = await readFile(path.join(run.runDir, REPORT_FILE_NAME), "utf8");
		assert.equal(artifact, failed.error, "the failure text is the run's complete final report");
		assert.equal(failed.report?.artifactBytes, Buffer.byteLength(artifact));
		assert.match(failed.report?.degradation ?? "", /no subagent-report block/);
	});
});

test("a resumed attempt does not inherit the previous attempt's report", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (h) => {
		const first = (await h.call("subagent", { task: "first attempt", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(h, first);
		const settled = (await h.readRuns()).find((run) => run.id === first.id);
		assert.ok(settled?.report?.artifactPath, "the first attempt published an artifact");

		const resumed = (await h.call("subagent_resume", { id: first.id, message: "carry on" })).details as unknown as RunRecord;

		// The ancestor's artifact lives in the ancestor's run dir and describes the
		// ancestor's answer. Carrying it would report it as this attempt's from the
		// moment the attempt is queued, and keep it if the attempt is cancelled.
		assert.equal(resumed.report, undefined);
	});
});

test("the report instruction reaches the child's task file, on a launch and on a resume", async () => {
	// The prompt is the only thing that asks the child for an envelope, so losing it
	// degrades every report silently. The unit test covers the text; this covers
	// that a launch actually writes it, including the resume path.
	await withHarness({ sessionManager: "liveBranch" }, async (h) => {
		const first = (await h.call("subagent", { task: "first attempt", handoff: "fork" })).details as unknown as RunRecord;
		assert.match(await readFile(path.join(first.runDir, "task.md"), "utf8"), new RegExp(REPORT_FENCE, "u"));

		await completeRun(h, first);
		const resumed = (await h.call("subagent_resume", { id: first.id, message: "carry on" })).details as unknown as RunRecord;
		assert.match(await readFile(path.join(resumed.runDir, "task.md"), "utf8"), new RegExp(REPORT_FENCE, "u"));
	});
});
