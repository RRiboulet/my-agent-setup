// The settlement gate: the pure decision function, the session-log state
// reconstruction, the disk readers, and the factory wiring through the fake
// extension host.
//
// Ticket 08's contract was report-only and its tests pinned that in the
// strongest form ("no `continue` at all"). Ticket 09 adds action, so those
// assertions change deliberately: what replaces them is the rule that the gate
// blocks only where a project opted in, only once per condition, only within the
// branch's attempt budget, and never when it cannot evaluate or when the session
// is a delegated child. The factory part still asserts on the boundary RETURNED
// proposal — `agent_before_settle` has no message channel — and still pins the
// composition rule: a yielding gate leaves `continue` alone and an acting one
// carries every earlier handler's entries forward.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	evaluateGate,
	formatVerdict,
	GATE_ENTRY_TYPE,
	GATE_LOOP_ENTRY_TYPE,
	GATE_OVERRIDE_ENTRY_TYPE,
	GATE_OVERRIDE_TOOL,
	reconstructGateState,
	scanEditVerification,
	scanFailures,
	type GateVerdict,
} from "../../orchestrator/gate.ts";
import {
	gateConfigPath,
	normalizeGateConfig,
	readGateConfig,
	DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
} from "../../orchestrator/config.ts";
import { ADVISOR_SECTION } from "../../orchestrator/advisor.ts";
import { ORCHESTRATION_EVENTS } from "../../orchestrator/events.ts";
import type { OrchestratorRole } from "../../orchestrator/role.ts";
import { readOpenTodos, todoDirectory } from "../../orchestrator/todo-state.ts";
import type { VerificationOutcome } from "../../orchestrator/verify.ts";
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

function toolResult(
	id: string,
	toolName: string,
	options: { text?: string; isError?: boolean; details?: Record<string, unknown> } = {},
): Entry {
	return {
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: [{ type: "text", text: options.text ?? "ok" }],
			...(options.details ? { details: options.details } : {}),
			isError: options.isError ?? false,
		},
	};
}

function gateStateEntry(attempts: number, attemptCap = 3, extra: Record<string, unknown> = {}): Entry {
	return custom(GATE_ENTRY_TYPE, {
		version: 2,
		kind: "attention",
		decision: attempts > 0 ? "continue" : "report",
		outcome: "completed",
		at: 1,
		scope: "parent",
		attempts,
		attemptCap,
		remainingAttempts: Math.max(0, attemptCap - attempts),
		blockedBy: attempts > 0 ? ["todos"] : [],
		blockedConditions: attempts > 0 ? ["todos"] : [],
		verification: null,
		override: null,
		reason: "recorded",
		reasons: [],
		conditions: [],
		...extra,
	});
}

/** A verdict exactly as ticket 08 wrote it: `retryCap`, `decision: "report"`. */
function ticket08Entry(attempts = 2, retryCap = 3): Entry {
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

function loopEntry(attempts: number, attemptCap = 3): Entry {
	return custom(GATE_LOOP_ENTRY_TYPE, {
		version: 2,
		action: "block",
		at: 2,
		tool: "bash",
		invocation: "npm run build",
		kind: "no-progress",
		count: 3,
		detail: "1|abc",
		reason: "a loop",
		attempts,
		attemptCap,
		remainingAttempts: Math.max(0, attemptCap - attempts),
		blocksTheTurn: 1,
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

async function startHost(
	options: {
		branch?: Entry[];
		hasUI?: boolean;
		cwd?: string;
		exec?: (command: string, args: string[], options: Record<string, unknown>) => Promise<Record<string, unknown>>;
		role?: OrchestratorRole;
	} = {},
) {
	const host = createFakeHost({
		sessionId: "orchestrator-gate-test",
		branch: options.branch ?? [],
		hasUI: options.hasUI,
		cwd: options.cwd,
		exec: options.exec as never,
	});
	// The role is a process-level fact resolved at module load; the seam exists so
	// a test can drive the worker path without mutating this process's environment
	// after the module was loaded (which is exactly the bug under test).
	orchestratorExtension(host.pi, { role: options.role });
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

test("normalizeGateConfig validates verification.successPattern and leaves it off when absent", () => {
	const base = { version: 1, verification: { command: "node --test" } };
	assert.equal(normalizeGateConfig(base).config.verification?.successPattern, null, "absent means no pattern");
	assert.deepEqual(normalizeGateConfig(base).warnings, []);

	const valid = normalizeGateConfig({ version: 1, verification: { command: "node --test", successPattern: "fail 0" } });
	assert.equal(valid.config.verification?.successPattern, "fail 0");
	assert.deepEqual(valid.warnings, []);

	const empty = normalizeGateConfig({ version: 1, verification: { command: "node --test", successPattern: "  " } });
	assert.equal(empty.config.verification?.successPattern, null);

	const invalid = normalizeGateConfig({ version: 1, verification: { command: "node --test", successPattern: "(" } });
	assert.equal(invalid.config.verification?.successPattern, null, "an uncompilable pattern is not a pattern");
	assert.match(invalid.warnings.join(" "), /verification\.successPattern/);

	const nonString = normalizeGateConfig({ version: 1, verification: { command: "node --test", successPattern: 42 } });
	assert.equal(nonString.config.verification?.successPattern, null);
	assert.match(nonString.warnings.join(" "), /verification\.successPattern/);

	const long = normalizeGateConfig({ version: 1, verification: { command: "node --test", successPattern: "a".repeat(600) } });
	assert.equal(long.config.verification?.successPattern, null, "an over-long pattern is refused, not truncated");
	assert.match(long.warnings.join(" "), /verification\.successPattern/);
});

test("the example config stays a valid, complete reference", async () => {
	const examplePath = path.join(import.meta.dirname, "..", "..", "orchestrator", "orchestrator.example.json");
	const example = JSON.parse(await readFile(examplePath, "utf8"));
	const { config, warnings } = normalizeGateConfig(example);
	assert.deepEqual(warnings, []);
	assert.ok(config.verification);
	assert.match(String(config.verification.successPattern), /fail\s+0/, "the example shows a realistic success pattern");
});

function verification(status: VerificationOutcome["status"], extra: Partial<VerificationOutcome> = {}): VerificationOutcome {
	return {
		status,
		command: "node --test",
		exitCode: status === "passed" ? 0 : 1,
		durationMs: 5,
		killed: status === "timed-out" || status === "truncated",
		truncated: status === "truncated",
		summary: `verification command \`node --test\` ${status}`,
		output: "1 failing",
		...extra,
	};
}

// --- Pure decision function -------------------------------------------------

test("evaluateGate reports an active goal, open todos, unverified edits, a repeated failure and the block budget", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 2,
		attemptCap: 3,
		activeGoal: { id: "g1", objective: "finish the ticket" },
		openTodos: [{ id: "aaaaaaaa", title: "write the test", status: "open" }],
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 0 },
		failure: { signature: "bash|npm test|failed", count: 2, tool: "bash", detail: "failed" },
		now: 42,
	});

	assert.equal(verdict.decision, "report", "nothing is configured to block here");
	assert.equal(verdict.kind, "attention");
	assert.equal(verdict.attempts, 2, "attempts count blocks, not evaluations");
	assert.equal(verdict.remainingAttempts, 1);
	assert.equal(verdict.at, 42);
	assert.equal(verdict.scope, "parent");
	assert.deepEqual(verdict.blockedBy, []);
	assert.deepEqual(
		verdict.reasons.map((reason) => reason.code),
		["goal-active", "open-todos", "edits-without-verification", "repeated-failure"],
	);
	const details = Object.fromEntries(verdict.reasons.map((reason) => [reason.code, reason.details]));
	assert.deepEqual(details["open-todos"], { ids: ["aaaaaaaa"], titles: ["write the test"] });
	assert.deepEqual(details["edits-without-verification"], { files: ["src/a.ts"], verificationRuns: 0 });
	assert.match(
		verdict.conditions.find((condition) => condition.kind === "verification")?.summary ?? "",
		/0 verification runs on this branch/,
	);
});

test("evaluateGate is clear when nothing is open and still spends no attempt", () => {
	const verdict = evaluateGate({ outcome: "completed", attempts: 0, attemptCap: 3, now: 1 });
	assert.equal(verdict.kind, "clear");
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.attempts, 0);
	assert.equal(verdict.remainingAttempts, 3);
	assert.deepEqual(verdict.reasons, []);
	assert.match(verdict.reason, /settled normally/);
});

test("evaluateGate marks an unevaluable condition unknown but still reports", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		unevaluated: ["todos: permission denied"],
		now: 1,
	});
	assert.equal(verdict.kind, "attention");
	assert.equal(verdict.decision, "report");
	assert.ok(verdict.conditions.some((condition) => condition.kind === "unevaluated" && condition.status === "unknown"));
	assert.equal(verdict.reasons[0]?.code, "unevaluated");
});

