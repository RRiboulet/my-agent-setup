import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	DELEGATION_CONFIG_ENV,
	DELEGATION_ENV,
	DELEGATION_SECTION,
	RECORD_REVIEW_TOOL,
} from "../../orchestrator/delegation.ts";
import { DELEGATION_WRITE_ENTRY } from "../../orchestrator/delegation-runtime.ts";
import { ORCHESTRATION_EVENTS } from "../../orchestrator/events.ts";
import { GATE_ENTRY_TYPE, GATE_OVERRIDE_TOOL, type GateVerdict } from "../../orchestrator/gate.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { WAVE_COMMAND } from "../../orchestrator/wave-runtime.ts";
import { createFakeHost, type FakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

async function withIsolatedRuntimeEnv<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "orchestrator-delegation-runtime-"));
	try {
		return await withEnv(
			{
				PI_CODING_AGENT_DIR: path.join(root, ".test-agent-dir"),
				[DELEGATION_CONFIG_ENV]: undefined,
				[DELEGATION_ENV]: undefined,
			},
			() => fn(root),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function startRuntimeHost(
	cwd: string,
	options: {
		role?: "parent" | "worker";
		trusted?: boolean;
		activeTools?: string[];
		branch?: Record<string, unknown>[];
		modelRegistry?: Record<string, unknown>;
	} = {},
): Promise<FakeHost> {
	const branch = options.branch ?? [];
	const host = createFakeHost({
		sessionId: "delegation-runtime-test",
		cwd,
		trusted: options.trusted ?? true,
		model: { provider: "anthropic", id: "claude-opus-4-6" },
		modelRegistry: options.modelRegistry,
		branch,
	});
	if (options.activeTools) {
		let currentActive = [...options.activeTools];
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};
		api.getActiveTools = () => [...currentActive];
		api.setActiveTools = (names: string[]) => {
			currentActive = [...names];
		};
	}
	const origAppend = host.pi.appendEntry.bind(host.pi);
	host.pi.appendEntry = (customType: string, data?: unknown) => {
		origAppend(customType, data);
		branch.push({ type: "custom", id: `e-${branch.length}`, customType, data });
	};
	orchestratorExtension(host.pi, { role: options.role ?? "parent" });
	await host.fire("session_start", {});
	return host;
}

async function startPrompt(host: FakeHost, prompt: string, sections: Record<string, string> = {}): Promise<void> {
	await host.fire("before_agent_start", {
		type: "before_agent_start",
		messageType: "user",
		prompt,
		systemPrompt: "base system prompt",
		systemPromptOptions: { sections },
	});
	await host.fire("turn_start", { turnIndex: 0 });
}

async function fireBoundary(
	host: FakeHost,
	baseEvent: Record<string, unknown> = { entries: [], continue: false, outcome: "completed" },
): Promise<{ entries: unknown[]; continue: boolean }> {
	const handlers = host.handlers.get("agent_before_settle") ?? [];
	let entries: unknown[] = Array.isArray(baseEvent.entries) ? [...baseEvent.entries] : [];
	let shouldContinue = Boolean(baseEvent.continue);
	for (const handler of handlers) {
		const res = (await handler({ ...baseEvent, entries, continue: shouldContinue }, host.ctx)) as
			| { entries?: unknown[]; continue?: boolean }
			| undefined;
		if (res?.entries !== undefined) entries = res.entries;
		if (res?.continue !== undefined) shouldContinue = res.continue;
	}
	return { entries, continue: shouldContinue };
}

function nestedCall(
	parentToolCallId: string,
	index: number,
	toolName: string,
	input: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		toolName,
		toolCallId: `${parentToolCallId}/${index}`,
		parentToolCallId,
		input,
		...extra,
	};
}

// --- RB-7: Nested codemode hook parity -------------------------------------

test("RB-7: nested codemode read records viewedFiles for subsequent nested and direct edits, and failed nested read does not", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, { activeTools: ["codemode"] });
		await startPrompt(host, "Fix one bug in src/app.ts");

		// Failed nested read must NOT mark file as viewed
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-1", 1, "read", { path: "src/missing.ts" })),
			undefined,
		);
		await host.fire(
			"tool_result",
			nestedCall("cm-1", 1, "read", { path: "src/missing.ts" }, { isError: true, content: [] }),
		);
		const unreadNestedEdit = (await host.fire(
			"tool_call",
			nestedCall("cm-1", 2, "edit", { path: "src/missing.ts", oldText: "a", newText: "b" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(unreadNestedEdit?.block, true);
		assert.match(unreadNestedEdit?.reason ?? "", /unread/i);

		// Successful nested read records viewedFiles -> subsequent nested edit succeeds
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-2", 1, "read", { path: "src/app.ts" })),
			undefined,
		);
		await host.fire(
			"tool_result",
			nestedCall("cm-2", 1, "read", { path: "src/app.ts" }, { isError: false, content: [] }),
		);
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-2", 2, "edit", { path: "src/app.ts", oldText: "a", newText: "b" })),
			undefined,
		);
		await host.fire(
			"tool_result",
			nestedCall("cm-2", 2, "edit", { path: "src/app.ts", oldText: "a", newText: "b" }, { isError: false, content: [] }),
		);

		// Direct edit on the same nested-read file also sees viewedFiles and edits the same 1 file
		assert.equal(
			await host.fire("tool_call", {
				toolName: "edit",
				toolCallId: "direct-1",
				input: { path: path.join(cwd, "src/app.ts"), oldText: "b", newText: "c" },
			}),
			undefined,
		);
	});
});

test("RB-7: nested codemode discovery tools decrement shared per-turn discovery budget and deny once exhausted", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, { activeTools: ["codemode"] });
		// Security turn mode -> discovery budget = 2
		await startPrompt(host, "Audit auth for security vulnerabilities");

		assert.equal(await host.fire("tool_call", nestedCall("cm-d1", 1, "read", { path: "a.ts" })), undefined);
		assert.equal(await host.fire("tool_call", nestedCall("cm-d1", 2, "grep", { pattern: "secret" })), undefined);

		for (const [idx, [toolName, input]] of (
			[
				["find", { pattern: "*.ts" }],
				["ls", { path: "." }],
				["read", { path: "b.ts" }],
			] as const
		).entries()) {
			const denied = (await host.fire(
				"tool_call",
				nestedCall("cm-d1", idx + 3, toolName, input),
			)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(denied?.block, true, `expected nested ${toolName} to be blocked after budget exhausted`);
			assert.match(denied?.reason ?? "", /Discovery budget exceeded/i);
		}

		// Direct discovery call in the same turn is also blocked
		const directDenied = (await host.fire("tool_call", {
			toolName: "grep",
			input: { pattern: "token" },
		})) as { block?: boolean } | undefined;
		assert.equal(directDenied?.block, true);
	});
});

