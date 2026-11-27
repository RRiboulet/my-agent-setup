// wave-ladder.mjs — the dispatch policy the wave orchestrator reads, and a pure
// reader for it.
//
// `.pi/extensions/orchestrator/wave-ladder.json` is the single bundled source
// for the roster, tier models, thinking pins, and reviewer gate. Callers using
// `readLadder()` without an explicit path resolve optional overrides in order:
//   1. `process.env.PI_ORCHESTRATE_LADDER` (`source: "env"`)
//   2. `<PI_CODING_AGENT_DIR or ~/.pi/agent>/orchestrate-ladder.json` when present (`source: "agent-dir"`)
//   3. bundled `wave-ladder.json` beside this module (`source: "file"`)
//
// Reader rule: a malformed or absent file never throws. `readLadder` returns a
// usable ladder plus warnings and falls back to `DEFAULT_LADDER` (`source: "default"`).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const LADDER_BASENAME = "wave-ladder.json";
export const AGENT_DIR_LADDER_BASENAME = "orchestrate-ladder.json";
export const LADDER_VERSION = 1;

/**
 * pi's thinking levels, in ascending order.
 */
export const THINKING_LEVELS = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/**
 * The types the dispatcher knows how to write a task for.
 */
export const KNOWN_ROSTER_TYPES = Object.freeze([
	"triage",
	"researcher",
	"implementer",
	"reviewer",
	"verifier",
]);

/**
 * Types the tier ladder cannot serve at all.
 */
export const TIER_EXEMPT_TYPES = Object.freeze(["triage"]);

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}

/**
 * The safe built-in ladder: matches the shipped `wave-ladder.json`.
 */
export const DEFAULT_LADDER = deepFreeze({
	version: LADDER_VERSION,
	roster: [...KNOWN_ROSTER_TYPES],
	tiers: [
		{ tier: 1, provider: "opencode-go", model: "hy4-flash-free", thinking: "max" },
		{ tier: 2, provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "medium" },
		{ tier: 3, provider: "mistral", model: "zai-glm-5-3-flash", thinking: "high" },
	],
	pins: {
		triage: { kind: "model", provider: "opencode", model: "jev-1.13-free" },
		reviewer: { kind: "inherit", inheritModel: true, thinking: "high" },
		verifier: { kind: "tier", tier: 2, thinking: "high" },
	},
	gates: { reviewer: { throughTier: 1 } },
});