test("the same evidence keeps blocking until overridden, and new evidence re-arms it", () => {
	const input = {
		outcome: "completed",
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
	} as const;
	const blocked = evaluateGate({ ...input, attempts: 0, policy: { kinds: ["todos"], alreadyBlocked: [] }, now: 1 });
	assert.equal(blocked.decision, "continue");
	assert.deepEqual(blocked.blockedBy, ["todos"]);
	assert.deepEqual(blocked.blockedConditions, ["todos"]);
	assert.equal(blocked.attempts, 1);
	assert.match(blocked.reason, new RegExp(GATE_OVERRIDE_TOOL));

	// Same evidence, next settlement: a condition that must be resolved blocks
	// again and spends another attempt. This is what makes the override needed.
	const repeated = evaluateGate({
		...input,
		attempts: 1,
		policy: { kinds: ["todos"], alreadyBlocked: ["todos"], alreadyBlockedEvidence: blocked.blockedEvidence },
		now: 2,
	});
	assert.equal(repeated.decision, "continue", "an unresolved condition blocks again");
	assert.equal(repeated.attempts, 2);
	assert.deepEqual(repeated.blockedBy, ["todos"]);

	// The override is consumed by that repeated block and settles without another
	// attempt being spent.
	const overridden = evaluateGate({
		...input,
		attempts: 2,
		policy: { kinds: ["todos"], alreadyBlocked: ["todos"], alreadyBlockedEvidence: repeated.blockedEvidence },
		override: { reason: "ship anyway", at: 3 },
		now: 3,
	});
	assert.equal(overridden.decision, "report");
	assert.equal(overridden.attempts, 2, "an override spends no attempt");
	assert.deepEqual(overridden.override, { reason: "ship anyway", at: 3 });
	assert.ok(overridden.reasons.some((reason) => reason.code === "override-used"));

	// A new open todo is new evidence: the check re-arms, still bounded by the cap.
	const rearmed = evaluateGate({
		...input,
		openTodos: [
			{ id: "aaaaaaaa", title: "finish", status: "open" },
			{ id: "bbbbbbbb", title: "another", status: "open" },
		],
		attempts: 1,
		policy: { kinds: ["todos"], alreadyBlocked: ["todos"], alreadyBlockedEvidence: blocked.blockedEvidence },
		now: 4,
	});
	assert.equal(rearmed.decision, "continue", "a new open todo must be able to block again");
	assert.equal(rearmed.attempts, 2);
});

test("a repeated failure condition also keeps blocking until overridden", () => {
	const input = {
		outcome: "completed",
		attemptCap: 3,
		failure: { signature: "bash|npm test|boom", tool: "bash", detail: "boom", count: 2 },
	} as const;
	const first = evaluateGate({ ...input, attempts: 0, policy: { kinds: ["failure"], alreadyBlocked: [] }, now: 1 });
	assert.equal(first.decision, "continue");
	const repeated = evaluateGate({
		...input,
		attempts: 1,
		policy: { kinds: ["failure"], alreadyBlocked: ["failure"], alreadyBlockedEvidence: first.blockedEvidence },
		now: 2,
	});
	assert.equal(repeated.decision, "continue", "the same failure signature is still unresolved");
	assert.equal(repeated.attempts, 2);
});

test("the attempt budget bounds every block on the branch", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 3,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.attempts, 3, "an attempt is only spent by a block");
	assert.equal(verdict.remainingAttempts, 0);
	assert.ok(verdict.reasons.some((reason) => reason.code === "attempt-cap-reached"));
	assert.equal(verdict.conditions.find((condition) => condition.kind === "attempt")?.status, "attention");
});

test("a cap of zero makes a configured gate report-only", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 0,
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.ok(verdict.reasons.some((reason) => reason.code === "attempt-cap-reached"));
});

test("an override reports instead of blocking and records itself", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		override: { reason: "the todo is a scratch note", at: 7 },
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.attempts, 0, "an override spends no attempt");
	assert.deepEqual(verdict.override, { reason: "the todo is a scratch note", at: 7 });
	assert.ok(verdict.reasons.some((reason) => reason.code === "override-used"));
});

test("an override granted while nothing is open stays pending for the settlement that needs it", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		override: { reason: "granted early", at: 9 },
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.override, null, "an override is spent by the block it prevents, not by a clean settlement");
	assert.equal(verdict.reasons.some((reason) => reason.code === "override-used"), false);
});

test("a delegated child session reports and never blocks", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		scope: "child",
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		suppressed: "this is a delegated child session",
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.scope, "child");
	assert.ok(verdict.reasons.some((reason) => reason.code === "blocking-suppressed"));
});

test("a verification run that timed out fails open and stays visible in the verdict", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 1 },
		verification: verification("timed-out"),
		policy: { kinds: ["verification"], alreadyBlocked: [] },
		now: 1,
	});
	assert.equal(verdict.decision, "report", "a check that could not finish must not trap the run");
	assert.equal(verdict.verification?.status, "timed-out");
	assert.ok(verdict.reasons.some((reason) => reason.code === "verification-fail-open"));
	assert.equal(verdict.conditions.find((condition) => condition.kind === "verification")?.status, "unknown");
});

test("a verification run that passed still continues once with the result", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 1 },
		verification: verification("passed"),
		policy: { kinds: ["verification"], alreadyBlocked: [] },
		now: 1,
	});
	assert.equal(verdict.decision, "continue", "the model gets one turn with what the project's command said");
	assert.deepEqual(verdict.blockedBy, ["verification"]);
	assert.equal(verdict.reasons.find((reason) => reason.code === "verification-ran")?.details?.exitCode, 0);
});

test("a passed verification is informational once, not a condition that keeps blocking", () => {
	const input = {
		outcome: "completed",
		attemptCap: 3,
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 1 },
		verification: verification("passed"),
	} as const;
	const first = evaluateGate({ ...input, attempts: 0, policy: { kinds: ["verification"], alreadyBlocked: [] }, now: 1 });
	assert.equal(first.decision, "continue");
	const second = evaluateGate({
		...input,
		attempts: 1,
		policy: { kinds: ["verification"], alreadyBlocked: ["verification"], alreadyBlockedEvidence: first.blockedEvidence },
		now: 2,
	});
	assert.equal(second.decision, "report", "nothing is left to fix, so a pass must not demand an override");
});

test("a verification run that failed blocks, naming the exit code", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		edits: { editedFiles: ["src/a.ts"], verificationRuns: 1 },
		verification: verification("failed", { exitCode: 2 }),
		policy: { kinds: ["verification"], alreadyBlocked: [] },
		now: 1,
	});
	assert.equal(verdict.decision, "continue");
	const reason = verdict.reasons.find((candidate) => candidate.code === "verification-failed");
	assert.equal(reason?.details?.exitCode, 2);
});

test("formatVerdict names the action, the budget, the scope and the verification", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "deadbeef", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		unevaluated: ["config: broken"],
		now: 1,
	});
	const text = formatVerdict(verdict);
	assert.match(text, /ATTENTION \(BLOCKED SETTLEMENT\)/);
	assert.match(text, /Attempt 1 of 3 gate blocks/);
	assert.match(text, /open todo: deadbeef/);
	assert.match(text, /delegated children are not visible/);
	assert.match(text, /Unevaluated \(reported, not blocking\):/);
});

// --- Session-backed state ---------------------------------------------------

test("reconstructGateState takes the last verdict, its attempt count and every blocked condition", () => {
	const state = reconstructGateState([gateStateEntry(1), gateStateEntry(2)]);
	assert.equal(state.attempts, 2);
	assert.equal(state.lastVerdict?.attempts, 2);
	assert.deepEqual(state.blockedConditions, ["todos"]);
});

test("reconstructGateState reads a ticket-08 entry, whose cap was called retryCap", () => {
	const state = reconstructGateState([ticket08Entry(2, 3)]);
	assert.equal(state.attempts, 2);
	assert.equal(state.lastVerdict?.attemptCap, 3);
	assert.equal(state.lastVerdict?.decision, "report");
	assert.equal(state.lastVerdict?.scope, "parent");
});

test("reconstructGateState tracks settlement attempts and loopAttempts separately", () => {
	const state = reconstructGateState([gateStateEntry(1), loopEntry(2)]);
	assert.equal(state.attempts, 1, "loop blocks must not increment settlement gate attempts");
	assert.equal(state.loopAttempts, 2, "loop blocks are tracked separately in loopAttempts");
	assert.equal(state.lastLoopVerdict?.action, "block");
	assert.deepEqual(state.blockedConditions, ["todos"], "the condition memory survives a loop block");
});

