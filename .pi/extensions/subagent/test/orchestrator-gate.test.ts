// The settlement gate (ticket 08): the pure decision function, the session-log
// state reconstruction, the disk readers, and the factory wiring through the
// fake extension host.
//
// The factory part asserts on the boundary RETURNED proposal, not on
// `pi.sendMessage`: `agent_before_settle` has no message channel. It also pins
// the report-only contract in the strongest available form — the gate's result
// has no `continue` property at all, and every earlier handler's draft is still
// present — so a later ticket that adds action must change this test
// deliberately.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	evaluateGate,
	formatVerdict,
	GATE_ENTRY_TYPE,
	reconstructGateState,
	scanEditVerification,
	scanFailures,
	type GateVerdict,
} from "../../orchestrator/gate.ts";
import { gateConfigPath, normalizeGateConfig, readGateConfig } from "../../orchestrator/config.ts";
import { ORCHESTRATION_EVENTS } from "../../orchestrator/events.ts";
import { readOpenTodos, todoDirectory } from "../../orchestrator/todo-state.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

type Entry = Record<string, unknown>;

function custom(customType: string, data: unknown): Entry {
	return { type: "custom", id: `entry-${Math.random()}`, customType, data };
}

function goalEntry(status = "active", objective = "ship the gate"): Entry {
	return custom("goal", {
		version: 2,
		action: "set",
		goal: {
			id: "goal-under-test",
			objective,
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 2,
		},
	});
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): Entry {
	return {
		type: "message",
		id: `msg-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	};
}

function toolResult(id: string, toolName: string, options: { text?: string; isError?: boolean } = {}): Entry {
	return {
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: [{ type: "text", text: options.text ?? "ok" }],
			isError: options.isError ?? false,
		},
	};
}

function gateStateEntry(attempts: number, retryCap = 3): Entry {
	return custom(GATE_ENTRY_TYPE, {
		version: 1,
		kind: "attention",
		decision: "report",
		outcome: "completed",
		at: 1,
		attempts,
		retryCap,
		remainingAttempts: Math.max(0, retryCap - attempts),
		reasons: [{ code: "goal-active", summary: "a goal is still active" }],
		conditions: [{ kind: "goal", status: "attention", summary: "a goal is still active" }],
	});
}

function boundaryEvent(entries: Entry[] = [], overrides: Record<string, unknown> = {}) {
	return {
		entries,
		continue: false,
		context: { pendingMessages: [] },
		outcome: "completed",
		...overrides,
	};
}

interface BoundaryProposal {
	entries?: ({ type?: string; customType?: string; data?: GateVerdict } & Entry)[];
	continue?: boolean;
}

function gateVerdictOf(result: unknown): GateVerdict {
	const proposal = (result ?? {}) as BoundaryProposal;
	const found = proposal.entries?.find((entry) => entry.customType === GATE_ENTRY_TYPE);
	assert.ok(found?.data, "the boundary result must carry one orchestrator-gate entry");
	return found.data;
}

async function startHost(options: { branch?: Entry[]; hasUI?: boolean; cwd?: string } = {}) {
	const host = createFakeHost({
		sessionId: "orchestrator-gate-test",
		branch: options.branch ?? [],
		hasUI: options.hasUI,
		cwd: options.cwd,
	});
	orchestratorExtension(host.pi);
	return host;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-gate-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// --- Pure decision function -------------------------------------------------

test("evaluateGate reports an active goal, open todos, unverified edits, a repeated failure and the retry cap", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 2,
		retryCap: 3,
		activeGoal: { id: "g1", objective: "finish the ticket" },
		openTodos: [{ id: "aaaaaaaa", title: "write the test", status: "open" }],
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 0 },
		failure: { signature: "bash|npm test|failed", count: 2, tool: "bash", detail: "failed" },
		now: 42,
	});

	assert.equal(verdict.decision, "report", "ticket 08 never decides to block or continue");
	assert.equal(verdict.kind, "attention");
	assert.equal(verdict.attempts, 3, "the current evaluation is counted");
	assert.equal(verdict.remainingAttempts, 0);
	assert.equal(verdict.at, 42);
	assert.deepEqual(
		verdict.reasons.map((reason) => reason.code),
		["goal-active", "open-todos", "edits-without-verification", "repeated-failure", "retry-cap-reached"],
	);
	const details = Object.fromEntries(verdict.reasons.map((reason) => [reason.code, reason.details]));
	assert.deepEqual(details["open-todos"], { ids: ["aaaaaaaa"], titles: ["write the test"] });
	assert.deepEqual(details["edits-without-verification"], { files: ["src/a.ts"] });
	assert.equal(details["retry-cap-reached"]?.attempts, 3);
});

test("evaluateGate is clear when nothing is open and still counts the attempt", () => {
	const verdict = evaluateGate({ outcome: "completed", attempts: 0, retryCap: 3, now: 1 });
	assert.equal(verdict.kind, "clear");
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.attempts, 1);
	assert.equal(verdict.remainingAttempts, 2);
	assert.deepEqual(verdict.reasons, []);
});

test("evaluateGate marks an unevaluable condition unknown but still report-only", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		retryCap: 3,
		unevaluated: ["todos: permission denied"],
		now: 1,
	});
	assert.equal(verdict.kind, "attention");
	assert.equal(verdict.decision, "report");
	assert.ok(verdict.conditions.some((condition) => condition.kind === "unevaluated" && condition.status === "unknown"));
	assert.equal(verdict.reasons[0]?.code, "unevaluated");
});

test("formatVerdict names the attempt, the reasons and the unevaluated conditions", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		retryCap: 3,
		openTodos: [{ id: "deadbeef", title: "t", status: "open" }],
		unevaluated: ["config: broken"],
		now: 1,
	});
	const text = formatVerdict(verdict);
	assert.match(text, /ATTENTION \(report-only\)/);
	assert.match(text, /Attempt 1 of 3/);
	assert.match(text, /open todo: deadbeef/);
	assert.match(text, /Unevaluated \(reported, not blocking\):/);
});

// --- Session-backed state ---------------------------------------------------

test("reconstructGateState takes the last verdict and its attempt count", () => {
	const state = reconstructGateState([gateStateEntry(1), gateStateEntry(4)]);
	assert.equal(state.attempts, 4);
	assert.equal(state.lastVerdict?.attempts, 4);
});

test("reconstructGateState ignores malformed entries and a branch before any decision", () => {
	assert.deepEqual(reconstructGateState([]), { attempts: 0, lastVerdict: null });
	const state = reconstructGateState([custom(GATE_ENTRY_TYPE, { nonsense: true }), gateStateEntry(2)]);
	assert.equal(state.attempts, 2);
});

// --- Branch readers ---------------------------------------------------------

test("scanEditVerification clears an edit once a verification command succeeds", () => {
	const branch = [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit"),
		assistantCall("b1", "bash", { command: "npm test" }),
		toolResult("b1", "bash"),
	];
	assert.deepEqual(scanEditVerification(branch), { editedFiles: [], verificationRuns: 1 });
});

test("scanEditVerification keeps an edit made after the last verification run", () => {
	const branch = [
		assistantCall("b1", "bash", { command: "npm test" }),
		toolResult("b1", "bash"),
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit"),
		assistantCall("w1", "write", { path: "src/b.ts" }),
		toolResult("w1", "write"),
	];
	assert.deepEqual(scanEditVerification(branch), { editedFiles: ["src/a.ts", "src/b.ts"], verificationRuns: 1 });
});

test("scanEditVerification ignores a failed edit", () => {
	const branch = [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit", { isError: true, text: "no match" }),
	];
	assert.deepEqual(scanEditVerification(branch), { editedFiles: [], verificationRuns: 0 });
});

test("scanFailures reports the same failing invocation repeated, not two different failures", () => {
	const repeated = [
		assistantCall("b1", "bash", { command: "npm test" }),
		toolResult("b1", "bash", { isError: true, text: "AssertionError: boom\n  at a.ts:1" }),
		assistantCall("b2", "bash", { command: "npm test" }),
		toolResult("b2", "bash", { isError: true, text: "AssertionError: boom\n  at a.ts:2" }),
	];
	const found = scanFailures(repeated);
	assert.equal(found?.count, 2);
	assert.equal(found?.tool, "bash");
	assert.equal(found?.detail, "AssertionError: boom");

	const different = [
		assistantCall("b1", "bash", { command: "npm test" }),
		toolResult("b1", "bash", { isError: true, text: "AssertionError: boom" }),
		assistantCall("b2", "bash", { command: "npm test" }),
		toolResult("b2", "bash", { isError: true, text: "Error: timeout" }),
	];
	assert.equal(scanFailures(different), null);
});

// --- Disk readers -----------------------------------------------------------

test("readOpenTodos mirrors the todo file format and skips closed todos", async () => {
	await withTempDir(async (dir) => {
		await writeFile(path.join(dir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "open item", status: "open" })}\n\nbody\n`);
		await writeFile(path.join(dir, "bbbbbbbb.md"), `${JSON.stringify({ id: "bbbbbbbb", title: "done item", status: "closed" })}\n`);
		await writeFile(path.join(dir, "cccccccc.md"), `${JSON.stringify({ id: "cccccccc", title: "done spelling", status: "Done" })}\n`);
		await writeFile(path.join(dir, "dddddddd.md"), "not JSON at all\n");
		await withEnv({ PI_TODO_PATH: dir }, async () => {
			const read = await readOpenTodos(dir);
			assert.equal(read.error, undefined);
			assert.deepEqual(read.todos, [
				{ id: "aaaaaaaa", title: "open item", status: "open" },
				{ id: "dddddddd", title: "", status: "open" },
			]);
		});
	});
});

