// Tests for the orchestrate ladder reader.
//
// The reader's contract is the one `.pi/extensions/orchestrator/config.ts`
// states for the gate config: a malformed file is reported, never thrown, and
// the caller dispatches from a safe default in the meantime. Most cases below
// therefore assert two things at once — the warning that names the problem, and
// the usable ladder that comes back anyway.
//
// The first two tests pin the shipped data file to DEFAULT_LADDER and to the
// reader's default path. Without them the constant and the JSON could drift, and
// "fail open" would quietly mean "dispatch from a different policy".

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_LADDER,
	KNOWN_ROSTER_TYPES,
	LADDER_VERSION,
	THINKING_LEVELS,
	defaultLadderPath,
	normalizeLadder,
	readLadder,
} from "./ladder.mjs";

const SHIPPED = JSON.parse(readFileSync(defaultLadderPath(), "utf8"));

function tempDir(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "orchestrate-ladder-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Write `value` (an object, or a raw string) as ladder.json in a fresh dir. */
function writeLadder(t, value) {
	const dir = tempDir(t);
	const file = path.join(dir, "ladder.json");
	writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return file;
}

function warningsOf(result) {
	assert.ok(Array.isArray(result.warnings), "warnings must always be an array");
	return result.warnings.join("; ");
}

/** A deep copy of the shipped ladder that a test may edit freely. */
function shipped() {
	return structuredClone(SHIPPED);
}

test("the shipped ladder.json normalizes with no warnings", () => {
	const result = readLadder();
	assert.equal(result.source, "file");
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
});

test("the shipped ladder carries the tier and pin policy this repository decided", () => {
	const { ladder } = readLadder();
	assert.equal(ladder.version, LADDER_VERSION);
	assert.deepEqual(ladder.roster, [...KNOWN_ROSTER_TYPES]);

	const byTier = new Map(ladder.tiers.map((tier) => [tier.tier, tier]));
	assert.equal(byTier.size, 3);
	assert.deepEqual(
		{ provider: byTier.get(1).provider, model: byTier.get(1).model, thinking: byTier.get(1).thinking },
		{ provider: "opencode-go", model: "hy4-flash-free", thinking: "max" },
	);
	assert.deepEqual(
		{ provider: byTier.get(2).provider, model: byTier.get(2).model, thinking: byTier.get(2).thinking },
		{ provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: "medium" },
	);
	assert.deepEqual(
		{ provider: byTier.get(3).provider, model: byTier.get(3).model, thinking: byTier.get(3).thinking },
		{ provider: "mistral", model: "zai-glm-5-3", thinking: "high" },
	);

	assert.deepEqual(ladder.pins.triage, {
		kind: "model",
		provider: "opencode",
		model: "jev-1.13-free",
	});
	assert.deepEqual(ladder.pins.reviewer, { kind: "tier", tier: 2 });
	assert.deepEqual(ladder.pins.verifier, { kind: "tier", tier: 2, thinking: "high" });
	assert.deepEqual(ladder.gates, { reviewer: { throughTier: 1 } });
});

test("readLadder returns the parsed ladder for a valid file", (t) => {
	const file = writeLadder(t, shipped());
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
});

test("an absent file falls open with a warning instead of throwing", (t) => {
	const dir = tempDir(t);
	const result = readLadder(path.join(dir, "does-not-exist.json"));
	assert.equal(result.source, "default");
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
	assert.match(warningsOf(result), /no ladder file at/);
	assert.match(warningsOf(result), /built-in ladder/);
});

test("an unreadable path falls open with a warning instead of throwing", (t) => {
	// A directory is unreadable as a file on every platform this runs on, which a
	// chmod-based test is not: it would pass while running as root.
	const dir = tempDir(t);
	const result = readLadder(dir);
	assert.equal(result.source, "default");
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
	assert.match(warningsOf(result), /could not read the ladder at/);
});

test("invalid JSON falls open with a warning instead of throwing", (t) => {
	const file = writeLadder(t, "{ this is not json");
	const result = readLadder(file);
	assert.equal(result.source, "default");
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
	assert.match(warningsOf(result), /is not valid JSON/);
});

test("a JSON value that is not an object falls open with a warning", (t) => {
	const file = writeLadder(t, [1, 2, 3]);
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.deepEqual(result.ladder, DEFAULT_LADDER);
	assert.match(warningsOf(result), /must contain a JSON object/);
});

test("a missing tier is reported and the built-in ladder is used", (t) => {
	const ladder = shipped();
	ladder.tiers = ladder.tiers.filter((tier) => tier.tier !== 2);
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /no tier 2/);
	assert.deepEqual(
		result.ladder.tiers.map((tier) => tier.tier),
		[1, 2, 3],
		"a hole at tier 2 would make escalation skip a rung, so nothing usable is kept",
	);
});