/** The ladder shipped beside this module. */
export function defaultLadderPath() {
	return fileURLToPath(new URL(`./${LADDER_BASENAME}`, import.meta.url));
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function describe(value) {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

function cloneLadder(ladder) {
	return structuredClone(ladder);
}

// --- Roster ----------------------------------------------------------------

function normalizeRoster(raw, warnings) {
	if (raw === undefined) {
		warnings.push(`roster is missing; using ${KNOWN_ROSTER_TYPES.join(", ")}`);
		return [...KNOWN_ROSTER_TYPES];
	}
	if (!Array.isArray(raw)) {
		warnings.push("roster must be an array of type names; using the built-in roster");
		return [...KNOWN_ROSTER_TYPES];
	}
	const roster = [];
	for (const entry of raw) {
		if (!nonEmptyString(entry)) {
			warnings.push(`roster entry ${describe(entry)} is not a type name; ignoring it`);
			continue;
		}
		const type = entry.trim();
		if (!KNOWN_ROSTER_TYPES.includes(type)) {
			warnings.push(
				`roster names an unknown type ${describe(type)}; known types are ${KNOWN_ROSTER_TYPES.join(", ")}. Ignoring it`,
			);
			continue;
		}
		if (roster.includes(type)) {
			warnings.push(`roster names ${describe(type)} twice; the duplicate is ignored`);
			continue;
		}
		roster.push(type);
	}
	if (roster.length === 0) {
		warnings.push("roster has no usable type; using the built-in roster");
		return [...KNOWN_ROSTER_TYPES];
	}
	return roster;
}

// --- Tiers -----------------------------------------------------------------

function normalizeTier(raw, index, warnings) {
	if (!isPlainObject(raw)) {
		warnings.push(`tiers[${index}] must be an object; ignoring it`);
		return null;
	}
	const { tier, provider, model, thinking } = raw;
	if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1) {
		warnings.push(`tiers[${index}].tier must be a positive integer; ignoring tiers[${index}]`);
		return null;
	}
	if (!nonEmptyString(provider) || !nonEmptyString(model)) {
		warnings.push(`tier ${tier} needs non-empty provider and model strings; ignoring it`);
		return null;
	}
	if (!THINKING_LEVELS.includes(thinking)) {
		warnings.push(
			`tier ${tier} thinking ${describe(thinking)} is not one of ${THINKING_LEVELS.join(", ")}; ignoring tier ${tier}`,
		);
		return null;
	}
	return { tier, provider: provider.trim(), model: model.trim(), thinking };
}

function normalizeTiers(raw, warnings) {
	if (raw === undefined) {
		warnings.push("tiers is missing; using the built-in three tiers");
		return cloneLadder(DEFAULT_LADDER).tiers;
	}
	if (!Array.isArray(raw)) {
		warnings.push("tiers must be an array of tier objects; using the built-in three tiers");
		return cloneLadder(DEFAULT_LADDER).tiers;
	}
	const tiers = [];
	for (const [index, entry] of raw.entries()) {
		const tier = normalizeTier(entry, index, warnings);
		if (!tier) continue;
		if (tiers.some((existing) => existing.tier === tier.tier)) {
			warnings.push(`tier ${tier.tier} is defined twice; the second definition is ignored`);
			continue;
		}
		tiers.push(tier);
	}
	tiers.sort((a, b) => a.tier - b.tier);
	if (tiers.length === 0) {
		warnings.push("no usable tier; using the built-in three tiers");
		return cloneLadder(DEFAULT_LADDER).tiers;
	}
	const builtInTop = cloneLadder(DEFAULT_LADDER).tiers.at(-1).tier;
	if (tiers[tiers.length - 1].tier < builtInTop) {
		warnings.push(
			`the ladder's highest tier is ${tiers[tiers.length - 1].tier}, below the built-in top tier ${builtInTop}; escalation would run off the ladder, so the built-in tiers are used instead`,
		);
		return cloneLadder(DEFAULT_LADDER).tiers;
	}
	const missing = [];
	for (let expected = 1; expected <= tiers[tiers.length - 1].tier; expected += 1) {
		if (!tiers.some((tier) => tier.tier === expected)) missing.push(expected);
	}
	if (missing.length > 0) {
		warnings.push(
			`the ladder has no tier ${missing.join(", ")}; escalation needs every tier from 1 up, so the built-in three tiers are used instead`,
		);
		return cloneLadder(DEFAULT_LADDER).tiers;
	}
	return tiers;
}

// --- Pins ------------------------------------------------------------------

function normalizePin(type, raw, tiers, warnings) {
	if (!isPlainObject(raw)) {
		warnings.push(`pins.${type} must be an object; ignoring it`);
		return null;
	}
	const { tier, provider, model, thinking, inheritModel } = raw;
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
		warnings.push(
			`pins.${type}.thinking ${describe(thinking)} is not one of ${THINKING_LEVELS.join(", ")}; ignoring the pin`,
		);
		return null;
	}
	const hasInherit = inheritModel !== undefined;
	const hasTier = tier !== undefined;
	const hasModel = provider !== undefined || model !== undefined;
	if (hasInherit) {
		if (typeof inheritModel !== "boolean") {
			warnings.push(`pins.${type}.inheritModel must be a boolean; ignoring the pin`);
			return null;
		}
		if (inheritModel === true) {
			if (hasTier || hasModel) {
				warnings.push(`pins.${type} declares inheritModel alongside a tier or model; ignoring the ambiguous pin`);
				return null;
			}
			return thinking === undefined
				? { kind: "inherit", inheritModel: true }
				: { kind: "inherit", inheritModel: true, thinking };
		}
	}
	if (hasTier && hasModel) {
		warnings.push(`pins.${type} declares both a tier and a model; ignoring the ambiguous pin`);
		return null;
	}
	if (hasTier) {
		if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1) {
			warnings.push(`pins.${type}.tier must be a positive integer; ignoring the pin`);
			return null;
		}
		if (!tiers.some((entry) => entry.tier === tier)) {
			warnings.push(
				`pins.${type} is pinned to tier ${tier}, which the ladder does not define; ${type} has no tier coverage and falls back to the tier ladder`,
			);
			return null;
		}
		return thinking === undefined ? { kind: "tier", tier } : { kind: "tier", tier, thinking };
	}
	if (hasModel) {
		if (!nonEmptyString(provider) || !nonEmptyString(model)) {
			warnings.push(
				`pins.${type}.provider and pins.${type}.model must both be non-empty strings; ignoring the pin`,
			);
			return null;
		}
		return thinking === undefined
			? { kind: "model", provider: provider.trim(), model: model.trim() }
			: { kind: "model", provider: provider.trim(), model: model.trim(), thinking };
	}
	warnings.push(`pins.${type} declares neither a tier, inheritModel, nor a provider/model pair; ignoring the pin`);
	return null;
}

