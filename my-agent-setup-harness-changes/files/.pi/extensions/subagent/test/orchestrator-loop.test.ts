// The loop breaker (ticket 09, R29–R30): the pure no-progress rules and the
// `tool_call` guard through the fake extension host.
//
// Two tests are the regression this ticket exists to prevent, and they are
// written as the repository's own documented workflows: polling a status tool
// while a child runs, and running a status command after each edit. A detector
// that counted repetition would fail both; the evidence rules here need the
// *result* to repeat as well, and a no-progress run is broken by any successful
// edit in between.
//
// The factory tests pin the two bounds: the per-turn cap (a turn boundary
// re-arms it) and the branch budget shared with settlement blocks. Both must let
// the call run rather than trap it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { gateConfigPath } from "../../orchestrator/config.ts";
import {
	GATE_LOOP_ENTRY_TYPE,
	GATE_OVERRIDE_ENTRY_TYPE,
	GATE_OVERRIDE_TOOL,
	type LoopVerdict,
} from "../../orchestrator/gate.ts";
import { ORCHESTRATION_EVENTS } from "../../orchestrator/events.ts";
import {
	createLoopState,
	evaluateLoop,
	invocationLabel,
	loopSignature,
	recordCall,
	recordResult,
	LOOP_WINDOW,
	type LoopCall,
	type LoopState,
} from "../../orchestrator/loop.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import type { OrchestratorRole } from "../../orchestrator/role.ts";
import { createFakeHost, type FakeHost } from "./fake-pi.ts";

type Entry = Record<string, unknown>;

function callOf(tool: string, input: Record<string, unknown>): LoopCall {
	return { tool, signature: loopSignature(tool, input), invocation: invocationLabel(tool, input) };
}

/** Record one finished call, as the factory does for an allowed one. */
function ran(state: LoopState, tool: string, input: Record<string, unknown>, result = "same output"): LoopCall {
	const call = callOf(tool, input);
	recordCall(state, call);
	recordResult(state, call, { isError: false, text: result });
	return call;
}

function failed(state: LoopState, tool: string, input: Record<string, unknown>, error: string): LoopCall {
	const call = callOf(tool, input);
	recordCall(state, call);
	recordResult(state, call, { isError: true, text: `${error}\n  at file.ts:1` });
	return call;
}

// --- Pure evidence rules ----------------------------------------------------

test("the loop detector does not fire on status polling", () => {
	// `subagent_status` is not one of the tools the detector considers: an
	// observation cannot make progress, so blocking it removes information
	// without breaking a loop. Five identical polls, five identical results.
	const state = createLoopState();
	const poll = callOf("subagent_status", { id: "run-1" });
	for (let index = 0; index < 5; index += 1) {
		assert.equal(evaluateLoop(state, poll), null, `poll ${index + 1} must not be a loop`);
		recordCall(state, poll);
		recordResult(state, poll, { isError: false, text: "running" });
	}
});

test("the loop detector does not fire on a status command after each edit", () => {
	// The repository's documented workflow: edit, check `git status`, edit, check
	// again. The status command repeats with the same result, but every repetition
	// is separated by a successful edit, which is progress.
	const state = createLoopState();
	for (let index = 0; index < 5; index += 1) {
		ran(state, "edit", { path: `src/file-${index}.ts`, oldText: "a", newText: `b${index}` });
		const status = callOf("bash", { command: "git status --porcelain" });
		assert.equal(evaluateLoop(state, status), null, `status after edit ${index + 1} must not be a loop`);
		recordCall(state, status);
		recordResult(state, status, { isError: false, text: " M src/file.ts" });
	}
});

test("the loop detector fires on the same mutation with no new result", () => {
	const state = createLoopState();
	const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
	ran(state, "edit", edit);
	ran(state, "edit", edit);
	// The third identical edit, with the same success twice and nothing else changed.
	const evidence = evaluateLoop(state, callOf("edit", edit));
	assert.ok(evidence, "the third identical edit is a loop");
	assert.equal(evidence.kind, "no-progress");
	assert.equal(evidence.count, 3);
	assert.equal(evidence.invocation, "src/a.ts");
});