test("RB-7: nested codemode write, over-cap edit, second-file edit, bash allowlist, and commit/PR gates match top-level guards", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, { activeTools: ["codemode"] });
		await startPrompt(host, "Implement a fix");

		// Read two files via nested calls
		assert.equal(await host.fire("tool_call", nestedCall("cm-w", 1, "read", { path: "src/one.ts" })), undefined);
		await host.fire("tool_result", nestedCall("cm-w", 1, "read", { path: "src/one.ts" }, { isError: false, content: [] }));
		assert.equal(await host.fire("tool_call", nestedCall("cm-w", 2, "read", { path: "src/two.ts" })), undefined);
		await host.fire("tool_result", nestedCall("cm-w", 2, "read", { path: "src/two.ts" }, { isError: false, content: [] }));

		// Nested write blocked
		const nestedWrite = (await host.fire(
			"tool_call",
			nestedCall("cm-w", 3, "write", { path: "src/new.ts", content: "export const x = 1;\n" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(nestedWrite?.block, true);
		assert.match(nestedWrite?.reason ?? "", /coder/);

		// Nested over-cap edit (>20 lines) blocked
		const bigOld = Array.from({ length: 21 }, (_, i) => `old ${i}`).join("\n");
		const bigNew = Array.from({ length: 21 }, (_, i) => `new ${i}`).join("\n");
		const bigNestedEdit = (await host.fire(
			"tool_call",
			nestedCall("cm-w", 4, "edit", { path: "src/one.ts", oldText: bigOld, newText: bigNew }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(bigNestedEdit?.block, true);
		assert.match(bigNestedEdit?.reason ?? "", /cap: 20/);

		// Surgical nested edit on src/one.ts allowed and marks tests required on tool_result
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-w", 5, "edit", { path: "src/one.ts", oldText: "a", newText: "b" })),
			undefined,
		);
		await host.fire(
			"tool_result",
			nestedCall("cm-w", 5, "edit", { path: "src/one.ts", oldText: "a", newText: "b" }, { isError: false, content: [] }),
		);

		// Second-file nested edit blocked
		const secondNestedEdit = (await host.fire(
			"tool_call",
			nestedCall("cm-w", 6, "edit", { path: "src/two.ts", oldText: "x", newText: "y" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(secondNestedEdit?.block, true);
		assert.match(secondNestedEdit?.reason ?? "", /at most 1 file/i);

		// Nested read-only bash allowed; nested mutating/test bash blocked
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-w", 7, "bash", { command: "git status --porcelain" })),
			undefined,
		);
		const deniedBash = (await host.fire(
			"tool_call",
			nestedCall("cm-w", 8, "bash", { command: "npm test" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(deniedBash?.block, true);
		assert.match(deniedBash?.reason ?? "", /coder/);

		// Nested git commit / push / gh pr create / gh pr merge all blocked while tests gate pending
		for (const [idx, cmd] of [
			"git commit -m 'fix'",
			"git push origin feat",
			"gh pr create --fill",
			"gh pr merge 12 --squash",
		].entries()) {
			const gated = (await host.fire(
				"tool_call",
				nestedCall("cm-w", 9 + idx, "bash", { command: cmd }),
			)) as { block?: boolean; reason?: string } | undefined;
			assert.equal(gated?.block, true, `expected nested "${cmd}" to be gated`);
			assert.match(gated?.reason ?? "", /tests/i);
		}
	});
});

test("RB-7: nested codemode subagent enforces mandatory role/fork gating and applies role routing patches in-place", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, {
			activeTools: ["codemode"],
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: true }),
			},
		});
		await startPrompt(host, "Investigate and implement fix");

		// Nested subagent missing role is blocked
		const missingRole = (await host.fire(
			"tool_call",
			nestedCall("cm-s", 1, "subagent", { task: "find files" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(missingRole?.block, true);
		assert.match(missingRole?.reason ?? "", /role/i);

		// Nested subagent with handoff: "fork" is blocked
		const forkBlocked = (await host.fire(
			"tool_call",
			nestedCall("cm-s", 2, "subagent", { role: "explore", task: "search", handoff: "fork" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(forkBlocked?.block, true);
		assert.match(forkBlocked?.reason ?? "", /fork/i);

		// Nested subagent with role: "explore" patches provider/model/thinking/tools in-place
		const exploreInput: Record<string, unknown> = { role: "explore", task: "search routes" };
		assert.equal(await host.fire("tool_call", nestedCall("cm-s", 3, "subagent", exploreInput)), undefined);
		assert.equal(exploreInput.provider, "opencode-go");
		assert.equal(exploreInput.model, "deepseek-v4.1-flash");
		assert.equal(exploreInput.thinking, "medium");
		assert.deepEqual(exploreInput.tools, ["read", "grep", "find", "ls"]);

		// Nested fan-out tasks[] patches each step in-place
		const fanoutInput: Record<string, unknown> = {
			tasks: [
				{ id: "r1", role: "research", task: "read docs" },
				{ id: "c1", role: "coder", task: "implement", dependsOn: ["r1"] },
			],
		};
		assert.equal(await host.fire("tool_call", nestedCall("cm-s", 4, "subagent", fanoutInput)), undefined);
		const steps = fanoutInput.tasks as Record<string, unknown>[];
		assert.equal(steps[0]?.provider, "opencode-go");
		assert.equal(steps[0]?.model, "deepseek-v4.1-flash");
		assert.equal(steps[0]?.thinking, "low");
		assert.equal(steps[1]?.provider, "opencode-go");
		assert.equal(steps[1]?.model, "hy4-flash-free");
		assert.equal(steps[1]?.thinking, "high");
	});
});

test("RB-7: orchestrator_override stays registered with exposure='codemode' under codemode.mode='only' and bypasses nested commit gate", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		// codemode.mode = "only" keeps only codemode (or codemode + tool_search) in activeTools
		const host = await startRuntimeHost(cwd, { activeTools: ["codemode"] });
		const overrideTool = host.tools.get(GATE_OVERRIDE_TOOL);
		assert.ok(overrideTool, "orchestrator_override must be registered in enforce mode");
		assert.equal(overrideTool.exposure, "codemode");

		// Also verify tool_search + codemode active set preserves codemode exposure
		const hostWithSearch = await startRuntimeHost(cwd, { activeTools: ["codemode", "tool_search"] });
		assert.equal(hostWithSearch.tools.get(GATE_OVERRIDE_TOOL)?.exposure, "codemode");

		await startPrompt(host, "Fix one line");
		await host.fire("tool_call", nestedCall("cm-o", 1, "read", { path: "src/a.ts" }));
		await host.fire("tool_result", nestedCall("cm-o", 1, "read", { path: "src/a.ts" }, { isError: false, content: [] }));
		await host.fire("tool_call", nestedCall("cm-o", 2, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }));
		await host.fire(
			"tool_result",
			nestedCall("cm-o", 2, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }, { isError: false, content: [] }),
		);

		// Calling orchestrator_override (as codemode script would) allows one nested git commit
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "override nested commit gate" });
		assert.equal(
			await host.fire("tool_call", nestedCall("cm-o", 3, "bash", { command: "git commit -m 'wip'" })),
			undefined,
		);
	});
});

// --- RB-8: Validated steer-unlock parity -----------------------------------

test("RB-8: bogus or unknown run IDs never increment steer-unlock across interrupt, resume, or answer", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd);
		await startPrompt(host, "Implement feature");

		// Steering unknown/bogus run IDs multiple times must NOT unlock parent writes
		await host.fire("tool_call", { toolName: "subagent_interrupt", toolCallId: "t1", input: { id: "bogus-1" } });
		await host.fire("tool_call", {
			toolName: "subagent_resume",
			toolCallId: "t2",
			input: { id: "bogus-1", message: "try again" },
		});
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "t3",
			input: { id: "bogus-req", answer: "yes" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "t3",
			input: { id: "bogus-req", answer: "yes" },
			isError: true,
			content: [{ type: "text", text: "No subagent question with id bogus-req" }],
		});
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "t4",
			input: { id: "bogus-1", answer: "again" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "t4",
			input: { id: "bogus-1", answer: "again" },
			isError: true,
			content: [{ type: "text", text: "No subagent question with id bogus-1" }],
		});

		const writeStillBlocked = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const x = 1;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(writeStillBlocked?.block, true);
		assert.equal(host.notifications.some((n) => /unlocked/i.test(n.message)), false);
	});
});

