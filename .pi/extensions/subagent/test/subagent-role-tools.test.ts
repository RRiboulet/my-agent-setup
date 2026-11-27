import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	ORCHESTRATION_EVENTS,
	type ChildActivitySummary,
	type RunSettledPayload,
	type RunStartedPayload,
} from "../../orchestrator/events.ts";
import { buildChildPiArgs, type ChildLaunchSpec } from "../handoff.ts";
import subagentExtension, { __test__, type RunRecord } from "../index.ts";
import { validateChildResult } from "../result.ts";
import { createFakeHost } from "./fake-pi.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { waitForRunStatus, withHarness } from "./lifecycle-harness.ts";

const BASE_SPEC: ChildLaunchSpec = {
	mode: "standalone",
	invocation: ["node", "/usr/lib/pi.js"],
	provider: "openrouter",
	model: "some/model",
	thinking: "medium",
	sessionDir: "/run/session",
	sessionId: "run-123",
	tmuxSession: "pi-agent-abc",
	trusted: false,
	extensionPath: "/ext/index.ts",
	promptPath: "/run/task.md",
};

function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

test("buildChildPiArgs emits --tools when tools is non-empty and omits it when empty or absent", () => {
	const withTools = buildChildPiArgs({ ...BASE_SPEC, tools: ["read", "grep", "find", "ls"] });
	assert.equal(flagValue(withTools, "--tools"), "read,grep,find,ls");
	assert.equal(withTools.at(-1), "@/run/task.md");

	const sanitized = buildChildPiArgs({ ...BASE_SPEC, tools: [" read ", "", "  ", "grep "] });
	assert.equal(flagValue(sanitized, "--tools"), "read,grep");

	const omitted = buildChildPiArgs({ ...BASE_SPEC });
	assert.equal(omitted.includes("--tools"), false);

	const empty = buildChildPiArgs({ ...BASE_SPEC, tools: [] });
	assert.equal(empty.includes("--tools"), false);

	const whitespaceOnly = buildChildPiArgs({ ...BASE_SPEC, tools: [" ", ""] });
	assert.equal(whitespaceOnly.includes("--tools"), false);
});

test("validateChildResult preserves valid activitySummary and drops malformed ones without failing", () => {
	const validSummary: ChildActivitySummary = {
		editedFiles: [{ path: "src/app.ts", changedLines: 12 }],
		passedCommands: [{ command: "npm test", at: 1_700_000_000_123 }],
		lastEditAt: 1_700_000_000_100,
	};

	const valid = validateChildResult({
		version: 1,
		status: "completed",
		output: "done",
		finishedAt: 1_700_000_000_500,
		activitySummary: validSummary,
	});
	assert.equal(valid.ok, true);
	if (valid.ok) {
		assert.deepEqual(valid.result.activitySummary, validSummary);
	}

	const malformedVariants: unknown[] = [
		"not-an-object",
		[],
		null,
		{ editedFiles: "nope", passedCommands: [] },
		{ editedFiles: [], passedCommands: "nope" },
		{ editedFiles: [{ path: 123, changedLines: 1 }], passedCommands: [] },
		{ editedFiles: [{ path: "a.ts", changedLines: -1 }], passedCommands: [] },
		{ editedFiles: [], passedCommands: [{ command: "ls", at: "bad" }] },
		{ editedFiles: [], passedCommands: [], lastEditAt: Number.NaN },
	];

	for (const malformed of malformedVariants) {
		const parsed = validateChildResult({
			version: 1,
			status: "completed",
			output: "still valid",
			finishedAt: 1_700_000_000_500,
			activitySummary: malformed,
		});
		assert.equal(parsed.ok, true, `malformed activitySummary (${JSON.stringify(malformed)}) must not fail result`);
		if (parsed.ok) {
			assert.equal(
				parsed.result.activitySummary,
				undefined,
				`malformed activitySummary (${JSON.stringify(malformed)}) must be dropped`,
			);
		}
	}
});

