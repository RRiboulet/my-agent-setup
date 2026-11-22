/**
 * The settlement gate: the decision function, the session-backed state, and the
 * vocabulary shared by its verdict, its loop blocks and its override.
 *
 * Ticket 08 made this REPORT-ONLY. Ticket 09 adds the action half, but only where
 * a project has opted in: `evaluateGate` decides, and every decision is still a
 * pure function of its input. Nothing here reads a file, spawns a process or
 * touches the clock except through `now`.
 *
 * What a block means, exactly:
 *
 *   * `decision: "continue"` is a settlement block. It is expressed at the
 *     boundary as `continue: true` plus a `custom_message` carrying the reason,
 *     so the model gets one more turn with the evidence. It never terminates the
 *     run, and it never drops entries an earlier handler proposed.
 *   * A condition can block **once** on a branch: `blockedConditions` is carried
 *     in every verdict and reconstructed by union from the active branch, so the
 *     second settlement with the same open condition reports and settles. That is
 *     what "blocks settlement once" means, and it is why a gate cannot be a trap.
 *   * `attemptCap` bounds every gate block on the branch, settlement and loop
 *     alike. `attempts` counts blocks, not evaluations: ticket 08's counter
 *     counted settles, so an active goal reached the cap on its third
 *     continuation with nothing having failed. The field is renamed for what it
 *     bounds and nothing else. `attemptCap: 0` therefore disables blocking
 *     without disabling reporting.
 *   * An override — the `orchestrator_override` tool — suppresses the next block
 *     and is named in every block reason, so a model that is legitimately
 *     iterating can continue without arguing with the gate.
 *
 * Two limits are stated in the verdict rather than left to be discovered:
 *
 *   * **The gate sees only this session's tool calls.** A run that delegated its
 *     edits to subagents reports no unverified edits over a worktree full of
 *     them, because a child is another process with another session log. `scope`
 *     says `child` inside a delegated child, where the gate reports and never
 *     acts: the parent owns the decision.
 *   * **Verification is the project's command, not any shell call.** With a
 *     command configured, only that command (or the gate's own run of it) counts.
 *     Without one, ticket 08's proxy — any successful shell call — is kept for
 *     the report.
 *
 * Everything that can be unevaluable is handled as data, never thrown: an
 * unreadable config, an unreadable todo directory, a malformed persisted verdict,
 * a verification command that timed out. Such a condition is marked `unknown` or
 * recorded as failed-open, and the decision remains `report` (R33).
 */

import type { OpenTodo } from "./todo-state.ts";
import { verificationFailedOpen, type VerificationOutcome } from "./verify.ts";

export const GATE_ENTRY_TYPE = "orchestrator-gate";
export const GATE_LOOP_ENTRY_TYPE = "orchestrator-gate-loop";
export const GATE_OVERRIDE_ENTRY_TYPE = "orchestrator-gate-override";
export const GATE_VERSION = 2;
/** The tool a block reason names, so a model has a mechanical way out. */
export const GATE_OVERRIDE_TOOL = "orchestrator_override";

const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FAILURE_WINDOW = 200;

export type GateConditionKind = "goal" | "todos" | "verification" | "failure" | "attempt" | "unevaluated";
export type GateConditionStatus = "clear" | "attention" | "unknown";
export type GateDecision = "report" | "continue";

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

/** One consumed override, recorded in the verdict that used it. */
export interface GateOverrideUse {
	reason: string;
	at: number;
}