function normalizePins(raw, roster, tiers, warnings) {
	const pins = {};
	if (raw === undefined) {
		return pins;
	}
	if (!isPlainObject(raw)) {
		warnings.push("pins must be an object keyed by roster type; every roster type uses the tier ladder");
		return pins;
	}
	for (const [type, entry] of Object.entries(raw)) {
		if (!roster.includes(type)) {
			warnings.push(`pins.${type} names a type that is not in the roster; the pin is ignored`);
			continue;
		}
		const pin = normalizePin(type, entry, tiers, warnings);
		if (pin) pins[type] = pin;
	}
	for (const type of roster) {
		if (!TIER_EXEMPT_TYPES.includes(type)) continue;
		const pin = pins[type];
		if (!pin) {
			warnings.push(
				`pins.${type} is required: ${type} is tier-exempt and has no decision model pinned, so ${type} cannot be dispatched`,
			);
			continue;
		}
		if (pin.kind !== "model") {
			warnings.push(
				`pins.${type} must pin a provider/model pair: ${type} is tier-exempt and cannot dispatch from a tier. Ignoring the pin`,
			);
			delete pins[type];
		}
	}
	return pins;
}

// --- Gates -----------------------------------------------------------------

function normalizeGates(raw, warnings) {
	const gates = { reviewer: { throughTier: 1 } };
	if (raw === undefined) return gates;
	if (!isPlainObject(raw)) {
		warnings.push("gates must be an object; the reviewer gate stays at its built-in setting");
		return gates;
	}
	const reviewer = raw.reviewer;
	if (reviewer === undefined) return gates;
	if (!isPlainObject(reviewer)) {
		warnings.push("gates.reviewer must be an object; the reviewer gate stays at its built-in setting");
		return gates;
	}
	const { throughTier } = reviewer;
	if (throughTier === undefined) return gates;
	if (typeof throughTier !== "number" || !Number.isInteger(throughTier) || throughTier < 1) {
		if (throughTier === 0) {
			warnings.push(
				"gates.reviewer.throughTier 0 would disable the reviewer gate; the gate cannot be disabled, so the built-in setting is used — widen the gate with a higher throughTier instead",
			);
		} else {
			warnings.push(
				"gates.reviewer.throughTier must be a positive integer; the reviewer gate stays at its built-in setting",
			);
		}
		return { reviewer: { throughTier: 1 } };
	}
	return { reviewer: { throughTier } };
}

// --- Reader & Pin Resolution -----------------------------------------------

/**
 * Resolve a pinned role (`"triage" | "reviewer" | "verifier"`, etc.) from a
 * normalized (or raw) ladder to `{ provider, model, thinking? }` or
 * `{ inheritModel: true, thinking? }`, or `null` if the role has no usable pin.
 */