test("a hand-edited todo with leading whitespace is open, as the todo list reads it", async () => {
	// `todos.ts`'s `splitFrontMatter` tests the raw first byte, so leading whitespace
	// means "no front matter" there: the todo list shows the file open and untitled.
	// A reader that trimmed first would parse it as closed and skip it — a missed
	// report for a todo the list shows as open.
	await withTempDir(async (dir) => {
		await writeFile(
			path.join(dir, "eeeeeeee.md"),
			`  ${JSON.stringify({ id: "eeeeeeee", title: "indented", status: "closed" })}\n`,
		);
		await withEnv({ PI_TODO_PATH: dir }, async () => {
			const read = await readOpenTodos(dir);
			assert.equal(read.error, undefined);
			assert.deepEqual(read.todos, [{ id: "eeeeeeee", title: "", status: "open" }]);
		});
	});
});

test("readOpenTodos treats a missing directory as no todos and a non-directory as unevaluable", async () => {
	await withTempDir(async (dir) => {
		const missing = path.join(dir, "missing");
		await withEnv({ PI_TODO_PATH: missing }, async () => {
			assert.deepEqual(await readOpenTodos(dir), { todos: [] });
		});
		const file = path.join(dir, "not-a-directory");
		await writeFile(file, "x");
		await withEnv({ PI_TODO_PATH: file }, async () => {
			const read = await readOpenTodos(dir);
			assert.equal(read.todos.length, 0);
			assert.match(read.error ?? "", /is not a directory/);
		});
	});
});

