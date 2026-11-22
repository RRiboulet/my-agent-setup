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
 *     because it acts on every tool call rather than once per run.
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
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 300_000;
export const DEFAULT_VERIFICATION_MAX_OUTPUT_BYTES = 16_000;
/** A verification run longer than an hour is a configuration mistake. */
export const MAX_VERIFICATION_TIMEOUT_MS = 3_600_000;
/** Bounded on purpose: the output ends up in a model message. */
export const MAX_VERIFICATION_OUTPUT_BYTES = 1_048_576;
/** The ticket-08 spelling of `attemptCap`, honoured for the warning only. */
export const LEGACY_ATTEMPT_CAP_KEY = "retryCap";

/** The project's verification command, run by the gate at the settle boundary. */
export interface VerificationConfig {
	/** Shell command line, run non-interactively through `pi.exec`. */
	command: string;
	timeoutMs: number;
	/** Combined stdout/stderr byte cap, used as `pi.exec`'s `maxBuffer` and as
	 *  the bound on what reaches the continuation message. */
	maxOutputBytes: number;
}

/** Which conditions may stop a settlement. Every key defaults to `false`. */
export interface GateBlockConfig {
	openTodos: boolean;
	repeatedFailure: boolean;
	/** The tool-call loop breaker (no-progress evidence, not repetition). */
	loops: boolean;
}

export interface GateConfig {
	version: number;
	/** Gate blocks allowed on one branch. `0` disables blocking entirely. */
	attemptCap: number;
	block: GateBlockConfig;
	/** `null` means no command is configured: verification is only reported. */
	verification: VerificationConfig | null;
}

export interface GateConfigRead {
	config: GateConfig;
	source: "default" | "file";
	warning?: string;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
	version: GATE_CONFIG_VERSION,
	attemptCap: DEFAULT_ATTEMPT_CAP,
	block: { openTodos: false, repeatedFailure: false, loops: false },
	verification: null,
};

/** The committed project file this reader looks for. */
export function gateConfigPath(cwd: string): string {
	return join(cwd, ".pi", GATE_CONFIG_BASENAME);
}

function defaultConfig(): GateConfig {
	return {
		version: GATE_CONFIG_VERSION,
		attemptCap: DEFAULT_ATTEMPT_CAP,
		block: { ...DEFAULT_GATE_CONFIG.block },
		verification: null,
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
			warnings.push(`block.${key} must be a boolean; leaving it off`);
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
	return {
		verification: { command: command.trim(), timeoutMs: timeout.value, maxOutputBytes: output.value },
		warnings,
	};
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
	const block = normalizeBlock(record.block);
	const verification = normalizeVerification(record.verification);
	return {
		config: {
			version: GATE_CONFIG_VERSION,
			attemptCap: attempt.attemptCap,
			block: block.block,
			verification: verification.verification,
		},
		warnings: [...warnings, ...attempt.warnings, ...block.warnings, ...verification.warnings],
	};
}

/**
 * True when the config asks the gate to do anything beyond reporting.
 *
 * The override tool is registered only for such a project: every registered
 * tool's description rides on every request, and a project that never opts into
 * blocking should not pay for the escape hatch from a block it cannot get.
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