test("RB-8: subagent_answer counts alongside interrupt/resume for known runs (via requestId->details or runId), respects lineage, and resets next prompt", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, { activeTools: ["codemode"] });
		await startPrompt(host, "Implement feature");

		// Register known root run via runStarted
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "run-root",
			status: "running",
			at: Date.now(),
		});

		// 1st steer: real subagent_answer schema ({ id: requestId, answer }) resolved via tool_result details.id
		// Note: tool_call carries requestId ("req-1"), not runId — must NOT unlock prematurely, and tool_result counts once.
		await host.fire(
			"tool_call",
			nestedCall("cm-st", 1, "subagent_answer", { id: "req-1", answer: "Use Postgres" }),
		);
		// Declined human confirmation ("Not sent:...") must NOT count
		await host.fire(
			"tool_result",
			nestedCall(
				"cm-st",
				1,
				"subagent_answer",
				{ id: "req-1", answer: "Use Postgres" },
				{
					isError: false,
					content: [{ type: "text", text: "Not sent: the human declined to confirm this answer." }],
					details: { id: "run-root" },
				},
			),
		);
		// Actual delivered answer counts as steer #1
		await host.fire(
			"tool_call",
			nestedCall("cm-st", 2, "subagent_answer", { id: "req-2", answer: "Use Postgres" }),
		);
		await host.fire(
			"tool_result",
			nestedCall(
				"cm-st",
				2,
				"subagent_answer",
				{ id: "req-2", answer: "Use Postgres" },
				{
					isError: false,
					content: [{ type: "text", text: "Answer delivered to subagent run-root." }],
					details: { id: "run-root" },
				},
			),
		);

		// Still locked after 1 valid steer
		const blockedAfterOne = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const x = 1;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedAfterOne?.block, true);

		// Child resumed run shares root lineage
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "run-child",
			status: "running",
			resumeOf: "run-root",
			at: Date.now(),
		});

		// 2nd steer on resumed child (nested subagent_interrupt) unlocks parent edits!
		await host.fire("tool_call", nestedCall("cm-st", 3, "subagent_interrupt", { id: "run-child" }));
		assert.ok(host.notifications.some((n) => /unlocked/i.test(n.message)));

		// Persists across assistant turn_start roundtrips
		await host.fire("turn_start", { turnIndex: 1 });
		assert.equal(
			await host.fire("tool_call", {
				toolName: "write",
				input: { path: "src/new.ts", content: "export const x = 1;\n" },
			}),
			undefined,
		);

		// Resets on next user prompt
		await startPrompt(host, "Next task");
		const relocked = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/another.ts", content: "export const y = 2;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(relocked?.block, true);
	});
});

test("RB-8: runsSnapshot seeds known runs for steer-unlock with two subagent_answer calls", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd);
		// Simulate reload snapshot before prompt
		host.pi.events.emit(ORCHESTRATION_EVENTS.runsSnapshot, {
			runs: [{ runId: "reloaded-run", status: "running" }],
			at: Date.now(),
		});
		await startPrompt(host, "Continue task");

		// Two valid subagent_answer calls (one via details.id, one via direct runId/id) unlock
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "a1",
			input: { id: "req-10", answer: "Proceed" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "a1",
			input: { id: "req-10", answer: "Proceed" },
			isError: false,
			content: [{ type: "text", text: "Answer delivered to subagent reloaded-run." }],
			details: { id: "reloaded-run" },
		});
		// Same toolCallId firing tool_result after tool_call count must not double-count
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "a2",
			input: { id: "reloaded-run", answer: "Confirm" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "a2",
			input: { id: "reloaded-run", answer: "Confirm" },
			isError: false,
			content: [{ type: "text", text: "Answer delivered to subagent reloaded-run." }],
			details: { id: "reloaded-run" },
		});

		assert.equal(
			await host.fire("tool_call", {
				toolName: "write",
				input: { path: "src/unlocked.ts", content: "export const ok = true;\n" },
			}),
			undefined,
		);
	});
});

// --- RB-8: Live-subagent settlement coordination ---------------------------

test("RB-8: default settlement with live workers blocks with subagent_wait guidance in enforce mode and notifies in warn/!direct", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		// Default repo config: no .pi/orchestrator.json (waitForSubagents = false)
		const host = await startRuntimeHost(cwd);
		await startPrompt(host, "Delegate implementation");

		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-worker-1",
			status: "running",
			at: Date.now(),
		});

		// Enforce mode must NOT silently drop live worker on settlement
		const blocked = await fireBoundary(host);
		assert.equal(blocked.continue, true);
		const gateMsg = blocked.entries.find(
			(e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate",
		) as { content?: string } | undefined;
		assert.ok(gateMsg, "expected continuation guidance entry when live worker is active");
		assert.match(gateMsg.content ?? "", /live-worker-1/);
		assert.match(gateMsg.content ?? "", /subagent_wait|subagent_status/);

		// Override skips the live-run block once
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "intentionally leave background worker running" });
		const overridden = await fireBoundary(host);
		assert.notEqual(overridden.continue, true);

		// Once live worker settles (with no pending edits), settlement succeeds cleanly
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "live-worker-1",
			status: "completed",
			role: "explore",
			finishedAt: Date.now(),
		});
		const settledClean = await fireBoundary(host);
		assert.notEqual(settledClean.continue, true);

		// Warn mode and !direct notify instead of blocking when workers are live
		await host.runCommand("delegation", "warn");
		await startPrompt(host, "Another task");
		host.notifications.length = 0;
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-worker-2",
			status: "running",
			at: Date.now(),
		});
		const warnedSettle = await fireBoundary(host);
		assert.notEqual(warnedSettle.continue, true);
		assert.ok(
			host.notifications.some((n) => n.type === "warning" && /live-worker-2/.test(n.message)),
			"warn mode must notify about live workers rather than dropping silently",
		);

		await host.runCommand("delegation", "enforce");
		await startPrompt(host, "!direct work with background run");
		host.notifications.length = 0;
		const directSettle = await fireBoundary(host);
		assert.notEqual(directSettle.continue, true);
		assert.ok(
			host.notifications.some((n) => n.type === "warning" && /live-worker-2/.test(n.message)),
			"!direct must still notify about live workers rather than dropping silently",
		);

		// Aborted outcome does not block or notify
		host.notifications.length = 0;
		const abortedSettle = await fireBoundary(host, { entries: [], continue: false, outcome: "aborted" });
		assert.notEqual(abortedSettle.continue, true);
		assert.equal(host.notifications.length, 0);
	});
});

test("RB-8: waitForSubagents parks cleanly when only delegation gates are pending and wakes when live worker settles", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { waitForSubagents: true, openTodos: false, repeatedFailure: false, loops: false },
			}),
		);
		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, { branch });
		await startPrompt(host, "Implement change");

		// Parent edits file -> delegation tests gate is pending
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/app.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		// Live worker starts
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-park-1",
			status: "running",
			at: Date.now(),
		});

		// Settlement parks cleanly without spending delegation settle attempts
		const boundary = await fireBoundary(host);
		assert.notEqual(boundary.continue, true);
		assert.equal(
			boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			false,
		);
		const gateVerdict = boundary.entries.find(
			(e) => (e as { customType?: string }).customType === GATE_ENTRY_TYPE,
		) as { data?: GateVerdict } | undefined;
		assert.ok(gateVerdict?.data);

		// When live worker settles, the parked parent wakes to complete verification
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "live-park-1",
			status: "completed",
			role: "explore",
			finishedAt: Date.now(),
		});
		const wake = host.messages.find((m) => m.message.customType === "orchestrator-resume");
		assert.ok(wake, "parked parent must wake once live worker settles");
		assert.equal(wake.options?.triggerTurn, true);
		assert.match(String(wake.message.content), /live-park-1/);
	});
});

