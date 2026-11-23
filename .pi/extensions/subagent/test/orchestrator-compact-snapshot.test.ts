// The post-compaction snapshot: what the model is told again after pi has
// replaced the conversation with a summary.
//
// The gate's and the advisor's state is branch-derived, so compaction cannot
// lose it — the tests at the end pin that this change leaves reconstruction
// alone. What the model loses is its own context, and the snapshot is the only
// repair: one `orchestrator:compact-snapshot` custom message after a successful
// compaction, no message when there is nothing to report, none after a failure,
// and no `session_before_compact` handler anywhere — compaction itself stays
// pi's.
//
// The bound is tested twice on purpose: the pure builder's, so a huge input is
// still bounded, and the wiring's, so the handler actually goes through it.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ADVISOR_ENTRY_TYPE, readAdvisorState } from "../../orchestrator/advisor.ts";
import { gateConfigPath } from "../../orchestrator/config.ts";
import {
	buildCompactSnapshot,
	MAX_COMPACT_SNAPSHOT_BYTES,
} from "../../orchestrator/compact-snapshot.ts";
import { ORCHESTRATION_EVENTS, ORCHESTRATOR_CUSTOM_TYPES } from "../../orchestrator/events.ts";
import { GATE_ENTRY_TYPE, reconstructGateState } from "../../orchestrator/gate.ts";
import { todoDirectory } from "../../orchestrator/todo-state.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

type Entry = Record<string, unknown>;

function custom(customType: string, data: unknown): Entry {
	return { type: "custom", id: `entry-${Math.random()}`, customType, data };
}

function goalEntry(objective = "ship the gate"): Entry {
	return custom("goal", {
		version: 2,
		action: "set",
		goal: {
			id: "goal-under-test",
			objective,
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 2,
		},
	});
}

function gateEntry(extra: Record<string, unknown> = {}): Entry {
	return custom(GATE_ENTRY_TYPE, {
		version: 2,
		kind: "attention",
		decision: "continue",
		outcome: "completed",
		at: 1,
		scope: "parent",
		attempts: 2,
		attemptCap: 3,
		remainingAttempts: 1,
		blockedBy: ["todos"],
		blockedConditions: ["todos", "verification"],
		blockedEvidence: { todos: "aaaaaaaa", verification: "src/a.ts#1" },
		verification: null,
		override: null,
		reason: "an open todo and unverified edits remain",
		reasons: [],
		conditions: [],
		...extra,
	});
}

function advisorEntry(triggerKey = "loop:bash|npm test|repeated-failure"): Entry {
	return custom(ADVISOR_ENTRY_TYPE, {
		version: 1,
		at: 10,
		trigger: { kind: "loop-block", key: triggerKey, summary: "a loop" },
		model: { provider: "opencode-go", model: "glm-5.3-flash" },
		fallbackFrom: null,
		status: "ok",
		called: true,
		reason: "answered",
		verdict: "the test is wrong",
		usage: null,
		digest: { text: "digest", bytes: 6, truncated: false },
		latencyMs: 5,
	});
}

function compactionEvent(): Record<string, unknown> {
	return {
		compactionEntry: { type: "compaction", id: "compaction-1", summary: "a summary of the earlier turns" },
		fromExtension: false,
		reason: "manual",
		willRetry: false,
	};
}

function emitOrchestration(host: Awaited<ReturnType<typeof startHost>>, channel: string, data: unknown): void {
	(host.pi.events as unknown as { emit: (name: string, payload: unknown) => void }).emit(channel, data);
}