test("a shell poll repeated is not no-progress, because a shell is not observable", () => {
	// Polling a warming server through bash is the same workflow as polling
	// `subagent_status`; the detector cannot see that nothing changed on disk.
	const state = createLoopState();
	const poll = { command: "curl -s localhost:3000/healthz" };
	ran(state, "bash", poll, "starting");
	ran(state, "bash", poll, "starting");
	assert.equal(evaluateLoop(state, callOf("bash", poll)), null, "a shell poll must not be blocked");
});

test("a shell mutation repeated is not no-progress either", () => {
	// `echo x >> log` mutates the filesystem every time and produces identical
	// output; treating that as no-progress would block real work.
	const state = createLoopState();
	const append = { command: "echo step >> build.log" };
	ran(state, "bash", append, "");
	ran(state, "bash", append, "");
	assert.equal(evaluateLoop(state, callOf("bash", append)), null);
});

test("the loop detector fires on a repeated failure signature, even across edits", () => {
	// The edit/test cycle that reproduces one failure is exactly the loop a
	// settlement gate never sees, because the run never settles.
	const state = createLoopState();
	const test_ = { command: "node --test" };
	failed(state, "bash", test_, "AssertionError: boom");
	ran(state, "edit", { path: "src/a.ts", oldText: "x", newText: "y" });
	failed(state, "bash", test_, "AssertionError: boom");
	ran(state, "edit", { path: "src/a.ts", oldText: "y", newText: "z" });

	const evidence = evaluateLoop(state, callOf("bash", test_));
	assert.ok(evidence, "the third identical failure is a loop");
	assert.equal(evidence.kind, "repeated-failure");
	assert.equal(evidence.count, 3);
	assert.equal(evidence.detail, "AssertionError: boom");
});

test("the loop detector does not fire when the result changed or the call is only repeated twice", () => {
	const state = createLoopState();
	const build = { command: "npm run build" };
	ran(state, "bash", build, "built v1");
	assert.equal(evaluateLoop(state, callOf("bash", build)), null, "twice is a retry, not a loop");
	ran(state, "bash", build, "built v2");
	assert.equal(evaluateLoop(state, callOf("bash", build)), null, "a new result is progress");
});

test("the loop detector does not fire when a different edit happened in between", () => {
	const state = createLoopState();
	const build = { command: "npm run build" };
	ran(state, "bash", build, "unchanged output");
	ran(state, "edit", { path: "src/other.ts", oldText: "a", newText: "b" });
	ran(state, "bash", build, "unchanged output");
	assert.equal(evaluateLoop(state, callOf("bash", build)), null, "an intervening edit is progress");
});

test("a call recorded without a result cannot be evidence", () => {
	// A blocked call is never recorded by the factory; a call that is still
	// running has no result yet. Either way there is nothing to compare.
	const state = createLoopState();
	const build = { command: "npm run build" };
	ran(state, "bash", build);
	const pending = callOf("bash", build);
	recordCall(state, pending);
	assert.equal(evaluateLoop(state, callOf("bash", build)), null);
});

test("loop signatures are order-independent and separate different calls", () => {
	assert.equal(loopSignature("bash", { command: "ls", timeout: 1 }), loopSignature("bash", { timeout: 1, command: "ls" }));
	assert.notEqual(loopSignature("bash", { command: "ls" }), loopSignature("bash", { command: "ls -l" }));
	assert.notEqual(loopSignature("bash", { command: "ls" }), loopSignature("powershell", { command: "ls" }));
});

test("the record window is bounded", () => {
	const state = createLoopState();
	for (let index = 0; index < LOOP_WINDOW + 20; index += 1) ran(state, "bash", { command: `cmd-${index}` });
	assert.equal(state.records.length, LOOP_WINDOW);
});

// --- Factory wiring ---------------------------------------------------------