// --- Ticket #05 code-review regression tests -------------------------------

test("Ticket #05: failed (isError) or declined ('Not sent:') subagent_answer calls carrying a known run ID do NOT unlock parent write", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd);
		await startPrompt(host, "Implement feature");

		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "known-run-1",
			status: "running",
			at: Date.now(),
		});

		// Two erroring subagent_answer calls carrying known-run-1 in both input and details
		for (const idx of [1, 2]) {
			await host.fire("tool_call", {
				toolName: "subagent_answer",
				toolCallId: `err-${idx}`,
				input: { id: "known-run-1", runId: "known-run-1", answer: "proceed" },
			});
			await host.fire("tool_result", {
				toolName: "subagent_answer",
				toolCallId: `err-${idx}`,
				input: { id: "known-run-1", runId: "known-run-1", answer: "proceed" },
				isError: true,
				content: [{ type: "text", text: "The question passed its deadline." }],
				details: { id: "known-run-1", runId: "known-run-1" },
			});
		}

		// Two declined subagent_answer calls carrying known-run-1
		for (const idx of [1, 2]) {
			await host.fire("tool_call", {
				toolName: "subagent_answer",
				toolCallId: `declined-${idx}`,
				input: { id: "known-run-1", runId: "known-run-1", answer: "proceed" },
			});
			await host.fire("tool_result", {
				toolName: "subagent_answer",
				toolCallId: `declined-${idx}`,
				input: { id: "known-run-1", runId: "known-run-1", answer: "proceed" },
				isError: false,
				content: [{ type: "text", text: "Not sent: the human declined to confirm this answer." }],
				details: { id: "known-run-1", runId: "known-run-1" },
			});
		}

		const writeBlocked = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/still-blocked.ts", content: "export const x = 1;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(writeBlocked?.block, true);
		assert.equal(host.notifications.some((n) => /unlocked/i.test(n.message)), false);
	});
});

test("Ticket #05: waitForSubagents: true with live coder run and NO parent edits parks and wakes on settle", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { waitForSubagents: true, openTodos: false, repeatedFailure: false, loops: false },
			}),
		);
		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, { branch });
		await startPrompt(host, "Delegate implementation to coder");

		// Live coder run with zero parent edits (gate.pending.length === 0)
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "coder-live-1",
			status: "running",
			at: Date.now(),
		});

		const boundary = await fireBoundary(host);
		assert.notEqual(boundary.continue, true);
		assert.equal(
			boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			false,
		);

		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "coder-live-1",
			status: "completed",
			role: "coder",
			finishedAt: Date.now(),
		});

		const wake = host.messages.find((m) => m.message.customType === "orchestrator-resume");
		assert.ok(wake, "parent must park and wake when live coder settles, never dropping it silently");
		assert.equal(wake.options?.triggerTurn, true);
		assert.match(String(wake.message.content), /coder-live-1/);
	});
});

test("Ticket #05: !direct and orchestrator_override suppress parking/wake when waitForSubagents: true", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { waitForSubagents: true, openTodos: false, repeatedFailure: false, loops: false },
			}),
		);
		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, { branch });

		// 1. !direct suppresses parking and wake, emitting a warning instead
		await startPrompt(host, "!direct leave background worker running");
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/app.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-direct-1",
			status: "running",
			at: Date.now(),
		});

		const directBoundary = await fireBoundary(host);
		assert.notEqual(directBoundary.continue, true);
		assert.ok(
			host.notifications.some((n) => n.type === "warning" && /live-direct-1/.test(n.message)),
			"!direct must warn about live runs instead of parking silently",
		);
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "live-direct-1",
			status: "completed",
			role: "explore",
			finishedAt: Date.now(),
		});
		assert.equal(
			host.messages.some((m) => m.message.customType === "orchestrator-resume"),
			false,
			"!direct must not park or wake on runSettled",
		);

		// 2. orchestrator_override suppresses parking and wake in enforce mode
		await startPrompt(host, "Normal prompt with override");
		host.notifications.length = 0;
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-override-1",
			status: "running",
			at: Date.now(),
		});
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "intentionally settle without waiting" });

		const overrideBoundary = await fireBoundary(host);
		assert.notEqual(overrideBoundary.continue, true);
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "live-override-1",
			status: "completed",
			role: "explore",
			finishedAt: Date.now(),
		});
		assert.equal(
			host.messages.some((m) => m.message.customType === "orchestrator-resume"),
			false,
			"orchestrator_override must suppress parking and wake",
		);
	});
});

test("Ticket #05: block { waitForSubagents: false, wave: false } with active wave does NOT park silently", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { waitForSubagents: false, wave: false, openTodos: false, repeatedFailure: false, loops: false },
			}),
		);
		const ticketsDir = path.join(cwd, "docs", "tickets", "wave-opt-out");
		await mkdir(ticketsDir, { recursive: true });
		await writeFile(
			path.join(ticketsDir, "01-task.md"),
			"---\nstatus: ready\nblocked-by: []\n---\n\n# 01: Task\n\n**Status:** ready\n",
		);

		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, { branch });
		await host.runCommand(WAVE_COMMAND, "docs/tickets/wave-opt-out");
		await startPrompt(host, "Work on wave");

		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "wave-live-1",
			status: "running",
			at: Date.now(),
		});

		// With waitForSubagents: false and wave: false, settlement must NOT park silently:
		// delegation blocks with subagent_wait/subagent_status guidance and does NOT wake later.
		const boundary = await fireBoundary(host);
		assert.equal(boundary.continue, true);
		const gateMsg = boundary.entries.find(
			(e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate",
		) as { content?: string } | undefined;
		assert.ok(gateMsg, "expected delegation block message instead of silent park");
		assert.match(gateMsg.content ?? "", /wave-live-1/);
		assert.match(gateMsg.content ?? "", /subagent_wait|subagent_status/);

		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "wave-live-1",
			status: "completed",
			role: "explore",
			finishedAt: Date.now(),
		});
		assert.equal(
			host.messages.some((m) => m.message.customType === "orchestrator-resume"),
			false,
			"must not park/wake when waitForSubagents and wave blocking are both disabled",
		);
	});
});

