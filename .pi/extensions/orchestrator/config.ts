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
 * Absence means report-only, and in this ticket report-only is the only mode:
 * the gate records a verdict and never blocks or continues. `retryCap` is
 * evaluated and reported now; the action half (blocking checks, verification
 * commands, the override) arrives in the next ticket and will add keys here.
 *
 * A malformed file is not fatal. The reader returns the defaults plus one
 * warning, and the gate reports the warning as an unevaluated condition, so a
 * project with a typo gets a visible note rather than a trapped session.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const GATE_CONFIG_BASENAME = "orchestrator.json";
export const GATE_CONFIG_VERSION = 1;
export const DEFAULT_RETRY_CAP = 3;

export interface GateConfig {
	version: number;
	retryCap: number;
}

export interface GateConfigRead {
	config: GateConfig;
	source: "default" | "file";
	warning?: string;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
	version: GATE_CONFIG_VERSION,
	retryCap: DEFAULT_RETRY_CAP,
};

/** The committed project file this reader looks for. */
export function gateConfigPath(cwd: string): string {
	return join(cwd, ".pi", GATE_CONFIG_BASENAME);
}

function normalizeRetryCap(value: unknown): { retryCap: number; warning?: string } {
	if (value === undefined) return { retryCap: DEFAULT_RETRY_CAP };
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		return {
			retryCap: DEFAULT_RETRY_CAP,
			warning: `retryCap must be a non-negative integer; using ${DEFAULT_RETRY_CAP}`,
		};
	}
	return { retryCap: value };
}

/**
 * Validate a parsed config object. Unknown keys are ignored deliberately: the
 * next ticket adds keys, and an older build must not reject a file a newer
 * project committed.
 */
export function normalizeGateConfig(raw: unknown): { config: GateConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config: { ...DEFAULT_GATE_CONFIG }, warnings: ["the config file must contain a JSON object"] };
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== undefined && record.version !== GATE_CONFIG_VERSION) {
		warnings.push(`unsupported config version ${String(record.version)}; using known fields`);
	}
	const { retryCap, warning } = normalizeRetryCap(record.retryCap);
	if (warning) warnings.push(warning);
	return {
		config: {
			version: GATE_CONFIG_VERSION,
			retryCap,
		},
		warnings,
	};
}

/**
 * Read the project config. Called from the settlement boundary (and never at
 * extension load), so an idle session performs no file read.
 */
export function readGateConfig(cwd: string): GateConfigRead {
	const path = gateConfigPath(cwd);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "ENOENT") return { config: { ...DEFAULT_GATE_CONFIG }, source: "default" };
		return {
			config: { ...DEFAULT_GATE_CONFIG },
			source: "default",
			warning: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			config: { ...DEFAULT_GATE_CONFIG },
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