test("todoDirectory honours PI_TODO_PATH and otherwise resolves .pi/todos", async () => {
	await withEnv({ PI_TODO_PATH: undefined }, async () => {
		assert.equal(todoDirectory("/repo"), path.resolve("/repo", ".pi/todos"));
	});
	await withEnv({ PI_TODO_PATH: "custom/todos" }, async () => {
		assert.equal(todoDirectory("/repo"), path.resolve("/repo", "custom/todos"));
	});
});

test("readGateConfig defaults when absent, and reports a malformed file rather than throwing", async () => {
	await withTempDir(async (dir) => {
		assert.equal(gateConfigPath(dir), path.join(dir, ".pi", "orchestrator.json"));
		const missing = readGateConfig(dir);
		assert.equal(missing.source, "default");
		assert.equal(missing.config.retryCap, 3);
		assert.equal(missing.warning, undefined);

		await withTempDir(async (configDir) => {
			await mkdir(path.join(configDir, ".pi"), { recursive: true });
			await writeFile(gateConfigPath(configDir), "{ not json");
			const broken = readGateConfig(configDir);
			assert.equal(broken.source, "default");
			assert.match(broken.warning ?? "", /not valid JSON/);
		});
	});
});

test("normalizeGateConfig validates retryCap and ignores unknown keys", () => {
	assert.deepEqual(normalizeGateConfig({ version: 1, retryCap: 5, future: true }), {
		config: { version: 1, retryCap: 5 },
		warnings: [],
	});
	const invalid = normalizeGateConfig({ version: 1, retryCap: -1 });
	assert.equal(invalid.config.retryCap, 3);
	assert.match(invalid.warnings[0] ?? "", /non-negative integer/);
	const future = normalizeGateConfig({ version: 99, retryCap: 2 });
	assert.equal(future.config.retryCap, 2);
	assert.match(future.warnings[0] ?? "", /unsupported config version/);
});

// --- Factory wiring ---------------------------------------------------------

test("the settlement boundary records a report-only verdict with every open condition and publishes it", async () => {
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "open", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			const host = await startHost({
				branch: [
					goalEntry(),
					assistantCall("e1", "edit", { path: "src/a.ts" }),
					toolResult("e1", "edit"),
					assistantCall("b1", "bash", { command: "npm test" }),
					toolResult("b1", "bash", { isError: true, text: "boom" }),
					assistantCall("b2", "bash", { command: "npm test" }),
					toolResult("b2", "bash", { isError: true, text: "boom" }),
				],
			});
			await host.fire("session_start", {});

			const sentinel = { type: "custom", customType: "another-extension", data: { proposed: true } };
			const result = (await host.fire("agent_before_settle", boundaryEvent([sentinel]))) as BoundaryProposal;
			const verdict = gateVerdictOf(result);

			assert.equal(result.continue, undefined, "the gate must not request a continuation");
			assert.ok(result.entries?.includes(sentinel as never), "an earlier handler's draft survives");
			assert.equal(verdict.decision, "report");
			assert.equal(verdict.kind, "attention");
			assert.equal(verdict.attempts, 1);
			assert.deepEqual(
				verdict.reasons.map((reason) => reason.code),
				["goal-active", "open-todos", "edits-without-verification", "repeated-failure"],
			);
			assert.equal(host.emitted.length, 1);
			assert.equal(host.emitted[0]?.channel, ORCHESTRATION_EVENTS.gateDecided);
			assert.deepEqual((host.emitted[0]?.data as { verdict: GateVerdict }).verdict, verdict);

			// What the boundary proposed is what a later load reconstructs: the
			// reasons are in the session entry, not only in this return value.
			const recovered = reconstructGateState(result.entries ?? []);
			assert.deepEqual(recovered.lastVerdict, verdict);
			assert.equal(recovered.attempts, verdict.attempts);
		});
	});
});