test("orchestrator_override is not double-consumed between openTodos settle gate and delegation live-run settle handler", async () => {
	for (const waitForSubagents of [true, false]) {
		await withIsolatedRuntimeEnv(async (cwd) => {
			await withEnv({ PI_TODO_PATH: undefined }, async () => {
				await mkdir(path.join(cwd, ".pi", "todos"), { recursive: true });
				await writeFile(
					path.join(cwd, ".pi", "orchestrator.json"),
					JSON.stringify({
						version: 1,
						block: { waitForSubagents, openTodos: true, repeatedFailure: false, loops: false },
					}),
				);
				await writeFile(
					path.join(cwd, ".pi", "todos", "todo-1.md"),
					`${JSON.stringify({ id: "todo-1", title: "Finish remaining task", status: "open" })}\n`,
				);

				const branch: Record<string, unknown>[] = [];
				const host = await startRuntimeHost(cwd, { branch });
				await startPrompt(host, "Settle with override despite open todo and live run");

				const runId = `live-override-todos-${waitForSubagents}`;
				host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
					runId,
					status: "running",
					at: Date.now(),
				});

				await host.callTool(GATE_OVERRIDE_TOOL, {
					reason: "intentionally settle despite open todo and live run",
				});

				const boundary = await fireBoundary(host);
				assert.notEqual(
					boundary.continue,
					true,
					`expected agent_before_settle to settle without continue: true (waitForSubagents=${waitForSubagents})`,
				);
				assert.equal(
					boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
					false,
					`expected delegation settle gate to honor consumed override (waitForSubagents=${waitForSubagents})`,
				);
				const gateVerdict = boundary.entries.find(
					(e) => (e as { customType?: string }).customType === GATE_ENTRY_TYPE,
				) as { data?: GateVerdict } | undefined;
				assert.ok(gateVerdict?.data, "expected orchestrator gate verdict");
				assert.ok(gateVerdict.data.override, "expected gate verdict to record consumed override");
				assert.equal(gateVerdict.data.decision, "report");
				assert.equal(gateVerdict.data.parked, false, "override must keep parked false");

				await host.fire("agent_settled", { aborted: false });

				// Without a second override, the next boundary must enforce again (override did not leak)
				if (!waitForSubagents) {
					const nextBoundary = await fireBoundary(host);
					assert.equal(nextBoundary.continue, true);
				}

				host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
					runId,
					status: "completed",
					role: "explore",
					finishedAt: Date.now(),
				});
				assert.equal(
					host.messages.some((m) => m.message.customType === "orchestrator-resume"),
					false,
					`settling live run must emit zero orchestrator-resume wake (waitForSubagents=${waitForSubagents})`,
				);
			});
		});
	}
});

// --- Ticket #06: Full persona, missing-sections warning, hide/restore write ---

test("Ticket 06 (RB-4): before_agent_start injects full persona + active mode directive for all 6 modes and emits a one-time warning when sections is unavailable", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd);

		const sections: Record<string, string> = {};
		await startPrompt(host, "Audit auth flow for XSS vulnerabilities", sections);
		assert.match(sections[DELEGATION_SECTION] ?? "", /Pragmatic Orchestrator/);
		assert.match(sections[DELEGATION_SECTION] ?? "", /Mode: security \(direct discovery budget: 2\)\./);

		// mode: "off" without sections must NOT warn or consume the one-time warning
		await host.runCommand("delegation", "off");
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Implement feature",
		});
		assert.equal(host.notifications.length, 0);

		// Turn back to enforce: missing systemPromptOptions emits a single warning
		await host.runCommand("delegation", "enforce");
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Implement feature",
		});
		const sectionWarnings = () =>
			host.notifications.filter((n) => n.type === "warning" && /sections/i.test(n.message));
		assert.equal(sectionWarnings().length, 1);

		// Turn 2 & Turn 3 with non-record / null sections do NOT repeat warning
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Debug why tests fail",
			systemPromptOptions: { sections: null },
		});
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Review the PR diff",
			systemPromptOptions: { sections: ["not-a-record"] },
		});
		assert.equal(sectionWarnings().length, 1);

		// session_start resets one-time warning flag
		await host.fire("session_start", {});
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Implement feature",
		});
		assert.equal(sectionWarnings().length, 2);

		// session_tree resets one-time warning flag
		await host.fire("session_tree", {});
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Implement feature",
		});
		assert.equal(sectionWarnings().length, 3);
	});
});

test("Ticket 06 (RB-4): enforce mode hides parent write via setActiveTools, restores on !direct, /delegation off/warn, and 2-steer unlock, and never adds write if absent", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit", "write"],
		});
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};

		// enforce on session_start hides write
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);

		// Defense-in-depth: tool_call write guard remains active even when hidden
		const hiddenWriteBlocked = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const a = 1;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(hiddenWriteBlocked?.block, true);

		// !direct restores write for that turn
		await startPrompt(host, "!direct create src/new.ts");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.equal(
			await host.fire("tool_call", {
				toolName: "write",
				input: { path: "src/new.ts", content: "export const a = 1;\n" },
			}),
			undefined,
		);

		// Next normal prompt hides write again
		await startPrompt(host, "Implement feature");
		assert.equal(api.getActiveTools().includes("write"), false);

		// /delegation off restores write
		await host.runCommand("delegation", "off");
		assert.equal(api.getActiveTools().includes("write"), true);

		// /delegation enforce hides write again
		await host.runCommand("delegation", "enforce");
		assert.equal(api.getActiveTools().includes("write"), false);

		// /delegation warn restores write
		await host.runCommand("delegation", "warn");
		assert.equal(api.getActiveTools().includes("write"), true);

		// /delegation enforce hides write again
		await host.runCommand("delegation", "enforce");
		assert.equal(api.getActiveTools().includes("write"), false);

		// 2-steer escalation unlock restores write mid-turn
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "steer-run-1",
			status: "running",
			at: Date.now(),
		});
		await host.fire("tool_call", { toolName: "subagent_interrupt", input: { id: "steer-run-1" } });
		assert.equal(api.getActiveTools().includes("write"), false);
		await host.fire("tool_call", { toolName: "subagent_resume", input: { id: "steer-run-1", task: "retry" } });
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.equal(
			await host.fire("tool_call", {
				toolName: "write",
				input: { path: "src/unlocked.ts", content: "export const ok = true;\n" },
			}),
			undefined,
		);

		// Next prompt resets escalationUnlocked and hides write again
		await startPrompt(host, "Another task");
		assert.equal(api.getActiveTools().includes("write"), false);
	});

	// Never inject write into a session launched without write (e.g. --tools read,grep)
	await withIsolatedRuntimeEnv(async (cwd) => {
		const setActiveCalls: string[][] = [];
		const branch: Record<string, unknown>[] = [];
		const host = createFakeHost({
			sessionId: "no-write-session",
			cwd,
			trusted: true,
			branch,
		});
		let currentActive = ["read", "grep"];
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};
		api.getActiveTools = () => [...currentActive];
		api.setActiveTools = (names: string[]) => {
			setActiveCalls.push([...names]);
			currentActive = [...names];
		};
		orchestratorExtension(host.pi, { role: "parent" });
		await host.fire("session_start", {});

		await startPrompt(host, "!direct inspect files");
		await host.runCommand("delegation", "off");
		await host.runCommand("delegation", "warn");
		await host.runCommand("delegation", "enforce");

		assert.deepEqual(currentActive, ["read", "grep"]);
		assert.equal(setActiveCalls.length, 0);
	});
});