async function withTempProject<T>(config: unknown, fn: (cwd: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-loop-test-"));
	try {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify(config, null, 2));
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function startHost(cwd: string, role: OrchestratorRole = "parent"): Promise<FakeHost> {
	const host = createFakeHost({ sessionId: "orchestrator-loop-test", cwd });
	// The role is resolved once at module load; the seam lets a test drive the
	// worker path without mutating this process's environment after load.
	orchestratorExtension(host.pi, { role });
	return host;
}

interface BlockResult {
	block?: boolean;
	reason?: string;
	/** pi stops the agent early only when every result in the batch says so. */
	terminate?: boolean;
}

/** Fire one `tool_call`; when it was not blocked, hand it a result. */
async function runCall(
	host: FakeHost,
	tool: string,
	input: Record<string, unknown>,
	result: { text?: string; isError?: boolean } = {},
): Promise<BlockResult | undefined> {
	const outcome = (await host.fire("tool_call", { toolName: tool, input })) as BlockResult | undefined;
	if (outcome?.block) return outcome;
	await host.fire("tool_result", {
		toolName: tool,
		input,
		isError: result.isError ?? false,
		content: [{ type: "text", text: result.text ?? "same output" }],
	});
	return outcome;
}

function loopEntries(host: FakeHost): LoopVerdict[] {
	return host.appended
		.filter((entry) => entry.customType === GATE_LOOP_ENTRY_TYPE)
		.map((entry) => entry.data as LoopVerdict);
}

test("with no configuration the loop breaker is inert", async () => {
	await withTempProject({ version: 1 }, async (cwd) => {
		const host = await startHost(cwd);
		for (let index = 0; index < 4; index += 1) {
			assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		}
		assert.equal(loopEntries(host).length, 0);
		assert.equal(host.emitted.length, 0);
	});
});

test("with block.loops the third identical call is blocked, recorded and named with the override", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);

		const blocked = await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(blocked?.block, true, "the third identical call is blocked");
		assert.match(blocked?.reason ?? "", /orchestrator_override/);
		assert.match(blocked?.reason ?? "", /src\/a\.ts/);
		assert.equal(blocked?.terminate, undefined, "a block never terminates the run");

		const recorded = loopEntries(host);
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0]?.action, "block");
		assert.equal(recorded[0]?.attempts, 1);
		assert.equal(recorded[0]?.kind, "no-progress");

		const event = host.emitted.find((candidate) => candidate.channel === ORCHESTRATION_EVENTS.gateDecided);
		assert.equal((event?.data as { action?: string }).action, "loop-block");
	});
});

test("a non-loop tool is never blocked however often it repeats", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		for (let index = 0; index < 6; index += 1) {
			assert.equal(await runCall(host, "subagent_status", { id: "run-1" }, { text: "running" }), undefined);
		}
		assert.equal(loopEntries(host).length, 0);
	});
});

test("three identical shell calls are never no-progress, even with loops enabled", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		for (let index = 0; index < 4; index += 1) {
			assert.equal(await runCall(host, "bash", { command: "curl -s localhost:3000/healthz" }, { text: "starting" }), undefined);
		}
		assert.equal(loopEntries(host).length, 0);
	});
});

test("an override lets the repeated call run, is consumed, and is recorded", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		// The tool is registered only for a project that opted in, and it arrives at
		// session start — before the calls, which the same event clears.
		await host.fire("session_start", {});
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });

		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "iterating on a flaky network failure" });
		assert.ok(host.appended.some((entry) => entry.customType === GATE_OVERRIDE_ENTRY_TYPE), "the grant is recorded");

		const allowed = await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(allowed, undefined, "the override lets the call run");
		const recorded = loopEntries(host);
		assert.equal(recorded.at(-1)?.action, "override");
		assert.match(recorded.at(-1)?.reason ?? "", /iterating on a flaky network failure/);
		assert.equal(recorded.at(-1)?.attempts, 0, "an override spends no attempt");

		// Consumed: the next identical block is a block again, not another override.
		const blocked = await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(blocked?.block, true);
	});
});