test("reconstructGateState ignores malformed entries and a branch before any decision", () => {
	assert.deepEqual(reconstructGateState([]), {
		attempts: 0,
		loopAttempts: 0,
		lastVerdict: null,
		lastLoopVerdict: null,
		blockedConditions: [],
		blockedEvidence: {},
	});
	const state = reconstructGateState([
		custom(GATE_ENTRY_TYPE, { nonsense: true }),
		custom(GATE_LOOP_ENTRY_TYPE, { action: "block" }),
		gateStateEntry(2),
	]);
	assert.equal(state.attempts, 2);
});

// --- Branch readers ---------------------------------------------------------

test("scanEditVerification clears an edit once a shell command succeeds", () => {
	const branch = [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit"),
		assistantCall("b1", "bash", { command: "npm test" }),
		toolResult("b1", "bash"),
	];
	assert.deepEqual(scanEditVerification(branch), { editedFiles: [], verificationRuns: 1, editResults: 1 });
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
	assert.deepEqual(scanEditVerification(branch), { editedFiles: ["src/a.ts", "src/b.ts"], verificationRuns: 1, editResults: 2 });
});

test("scanEditVerification ignores a failed edit", () => {
	const branch = [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit", { isError: true, text: "no match" }),
	];
	assert.deepEqual(scanEditVerification(branch), { editedFiles: [], verificationRuns: 0, editResults: 0 });
});

test("with a configured command only that command verifies, not any shell call", () => {
	// Ticket 08's proxy cleared an edit on `ls` or `git status`. Ticket 09 asks
	// what "the command was run after the edit" means when the command lives in
	// config: it means this command.
	const branch = [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit"),
		assistantCall("b1", "bash", { command: "ls" }),
		toolResult("b1", "bash"),
	];
	const proxied = scanEditVerification(branch);
	assert.deepEqual(proxied.editedFiles, [], "without a command, ticket 08's proxy is kept");
	const commanded = scanEditVerification(branch, { verificationCommand: "node --test" });
	assert.deepEqual(commanded.editedFiles, ["src/a.ts"], "a different command is not the project's verification");
	assert.equal(commanded.verificationRuns, 0);

	const verified = [
		...branch,
		assistantCall("b2", "bash", { command: "node   --test" }),
		toolResult("b2", "bash"),
	];
	assert.deepEqual(scanEditVerification(verified, { verificationCommand: "node --test" }), {
		editedFiles: [],
		verificationRuns: 1,
		editResults: 1,
	});
});