test("single subagent run preserves role/tools, passes --tools, and emits enriched lifecycle payloads", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", {
			task: "inspect repo",
			role: "explore",
			tools: ["read", "grep", "find", "ls"],
		});
		const run = started.details as unknown as RunRecord & { role?: string; tools?: string[] };
		assert.equal(run.role, "explore");
		assert.deepEqual(run.tools, ["read", "grep", "find", "ls"]);

		const childCommand = h.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.find((arg) => typeof arg === "string" && arg.includes("--provider"));
		assert.ok(childCommand, "child command was sent");
		assert.match(childCommand, /--tools['"]?\s+['"]?read,grep,find,ls,subagent_ask(?:\s|['"]|$)/);

		const startedEvent = h.events.find((e) => e.channel === ORCHESTRATION_EVENTS.runStarted);
		assert.ok(startedEvent, "orchestrator:run-started was emitted");
		const startedPayload = startedEvent!.data as RunStartedPayload;
		assert.equal(startedPayload.runId, run.id);
		assert.equal(startedPayload.role, "explore");
		assert.equal(startedPayload.provider, run.provider);
		assert.equal(startedPayload.model, run.model);
		assert.equal(startedPayload.startedAt, run.createdAt);

		const activitySummary: ChildActivitySummary = {
			editedFiles: [{ path: "src/index.ts", changedLines: 5 }],
			passedCommands: [{ command: "node --test", at: 1_700_000_001_000 }],
			lastEditAt: 1_700_000_000_900,
		};
		await h.writeResult(run as never, {
			version: 1,
			status: "completed",
			output: "all good",
			finishedAt: Date.now(),
			activitySummary,
		});
		await waitForRunStatus(h, "completed");

		const persistedRun = (await h.readRuns()).find((r) => r.id === run.id) as
			| (RunRecord & { role?: string; tools?: string[]; activitySummary?: ChildActivitySummary })
			| undefined;
		assert.equal(persistedRun?.role, "explore");
		assert.deepEqual(persistedRun?.tools, ["read", "grep", "find", "ls"]);
		assert.deepEqual(persistedRun?.activitySummary, activitySummary);

		await waitFor(() => h.events.some((e) => e.channel === ORCHESTRATION_EVENTS.runSettled));
		const settledEvent = h.events.find((e) => e.channel === ORCHESTRATION_EVENTS.runSettled);
		const settledPayload = settledEvent!.data as RunSettledPayload;
		assert.equal(settledPayload.runId, run.id);
		assert.equal(settledPayload.role, "explore");
		assert.equal(settledPayload.provider, run.provider);
		assert.equal(settledPayload.model, run.model);
		assert.equal(settledPayload.startedAt, run.startedAt ?? run.createdAt);
		assert.deepEqual(settledPayload.activitySummary, activitySummary);
	});
});

test("plan tasks[] preserve role and tools across launch and retries and emit enriched payloads", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", {
			tasks: [
				{
					id: "explore-step",
					task: "explore files",
					role: "explore",
					tools: ["read", "grep"],
					retries: 1,
				},
				{
					id: "coder-step",
					task: "edit files",
					role: "coder",
					dependsOn: ["explore-step"],
				},
			],
		});

		const plans = await h.readPlans();
		assert.equal(plans.length, 1);
		const step1Spec = plans[0]!.steps.find((s) => s.id === "explore-step") as
			| { role?: string; tools?: string[] }
			| undefined;
		const step2Spec = plans[0]!.steps.find((s) => s.id === "coder-step") as
			| { role?: string; tools?: string[] }
			| undefined;
		assert.equal(step1Spec?.role, "explore");
		assert.deepEqual(step1Spec?.tools, ["read", "grep"]);
		assert.equal(step2Spec?.role, "coder");
		assert.equal(step2Spec?.tools, undefined);

		const initialRun = (started.details.runs as (RunRecord & { role?: string; tools?: string[] })[])[0]!;
		assert.equal(initialRun.role, "explore");
		assert.deepEqual(initialRun.tools, ["read", "grep"]);

		const sendKeysArgs = (): string[] =>
			h.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"));

		assert.match(sendKeysArgs().at(-1) ?? "", /--tools['"]?\s+['"]?read,grep/);

		// Fail attempt 1 so retry launches attempt 2; retry must keep role/tools.
		await h.writeResult(initialRun, {
			version: 1,
			status: "failed",
			output: "",
			error: "transient failure",
			finishedAt: Date.now(),
		});
		await waitFor(async () => {
			const runs = await h.readRuns();
			return runs.filter((r) => r.stepId === "explore-step").length === 2;
		});

		const runsAfterRetry = await h.readRuns();
		const retryRun = runsAfterRetry.find(
			(r) => r.stepId === "explore-step" && r.id !== initialRun.id,
		) as (RunRecord & { role?: string; tools?: string[] }) | undefined;
		assert.ok(retryRun, "retry run was created");
		assert.equal(retryRun!.role, "explore");
		assert.deepEqual(retryRun!.tools, ["read", "grep"]);
		assert.match(sendKeysArgs().at(-1) ?? "", /--tools['"]?\s+['"]?read,grep/);

		const retrySummary: ChildActivitySummary = {
			editedFiles: [],
			passedCommands: [{ command: "ls -la", at: 1_700_000_002_000 }],
		};
		await h.writeResult(retryRun!, {
			version: 1,
			status: "completed",
			output: "found it",
			finishedAt: Date.now(),
			activitySummary: retrySummary,
		});

		// Wait for coder-step to launch and verify it does NOT emit --tools.
		await waitFor(async () => (await h.readRuns()).some((r) => r.stepId === "coder-step"));
		const coderCommand = sendKeysArgs().at(-1) ?? "";
		assert.equal(coderCommand.includes("--tools"), false, "step without tools must not emit --tools");

		const settledEvents = h.events.filter((e) => e.channel === ORCHESTRATION_EVENTS.runSettled);
		const retrySettled = settledEvents.find((e) => (e.data as RunSettledPayload).runId === retryRun!.id);
		assert.ok(retrySettled);
		const payload = retrySettled!.data as RunSettledPayload;
		assert.equal(payload.role, "explore");
		assert.deepEqual(payload.activitySummary, retrySummary);
	});
});

