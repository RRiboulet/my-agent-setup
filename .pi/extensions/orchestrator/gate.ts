/**
 * The settlement gate's decision function and session-backed state.
 *
 * This ticket (08) is REPORT-ONLY. The gate runs at `agent_before_settle`,
 * evaluates the conditions this repository considers "finished", appends one
 * `custom` session entry holding the verdict, publishes `orchestrator:gate-decided`
 * and returns no `continue`. Blocking, verification commands and the override
 * arrive in ticket 09; keeping the decision function free of action means that
 * ticket can add action without changing what a verdict means.
 *
 * State lives in the session log, following `goal.ts`: every verdict is an
 * append-only `custom` entry, and `session_start` / `session_tree` rebuild the
 * attempt count and last verdict from the active branch. No file store. A resume
 * therefore cannot reset the cap, and tree navigation sees the branch it
 * navigated to.
 *
 * "Attempt" is one recorded gate evaluation on this branch. The retry cap is a
 * project setting (`.pi/orchestrator.json`, `retryCap`, default 3); when the
 * number of recorded evaluations reaches it the verdict says no allowance
 * remains. Nothing happens as a result in this ticket.
 *
 * "Verification" here means a successful `bash`/`powershell` call after the last
 * edit, which is a proxy, not the project's test command (ticket 09 replaces it):
 * `ls` or `git status` clears an edit just as a test run would. And the gate reads
 * only the PARENT's branch, so a run that delegated its edits to subagents and
 * never ran a shell command itself reports no unverified edits over a worktree
 * full of them. Both are acceptable for a report-only gate and neither may be
 * mistaken for run-wide coverage.
 *
 * Everything that can be unevaluable is handled as data, never thrown: an
 * unreadable config, an unreadable todo directory, a malformed persisted
 * verdict. Such a condition is marked `unknown` and the decision remains
 * `report`, which is the fail-open behaviour R33 asks for.
 */

import { activeGoalFromBranch } from "../goal.ts";
import type { OpenTodo } from "./todo-state.ts";

export const GATE_ENTRY_TYPE = "orchestrator-gate";
export const GATE_VERSION = 1;

const EDIT_TOOLS = new Set(["edit", "write"]);
const VERIFICATION_TOOLS = new Set(["bash", "powershell"]);
const FAILURE_WINDOW = 200;

export type GateConditionKind = "goal" | "todos" | "verification" | "failure" | "retry" | "unevaluated";
export type GateConditionStatus = "clear" | "attention" | "unknown";

export interface GateCondition {
	kind: GateConditionKind;
	status: GateConditionStatus;
	summary: string;
}

export interface GateReason {
	code: string;
	summary: string;
	details?: Record<string, unknown>;
}

export interface GateVerdict {
	version: typeof GATE_VERSION;
	/** `attention` means at least one condition is open or unknown. It is not a
	 *  request to block; `decision` carries that, and is always `report` here. */
	kind: "clear" | "attention";
	decision: "report";
	outcome: string;
	at: number;
	/** Evaluations recorded on this branch, including this one. */
	attempts: number;
	retryCap: number;
	remainingAttempts: number;
	reasons: GateReason[];
	conditions: GateCondition[];
}

interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

export interface EditState {
	/** Files edited since the last successful verification command. */
	editedFiles: string[];
	/** Successful bash/powershell results seen on the branch. Diagnostic only. */
	verificationRuns: number;
}

export interface FailureSignature {
	signature: string;
	count: number;
	tool: string;
	detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ");
}

function firstLine(text: string): string {
	return collapse(text.split("\n", 1)[0] ?? "");
}

function describeInvocation(tool: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	if (tool === "bash" && typeof args.command === "string") return collapse(args.command);
	if ((tool === "edit" || tool === "write") && typeof args.path === "string") return collapse(args.path);
	try {
		return collapse(JSON.stringify(args));
	} catch {
		return "";
	}
}

/**
 * Reconstruct the last verdict and the attempt count from the active branch.
 * The LAST gate entry wins, exactly like `goal.ts`'s reconstruction; a
 * navigation to a branch before any decision legitimately reports zero.
 */
export function reconstructGateState(branch: readonly unknown[]): {
	attempts: number;
	lastVerdict: GateVerdict | null;
} {
	let lastVerdict: GateVerdict | null = null;
	for (const item of branch) {
		if (!isRecord(item) || item.type !== "custom" || item.customType !== GATE_ENTRY_TYPE) continue;
		const verdict = normalizePersistedVerdict(item.data);
		if (verdict) lastVerdict = verdict;
	}
	return { attempts: lastVerdict?.attempts ?? 0, lastVerdict };
}