test("the gate's own passing verification clears the edits it covered, and a failing one does not", () => {
	const edits = [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")];
	const passed = [...edits, custom(GATE_ENTRY_TYPE, { verification: { status: "passed" }, attempts: 1 })];
	assert.deepEqual(scanEditVerification(passed, { verificationCommand: "node --test" }), {
		editedFiles: [],
		verificationRuns: 1,
		editResults: 1,
	});
	const failed = [...edits, custom(GATE_ENTRY_TYPE, { verification: { status: "failed" }, attempts: 1 })];
	assert.deepEqual(scanEditVerification(failed, { verificationCommand: "node --test" }), {
		editedFiles: ["src/a.ts"],
		verificationRuns: 0,
		editResults: 1,
	});
});

test("a matching shell result clears edits only when its evidence is a real pass", () => {
	const options = { verificationCommand: "node --test" };
	const shellRun = (result: { text?: string; isError?: boolean; details?: Record<string, unknown> }, extra: Entry[] = []) => [
		assistantCall("e1", "edit", { path: "src/a.ts" }),
		toolResult("e1", "edit"),
		...extra,
		assistantCall("b1", "bash", { command: "node --test" }),
		toolResult("b1", "bash", result),
	];

	assert.deepEqual(scanEditVerification(shellRun({ text: "pass 3" }), options), {
		editedFiles: [],
		verificationRuns: 1,
		editResults: 1,
	});

	const notPasses = [
		["a failed shell result", shellRun({ text: "1 failing", isError: true })],
		["an exit code in the details", shellRun({ text: "pass 3", details: { exitCode: 1 } })],
		["zero-test output", shellRun({ text: "0 passing" })],
		["a zero-test indicator for a runner that found no files", shellRun({ text: "No test files found" })],
	] as const;
	for (const [name, branch] of notPasses) {
		const state = scanEditVerification(branch, options);
		assert.deepEqual(state.editedFiles, ["src/a.ts"], `${name} does not clear the edits`);
		assert.equal(state.verificationRuns, 0, `${name} is not a verification run`);
		assert.equal(state.editResults, 1, "the edit is still evidence, so a later real pass re-arms");
	}

	// The configured command itself can be weak; running it proves nothing.
	const weak = scanEditVerification(shellRun({ text: "pass 3" }), { verificationCommand: "node --test || true" });
	assert.deepEqual(weak.editedFiles, ["src/a.ts"], "a weak command never clears edits");

	// An opt-in pattern must match the output the model's run reported.
	const pattern = { verificationCommand: "node --test", successPattern: "fail 0" };
	assert.deepEqual(scanEditVerification(shellRun({ text: "pass 3" }), pattern).editedFiles, ["src/a.ts"]);
	assert.deepEqual(scanEditVerification(shellRun({ text: "pass 3\nfail 0" }), pattern).editedFiles, []);
});

test("a persisted passed verdict clears edits only when it was a real pass", () => {
	const edits = [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")];
	const persisted = (verification: Record<string, unknown>, options: Parameters<typeof scanEditVerification>[1] = {}) =>
		scanEditVerification([...edits, custom(GATE_ENTRY_TYPE, { verification, attempts: 1 })], {
			verificationCommand: "node --test",
			...options,
		});

	assert.deepEqual(persisted({ status: "passed", command: "node --test", output: "pass 3" }).editedFiles, []);
	assert.deepEqual(
		persisted({ status: "passed", command: "node --test", output: "0 passing" }).editedFiles,
		["src/a.ts"],
		"a verdict whose run reported zero tests predates the inconclusive status, so it is re-checked",
	);
	assert.deepEqual(
		persisted({ status: "passed", command: "node --test || true", output: "pass 3" }).editedFiles,
		["src/a.ts"],
		"a weak persisted run is not a pass either",
	);
	assert.deepEqual(
		persisted({ status: "passed", command: "node --test", output: "pass 3" }, { successPattern: "fail 0" }).editedFiles,
		["src/a.ts"],
		"a configured pattern applies to a persisted pass too",
	);
	assert.equal(
		persisted({ status: "passed", command: "node --test || true", output: "pass 3" }).verificationRuns,
		0,
		"a re-checked false pass is not counted as a verification run",
	);
});

function codemodeResult(
	id: string,
	calls: Array<{ id: string; name: string; arguments?: Record<string, unknown>; status: "ok" | "error" | "unfinished"; error?: string }>,
	options: { isError?: boolean; text?: string } = {},
): Entry {
	return {
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "codemode",
			content: [{ type: "text", text: options.text ?? "ok" }],
			nestedCalls: { calls, complete: true },
			isError: options.isError ?? false,
		},
	};
}

test("scanEditVerification tracks edits and verification commands inside codemode nestedCalls", () => {
	const branch = [
		assistantCall("cm1", "codemode", { code: "..." }),
		codemodeResult("cm1", [
			{ id: "cm1/1", name: "edit", arguments: { path: "src/a.ts" }, status: "ok" },
			{ id: "cm1/2", name: "write", arguments: { path: "src/b.ts" }, status: "error", error: "EACCES" },
			{ id: "cm1/3", name: "edit", arguments: { path: "src/c.ts" }, status: "unfinished" },
		]),
	];
	assert.deepEqual(scanEditVerification(branch, { verificationCommand: "node --test" }), {
		editedFiles: ["src/a.ts"],
		verificationRuns: 0,
		editResults: 1,
	});

	// Output-less nested bash running the configured verification command must NOT clear edits,
	// preserving zero-test and successPattern enforcement until a run with real output happens.
	const nestedRunWithoutOutput = [
		...branch,
		assistantCall("cm2", "codemode", { code: "..." }),
		codemodeResult("cm2", [
			{ id: "cm2/1", name: "bash", arguments: { command: "node --test" }, status: "ok" },
			{ id: "cm2/2", name: "write", arguments: { path: "src/d.ts" }, status: "ok" },
		]),
	];
	assert.deepEqual(scanEditVerification(nestedRunWithoutOutput, { verificationCommand: "node --test" }), {
		editedFiles: ["src/a.ts", "src/d.ts"],
		verificationRuns: 0,
		editResults: 2,
	});

	// Failed or weak nested shell commands never verify, and nested failing bash is recorded by scanFailures.
	const failedOrWeak = [
		...branch,
		assistantCall("cm3", "codemode", { code: "..." }),
		codemodeResult("cm3", [
			{ id: "cm3/1", name: "bash", arguments: { command: "node --test" }, status: "error", error: "exit 1" },
			{ id: "cm3/2", name: "bash", arguments: { command: "node --test || true" }, status: "ok" },
		]),
		assistantCall("cm4", "codemode", { code: "..." }),
		codemodeResult("cm4", [
			{ id: "cm4/1", name: "bash", arguments: { command: "node --test" }, status: "error", error: "exit 1" },
		]),
	];
	assert.deepEqual(scanEditVerification(failedOrWeak, { verificationCommand: "node --test" }), {
		editedFiles: ["src/a.ts"],
		verificationRuns: 0,
		editResults: 1,
	});
	const failure = scanFailures(failedOrWeak);
	assert.equal(failure?.count, 2);
	assert.equal(failure?.tool, "bash");
	assert.equal(failure?.detail, "exit 1");
});

test("scanEditVerification matches safe cd prefixes and formatting flags, never scoped or chained variants", () => {
	const runCmd = (command: string, resultOpts: { text?: string; isError?: boolean; details?: Record<string, unknown> } = {}) => {
		const branch = [
			assistantCall("e1", "edit", { path: "src/a.ts" }),
			toolResult("e1", "edit"),
			assistantCall("b1", "bash", { command }),
			toolResult("b1", "bash", { text: "pass 4", ...resultOpts }),
		];
		return scanEditVerification(branch, { verificationCommand: "pytest" });
	};

	const safeCommands = [
		"pytest",
		"pytest -q",
		"pytest --quiet --tb=short --no-header --color=no",
		"pytest -v --verbose -vv --tb=line",
		"pytest --reporter=spec",
		"pytest --reporter tap",
		"cd packages/api && pytest",
		"cd \"/tmp/my repo\" && pytest -q --tb=short",
		"cd 'packages/my api' && pytest --reporter=json",
	];
	for (const cmd of safeCommands) {
		const state = runCmd(cmd);
		assert.deepEqual(state.editedFiles, [], `safe command must verify: ${cmd}`);
		assert.equal(state.verificationRuns, 1, `safe command must count as verification run: ${cmd}`);
	}

	const unsafeCommands = [
		"pytest tests/test_one.py",
		"pytest -k test_foo",
		"pytest -m unit",
		"pytest --test-name-pattern=foo",
		"pytest --test-name-pattern foo",
		"pytest | head -n 20",
		"pytest -q|cat",
		"pytest > out.txt",
		"pytest 2>&1",
		"pytest || true",
		"pytest; exit 0",
		"pytest && echo ok",
		"cd a && cd b && pytest",
		"cd a; pytest",
		"cd a || pytest",
		"cd a && echo hi && pytest",
		"pytest-cov",
		"pytest --reporter",
		"pytest --reporter=spec;true",
	];
	for (const cmd of unsafeCommands) {
		const state = runCmd(cmd);
		assert.deepEqual(state.editedFiles, ["src/a.ts"], `unsafe command must NOT verify: ${cmd}`);
		assert.equal(state.verificationRuns, 0, `unsafe command must NOT count: ${cmd}`);
	}

	// Safe flags still pass through classifyVerificationEvidence (zero-test and exitCode checks).
	assert.deepEqual(runCmd("cd packages/api && pytest -q", { text: "0 passing" }).editedFiles, ["src/a.ts"]);
	assert.deepEqual(runCmd("pytest --reporter=spec", { details: { exitCode: 1 } }).editedFiles, ["src/a.ts"]);
});

test("scanEditVerification rejects unsafe test filters past column 160 on long verificationCommand", () => {
	const longCommand = `node --test ${Array.from({ length: 10 }, (_, i) => `packages/module-${i}/test/unit.test.ts`).join(" ")}`;
	assert.ok(longCommand.length > 160, `expected >160 chars, got ${longCommand.length}`);

	const runLong = (command: string) =>
		scanEditVerification(
			[
				assistantCall("e1", "edit", { path: "src/a.ts" }),
				toolResult("e1", "edit"),
				assistantCall("b1", "bash", { command }),
				toolResult("b1", "bash", { text: "pass 4" }),
			],
			{ verificationCommand: longCommand },
		);

	assert.deepEqual(runLong(longCommand).editedFiles, [], "exact long verificationCommand verifies");
	assert.deepEqual(runLong(`${longCommand} --quiet`).editedFiles, [], "safe flag past column 160 verifies");

	for (const unsafeTail of ["--test-name-pattern=only_one", "--test-name-pattern only_one", "extra.test.ts"]) {
		const state = runLong(`${longCommand} ${unsafeTail}`);
		assert.deepEqual(state.editedFiles, ["src/a.ts"], `unsafe tail past column 160 must NOT verify: ${unsafeTail}`);
		assert.equal(state.verificationRuns, 0);
	}
});

test("scanFailures tracks repeated failures inside codemode nestedCalls", () => {
	const nestedRepeated = [
		assistantCall("cm1", "codemode", { code: "run1" }),
		codemodeResult("cm1", [
			{ id: "cm1/1", name: "bash", arguments: { command: "npm test" }, status: "error", error: "AssertionError: boom\n  at a.ts:1" },
		]),
		assistantCall("cm2", "codemode", { code: "run2" }),
		codemodeResult("cm2", [
			{ id: "cm2/1", name: "bash", arguments: { command: "npm test" }, status: "error", error: "AssertionError: boom\n  at a.ts:2" },
		]),
	];
	const found = scanFailures(nestedRepeated);
	assert.equal(found?.count, 2);
	assert.equal(found?.tool, "bash");
	assert.equal(found?.detail, "AssertionError: boom");

	const okCalls = [
		assistantCall("cm1", "codemode", { code: "run1" }),
		codemodeResult("cm1", [
			{ id: "cm1/1", name: "bash", arguments: { command: "npm test" }, status: "ok" },
		]),
		assistantCall("cm2", "codemode", { code: "run2" }),
		codemodeResult("cm2", [
			{ id: "cm2/1", name: "bash", arguments: { command: "npm test" }, status: "ok" },
		]),
	];
	assert.equal(scanFailures(okCalls), null);
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
		assert.equal(missing.config.attemptCap, 3);
		assert.equal(missing.config.verification, null);
		assert.deepEqual(missing.config.block, { openTodos: false, repeatedFailure: false, loops: false, waitForSubagents: false, wave: true });
		assert.deepEqual(missing.config.workspace, { lockScope: "worktree" }, "reservations stay worktree-scoped unless a project opts in");
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

test("normalizeGateConfig validates the block keys, the verification command and the attempt cap", () => {
	assert.deepEqual(
		normalizeGateConfig({
			version: 1,
			attemptCap: 5,
			block: { openTodos: true, loops: true, waitForSubagents: true, future: true },
			verification: { command: "node --test" },
			future: true,
		}),
		{
			config: {
				version: 1,
				attemptCap: 5,
				loopAttemptCap: 3,
				block: { openTodos: true, repeatedFailure: false, loops: true, waitForSubagents: true, wave: true },
				verification: {
					command: "node --test",
					timeoutMs: 300_000,
					maxOutputBytes: DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
					successPattern: null,
				},
				advisor: null,
				workspace: { lockScope: "worktree" },
			},
			warnings: [],
		},
		"unknown keys are ignored, so a newer project can commit one",
	);

	const customLoopCap = normalizeGateConfig({ version: 1, loopAttemptCap: 5 });
	assert.equal(customLoopCap.config.loopAttemptCap, 5);
	assert.deepEqual(customLoopCap.warnings, []);
	assert.equal(normalizeGateConfig({ version: 1, loopAttemptCap: 0 }).config.loopAttemptCap, 0);

	const invalid = normalizeGateConfig({
		version: 1,
		attemptCap: -1,
		loopAttemptCap: -2,
		block: { openTodos: "yes", waitForSubagents: "yes" },
		verification: { command: "" },
	});
	assert.equal(invalid.config.attemptCap, 3);
	assert.equal(invalid.config.loopAttemptCap, 3);
	assert.equal(invalid.config.block.openTodos, false);
	assert.equal(invalid.config.block.waitForSubagents, false);
	assert.equal(invalid.config.verification, null);
	assert.match(invalid.warnings.join(" "), /attemptCap must be a non-negative integer/);
	assert.match(invalid.warnings.join(" "), /loopAttemptCap must be a non-negative integer/);
	assert.match(invalid.warnings.join(" "), /block\.openTodos must be a boolean/);
	assert.match(invalid.warnings.join(" "), /block\.waitForSubagents must be a boolean/);
	assert.match(invalid.warnings.join(" "), /verification\.command must be a non-empty string/);

	const capped = normalizeGateConfig({ version: 1, verification: { command: "x", timeoutMs: 1e9, maxOutputBytes: 1e9 } });
	assert.equal(capped.config.verification?.timeoutMs, 3_600_000);
	assert.equal(capped.config.verification?.maxOutputBytes, 1_048_576);
	assert.match(capped.warnings.join(" "), /capped at/);

	const legacy = normalizeGateConfig({ version: 1, retryCap: 2 });
	assert.equal(legacy.config.attemptCap, 2, "the ticket-08 key is still honoured");
	assert.match(legacy.warnings.join(" "), /renamed attemptCap/);

	const future = normalizeGateConfig({ version: 99, attemptCap: 2 });
	assert.equal(future.config.attemptCap, 2);
	assert.match(future.warnings[0] ?? "", /unsupported config version/);
});

// --- Factory wiring ---------------------------------------------------------

test("the settlement boundary records a verdict with every open condition and publishes it", async () => {
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

			assert.equal(result.continue, undefined, "nothing is configured to block");
			assert.ok(result.entries?.includes(sentinel as never), "an earlier handler's draft survives");
			assert.equal(verdict.decision, "report");
			assert.equal(verdict.kind, "attention");
			assert.equal(verdict.attempts, 0, "a report is not an attempt");
			assert.deepEqual(
				verdict.reasons.map((reason) => reason.code),
				["goal-active", "open-todos", "edits-without-verification", "repeated-failure"],
			);
			assert.equal(host.emitted.length, 1);
			assert.equal(host.emitted[0]?.channel, ORCHESTRATION_EVENTS.gateDecided);
			assert.deepEqual((host.emitted[0]?.data as { verdict: GateVerdict }).verdict, verdict);
			assert.equal((host.emitted[0]?.data as { action: string }).action, "settle");
			assert.equal(host.execCalls.length, 0, "no command is configured, so nothing runs");

			// What the boundary proposed is what a later load reconstructs.
			const recovered = reconstructGateState(result.entries ?? []);
			assert.deepEqual(recovered.lastVerdict, verdict);
			assert.equal(recovered.attempts, verdict.attempts);
		});
	});
});

