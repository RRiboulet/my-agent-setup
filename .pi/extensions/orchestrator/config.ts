/**
 * Per-project settlement-gate configuration.
 *
 * Why a committed file rather than `.pi/settings.json`: this repository
 * gitignores its own settings file, and pi's `Settings` surface is a closed
 * typed set that rejects unknown keys. A project that wants to change gate
 * behaviour therefore commits a small file of its own. The path is
 * `<project>/.pi/orchestrator.json`; `.pi/extensions/orchestrator/` ships
 * `orchestrator.example.json` beside this reader so the shape is discoverable
 * without reading the code.
 *
 * Absence means report-only: the gate records a verdict and never blocks,
 * continues or runs a command. Blocking checks are opt-in, one key each:
 *
 *   * `block.openTodos` turns an open todo into a settlement block;
 *   * `block.repeatedFailure` turns a repeated failure signature into one;
 *   * `verification.command` is the project's own verification command. Setting
 *     it both enables the edits-without-verification block and says what to run,
 *     because a command that exists only to be reported would be a second way of
 *     spelling the same intent;
 *   * `block.loops` enables the tool-call loop breaker, which is off by default
 *     because it acts on every tool call rather than once per run;
 *   * `block.waitForSubagents` parks a would-be block while a delegated run is
 *     live, so the parent is not woken into a race it cannot win. Off by default,
 *     and deliberately not a blocking check of its own: parking needs another
 *     condition to be meaningful;
 *   * `advisor` configures one bounded second opinion from a stronger model when
 *     the gate keeps failing the same way or a loop was broken. It is off by
 *     default and separate from `block`, because it is not a blocking check: it
 *     spends tokens on a model call rather than deciding whether to settle.
 *
 * `workspace.lockScope` is not a gate key at all; it lives in the same file
 * because a project already commits one. It decides whether workspace
 * reservations are compared as absolute paths ("worktree", the default, so
 * linked worktrees never collide) or as repository-relative paths in the shared
 * repository root ("repo").
 *
 * **What committing this file means.** It opts the checkout into running
 * `verification.command` at settlement, with the user's permissions. That is why
 * the gate acts only in a TRUSTED project (`ctx.isProjectTrusted()`): this
 * extension ships as a user-level package and therefore also loads in a clone pi
 * has never trusted, where the file came from whoever wrote the repository. An
 * untrusted project is reported as suppressed and nothing is read from it.
 *
 * `attemptCap` is the budget for gate blocks on one branch, not for settle
 * events. Ticket 08 called it `retryCap` while it counted every evaluation; that
 * counter reached the cap on an active goal's third continuation with nothing
 * having failed. It is renamed here because a key that shipped with no users is
 * still a key without users, and because the number now bounds exactly the
 * actions the gate takes. `retryCap` is still honoured, with a warning, so a
 * config written against the ticket-08 build keeps its value.
 *
 * A malformed file is not fatal. The reader returns the defaults plus one
 * warning, and the gate reports the warning as an unevaluated condition, so a
 * project with a typo gets a visible note rather than a trapped session.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GATE_CONFIG_BASENAME = "orchestrator.json";
export const GATE_CONFIG_VERSION = 1;
export const DEFAULT_ATTEMPT_CAP = 3;
export const DEFAULT_LOOP_ATTEMPT_CAP = 3;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 300_000;
export const DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES = 16_000;
/** A verification run longer than an hour is a configuration mistake. */
export const MAX_VERIFICATION_TIMEOUT_MS = 3_600_000;
/** Bounded on purpose: the output ends up in a model message. */
export const MAX_VERIFICATION_OUTPUT_BYTES = 1_048_576;
/** A success pattern is compiled and echoed in the verdict; 512 characters is
 *  already longer than any runner summary it needs to match. */
export const MAX_VERIFICATION_SUCCESS_PATTERN_LENGTH = 512;
/** The ticket-08 spelling of `attemptCap`, honoured for the warning only. */
export const LEGACY_ATTEMPT_CAP_KEY = "retryCap";

// --- Workspace -------------------------------------------------------------

/**
 * Which namespace a reservation's paths are compared in.
 *
 * `"worktree"` keeps the canonical absolute path, so the main checkout and a
 * linked worktree never collide: branch-isolated agents may touch the same
 * repository-relative file in different trees. `"repo"` maps a reservation into
 * the shared repository root instead, so the same relative path is one claim
 * across every linked worktree. The default reproduces the behaviour that
 * shipped before this key existed.
 */
