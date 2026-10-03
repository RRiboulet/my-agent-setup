// Unit tests for the run-summary rendering, status predicates and output
// helpers.
//
// Risk covered: runSummary is the text the main agent reads to decide what
// happened to a run, so its truncation, error handling and usage rendering are
// user-visible correctness, not cosmetics.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";

const {
	formatDuration,
	holdsChild,
	isTerminal,
	runDirOwnsLiveTranscript,
	runSummary,
	textFromAssistant,
	trimPane,
	truncateToolText,
} = __test__;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "11111111-2222-4333-8444-555555555555",
		task: "Investigate the failing query",
		cwd: "/workspace",
		provider: "openrouter",
		model: "deepseek/deepseek-v4",
		thinking: "medium",
		tmuxSession: "pi-agent-11111111-2222-4333-8444-555555555555",
		tmuxTarget: "pi-agent-11111111-2222-4333-8444-555555555555:0.0",
		attachCommand: "pi --attach-subagent '11111111-2222-4333-8444-555555555555'",
		captureCommand: "tmux capture-pane -p",
		killCommand: "tmux kill-session -t pi-agent-11111111-2222-4333-8444-555555555555",
		runDir: "/tmp/run",
		resultPath: "/tmp/run/result.json",
		trusted: false,
		status: "running",
		createdAt: 1_700_000_000_000,
		...overrides,
	};
}

test("isTerminal covers exactly the settled statuses", () => {
	assert.equal(isTerminal("completed"), true);
	assert.equal(isTerminal("failed"), true);
	assert.equal(isTerminal("cancelled"), true);
	// Interrupted is terminal: nothing more will arrive on its own, so wait must
	// stop, clean must skip and resume must be allowed.
	assert.equal(isTerminal("interrupted"), true);
	assert.equal(isTerminal("running"), false);
	assert.equal(isTerminal("queued"), false);
});

test("holdsChild separates terminal from still-alive", () => {
	// The pair is the whole contract of the interrupted status: terminal for
	// waiting, alive for anything that would destroy or free the child.
	assert.equal(holdsChild("queued"), true);
	assert.equal(holdsChild("running"), true);
	assert.equal(holdsChild("interrupted"), true);
	assert.equal(holdsChild("completed"), false);
	assert.equal(holdsChild("failed"), false);
	assert.equal(holdsChild("cancelled"), false);
});

test("runDirOwnsLiveTranscript counts an interrupted run as a live holder", () => {
	// Regression: with isTerminal here, cleaning an ancestor's run dir would
	// unlink a transcript an interrupted child still has open.
	const ancestor = makeRun({ id: "ancestor", runDir: "/tmp/runs/ancestor", status: "completed" });
	const interrupted = makeRun({
		id: "interrupted",
		runDir: "/tmp/runs/interrupted",
		status: "interrupted",
		sessionFile: "/tmp/runs/ancestor/session/standalone.jsonl",
	});
	const runs = new Map([
		[ancestor.id, ancestor],
		[interrupted.id, interrupted],
	]);
	assert.equal(runDirOwnsLiveTranscript(ancestor, runs), true);
	assert.equal(runDirOwnsLiveTranscript(interrupted, runs), false);

	// Once the interrupted run is cancelled the dir is free again.
	interrupted.status = "cancelled";
	assert.equal(runDirOwnsLiveTranscript(ancestor, runs), false);
});

test("formatDuration omits unset start and formats minutes and seconds", () => {
	assert.equal(formatDuration(undefined), undefined);
	assert.equal(formatDuration(1_000, 1_000), "0s");
	assert.equal(formatDuration(1_000, 46_000), "45s");
	assert.equal(formatDuration(1_000, 61_000), "1m 0s");
	assert.equal(formatDuration(1_000, 3_725_000), "62m 4s", "minutes keep counting past an hour; there is no hours branch");
	assert.equal(formatDuration(5_000, 1_000), "0s", "clock skew cannot produce a negative duration");
});

test("runSummary reports id, status, task and model", () => {
	const summary = runSummary(makeRun());
	assert.match(summary, /^11111111-2222-4333-8444-555555555555 {2}running/);
	assert.ok(summary.includes("task: Investigate the failing query"));
	assert.ok(summary.includes("model: openrouter/deepseek/deepseek-v4 (medium)"));
	assert.ok(summary.includes("tmux: pi-agent-11111111-2222-4333-8444-555555555555"));
	assert.ok(summary.includes("attach: pi --attach-subagent"));
});

test("runSummary truncates a long task to its first line", () => {
	const task = `${"x".repeat(250)}\nsecond line`;
	const summary = runSummary(makeRun({ task }));
	assert.ok(summary.includes(`task: ${"x".repeat(100)}`));
	assert.ok(!summary.includes("second line"));
});

test("runSummary includes pane and output only when requested", () => {
	const run = makeRun({ pane: "pane text", output: "final output" });
	assert.ok(!runSummary(run).includes("pane text"));
	assert.ok(runSummary(run, { pane: true }).includes("pane text"));
	assert.ok(runSummary(run, { output: true }).includes("final output"));
});

test("runSummary surfaces an error, but not twice when the output already carries it", () => {
	const withError = runSummary(makeRun({ status: "failed", error: "boom" }));
	assert.ok(withError.includes("Error: boom"));
	const duplicated = runSummary(makeRun({ status: "failed", error: "boom", output: "boom\ndetails" }), {
		output: true,
	});
	assert.ok(duplicated.includes("boom\ndetails"), "output is still shown");
	assert.ok(!duplicated.includes("Error: boom"), "the error is not repeated when the output already carries it");
});

test("runSummary renders usage when the child reported it", () => {
	const summary = runSummary(
		makeRun({
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.5, turns: 2 },
		}),
	);
	assert.ok(summary.includes("30 tok"));
	assert.ok(summary.includes("2 turns"));
	assert.ok(summary.includes("$0.500000"));
});

test("runSummary omits duration when the run never started", () => {
	assert.ok(!runSummary(makeRun({ status: "queued" })).includes("·"));
	assert.ok(runSummary(makeRun({ startedAt: 1_000, finishedAt: 5_000 })).includes("4s"));
});

test("trimPane drops surrounding blank lines and keeps the tail", () => {
	const pane = trimPane(`\n\n\n${"old\n".repeat(40)}last line\n\n`);
	const lines = pane.split("\n");
	assert.ok(lines.length <= 18);
	assert.equal(lines.at(-1), "last line");
	assert.equal(trimPane("   \n  "), "");
});

test("truncateToolText passes short output through untouched", () => {
	assert.equal(truncateToolText("all good"), "all good");
});

test("truncateToolText caps oversized output and points at the session file", () => {
	const truncated = truncateToolText(Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n"));
	assert.ok(truncated.length < 60_000);
	assert.ok(truncated.includes("[Output truncated. Full output is available in the child session file.]"));
});

test("textFromAssistant extracts text blocks and tolerates other shapes", () => {
	assert.equal(textFromAssistant({ content: "plain string" }), "plain string");
	assert.equal(textFromAssistant({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
	assert.equal(textFromAssistant({ content: [{ type: "thinking", thinking: "hidden" }] }), "");
	assert.equal(textFromAssistant({ content: [{ type: "text", text: 42 }] }), "");
	assert.equal(textFromAssistant({ content: undefined }), "");
	assert.equal(textFromAssistant({}), "");
});