test("Ticket 06 (RB-4 & RB-7): parent write hiding/restoration coordinates cleanly with codemode (+tool_search/+codemode and codemode.mode='only')", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit", "write", "codemode", "tool_search"],
		});
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};

		// In enforce mode, write is excluded from activeTools (so codemode cannot expose tools.write)
		// while codemode, tool_search, read, bash, edit stay active and orchestrator_override keeps codemode exposure.
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit", "codemode", "tool_search"]);
		assert.equal(host.tools.get(GATE_OVERRIDE_TOOL)?.exposure, "codemode");

		// Nested codemode write remains blocked in enforce mode
		const nestedBlocked = (await host.fire(
			"tool_call",
			nestedCall("cm-hide", 1, "write", { path: "src/new.ts", content: "export const x = 1;\n" }),
		)) as { block?: boolean } | undefined;
		assert.equal(nestedBlocked?.block, true);

		// !direct restores write so codemode can dispatch tools.write
		await startPrompt(host, "!direct write src/new.ts via codemode");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.equal(
			await host.fire(
				"tool_call",
				nestedCall("cm-hide", 2, "write", { path: "src/new.ts", content: "export const x = 1;\n" }),
			),
			undefined,
		);

		// Next normal prompt hides write again
		await startPrompt(host, "Implement next change");
		assert.equal(api.getActiveTools().includes("write"), false);

		// /delegation off restores write; session_tree resets session override and hides write again
		await host.runCommand("delegation", "off");
		assert.equal(api.getActiveTools().includes("write"), true);
		await host.fire("session_tree", {});
		assert.equal(api.getActiveTools().includes("write"), false);
	});
});

test("Ticket 06 (RB-4): custom wake turns preserve sections.delegation without resetting turn state and setActiveTools is never called redundantly", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const setActiveCalls: string[][] = [];
		let currentActive = ["read", "bash", "edit", "write"];
		const host = createFakeHost({
			sessionId: "custom-turn-and-no-churn",
			cwd,
			trusted: true,
			branch: [],
		});
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};
		api.getActiveTools = () => [...currentActive];
		api.setActiveTools = (names: string[]) => {
			setActiveCalls.push([...names]);
			currentActive = [...names];
		};
		orchestratorExtension(host.pi, { role: "parent" });
		await host.fire("session_start", {});
		assert.equal(setActiveCalls.length, 1);

		// Security turn consumes 1 of 2 discovery calls; repeated normal prompts make 0 redundant setActiveTools calls
		await startPrompt(host, "Audit auth for security vulnerabilities");
		assert.equal(setActiveCalls.length, 1);
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } }), undefined);

		// Custom wake turn (messageType: "custom", no prompt) keeps security mode & discoveryCount=1 AND re-populates sections.delegation
		const customSections: Record<string, string> = {};
		await host.fire("before_agent_start", {
			type: "before_agent_start",
			messageType: "custom",
			message: { role: "custom", customType: "orchestrator-resume", content: "wake" },
			systemPrompt: "base system prompt",
			systemPromptOptions: { sections: customSections },
		});
		assert.match(customSections[DELEGATION_SECTION] ?? "", /Mode: security \(direct discovery budget: 2\)\./);
		assert.equal(setActiveCalls.length, 1);

		// 2nd discovery succeeds, 3rd is blocked (discoveryCount was NOT reset on custom wake turn)
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "src/b.ts" } }), undefined);
		const third = (await host.fire("tool_call", { toolName: "read", input: { path: "src/c.ts" } })) as
			| { block?: boolean }
			| undefined;
		assert.equal(third?.block, true);

		// !direct restores once; another !direct makes 0 redundant setActiveTools calls
		await startPrompt(host, "!direct write a file");
		assert.equal(setActiveCalls.length, 2);
		await startPrompt(host, "!direct write another file");
		assert.equal(setActiveCalls.length, 2);
	});
});

test("hidParentWrite persistence (a): resume/reload with branch { hidden: true } restores write on !direct and /delegation off", async () => {
	// !direct after resume/reload
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [
			{ type: "custom", id: "e-0", customType: DELEGATION_WRITE_ENTRY, data: { hidden: true } },
		];
		// Simulates Pi's _restoreToolsFromTranscript() restoring active tools without "write"
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit"],
			branch,
		});
		const api = host.pi as unknown as { getActiveTools: () => string[] };

		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		assert.equal(
			host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).length,
			0,
		);

		await startPrompt(host, "!direct create src/resumed.ts");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.deepEqual(
			host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).map((e) => e.data),
			[{ hidden: false }],
		);
	});

	// /delegation off after resume/reload
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [
			{ type: "custom", id: "e-0", customType: DELEGATION_WRITE_ENTRY, data: { hidden: true } },
		];
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit"],
			branch,
		});
		const api = host.pi as unknown as { getActiveTools: () => string[] };

		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		await host.runCommand("delegation", "off");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.deepEqual(
			host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).map((e) => e.data),
			[{ hidden: false }],
		);
	});
});

test("hidParentWrite persistence (b): session_tree to a branch without write resets hidParentWrite and does not inject write", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit", "write"],
			branch,
		});
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};

		// Branch A hid write
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		assert.deepEqual(branch.at(-1)?.data, { hidden: true });

		// Navigate via session_tree to Branch B (no delegation-write entry, active tools lack write)
		branch.length = 0;
		api.setActiveTools(["read", "grep"]);
		await host.fire("session_tree", {});
		assert.deepEqual(api.getActiveTools(), ["read", "grep"]);

		await host.runCommand("delegation", "off");
		assert.deepEqual(api.getActiveTools(), ["read", "grep"]);

		await host.runCommand("delegation", "enforce");
		await startPrompt(host, "!direct inspect files");
		assert.deepEqual(api.getActiveTools(), ["read", "grep"]);
	});
});

test("hidParentWrite persistence (c): session_tree from !direct back to an enforce turn reconstructs hidParentWrite=true", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [];
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit", "write"],
			branch,
		});
		const api = host.pi as unknown as {
			getActiveTools: () => string[];
			setActiveTools: (names: string[]) => void;
		};

		// Turn 1 (enforce) hid write -> { hidden: true }
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		// Turn 2 (!direct) restored write -> { hidden: false }
		await startPrompt(host, "!direct write src/turn2.ts");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.deepEqual(
			branch.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).map((e) => e.data),
			[{ hidden: true }, { hidden: false }],
		);

		// Navigate back to Turn 1: branch ends at { hidden: true }, _restoreToolsFromTranscript() omits write
		branch.splice(1);
		assert.deepEqual(branch.at(-1)?.data, { hidden: true });
		api.setActiveTools(["read", "bash", "edit"]);
		await host.fire("session_tree", {});
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);

		// Subsequent !direct must restore write
		await startPrompt(host, "!direct write src/turn1-retry.ts");
		assert.equal(api.getActiveTools().includes("write"), true);
		assert.deepEqual(branch.at(-1)?.data, { hidden: false });
	});
});