export function resolvePin(ladder, role) {
	if (!isPlainObject(ladder) || !isPlainObject(ladder.pins)) return null;
	const pin = ladder.pins[role];
	if (!isPlainObject(pin)) return null;
	const isInheritPin =
		pin.kind === "inherit" ||
		(pin.kind === undefined &&
			pin.inheritModel === true &&
			pin.tier === undefined &&
			pin.provider === undefined &&
			pin.model === undefined);
	if (isInheritPin) {
		return pin.thinking !== undefined
			? { inheritModel: true, thinking: pin.thinking }
			: { inheritModel: true };
	}
	const isModelPin = pin.kind === "model" || (pin.kind === undefined && nonEmptyString(pin.provider) && nonEmptyString(pin.model));
	if (isModelPin) {
		if (!nonEmptyString(pin.provider) || !nonEmptyString(pin.model)) return null;
		return pin.thinking !== undefined
			? { provider: pin.provider.trim(), model: pin.model.trim(), thinking: pin.thinking }
			: { provider: pin.provider.trim(), model: pin.model.trim() };
	}
	const isTierPin = pin.kind === "tier" || (pin.kind === undefined && typeof pin.tier === "number");
	if (isTierPin) {
		if (!Array.isArray(ladder.tiers)) return null;
		const tierEntry = ladder.tiers.find((entry) => entry && entry.tier === pin.tier);
		if (!tierEntry) return null;
		return {
			provider: tierEntry.provider,
			model: tierEntry.model,
			thinking: pin.thinking ?? tierEntry.thinking,
		};
	}
	return null;
}

export function normalizeLadder(raw) {
	const warnings = [];
	if (!isPlainObject(raw)) {
		return {
			ladder: cloneLadder(DEFAULT_LADDER),
			warnings: ["the ladder file must contain a JSON object; using the built-in ladder"],
		};
	}
	if (raw.version !== undefined && raw.version !== LADDER_VERSION) {
		warnings.push(
			`unsupported ladder version ${describe(raw.version)}; reading the keys this build knows`,
		);
	}
	const roster = normalizeRoster(raw.roster, warnings);
	const tiers = normalizeTiers(raw.tiers, warnings);
	const pins = normalizePins(raw.pins, roster, tiers, warnings);
	const gates = normalizeGates(raw.gates, warnings);
	return {
		ladder: { version: LADDER_VERSION, roster, tiers, pins, gates },
		warnings,
	};
}

function resolveDefaultLadderTarget(options) {
	const envLadder = typeof process.env.PI_ORCHESTRATE_LADDER === "string" ? process.env.PI_ORCHESTRATE_LADDER.trim() : "";
	if (envLadder.length > 0) {
		return { filePath: envLadder, source: "env" };
	}
	const agentDir =
		options?.agentDir ?? (process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), ".pi", "agent"));
	if (typeof agentDir === "string" && agentDir.length > 0) {
		const candidate = path.join(agentDir, AGENT_DIR_LADDER_BASENAME);
		if (existsSync(candidate)) {
			return { filePath: candidate, source: "agent-dir" };
		}
	}
	return { filePath: defaultLadderPath(), source: "file" };
}

/**
 * Read a ladder file. When `explicitPath` is omitted, checks overrides in order:
 *   1. `process.env.PI_ORCHESTRATE_LADDER` (`source: "env"`)
 *   2. `<agentDir or PI_CODING_AGENT_DIR or ~/.pi/agent>/orchestrate-ladder.json` if it exists (`source: "agent-dir"`)
 *   3. bundled `wave-ladder.json` beside this module (`source: "file"`)
 *
 * Never throws; returns `{ ladder, warnings, source }`, falling back to
 * `DEFAULT_LADDER` (`source: "default"`) if the chosen file cannot be read or
 * parsed.
 */
export function readLadder(explicitPath, options) {
	const target =
		explicitPath !== undefined
			? { filePath: explicitPath, source: "file" }
			: resolveDefaultLadderTarget(options);

	let text;
	try {
		text = readFileSync(target.filePath, "utf8");
	} catch (error) {
		const code = error !== null && typeof error === "object" ? error.code : undefined;
		const reason =
			code === "ENOENT"
				? `there is no ladder file at ${target.filePath}`
				: `could not read the ladder at ${target.filePath}: ${message(error)}`;
		return {
			ladder: cloneLadder(DEFAULT_LADDER),
			warnings: [`${reason}; using the built-in ladder`],
			source: "default",
		};
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			ladder: cloneLadder(DEFAULT_LADDER),
			warnings: [`the ladder at ${target.filePath} is not valid JSON: ${message(error)}; using the built-in ladder`],
			source: "default",
		};
	}

	const { ladder, warnings } = normalizeLadder(parsed);
	return { ladder, warnings, source: target.source };
}