test("child activity tracker aggregates edit, write, and bash/powershell and ignores errored calls", () => {
	const tracker = (__test__ as Record<string, unknown>).createChildActivityTracker as () => {
		onStart: (event: { toolCallId: string; toolName: string; args: unknown }) => void;
		onEnd: (event: { toolCallId: string; toolName: string; isError: boolean; result?: unknown }) => void;
		getSummary: () => ChildActivitySummary | undefined;
	};
	assert.equal(typeof tracker, "function");

	const t = tracker();
	assert.equal(t.getSummary(), undefined, "empty tracker returns undefined");

	// edit with edits[] array
	t.onStart({
		toolCallId: "c1",
		toolName: "edit",
		args: {
			path: "src/a.ts",
			edits: [
				{ oldText: "one\ntwo", newText: "one\ntwo\nthree" }, // max(2, 3) = 3
				{ oldText: "x", newText: "y" }, // max(1, 1) = 1
			],
		},
	});
	t.onEnd({ toolCallId: "c1", toolName: "edit", isError: false });

	// edit with flat oldText/newText fallback on same path
	t.onStart({
		toolCallId: "c2",
		toolName: "edit",
		args: { path: "src/a.ts", oldText: "a\nb\nc\nd", newText: "a" }, // max(4, 1) = 4
	});
	t.onEnd({ toolCallId: "c2", toolName: "edit", isError: false });

	// write on new path
	t.onStart({
		toolCallId: "c3",
		toolName: "write",
		args: { path: "src/b.ts", content: "l1\nl2\nl3\n" }, // 3 lines
	});
	t.onEnd({ toolCallId: "c3", toolName: "write", isError: false });

	// errored edit must be ignored
	t.onStart({
		toolCallId: "c4",
		toolName: "edit",
		args: { path: "src/err.ts", oldText: "a", newText: "b" },
	});
	t.onEnd({ toolCallId: "c4", toolName: "edit", isError: true });

	// passing bash command (trimmed + truncated to 512)
	const longCmd = `  ${"x".repeat(600)}  `;
	t.onStart({ toolCallId: "c5", toolName: "bash", args: { command: longCmd } });
	t.onEnd({ toolCallId: "c5", toolName: "bash", isError: false });

	// errored bash command must be ignored
	t.onStart({ toolCallId: "c6", toolName: "bash", args: { command: "false" } });
	t.onEnd({ toolCallId: "c6", toolName: "bash", isError: true });

	// powershell also tracked
	t.onStart({ toolCallId: "c7", toolName: "powershell", args: { command: " Get-Date " } });
	t.onEnd({ toolCallId: "c7", toolName: "powershell", isError: false });

	const summary = t.getSummary();
	assert.ok(summary);
	assert.equal(summary!.editedFiles.length, 2);
	assert.equal(summary!.editedFiles[0]!.path, "src/a.ts");
	assert.equal(summary!.editedFiles[0]!.changedLines, 8);
	assert.equal(typeof summary!.editedFiles[0]!.lastEditAt, "number");
	assert.equal(summary!.editedFiles[1]!.path, "src/b.ts");
	assert.equal(summary!.editedFiles[1]!.changedLines, 3);
	assert.equal(typeof summary!.editedFiles[1]!.lastEditAt, "number");
	assert.equal(summary!.passedCommands.length, 2);
	assert.equal(summary!.passedCommands[0]!.command, "x".repeat(512));
	assert.equal(summary!.passedCommands[1]!.command, "Get-Date");
	assert.equal(typeof summary!.lastEditAt, "number");

	// passedCommands capped to latest 50 entries
	for (let i = 0; i < 60; i++) {
		t.onStart({ toolCallId: `b-${i}`, toolName: "bash", args: { command: `cmd-${i}` } });
		t.onEnd({ toolCallId: `b-${i}`, toolName: "bash", isError: false });
	}
	const capped = t.getSummary()!;
	assert.equal(capped.passedCommands.length, 50);
	assert.equal(capped.passedCommands[0]!.command, "cmd-10");
	assert.equal(capped.passedCommands.at(-1)!.command, "cmd-59");
});