/** Accept a verdict written by an earlier build, with defaults for anything
 *  that is missing; reject data that cannot describe a decision at all. */
function normalizePersistedVerdict(data: unknown): GateVerdict | null {
	if (!isRecord(data)) return null;
	const attempts = data.attempts;
	if (typeof attempts !== "number" || !Number.isFinite(attempts) || attempts < 0) return null;
	const retryCap = typeof data.retryCap === "number" && Number.isFinite(data.retryCap) && data.retryCap >= 0
		? Math.floor(data.retryCap)
		: 0;
	const reasons = Array.isArray(data.reasons)
		? data.reasons.filter((reason): reason is GateReason => isRecord(reason) && typeof reason.summary === "string")
		: [];
	const conditions = Array.isArray(data.conditions)
		? data.conditions.filter((condition): condition is GateCondition => isRecord(condition) && typeof condition.summary === "string")
		: [];
	return {
		version: GATE_VERSION,
		kind: data.kind === "clear" ? "clear" : "attention",
		decision: "report",
		outcome: typeof data.outcome === "string" ? data.outcome : "unknown",
		at: typeof data.at === "number" && Number.isFinite(data.at) ? data.at : 0,
		attempts: Math.floor(attempts),
		retryCap,
		remainingAttempts: Math.max(0, retryCap - Math.floor(attempts)),
		reasons,
		conditions,
	};
}

/**
 * Files edited since the last successful verification command.
 *
 * The tool names are pi's built-ins (`edit`, `write`, `bash`, `powershell`).
 * A tool call only counts once its result succeeded, so a rejected edit does not
 * manufacture an open condition. Ticket 09 replaces "any bash succeeded" with
 * the project's configured verification command; this function is therefore the
 * seam that ticket changes, not a throwaway.
 */
export function scanEditVerification(branch: readonly unknown[]): EditState {
	const calls = new Map<string, ToolCallRecord>();
	const edited = new Set<string>();
	let verificationRuns = 0;

	for (const item of branch) {
		if (!isRecord(item) || item.type !== "message" || !isRecord(item.message)) continue;
		const message = item.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				calls.set(block.id, { name: block.name, arguments: isRecord(block.arguments) ? block.arguments : {} });
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError === true) continue;
		const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
		const tool = typeof message.toolName === "string" ? message.toolName : call?.name;
		if (!tool) continue;
		if (EDIT_TOOLS.has(tool)) {
			const path = call?.arguments.path;
			edited.add(typeof path === "string" && path.trim() ? path : "(unknown file)");
			continue;
		}
		if (VERIFICATION_TOOLS.has(tool)) {
			edited.clear();
			verificationRuns += 1;
		}
	}

	return { editedFiles: [...edited].sort(), verificationRuns };
}

/**
 * The most repeated failure signature in the recent branch.
 *
 * A signature is tool + invocation + the first line of the error, so the same
 * command failing with the same message twice is a repeat while two different
 * failures are not. This is evidence, not a verdict: the gate only reports it.
 * Ticket 09's loop breaker adds the no-progress rule on top; it does not need
 * this function to act.
 */
export function scanFailures(branch: readonly unknown[], window = FAILURE_WINDOW): FailureSignature | null {
	const calls = new Map<string, ToolCallRecord>();
	const messages = branch.filter((item) => isRecord(item) && item.type === "message").slice(-window);
	const counts = new Map<string, FailureSignature>();

	for (const item of messages) {
		if (!isRecord(item) || !isRecord(item.message)) continue;
		const message = item.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
				calls.set(block.id, { name: block.name, arguments: isRecord(block.arguments) ? block.arguments : {} });
			}
			continue;
		}
		if (message.role !== "toolResult" || message.isError !== true) continue;
		const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
		const tool = typeof message.toolName === "string" ? message.toolName : call?.name ?? "tool";
		const invocation = describeInvocation(tool, call?.arguments);
		const detail = firstLine(textFromContent(message.content));
		const signature = `${tool}|${invocation}|${detail}`;
		const current = counts.get(signature);
		if (current) current.count += 1;
		else counts.set(signature, { signature, count: 1, tool, detail });
	}

	let repeated: FailureSignature | null = null;
	for (const candidate of counts.values()) {
		if (candidate.count < 2) continue;
		if (!repeated || candidate.count > repeated.count) repeated = candidate;
	}
	return repeated;
}

export interface GateEvaluationInput {
	outcome: string;
	/** Evaluations recorded before this one. */
	attempts: number;
	retryCap: number;
	activeGoal?: { id: string; objective: string } | null;
	openTodos?: OpenTodo[];
	edits?: EditState;
	failure?: FailureSignature | null;
	/** Conditions that could not be evaluated, with the reason. */
	unevaluated?: string[];
	now?: number;
}

