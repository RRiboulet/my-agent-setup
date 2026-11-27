// Load guard + behavior tests for review.ts.
//
// Part 1 is a load guard: review.ts must load under a strict ESM linker. pi
// loads extensions through jiti, whose CJS interop resolves missing named
// exports lazily — a module importing a symbol that pi 1.0 removed still
// "loads" through jiti and only fails when the code path runs. Importing the
// module here with `node --test` uses the real ESM linker, so a removed import
// fails at load time and this test goes red.
//
// Part 2 exercises the helpers the local testability refactor moved out of the
// factory and exposed via the `__test__` export: the arg parsers, PR-ref
// parsing, and the rubric/verdict logic the review loop relies on. These are
// the parts of the vendored file we changed, and upstream ships them with no
// tests at all.
//
// Importing the module has no side effects: the factory is only called when
// pi actually loads the extension.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	ORCHESTRATION_EVENTS,
	publishOrchestrationEvent,
	subscribeOrchestrationEvent,
	type SubagentDispatchPayload,
	type SubagentDispatchResult,
} from "../../orchestrator/events.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { waitFor } from "./helpers.ts";
import { waitForRunStatus, withHarness } from "./lifecycle-harness.ts";

const SPECIFIER = new URL("../../review.ts", import.meta.url).href;

type ReviewTargetShape = {
	type: string;
	branch?: string;
	sha?: string;
	title?: string;
	paths?: string[];
	ref?: string;
	prNumber?: number;
	baseBranch?: string;
};

type ParsedArgs = {
	target: ReviewTargetShape | null;
	extraInstruction?: string;
	error?: string;
};

type ReviewHelpers = {
	parseReviewPaths: (value: string) => string[];
	tokenizeArgs: (value: string) => string[];
	parseArgs: (args: string | undefined) => ParsedArgs;
	parsePrReference: (ref: string) => number | null;
	parseMarkdownHeading: (line: string) => { level: number; title: string } | null;
	getFindingsSectionBounds: (lines: string[]) => { start: number; end: number } | null;
	isLikelyFindingLine: (line: string) => boolean;
	normalizeVerdictValue: (value: string) => string;
	isNeedsAttentionVerdictValue: (value: string) => boolean;
	hasNeedsAttentionVerdict: (messageText: string) => boolean;
	hasBlockingReviewFindings: (messageText: string) => boolean;
	getUserFacingHint: (target: ReviewTargetShape) => string;
	extractAssistantTextContent: (content: unknown) => string;
};

async function loadHelpers(): Promise<ReviewHelpers> {
	const module = (await import(SPECIFIER)) as { default?: unknown; __test__?: ReviewHelpers };
	assert.ok(typeof module.default === "function", "review.ts must export a default extension factory");
	assert.ok(module.__test__ !== undefined, "review.ts must export __test__ (see the file header)");
	return module.__test__ as ReviewHelpers;
}

test("review.ts loads under strict ESM with a __test__ export", async () => {
	// The load guard itself: fail at import time on a removed pi symbol, and
	// keep the __test__ tail load-bearing for the behavior tests below.
	await loadHelpers();
});

test("tokenizeArgs splits on whitespace and honours quoted spans", async () => {
	const { tokenizeArgs } = await loadHelpers();
	assert.deepEqual(tokenizeArgs("branch main"), ["branch", "main"]);
	assert.deepEqual(tokenizeArgs('--extra "focus on perf"'), ["--extra", "focus on perf"]);
	assert.deepEqual(tokenizeArgs("--extra 'focus on perf'"), ["--extra", "focus on perf"]);
	assert.deepEqual(tokenizeArgs('say "hello\\" world"'), ["say", 'hello" world']);
	assert.deepEqual(tokenizeArgs(""), []);
});

