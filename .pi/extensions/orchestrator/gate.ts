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
 *   * A condition that must be resolved keeps blocking while its evidence is
 *     unchanged: `blockedConditions` and `blockedEvidence` are carried in every
 *     verdict and reconstructed from the active branch. An open todo, a failed
 *     verification or a repeated failure therefore blocks again on the next
 *     settlement instead of becoming decorative. A passed verification is
 *     informational once, because there is nothing to fix. New evidence (a new
 *     edit, todo or failure) re-arms any condition.
 *   * `attemptCap` bounds settlement gate blocks on the branch, while
 *     `loopAttemptCap` separately bounds mid-run loop-breaker blocks so loop
 *     blocks never exhaust the settlement budget; each is the hard stop that
 *     keeps repeated blocks from trapping a run. `attempts` counts blocks, not
 *     evaluations: ticket 08's counter counted settles, so an active goal
 *     reached the cap on its third continuation with nothing having failed. The
 *     field is renamed for what it bounds and nothing else. Setting
 *     `attemptCap: 0` or `loopAttemptCap: 0` disables blocking for that gate
 *     without disabling reporting.
 *   * An override — the `orchestrator_override` tool — is consumed by the next
 *     block it prevents, including a repeated block on unchanged evidence. It
 *     spends no attempt and is named in every block reason.
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
import {
	classifyVerificationEvidence,
	detectWeakCommand,
	detectZeroTests,
	successPatternMatches,
	verificationFailedOpen,
	type VerificationOutcome,
} from "./verify.ts";
import { evaluateWaveGate, type WaveState } from "./wave.ts";

export const GATE_ENTRY_TYPE = "orchestrator-gate";
export const GATE_LOOP_ENTRY_TYPE = "orchestrator-gate-loop";
export const GATE_OVERRIDE_ENTRY_TYPE = "orchestrator-gate-override";
export const GATE_VERSION = 2;
/** The tool a block reason names, so a model has a mechanical way out. */
export const GATE_OVERRIDE_TOOL = "orchestrator_override";

const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FAILURE_WINDOW = 200;

export type GateConditionKind = "goal" | "todos" | "verification" | "failure" | "wave" | "attempt" | "unevaluated";
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
	 *  this verdict's. A kind whose condition must be resolved stays blockable
	 *  while its evidence is unchanged; the attempt cap and an override are the
	 *  ways a run settles without resolving it. */
	blockedConditions: GateConditionKind[];
	/** The evidence each blocked kind reported when it blocked. A kind re-arms
	 *  when its evidence changes — new unverified edits, a different set of open
	 *  todos, a different failure — so the model can fix the condition rather
	 *  than only overriding it. */
	blockedEvidence: Partial<Record<GateConditionKind, string>>;
	/** What the gate's own verification run did, when it ran one. */
	verification: VerificationOutcome | null;
	/** The override this verdict consumed, when one was pending. */
	override: GateOverrideUse | null;
	/** True when a would-be block was parked instead: no continuation, no attempt,
	 *  because a delegated run is still live. `decision` stays `report`. A park
	 *  yields the continuation field rather than claiming it, so another boundary
	 *  handler (the goal extension) may still request a turn; the park saves the
	 *  gate's attempt, not necessarily the turn. */
	parked: boolean;
	/** The live run ids that kept this settlement parked; empty when it did not
	 *  park (or when the live set was empty). */
	liveRuns: string[];
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
	/** Successful edit/write results on the branch, never cleared. This is what
	 *  makes evidence a *state* rather than a path set: editing the same file
	 *  again must re-arm verification. Optional for callers that only report. */
	editResults?: number;
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
	/** Kinds that already blocked on this branch. A kind whose condition must be
	 *  resolved stays blockable until its evidence changes, it is overridden, or
	 *  the attempt cap is reached. */
	alreadyBlocked: GateConditionKind[];
	/** Evidence each already-blocked kind reported, from `state.blockedEvidence`. */
	alreadyBlockedEvidence?: Partial<Record<GateConditionKind, string>>;
	/** Optional flag overrides; `wave` defaults to `true`. */
	block?: { wave?: boolean };
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
	if ((tool === "bash" || tool === "powershell") && typeof args.command === "string") return collapse(args.command);
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
	/** Settlement gate blocks recorded on this branch. */
	attempts: number;
	/** Mid-run loop-breaker blocks recorded on this branch. */
	loopAttempts: number;
	lastVerdict: GateVerdict | null;
	lastLoopVerdict: LoopVerdict | null;
	/** Union of every condition kind that has blocked on this branch. */
	blockedConditions: GateConditionKind[];
	/** Latest evidence per blocked kind (last entry wins, like `attempts`). */
	blockedEvidence: Partial<Record<GateConditionKind, string>>;
}