test("childMode reporter writes activitySummary into result.json and omits when empty", async () => {
	await withTempAgentDir(async () => {
		const runDir = await mkdtemp(path.join(tmpdir(), "subagent-child-activity-"));
		try {
			const resultPath = path.join(runDir, "result.json");
			const host = createFakeHost({
				branch: [{ type: "message", message: { role: "assistant", content: "finished work", stopReason: "stop" } }],
			});
			Object.assign(host.pi as Record<string, unknown>, {
				getThinkingLevel: () => "medium",
			});
			Object.assign(host.ctx as unknown as Record<string, unknown>, {
				shutdown: () => undefined,
			});

			await withEnv(
				{
					PI_TMUX_SUBAGENT_CHILD: "1",
					PI_TMUX_SUBAGENT_RESULT: resultPath,
					PI_TMUX_SUBAGENT_INTERRUPT: undefined,
					PI_TMUX_SUBAGENT_ESCALATION: undefined,
				},
				async () => {
					subagentExtension(host.pi);
				},
			);

			await host.fire("tool_execution_start", {
				toolCallId: "t1",
				toolName: "write",
				args: { path: "foo.ts", content: "a\nb" },
			});
			await host.fire("tool_execution_end", { toolCallId: "t1", toolName: "write", isError: false, result: {} });
			await host.fire("tool_execution_start", {
				toolCallId: "t2",
				toolName: "bash",
				args: { command: "echo ok" },
			});
			await host.fire("tool_execution_end", { toolCallId: "t2", toolName: "bash", isError: false, result: {} });
			await host.fire("tool_execution_start", {
				toolCallId: "t3",
				toolName: "bash",
				args: { command: "exit 1" },
			});
			await host.fire("tool_execution_end", { toolCallId: "t3", toolName: "bash", isError: true, result: {} });
			await host.fire("agent_settled");

			const written = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
			const summary = written.activitySummary as ChildActivitySummary | undefined;
			assert.ok(summary, "activitySummary is written to result.json");
			assert.equal(summary!.editedFiles.length, 1);
			assert.equal(summary!.editedFiles[0]!.path, "foo.ts");
			assert.equal(summary!.editedFiles[0]!.changedLines, 2);
			assert.equal(typeof summary!.editedFiles[0]!.lastEditAt, "number");
			assert.equal(summary!.passedCommands.length, 1);
			assert.equal(summary!.passedCommands[0]!.command, "echo ok");

			// Empty case omits activitySummary
			const emptyResultPath = path.join(runDir, "empty-result.json");
			const emptyHost = createFakeHost({
				branch: [{ type: "message", message: { role: "assistant", content: "read only", stopReason: "stop" } }],
			});
			Object.assign(emptyHost.pi as Record<string, unknown>, { getThinkingLevel: () => "medium" });
			Object.assign(emptyHost.ctx as unknown as Record<string, unknown>, { shutdown: () => undefined });

			await withEnv(
				{
					PI_TMUX_SUBAGENT_CHILD: "1",
					PI_TMUX_SUBAGENT_RESULT: emptyResultPath,
					PI_TMUX_SUBAGENT_INTERRUPT: undefined,
					PI_TMUX_SUBAGENT_ESCALATION: undefined,
				},
				async () => {
					subagentExtension(emptyHost.pi);
				},
			);
			await emptyHost.fire("tool_execution_start", { toolCallId: "r1", toolName: "read", args: { path: "foo.ts" } });
			await emptyHost.fire("tool_execution_end", { toolCallId: "r1", toolName: "read", isError: false, result: {} });
			await emptyHost.fire("agent_settled");

			const emptyWritten = JSON.parse(await readFile(emptyResultPath, "utf8")) as Record<string, unknown>;
			assert.equal("activitySummary" in emptyWritten, false, "empty activitySummary must be omitted");
		} finally {
			await rm(runDir, { recursive: true, force: true });
		}
	});
});