test("a ladder whose top tier is missing is reported and the built-in ladder is used", (t) => {
	const ladder = shipped();
	ladder.tiers = ladder.tiers.filter((tier) => tier.tier !== 3);
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.match(
		warningsOf(result),
		/escalation would run off the ladder/,
		"a missing ceiling is silent drift: escalation from Tier 2 would find no target and every exhausted ticket would block instead",
	);
	assert.deepEqual(
		result.ladder.tiers.map((tier) => tier.tier),
		[1, 2, 3],
	);
});

test("a thinking level outside pi's enum is reported", (t) => {
	const ladder = shipped();
	ladder.tiers[1].thinking = "very-high";
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	const warnings = warningsOf(result);
	assert.match(warnings, /tier 2 thinking "very-high" is not one of/);
	for (const level of THINKING_LEVELS) {
		assert.ok(warnings.includes(level), `the warning should name ${level}`);
	}
	// Tier 2 was dropped, which leaves a hole at 2, so the ladder falls back.
	assert.deepEqual(result.ladder.tiers, [...DEFAULT_LADDER.tiers]);
});

test("a pin to a tier the ladder does not define has no tier coverage and is reported", (t) => {
	const ladder = shipped();
	ladder.pins.implementer = { tier: 9 };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.implementer is pinned to tier 9/);
	assert.match(warningsOf(result), /implementer has no tier coverage/);
	assert.equal(result.ladder.pins.implementer, undefined, "an unusable pin does not survive normalization");
	// The rest of the ladder is still usable, so it is kept rather than replaced.
	assert.deepEqual(result.ladder.tiers, [...DEFAULT_LADDER.tiers]);
	assert.deepEqual(result.ladder.pins.triage, DEFAULT_LADDER.pins.triage);
});

test("an empty tier table leaves every unpinned roster type uncovered and is reported", (t) => {
	const ladder = shipped();
	ladder.tiers = [];
	delete ladder.pins.reviewer;
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /no usable tier/);
	assert.deepEqual(result.ladder.tiers, [...DEFAULT_LADDER.tiers]);
});

test("the tier-exempt type without its pin is reported", (t) => {
	const ladder = shipped();
	delete ladder.pins.triage;
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.triage is required/);
	assert.match(warningsOf(result), /tier-exempt/);
	assert.match(warningsOf(result), /cannot be dispatched/);
	assert.equal(result.ladder.pins.triage, undefined);
	assert.ok(result.ladder.roster.includes("triage"));
});

test("the tier-exempt type pinned to a tier is reported and the pin dropped", (t) => {
	const ladder = shipped();
	ladder.pins.triage = { tier: 2 };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.triage must pin a provider\/model pair/);
	assert.equal(result.ladder.pins.triage, undefined);
});

test("an unknown roster entry is reported and dropped", (t) => {
	const ladder = shipped();
	ladder.roster.push("implementor");
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	const warnings = warningsOf(result);
	assert.match(warnings, /roster names an unknown type "implementor"/);
	assert.ok(warnings.includes("triage"), "the warning should list the known types");
	assert.deepEqual(result.ladder.roster, [...KNOWN_ROSTER_TYPES]);
});

test("a roster entry the dispatcher knows but the file omits is not invented", (t) => {
	const ladder = shipped();
	ladder.roster = ladder.roster.filter((type) => type !== "researcher");
	delete ladder.pins.reviewer;
	ladder.pins.verifier = { tier: 2, thinking: "high" };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.deepEqual(result.ladder.roster, ["triage", "implementer", "reviewer", "verifier"]);
});

test("a pin for a type that is not in the roster is reported and ignored", (t) => {
	const ladder = shipped();
	ladder.roster = ladder.roster.filter((type) => type !== "researcher");
	ladder.pins.researcher = { tier: 3 };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.researcher names a type that is not in the roster/);
	assert.equal(result.ladder.pins.researcher, undefined);
});

