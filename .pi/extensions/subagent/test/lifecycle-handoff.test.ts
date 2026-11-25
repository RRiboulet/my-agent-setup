// Context handoff (`handoff` parameter) and `subagent_resume`.
//
// Risk covered: a resumed run keeps its transcript in its ANCESTOR's run dir,
// so the run dir and the transcript have different lifetimes. That mismatch is
// where silent data loss lives — a second appender on one JSONL, a run dir
// deleted out from under a live child — and none of it is reachable from the
// standalone tests.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { waitFor } from "./helpers.ts";
import { completeRun, withHarness } from "./lifecycle-harness.ts";

test("handoff=fork seeds the child with the parent's LIVE branch", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const run = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		assert.equal(run.mode, "fork");

		const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
		assert.equal(JSON.parse(lines[0]).type, "session");
		assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
		const body = lines.slice(1).map((line) => JSON.parse(line));
		assert.deepEqual(
			body.map((entry) => entry.id),
			["e1", "e2"],
			"only the live branch is inherited",
		);
		assert.ok(!lines.join("\n").includes("ABANDONED SIBLING"), "the abandoned sibling must not leak");
		// The live leaf must be the last line, because pi derives the active
		// branch from file order.
		assert.equal(body.at(-1)?.id, "e2");
		assert.equal(run.usageFromLine, 3, "header + two inherited entries");

		// fork mode addresses the child with --session, never --session-id:
		// pi hard-exits on the combination.
		const childCommand = harness.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.find((arg) => arg.includes("--provider"));
		assert.ok(childCommand?.includes("'--session'"), childCommand);
		assert.ok(!childCommand?.includes("--session-id"), childCommand);
	});
});

test("handoff=lineage links the child to the parent without sharing context", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const run = (await harness.call("subagent", { task: "lineage work", handoff: "lineage" })).details as unknown as RunRecord;
		assert.equal(run.mode, "lineage");
		const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
		assert.equal(lines.length, 1, "header only: no inherited conversation");
		assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
		assert.equal(run.usageFromLine, 1);
	});
});

test("subagent_resume continues the same transcript and counts only its own turns", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const beforeResume = (await readFile(first.sessionFile as string, "utf8")).trim().split("\n").length;

		const resumed = (await harness.call("subagent_resume", {
			id: first.id,
			message: "carry on",
		})).details as unknown as RunRecord;

		assert.equal(resumed.sessionFile, first.sessionFile, "the same transcript is continued");
		assert.notEqual(resumed.id, first.id);
		assert.equal(resumed.mode, "resume");
		assert.equal(resumed.attempt, 2);
		assert.equal(resumed.usageFromLine, beforeResume, "the baseline is the transcript as it stood");
		assert.notEqual(resumed.runDir, first.runDir, "the attempt gets its own run dir");

		const childCommand = harness.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.filter((arg) => arg.includes("'--session'"))
			.at(-1);
		assert.ok(childCommand?.includes("'--session'"));
		assert.ok(!childCommand?.includes("--session-id"), childCommand);
	});
});

test("subagent_resume refuses a second concurrent resume of the same transcript", async () => {
	// Regression test: a finished run stays terminal forever, so the "is it
	// still running" guard passed for both resumes and two pi processes
	// appended to one JSONL, forking branches and scrambling baselines.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const a = (await harness.call("subagent_resume", { id: first.id, message: "one" })).details as unknown as RunRecord;
		await assert.rejects(
			() => harness.call("subagent_resume", { id: first.id, message: "two" }),
			/already using this session file/,
		);
		const runs = await harness.readRuns();
		assert.equal(runs.filter((run) => run.sessionFile === first.sessionFile && run.status !== "cancelled").length >= 1, true);
		assert.equal(a.attempt, 2);
	});
});

test("two resumes fired in parallel cannot both launch on one transcript", async () => {
	// The guard scans `runs`, but a resume does I/O (`mkdir`, `countSessionLines`)
	// before its run lands there, so two calls fired without awaiting each other
	// both passed it and two pi processes appended to one JSONL. The synchronous
	// claim on the session file is what stops the second.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);

		const results = await Promise.allSettled([
			harness.call("subagent_resume", { id: first.id, message: "one" }),
			harness.call("subagent_resume", { id: first.id, message: "two" }),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		assert.equal(fulfilled.length, 1, "exactly one resume may launch");
		assert.equal(rejected.length, 1, "the second must be refused, not launched");
		assert.match(String(rejected[0].reason), /already starting|already using this session file/);

		const appending = (await harness.readRuns()).filter(
			(run) => run.sessionFile === first.sessionFile && ["queued", "running", "interrupted"].includes(run.status),
		);
		assert.equal(appending.length, 1, "one live appender on the transcript");
	});
});