export type LockScope = "worktree" | "repo";

/** The workspace-coordination keys this file carries (they are not gate blocks). */
export interface WorkspaceConfig {
	lockScope: LockScope;
}

// --- Advisor --------------------------------------------------------------

/** Ten minutes: long enough that one stuck run cannot buy several opinions. */
export const DEFAULT_ADVISOR_COOLDOWN_MS = 600_000;
export const MAX_ADVISOR_COOLDOWN_MS = 86_400_000;
/** Recorded attempts per branch, refusals included. `0` disables the advisor. */
export const DEFAULT_ADVISOR_BUDGET = 2;
export const MAX_ADVISOR_BUDGET = 20;
/** Settlement blocks reporting the same conditions before a repeat is a trigger. */
export const DEFAULT_ADVISOR_MIN_GATE_BLOCKS = 2;
export const MAX_ADVISOR_MIN_GATE_BLOCKS = 10;
/** The consultation is awaited at run start, so a slow provider delays the
 *  first token; five minutes is the most that can be called bounded. */
export const DEFAULT_ADVISOR_TIMEOUT_MS = 60_000;
export const MAX_ADVISOR_TIMEOUT_MS = 300_000;

/** The project's verification command, run by the gate at the settle boundary. */
export interface VerificationConfig {
	/** Shell command line, run non-interactively through `pi.exec`. */
	command: string;
	timeoutMs: number;
	/** Combined stdout/stderr byte cap, used as `pi.exec`'s `maxBuffer` and as
	 *  the bound on what reaches the continuation message. */
	maxOutputBytes: number;
	/** Opt-in regular expression the bounded output must match for a run to count
	 *  as `passed`. `null` means the exit code (qualified by the weak-command and
	 *  zero-test checks) is the whole story. */
	successPattern: string | null;
}

/** Which conditions may stop a settlement. Every opt-in key defaults to
 *  `false`; `wave` defaults to `true` so an active wave cannot silently settle
 *  early unless a project disables it. */
export interface GateBlockConfig {
	openTodos: boolean;
	repeatedFailure: boolean;
	/** The tool-call loop breaker (no-progress evidence, not repetition). */
	loops: boolean;
	/** Park a would-be block while a delegated run is live, instead of spending
	 *  an attempt on a turn with nothing new to act on. The parent is woken once
	 *  when the last run settles. */
	waitForSubagents: boolean;
	/** Block settlement when an active wave still has unfinished tickets. */
	wave: boolean;
}

/**
 * One bounded second opinion from a stronger model.
 *
 * A separate top-level key rather than part of `block`: this does not decide
 * whether a run settles, it spends a model call. Absent means off, which is the
 * default — the advisor is the only part of this extension that costs money by
 * itself. `budget` is the number of recorded attempts (calls and refusals alike)
 * allowed on one branch, and `minGateBlocks` is how many settlement blocks must
 * report the same conditions before they count as a repeated failure.
 *
 * `redact` filters the documented credential shapes out of every field the
 * digest keeps; it is on unless a project turns it off. `fallback` names one
 * other provider/model, used only when the primary call fails with a provider
 * error — never for a credential refusal or an abort, which are configuration
 * facts rather than outages.
 */
export interface AdvisorFallback {
	provider: string;
	model: string;
}

export interface AdvisorConfig {
	provider: string;
	model: string;
	cooldownMs: number;
	budget: number;
	minGateBlocks: number;
	timeoutMs: number;
	/** Redact credential shapes from the digest's retained fields. Default true. */
	redact: boolean;
	/** `null` means no fallback: a failed call is reported and not retried. */
	fallback: AdvisorFallback | null;
}

export interface GateConfig {
	version: number;
	/** Settlement gate blocks allowed on one branch. `0` disables settlement blocking entirely. */
	attemptCap: number;
	/** Mid-run loop-breaker blocks allowed on one branch. `0` disables loop blocking entirely. */
	loopAttemptCap: number;
	block: GateBlockConfig;
	/** `null` means no command is configured: verification is only reported. */
	verification: VerificationConfig | null;
	/** `null` means no second opinion is configured. */
	advisor: AdvisorConfig | null;
	/**
	 * Reservation keys. Not a gate block: it changes where a workspace claim is
	 * compared, and `gateConfigCanAct` ignores it because it neither blocks a
	 * settlement nor runs a command.
	 */
	workspace: WorkspaceConfig;
}

