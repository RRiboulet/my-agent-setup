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

test("the branch budget bounds loop blocks as well as settlement blocks", async () => {
	await withTempProject({ version: 1, attemptCap: 1, block: { loops: true } }, async (cwd) => {
		const host = await startHost(cwd);
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal((await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" }))?.block, true, "the first block spends the budget");

		await host.fire("turn_start", { turnIndex: 1 });
		const allowed = await runCall(host, "edit", { path: "src/a.ts", oldText: "a", newText: "b" });
		assert.equal(allowed, undefined, "an exhausted budget lets the call run rather than trapping the run");
		assert.equal(loopEntries(host).filter((entry) => entry.action === "block").length, 1);
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