test("parseArgs resolves every review mode", async () => {
	const { parseArgs } = await loadHelpers();
	assert.deepEqual(parseArgs(undefined), { target: null });
	assert.deepEqual(parseArgs("   "), { target: null });
	assert.deepEqual(parseArgs("uncommitted"), { target: { type: "uncommitted" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("branch main"), { target: { type: "baseBranch", branch: "main" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("branch"), { target: null, extraInstruction: undefined });
	assert.deepEqual(parseArgs("commit abc123"), { target: { type: "commit", sha: "abc123", title: undefined }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("commit abc123 add docs"), { target: { type: "commit", sha: "abc123", title: "add docs" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("folder src docs"), { target: { type: "folder", paths: ["src", "docs"] }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("pr 123"), { target: { type: "pr", ref: "123" }, extraInstruction: undefined });
	assert.deepEqual(parseArgs("bogus"), { target: null, extraInstruction: undefined });
});

test("parseArgs handles --extra and reports a missing value", async () => {
	const { parseArgs } = await loadHelpers();
	assert.deepEqual(parseArgs("--extra focus uncommitted"), { target: { type: "uncommitted" }, extraInstruction: "focus" });
	assert.deepEqual(parseArgs('--extra "focus on perf" uncommitted'), { target: { type: "uncommitted" }, extraInstruction: "focus on perf" });
	assert.deepEqual(parseArgs("--extra=perf uncommitted"), { target: { type: "uncommitted" }, extraInstruction: "perf" });
	assert.deepEqual(parseArgs("--extra"), { target: null, error: "Missing value for --extra" });
});

test("parseReviewPaths splits paths and drops empty entries", async () => {
	const { parseReviewPaths } = await loadHelpers();
	assert.deepEqual(parseReviewPaths("src docs"), ["src", "docs"]);
	assert.deepEqual(parseReviewPaths("  a   b\tc "), ["a", "b", "c"]);
	assert.deepEqual(parseReviewPaths(""), []);
});

test("parsePrReference accepts a number or a GitHub pull URL", async () => {
	const { parsePrReference } = await loadHelpers();
	assert.equal(parsePrReference("123"), 123);
	assert.equal(parsePrReference(" 789 "), 789);
	assert.equal(parsePrReference("https://github.com/owner/repo/pull/123"), 123);
	assert.equal(parsePrReference("github.com/owner/repo/pull/456"), 456);
	assert.equal(parsePrReference("0"), null);
	assert.equal(parsePrReference("not a pr"), null);
});

test("parseMarkdownHeading reads level and title", async () => {
	const { parseMarkdownHeading } = await loadHelpers();
	assert.deepEqual(parseMarkdownHeading("## Verdict"), { level: 2, title: "Verdict" });
	assert.deepEqual(parseMarkdownHeading("###### Deep ##"), { level: 6, title: "Deep" });
	assert.deepEqual(parseMarkdownHeading("not a heading"), null);
});

test("getFindingsSectionBounds spans only the findings section", async () => {
	const { getFindingsSectionBounds } = await loadHelpers();
	const lines = ["## Findings", "- [P1] auth bypass", "## Verdict", "needs attention"];
	assert.deepEqual(getFindingsSectionBounds(lines), { start: 1, end: 2 });
	assert.equal(getFindingsSectionBounds(["nothing about findings"]), null);
});

test("verdict values normalize and classify", async () => {
	const { normalizeVerdictValue, isNeedsAttentionVerdictValue } = await loadHelpers();
	assert.equal(normalizeVerdictValue("  - needs attention "), "needs attention");
	assert.equal(normalizeVerdictValue("`needs attention`"), "needs attention");
	assert.equal(isNeedsAttentionVerdictValue("needs attention"), true);
	assert.equal(isNeedsAttentionVerdictValue("correct"), false);
	assert.equal(isNeedsAttentionVerdictValue("not needs attention"), false);
	assert.equal(isNeedsAttentionVerdictValue("correct or needs attention"), false);
});

test("hasNeedsAttentionVerdict reads verdict lines and headings", async () => {
	const { hasNeedsAttentionVerdict } = await loadHelpers();
	assert.equal(hasNeedsAttentionVerdict("## Verdict\nneeds attention"), true);
	assert.equal(hasNeedsAttentionVerdict("Verdict: needs attention"), true);
	assert.equal(hasNeedsAttentionVerdict("- Verdict: correct"), false);
	assert.equal(hasNeedsAttentionVerdict("nothing to see"), false);
});

test("hasBlockingReviewFindings requires a tagged P0-P2 finding", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const blocking = ["## Findings", "- [P1] auth bypass in login", "## Verdict", "needs attention"].join("\n");
	assert.equal(hasBlockingReviewFindings(blocking), true);
	const p3Only = ["## Findings", "- [P3] cosmetic nit"].join("\n");
	assert.equal(hasBlockingReviewFindings(p3Only), false);
	assert.equal(hasBlockingReviewFindings(""), false);
});

test("hasBlockingReviewFindings skips [P] tags inside code fences", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const fenced = ["## Findings", "```", "- [P1] auth bypass, shown as example code", "```"].join("\n");
	assert.equal(hasBlockingReviewFindings(fenced), false);
	const unfenced = ["## Findings", "- [P1] auth bypass"].join("\n");
	assert.equal(hasBlockingReviewFindings(unfenced), true);
});

test("hasBlockingReviewFindings falls back to the verdict without tagged findings", async () => {
	const { hasBlockingReviewFindings } = await loadHelpers();
	const untagged = ["## Findings", "- login flow looks suspicious, but untagged", "## Verdict", "needs attention"].join("\n");
	assert.equal(hasBlockingReviewFindings(untagged), true);
	const untaggedCorrect = ["## Findings", "- login flow looks suspicious, but untagged", "## Verdict", "correct"].join("\n");
	assert.equal(hasBlockingReviewFindings(untaggedCorrect), false);
});

test("getUserFacingHint summarises a target", async () => {
	const { getUserFacingHint } = await loadHelpers();
	assert.equal(getUserFacingHint({ type: "uncommitted" }), "current changes");
	assert.equal(getUserFacingHint({ type: "baseBranch", branch: "main" }), "changes against 'main'");
	assert.equal(getUserFacingHint({ type: "commit", sha: "abcdef0123", title: "fix bug" }), "commit abcdef0: fix bug");
	assert.equal(
		getUserFacingHint({ type: "folder", paths: ["src", "docs", "tests", "scripts", "config"] }),
		"folders: src, docs, tests, scripts, config",
	);
	// Titles over 30 chars are trimmed to 27 plus an ellipsis.
	const prHint = getUserFacingHint({ type: "pullRequest", prNumber: 9, baseBranch: "dev", title: "a deliberately long pull request title" });
	assert.equal(prHint.length, 37); // "PR #9: " + 27 chars + "..."
	assert.ok(prHint.startsWith("PR #9: ") && prHint.endsWith("..."));
});

test("extractAssistantTextContent pulls text parts from a message", async () => {
	const { extractAssistantTextContent } = await loadHelpers();
	assert.equal(extractAssistantTextContent("  hello "), "hello");
	assert.equal(
		extractAssistantTextContent([
			{ type: "text", text: "line one" },
			{ type: "tool_use", id: "x", name: "bash" },
			{ type: "text", text: "  line two  " },
		]),
		"line one\n  line two", // parts join verbatim; only the outer edges trim
	);
	assert.equal(extractAssistantTextContent({ not: "content" }), "");
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "review-ext-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function loadReviewExtension() {
	const module = (await import(SPECIFIER)) as {
		default: (pi: unknown) => void;
		__test__: ReviewHelpers;
	};
	return module.default;
}

test("ORCHESTRATION_EVENTS exposes subagentDispatch channel", () => {
	assert.equal(
		(ORCHESTRATION_EVENTS as Record<string, string>).subagentDispatch,
		"orchestrator:subagent-dispatch",
	);
});

test("/review dispatches an isolated reviewer subagent with rubric, guidelines, and inherited model", async () => {
	const reviewExtension = await loadReviewExtension();
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, "REVIEW_GUIDELINES.md"), "Always check fail-fast error propagation.\n", "utf8");

		const host = createFakeHost({
			cwd,
			hasUI: true,
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			exec: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-dir") {
					return { stdout: ".git\n", stderr: "", code: 0, killed: false, truncated: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
			},
		});

		const sendUserMessageCalls: unknown[] = [];
		(host.pi as unknown as Record<string, unknown>).sendUserMessage = (...args: unknown[]) => {
			sendUserMessageCalls.push(args);
		};

		const dispatched: SubagentDispatchPayload[] = [];
		const channel = (ORCHESTRATION_EVENTS as Record<string, string>).subagentDispatch;
		assert.ok(channel, "subagentDispatch channel must exist");
		subscribeOrchestrationEvent(host.pi, channel as never, (rawPayload) => {
			const payload = rawPayload as unknown as SubagentDispatchPayload;
			dispatched.push(payload);
			payload.onAccepted?.();
			payload.onDispatched?.({
				ok: true,
				runId: "rev-run-1",
				provider: "anthropic",
				model: "claude-opus-4-6",
				thinking: "high",
			});
		});

		reviewExtension(host.pi);
		await host.fire("session_start", {});
		await host.runCommand("review", 'uncommitted --extra "focus on auth checks"');

		assert.equal(sendUserMessageCalls.length, 0, "review must never call pi.sendUserMessage");
		assert.equal(host.messages.length, 0, "review must never send session messages directly");
		assert.equal(dispatched.length, 1);

		const req = dispatched[0]!;
		assert.equal(req.role, "reviewer");
		assert.deepEqual(req.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.equal(req.thinking, "high");
		assert.equal(req.handoff, false);
		assert.equal(req.provider, undefined, "provider must be omitted for frontier inheritance");
		assert.equal(req.model, undefined, "model must be omitted for frontier inheritance");
		assert.equal(req.cwd, cwd);
		assert.match(req.task, /# Review Guidelines/);
		assert.match(req.task, /Review the current code changes/);
		assert.match(req.task, /focus on auth checks/);
		assert.match(req.task, /Always check fail-fast error propagation\./);
		assert.ok(
			host.notifications.some((n) => n.message.includes("rev-run-1")),
			"user should be notified with the dispatched runId",
		);

		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev-run-1",
			status: "completed",
			role: "reviewer",
			finishedAt: Date.now(),
		});
		assert.ok(
			host.notifications.some((n) => n.message.includes("rev-run-1") && /completed/i.test(n.message)),
			"user should be notified when the review run settles",
		);
		assert.equal(sendUserMessageCalls.length, 0);
	});
});

test("/review drops /end-review, loop-fixing, and parent-session branch prompts", async () => {
	const reviewExtension = await loadReviewExtension();
	await withTempDir(async (cwd) => {
		const selectPrompts: string[] = [];
		const host = createFakeHost({
			cwd,
			hasUI: true,
			branch: [{ type: "message", id: "m1", message: { role: "user", content: "existing turn" } }],
			exec: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-dir") {
					return { stdout: ".git\n", stderr: "", code: 0, killed: false, truncated: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
			},
		});
		host.ctx.ui.select = async (title: string) => {
			selectPrompts.push(title);
			return undefined;
		};

		const sendUserMessageCalls: unknown[] = [];
		(host.pi as unknown as Record<string, unknown>).sendUserMessage = (...args: unknown[]) => {
			sendUserMessageCalls.push(args);
		};

		const channel = (ORCHESTRATION_EVENTS as Record<string, string>).subagentDispatch;
		assert.ok(channel, "subagentDispatch channel must exist");
		subscribeOrchestrationEvent(host.pi, channel as never, (rawPayload) => {
			const payload = rawPayload as unknown as SubagentDispatchPayload;
			payload.onAccepted?.();
			payload.onDispatched?.({ ok: true, runId: "rev-run-2" });
		});

		reviewExtension(host.pi);
		await host.fire("session_start", {});
		assert.equal(host.commands.has("end-review"), false, "/end-review command must be removed");

		await host.runCommand("review", "uncommitted");
		assert.deepEqual(selectPrompts, [], "should not prompt for Empty branch vs Current session");
		assert.equal(sendUserMessageCalls.length, 0);
	});
});

test("/review notifies with an error when no subagent dispatcher is registered", async () => {
	const reviewExtension = await loadReviewExtension();
	await withTempDir(async (cwd) => {
		const host = createFakeHost({
			cwd,
			hasUI: true,
			exec: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-dir") {
					return { stdout: ".git\n", stderr: "", code: 0, killed: false, truncated: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
			},
		});
		const sendUserMessageCalls: unknown[] = [];
		(host.pi as unknown as Record<string, unknown>).sendUserMessage = (...args: unknown[]) => {
			sendUserMessageCalls.push(args);
		};

		reviewExtension(host.pi);
		await host.fire("session_start", {});
		await host.runCommand("review", "uncommitted");

		assert.equal(sendUserMessageCalls.length, 0);
		assert.ok(
			host.notifications.some((n) => n.type === "error" && /subagent|dispatcher/i.test(n.message)),
			"should notify an error when no subagent dispatcher handles the event",
		);
	});
});

test("reviewExtension + orchestrator delegation marks reviewVerified when dispatched reviewer run settles", async () => {
	const reviewExtension = await loadReviewExtension();
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		const host = createFakeHost({
			cwd,
			hasUI: true,
			trusted: true,
			model: { provider: "anthropic", id: "claude-opus-4-6" },
			exec: async (command, args) => {
				if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-dir") {
					return { stdout: ".git\n", stderr: "", code: 0, killed: false, truncated: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
			},
		});

		orchestratorExtension(host.pi, { role: "parent" });
		reviewExtension(host.pi);

		const channel = (ORCHESTRATION_EVENTS as Record<string, string>).subagentDispatch;
		assert.ok(channel, "subagentDispatch channel must exist");
		let dispatchedRunId = "";
		let dispatchedStartedAt = 0;
		subscribeOrchestrationEvent(host.pi, channel as never, (rawPayload) => {
			const payload = rawPayload as unknown as SubagentDispatchPayload;
			dispatchedRunId = "rev-int-1";
			dispatchedStartedAt = Date.now();
			payload.onAccepted?.();
			publishOrchestrationEvent(host.pi, ORCHESTRATION_EVENTS.runStarted, {
				runId: dispatchedRunId,
				status: "running",
				role: payload.role,
				provider: "anthropic",
				model: "claude-opus-4-6",
				startedAt: dispatchedStartedAt,
				at: dispatchedStartedAt,
			});
			payload.onDispatched?.({
				ok: true,
				runId: dispatchedRunId,
				provider: "anthropic",
				model: "claude-opus-4-6",
				thinking: payload.thinking,
			});
		});

		await host.fire("session_start", {});
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Implement multi-file change",
			systemPrompt: "base",
			systemPromptOptions: { sections: {} },
		});

		const editTime = Date.now() - 100;
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "coder-1",
			status: "completed",
			role: "coder",
			startedAt: editTime,
			finishedAt: editTime + 20,
			activitySummary: {
				editedFiles: [
					{ path: "src/a.ts", changedLines: 10 },
					{ path: "src/b.ts", changedLines: 10 },
				],
				passedCommands: [{ command: "node --test", at: editTime + 15 }],
				lastEditAt: editTime + 10,
			},
		});

		const blocked = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'wip'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /code-review/);

		await host.runCommand("review", "uncommitted");
		assert.equal(dispatchedRunId, "rev-int-1");

		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: dispatchedRunId,
			status: "completed",
			role: "reviewer",
			startedAt: dispatchedStartedAt,
			finishedAt: dispatchedStartedAt + 50,
		});

		const allowed = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat'" },
		});
		assert.equal(allowed, undefined, "git commit should succeed once reviewer run settles");

		// Small follow-up edit re-arms the review gate and /review satisfies it again
		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/a.ts", oldText: "x", newText: "y" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "x", newText: "y" },
			isError: false,
			content: [],
		});
		await host.fire("tool_result", { toolName: "bash", input: { command: "node --test" }, isError: false, content: [] });

		const reblocked = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'follow-up'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(reblocked?.block, true);
		assert.match(reblocked?.reason ?? "", /code-review/);

		await host.runCommand("review", "uncommitted");
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: dispatchedRunId,
			status: "completed",
			role: "reviewer",
			startedAt: dispatchedStartedAt,
			finishedAt: dispatchedStartedAt + 50,
		});
		assert.equal(
			await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'follow-up'" } }),
			undefined,
		);
	});
});