export interface GateVerdict {
	version: typeof GATE_VERSION;
	/** `attention` means at least one condition is open or unknown. */
	kind: "clear" | "attention";
	/** What the gate did at this boundary. */
	decision: GateDecision;
	outcome: string;
	at: number;
	/** Which session's tool calls this verdict could see. */
	scope: "parent" | "child";
	/** Gate blocks recorded on this branch, including this one. */
	attempts: number;
	attemptCap: number;
	remainingAttempts: number;
	/** Condition kinds that stopped this settlement. Empty when reporting. */
	blockedBy: GateConditionKind[];
	/** Every condition kind that has ever blocked on this branch, including
	 *  this verdict's: the reason the next settlement cannot be blocked by them
	 *  while they report the same evidence. */
	blockedConditions: GateConditionKind[];
	/** The evidence each blocked kind reported when it blocked. A kind re-arms
	 *  when its evidence changes — new unverified edits, a different set of open
	 *  todos, a different failure — so one block cannot make a check decorative. */
	blockedEvidence: Partial<Record<GateConditionKind, string>>;
	/** What the gate's own verification run did, when it ran one. */
	verification: VerificationOutcome | null;
	/** The override this verdict consumed, when one was pending. */
	override: GateOverrideUse | null;
	/** One-line summary of the decision, used in the continuation message. */
	reason: string;
	reasons: GateReason[];
	conditions: GateCondition[];
}

/** The record one loop decision appends, shaped like a verdict so `/gate` can
 *  show it and a resume can reconstruct the attempt count. `action: "override"`
 *  is a consumed override that let a repeated call run; it spends no attempt. */
export interface LoopVerdict {
	version: typeof GATE_VERSION;
	action: "block" | "override";
	at: number;
	tool: string;
	invocation: string;
	kind: "no-progress" | "repeated-failure";
	count: number;
	detail: string;
	reason: string;
	attempts: number;
	attemptCap: number;
	remainingAttempts: number;
	/** Loop blocks already spent in this turn, including this one. */
	blocksTheTurn: number;
}

interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

/** Every settlement verdict and loop decision a branch holds, each in the order
 *  it was decided. */
export interface GateHistory {
	verdicts: GateVerdict[];
	loops: LoopVerdict[];
}

/**
 * Every settlement verdict and loop decision on the active branch, in branch
 * order. `reconstructGateState` answers "what is the state now"; this answers
 * "what has the gate done", which the advisor needs to tell a single block from
 * a repeated failure. Entries that cannot be read are skipped, exactly as the
 * reconstruction skips them: a malformed entry is not history.
 */
export function readGateHistory(branch: readonly unknown[]): GateHistory {
	const verdicts: GateVerdict[] = [];
	const loops: LoopVerdict[] = [];
	for (const item of branch) {
		if (!isRecord(item) || item.type !== "custom") continue;
		if (item.customType === GATE_LOOP_ENTRY_TYPE) {
			const loop = normalizePersistedLoop(item.data);
			if (loop) loops.push(loop);
			continue;
		}
		if (item.customType !== GATE_ENTRY_TYPE) continue;
		const verdict = normalizePersistedVerdict(item.data);
		if (verdict) verdicts.push(verdict);
	}
	return { verdicts, loops };
}

interface ToolCallRecord {
	name: string;
	arguments: Record<string, unknown>;
}

export interface EditState {
	/** Files edited since the last verification: a successful run of the
	 *  configured command, or the gate's own passing run. */
	editedFiles: string[];
	/** Successful verification runs seen on the branch, including the gate's own.
	 *  Reported in the verdict, never used to decide. */
	verificationRuns: number;
}

export interface FailureSignature {
	signature: string;
	count: number;
	tool: string;
	detail: string;
}

/** Which conditions the project allows to stop a settlement. */
export interface GateBlockPolicy {
	kinds: GateConditionKind[];
	/** Kinds that already blocked on this branch; they report only while their
	 *  evidence is unchanged. */
	alreadyBlocked: GateConditionKind[];
	/** Evidence each already-blocked kind reported, from `state.blockedEvidence`. */
	alreadyBlockedEvidence?: Partial<Record<GateConditionKind, string>>;
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

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

// --- Session-backed state ---------------------------------------------------

export interface GateState {
	/** Gate blocks recorded on this branch, settlement and loop alike. */
	attempts: number;
	lastVerdict: GateVerdict | null;
	lastLoopVerdict: LoopVerdict | null;
	/** Union of every condition kind that has blocked on this branch. */
	blockedConditions: GateConditionKind[];
	/** Latest evidence per blocked kind (last entry wins, like `attempts`). */
	blockedEvidence: Partial<Record<GateConditionKind, string>>;
}

const CONDITION_KINDS: readonly GateConditionKind[] = ["goal", "todos", "verification", "failure", "attempt", "unevaluated"];

function conditionKinds(value: unknown): GateConditionKind[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is GateConditionKind => typeof item === "string" && CONDITION_KINDS.includes(item as GateConditionKind));
}

