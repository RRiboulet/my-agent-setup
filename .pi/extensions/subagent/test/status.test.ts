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
	isMissingTmuxTarget,
	isSameOrDescendant,
	isTerminal,
	runDirOwnsLiveTranscript,
	resolveManagementExposure,
	runSummary,
	startRepeatingRefresh,
	statusDetail,
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

test("startRepeatingRefresh fires and, crucially, can be stopped", async () => {
	// The widget ticker is the only refresher when a watcher's tmux calls are slow.
	// Pinned here on its own so the mechanism cannot rot behind the integration.
	let ticks = 0;
	const stop = startRepeatingRefresh(() => (ticks += 1), 20);
	// 500 ms, not 120: the assertion is "fires repeatedly", and on a loaded box a
	// starved event loop missed two 20 ms ticks inside 120 ms. Same rule as the
	// generous bounds in helpers.ts — assert the behaviour, not the machine.
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert.ok(ticks >= 2, `expected repeated ticks, got ${ticks}`);
	stop();
	const settled = ticks;
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(ticks, settled, "stop() must end the timer, not merely ignore its callback");
	// Stopping twice is harmless: session_shutdown can run after a run leaves.
	stop();
});

test("resolveManagementExposure hides the tools only when pi can reach them on demand", () => {
	// Nothing to reach them with: they must stay declared. A tool the model cannot
	// find is worse than one it pays for, so this is the only safe default.
	assert.equal(resolveManagementExposure(["read", "bash", "edit", "write"]), undefined);
	assert.equal(resolveManagementExposure([]), undefined);
	// An unrelated tool must not trigger it, and a similarly named one must not
	// either — the test is not "any extra tool".
	assert.equal(resolveManagementExposure(["read", "bash", "subagent", "mcp__thing__codemode"]), undefined);

	// Either mechanism is enough.
	assert.equal(resolveManagementExposure(["read", "codemode"]), "codemode");
	assert.equal(resolveManagementExposure(["tool_search"]), "codemode");
});

test("statusDetail renders one qualifier per kind", () => {
	// The widget row is `${detail} · ${elapsed}`, so a detail that repeats the kind
	// and a detail that omits it entirely are both wrong. The duration leads,
	// because it measures the phase while a tool name measures what is happening
	// inside it — pairing them the other way round implies the tool has been
	// running for the whole phase.
	const snapshot = (overrides: Record<string, unknown> = {}) =>
		({
			kind: "active",
			elapsedText: "0s",
			activeDurationText: null,
			activeScope: null,
			toolName: null,
			waitingDurationText: null,
			snapshotState: "present",
			snapshotError: null,
			snapshotProblemText: null,
			quietDurationText: null,
			statusLabel: null,
			...overrides,
		}) as never;

	assert.equal(statusDetail(snapshot({ activeScope: "provider" })), "active (provider)", "no duration yet");
	assert.equal(statusDetail(snapshot({ toolName: "bash", activeDurationText: "45s" })), "active 45s (bash)");
	assert.equal(statusDetail(snapshot({ toolName: "bash" })), "active (bash)", "the tool outranks the scope");
	assert.equal(statusDetail(snapshot({ activeDurationText: "2m" })), "active 2m", "no label, but still a duration");
	assert.equal(statusDetail(snapshot({ kind: "waiting", waitingDurationText: "12s" })), "waiting 12s");
	assert.equal(statusDetail(snapshot({ kind: "waiting", statusLabel: "done" })), "done", "a settled child is labelled");
	assert.equal(statusDetail(snapshot({ kind: "stalled", snapshotProblemText: "3m 0s" })), "stalled 3m 0s");
	assert.equal(
		statusDetail(snapshot({ kind: "stalled", snapshotProblemText: "3m 0s", statusLabel: "wrong activity id" })),
		"stalled 3m 0s (wrong activity id)",
		"the reason is shown: it calls for a different response than a bare stall",
	);
	// A valid-but-silent snapshot has no problem clock, so the row falls back to
	// the run's own age rather than showing a stall with no duration at all.
	// A valid-but-silent snapshot has no problem clock, so its own silence is
	// reported. Never the run's age: a child that worked for an hour and then
	// wedged has been silent for seconds, and saying "stalled 1h 3m" would be a
	// different (and much worse) claim than the one the evidence supports.
	assert.equal(
		statusDetail(snapshot({ kind: "stalled", statusLabel: "no activity", quietDurationText: "3m 20s", elapsedText: "1h 3m" })),
		"stalled 3m 20s (no activity)",
	);
	assert.equal(statusDetail(snapshot({ kind: "stalled", statusLabel: "no activity" })), "stalled (no activity)", "no duration is better than a wrong one");
	// An unreadable file is a different problem from a wedged child, so the parse
	// error is surfaced (and bounded) rather than thrown away.
	assert.equal(
		statusDetail(snapshot({ kind: "stalled", snapshotState: "invalid", snapshotError: "activity is not valid JSON: Unexpected token h in JSON at position 2", snapshotProblemText: "3m 0s" })),
		// The detail is bounded: a parse error can be arbitrarily long.
		"stalled 3m 0s (invalid snapshot: Unexpected token h in JSON at position 2)",
	);
	assert.equal(
		statusDetail(snapshot({ kind: "stalled", snapshotState: "invalid", snapshotError: "   " })),
		"stalled (invalid snapshot)",
	);
	const long = `activity is not valid JSON: ${"x".repeat(120)}`;
	const rendered = statusDetail(snapshot({ kind: "stalled", snapshotState: "invalid", snapshotError: long }));
	assert.equal(rendered.length < 80, true, `a parse error must not take over the row: ${rendered}`);
	assert.equal(statusDetail(snapshot({ kind: "queued" })), "queued for a slot");
	assert.equal(statusDetail(snapshot({ kind: "interrupted" })), "interrupted");
	assert.equal(statusDetail(snapshot({ kind: "starting" })), "starting");
});