test("single subagent run with modifier tools preserves modifier syntax and omits subagent_ask", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", {
			task: "inspect without write/edit",
			tools: ["-write", "-edit"],
		});
		const run = started.details as unknown as RunRecord & { tools?: string[] };
		assert.deepEqual(run.tools, ["-write", "-edit"]);

		const childCommand = h.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.find((arg) => typeof arg === "string" && arg.includes("--provider"));
		assert.ok(childCommand, "child command was sent");
		assert.match(childCommand, /--tools['"]?\s+['"]?-write,-edit(?:\s|['"]|$)/);
		assert.equal(childCommand.includes("subagent_ask"), false);

		const filtered = await h.call("subagent", {
			task: "filter explicit -subagent_ask from modifier list",
			tools: ["-write", "-edit", "-subagent_ask"],
		});
		const filteredRun = filtered.details as unknown as RunRecord & { tools?: string[] };
		assert.deepEqual(filteredRun.tools, ["-write", "-edit", "-subagent_ask"]);
		const filteredCommand = h.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"))
			.at(-1);
		assert.ok(filteredCommand, "second child command was sent");
		assert.match(filteredCommand, /--tools['"]?\s+['"]?-write,-edit(?:\s|['"]|$)/);
		assert.equal(filteredCommand.includes("subagent_ask"), false);
	});
});