export interface GateConfigRead {
	config: GateConfig;
	source: "default" | "file";
	warning?: string;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
	version: GATE_CONFIG_VERSION,
	attemptCap: DEFAULT_ATTEMPT_CAP,
	loopAttemptCap: DEFAULT_LOOP_ATTEMPT_CAP,
	block: { openTodos: false, repeatedFailure: false, loops: false, waitForSubagents: false, wave: true },
	verification: null,
	advisor: null,
	workspace: { lockScope: "worktree" },
};

/** The committed project file this reader looks for. */
export function gateConfigPath(cwd: string): string {
	return join(cwd, ".pi", GATE_CONFIG_BASENAME);
}

function defaultConfig(): GateConfig {
	return {
		version: GATE_CONFIG_VERSION,
		attemptCap: DEFAULT_ATTEMPT_CAP,
		loopAttemptCap: DEFAULT_LOOP_ATTEMPT_CAP,
		block: { ...DEFAULT_GATE_CONFIG.block },
		verification: null,
		advisor: null,
		workspace: { ...DEFAULT_GATE_CONFIG.workspace },
	};
}

function normalizeAttemptCap(record: Record<string, unknown>): { attemptCap: number; warnings: string[] } {
	const warnings: string[] = [];
	const value = record.attemptCap ?? record[LEGACY_ATTEMPT_CAP_KEY];
	if (value === undefined) return { attemptCap: DEFAULT_ATTEMPT_CAP, warnings };
	if (record.attemptCap === undefined && record[LEGACY_ATTEMPT_CAP_KEY] !== undefined) {
		warnings.push(`${LEGACY_ATTEMPT_CAP_KEY} was renamed attemptCap; honouring the old key`);
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		return { attemptCap: DEFAULT_ATTEMPT_CAP, warnings: [...warnings, `attemptCap must be a non-negative integer; using ${DEFAULT_ATTEMPT_CAP}`] };
	}
	return { attemptCap: value, warnings };
}

function normalizeLoopAttemptCap(record: Record<string, unknown>): { loopAttemptCap: number; warnings: string[] } {
	const warnings: string[] = [];
	const value = record.loopAttemptCap;
	if (value === undefined) return { loopAttemptCap: DEFAULT_LOOP_ATTEMPT_CAP, warnings };
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		return {
			loopAttemptCap: DEFAULT_LOOP_ATTEMPT_CAP,
			warnings: [`loopAttemptCap must be a non-negative integer; using ${DEFAULT_LOOP_ATTEMPT_CAP}`],
		};
	}
	return { loopAttemptCap: value, warnings };
}

function normalizeBlock(raw: unknown): { block: GateBlockConfig; warnings: string[] } {
	const block = { ...DEFAULT_GATE_CONFIG.block };
	const warnings: string[] = [];
	if (raw === undefined) return { block, warnings };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { block, warnings: ["block must be an object; every blocking check stays off"] };
	}
	const record = raw as Record<string, unknown>;
	for (const key of Object.keys(block) as (keyof GateBlockConfig)[]) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			warnings.push(`block.${key} must be a boolean; leaving it ${block[key] ? "on" : "off"}`);
			continue;
		}
		block[key] = value;
	}
	return { block, warnings };
}

function positiveInteger(value: unknown, fallback: number, max: number, name: string): { value: number; warning?: string } {
	if (value === undefined) return { value: fallback };
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
		return { value: fallback, warning: `${name} must be a positive integer; using ${fallback}` };
	}
	if (value > max) return { value: max, warning: `${name} is capped at ${max}; using ${max}` };
	return { value };
}

/** Like {@link positiveInteger}, but 0 is a valid value (it means "disabled"). */
function nonNegativeInteger(value: unknown, fallback: number, max: number, name: string): { value: number; warning?: string } {
	if (value === undefined) return { value: fallback };
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		return { value: fallback, warning: `${name} must be a non-negative integer; using ${fallback}` };
	}
	if (value > max) return { value: max, warning: `${name} is capped at ${max}; using ${max}` };
	return { value };
}

/**
 * Validate the opt-in success pattern. A pattern that does not compile is not a
 * pattern: it is dropped with a warning rather than left to throw at settlement,
 * where a bad regex in a committed file would become a trapped session.
 */