test("the loop breaker is capped per turn and re-armed by the next turn", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal((await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }))?.block, true);

		// One block per turn: the same call now runs, and it produced the same
		// result again — the detector fires, the cap lets the call through.
		assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 1);

		// A new turn re-arms it.
		await host.fire("turn_start", { turnIndex: 1 });
		assert.equal((await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }))?.block, true);
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 2);
	});
});

test("loopAttemptCap bounds loop blocks independently from settlement attemptCap", async () => {
	await withTempProject({ version: 1, attemptCap: 1, loopAttemptCap: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal((await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }))?.block, true, "the first block spends the loop budget");

		await host.fire("turn_start", { turnIndex: 1 });
		const allowed = await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(allowed, undefined, "an exhausted loop budget lets the call run rather than trapping the run");
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 1);
	});
});

test("3 mid-run loop blocks exhaust loopAttemptCap while leaving settlement attemptCap untouched", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-loop-sep-"));
	try {
		await mkdir(path.join(dir, ".pi", "todos"), { recursive: true });
		await writeFile(
			path.join(dir, ".pi", "todos", "aaaaaaaa.md"),
			`${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`,
		);
		await writeFile(
			gateConfigPath(dir),
			JSON.stringify({ version: 1, attemptCap: 2, block: { loops: true, openTodos: true } }),
		);

		const host = await startHost(dir);
		await host.fire("session_start", {});

		const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
		await runCall(host, "edit", edit);
		await runCall(host, "edit", edit);

		// 3 mid-run loop blocks across 3 turns exhaust default loopAttemptCap (3).
		for (let turn = 0; turn < 3; turn += 1) {
			if (turn > 0) await host.fire("turn_start", { turnIndex: turn });
			const blocked = await runCall(host, "edit", edit);
			assert.equal(blocked?.block, true, `loop block ${turn + 1} must fire`);
		}
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 3);
		assert.equal(loopEntries(host).at(-1)?.attempts, 3);
		assert.equal(loopEntries(host).at(-1)?.attemptCap, 3);

		// 4th turn: loopAttemptCap is exhausted so the loop breaker stops blocking.
		await host.fire("turn_start", { turnIndex: 3 });
		assert.equal(await runCall(host, "edit", edit), undefined, "loopAttemptCap exhaustion lets the call run");
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 3);

		// Now simulate branch resume carrying the 3 loop blocks before settlement.
		const branch = host.appended.map((entry, idx) => ({
			type: "custom",
			id: `e-${idx}`,
			customType: entry.customType,
			data: entry.data,
		}));
		const resumed = createFakeHost({ sessionId: "orchestrator-loop-sep-resumed", cwd: dir, branch });
		orchestratorExtension(resumed.pi, { role: "parent" });
		await resumed.fire("session_start", {});

		// Settlement gate must STILL fire because its attempts (0) < attemptCap (2).
		const settlement = (await resumed.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { entries?: { customType?: string; data?: { decision?: string; attempts?: number; attemptCap?: number } }[]; continue?: boolean };
		assert.equal(settlement.continue, true, "settlement gate must still fire after loopAttemptCap was exhausted");
		const gateVerdict = settlement.entries?.find((e) => e.customType === "orchestrator-gate")?.data;
		assert.equal(gateVerdict?.decision, "continue");
		assert.equal(gateVerdict?.attempts, 1, "settlement gate attempts start at 1, untouched by loop blocks");
		assert.equal(gateVerdict?.attemptCap, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("custom loopAttemptCap is independent from attemptCap even when attemptCap is smaller", async () => {
	await withTempProject({ version: 1, attemptCap: 1, loopAttemptCap: 2, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
		await runCall(host, "edit", edit);
		await runCall(host, "edit", edit);
		assert.equal((await runCall(host, "edit", edit))?.block, true, "loop block 1");
		await host.fire("turn_start", { turnIndex: 1 });
		assert.equal((await runCall(host, "edit", edit))?.block, true, "loop block 2 must still fire despite attemptCap=1");
		await host.fire("turn_start", { turnIndex: 2 });
		assert.equal(await runCall(host, "edit", edit), undefined, "loop block 3 is stopped by loopAttemptCap=2");
	});
});

test("a delegated child session never blocks a tool call", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd, "worker");
		for (let index = 0; index < 4; index += 1) {
			assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		}
		assert.equal(loopEntries(host).length, 0);
	});
});