test("with no configuration the gate reports clear and never blocks or continues", async () => {
	await withTempDir(async (cwd) => {
		// A fresh project directory: no .pi/orchestrator.json and no todos.
		const host = await startHost({ branch: [], cwd });
		const sentinel = { type: "custom", customType: "another-extension", data: null };
		const result = (await host.fire("agent_before_settle", boundaryEvent([sentinel]))) as BoundaryProposal;
		const verdict = gateVerdictOf(result);

		assert.equal(verdict.kind, "clear");
		assert.equal(verdict.decision, "report");
		assert.equal(result.continue, undefined);
		assert.ok(result.entries?.includes(sentinel as never));
	});
});

test("when a goal already owns the continuation the gate does not request another", async () => {
	const host = await startHost({ branch: [goalEntry()] });
	await host.fire("session_start", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent([], { continue: true }))) as BoundaryProposal;
	const verdict = gateVerdictOf(result);

	assert.equal(verdict.reasons[0]?.code, "goal-active");
	assert.equal(result.continue, undefined, "yield by leaving the field alone; never return continue: true");
});

test("verdicts and attempt counts survive a simulated resume", async () => {
	const host = await startHost({ branch: [gateStateEntry(2)] });
	await host.fire("session_start", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	assert.equal(gateVerdictOf(result).attempts, 3);
});

test("session_tree re-reconstructs the last decision instead of resetting it", async () => {
	const host = await startHost({ branch: [gateStateEntry(2)] });
	await host.fire("session_start", {});
	await host.fire("session_tree", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	assert.equal(gateVerdictOf(result).attempts, 3);
});

test("a cap reached before a resume stays reached after it", async () => {
	const first = await startHost({ branch: [gateStateEntry(2)] });
	await first.fire("session_start", {});
	const settled = (await first.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	assert.equal(gateVerdictOf(settled).remainingAttempts, 0);

	// The next load sees the entry the boundary just proposed.
	const resumed = await startHost({ branch: [gateStateEntry(3)] });
	await resumed.fire("session_start", {});
	const after = (await resumed.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	const verdict = gateVerdictOf(after);
	assert.equal(verdict.attempts, 4);
	assert.equal(verdict.remainingAttempts, 0);
	assert.ok(verdict.reasons.some((reason) => reason.code === "retry-cap-reached"));
});

test("a condition that cannot be evaluated produces a report-only verdict, not an error or a block", async () => {
	await withTempDir(async (dir) => {
		const notADirectory = path.join(dir, "todos-is-a-file");
		await writeFile(notADirectory, "x");
		await withEnv({ PI_TODO_PATH: notADirectory }, async () => {
			const host = await startHost({ branch: [] });
			const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const verdict = gateVerdictOf(result);

			assert.equal(verdict.decision, "report");
			assert.equal(result.continue, undefined);
			assert.ok(verdict.reasons.some((reason) => reason.code === "unevaluated"));
			assert.match(verdict.reasons.find((reason) => reason.code === "unevaluated")?.summary ?? "", /todos:/);
		});
	});
});

test("/gate shows the last verdict, and --json returns it verbatim", async () => {
	await withTempDir(async (cwd) => {
		const host = await startHost({ branch: [], cwd });
		await host.fire("agent_before_settle", boundaryEvent());
		const verdict = gateVerdictOf(await host.fire("agent_before_settle", boundaryEvent()));

		await host.runCommand("gate");
		const text = String(host.messages.at(-1)?.message.content ?? "");
		assert.match(text, /Orchestration gate: CLEAR \(report-only\)/);
		assert.match(text, new RegExp(`Attempt ${verdict.attempts} of 3`));

		await host.runCommand("gate", "--json");
		const json = String(host.messages.at(-1)?.message.content ?? "");
		assert.deepEqual(JSON.parse(json), verdict);
	});
});