test("with no configuration the gate reports clear and never blocks, continues or runs a command", async () => {
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
		assert.equal(host.execCalls.length, 0);
		assert.equal(host.emitted.length, 1, "the report-only decision is still published");
	});
});

test("a completed run's pre-draft canContinue=false does not suppress a real block", async () => {
	// pi builds `context.canContinue` from the drafts proposed BEFORE the gate
	// runs. On a normal completed run it is false (the last message is the
	// assistant's); the gate's own custom_message is what makes the next request
	// continuable. A real session with an open todo hit exactly this and settled
	// without blocking until the suppression was removed.
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "bbbbbbbb.md"), `${JSON.stringify({ id: "bbbbbbbb", title: "stay open", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			await withTempDir(async (cwd) => {
				await mkdir(path.join(cwd, ".pi"), { recursive: true });
				await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));
				const host = await startHost({ branch: [], cwd });
				const result = (await host.fire(
					"agent_before_settle",
					boundaryEvent([], { context: { pendingMessages: [], canContinue: false } }),
				)) as BoundaryProposal;
				const verdict = gateVerdictOf(result);
				assert.equal(verdict.decision, "continue");
				assert.equal(result.continue, true);
				assert.deepEqual(verdict.blockedBy, ["todos"]);
				// `continue: true` is only valid because the gate carries its own
				// user-role draft; pin that, or deleting the message while keeping the
				// flag would spend an attempt on a block the model never sees.
				const message = result.entries?.find((entry) => entry.type === "custom_message");
				assert.ok(message, "the block must carry a custom_message, not just continue: true");
				assert.match(String(message?.content ?? ""), /did not settle/);
			});
		});
	});
});

test("when a goal already owns the continuation the gate does not request another", async () => {
	const host = await startHost({ branch: [goalEntry()] });
	await host.fire("session_start", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent([], { continue: true }))) as BoundaryProposal;
	const verdict = gateVerdictOf(result);

	assert.equal(verdict.reasons[0]?.code, "goal-active");
	assert.equal(result.continue, undefined, "yield by leaving the field alone; never return continue: false");
});

test("a configured open-todo check blocks until overridden, carrying drafts forward", async () => {
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			await withTempDir(async (cwd) => {
				await mkdir(path.join(cwd, ".pi"), { recursive: true });
				await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));

				const host = await startHost({ branch: [], cwd });
				const sentinel = { type: "custom", customType: "another-extension", data: { proposed: true } };
				const first = (await host.fire("agent_before_settle", boundaryEvent([sentinel]))) as BoundaryProposal;
				const blocked = gateVerdictOf(first);
				assert.equal(first.continue, true);
				assert.deepEqual(blocked.blockedBy, ["todos"]);
				assert.equal(blocked.attempts, 1);
				assert.ok(first.entries?.includes(sentinel as never), "the gate must not drop an earlier handler's entries");
				const message = first.entries?.find((entry) => entry.type === "custom_message");
				assert.match(String(message?.content ?? ""), /did not settle/);
				assert.match(String(message?.content ?? ""), new RegExp(GATE_OVERRIDE_TOOL));

				// The same evidence blocks again: a report-only settlement here would
				// make the override decorative.
				const resumed = await startHost({ branch: first.entries as Entry[], cwd });
				const repeated = (await resumed.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				const reblocked = gateVerdictOf(repeated);
				assert.equal(repeated.continue, true);
				assert.equal(reblocked.attempts, 2);

				// An armed override is consumed by that repeated block and settles.
				const withOverride = await startHost({
					branch: [...(first.entries as Entry[]), ...(repeated.entries as Entry[])],
					cwd,
				});
				await withOverride.fire("session_start", {});
				await withOverride.callTool(GATE_OVERRIDE_TOOL, { reason: "ship anyway" });
				const settled = (await withOverride.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				const verdict = gateVerdictOf(settled);
				assert.equal(settled.continue, undefined);
				assert.equal(verdict.decision, "report");
				assert.equal(verdict.attempts, 2, "the override spends no attempt");
				assert.equal(verdict.override?.reason, "ship anyway");
			});
		});
	});
});

test("an override lets a blocked settlement settle, and is recorded in the session", async () => {
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			await withTempDir(async (cwd) => {
				await mkdir(path.join(cwd, ".pi"), { recursive: true });
				await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));

				const host = await startHost({ branch: [], cwd });
				await host.fire("session_start", {});
				await host.callTool(GATE_OVERRIDE_TOOL, { reason: "the todo is a scratch note" });
				assert.ok(host.appended.some((entry) => entry.customType === GATE_OVERRIDE_ENTRY_TYPE));

				const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				const verdict = gateVerdictOf(result);
				assert.equal(result.continue, undefined, "the override suppresses the block");
				assert.equal(verdict.decision, "report");
				assert.deepEqual(verdict.override, { reason: "the todo is a scratch note", at: verdict.override?.at });
				assert.equal(verdict.attempts, 0);

				// Consumed: the next settlement blocks again, as it would have.
				const next = newHostFrom(cwd, result.entries as Entry[]);
				const after = (await next.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				assert.equal(after.continue, true);
				assert.equal(gateVerdictOf(after).override, null);
			});
		});
	});
});

function newHostFrom(cwd: string, branch: Entry[]) {
	const host = createFakeHost({ sessionId: "orchestrator-gate-test", cwd, branch });
	orchestratorExtension(host.pi, { role: "parent" });
	return host;
}

test("the override tool refuses an empty reason", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		await assert.rejects(async () => await host.callTool(GATE_OVERRIDE_TOOL, { reason: "  " }), /non-empty reason/);
	});
});

test("a report-only project pays nothing for the override: the tool is not registered", async () => {
	await withTempDir(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false, "no block is possible, so no escape hatch is advertised");
	});
});

test("a project that opts into a check gets the override tool at session start", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { loops: true } }));
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), true);
	});
});

test("an untrusted project's config is never executed and never blocks", async () => {
	// This extension ships as a user-level package, so it loads in a checkout pi has
	// never trusted. Running that checkout's committed command at settlement would be
	// arbitrary code execution from a cloned repository.
	await withTempDir(async (dir) => {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(
			gateConfigPath(dir),
			JSON.stringify({
				version: 1,
				attemptCap: 3,
				block: { openTodos: true },
				verification: { command: "touch PWNED" },
			}),
		);
		await mkdir(path.join(dir, ".pi", "todos"), { recursive: true });
		await writeFile(
			path.join(dir, ".pi", "todos", "aaaaaaaa.md"),
			`${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`,
		);

		const host = createFakeHost({ sessionId: "untrusted", cwd: dir, trusted: false });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		const verdict = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);

		assert.equal(verdict.decision, "report");
		const suppressed = verdict.reasons.find((reason) => reason.code === "blocking-suppressed");
		assert.match(String(suppressed?.summary ?? ""), /not trusted/);
		assert.equal(verdict.verification, null, "no command may run in an untrusted project");
		assert.equal(
			host.toolOrder.includes(GATE_OVERRIDE_TOOL),
			false,
			"a project the gate will not act in gets no escape hatch",
		);
	});
});

test("an untrusted project with .pi/orchestrator.json emits a one-time warning, and does not warn otherwise", async () => {
	// 1. Untrusted + config exists -> warns once across lifecycle boundaries.
	await withTempDir(async (dir) => {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

		const host = createFakeHost({ sessionId: "untrusted-warn", cwd: dir, trusted: false });
		orchestratorExtension(host.pi, { role: "parent" });
		await host.fire("session_start", {});
		await host.fire("session_tree", {});
		await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		await host.fire("tool_call", { toolName: "bash", input: { command: "ls" } });
		await host.fire("agent_before_settle", boundaryEvent());

		const warnings = host.notifications.filter((n) => n.type === "warning");
		assert.equal(warnings.length, 1, "untrusted project with config must warn exactly once");
		assert.match(warnings[0]!.message, /\.pi\/orchestrator\.json/);
		assert.match(warnings[0]!.message, /untrusted/i);
	});

	// 2. Untrusted + no config -> no warning.
	await withTempDir(async (dir) => {
		const host = createFakeHost({ sessionId: "untrusted-no-config", cwd: dir, trusted: false });
		orchestratorExtension(host.pi, { role: "parent" });
		await host.fire("session_start", {});
		await host.fire("agent_before_settle", boundaryEvent());
		assert.equal(host.notifications.length, 0, "no config means no warning");
	});

	// 3. Trusted + config exists -> no warning.
	await withTempDir(async (dir) => {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

		const host = createFakeHost({ sessionId: "trusted-no-warn", cwd: dir, trusted: true });
		orchestratorExtension(host.pi, { role: "parent" });
		await host.fire("session_start", {});
		await host.fire("agent_before_settle", boundaryEvent());
		assert.equal(host.notifications.length, 0, "trusted project must not emit untrusted warning");
	});

	// 4. Delegated worker + untrusted + config exists -> no warning.
	await withTempDir(async (dir) => {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

		const host = createFakeHost({ sessionId: "worker-no-warn", cwd: dir, trusted: false });
		orchestratorExtension(host.pi, { role: "worker" });
		await host.fire("session_start", {});
		await host.fire("agent_before_settle", boundaryEvent());
		assert.equal(host.notifications.length, 0, "delegated worker must not warn");
	});
});

test("orchestrator_override uses codemode exposure when codemode or tool_search is active and stays omitted when untrusted", async () => {
	for (const activeTool of ["codemode", "tool_search"]) {
		await withTempDir(async (dir) => {
			await mkdir(path.join(dir, ".pi"), { recursive: true });
			await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

			let activeTools = ["read", "bash", "edit", "write", activeTool];
			const host = createFakeHost({ sessionId: `override-codemode-${activeTool}`, cwd: dir, trusted: true });
			(host.pi as unknown as { getActiveTools: () => string[] }).getActiveTools = () => [...activeTools];
			orchestratorExtension(host.pi, { role: "parent" });

			await host.fire("session_start", {});
			assert.equal(
				host.tools.get(GATE_OVERRIDE_TOOL)?.exposure,
				"codemode",
				`orchestrator_override must adopt codemode exposure when ${activeTool} is active`,
			);
			const registrationsAfterStart = host.toolOrder.filter((name) => name === GATE_OVERRIDE_TOOL).length;

			// Unchanged active tools on before_agent_start must not churn registrations.
			await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
			assert.equal(host.toolOrder.filter((name) => name === GATE_OVERRIDE_TOOL).length, registrationsAfterStart);

			// Turning codemode/tool_search off mid-session re-registers as direct.
			activeTools = ["read", "bash", "edit", "write"];
			await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
			assert.equal(host.tools.get(GATE_OVERRIDE_TOOL)?.exposure, undefined);
		});
	}

	// Untrusted projects never register orchestrator_override even when codemode is active.
	await withTempDir(async (dir) => {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

		const host = createFakeHost({ sessionId: "override-untrusted-codemode", cwd: dir, trusted: false });
		(host.pi as unknown as { getActiveTools: () => string[] }).getActiveTools = () => ["read", "codemode", "tool_search"];
		orchestratorExtension(host.pi, { role: "parent" });

		await host.fire("session_start", {});
		await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
		await host.fire("agent_before_settle", boundaryEvent());
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);
	});
});

test("orchestrator_override transitioning direct to codemode calls setActiveTools to remove it from activeTools", async () => {
	for (const activeTool of ["codemode", "tool_search"]) {
		await withTempDir(async (dir) => {
			await mkdir(path.join(dir, ".pi"), { recursive: true });
			await writeFile(gateConfigPath(dir), JSON.stringify({ version: 1, block: { openTodos: true } }));

			let activeTools = ["read", "bash", "edit", "write", GATE_OVERRIDE_TOOL];
			const setActiveCalls: string[][] = [];
			const host = createFakeHost({ sessionId: `override-direct-to-${activeTool}`, cwd: dir, trusted: true });
			const api = host.pi as unknown as {
				getActiveTools: () => string[];
				setActiveTools: (names: string[]) => void;
			};
			api.getActiveTools = () => [...activeTools];
			api.setActiveTools = (names: string[]) => {
				setActiveCalls.push([...names]);
				activeTools = [...names];
			};
			orchestratorExtension(host.pi, { role: "parent" });

			await host.fire("session_start", {});
			assert.equal(host.tools.get(GATE_OVERRIDE_TOOL)?.exposure, undefined);
			assert.equal(setActiveCalls.length, 0);

			activeTools = ["read", "bash", "edit", "write", GATE_OVERRIDE_TOOL, activeTool];
			await host.fire("before_agent_start", { systemPromptOptions: { sections: {} } });
			assert.equal(host.tools.get(GATE_OVERRIDE_TOOL)?.exposure, "codemode");
			assert.equal(setActiveCalls.length, 2, "workspace and override transitions each update activeTools");
			assert.equal(activeTools.includes(GATE_OVERRIDE_TOOL), false);
			assert.deepEqual(activeTools, ["read", "bash", "edit", "write", activeTool]);
		});
	}
});

// --- Worker role ------------------------------------------------------------

/**
 * A delegated child that loads the orchestrator and then has its child markers
 * scrubbed still reports, runs nothing and blocks nothing.
 *
 * This is the regression the role module exists for. The old guard read
 * `PI_TMUX_SUBAGENT_CHILD` at every call site, and the subagent factory deletes
 * it during startup, so by this boundary the guard was gone and the child ran
 * the project's verification command and blocked its own settlement — while the
 * parent was still waiting on it.
 */
test("a delegated worker reports, runs no command and blocks nothing after its child markers are scrubbed", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi", "todos"), { recursive: true });
		await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));
		await writeFile(
			path.join(cwd, ".pi", "todos", "aaaaaaaa.md"),
			`${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`,
		);

		await withEnv({ PI_TODO_PATH: undefined }, async () => {
			// The real order: the launcher sets the markers, the subagent factory
			// reads them, and then it scrubs them from the process so a `pi` spawned
			// from the child's shell tool cannot re-enter child mode.
			await withEnv({ PI_TMUX_SUBAGENT_CHILD: "1", PI_ORCHESTRATOR_ROLE: "worker" }, async () => {
				await withEnv({ PI_TMUX_SUBAGENT_CHILD: undefined, PI_ORCHESTRATOR_ROLE: undefined }, async () => {
					const host = await startHost({ branch: [], cwd, role: "worker" });
					await host.fire("session_start", {});

					const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
					const verdict = gateVerdictOf(result);

					assert.equal(verdict.decision, "report", "a child never blocks its own settlement");
					assert.equal(verdict.scope, "child");
					assert.equal(result.continue, undefined, "no continuation is requested from a child");
					assert.equal(host.execCalls.length, 0, "the verification command must not run as a child");
					const suppressed = verdict.reasons.find((reason) => reason.code === "blocking-suppressed");
					assert.match(String(suppressed?.summary ?? ""), /PI_ORCHESTRATOR_ROLE=worker/);
					assert.match(String(suppressed?.summary ?? ""), /PI_TMUX_SUBAGENT_CHILD/);
					assert.equal(
						host.tools.has(GATE_OVERRIDE_TOOL),
						false,
						"a child gets no escape hatch, at session start or at the boundary",
					);
				});
			});
		});
	});
});

/**
 * The control for the worker test: the same project, as a parent, blocks and
 * runs the configured command. Without this, "report" above could be a
 * misconfigured fixture rather than the role doing its job.
 */
test("the same project blocks a parent and runs its verification command", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			gateConfigPath(cwd),
			JSON.stringify({ version: 1, verification: { command: "node --test", timeoutMs: 30_000 } }),
		);
		await withEnv({ PI_TODO_PATH: undefined }, async () => {
			const exec = async () => ({ stdout: "ok", stderr: "", code: 0, killed: false, truncated: false });
			const parent = await startHost({
				cwd,
				role: "parent",
				exec,
				branch: [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")],
			});
			const parentVerdict = gateVerdictOf((await parent.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
			assert.equal(parentVerdict.scope, "parent");
			assert.equal(parentVerdict.decision, "continue", "a parent is held to the project's policy");
			assert.equal(parent.execCalls.length, 1, "a parent runs the configured command");

			const worker = await startHost({
				cwd,
				role: "worker",
				exec,
				branch: [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")],
			});
			const workerVerdict = gateVerdictOf((await worker.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
			assert.equal(workerVerdict.scope, "child");
			assert.equal(workerVerdict.decision, "report");
			assert.equal(worker.execCalls.length, 0);
		});
	});
});

// --- Prompt stability -------------------------------------------------------

test("before_agent_start returns no systemPrompt and no handler writes to it", async () => {
	const host = await startHost({ branch: [] });
	const event = { systemPrompt: "base", systemPromptOptions: { sections: {} } };
	const result = await host.fire("before_agent_start", event);
	const proposal = (result ?? {}) as Record<string, unknown>;

	// A returned `systemPrompt` would fold run-time state into the cached prefix.
	assert.equal("systemPrompt" in proposal, false);
	assert.equal(event.systemPrompt, "base", "no handler may rewrite the run's system prompt");
	assert.deepEqual(Object.keys((event.systemPromptOptions as { sections: Record<string, string> }).sections), []);
	// The only prompt mutation the orchestrator has is a namespaced section.
	assert.equal(ADVISOR_SECTION, "advisor");
});

test("an override is not burned on a settlement that could not block", () => {
	// The budget is spent, so this settlement reports with or without an override;
	// consuming the one-shot here would silently waste it.
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 2,
		attemptCap: 2,
		openTodos: [{ id: "aaaaaaaa", title: "finish", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		override: { reason: "iterating", at: 1 },
		now: 2,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.override, null, "the override must stay pending");
});

test("attemptCap 0 is reported as disabled, not as attention", () => {
	const verdict = evaluateGate({ outcome: "completed", attempts: 0, attemptCap: 0 });
	assert.equal(verdict.kind, "clear");
	assert.equal(verdict.conditions.find((condition) => condition.kind === "attempt")?.status, "clear");
});

test("verdicts, blocked conditions and the attempt budget survive a simulated resume", async () => {
	const host = await startHost({ branch: [gateStateEntry(1)] });
	await host.fire("session_start", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	const verdict = gateVerdictOf(result);
	assert.equal(verdict.attempts, 1);
	assert.equal(verdict.reasons.some((reason) => reason.code === "settlement-blocked"), false, "nothing blocks after a resume");
});

test("session_tree re-reconstructs the last decision instead of resetting it", async () => {
	const host = await startHost({ branch: [gateStateEntry(2)] });
	await host.fire("session_start", {});
	await host.fire("session_tree", {});
	const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
	assert.equal(gateVerdictOf(result).attempts, 2);
});

test("a budget reached before a resume stays reached after it", async () => {
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			await withTempDir(async (cwd) => {
				await mkdir(path.join(cwd, ".pi"), { recursive: true });
				await writeFile(
					gateConfigPath(cwd),
					JSON.stringify({ version: 1, block: { openTodos: true, repeatedFailure: true } }),
				);
				// The budget was spent on a different condition than the one open now,
				// so the cap — not the per-condition memory — is what settles this run.
				const resumed = await startHost({
					branch: [
						gateStateEntry(3),
						assistantCall("b1", "bash", { command: "npm test" }),
						toolResult("b1", "bash", { isError: true, text: "boom" }),
						assistantCall("b2", "bash", { command: "npm test" }),
						toolResult("b2", "bash", { isError: true, text: "boom" }),
					],
					cwd,
				});
				await resumed.fire("session_start", {});
				const after = (await resumed.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				const verdict = gateVerdictOf(after);
				assert.equal(after.continue, undefined, "an exhausted budget settles the run");
				assert.equal(verdict.attempts, 3);
				assert.equal(verdict.remainingAttempts, 0);
				assert.ok(verdict.reasons.some((reason) => reason.code === "attempt-cap-reached"));
			});
		});
	});
});

test("a run that did not complete is reported, never continued", async () => {
	await withTempDir(async (todosDir) => {
		await writeFile(path.join(todosDir, "aaaaaaaa.md"), `${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`);
		await withEnv({ PI_TODO_PATH: todosDir }, async () => {
			await withTempDir(async (cwd) => {
				await mkdir(path.join(cwd, ".pi"), { recursive: true });
				await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true } }));
				const host = await startHost({ branch: [], cwd });
				const result = (await host.fire(
					"agent_before_settle",
					boundaryEvent([], { outcome: "error" }),
				)) as BoundaryProposal;
				assert.equal(result.continue, undefined);
				assert.equal(gateVerdictOf(result).decision, "report");
				assert.ok(gateVerdictOf(result).reasons.some((reason) => reason.code === "blocking-suppressed"));
			});
		});
	});
});

test("verification re-runs for new edits, not for evidence it already blocked", async () => {
	// The required-override change keeps the same evidence blocking, so the gate
	// must re-run the project's command when the files under verification change;
	// otherwise it would keep blocking on a state it never rechecked.
	const execCalls: string[][] = [];
	const exec = async (command: string, args: string[]) => {
		execCalls.push([command, ...args]);
		return { code: 0, killed: false, truncated: false, stdout: "ok", stderr: "" };
	};
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			gateConfigPath(cwd),
			JSON.stringify({ version: 1, verification: { command: "node --test" } }),
		);
		const firstEdit = [assistantCall("w1", "write", { path: "src/a.ts" }), toolResult("w1", "write")];
		const host = await startHost({ branch: firstEdit, cwd, exec });
		await host.fire("session_start", {});
		const first = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		assert.equal(execCalls.length, 1, "the configured command runs on the first settlement");
		const firstVerdict = gateVerdictOf(first);
		assert.equal(firstVerdict.decision, "continue", "a pass is informational once");

		// Same evidence: the command already ran, so it must not run again.
		const same = await startHost({ branch: [...firstEdit, ...(first.entries as Entry[])], cwd, exec });
		await same.fire("session_start", {});
		const repeated = (await same.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		assert.equal(execCalls.length, 1, "the same evidence is not re-verified");
		assert.equal(gateVerdictOf(repeated).decision, "report");

		// A new edit changes the evidence: verify it, even though the kind blocked before.
		const newEdit = [assistantCall("w2", "write", { path: "src/b.ts" }), toolResult("w2", "write")];
		const changed = await startHost({ branch: [...firstEdit, ...(first.entries as Entry[]), ...newEdit], cwd, exec });
		await changed.fire("session_start", {});
		await changed.fire("agent_before_settle", boundaryEvent());
		assert.equal(execCalls.length, 2, "a new edit re-arms the verification run");
	});
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

test("/gate shows the last verdict, and --json returns the verdict, the last loop block and the advisor record", async () => {
	await withTempDir(async (cwd) => {
		const host = await startHost({ branch: [], cwd });
		const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		const verdict = gateVerdictOf(result);

		await host.runCommand("gate");
		const text = String(host.messages.at(-1)?.message.content ?? "");
		assert.match(text, /Orchestration gate: CLEAR \(report-only\)/);
		assert.match(text, new RegExp(`Attempt ${verdict.attempts} of 3 gate blocks`));

		await host.runCommand("gate", "--json");
		const json = String(host.messages.at(-1)?.message.content ?? "");
		assert.deepEqual(JSON.parse(json), { verdict, loop: null, advisor: null });
	});
});

// --- Delegated-run parking (ticket 02) --------------------------------------

/**
 * Emit one orchestration event through the fake host's bus. The fake now
 * dispatches as well as records, so this drives the factory's subscriptions the
 * same way the subagent extension's publications would in one process.
 */
function emitOrchestration(host: Awaited<ReturnType<typeof startHost>>, channel: string, data: unknown): void {
	(host.pi.events as unknown as { emit: (name: string, payload: unknown) => void }).emit(channel, data);
}

/** A project that opted into parking: an open todo plus `waitForSubagents`. */
async function withParkingProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	return withTempDir(async (cwd) => {
		const todosDir = path.join(cwd, "todos");
		await mkdir(todosDir, { recursive: true });
		await writeFile(
			path.join(todosDir, "aaaaaaaa.md"),
			`${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`,
		);
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(cwd), JSON.stringify({ version: 1, block: { openTodos: true, waitForSubagents: true } }));
		return await withEnv({ PI_TODO_PATH: todosDir }, () => fn(cwd));
	});
}

test("waitForSubagents is off by default: a live run still blocks and spends an attempt", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		liveRuns: ["run-1"],
		now: 1,
	});
	assert.equal(verdict.decision, "continue");
	assert.equal(verdict.parked, false);
	assert.deepEqual(verdict.liveRuns, [], "live ids are reported only when they parked the settlement");
	assert.equal(verdict.attempts, 1);
});

test("a live run parks a would-be block: no continuation, no attempt, the ids in the verdict", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 1,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: ["todos"], alreadyBlockedEvidence: { todos: "aaaaaaaa" } },
		liveRuns: ["run-1", "run-2"],
		waitForSubagents: true,
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.parked, true);
	assert.deepEqual(verdict.liveRuns, ["run-1", "run-2"]);
	assert.equal(verdict.kind, "attention");
	assert.equal(verdict.attempts, 1, "parking spends no attempt");
	assert.deepEqual(verdict.blockedBy, [], "parking did not block");
	assert.deepEqual(verdict.blockedConditions, ["todos"], "the already-blocked set is unchanged");
	assert.deepEqual(verdict.blockedEvidence, { todos: "aaaaaaaa" }, "the already-blocked evidence is unchanged");
	const parked = verdict.reasons.find((reason) => reason.code === "settlement-parked");
	assert.ok(parked, "the verdict names why it parked");
	assert.match(parked!.summary, /run-1/);
	assert.match(parked!.summary, /open todo/);
	assert.match(verdict.reason, /parked/);
});

test("with waitForSubagents but no live run, the same settlement blocks as today", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		liveRuns: [],
		waitForSubagents: true,
		now: 1,
	});
	assert.equal(verdict.decision, "continue");
	assert.equal(verdict.parked, false);
	assert.equal(verdict.attempts, 1);
});

test("an override wins over parking and is consumed", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		override: { reason: "deliberately settling", at: 7 },
		liveRuns: ["run-1"],
		waitForSubagents: true,
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.parked, false, "an override is an action, not a park");
	assert.deepEqual(verdict.override, { reason: "deliberately settling", at: 7 });
	assert.equal(verdict.attempts, 0);
});

test("an exhausted budget does not park: there is nothing left to save", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 3,
		attemptCap: 3,
		openTodos: [{ id: "aaaaaaaa", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: ["todos"] },
		liveRuns: ["run-1"],
		waitForSubagents: true,
		now: 1,
	});
	assert.equal(verdict.decision, "report");
	assert.equal(verdict.parked, false);
	assert.equal(verdict.attempts, 3);
	assert.ok(verdict.reasons.some((reason) => reason.code === "attempt-cap-reached"));
});

test("a persisted verdict without the parking fields reconstructs as not parked", () => {
	const state = reconstructGateState([gateStateEntry(1)]);
	assert.equal(state.lastVerdict?.parked, false);
	assert.deepEqual(state.lastVerdict?.liveRuns, []);

	const parkedEntry = gateStateEntry(0, 3, {
		parked: true,
		liveRuns: ["run-1"],
	});
	const parkedState = reconstructGateState([parkedEntry]);
	assert.equal(parkedState.lastVerdict?.parked, true);
	assert.deepEqual(parkedState.lastVerdict?.liveRuns, ["run-1"]);
});

test("formatVerdict says a parked settlement parked rather than blocked", () => {
	const verdict = evaluateGate({
		outcome: "completed",
		attempts: 0,
		attemptCap: 3,
		openTodos: [{ id: "deadbeef", title: "t", status: "open" }],
		policy: { kinds: ["todos"], alreadyBlocked: [] },
		liveRuns: ["run-1"],
		waitForSubagents: true,
		now: 1,
	});
	const text = formatVerdict(verdict);
	assert.match(text, /Parked:/);
	assert.match(text, /run-1/);
});

test("a settlement with a live run parks, and the last run settling wakes the parent exactly once", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-live-1", status: "queued", at: 1 });

		const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		const verdict = gateVerdictOf(result);
		assert.equal(result.continue, undefined, "a park returns no continuation");
		assert.equal(verdict.parked, true);
		assert.deepEqual(verdict.liveRuns, ["run-live-1"]);
		assert.equal(verdict.attempts, 0);
		assert.equal(host.messages.length, 0, "parking sends nothing");

		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "run-live-1",
			status: "completed",
			finishedAt: 2,
		});
		assert.equal(host.messages.length, 1, "the last settled run wakes the parked parent");
		const sent = host.messages[0]!;
		assert.equal(sent.message.customType, "orchestrator-resume");
		assert.equal(sent.options?.triggerTurn, true);
		assert.equal(sent.options?.deliverAs, "followUp");
		assert.match(String(sent.message.content), /run-live-1/);

		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "run-live-1",
			status: "completed",
			finishedAt: 3,
		});
		assert.equal(host.messages.length, 1, "a second settle in the same state does not wake again");
	});
});

test("a parked parent stays parked while another run is live, then wakes on the last one", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-a", status: "running", at: 1 });
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-b", status: "running", at: 1 });
		const verdict = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
		assert.deepEqual(verdict.liveRuns, ["run-a", "run-b"]);

		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-a", status: "failed", finishedAt: 2 });
		assert.equal(host.messages.length, 0, "one sibling finishing does not wake the parent");
		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-b", status: "completed", finishedAt: 3 });
		assert.equal(host.messages.length, 1);
	});
});

test("a cancelled only-run releases the park", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-cancelled", status: "running", at: 1 });
		const verdict = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
		assert.equal(verdict.parked, true);

		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-cancelled", status: "cancelled", finishedAt: 2 });
		assert.equal(host.messages.length, 1, "cancelled is terminal for parking");
		assert.equal(host.messages[0]!.message.customType, "orchestrator-resume");
	});
});

test("without a live run the settlement blocks normally: parking is not a blanket suppression", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		const verdict = gateVerdictOf(result);
		assert.equal(result.continue, true);
		assert.equal(verdict.parked, false);
		assert.equal(verdict.attempts, 1);
		assert.equal(host.messages.length, 0, "no wake when nothing ever parked");
	});
});

test("a runs snapshot rebuilds the live set before the first settlement after a reload", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runsSnapshot, {
			runs: [{ runId: "run-after-reload", status: "running" }],
			at: 5,
		});

		const verdict = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
		assert.equal(verdict.parked, true);
		assert.deepEqual(verdict.liveRuns, ["run-after-reload"]);
	});
});

test("a worker with the same config and a live run never parks", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd, role: "worker" });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-live", status: "running", at: 1 });

		const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		const verdict = gateVerdictOf(result);
		assert.equal(verdict.scope, "child");
		assert.equal(verdict.parked, false);
		assert.equal(result.continue, undefined);

		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-live", status: "completed", finishedAt: 2 });
		assert.equal(host.messages.length, 0, "a worker never wakes the parent");
	});
});

test("an aborted run clears a park so a later settlement does not wake", async () => {
	await withParkingProject(async (cwd) => {
		const host = await startHost({ cwd });
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-abort", status: "running", at: 1 });
		const parked = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
		assert.equal(parked.parked, true);

		// Aborting skips agent_before_settle, so nothing else would disarm the park.
		await host.fire("agent_settled", { aborted: true });
		emitOrchestration(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-abort", status: "completed", finishedAt: 2 });
		assert.equal(host.messages.length, 0, "the user aborted; a late child must not pull them back into a run");
	});
});

test("a parked settlement does not run the verification command it would discard", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			gateConfigPath(cwd),
			JSON.stringify({ version: 1, block: { waitForSubagents: true }, verification: { command: "node --test" } }),
		);
		const exec = async () => ({ stdout: "ok", stderr: "", code: 0, killed: false, truncated: false });
		const host = await startHost({
			cwd,
			exec,
			branch: [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")],
		});
		await host.fire("session_start", {});
		emitOrchestration(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-live", status: "running", at: 1 });

		const verdict = gateVerdictOf((await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal);
		assert.equal(verdict.parked, true);
		assert.equal(host.execCalls.length, 0, "the outcome would be discarded by the park; the next settlement runs it once");
	});
});