test("single subagent run forwards minimal startup flags, persists trimmed skills, and preserves skills on resume", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", {
			task: "run with skills",
			skills: [" skills/tdd/SKILL.md ", "", "  ", "/abs/skills/review/SKILL.md", "skills/tdd/SKILL.md"],
		});
		const run = started.details as unknown as RunRecord & { skills?: string[] };
		assert.deepEqual(run.skills, ["skills/tdd/SKILL.md", "/abs/skills/review/SKILL.md"]);

		const childCommand = h.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.find((arg) => typeof arg === "string" && arg.includes("--provider"));
		assert.ok(childCommand, "child command was sent");
		for (const flag of ["--no-extensions", "--no-skills", "--no-mcp", "--no-prompt-templates", "--no-themes"]) {
			assert.ok(childCommand.includes(flag), `child command must include ${flag}`);
		}
		assert.match(childCommand, /--skill['"]?\s+['"]?skills\/tdd\/SKILL\.md['"]?/);
		assert.match(childCommand, /--skill['"]?\s+['"]?\/abs\/skills\/review\/SKILL\.md['"]?/);
		assert.match(childCommand, /@[^\s]*task\.md['"]?$/);

		// Finish run with an existing session file, then resume and verify skills persist onto resumed run and command.
		const sessionFile = path.join(run.runDir, "session", "standalone.jsonl");
		await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: run.id, timestamp: new Date().toISOString(), cwd: run.cwd })}\n`, "utf8");
		await h.writeResult(run as never, {
			version: 1,
			status: "completed",
			output: "first pass done",
			finishedAt: Date.now(),
			sessionFile,
		});
		await waitForRunStatus(h, "completed");

		const resumed = await h.call("subagent_resume", {
			id: run.id,
			message: "continue with same skills",
		});
		const resumedRun = resumed.details as unknown as RunRecord & { skills?: string[] };
		assert.deepEqual(resumedRun.skills, ["skills/tdd/SKILL.md", "/abs/skills/review/SKILL.md"]);

		const resumedCommand = h.execCalls
			.filter((call) => call.args.includes("send-keys"))
			.flatMap((call) => call.args)
			.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"))
			.at(-1);
		assert.ok(resumedCommand, "resumed child command was sent");
		assert.match(resumedCommand, /--skill['"]?\s+['"]?skills\/tdd\/SKILL\.md['"]?/);
		assert.match(resumedCommand, /--skill['"]?\s+['"]?\/abs\/skills\/review\/SKILL\.md['"]?/);
	});
});

test("plan tasks[] preserve skills across launch and retries", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", {
			tasks: [
				{
					id: "skill-step",
					task: "step with skills",
					skills: [" skills/tdd/SKILL.md ", "skills/tdd/SKILL.md"],
					retries: 1,
				},
				{
					id: "plain-step",
					task: "step without skills",
					dependsOn: ["skill-step"],
				},
			],
		});

		const initialRun = (started.details.runs as (RunRecord & { skills?: string[] })[])[0]!;
		assert.deepEqual(initialRun.skills, ["skills/tdd/SKILL.md"]);

		const sendKeysArgs = (): string[] =>
			h.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"));

		assert.match(sendKeysArgs().at(-1) ?? "", /--skill['"]?\s+['"]?skills\/tdd\/SKILL\.md['"]?/);

		await h.writeResult(initialRun, {
			version: 1,
			status: "failed",
			output: "",
			error: "retry me",
			finishedAt: Date.now(),
		});
		await waitFor(async () => {
			const runs = await h.readRuns();
			return runs.filter((r) => r.stepId === "skill-step").length === 2;
		});

		const runsAfterRetry = await h.readRuns();
		const retryRun = runsAfterRetry.find(
			(r) => r.stepId === "skill-step" && r.id !== initialRun.id,
		) as (RunRecord & { skills?: string[] }) | undefined;
		assert.ok(retryRun, "retry run created");
		assert.deepEqual(retryRun!.skills, ["skills/tdd/SKILL.md"]);
		assert.match(sendKeysArgs().at(-1) ?? "", /--skill['"]?\s+['"]?skills\/tdd\/SKILL\.md['"]?/);

		await h.writeResult(retryRun!, {
			version: 1,
			status: "completed",
			output: "ok",
			finishedAt: Date.now(),
		});
		await waitFor(() => sendKeysArgs().length === 3);
		const plainCommand = sendKeysArgs().at(-1) ?? "";
		assert.equal(
			/(?:^|\s|['"])--skill(?:\s|['"]|$)/.test(plainCommand),
			false,
			"step without skills must not emit --skill",
		);
	});
});

test("PI_SUBAGENT_WORKER_EXTENSIONS and opencode-go auto-extension are forwarded and deduplicated", async () => {
	await withHarness({}, async (h) => {
		const sep = path.delimiter;
		const subagentExt = path.resolve(import.meta.dirname, "..", "index.ts");
		const opencodeExt = path.resolve(import.meta.dirname, "..", "..", "opencode-go-provider", "index.ts");

		// 1. Default provider (openrouter): only PI_SUBAGENT_WORKER_EXTENSIONS + subagent extension.
		await withEnv(
			{
				PI_SUBAGENT_WORKER_EXTENSIONS: `${subagentExt}, /ext/custom-a.ts${sep}/ext/custom-b.ts${sep} /ext/custom-a.ts`,
			},
			async () => {
				await h.call("subagent", { task: "with configured worker extensions" });
			},
		);

		const sendKeysCommands = (): string[] =>
			h.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"));

		const firstCmd = sendKeysCommands().at(-1) ?? "";
		assert.equal(firstCmd.split("--extension").length - 1, 3, `expected subagent + 2 extra extensions in: ${firstCmd}`);
		assert.ok(firstCmd.includes("/ext/custom-a.ts"), "custom-a included");
		assert.ok(firstCmd.includes("/ext/custom-b.ts"), "custom-b included");
		assert.equal(firstCmd.includes("opencode-go-provider"), false, "openrouter run must not load opencode-go-provider");

		// 2. opencode-go provider auto-includes local opencode-go-provider/index.ts once, even if duplicated in env.
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		};
		await withEnv(
			{
				PI_SUBAGENT_WORKER_EXTENSIONS: opencodeExt,
			},
			async () => {
				await h.call("subagent", {
					task: "opencode-go task",
					provider: "opencode-go",
					model: "hy4-flash-free",
				});
			},
		);
		const secondCmd = sendKeysCommands().at(-1) ?? "";
		assert.equal(secondCmd.split("--extension").length - 1, 2, `expected subagent + deduplicated opencode-go-provider in: ${secondCmd}`);
		assert.ok(secondCmd.includes(opencodeExt), "opencode-go-provider included");
	});
});

test("PI_SUBAGENT_WORKER_EXTENSIONS preserves scheme specifiers without splitting on scheme colons or resolving paths", async () => {
	await withHarness({}, async (h) => {
		const sendKeysCommands = (): string[] =>
			h.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"));

		await withEnv(
			{
				PI_SUBAGENT_WORKER_EXTENSIONS: "builtin:llama.cpp,/tmp/custom-ext.ts",
			},
			async () => {
				await h.call("subagent", { task: "with builtin and path worker extensions" });
			},
		);

		const cmd = sendKeysCommands().at(-1) ?? "";
		assert.equal(cmd.split("--extension").length - 1, 3, `expected subagent + 2 worker extensions in: ${cmd}`);
		assert.match(cmd, /--extension['"]?\s+['"]?builtin:llama\.cpp['"]?(?:\s|$)/);
		assert.match(cmd, /--extension['"]?\s+['"]?\/tmp\/custom-ext\.ts['"]?(?:\s|$)/);

		const schemeSpecifiers = [
			"builtin:llama.cpp",
			"npm:@org/worker-ext",
			"git:https://github.com/org/repo.git",
			"http://localhost:8080/ext.ts",
			"https://example.com:8443/ext.ts",
			"file:///tmp/file-ext.ts",
			"/tmp/custom-ext.ts",
		];
		await withEnv(
			{
				PI_SUBAGENT_WORKER_EXTENSIONS: schemeSpecifiers.join(","),
			},
			async () => {
				await h.call("subagent", { task: "with all scheme specifiers" });
			},
		);

		const schemesCmd = sendKeysCommands().at(-1) ?? "";
		assert.equal(
			schemesCmd.split("--extension").length - 1,
			1 + schemeSpecifiers.length,
			`expected subagent + ${schemeSpecifiers.length} worker extensions in: ${schemesCmd}`,
		);
		for (const spec of schemeSpecifiers) {
			assert.ok(schemesCmd.includes(spec), `expected verbatim specifier ${spec} in: ${schemesCmd}`);
		}
	});
});

test(
	"PI_SUBAGENT_WORKER_EXTENSIONS splits colon-delimited entries without breaking git SSH, URL ports, or scheme colons",
	{ skip: path.delimiter === ";" },
	async () => {
		const colonDelimitedCases: ReadonlyArray<[string, readonly string[]]> = [
			["git:git@github.com:org/repo.git:/tmp/custom-ext.ts", ["git:git@github.com:org/repo.git", "/tmp/custom-ext.ts"]],
			["git:github.com/org/repo@v1.0.0:/tmp/custom-ext.ts", ["git:github.com/org/repo@v1.0.0", "/tmp/custom-ext.ts"]],
			["http://localhost:8080:/tmp/custom-ext.ts", ["http://localhost:8080", "/tmp/custom-ext.ts"]],
			["https://example.com/ext.ts:123/other.ts", ["https://example.com/ext.ts", "123/other.ts"]],
			["builtin:llama.cpp:/tmp/custom-ext.ts", ["builtin:llama.cpp", "/tmp/custom-ext.ts"]],
		];

	for (const [envValue, expectedSpecs] of colonDelimitedCases) {
		await withHarness({}, async (h) => {
			await withEnv(
				{
					PI_SUBAGENT_WORKER_EXTENSIONS: envValue,
				},
				async () => {
					await h.call("subagent", { task: `colon-delimited ${envValue}` });
				},
			);
			const commands = h.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg): arg is string => typeof arg === "string" && arg.includes("--provider"));
			assert.equal(commands.length, 1, `expected single launch command for ${envValue}`);
			const colonCmd = commands[0] ?? "";
			assert.equal(
				colonCmd.split("--extension").length - 1,
				1 + expectedSpecs.length,
				`expected subagent + ${expectedSpecs.length} worker extensions for ${envValue} in: ${colonCmd}`,
			);
			for (const spec of expectedSpecs) {
				const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				assert.match(
					colonCmd,
					new RegExp(`--extension['"]?\\s+['"]?${escaped}['"]?(?:\\s|$)`),
					`expected exact specifier ${spec} for ${envValue} in: ${colonCmd}`,
				);
			}
		});
	}
});