/**
 * Reconstruct the attempt budget, the last verdicts and the set of conditions
 * that already blocked, from the active branch.
 *
 * The LAST entry of either gate type wins the attempt count, exactly like
 * `goal.ts`'s reconstruction; the blocked-condition set is a union, because it is
 * monotone and a navigation to a branch before any block legitimately reports
 * none. A gate entry whose `attempts` cannot be read is skipped rather than
 * trusted, so a malformed entry cannot raise or reset a cap.
 */
export function reconstructGateState(branch: readonly unknown[]): GateState {
	let lastVerdict: GateVerdict | null = null;
	let lastLoopVerdict: LoopVerdict | null = null;
	let attempts = 0;
	const blocked = new Set<GateConditionKind>();
	const blockedEvidence: Partial<Record<GateConditionKind, string>> = {};

	for (const item of branch) {
		if (!isRecord(item) || item.type !== "custom") continue;
		if (item.customType === GATE_LOOP_ENTRY_TYPE) {
			const loop = normalizePersistedLoop(item.data);
			if (!loop) continue;
			lastLoopVerdict = loop;
			attempts = loop.attempts;
			continue;
		}
		if (item.customType !== GATE_ENTRY_TYPE) continue;
		const verdict = normalizePersistedVerdict(item.data);
		if (!verdict) continue;
		lastVerdict = verdict;
		attempts = verdict.attempts;
		for (const kind of verdict.blockedConditions) {
			blocked.add(kind);
			const evidence = verdict.blockedEvidence?.[kind];
			// Missing evidence is not "unchanged": it is a ticket-08 entry, and
			// re-arming on it costs at most one extra block, bounded by the cap.
			if (typeof evidence === "string") blockedEvidence[kind] = evidence;
			else delete blockedEvidence[kind];
		}
	}

	return {
		attempts,
		lastVerdict,
		lastLoopVerdict,
		blockedConditions: [...blocked].sort() as GateConditionKind[],
		blockedEvidence,
	};
}

function optionalFinite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Accept a verdict written by an earlier build, with defaults for anything
 *  that is missing; reject data that cannot describe a decision at all. */