async function startHost(
	options: {
		branch?: Entry[];
		cwd?: string;
	} = {},
) {
	const host = createFakeHost({
		sessionId: "orchestrator-compact-snapshot-test",
		branch: options.branch ?? [],
		cwd: options.cwd,
	});
	orchestratorExtension(host.pi);
	return host;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-compact-snapshot-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeTodo(directory: string, id: string, title: string): Promise<void> {
	await writeFile(path.join(directory, `${id}.md`), `${JSON.stringify({ id, title, status: "open" })}\n`);
}

/** A project that opted into the advisor, so its budget belongs in the snapshot. */
async function writeAdvisorConfig(cwd: string, budget = 2): Promise<void> {
	await mkdir(path.join(cwd, ".pi"), { recursive: true });
	await writeFile(
		gateConfigPath(cwd),
		JSON.stringify({
			version: 1,
			attemptCap: 3,
			advisor: { provider: "opencode-go", model: "glm-5.3-flash", budget },
		}),
	);
}

test("a successful compaction emits exactly one snapshot naming goal, todos, gate, live runs and advisor", async () => {
	await withTempDir(async (cwd) => {
		const todosDir = path.join(cwd, "todos");
		await mkdir(todosDir, { recursive: true });
		await writeTodo(todosDir, "aaaaaaaa", "finish the gate");
		await writeAdvisorConfig(cwd);

		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			const host = await startHost({ cwd, branch: [goalEntry(), gateEntry(), advisorEntry()] });
			await host.fire("session_start", {});
			emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-live", status: "running", at: 1 });

			await host.fire("session_compact", compactionEvent());

			assert.equal(host.messages.length, 1, "exactly one message per successful compaction");
			const sent = host.messages[0]!;
			assert.equal(sent.message.customType, ORCHESTRATOR_CUSTOM_TYPES.compactSnapshot);
			assert.equal(sent.message.customType, "orchestrator:compact-snapshot");
			assert.equal(sent.message.display, false, "bookkeeping, not a transcript message");
			assert.equal(sent.options?.triggerTurn, false, "the snapshot never starts a turn");

			const content = String(sent.message.content);
			assert.match(content, /Active goal: ship the gate/);
			assert.match(content, /aaaaaaaa/);
			assert.match(content, /finish the gate/);
			assert.match(content, /2 of 3/, "the attempt budget is carried");
			assert.match(content, /blocked on todos: aaaaaaaa/);
			assert.match(content, /blocked on verification: src\/a\.ts#1/);
			assert.match(content, /Last verdict: an open todo and unverified edits remain/);
			assert.match(content, /run-live \(running\)/, "the live run keeps its status");
			assert.match(content, /Advisor: 1 of 2 attempts recorded/);
			assert.match(content, /consumed triggers: loop:bash\|npm test\|repeated-failure/);
			assert.ok(
				Buffer.byteLength(content, "utf8") <= MAX_COMPACT_SNAPSHOT_BYTES,
				"the emitted content respects the bound",
			);
		});
	});
});

test("an empty session gets no snapshot: there is nothing to report", async () => {
	await withTempDir(async (cwd) => {
		await withEnv({ PI_TODO_PATH: path.join(cwd, "todos") }, async () => {
			const host = await startHost({ cwd, branch: [] });
			await host.fire("session_start", {});
			await host.fire("session_compact", compactionEvent());
			assert.equal(host.messages.length, 0);
		});
	});
});

test("a failed or cancelled compaction emits no snapshot", async () => {
	await withTempDir(async (cwd) => {
		const todosDir = path.join(cwd, "todos");
		await mkdir(todosDir, { recursive: true });
		await writeTodo(todosDir, "aaaaaaaa", "finish the gate");
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			const host = await startHost({ cwd, branch: [goalEntry(), gateEntry()] });
			await host.fire("session_start", {});
			await host.fire("session_compact_failed", {
				reason: "manual",
				errorMessage: "compaction failed",
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			assert.equal(host.messages.length, 0);
		});
	});
});

test("no session_before_compact handler is registered: compaction stays pi's", async () => {
	await withTempDir(async (cwd) => {
		const host = await startHost({ cwd });
		assert.equal(host.handlers.has("session_before_compact"), false);
		assert.equal(host.handlers.has("session_compact"), true, "the observer is registered");
		assert.equal(host.handlers.has("session_compact_failed"), false, "a failure has no handler to send from");
	});
});