function normalizeSuccessPattern(value: unknown): { value: string | null; warning?: string } {
	if (value === undefined || value === null) return { value: null };
	if (typeof value !== "string") {
		return { value: null, warning: "verification.successPattern must be a string; no pattern is configured" };
	}
	const pattern = value.trim();
	if (!pattern) return { value: null };
	if (pattern.length > MAX_VERIFICATION_SUCCESS_PATTERN_LENGTH) {
		return {
			value: null,
			warning: `verification.successPattern longer than ${MAX_VERIFICATION_SUCCESS_PATTERN_LENGTH} characters; no pattern is configured`,
		};
	}
	try {
		new RegExp(pattern);
	} catch (error) {
		return {
			value: null,
			warning: `verification.successPattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)}); no pattern is configured`,
		};
	}
	return { value: pattern };
}

function normalizeVerification(raw: unknown): { verification: VerificationConfig | null; warnings: string[] } {
	const warnings: string[] = [];
	if (raw === undefined || raw === null) return { verification: null, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { verification: null, warnings: ["verification must be an object; no command is configured"] };
	}
	const record = raw as Record<string, unknown>;
	const command = record.command;
	if (typeof command !== "string" || !command.trim()) {
		return { verification: null, warnings: ["verification.command must be a non-empty string; no command is configured"] };
	}
	const timeout = positiveInteger(
		record.timeoutMs,
		DEFAULT_VERIFICATION_TIMEOUT_MS,
		MAX_VERIFICATION_TIMEOUT_MS,
		"verification.timeoutMs",
	);
	const output = positiveInteger(
		record.maxOutputBytes,
		DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES,
		MAX_VERIFICATION_OUTPUT_BYTES,
		"verification.maxOutputBytes",
	);
	if (timeout.warning) warnings.push(timeout.warning);
	if (output.warning) warnings.push(output.warning);
	const successPattern = normalizeSuccessPattern(record.successPattern);
	if (successPattern.warning) warnings.push(successPattern.warning);
	return {
		verification: {
			command: command.trim(),
			timeoutMs: timeout.value,
			maxOutputBytes: output.value,
			successPattern: successPattern.value,
		},
		warnings,
	};
}

/**
 * The fallback is validated exactly like the primary: two non-empty keys, or no
 * fallback and a warning. A one-key object is a typo, not an intent, and a
 * guessed model would be a second bill nobody asked for.
 */
function normalizeAdvisorFallback(raw: unknown): { fallback: AdvisorFallback | null; warning?: string } {
	if (raw === undefined || raw === null) return { fallback: null };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { fallback: null, warning: "advisor.fallback must be an object; no fallback model is configured" };
	}
	const record = raw as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const model = typeof record.model === "string" ? record.model.trim() : "";
	if (!provider || !model) {
		return {
			fallback: null,
			warning: "advisor.fallback.provider and advisor.fallback.model must both be non-empty strings; no fallback model is configured",
		};
	}
	return { fallback: { provider, model } };
}

/**
 * Validate the advisor block. A model is two keys rather than one
 * `provider/model` string because model ids contain slashes of their own; a
 * half-configured advisor is off, with a warning, rather than a guess.
 */
function normalizeAdvisor(raw: unknown): { advisor: AdvisorConfig | null; warnings: string[] } {
	const warnings: string[] = [];
	if (raw === undefined || raw === null) return { advisor: null, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { advisor: null, warnings: ["advisor must be an object; no second opinion is configured"] };
	}
	const record = raw as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const model = typeof record.model === "string" ? record.model.trim() : "";
	if (!provider || !model) {
		return {
			advisor: null,
			warnings: ["advisor.provider and advisor.model must both be non-empty strings; no second opinion is configured"],
		};
	}
	const cooldown = positiveInteger(record.cooldownMs, DEFAULT_ADVISOR_COOLDOWN_MS, MAX_ADVISOR_COOLDOWN_MS, "advisor.cooldownMs");
	const budget = nonNegativeInteger(record.budget, DEFAULT_ADVISOR_BUDGET, MAX_ADVISOR_BUDGET, "advisor.budget");
	const minGateBlocks = positiveInteger(
		record.minGateBlocks,
		DEFAULT_ADVISOR_MIN_GATE_BLOCKS,
		MAX_ADVISOR_MIN_GATE_BLOCKS,
		"advisor.minGateBlocks",
	);
	const timeout = positiveInteger(record.timeoutMs, DEFAULT_ADVISOR_TIMEOUT_MS, MAX_ADVISOR_TIMEOUT_MS, "advisor.timeoutMs");
	for (const result of [cooldown, budget, minGateBlocks, timeout]) {
		if (result.warning) warnings.push(result.warning);
	}
	// Redaction is on by default: a key that shipped off would leak the one thing
	// it exists to catch. Only an explicit `false` turns it off.
	let redact = true;
	if (record.redact !== undefined) {
		if (typeof record.redact === "boolean") redact = record.redact;
		else warnings.push("advisor.redact must be a boolean; using true");
	}
	const fallback = normalizeAdvisorFallback(record.fallback);
	if (fallback.warning) warnings.push(fallback.warning);
	return {
		advisor: {
			provider,
			model,
			cooldownMs: cooldown.value,
			budget: budget.value,
			minGateBlocks: minGateBlocks.value,
			timeoutMs: timeout.value,
			redact,
			fallback: fallback.fallback,
		},
		warnings,
	};
}