test("subagent extension handles ORCHESTRATION_EVENTS.subagentDispatch and emits runStarted/runSettled", async () => {
	await withHarness({}, async (h) => {
		const channel = (ORCHESTRATION_EVENTS as Record<string, string>).subagentDispatch;
		assert.ok(channel, "subagentDispatch channel must exist");

		let dispatchResult: SubagentDispatchResult | undefined;
		publishOrchestrationEvent(h.pi as never, channel as never, {
			task: "Review uncommitted changes",
			cwd: h.ctx.cwd as string,
			role: "reviewer",
			tools: ["read", "grep", "find", "ls", "bash"],
			thinking: "high",
			handoff: false,
			source: "review-command",
			onDispatched: (res) => {
				dispatchResult = res;
			},
		} as never);

		await waitFor(() => dispatchResult !== undefined);
		assert.equal(dispatchResult?.ok, true);
		assert.ok(dispatchResult?.runId);
		assert.equal(dispatchResult?.provider, "openrouter");
		assert.equal(dispatchResult?.model, "parent/model");
		assert.equal(dispatchResult?.thinking, "high");

		const runs = await h.readRuns();
		const run = runs.find((r) => r.id === dispatchResult?.runId);
		assert.ok(run);
		assert.equal(run.role, "reviewer");
		assert.deepEqual(run.tools, ["read", "grep", "find", "ls", "bash"]);
		assert.equal(run.thinking, "high");
		assert.equal(run.mode, "standalone");

		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "## Verdict\ncorrect\n",
			finishedAt: Date.now(),
		});
		await waitForRunStatus(h, "completed");

		await waitFor(() =>
			h.events.some(
				(e) =>
					e.channel === ORCHESTRATION_EVENTS.runSettled &&
					(e.data as { runId?: string }).runId === run.id,
			),
		);
		const settled = h.events.find(
			(e) =>
				e.channel === ORCHESTRATION_EVENTS.runSettled &&
				(e.data as { runId?: string }).runId === run.id,
		);
		assert.equal((settled?.data as { role?: string; status?: string }).role, "reviewer");
		assert.equal((settled?.data as { role?: string; status?: string }).status, "completed");
	});
});

test("subagent extension reports validation errors via onDispatched on invalid subagentDispatch", async () => {
	await withHarness({}, async (h) => {
		let emptyResult: SubagentDispatchResult | undefined;
		publishOrchestrationEvent(h.pi as never, ORCHESTRATION_EVENTS.subagentDispatch, {
			task: "   ",
			role: "reviewer",
			onDispatched: (res) => {
				emptyResult = res;
			},
		});
		await waitFor(() => emptyResult !== undefined);
		assert.equal(emptyResult?.ok, false);
		assert.match(emptyResult?.error ?? "", /empty/i);

		let badHandoffResult: SubagentDispatchResult | undefined;
		publishOrchestrationEvent(h.pi as never, ORCHESTRATION_EVENTS.subagentDispatch, {
			task: "Review changes",
			role: "reviewer",
			handoff: "invalid-mode" as never,
			onDispatched: (res) => {
				badHandoffResult = res;
			},
		});
		await waitFor(() => badHandoffResult !== undefined);
		assert.equal(badHandoffResult?.ok, false);
		assert.match(badHandoffResult?.error ?? "", /handoff/i);
	});
});