test("an ambiguous pin naming both a tier and a model is reported and dropped", (t) => {
	const ladder = shipped();
	ladder.pins.reviewer = { tier: 2, provider: "opencode-go", model: "deepseek-v4.1-flash" };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.reviewer declares both a tier and a model/);
	assert.equal(result.ladder.pins.reviewer, undefined);
});

test("a pin thinking level outside pi's enum is reported", (t) => {
	const ladder = shipped();
	ladder.pins.verifier = { tier: 2, thinking: "maximum" };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.verifier\.thinking "maximum"/);
	assert.equal(result.ladder.pins.verifier, undefined);
});

test("a pin with half a provider/model pair is reported", (t) => {
	const ladder = shipped();
	ladder.pins.triage = { provider: "openrouter" };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	const warnings = warningsOf(result);
	assert.match(warnings, /pins\.triage\.provider and pins\.triage\.model must both be non-empty strings/);
	assert.match(warnings, /pins\.triage is required/, "with no usable pin, the exempt type is uncovered again");
});

test("a malformed gates block falls back to the built-in reviewer gate", (t) => {
	const ladder = shipped();
	ladder.gates = { reviewer: { throughTier: "one" } };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /gates\.reviewer\.throughTier must be a positive integer/);
	assert.equal(
		result.ladder.gates.reviewer.throughTier, 1,
		"a malformed gate must fall back to the built-in gate, not to a disabled one: 0 would drop the Tier-1 quality floor silently",
	);
});

test("an explicit zero reviewer gate is refused, not accepted as gate-off", (t) => {
	const ladder = shipped();
	ladder.gates = { reviewer: { throughTier: 0 } };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.match(warningsOf(result), /the gate cannot be disabled/);
	assert.equal(
		result.ladder.gates.reviewer.throughTier, 1,
		"a zero throughTier would drop the Tier-1 quality floor — the spec's headline value — so the ladder refuses it and keeps the built-in gate",
	);
});

test("an unknown version is reported but the keys this build knows are read", (t) => {
	const ladder = shipped();
	ladder.version = 99;
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /unsupported ladder version 99/);
	assert.deepEqual(result.ladder.roster, [...KNOWN_ROSTER_TYPES]);
	assert.deepEqual(result.ladder.tiers, [...DEFAULT_LADDER.tiers]);
});

test("a missing roster is reported", (t) => {
	const ladder = shipped();
	delete ladder.roster;
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /roster is missing/);
	assert.deepEqual(result.ladder.roster, [...KNOWN_ROSTER_TYPES]);
});

test("normalizeLadder never throws, whatever it is handed", () => {
	const nonsense = [
		null,
		undefined,
		0,
		NaN,
		"ladder",
		true,
		[],
		{},
		{ version: null },
		{ roster: "triage", tiers: "three", pins: "none", gates: [] },
		{ roster: [null, 3, "", "triage"], tiers: [null, { tier: -1 }, { tier: 1 }], pins: { triage: [] } },
		{ tiers: [{ tier: 1, provider: "", model: "", thinking: "off" }], pins: { triage: { tier: 1, model: 2 } } },
		{ version: 1, tiers: [{ tier: 1, provider: "p", model: "m", thinking: "max" }], pins: {}, gates: { reviewer: null } },
	];
	for (const value of nonsense) {
		const result = normalizeLadder(value);
		assert.ok(result.ladder, `no ladder for ${JSON.stringify(value) ?? String(value)}`);
		assert.ok(Array.isArray(result.warnings));
		assert.ok(Array.isArray(result.ladder.roster));
		assert.ok(Array.isArray(result.ladder.tiers));
		assert.equal(typeof result.ladder.pins, "object");
		assert.equal(typeof result.ladder.gates, "object");
	}
});

test("the returned ladder is a copy: editing it never mutates DEFAULT_LADDER", (t) => {
	const dir = tempDir(t);
	const first = readLadder(path.join(dir, "missing.json"));
	first.ladder.tiers[0].model = "tampered";
	first.ladder.pins.reviewer.tier = 99;

	const second = readLadder(path.join(dir, "missing.json"));
	assert.equal(second.ladder.tiers[0].model, "hy4-flash-free");
	assert.equal(second.ladder.pins.reviewer.tier, 2);
	assert.equal(DEFAULT_LADDER.tiers[0].model, "hy4-flash-free");
});