test("an untrusted project never blocks a tool call", async () => {
	// The guard honours the same trust boundary as the settlement: the config that
	// turns it on comes from the project.
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = createFakeHost({ sessionId: "untrusted-loop", cwd, trusted: false });
		orchestratorExtension(host.pi);
		for (let index = 0; index < 4; index += 1) {
			assert.equal(await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }), undefined);
		}
		assert.equal(loopEntries(host).length, 0);
	});
});

test("agent_start re-arms the per-turn loop cap as well as turn_start", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
		await runCall(host, "edit", edit);
		await runCall(host, "edit", edit);
		assert.equal((await runCall(host, "edit", edit))?.block, true);

		// The same reset pi fires at the top of every low-level run.
		await host.fire("agent_start", {});
		assert.equal((await runCall(host, "edit", edit))?.block, true);
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 2);
	});
});

test("/gate shows a loop block, and --json returns it", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });

		await host.runCommand("gate");
		const text = String(host.messages.at(-1)?.message.content ?? "");
		assert.match(text, /LOOP BLOCKED/);
		assert.match(text, /src\/a\.ts/);

		await host.runCommand("gate", "--json");
		const parsed = JSON.parse(String(host.messages.at(-1)?.message.content ?? "")) as {
			loop?: LoopVerdict;
			verdict?: unknown;
		};
		assert.equal(parsed.loop?.action, "block");
		assert.equal(parsed.verdict, null);
	});
});

test("a blocked call is not recorded, so the evidence survives the block", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		// The same call after a turn boundary is blocked again from the same
		// evidence: a blocked call never becomes a result to compare against.
		await host.fire("turn_start", { turnIndex: 1 });
		assert.equal((await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }))?.block, true);
	});
});

test("entries from a loop block are plain session entries", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		const entry = host.appended.find((candidate) => candidate.customType === GATE_LOOP_ENTRY_TYPE) as Entry | undefined;
		assert.ok(entry);
		assert.equal(typeof (entry?.data as LoopVerdict).reason, "string");
		assert.equal((entry?.data as LoopVerdict).remainingAttempts, 2);
	});
});

test("recordResult matches pending records by toolCallId when input changes, falling back to signature only when toolCallId is absent", () => {
	const state = createLoopState();
	const orig = { path: "src/a.ts", oldText: "a", newText: "b" };
	const mutated = { path: "src/a.ts", oldText: "a", newText: "b", normalized: true };

	recordCall(state, { ...callOf("edit", orig), toolCallId: "tc-1" });
	recordResult(state, { ...callOf("edit", mutated), toolCallId: "tc-1" }, { isError: false, text: "ok" });
	assert.notEqual(state.records[0]?.result, null, "matching by toolCallId must resolve a mutated-input call");
	assert.equal(state.records[0]?.mutation, true);

	// Unknown toolCallId must not fall back to signature and close another pending call.
	recordCall(state, { ...callOf("edit", orig), toolCallId: "tc-2" });
	recordResult(state, { ...callOf("edit", orig), toolCallId: "tc-other" }, { isError: false, text: "wrong" });
	assert.equal(state.records[1]?.result, null, "mismatched toolCallId must not resolve tc-2 by signature");

	// Without toolCallId, fallback to signature still resolves pending calls.
	recordCall(state, callOf("edit", orig));
	recordResult(state, callOf("edit", orig), { isError: false, text: "ok" });
	assert.notEqual(state.records[2]?.result, null, "absent toolCallId falls back to signature");
});