test("subagent_resume refuses to resume a run that is still going", async () => {
	await withHarness(undefined, async (h) => {
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		const result = await h.call("subagent_resume", { id: active.id, message: "are you there" });
		assert.match(result.text, /still has a live child \(running\)/);
	});
});

test("an interrupted run is refused a resume while its child is alive", async () => {
	// Regression: resume opens a SECOND pi process on the transcript, and an
	// interrupted child's pi is still holding that file open. Two appenders
	// interleave branches and scramble usage baselines — the corruption the
	// "already using this session file" guard exists to prevent. So the tool's own
	// suggested next step (attach, or cancel first) must not include resuming.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await harness.writeInterrupt(first);
		await waitFor(async () => (await harness.readRuns())[0].status === "interrupted");

		const refused = await harness.call("subagent_resume", { id: first.id, message: "different plan" });
		assert.match(refused.text, /still has a live child \(interrupted\)/);
		assert.match(refused.text, /subagent_cancel/);
		assert.equal((await harness.readRuns()).length, 1, "no second attempt was started");

		// Cancelling releases the child (the transcript stays on disk), and then
		// resume works exactly as it does for any finished run.
		await harness.call("subagent_cancel", { id: first.id });
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "different plan" }))
			.details as unknown as RunRecord;
		assert.equal(resumed.sessionFile, first.sessionFile);
		assert.equal(resumed.attempt, 2);
		assert.equal(resumed.interrupts, undefined, "the new attempt does not inherit the interrupt history");
	});
});

test("subagent_clean does not delete a run dir that still owns a live run's transcript", async () => {
	// Regression test: subagent_resume keeps the ANCESTOR's transcript, so
	// deleting the ancestor's run dir pulled the file out from under a run that
	// was still running. pi holds the descriptor open, so the child kept
	// writing to an unlinked inode and lost every entry silently.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await harness.writeResult(first, {
			version: 1,
			status: "completed",
			output: "ok",
			finishedAt: Date.now(),
			sessionFile: first.sessionFile,
		});
		await waitFor(async () => (await harness.readRuns()).find((run) => run.id === first.id)?.status === "completed");

		// Resume it: the new run points at the old run's transcript and is running.
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;

		const cleaned = await harness.call("subagent_clean", { delete_files: true });
		assert.match(cleaned.text, /still hold the session file of a live run/);
		assert.match(cleaned.text, new RegExp(first.id));

		// The ancestor's transcript must still be on disk for the live run.
		assert.ok(existsSync(resumed.sessionFile as string), "live run's transcript survives the clean");
		assert.ok(existsSync(first.runDir), "the owning run dir is retained");
	});
});

test("subagent_clean counts only transcripts it actually deletes", async () => {
	// A resumed record's sessionFile lives in its ancestor's run dir, so
	// counting "has a sessionFile" over-reports: here the ancestor is skipped
	// as too recent while the resumed record is deleted, and the resumed
	// record's own dir contains no transcript at all. Deleting it destroys
	// nothing resumable, so the count must stay at 0.
	await withHarness({ sessionManager: "liveBranch" }, async (harness, agentDir) => {
		const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
		await completeRun(harness, first);
		const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;
		await harness.writeResult(resumed, {
			version: 1,
			status: "completed",
			output: "ok",
			// Old enough to be cleaned; the ancestor stays recent.
			finishedAt: Date.now() - 7_200_000,
			sessionFile: resumed.sessionFile,
		});
		await waitFor(async () => (await harness.readRuns()).find((run) => run.id === resumed.id)?.status === "completed");

		const cleaned = await harness.call("subagent_clean", { delete_files: true, older_than_hours: 1 });
		assert.match(cleaned.text, /deleted 1 run dir\(s\)/, cleaned.text);
		assert.doesNotMatch(
			cleaned.text,
			/child session transcript/,
			`deleting the resumed run's empty dir must not be reported as a lost transcript: ${cleaned.text}`,
		);
		// The ancestor's transcript is untouched, because it was skipped.
		assert.ok(existsSync(resumed.sessionFile as string));
	});
});