test("a compaction changes neither the attempt count nor the blocked evidence", async () => {
	await withTempDir(async (cwd) => {
		const todosDir = path.join(cwd, "todos");
		await mkdir(todosDir, { recursive: true });
		await writeTodo(todosDir, "aaaaaaaa", "finish the gate");
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			const branch = [goalEntry(), gateEntry(), advisorEntry()];
			const host = await startHost({ cwd, branch });
			await host.fire("session_start", {});

			const before = reconstructGateState(host.ctx.sessionManager.getBranch());
			const advisorBefore = readAdvisorState(host.ctx.sessionManager.getBranch());
			const appendedBefore = host.appended.length;

			await host.fire("session_compact", compactionEvent());

			const after = reconstructGateState(host.ctx.sessionManager.getBranch());
			const advisorAfter = readAdvisorState(host.ctx.sessionManager.getBranch());
			assert.equal(after.attempts, before.attempts);
			assert.deepEqual(after.blockedConditions, before.blockedConditions);
			assert.deepEqual(after.blockedEvidence, before.blockedEvidence);
			assert.equal(after.lastVerdict?.reason, before.lastVerdict?.reason);
			assert.deepEqual(advisorAfter, advisorBefore);
			assert.equal(host.appended.length, appendedBefore, "nothing reads the snapshot back: no entry is appended");
		});
	});
});

test("the snapshot is bounded, with a truncation note", () => {
	const todos = Array.from({ length: 300 }, (_, index) => ({
		id: `todo-${index}`,
		title: `a very long todo title that would blow the bound on its own ${"x".repeat(180)}`,
	}));
	const blocked = Array.from({ length: 40 }, (_, index) => ({
		kind: `condition-${index}`,
		evidence: `${"y".repeat(300)}`,
	}));
	const snapshot = buildCompactSnapshot({
		goal: { objective: "ship it" },
		openTodos: todos,
		gate: { attempts: 3, attemptCap: 3, blocked, lastReason: "blocked" },
		liveRuns: Array.from({ length: 20 }, (_, index) => ({
			runId: `run-${index}`,
			status: index % 2 === 0 ? ("running" as const) : ("queued" as const),
		})),
		advisor: { budget: 2, attempts: 2, consumedKeys: ["gate:todos", "loop:bash|a|b"] },
	});
	assert.equal(snapshot.empty, false);
	assert.equal(snapshot.truncated, true);
	assert.ok(snapshot.bytes <= MAX_COMPACT_SNAPSHOT_BYTES, `bytes ${snapshot.bytes} must stay within the bound`);
	assert.ok(Buffer.byteLength(snapshot.text, "utf8") <= MAX_COMPACT_SNAPSHOT_BYTES);
	assert.match(snapshot.text, /\[compact snapshot truncated\]/);
	assert.match(snapshot.text, /^Orchestrator state after compaction/, "the truncation keeps the header");
});

test("a project whose state overflows the bound still sends one bounded message", async () => {
	await withTempDir(async (cwd) => {
		const todosDir = path.join(cwd, "todos");
		await mkdir(todosDir, { recursive: true });
		for (let index = 0; index < 40; index += 1) {
			await writeTodo(todosDir, `todo-${String(index).padStart(4, "0")}`, `open item ${"z".repeat(180)}`);
		}
		assert.equal(todoDirectory(cwd).endsWith("todos"), true);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			const host = await startHost({ cwd, branch: [goalEntry()] });
			await host.fire("session_start", {});
			await host.fire("session_compact", compactionEvent());
			assert.equal(host.messages.length, 1);
			const content = String(host.messages[0]!.message.content);
			assert.ok(Buffer.byteLength(content, "utf8") <= MAX_COMPACT_SNAPSHOT_BYTES);
			assert.match(content, /\[compact snapshot truncated\]/);
		});
	});
});

test("a second successful compaction emits its own single message", async () => {
	await withTempDir(async (cwd) => {
		await withEnv({ PI_TODO_PATH: path.join(cwd, "todos") }, async () => {
			const host = await startHost({ cwd, branch: [goalEntry("ship the snapshot")] });
			await host.fire("session_start", {});

			await host.fire("session_compact", compactionEvent());
			await host.fire("session_compact", { ...compactionEvent(), reason: "threshold" });

			assert.equal(host.messages.length, 2, "one message per successful compaction");
			for (const sent of host.messages) {
				assert.equal(sent.message.customType, ORCHESTRATOR_CUSTOM_TYPES.compactSnapshot);
				assert.match(String(sent.message.content), /ship the snapshot/);
			}
		});
	});
});