test("isMissingTmuxTarget only claims a missing target for tmux's own wording", () => {
	// A false positive fails a healthy child, so the patterns are deliberately
	// narrow; a false negative re-arms the watcher against a target that cannot
	// exist, so the canonical messages must all be covered.
	for (const stderr of [
		"can't find pane: pi-agent-x",
		"can't find session: pi-agent-x",
		"no such session",
		"unknown session: pi-agent-x",
		"server exited unexpectedly",
		// tmux is not consistent about which stream carries the error, so both
		// are searched; a different wording is not enough on its own.
		"",
	]) {
		const stdout = stderr ? "" : "no such pane in session 3";
		assert.equal(isMissingTmuxTarget({ code: 1, stdout, stderr }), true, `${stderr}${stdout}`);
	}
	// A success is never a missing target, and neither is a transient failure the
	// watcher must keep retrying.
	assert.equal(isMissingTmuxTarget({ code: 0, stdout: "1", stderr: "can't find pane" }), false);
	assert.equal(isMissingTmuxTarget({ code: 1, stdout: "", stderr: "error connecting to sock (No such file or directory)" }), false);
	assert.equal(isMissingTmuxTarget({ code: 1, stdout: "", stderr: "permission denied" }), false);
	assert.equal(isMissingTmuxTarget({ code: 1, stdout: "error: no session found on this server", stderr: "" }), false);
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

test("runSummary renders role, activitySummary, and parsed subagent-report digest for settled runs without dead pane or raw output", () => {
	const bigBody = `${"raw reasoning line\n".repeat(400)}TAIL-MARKER`;
	const run = makeRun({
		status: "completed",
		role: "coder",
		startedAt: 1_000,
		finishedAt: 6_000,
		pane: "DEAD-TMUX-PANE-SNAPSHOT",
		sessionFile: "/tmp/run/session/child.jsonl",
		output: `${bigBody}\n\n\`\`\`subagent-report\n{"version":1,"status":"ok","summary":"Implemented feature X."}\n\`\`\``,
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: 0.01, turns: 2 },
		activitySummary: {
			editedFiles: [{ path: "src/foo.ts", changedLines: 14 }],
			passedCommands: [{ command: "node --test src/foo.test.ts", at: 5_500 }],
			lastEditAt: 5_000,
		},
		report: {
			artifactPath: "/tmp/run/report.md",
			artifactBytes: 8_200,
			head: bigBody.slice(0, 500),
			truncated: true,
			version: 1,
			status: "ok",
			summary: "Implemented feature X.\nVerified all cases.",
			files: ["src/foo.ts", "test/foo.test.ts"],
			commands: ["node --test src/foo.test.ts"],
			unresolved: ["Confirm rollout window"],
		},
	});

	const summary = runSummary(run);
	assert.match(summary, /completed · 5s · 150 tok · 2 turns · \$0\.010000/);
	assert.ok(summary.includes("role: coder"));
	assert.ok(summary.includes("model: openrouter/deepseek/deepseek-v4 (medium)"));
	assert.ok(summary.includes("activity summary: edited src/foo.ts (14L) · passed node --test src/foo.test.ts"));
	assert.ok(summary.includes("report: /tmp/run/report.md (8200 bytes, bounded copy in this record)"));
	assert.ok(summary.includes("reported: ok — Implemented feature X. Verified all cases."));
	assert.ok(summary.includes("report files: src/foo.ts, test/foo.test.ts"));
	assert.ok(summary.includes("report commands: node --test src/foo.test.ts"));
	assert.ok(summary.includes("report unresolved: Confirm rollout window"));
	assert.ok(summary.includes("child session: /tmp/run/session/child.jsonl"));
	assert.ok(!summary.includes("DEAD-TMUX-PANE-SNAPSHOT"), "dead pane omitted by default");
	assert.ok(!summary.includes("raw reasoning line"), "raw output omitted when report digest exists");
	assert.ok(!summary.includes("TAIL-MARKER"), "tail omitted when report digest exists");

	const withPaneAndOutput = runSummary(run, { pane: true, output: true });
	assert.ok(withPaneAndOutput.includes("DEAD-TMUX-PANE-SNAPSHOT"));
	assert.ok(withPaneAndOutput.includes("raw reasoning line"));
	assert.ok(withPaneAndOutput.includes("TAIL-MARKER"));
});

test("runSummary uses a bounded compact tail fallback for settled runs without a structured report", () => {
	const lines = Array.from({ length: 250 }, (_, index) => `line-${String(index).padStart(3, "0")}: ${"x".repeat(40)}`);
	const rawOutput = lines.join("\n");
	const run = makeRun({
		status: "completed",
		startedAt: 1_000,
		finishedAt: 3_000,
		pane: "DEAD-TMUX-PANE",
		output: rawOutput,
		report: {
			artifactPath: "/tmp/run/report.md",
			artifactBytes: Buffer.byteLength(rawOutput),
			head: rawOutput,
			truncated: false,
			degradation: "the child's final text carries no subagent-report block",
		},
	});

	const defaultSummary = runSummary(run);
	assert.ok(!defaultSummary.includes("DEAD-TMUX-PANE"), "dead pane omitted by default");
	assert.ok(!defaultSummary.includes("line-000:"), "early multi-KB lines omitted in compact tail fallback");
	assert.ok(defaultSummary.includes("line-249:"), "tail line is present in compact fallback");
	assert.ok(Buffer.byteLength(defaultSummary, "utf8") < 3_000, `summary must stay compact, got ${Buffer.byteLength(defaultSummary, "utf8")} bytes`);
	assert.ok(defaultSummary.includes("includeOutput: true"), "tells caller how to get full output");

	const expanded = runSummary(run, { output: true });
	assert.ok(expanded.includes("line-000:"), "output: true restores full raw output");
	assert.ok(expanded.includes("line-249:"));
});

test("runSummary renders parsed report digest alongside report degradation when both are present", () => {
	const run = makeRun({
		status: "completed",
		startedAt: 1_000,
		finishedAt: 4_000,
		output: "raw output",
		report: {
			artifactPath: "/tmp/run/report.md",
			artifactBytes: 4_096,
			head: "raw output",
			truncated: true,
			degradation: "report.md copy was bounded before digest extraction",
			version: 1,
			status: "ok",
			summary: "Applied fix and verified tests.",
			files: ["src/fix.ts"],
			commands: ["node --test"],
			unresolved: ["Monitor rollout"],
		},
	});

	const summary = runSummary(run);
	assert.ok(summary.includes("report degraded: report.md copy was bounded before digest extraction"));
	assert.ok(summary.includes("reported: ok — Applied fix and verified tests."));
	assert.ok(summary.includes("report files: src/fix.ts"));
	assert.ok(summary.includes("report commands: node --test"));
	assert.ok(summary.includes("report unresolved: Monitor rollout"));
});
