// ladder.mjs — the dispatch policy the orchestrate skill reads, and a pure
// reader for it.
//
// `.pi/skills/orchestrate/ladder.json` is the ONE place the roster, the tier
// models, the thinking pins and the reviewer gate are written. The skill prose
// points at this file; a future enforcement extension reads the same one. A
// second copy of the table in a prompt is the failure this module exists to
// prevent.
//
// Reader rule, copied from `.pi/extensions/orchestrator/config.ts`: a malformed
// file is never fatal. `readLadder` returns a ladder plus a list of warnings and
// never throws; a caller shows the warnings and dispatches from the safe
// built-in ladder rather than trapping a session. The one deliberate difference
// is absence. An absent project config there is normal and silent; an absent
// ladder here is not — this repository ships one, so its absence means dispatch
// would run from an unversioned copy and is warned about like any other
// malformation.
//
// Why a model is two keys (`provider`, `model`) rather than one
// `provider/model` string: model ids contain slashes of their own
// (`typesafe/jev-1.13`), so the single-string form cannot be split without
// guessing where the provider ends. The advisor config in
// `.pi/extensions/orchestrator/config.ts` makes the same choice for the same
// reason, and the subagent tools take `provider` and `model` separately anyway.
//
// Why the tiers must be contiguous from tier 1: escalation is "one tier up".
// A ladder with a hole at tier 2 turns that step into a jump past the workhorse
// model, which is a silent policy change rather than a dispatch. A hole is
// therefore treated as a malformed tier table and the built-in three are used.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LADDER_BASENAME = "ladder.json";
export const LADDER_VERSION = 1;

/**
 * pi's thinking levels, in ascending order. A level outside this list cannot be
 * dispatched: the subagent tools take this closed enum, so a typo would be
 * rejected at run start rather than read as a nearby level.
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
 * The types the dispatcher knows how to write a task for. A roster entry outside
 * this list cannot be dispatched — there is no prompt for it — so it is dropped
 * with a warning instead of reaching a run that has nothing to say.
 */
export const KNOWN_ROSTER_TYPES = Object.freeze([
	"triage",
	"researcher",
	"implementer",
	"reviewer",
	"verifier",
]);

/**
 * Types the tier ladder cannot serve at all. Triage decides which tier a ticket
 * needs; it does not do the ticket, and the tier models are not decision models.
 * A tier-exempt type therefore has to be pinned to a literal (provider, model)
 * pair — with no pin it cannot be dispatched, which is a warning rather than a
 * silent fallback to Tier 1.
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
 * The safe ladder: what a caller dispatches from when the file is missing,
 * unreadable or malformed. It is the shipped `ladder.json` normalized, and
 * `ladder.test.mjs` asserts the two stay equal so this constant cannot drift
 * from the data file it stands in for.
 *
 * Capability here is bought with deliberation rather than model size: every
 * tier model is free, so the quality dial is thinking. Tier 1 spends `max` on
 * small work, Tier 2 stays at `medium`, and only the escalation target runs at
 * `high`.
 */
export const DEFAULT_LADDER = deepFreeze({
	version: LADDER_VERSION,
	roster: [...KNOWN_ROSTER_TYPES],
	tiers: [
		{ tier: 1, provider: "opencode-go", model: "hy4-flash-free", thinking: "max" },
		{ tier: 2, provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "medium" },
		{ tier: 3, provider: "mistral", model: "zai-glm-5-3", thinking: "high" },
	],
	pins: {
		triage: { kind: "model", provider: "opencode", model: "jev-1.13-free" },
		reviewer: { kind: "tier", tier: 2 },
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

/**
 * Validate the tier table. Every tier is checked, unusable entries are dropped
 * with a warning, and the survivors must then cover 1..N with no hole — a hole
 * makes "escalate one tier" skip a rung — and reach the built-in top tier: a
 * ladder whose ceiling is missing is silent drift, since escalation from the
 * second-highest tier would find no target and every exhausted ticket would
 * block without a warning saying why.
 */
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

/**
 * One type's dispatch pin. Two shapes, because they answer different questions:
 *
 *   * `{ provider, model, thinking? }` — a literal model. Tier-exempt: the type
 *     does not dispatch from the ladder at all. Triage is the one type that
 *     must use this shape, because a decision model is not a tier model.
 *   * `{ tier, thinking? }` — dispatch at a rung of the ladder, optionally at a
 *     different thinking level than the tier's. The reviewer and verifier are
 *     pinned this way; the verifier's `high` is deliberate, since its pass/fail
 *     authorizes the commit.
 *
 * Both keys at once is a typo rather than an intent — nothing says which wins —
 * so such a pin is dropped with a warning instead of guessed at.
 */
function normalizePin(type, raw, tiers, warnings) {
	if (!isPlainObject(raw)) {
		warnings.push(`pins.${type} must be an object; ignoring it`);
		return null;
	}
	const { tier, provider, model, thinking } = raw;
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
		warnings.push(
			`pins.${type}.thinking ${describe(thinking)} is not one of ${THINKING_LEVELS.join(", ")}; ignoring the pin`,
		);
		return null;
	}
	const hasTier = tier !== undefined;
	const hasModel = provider !== undefined || model !== undefined;
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
	warnings.push(`pins.${type} declares neither a tier nor a provider/model pair; ignoring the pin`);
	return null;
}

function normalizePins(raw, roster, tiers, warnings) {
	const pins = {};
	if (raw === undefined) {
		// Not an error by itself: a roster of purely tiered types needs no pins.
		// The coverage pass below is what reports a type that cannot be served.
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

/**
 * Gate policy. Kept here, next to the models it gates, because a rule written in
 * skill prose and a model written here drift apart the moment one is edited.
 * `throughTier` is the highest tier whose output still passes the reviewer: Tier
 * 1 gets an independent grader, Tier 2 and above are ungated. The gate cannot be
 * disabled from config: `throughTier: 0` is refused with a warning and the
 * built-in gate is kept, because dropping the Tier-1 grader is exactly the
 * silent quality-floor loss this ladder exists to prevent.
 */
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

// --- Reader ----------------------------------------------------------------

/**
 * Validate an already-parsed ladder. Never throws: every field is checked
 * independently, an unusable one falls back to its built-in value, and anything
 * that could not be read is reported in `warnings`. Unknown top-level keys are
 * ignored on purpose, so a ladder written for a newer build still dispatches.
 */
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

/**
 * Read a ladder file. `path` defaults to the `ladder.json` beside this module;
 * tests point it at a temporary directory.
 *
 * The return value is `{ ladder, warnings, source }`. `source` is `"file"` when
 * the file was found and parsed (even if parts of it were malformed, which the
 * warnings then describe) and `"default"` when nothing could be read at all.
 * The ladder is always a usable object, and mutating it never touches
 * `DEFAULT_LADDER`.
 */
export function readLadder(path = defaultLadderPath()) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = error !== null && typeof error === "object" ? error.code : undefined;
		const reason =
			code === "ENOENT"
				? `there is no ladder file at ${path}`
				: `could not read the ladder at ${path}: ${message(error)}`;
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
			warnings: [`the ladder at ${path} is not valid JSON: ${message(error)}; using the built-in ladder`],
			source: "default",
		};
	}

	const { ladder, warnings } = normalizeLadder(parsed);
	return { ladder, warnings, source: "file" };
}