function normalizePersistedVerdict(data: unknown): GateVerdict | null {
	if (!isRecord(data)) return null;
	const attempts = optionalFinite(data.attempts);
	if (attempts === null || attempts < 0) return null;
	// `attemptCap` replaced `retryCap` in ticket 09; a ticket-08 entry carries the
	// old key and the same number.
	const cap = optionalFinite(data.attemptCap) ?? optionalFinite(data.retryCap);
	const attemptCap = cap !== null && cap >= 0 ? Math.floor(cap) : 0;
	const reasons = Array.isArray(data.reasons)
		? data.reasons.filter((reason): reason is GateReason => isRecord(reason) && typeof reason.summary === "string")
		: [];
	const conditions = Array.isArray(data.conditions)
		? data.conditions.filter((condition): condition is GateCondition => isRecord(condition) && typeof condition.summary === "string")
		: [];
	const finalAttempts = Math.floor(attempts);
	const blockedBy = conditionKinds(data.blockedBy);
	const blockedConditions = conditionKinds(data.blockedConditions).length > 0 ? conditionKinds(data.blockedConditions) : blockedBy;
	const blockedEvidence: Partial<Record<GateConditionKind, string>> = {};
	if (isRecord(data.blockedEvidence)) {
		for (const kind of CONDITION_KINDS) {
			const value = data.blockedEvidence[kind];
			if (typeof value === "string") blockedEvidence[kind] = value;
		}
	}
	return {
		version: GATE_VERSION,
		kind: data.kind === "clear" ? "clear" : "attention",
		// Ticket 08 never blocked; anything else is normalised to `report` so a
		// corrupted or older entry cannot manufacture an action.
		decision: data.decision === "continue" && data.version === GATE_VERSION ? "continue" : "report",
		outcome: typeof data.outcome === "string" ? data.outcome : "unknown",
		at: optionalFinite(data.at) ?? 0,
		scope: data.scope === "child" ? "child" : "parent",
		attempts: finalAttempts,
		attemptCap,
		remainingAttempts: Math.max(0, attemptCap - finalAttempts),
		blockedBy,
		blockedConditions,
		blockedEvidence,
		verification: isRecord(data.verification) ? (data.verification as unknown as VerificationOutcome) : null,
		override: isRecord(data.override) && typeof data.override.reason === "string"
			? { reason: data.override.reason, at: optionalFinite(data.override.at) ?? 0 }
			: null,
		reason: typeof data.reason === "string" ? data.reason : "",
		reasons,
		conditions,
	};
}

function normalizePersistedLoop(data: unknown): LoopVerdict | null {
	if (!isRecord(data) || (data.action !== "block" && data.action !== "override")) return null;
	const attempts = optionalFinite(data.attempts);
	if (attempts === null || attempts < 0) return null;
	const attemptCap = Math.max(0, Math.floor(optionalFinite(data.attemptCap) ?? 0));
	return {
		version: GATE_VERSION,
		action: data.action,
		at: optionalFinite(data.at) ?? 0,
		tool: typeof data.tool === "string" ? data.tool : "tool",
		invocation: typeof data.invocation === "string" ? data.invocation : "",
		kind: data.kind === "repeated-failure" ? "repeated-failure" : "no-progress",
		count: Math.max(0, Math.floor(optionalFinite(data.count) ?? 0)),
		detail: typeof data.detail === "string" ? data.detail : "",
		reason: typeof data.reason === "string" ? data.reason : "",
		attempts: Math.floor(attempts),
		attemptCap,
		remainingAttempts: Math.max(0, attemptCap - Math.floor(attempts)),
		blocksTheTurn: Math.max(0, Math.floor(optionalFinite(data.blocksTheTurn) ?? 0)),
	};
}

// --- Branch readers ---------------------------------------------------------

export interface EditScanOptions {
	/** The configured verification command. When set, only a successful run of
	 *  this exact command (or the gate's own passing run) counts as verification;
	 *  when absent, ticket 08's "any successful shell call" proxy is kept. */
	verificationCommand?: string | null;
}

/**
 * Files edited since the last verification.
 *
 * The tool names are pi's built-ins (`edit`, `write`, `bash`, `powershell`).
 * A tool call only counts once its result succeeded, so a rejected edit does not
 * manufacture an open condition.
 *
 * Three things clear an edit: a successful shell call when no verification
 * command is configured (ticket 08's proxy, kept for the report-only path), a
 * successful shell call whose command matches the configured one (the model
 * verified it itself), and a persisted gate verdict whose own verification run
 * passed. The last one is why a blocked-then-verified run settles on its next
 * boundary instead of running the command again.
 */