/**
 * Validate the workspace block. A value this build does not know is the
 * default with a warning, never a guess: a misspelled scope must not silently
 * widen a project's lock from one worktree to the whole repository.
 */
function normalizeWorkspace(raw: unknown): { workspace: WorkspaceConfig; warnings: string[] } {
	const workspace: WorkspaceConfig = { ...DEFAULT_GATE_CONFIG.workspace };
	const warnings: string[] = [];
	if (raw === undefined) return { workspace, warnings };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { workspace, warnings: ["workspace must be an object; reservations stay worktree-scoped"] };
	}
	const value = (raw as Record<string, unknown>).lockScope;
	if (value === undefined) return { workspace, warnings };
	if (typeof value !== "string") {
		return { workspace, warnings: ["workspace.lockScope must be \"worktree\" or \"repo\"; using \"worktree\""] };
	}
	if (value !== "worktree" && value !== "repo") {
		return { workspace, warnings: [`workspace.lockScope must be \"worktree\" or \"repo\"; ignoring ${JSON.stringify(value)}`] };
	}
	return { workspace: { lockScope: value }, warnings };
}

/**
 * Validate a parsed config object. Unknown keys are ignored deliberately: a
 * newer project may commit a key this build does not know.
 */
export function normalizeGateConfig(raw: unknown): { config: GateConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config: defaultConfig(), warnings: ["the config file must contain a JSON object"] };
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== undefined && record.version !== GATE_CONFIG_VERSION) {
		warnings.push(`unsupported config version ${String(record.version)}; using known fields`);
	}
	const attempt = normalizeAttemptCap(record);
	const loopAttempt = normalizeLoopAttemptCap(record);
	const block = normalizeBlock(record.block);
	const verification = normalizeVerification(record.verification);
	const advisor = normalizeAdvisor(record.advisor);
	const workspace = normalizeWorkspace(record.workspace);
	return {
		config: {
			version: GATE_CONFIG_VERSION,
			attemptCap: attempt.attemptCap,
			loopAttemptCap: loopAttempt.loopAttemptCap,
			block: block.block,
			verification: verification.verification,
			advisor: advisor.advisor,
			workspace: workspace.workspace,
		},
		warnings: [
			...warnings,
			...attempt.warnings,
			...loopAttempt.warnings,
			...block.warnings,
			...verification.warnings,
			...advisor.warnings,
			...workspace.warnings,
		],
	};
}

/**
 * True when the config asks the gate to do anything beyond reporting.
 *
 * The override tool is registered only for such a project: every registered
 * tool's description rides on every request, and a project that never opts into
 * blocking should not pay for the escape hatch from a block it cannot get. The
 * advisor is deliberately excluded: it reacts to blocks rather than making one,
 * and a config that only asks for a second opinion has nothing to override.
 * `workspace` is excluded for the same reason: it scopes reservations, and a
 * project that only sets it still has nothing for the gate to block on.
 */
export function gateConfigCanAct(config: GateConfig): boolean {
	return config.verification !== null || config.block.openTodos || config.block.repeatedFailure || config.block.loops;
}

/**
 * Read the project config. Called from the settlement boundary (and, for the
 * loop breaker, once per session and then cached), so an idle session performs
 * no file read.
 */
export function readGateConfig(cwd: string): GateConfigRead {
	const path = gateConfigPath(cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { config: defaultConfig(), source: "default" };
		return {
			config: defaultConfig(),
			source: "default",
			warning: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			config: defaultConfig(),
			source: "default",
			warning: `${GATE_CONFIG_BASENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const { config, warnings } = normalizeGateConfig(parsed);
	return {
		config,
		source: "file",
		...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
	};
}