/** The pure decision function. No I/O, no clock, no pi API. */
export function evaluateGate(input: GateEvaluationInput): GateVerdict {
	const attempts = Math.max(0, Math.floor(input.attempts)) + 1;
	const retryCap = Number.isFinite(input.retryCap) && input.retryCap >= 0 ? Math.floor(input.retryCap) : 0;
	const remainingAttempts = Math.max(0, retryCap - attempts);
	const conditions: GateCondition[] = [];
	const reasons: GateReason[] = [];

	const goal = input.activeGoal ?? null;
	if (goal) {
		conditions.push({ kind: "goal", status: "attention", summary: `a goal is still active: ${goal.objective}` });
		reasons.push({
			code: "goal-active",
			summary: `a goal is still active: ${goal.objective}`,
			details: { goalId: goal.id },
		});
	} else {
		conditions.push({ kind: "goal", status: "clear", summary: "no active goal" });
	}

	const openTodos = input.openTodos ?? [];
	if (openTodos.length > 0) {
		const ids = openTodos.map((todo) => todo.id);
		const summary = `${openTodos.length} open todo${openTodos.length === 1 ? "" : "s"}: ${ids.join(", ")}`;
		conditions.push({ kind: "todos", status: "attention", summary });
		reasons.push({ code: "open-todos", summary, details: { ids, titles: openTodos.map((todo) => todo.title) } });
	} else {
		conditions.push({ kind: "todos", status: "clear", summary: "no open todos" });
	}

	const editedFiles = input.edits?.editedFiles ?? [];
	if (editedFiles.length > 0) {
		const summary = `${editedFiles.length} file${editedFiles.length === 1 ? "" : "s"} edited since the last successful shell command: ${editedFiles.join(", ")}`;
		conditions.push({ kind: "verification", status: "attention", summary });
		reasons.push({ code: "edits-without-verification", summary, details: { files: editedFiles } });
	} else {
		conditions.push({ kind: "verification", status: "clear", summary: "no unverified edits" });
	}

	const failure = input.failure ?? null;
	if (failure) {
		const summary = `the same failure repeated ${failure.count} times: ${failure.tool} ${failure.detail}`;
		conditions.push({ kind: "failure", status: "attention", summary });
		reasons.push({
			code: "repeated-failure",
			summary,
			details: { count: failure.count, tool: failure.tool, signature: failure.signature },
		});
	} else {
		conditions.push({ kind: "failure", status: "clear", summary: "no repeated failure signature" });
	}

	if (remainingAttempts === 0) {
		const summary = `no retry allowance remains (${attempts} of ${retryCap} attempts used)`;
		conditions.push({ kind: "retry", status: "attention", summary });
		reasons.push({ code: "retry-cap-reached", summary, details: { attempts, retryCap } });
	} else {
		conditions.push({
			kind: "retry",
			status: "clear",
			summary: `${remainingAttempts} of ${retryCap} attempts remain`,
		});
	}

	for (const note of input.unevaluated ?? []) {
		conditions.push({ kind: "unevaluated", status: "unknown", summary: note });
		reasons.push({ code: "unevaluated", summary: note });
	}

	return {
		version: GATE_VERSION,
		kind: conditions.some((condition) => condition.status !== "clear") ? "attention" : "clear",
		decision: "report",
		outcome: input.outcome,
		at: input.now ?? Date.now(),
		attempts,
		retryCap,
		remainingAttempts,
		reasons,
		conditions,
	};
}

/** Human-readable form used by `/gate` and by the report-only entry's renderer
 *  if one is added later. Kept here so the command has no formatting logic of
 *  its own. */
export function formatVerdict(verdict: GateVerdict): string {
	const lines = [
		`Orchestration gate: ${verdict.kind.toUpperCase()} (report-only)`,
		`Attempt ${verdict.attempts} of ${verdict.retryCap} · ${verdict.remainingAttempts} remaining · outcome ${verdict.outcome}`,
	];
	if (verdict.reasons.length === 0) {
		lines.push("No open condition: no active goal, no open todos, no unverified edits, no repeated failure.");
	} else {
		lines.push("Reasons:");
		for (const reason of verdict.reasons) lines.push(`  - ${reason.summary}`);
	}
	const unknown = verdict.conditions.filter((condition) => condition.status === "unknown");
	if (unknown.length > 0) {
		lines.push("Unevaluated (reported, not blocking):");
		for (const condition of unknown) lines.push(`  - ${condition.summary}`);
	}
	return lines.join("\n");
}