test("hidParentWrite persistence (d): { hidden: false } without system toolsAdded:['write'] still restores write on resume, while confirmed restore + manual removal does not", async () => {
	// Case 1: /delegation off appended { hidden: false }, but Turn 1 system message only had [read, bash, edit]
	// and no Turn 2 system message persisted toolsAdded: [{ name: "write", ... }] before exiting/reloading.
	for (const restoreAction of ["direct", "delegation-off"] as const) {
		await withIsolatedRuntimeEnv(async (cwd) => {
			const branch: Record<string, unknown>[] = [
				{ type: "custom", id: "e-0", customType: DELEGATION_WRITE_ENTRY, data: { hidden: true } },
				{
					type: "message",
					id: "m-1",
					message: {
						role: "system",
						toolsAdded: [
							{ name: "read", description: "Read file", parameters: {} },
							{ name: "bash", description: "Run shell command", parameters: {} },
							{ name: "edit", description: "Edit file", parameters: {} },
						],
					},
				},
				{ type: "custom", id: "e-1", customType: DELEGATION_WRITE_ENTRY, data: { hidden: false } },
			];
			const host = await startRuntimeHost(cwd, {
				activeTools: ["read", "bash", "edit"],
				branch,
			});
			const api = host.pi as unknown as { getActiveTools: () => string[] };

			assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
			assert.equal(
				host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).length,
				0,
			);

			if (restoreAction === "direct") {
				await startPrompt(host, "!direct create src/after-desync-resume.ts");
			} else {
				await host.runCommand("delegation", "off");
			}

			assert.equal(api.getActiveTools().includes("write"), true);
			assert.deepEqual(
				host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).map((e) => e.data),
				[{ hidden: false }],
			);
		});
	}

	// Contrast case 1: { hidden: true } -> { hidden: false } -> Turn 2 system message with toolsAdded: [{ name: "write", ... }]
	// -> Turn 3 manual removal (toolsRemoved: [{ name: "write" }]). Resuming with ["read", "bash", "edit"] keeps
	// hidParentWrite = false and does NOT re-inject "write".
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [
			{ type: "custom", id: "e-0", customType: DELEGATION_WRITE_ENTRY, data: { hidden: true } },
			{
				type: "message",
				id: "m-1",
				message: {
					role: "system",
					toolsAdded: [
						{ name: "read", description: "Read file", parameters: {} },
						{ name: "bash", description: "Run shell command", parameters: {} },
						{ name: "edit", description: "Edit file", parameters: {} },
					],
				},
			},
			{ type: "custom", id: "e-1", customType: DELEGATION_WRITE_ENTRY, data: { hidden: false } },
			{
				type: "message",
				id: "m-2",
				message: {
					role: "system",
					toolsAdded: [{ name: "write", description: "Write file", parameters: {} }],
				},
			},
			{
				type: "message",
				id: "m-3",
				message: {
					role: "system",
					toolsRemoved: [{ name: "write" }],
				},
			},
		];
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit"],
			branch,
		});
		const api = host.pi as unknown as { getActiveTools: () => string[] };

		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		await startPrompt(host, "!direct inspect files");
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		await host.runCommand("delegation", "off");
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		assert.equal(
			host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).length,
			0,
		);
	});

	// Contrast case 2: { m-1 with write } -> { hidden: true } -> { hidden: false } -> { m-3 toolsRemoved: write }.
	// Transcript already had "write" when { hidden: false } was recorded, so hidParentWrite clears immediately
	// and m-3 manual removal stays honored (hidParentWrite stays false on resume).
	await withIsolatedRuntimeEnv(async (cwd) => {
		const branch: Record<string, unknown>[] = [
			{
				type: "message",
				id: "m-1",
				message: {
					role: "system",
					toolsAdded: [
						{ name: "read", description: "Read file", parameters: {} },
						{ name: "bash", description: "Run shell command", parameters: {} },
						{ name: "edit", description: "Edit file", parameters: {} },
						{ name: "write", description: "Write file", parameters: {} },
					],
				},
			},
			{ type: "custom", id: "e-0", customType: DELEGATION_WRITE_ENTRY, data: { hidden: true } },
			{ type: "custom", id: "e-1", customType: DELEGATION_WRITE_ENTRY, data: { hidden: false } },
			{
				type: "message",
				id: "m-3",
				message: {
					role: "system",
					toolsRemoved: [{ name: "write" }],
				},
			},
		];
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit"],
			branch,
		});
		const api = host.pi as unknown as { getActiveTools: () => string[] };

		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		await startPrompt(host, "!direct inspect files");
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		await host.runCommand("delegation", "off");
		assert.deepEqual(api.getActiveTools(), ["read", "bash", "edit"]);
		assert.equal(
			host.appended.filter((e) => e.customType === DELEGATION_WRITE_ENTRY).length,
			0,
		);
	});
});

// --- Ticket #07: orchestrator_record_review & unconditional post-review dirty reset ---

test("Ticket 07 (RB-6 & RB-7): orchestrator_record_review enforces inspection precondition, verdict rules, and unconditional post-review dirty reset", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, {
			activeTools: ["read", "bash", "edit", "write", "codemode", "tool_search"],
		});
		await startPrompt(host, "Implement multi-file feature");

		// Pre-edit read does NOT count as post-edit inspection
		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });

		const t0 = Date.now();
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "coder-1",
			status: "completed",
			role: "coder",
			startedAt: t0,
			finishedAt: t0,
			activitySummary: {
				editedFiles: [
					{ path: "src/a.ts", changedLines: 15, lastEditAt: t0 },
					{ path: "src/b.ts", changedLines: 15, lastEditAt: t0 },
				],
				passedCommands: [{ command: "node --test", at: t0 }],
				lastEditAt: t0,
			},
		});

		// Gate is armed for code-review
		const blockedBefore = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'wip'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedBefore?.block, true);
		assert.match(blockedBefore?.reason ?? "", /code-review/);

		// Calling orchestrator_record_review before post-edit inspection is rejected
		const missingInspect = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "pass",
			scope: "src/a.ts, src/b.ts",
			summary: "Looks clean",
		})) as { isError?: boolean; content: Array<{ text?: string }> };
		assert.equal(missingInspect.isError, true);
		assert.match(missingInspect.content[0]?.text ?? "", /inspect|git diff|read/i);

		// Non-inspection bash commands (ls, git branch -a) and failed git diff do NOT satisfy inspection
		await host.fire("tool_result", nestedCall("cm-rev", 1, "bash", { command: "ls -la" }, { isError: false, content: [] }));
		await host.fire("tool_result", nestedCall("cm-rev", 2, "bash", { command: "git branch -a" }, { isError: false, content: [] }));
		await host.fire("tool_result", nestedCall("cm-rev", 3, "bash", { command: "git diff" }, { isError: true, content: [] }));

		const stillMissingInspect = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "pass",
			scope: "src/a.ts, src/b.ts",
			summary: "Still uninspected",
		})) as { isError?: boolean };
		assert.equal(stillMissingInspect.isError, true);

		// Nested codemode git diff inspection satisfies inspection precondition
		await host.fire("tool_result", nestedCall("cm-rev", 4, "bash", { command: "git diff --stat" }, { isError: false, content: [] }));

		// verdict: "fail" records review metadata but leaves reviewVerified = false (gates stay blocked)
		const failReview = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "fail",
			scope: "src/a.ts, src/b.ts",
			summary: "Missing null check in src/b.ts",
			inspectedPaths: ["src/a.ts", "src/b.ts"],
		})) as { isError?: boolean; details?: { review?: { verdict?: string }; reviewVerified?: boolean } };
		assert.notEqual(failReview.isError, true);
		assert.equal(failReview.details?.reviewVerified, false);

		const blockedAfterFail = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'wip'" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedAfterFail?.block, true);
		const settleAfterFail = await fireBoundary(host);
		assert.equal(settleAfterFail.continue, true);

		// verdict: "pass" clears commit and settle gates
		const passReview = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "pass",
			scope: "src/a.ts, src/b.ts",
			summary: "Null check verified; clean diff",
			inspectedPaths: ["src/a.ts", "src/b.ts"],
		})) as { isError?: boolean; details?: { reviewVerified?: boolean } };
		assert.notEqual(passReview.isError, true);
		assert.equal(passReview.details?.reviewVerified, true);

		assert.equal(
			await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'feat'" } }),
			undefined,
		);
		const cleanSettle = await fireBoundary(host);
		assert.notEqual(cleanSettle.continue, true);

		// /delegation --json surfaces lastMainReview and lastReviewInspectionAt
		await host.runCommand("delegation", "--json");
		const snapshot = JSON.parse(String(host.messages.at(-1)?.message.content ?? "{}")) as {
			state: {
				lastReviewInspectionAt?: number;
				lastMainReview?: { verdict?: string; scope?: string; summary?: string; inspectedPaths?: string[] };
			};
		};
		assert.ok((snapshot.state.lastReviewInspectionAt ?? 0) > 0);
		assert.equal(snapshot.state.lastMainReview?.verdict, "pass");
		assert.equal(snapshot.state.lastMainReview?.scope, "src/a.ts, src/b.ts");
		assert.deepEqual(snapshot.state.lastMainReview?.inspectedPaths, ["src/a.ts", "src/b.ts"]);

		// Small follow-up edit (1 file, 1 line) unconditionally clears reviewVerified and re-arms code-review gate
		await startPrompt(host, "Fix one tiny line");
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "1", newText: "2" },
			isError: false,
			content: [],
		});
		// Pass tests after follow-up edit so only code-review remains
		await host.fire("tool_result", {
			toolName: "bash",
			input: { command: "node --test" },
			isError: false,
			content: [],
		});

		const rearmedCommit = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'follow-up'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(rearmedCommit?.block, true);
		assert.match(rearmedCommit?.reason ?? "", /code-review/);

		// Calling orchestrator_record_review before re-inspecting after the follow-up edit is rejected
		const staleInspect = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "accepted_with_notes",
			scope: "src/a.ts",
			summary: "Should fail without post-follow-up read",
		})) as { isError?: boolean };
		assert.equal(staleInspect.isError, true);

		// Post-follow-up nested read satisfies inspection, and accepted_with_notes clears the gate
		await host.fire("tool_result", nestedCall("cm-rev", 5, "read", { path: "src/a.ts" }, { isError: false, content: [] }));
		const acceptedNotes = (await host.callTool(RECORD_REVIEW_TOOL, {
			verdict: "accepted_with_notes",
			scope: "src/a.ts follow-up",
			summary: "Minor follow-up verified; style nit deferred",
		})) as { isError?: boolean; details?: { reviewVerified?: boolean } };
		assert.notEqual(acceptedNotes.isError, true);
		assert.equal(acceptedNotes.details?.reviewVerified, true);
		assert.equal(
			await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'follow-up'" } }),
			undefined,
		);
	});
});