export function scanEditVerification(branch: readonly unknown[], options: EditScanOptions = {}): EditState {
	const calls = new Map<string, ToolCallRecord>();
	const edited = new Set<string>();
	let verificationRuns = 0;
	const wanted = options.verificationCommand?.trim() ? collapse(options.verificationCommand) : null;

	for (const item of branch) {
		if (!isRecord(item)) continue;
		if (item.type === "custom" && item.customType === GATE_ENTRY_TYPE && isRecord(item.data)) {
			if (isRecord(item.data.verification) && item.data.verification.status === "passed") {
				edited.clear();
				verificationRuns += 1;
			}
			continue;
		}
		if (item.type !== "message" || !isRecord(item.message)) continue;
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
		if (!SHELL_TOOLS.has(tool)) continue;
		const command = call?.arguments.command;
		const ranVerification = wanted
			? typeof command === "string" && collapse(command) === wanted
			: true;
		if (ranVerification) {
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
 * failures are not. This is evidence, not a verdict: it blocks a settlement only
 * when `block.repeatedFailure` is configured, and the mid-run loop breaker has
 * its own rules over calls rather than results.
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

// --- The decision function --------------------------------------------------

export interface GateEvaluationInput {
	outcome: string;
	/** Gate blocks recorded before this evaluation. */
	attempts: number;
	attemptCap: number;
	/** Which session's calls were visible. Defaults to `parent`. */
	scope?: "parent" | "child";
	activeGoal?: { id: string; objective: string } | null;
	openTodos?: OpenTodo[];
	edits?: EditState;
	failure?: FailureSignature | null;
	/** The gate's own verification run in this evaluation, if it ran one. */
	verification?: VerificationOutcome | null;
	/** The configured verification command, for the report when the gate did not
	 *  run it in this evaluation. */
	verificationCommand?: string | null;
	/** An override consumed by this evaluation. */
	override?: GateOverrideUse | null;
	/** Conditions the project allows to block, and those already spent. */
	policy?: GateBlockPolicy;
	/** Why blocking was not attempted at all (a child session, an outcome pi will
	 *  not continue after, a missing continuation). Reported, never silent. */
	suppressed?: string | null;
	/** Conditions that could not be evaluated, with the reason. */
	unevaluated?: string[];
	now?: number;
}

/** The pure decision function. No I/O, no clock, no pi API. */
export function evaluateGate(input: GateEvaluationInput): GateVerdict {
	const previousAttempts = Math.max(0, Math.floor(input.attempts));
	const attemptCap = Number.isFinite(input.attemptCap) && input.attemptCap >= 0 ? Math.floor(input.attemptCap) : 0;
	const scope = input.scope === "child" ? "child" : "parent";
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
	const verificationRuns = input.edits?.verificationRuns ?? 0;
	const verification = input.verification ?? null;
	if (editedFiles.length === 0) {
		conditions.push({
			kind: "verification",
			status: "clear",
			summary: `no unverified edits (${verificationRuns} successful verification run${verificationRuns === 1 ? "" : "s"} on this branch)`,
		});
	} else if (verificationFailedOpen(verification)) {
		// Fail-open: the command told us nothing, so the condition is unknown and
		// the run settles. This is the timeout/truncated/cannot-run path of R33.
		const summary = `${editedFiles.length} file${editedFiles.length === 1 ? "" : "s"} edited and verification could not be evaluated: ${verification?.summary ?? "no run"}`;
		conditions.push({ kind: "verification", status: "unknown", summary });
		reasons.push({
			code: "verification-fail-open",
			summary,
			details: { files: editedFiles, status: verification?.status ?? "unavailable" },
		});
	} else if (verification) {
		const passed = verification.status === "passed";
		const summary = passed
			? `${editedFiles.length} file${editedFiles.length === 1 ? "" : "s"} edited and the configured verification command passed: ${editedFiles.join(", ")}`
			: `${editedFiles.length} file${editedFiles.length === 1 ? "" : "s"} edited and the configured verification command failed (exit ${verification.exitCode}): ${editedFiles.join(", ")}`;
		conditions.push({ kind: "verification", status: "attention", summary });
		reasons.push({
			code: passed ? "verification-ran" : "verification-failed",
			summary,
			details: { files: editedFiles, command: verification.command, exitCode: verification.exitCode, status: verification.status },
		});
	} else {
		const target = input.verificationCommand?.trim() || null;
		const summary = `${editedFiles.length} file${editedFiles.length === 1 ? "" : "s"} edited since the last successful ${target ? `run of \`${target}\`` : "shell command"}: ${editedFiles.join(", ")} (${verificationRuns} verification run${verificationRuns === 1 ? "" : "s"} on this branch)`;
		conditions.push({ kind: "verification", status: "attention", summary });
		reasons.push({ code: "edits-without-verification", summary, details: { files: editedFiles, verificationRuns } });
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

	const policy: GateBlockPolicy = input.policy ?? { kinds: [], alreadyBlocked: [] };
	const alreadyBlocked = unique(policy.alreadyBlocked);
	const alreadyBlockedEvidence = policy.alreadyBlockedEvidence ?? {};
	/** What a kind reports right now; a change re-arms a kind that blocked before. */
	const evidenceFor = (kind: GateConditionKind): string => {
		if (kind === "todos") return openTodos.map((todo) => todo.id).sort().join(",");
		if (kind === "verification") return [...editedFiles].sort().join(",");
		if (kind === "failure") return failure?.signature ?? "";
		return "";
	};
	const candidates = conditions.filter(
		(condition) =>
			condition.status === "attention" &&
			policy.kinds.includes(condition.kind) &&
			// Blocked once per branch *per evidence*: the same set of open todos or
			// unverified edits cannot block twice, but a new edit or todo re-arms the
			// check. Without this the first block would make the check decorative —
			// edit once more and the next settlement passes unverified.
			(!alreadyBlocked.includes(condition.kind) ||
				alreadyBlockedEvidence[condition.kind] !== evidenceFor(condition.kind)),
	);

	const blockedBy: GateConditionKind[] = [];
	const blockedEvidenceNow: Partial<Record<GateConditionKind, string>> = {};
	let decision: GateDecision = "report";
	let attempts = previousAttempts;
	// An override is spent by the block it prevents, and only by that: one granted
	// while nothing is open stays pending for the settlement that needs it.
	const wouldBlock = candidates.length > 0 && previousAttempts < attemptCap;
	const override = input.override && wouldBlock && !input.suppressed ? input.override : null;

	if (input.suppressed) {
		reasons.push({ code: "blocking-suppressed", summary: input.suppressed });
	} else if (override) {
		reasons.push({
			code: "override-used",
			summary: `an override was granted and used instead of blocking: ${override.reason}`,
			details: { at: override.at },
		});
	} else if (candidates.length > 0) {
		if (previousAttempts >= attemptCap) {
			reasons.push({
				code: "attempt-cap-reached",
				summary: `no gate blocks remain on this branch (${previousAttempts} of ${attemptCap} used), so this settlement is not blocked`,
				details: { attempts: previousAttempts, attemptCap },
			});
		} else {
			decision = "continue";
			attempts = previousAttempts + 1;
			blockedBy.push(...candidates.map((condition) => condition.kind));
			for (const condition of candidates) blockedEvidenceNow[condition.kind] = evidenceFor(condition.kind);
			for (const condition of candidates) {
				reasons.push({
					code: "settlement-blocked",
					summary: `blocked settlement: ${condition.summary}`,
					details: { kind: condition.kind },
				});
			}
		}
	}

	const remainingAttempts = Math.max(0, attemptCap - attempts);
	if (attemptCap === 0) {
		// Blocking disabled by config: that is a setting, not a problem to report.
		conditions.push({ kind: "attempt", status: "clear", summary: "gate blocking is disabled (attemptCap 0)" });
	} else if (remainingAttempts === 0) {
		conditions.push({
			kind: "attempt",
			status: "attention",
			summary: `no gate blocks remain on this branch (${attempts} of ${attemptCap} used)`,
		});
	} else {
		conditions.push({
			kind: "attempt",
			status: "clear",
			summary: `${remainingAttempts} of ${attemptCap} gate blocks remain`,
		});
	}

	for (const note of input.unevaluated ?? []) {
		conditions.push({ kind: "unevaluated", status: "unknown", summary: note });
		reasons.push({ code: "unevaluated", summary: note });
	}

	const blockedConditions = unique([...alreadyBlocked, ...blockedBy]) as GateConditionKind[];
	const blockedEvidence: Partial<Record<GateConditionKind, string>> = { ...alreadyBlockedEvidence, ...blockedEvidenceNow };
	const reason =
		decision === "continue"
			? `the gate did not settle this run: ${candidates
					.map((condition) => condition.summary)
					.join("; ")}. Address it, or call \`${GATE_OVERRIDE_TOOL}\` with a reason to settle anyway; it will not block again unless what it reports changes.`
			: summarizeReport(candidates, alreadyBlocked, previousAttempts, attemptCap);

	return {
		version: GATE_VERSION,
		kind: conditions.some((condition) => condition.status !== "clear") ? "attention" : "clear",
		decision,
		outcome: input.outcome,
		at: input.now ?? Date.now(),
		scope,
		attempts,
		attemptCap,
		remainingAttempts,
		blockedBy,
		blockedConditions,
		blockedEvidence,
		verification,
		override,
		reason,
		reasons,
		conditions,
	};
}

function summarizeReport(
	candidates: GateCondition[],
	alreadyBlocked: GateConditionKind[],
	attempts: number,
	attemptCap: number,
): string {
	if (candidates.length === 0) {
		const spent = alreadyBlocked.length > 0 ? ` (already blocked on this branch: ${alreadyBlocked.join(", ")})` : "";
		return `the gate settled normally: nothing blocking is configured or open${spent}, ${attempts} of ${attemptCap} gate blocks used`;
	}
	return `the gate reported without blocking: ${candidates.map((condition) => condition.summary).join("; ")}`;
}

/** Human-readable form used by `/gate`. */
export function formatVerdict(verdict: GateVerdict): string {
	const action = verdict.decision === "continue" ? "BLOCKED SETTLEMENT" : "report-only";
	const lines = [
		`Orchestration gate: ${verdict.kind.toUpperCase()} (${action})`,
		`Attempt ${verdict.attempts} of ${verdict.attemptCap} gate blocks · ${verdict.remainingAttempts} remaining · outcome ${verdict.outcome}`,
		`Scope: ${verdict.scope === "child" ? "delegated child session (reports only; the parent decides)" : "this session's own tool calls — edits made by delegated children are not visible"}`,
	];
	if (verdict.reasons.length === 0) {
		lines.push("No open condition: no active goal, no open todos, no unverified edits, no repeated failure.");
	} else {
		lines.push("Reasons:");
		for (const reason of verdict.reasons) lines.push(`  - ${reason.summary}`);
	}
	if (verdict.verification) lines.push(`Verification: ${verdict.verification.summary}`);
	if (verdict.override) lines.push(`Override used: ${verdict.override.reason}`);
	const unknown = verdict.conditions.filter((condition) => condition.status === "unknown");
	if (unknown.length > 0) {
		lines.push("Unevaluated (reported, not blocking):");
		for (const condition of unknown) lines.push(`  - ${condition.summary}`);
	}
	return lines.join("\n");
}

/** Human-readable form of a loop decision, for `/gate`. */
export function formatLoopVerdict(verdict: LoopVerdict): string {
	return [
		`Orchestration gate: ${verdict.action === "block" ? "LOOP BLOCKED" : "LOOP OVERRIDDEN"}`,
		`${verdict.tool} ${verdict.invocation || "(no input)"} — ${verdict.kind === "repeated-failure" ? "the same failure" : "the same result"} ${verdict.count} times`,
		`Attempt ${verdict.attempts} of ${verdict.attemptCap} gate blocks · ${verdict.remainingAttempts} remaining · ${verdict.blocksTheTurn} block(s) this turn`,
		verdict.detail ? `Detail: ${verdict.detail}` : "",
	].filter(Boolean).join("\n");
}
