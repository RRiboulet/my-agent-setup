// Tests for `.pi/extensions/orchestrator/wave-ladder.mjs`.
//
// Ports the full contract from `.pi/skills/orchestrate/ladder.test.mjs` and adds
// coverage for env/agent-dir override resolution (`PI_ORCHESTRATE_LADDER`,
// `PI_CODING_AGENT_DIR/orchestrate-ladder.json`) and `resolvePin(ladder, role)`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	resolvePin,
} from "../../orchestrator/wave-ladder.mjs";
import { withEnv } from "./helpers.ts";

const SHIPPED = JSON.parse(readFileSync(defaultLadderPath(), "utf8"));

function tempDir(t: test.TestContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), "orchestrator-wave-ladder-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeLadder(t: test.TestContext, value: unknown, filename = "wave-ladder.json"): string {
	const dir = tempDir(t);
	const file = path.join(dir, filename);
	writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
	return file;
}

function warningsOf(result: { warnings: string[] }): string {
	assert.ok(Array.isArray(result.warnings), "warnings must always be an array");
	return result.warnings.join("; ");
}

function shipped(): Record<string, any> {
	return structuredClone(SHIPPED);
}

test("the shipped wave-ladder.json normalizes with no warnings when no overrides are set", async (t) => {
	const fakeHome = tempDir(t);
	await withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
		const result = readLadder();
		assert.equal(result.source, "file");
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(result.ladder, DEFAULT_LADDER);
	});
});

test("the shipped ladder carries the clean upstream tier and pin policy", async (t) => {
	const fakeHome = tempDir(t);
	await withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
		const { ladder } = readLadder();
		assert.equal(ladder.version, LADDER_VERSION);
		assert.deepEqual(ladder.roster, [...KNOWN_ROSTER_TYPES]);

		const byTier = new Map(ladder.tiers.map((tier: any) => [tier.tier, tier]));
		assert.equal(byTier.size, 3);
		assert.deepEqual(
			{ provider: byTier.get(1).provider, model: byTier.get(1).model, thinking: byTier.get(1).thinking },
			{ provider: "opencode-go", model: "hy4-flash-free", thinking: "max" },
		);
		assert.deepEqual(
			{ provider: byTier.get(2).provider, model: byTier.get(2).model, thinking: "medium" },
			{ provider: "opencode-go", model: "deepseek-v4.1-flash", thinking: byTier.get(2).thinking },
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
});

test("override precedence: PI_ORCHESTRATE_LADDER > PI_CODING_AGENT_DIR/orchestrate-ladder.json > bundled", async (t) => {
	const envLadder = shipped();
	envLadder.tiers[0].model = "env-model";
	const envFile = writeLadder(t, envLadder, "custom-env-ladder.json");

	const agentDir = tempDir(t);
	const agentDirLadder = shipped();
	agentDirLadder.tiers[0].model = "agent-dir-model";
	writeFileSync(path.join(agentDir, "orchestrate-ladder.json"), `${JSON.stringify(agentDirLadder, null, 2)}\n`, "utf8");

	// 1. Both set -> PI_ORCHESTRATE_LADDER wins with source "env"
	await withEnv({ PI_ORCHESTRATE_LADDER: envFile, PI_CODING_AGENT_DIR: agentDir }, () => {
		const res = readLadder();
		assert.equal(res.source, "env");
		assert.deepEqual(res.warnings, []);
		assert.equal(res.ladder.tiers[0].model, "env-model");
	});

	// 2. Only PI_CODING_AGENT_DIR set and file exists -> source "agent-dir"
	await withEnv({ PI_ORCHESTRATE_LADDER: "", PI_CODING_AGENT_DIR: agentDir }, () => {
		const res = readLadder();
		assert.equal(res.source, "agent-dir");
		assert.deepEqual(res.warnings, []);
		assert.equal(res.ladder.tiers[0].model, "agent-dir-model");
	});

	// 3. PI_CODING_AGENT_DIR set but orchestrate-ladder.json absent -> bundled file
	const emptyAgentDir = tempDir(t);
	await withEnv({ PI_ORCHESTRATE_LADDER: undefined, PI_CODING_AGENT_DIR: emptyAgentDir }, () => {
		const res = readLadder();
		assert.equal(res.source, "file");
		assert.deepEqual(res.warnings, []);
		assert.equal(res.ladder.tiers[0].model, "hy4-flash-free");
	});

	// 4. Explicit path argument bypasses env overrides
	await withEnv({ PI_ORCHESTRATE_LADDER: envFile, PI_CODING_AGENT_DIR: agentDir }, () => {
		const explicitFile = writeLadder(t, shipped());
		const res = readLadder(explicitFile);
		assert.equal(res.source, "file");
		assert.equal(res.ladder.tiers[0].model, "hy4-flash-free");
	});
});

test("default ~/.pi/agent/orchestrate-ladder.json is discovered when PI_CODING_AGENT_DIR is unset", async (t) => {
	const fakeHome = tempDir(t);
	const defaultAgentDir = path.join(fakeHome, ".pi", "agent");
	mkdirSync(defaultAgentDir, { recursive: true });
	const homeLadder = shipped();
	homeLadder.tiers[0].model = "home-agent-dir-model";
	writeFileSync(
		path.join(defaultAgentDir, "orchestrate-ladder.json"),
		`${JSON.stringify(homeLadder, null, 2)}\n`,
		"utf8",
	);

	await withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
		const res = readLadder();
		assert.equal(res.source, "agent-dir");
		assert.deepEqual(res.warnings, []);
		assert.equal(res.ladder.tiers[0].model, "home-agent-dir-model");
	});
});