test("unresolved result===null records from earlier turns or superseded calls do not disable evaluateLoop", () => {
	const state = createLoopState();
	const edit = { path: "src/a.ts", oldText: "a", newText: "b" };
	ran(state, "edit", edit, "ok");
	recordCall(state, { ...callOf("edit", edit), toolCallId: "tc-superseded" }); // never gets a result
	ran(state, "edit", edit, "ok");

	const evidence = evaluateLoop(state, callOf("edit", edit));
	assert.ok(evidence, "an unresolved call between two completed calls must not disable evaluateLoop");
	assert.equal(evidence.kind, "no-progress");
});

test("loop breaker pairs mutated event.input via toolCallId and blocks the third identical call", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		// Downstream extension mutates event.input between tool_call and tool_result.
		host.pi.on("tool_call", async (event) => {
			if (event.toolName === "edit" && event.input && typeof event.input === "object") {
				(event.input as Record<string, unknown>)._mutatedByDownstream = true;
			}
		});

		const originalInput = { path: "src/a.ts", oldText: "a", newText: "b" };
		for (const id of ["tc-1", "tc-2"]) {
			const input = { ...originalInput };
			const outcome = (await host.fire("tool_call", { toolName: "edit", toolCallId: id, input })) as BlockResult | undefined;
			assert.equal(outcome, undefined);
			// Host passes the mutated input into tool_result.
			await host.fire("tool_result", {
				toolName: "edit",
				toolCallId: id,
				input,
				isError: false,
				content: [{ type: "text", text: "same output" }],
			});
		}

		const blocked = (await host.fire("tool_call", {
			toolName: "edit",
			toolCallId: "tc-3",
			input: { ...originalInput },
		})) as BlockResult | undefined;
		assert.equal(blocked?.block, true, "the third call must still be blocked despite downstream input mutation");
	});
});

test("a downstream-blocked tool_call without a tool_result does not disable loop detection", async () => {
	await withTempProject({ version: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		// Downstream extension blocks only toolCallId === "tc-downstream-blocked".
		host.pi.on("tool_call", async (event) => {
			if (event.toolCallId === "tc-downstream-blocked") {
				return { block: true, reason: "blocked downstream" };
			}
			return undefined;
		});

		const edit = { path: "src/a.ts", oldText: "a", newText: "b" };

		// 1. tc-1 runs and completes.
		assert.equal(await host.fire("tool_call", { toolName: "edit", toolCallId: "tc-1", input: { ...edit } }), undefined);
		await host.fire("tool_result", {
			toolName: "edit",
			toolCallId: "tc-1",
			input: { ...edit },
			isError: false,
			content: [{ type: "text", text: "same output" }],
		});

		// 2. tc-downstream-blocked is blocked downstream -> no tool_result ever arrives.
		const downstreamBlocked = (await host.fire("tool_call", {
			toolName: "edit",
			toolCallId: "tc-downstream-blocked",
			input: { ...edit },
		})) as BlockResult | undefined;
		assert.equal(downstreamBlocked?.block, true);

		// 3. tc-2 runs and completes with the same result.
		assert.equal(await host.fire("tool_call", { toolName: "edit", toolCallId: "tc-2", input: { ...edit } }), undefined);
		await host.fire("tool_result", {
			toolName: "edit",
			toolCallId: "tc-2",
			input: { ...edit },
			isError: false,
			content: [{ type: "text", text: "same output" }],
		});

		// 4. tc-3 must be blocked by the orchestrator loop breaker (same turn AND after turn_start).
		const blockedSameTurn = (await host.fire("tool_call", {
			toolName: "edit",
			toolCallId: "tc-3",
			input: { ...edit },
		})) as BlockResult | undefined;
		assert.equal(blockedSameTurn?.block, true, "downstream-blocked call must not disable loop detection");
		assert.match(blockedSameTurn?.reason ?? "", /loop breaker/);
	});
});