test("Ticket 07 (RB-7): orchestrator_record_review uses codemode exposure under codemode/tool_search, transitions cleanly, and is absent on worker", async () => {
	for (const activeTool of ["codemode", "tool_search"]) {
		await withIsolatedRuntimeEnv(async (cwd) => {
			let activeTools = ["read", "bash", "edit", RECORD_REVIEW_TOOL];
			const host = createFakeHost({ sessionId: `record-review-${activeTool}`, cwd, trusted: true });
			const api = host.pi as unknown as {
				getActiveTools: () => string[];
				setActiveTools: (names: string[]) => void;
			};
			api.getActiveTools = () => [...activeTools];
			api.setActiveTools = (names: string[]) => {
				activeTools = [...names];
			};
			orchestratorExtension(host.pi, { role: "parent" });

			await host.fire("session_start", {});
			assert.equal(host.tools.get(RECORD_REVIEW_TOOL)?.exposure, undefined);
			assert.equal(activeTools.includes(RECORD_REVIEW_TOOL), true);

			activeTools = [...activeTools, activeTool];
			await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
			assert.equal(host.tools.get(RECORD_REVIEW_TOOL)?.exposure, "codemode");
			assert.equal(
				activeTools.includes(RECORD_REVIEW_TOOL),
				false,
				`orchestrator_record_review must be removed from activeTools when transitioning to ${activeTool}`,
			);
		});
	}

	// Worker never registers orchestrator_record_review
	await withIsolatedRuntimeEnv(async (cwd) => {
		const worker = await startRuntimeHost(cwd, {
			role: "worker",
			activeTools: ["read", "bash", "edit", "write", "codemode"],
		});
		assert.equal(worker.tools.has(RECORD_REVIEW_TOOL), false);
	});
});

test("read-only bash guardrail returns role-accurate block messages in enforce and warn modes (top-level and nested codemode)", async () => {
	await withIsolatedRuntimeEnv(async (cwd) => {
		const host = await startRuntimeHost(cwd, { activeTools: ["read", "bash", "edit", "codemode"] });
		await startPrompt(host, "Investigate repository files");

		// 1. Compound/subshell/redirect command starting with ls -> names constructs & suggests split / explore
		const compound = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "ls -la && (ls -la docs 2>/dev/null || true)" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(compound?.block, true);
		assert.match(compound?.reason ?? "", /&&/);
		assert.match(compound?.reason ?? "", /subshell/i);
		assert.match(compound?.reason ?? "", /explore/);
		assert.doesNotMatch(compound?.reason ?? "", /role:\s*'coder'/);

		// 2. Unsupported pipe sinks (direct and nested codemode) -> names pipe sink & suggests explore / filtering
		const gitLsFilesPipe = (await host.fire(
			"tool_call",
			nestedCall("cm-bash", 1, "bash", { command: "git ls-files | grep -iE 'pe[-_]?hc'" }),
		)) as { block?: boolean; reason?: string } | undefined;
		assert.equal(gitLsFilesPipe?.block, true);
		assert.match(gitLsFilesPipe?.reason ?? "", /\| grep/);
		assert.match(gitLsFilesPipe?.reason ?? "", /head.*tail.*wc.*cat/i);
		assert.match(gitLsFilesPipe?.reason ?? "", /explore/);
		assert.doesNotMatch(gitLsFilesPipe?.reason ?? "", /role:\s*'coder'/);

		const gitLogPipe = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git log -n 10 | grep foo" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(gitLogPipe?.block, true);
		assert.match(gitLogPipe?.reason ?? "", /\| grep/);
		assert.match(gitLogPipe?.reason ?? "", /without the pipe|filter/i);
		assert.match(gitLogPipe?.reason ?? "", /explore/);
		assert.doesNotMatch(gitLogPipe?.reason ?? "", /role:\s*'coder'/);

		// 3. Bare git ls-files and read-only search commands -> point to direct tools or explore (not coder)
		for (const cmd of ["git ls-files", "rg -n foo src/", "find . -name '*.ts'"]) {
			const searchRes = (await host.fire("tool_call", {
				toolName: "bash",
				input: { command: cmd },
			})) as { block?: boolean; reason?: string } | undefined;
			assert.equal(searchRes?.block, true);
			assert.match(searchRes?.reason ?? "", /explore/);
			assert.doesNotMatch(searchRes?.reason ?? "", /role:\s*'coder'/);
		}

		// 4. Mutating/test/general shell commands still route to coder
		for (const cmd of ["npm test", "pytest", "git checkout -b feat", "rm -rf /tmp/scratch"]) {
			const coderRes = (await host.fire("tool_call", {
				toolName: "bash",
				input: { command: cmd },
			})) as { block?: boolean; reason?: string } | undefined;
			assert.equal(coderRes?.block, true);
			assert.match(coderRes?.reason ?? "", /coder/);
		}

		// 5. Warn mode emits the same role-accurate reason without blocking
		await host.runCommand("delegation", "warn");
		host.notifications.length = 0;
		const warnAllowed = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git log -n 10 | grep foo" },
		});
		assert.equal(warnAllowed, undefined);
		assert.ok(
			host.notifications.some((n) => n.type === "warning" && /\| grep/.test(n.message) && /explore/.test(n.message)),
		);
	});
});