test("invalid or missing PI_ORCHESTRATE_LADDER never throws and falls back to DEFAULT_LADDER with warnings", async (t) => {
	const fakeHome = tempDir(t);
	const missingPath = path.join(tempDir(t), "nope.json");
	await withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: missingPath, PI_CODING_AGENT_DIR: undefined }, () => {
		const res = readLadder();
		assert.equal(res.source, "default");
		assert.deepEqual(res.ladder, DEFAULT_LADDER);
		assert.match(warningsOf(res), /no ladder file at/);
	});

	const brokenEnvFile = writeLadder(t, "{ not valid json", "broken.json");
	await withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: brokenEnvFile, PI_CODING_AGENT_DIR: undefined }, () => {
		const res = readLadder();
		assert.equal(res.source, "default");
		assert.deepEqual(res.ladder, DEFAULT_LADDER);
		assert.match(warningsOf(res), /is not valid JSON/);
	});
});

test("resolvePin resolves model pins, tier pins with/without thinking override, and missing pins", () => {
	assert.deepEqual(resolvePin(DEFAULT_LADDER, "triage"), {
		provider: "opencode",
		model: "jev-1.13-free",
	});
	assert.deepEqual(resolvePin(DEFAULT_LADDER, "reviewer"), {
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		thinking: "medium",
	});
	assert.deepEqual(resolvePin(DEFAULT_LADDER, "verifier"), {
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		thinking: "high",
	});
	assert.equal(resolvePin(DEFAULT_LADDER, "implementer"), null);

	const customLadder = {
		...structuredClone(DEFAULT_LADDER),
		pins: {
			triage: { kind: "model", provider: "opencode", model: "triage-m", thinking: "low" },
			reviewer: { kind: "model", provider: "anthropic", model: "claude-sonnet", thinking: "high" },
			verifier: { kind: "tier", tier: 3 },
		},
	};
	assert.deepEqual(resolvePin(customLadder, "triage"), {
		provider: "opencode",
		model: "triage-m",
		thinking: "low",
	});
	assert.deepEqual(resolvePin(customLadder, "reviewer"), {
		provider: "anthropic",
		model: "claude-sonnet",
		thinking: "high",
	});
	assert.deepEqual(resolvePin(customLadder, "verifier"), {
		provider: "mistral",
		model: "zai-glm-5-3",
		thinking: "high",
	});
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
	ladder.tiers = ladder.tiers.filter((tier: any) => tier.tier !== 2);
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /no tier 2/);
	assert.deepEqual(
		result.ladder.tiers.map((tier: any) => tier.tier),
		[1, 2, 3],
	);
});

test("a ladder whose top tier is missing is reported and the built-in ladder is used", (t) => {
	const ladder = shipped();
	ladder.tiers = ladder.tiers.filter((tier: any) => tier.tier !== 3);
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.match(warningsOf(result), /escalation would run off the ladder/);
	assert.deepEqual(
		result.ladder.tiers.map((tier: any) => tier.tier),
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
	assert.deepEqual(result.ladder.tiers, [...DEFAULT_LADDER.tiers]);
});

test("a pin to a tier the ladder does not define has no tier coverage and is reported", (t) => {
	const ladder = shipped();
	ladder.pins.implementer = { tier: 9 };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /pins\.implementer is pinned to tier 9/);
	assert.match(warningsOf(result), /implementer has no tier coverage/);
	assert.equal(result.ladder.pins.implementer, undefined);
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
	assert.ok(warnings.includes("triage"));
	assert.deepEqual(result.ladder.roster, [...KNOWN_ROSTER_TYPES]);
});

test("a roster entry the dispatcher knows but the file omits is not invented", (t) => {
	const ladder = shipped();
	ladder.roster = ladder.roster.filter((type: string) => type !== "researcher");
	delete ladder.pins.reviewer;
	ladder.pins.verifier = { tier: 2, thinking: "high" };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.deepEqual(result.ladder.roster, ["triage", "implementer", "reviewer", "verifier"]);
});

test("a pin for a type that is not in the roster is reported and ignored", (t) => {
	const ladder = shipped();
	ladder.roster = ladder.roster.filter((type: string) => type !== "researcher");
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
	assert.match(warnings, /pins\.triage is required/);
});

test("a malformed gates block falls back to the built-in reviewer gate", (t) => {
	const ladder = shipped();
	ladder.gates = { reviewer: { throughTier: "one" } };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.match(warningsOf(result), /gates\.reviewer\.throughTier must be a positive integer/);
	assert.equal(result.ladder.gates.reviewer.throughTier, 1);
});

test("an explicit zero reviewer gate is refused, not accepted as gate-off", (t) => {
	const ladder = shipped();
	ladder.gates = { reviewer: { throughTier: 0 } };
	const file = writeLadder(t, ladder);
	const result = readLadder(file);
	assert.equal(result.source, "file");
	assert.match(warningsOf(result), /the gate cannot be disabled/);
	assert.equal(result.ladder.gates.reviewer.throughTier, 1);
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
		assert.ok(result.ladder);
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