const CONDITION_KINDS: readonly GateConditionKind[] = ["goal", "todos", "verification", "failure", "wave", "attempt", "unevaluated"];

function conditionKinds(value: unknown): GateConditionKind[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is GateConditionKind => typeof item === "string" && CONDITION_KINDS.includes(item as GateConditionKind));
}

/**
 * Reconstruct the settlement and loop attempt budgets, the last verdicts and
 * the set of conditions that already blocked, from the active branch.
 *
 * The LAST entry of each gate type wins its own attempt count, exactly like
 * `goal.ts`'s reconstruction; the blocked-condition set is a union, because it is
 * monotone and a navigation to a branch before any block legitimately reports
 * none. A gate entry whose `attempts` cannot be read is skipped rather than
 * trusted, so a malformed entry cannot raise or reset a cap.
 */
export function reconstructGateState(branch: readonly unknown[]): GateState {
	let lastVerdict: GateVerdict | null = null;
	let lastLoopVerdict: LoopVerdict | null = null;
	let attempts = 0;
	let loopAttempts = 0;
	const blocked = new Set<GateConditionKind>();
	const blockedEvidence: Partial<Record<GateConditionKind, string>> = {};

	for (const item of branch) {
		if (!isRecord(item) || item.type !== "custom") continue;
		if (item.customType === GATE_LOOP_ENTRY_TYPE) {
			const loop = normalizePersistedLoop(item.data);
			if (!loop) continue;
			lastLoopVerdict = loop;
			loopAttempts = loop.attempts;
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
		loopAttempts,
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
		// A verdict written before parking existed is not parked; the live set is
		// a snapshot of one evaluation, never reconstructed as current state.
		parked: data.parked === true,
		liveRuns: Array.isArray(data.liveRuns)
			? data.liveRuns.filter((id): id is string => typeof id === "string")
			: [],
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
	/** The opt-in `verification.successPattern`: a matching command's output must
	 *  match it for the run to clear edits, including a persisted verdict's. */
	successPattern?: string | null;
}

/**
 * The exit code a tool result reported, when the host put one in `details`.
 * pi's `BashToolDetails` carries only truncation fields today, so this is the
 * forward-compatible read: when there is no number, the caller falls back to
 * `isError` as the failure signal.
 */
function exitCodeFromDetails(details: unknown): number | null {
	if (!isRecord(details)) return null;
	for (const key of ["exitCode", "code"] as const) {
		const value = details[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

/**
 * Is this evidence a real pass under the current rules?
 *
 * Shared by a model's own run of the configured command and by a persisted
 * verdict, because both can predate the `weak-command` and `inconclusive`
 * statuses: a stored `status: "passed"` is re-checked against today's rules
 * rather than trusted. A missing command or output is not evidence against the
 * run (an older verdict does not carry them); a configured pattern still has to
 * match.
 */
function evidenceIsRealPass(input: {
	status: unknown;
	command?: unknown;
	output?: unknown;
	successPattern?: string | null;
}): boolean {
	if (input.status !== "passed") return false;
	const command = typeof input.command === "string" ? input.command : "";
	const output = typeof input.output === "string" ? input.output : "";
	if (command && detectWeakCommand(command)) return false;
	if (output && detectZeroTests(output)) return false;
	return successPatternMatches(input.successPattern, output) !== false;
}

const SAFE_VERIFICATION_FLAGS = new Set([
	"-q",
	"--quiet",
	"-v",
	"--verbose",
	"-vv",
	"--tb=short",
	"--tb=line",
	"--no-header",
	"--color=no",
]);
const SAFE_REPORTER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LEADING_CD_PREFIX = /^cd\s+(?:"([^"$`\\;|&]+)"|'([^';|&]+)'|([^\s;|&<>`"$()]+))\s+&&\s+([\s\S]+)$/;

function hasOnlySafeVerificationFlags(tail: string): boolean {
	if (!tail) return true;
	const tokens = tail.split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i]!;
		if (SAFE_VERIFICATION_FLAGS.has(token)) continue;
		if (token.startsWith("--reporter=")) {
			if (!SAFE_REPORTER_VALUE.test(token.slice("--reporter=".length))) return false;
			continue;
		}
		if (token === "--reporter") {
			const next = tokens[i + 1];
			if (!next || !SAFE_REPORTER_VALUE.test(next)) return false;
			i += 1;
			continue;
		}
		return false;
	}
	return true;
}

function matchesVerificationCommand(command: string, wantedFull: string): boolean {
	let rest = command.trim();
	const cdMatch = LEADING_CD_PREFIX.exec(rest);
	if (cdMatch) rest = cdMatch[4]!.trim();
	const normalizedRest = rest.replace(/\s+/g, " ").trim();
	if (normalizedRest === wantedFull) return true;
	if (!normalizedRest.startsWith(`${wantedFull} `)) return false;
	const tail = normalizedRest.slice(wantedFull.length).trim();
	return hasOnlySafeVerificationFlags(tail);
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
 *
 * A green exit status is not enough for the second and third. The result's own
 * text is classified with the same rules as the gate's run — a weak command, a
 * zero-test report, a configured `successPattern` that does not match — and only
 * a real pass clears the edits. Nobody read the model's output before this, so a
 * matching call that printed `0 passing` used to count as verification.
 */
export function scanEditVerification(branch: readonly unknown[], options: EditScanOptions = {}): EditState {
	const calls = new Map<string, ToolCallRecord>();
	const edited = new Set<string>();
	let verificationRuns = 0;
	let editResults = 0;
	const wantedRaw = options.verificationCommand?.trim() ?? "";
	const wantedFull = wantedRaw ? wantedRaw.replace(/\s+/g, " ").trim() : null;
	const successPattern = options.successPattern ?? null;

	const recordToolOutcome = (
		tool: string,
		args: Record<string, unknown> | undefined,
		outcome: { isError: boolean; exitCode: number | null; output: string; requireOutputForVerification?: boolean },
	): void => {
		if (EDIT_TOOLS.has(tool)) {
			if (outcome.isError) return;
			const path = args?.path;
			edited.add(typeof path === "string" && path.trim() ? path : "(unknown file)");
			editResults += 1;
			return;
		}
		if (!SHELL_TOOLS.has(tool)) return;
		if (outcome.isError) return;
		if (outcome.exitCode !== null && outcome.exitCode !== 0) return;
		const command = args?.command;
		if (typeof command !== "string") return;
		if (wantedFull && outcome.requireOutputForVerification && !outcome.output.trim()) return;
		const ranVerification = wantedFull ? matchesVerificationCommand(command, wantedFull) : true;
		if (!ranVerification) return;
		const evidence = classifyVerificationEvidence({
			result: {
				code: outcome.exitCode ?? 0,
				stdout: outcome.output,
				stderr: "",
				killed: false,
				truncated: false,
			},
			command,
			output: outcome.output,
			successPattern: wantedFull ? successPattern : null,
		});
		if (evidence.status !== "passed") return;
		edited.clear();
		verificationRuns += 1;
	};

	for (const item of branch) {
		if (!isRecord(item)) continue;
		if (item.type === "custom" && item.customType === GATE_ENTRY_TYPE && isRecord(item.data)) {
			const stored = isRecord(item.data.verification) ? item.data.verification : null;
			if (
				stored &&
				evidenceIsRealPass({
					status: stored.status,
					command: stored.command,
					output: stored.output,
					successPattern,
				})
			) {
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
		if (message.role !== "toolResult") continue;
		if (isRecord(message.nestedCalls) && Array.isArray(message.nestedCalls.calls)) {
			for (const nested of message.nestedCalls.calls) {
				if (!isRecord(nested) || typeof nested.name !== "string") continue;
				const nestedOutput =
					typeof nested.output === "string"
						? nested.output
						: typeof nested.stdout === "string"
							? nested.stdout
							: "";
				recordToolOutcome(nested.name, isRecord(nested.arguments) ? nested.arguments : undefined, {
					isError: nested.status !== "ok",
					exitCode: null,
					output: nestedOutput,
					requireOutputForVerification: true,
				});
			}
		}
		const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
		const tool = typeof message.toolName === "string" ? message.toolName : call?.name;
		if (!tool) continue;
		recordToolOutcome(tool, call?.arguments, {
			isError: message.isError === true,
			exitCode: exitCodeFromDetails(message.details),
			output: textFromContent(message.content),
		});
	}

	return { editedFiles: [...edited].sort(), verificationRuns, editResults };
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

	const recordFailure = (tool: string, args: Record<string, unknown> | undefined, errorText: string): void => {
		const invocation = describeInvocation(tool, args);
		const detail = firstLine(errorText);
		const signature = `${tool}|${invocation}|${detail}`;
		const current = counts.get(signature);
		if (current) current.count += 1;
		else counts.set(signature, { signature, count: 1, tool, detail });
	};

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
		if (message.role !== "toolResult") continue;
		if (isRecord(message.nestedCalls) && Array.isArray(message.nestedCalls.calls)) {
			for (const nested of message.nestedCalls.calls) {
				if (!isRecord(nested) || nested.status !== "error" || typeof nested.name !== "string") continue;
				recordFailure(
					nested.name,
					isRecord(nested.arguments) ? nested.arguments : undefined,
					typeof nested.error === "string" ? nested.error : "",
				);
			}
		}
		if (message.isError !== true) continue;
		const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
		const tool = typeof message.toolName === "string" ? message.toolName : call?.name ?? "tool";
		recordFailure(tool, call?.arguments, textFromContent(message.content));
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
	/** Delegated runs still live when this settlement was evaluated. Combined with
	 *  `waitForSubagents`, a would-be block is parked instead of spent. */
	liveRuns?: string[];
	/** The project opted into parking on live delegated runs (`block.waitForSubagents`). */
	waitForSubagents?: boolean;
	/** Conditions the project allows to block, and those already spent. */
	policy?: GateBlockPolicy;
	/** Active or terminal wave state from the branch, if any. */
	wave?: WaveState | null;
	/** Why blocking was not attempted at all (a child session, an outcome pi will
	 *  not continue after, a missing continuation). Reported, never silent. */
	suppressed?: string | null;
	/** Conditions that could not be evaluated, with the reason. */
	unevaluated?: string[];
	now?: number;
}

export type EvaluateGateInput = GateEvaluationInput;

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
	const editResults = input.edits?.editResults ?? 0;
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

	const waveGate = evaluateWaveGate(input.wave ?? null);
	if (waveGate) {
		conditions.push({ kind: "wave", status: "attention", summary: waveGate.summary });
		reasons.push({
			code: "wave-active",
			summary: waveGate.summary,
			details: { folder: input.wave!.folder, unfinishedIds: waveGate.unfinishedIds },
		});
	} else {
		conditions.push({ kind: "wave", status: "clear", summary: "no active wave with unfinished tickets" });
	}

	const policy: GateBlockPolicy = input.policy ?? { kinds: [], alreadyBlocked: [] };
	const alreadyBlocked = unique(policy.alreadyBlocked);
	const alreadyBlockedEvidence = policy.alreadyBlockedEvidence ?? {};
	/** What a kind reports right now; a change re-arms a kind that blocked before. */
	const evidenceFor = (kind: GateConditionKind): string => {
		if (kind === "todos") return openTodos.map((todo) => todo.id).sort().join(",");
		// The edit count is part of the state: re-editing the same file is new
		// evidence and must re-run the command, while an unchanged state must not.
		if (kind === "verification") return `${[...editedFiles].sort().join(",")}#${editResults}`;
		if (kind === "failure") return failure?.signature ?? "";
		if (kind === "wave") return waveGate?.evidence ?? "";
		return "";
	};
	/**
	 * A condition that represents a problem blocks until it is resolved or the
	 * override settles it; a passed verification is informational and blocks at
	 * most once for the same evidence. Without the second rule a passing
	 * verification would keep blocking until the attempt cap, because its
	 * condition never has anything to "fix".
	 */
	const informationalOnce = (kind: GateConditionKind): boolean => kind === "verification" && verification?.status === "passed";
	const waveBlockingEnabled = policy.block?.wave !== false;
	const candidates = conditions.filter(
		(condition) =>
			condition.status === "attention" &&
			(condition.kind === "wave" ? waveBlockingEnabled : policy.kinds.includes(condition.kind)) &&
			// Same evidence blocks again for a condition that must be resolved —
			// that is what makes `orchestrator_override` necessary rather than
			// decorative. A new edit, todo or failure also re-arms it via evidence.
			(!alreadyBlocked.includes(condition.kind) ||
				alreadyBlockedEvidence[condition.kind] !== evidenceFor(condition.kind) ||
				!informationalOnce(condition.kind)),
	);

	const blockedBy: GateConditionKind[] = [];
	const blockedEvidenceNow: Partial<Record<GateConditionKind, string>> = {};
	let decision: GateDecision = "report";
	let attempts = previousAttempts;
	// An override is spent by the block it prevents, and only by that: one granted
	// while nothing is open stays pending for the settlement that needs it.
	const wouldBlock = candidates.length > 0 && previousAttempts < attemptCap;
	const override = input.override && wouldBlock && !input.suppressed ? input.override : null;
	// A live delegated run means the work is not finished, so a block would ask the
	// model to act on information it does not have yet — and spend an attempt doing
	// it. Park instead: no continuation, no attempt, and the ids in the verdict.
	// Deliberately independent of `alreadyBlocked`: the point is not to spend
	// another attempt on the same unchanged condition.
	const liveRuns = unique((input.liveRuns ?? []).filter((id): id is string => typeof id === "string" && id.trim().length > 0));
	const parked =
		input.waitForSubagents === true &&
		liveRuns.length > 0 &&
		candidates.length > 0 &&
		!input.suppressed &&
		!override &&
		previousAttempts < attemptCap;

	if (input.suppressed) {
		reasons.push({ code: "blocking-suppressed", summary: input.suppressed });
	} else if (override) {
		reasons.push({
			code: "override-used",
			summary: `an override was granted and used instead of blocking: ${override.reason}`,
			details: { at: override.at },
		});
	} else if (parked) {
		reasons.push({
			code: "settlement-parked",
			summary: `parked the settlement rather than blocking it: ${candidates
				.map((condition) => condition.summary)
				.join("; ")}; waiting for the live delegated run${liveRuns.length === 1 ? "" : "s"} ${liveRuns.join(", ")}`,
			details: { kinds: candidates.map((condition) => condition.kind), liveRuns },
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
	const reason = parked
		? `the gate parked this settlement rather than blocking it: ${candidates
				.map((condition) => condition.summary)
				.join("; ")}. ${liveRuns.length === 1 ? "A delegated run is" : "Delegated runs are"} still live (${liveRuns.join(", ")}), so the model has nothing to act on yet; it is woken once when the last one settles. No gate block was spent (${attempts} of ${attemptCap} gate blocks used).`
		: decision === "continue"
			? `the gate did not settle this run: ${candidates
					.map((condition) => condition.summary)
					.join("; ")}. Address it, or call \`${GATE_OVERRIDE_TOOL}\` with a reason to settle anyway; it will block again until the condition changes, is overridden, or the attempt budget runs out (${attempts} of ${attemptCap} gate blocks used).`
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
		parked,
		liveRuns: parked ? liveRuns : [],
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
	if (verdict.parked) {
		lines.push(
			`Parked: waiting for the live delegated run${verdict.liveRuns.length === 1 ? "" : "s"} ${verdict.liveRuns.join(", ")} — no gate block was spent; the parent is woken once when the last one settles.`,
		);
	}
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
