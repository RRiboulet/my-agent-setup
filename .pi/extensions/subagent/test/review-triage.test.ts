// Unit tests for the review-triage extension.
//
// The risks worth pinning here are the ones where a quiet bug changes a review
// decision rather than breaking a call:
//
//   - the config merge and the profile catalog, because a silently ignored field
//     or a wrongly pruned profile changes what Jev may choose;
//   - the evidence scan, because a missing signal is what makes Jev blind and a
//     false one is merely discounted;
//   - the forward/reverse Choice averaging, because Jev's first-option bias is
//     the documented failure mode and averaging is the fix;
//   - the skip gate and fallback policy, because "we skipped a review" and "we
//     invented a judgement" are the two failures this whole tool exists to
//     prevent.
//
// Everything is pure or mocked: no network, no git, no tmux.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	applyDotEnv,
	DEFAULT_CONFIG,
	DEFAULT_THINKING_LADDER,
	generateCatalog,
	loadConfig,
	parseProfile,
	profileKey,
	profileRank,
	type Candidate,
	type ProfileOption,
	type TriageConfig,
} from "../../review-triage/config.ts";
import {
	buildRangeCommand,
	collectEvidence,
	detectInstability,
	detectSignals,
	indicatorsFor,
	INSTABILITY_MARKERS,
	parseNumstatZ,
	parsePathListZ,
	parseRawZ,
	splitPatchByPath,
	toEvidenceItems,
	type GitExec,
} from "../../review-triage/evidence.ts";
import {
	askJudge,
	averageChoice,
	buildQuestions,
	JudgeError,
	parseJudgment,
	QUESTION_IDS,
	summarizeChoice,
	type Judgment,
	type TrackJudgment,
} from "../../review-triage/judge.ts";
import { buildDossier, type BuiltDossier } from "../../review-triage/dossier.ts";
import {
	clampThinking,
	composePlan,
	disabledPlan,
	failOpenPlan,
	resolveCandidates,
	resolveProfileModel,
	tierFromPrice,
	type AvailableModel,
	type ComposeArgs,
} from "../../review-triage/compose.ts";
import { decidePolicy, POLICY_REASONS, rationaleFor, type PolicyGates } from "../../review-triage/policy.ts";
import { formatPlan } from "../../review-triage/format.ts";
import { parseTriageArgs, resolveContext, resolveTarget } from "../../review-triage/index.ts";
import reviewTriageExtension from "../../review-triage/index.ts";
import type { ClassifierResult, ClassifierAnswer } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(overrides: Partial<TriageConfig> = {}): TriageConfig {
	return {
		...DEFAULT_CONFIG,
		judge: { ...DEFAULT_CONFIG.judge },
		thinkingLadder: {
			low: [...DEFAULT_THINKING_LADDER.low],
			medium: [...DEFAULT_THINKING_LADDER.medium],
			high: [...DEFAULT_THINKING_LADDER.high],
		},
		policy: { ...DEFAULT_CONFIG.policy },
		candidates: [],
		...overrides,
	};
}

const CANDIDATES: Candidate[] = [
	{ provider: "p", model: "cheap", tier: "low", cost: 0.1, description: "cheap" },
	{ provider: "p", model: "mid", tier: "medium", cost: 0.5, description: "mid" },
	{ provider: "p", model: "strong", tier: "high", cost: 2, description: "strong" },
];

const AVAILABLE: AvailableModel[] = [
	{
		provider: "p",
		id: "cheap",
		reasoning: true,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
	},
	{
		provider: "p",
		id: "mid",
		reasoning: true,
		cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { low: "low", medium: null, high: "high", max: "max" },
	},
	{
		provider: "p",
		id: "strong",
		reasoning: true,
		cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
		thinkingLevelMap: { low: "low", medium: null, high: "high", max: "xhigh" },
	},
];

const ALLOWED = ["low:low", "low:medium", "low:high", "medium:high", "medium:max", "high:high", "high:max"] as const;

function catalog(): ProfileOption[] {
	return generateCatalog({
		candidates: CANDIDATES,
		ladder: DEFAULT_THINKING_LADDER,
		available: AVAILABLE,
	}).options;
}

/** A minimal dossier for the judge tests: the judge now reads the dossier, not
 * a flat state, so every askJudge call needs one. */
function emptyDossier(): BuiltDossier {
	return buildDossier({ items: [], task: { summary: "x" }, scope: { target: "none" }, catalog: [] });
}

function gates(overrides: Partial<PolicyGates> = {}): PolicyGates {
	return { stable: true, conflicts: false, evidenceComplete: true, mandatoryReview: false, ...overrides };
}

function track(overrides: Partial<TrackJudgment> = {}): TrackJudgment {
	return {
		profiles: {},
		skipConfidence: 0.05,
		reviewAlternative: "high:max",
		routingConfidence: 0.4,
		choice: "high:max",
		choiceConfidence: 0.4,
		...overrides,
	};
}

function judgment(overrides: Partial<Judgment> = {}): Judgment {
	return {
		adversarial: track(),
		complexity: track(),
		judge: "openrouter/typesafe/jev-1.13",
		latencyMs: 500,
		...overrides,
	};
}

const EVIDENCE = { files: 3, added: 40, removed: 10, signals: ["changes error handling"] };

const PLAN_CONTEXT = {
	task: { summary: "add a thing" },
	scope: { target: "uncommitted", snapshot: "HEAD" },
	limitations: ["a known gap"],
	versions: { riskRules: "1" },
};

function compose(overrides: Partial<ComposeArgs> = {}) {
	return composePlan({
		judgment: judgment(),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		catalog: catalog(),
		gates: gates(),
		evidence: EVIDENCE,
		summary: "add a thing",
		context: PLAN_CONTEXT,
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config: defaults apply when no file exists", () => {
	const loaded = loadConfig({ path: "/nonexistent/review-triage.json", env: {} });
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.tool, true, "the tool is registered by default");
	assert.equal(loaded.judge.provider, "openrouter");
	assert.equal(loaded.judge.model, "typesafe/jev-1.13");
	assert.equal(loaded.reverseChoice, true);
	assert.equal(loaded.policy.skipThreshold, 0.9);
	assert.deepEqual(loaded.thinkingLadder, DEFAULT_THINKING_LADDER);
});

test("config: the tool switch is read from the file", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(path, JSON.stringify({ tool: false }));
	try {
		const loaded = loadConfig({ path, env: {} });
		assert.equal(loaded.tool, false);
		assert.equal(loaded.enabled, true, "turning the tool off leaves the command usable");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: a redaction block is parsed, and a bad rule warns instead of vanishing", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	const warnings: string[] = [];
	const collect = (message: string) => warnings.push(message);
	try {
		writeFileSync(
			path,
			JSON.stringify({
				redaction: { paths: ["src/auth/**", 7, ""], patterns: ["AKIA[0-9A-Z]{16}"], mask: "[gone]" },
			}),
		);
		assert.deepEqual(loadConfig({ path, env: {}, warn: collect }).redaction, {
			paths: ["src/auth/**"],
			patterns: ["AKIA[0-9A-Z]{16}"],
			mask: "[gone]",
		});
		assert.ok(
			warnings.some((warning) => warning.includes("non-string redaction.paths")),
			"a rule the owner wrote and the parser dropped is worth a warning",
		);

		// A wrong type for a whole field is ignored, loudly, rather than silently
		// disabling that half of the guard.
		writeFileSync(
			path,
			JSON.stringify({ redaction: { patterns: "AKIA", mask: [1], paths: ["src/auth/**"] } }),
		);
		warnings.length = 0;
		assert.deepEqual(loadConfig({ path, env: {}, warn: collect }).redaction, { paths: ["src/auth/**"] });
		assert.ok(warnings.some((warning) => warning.includes("redaction.patterns is not a list")));
		assert.ok(warnings.some((warning) => warning.includes("redaction.mask")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(
		loadConfig({ path: "/nonexistent/review-triage.json", env: {} }).redaction,
		undefined,
		"no block means nothing to hash differently",
	);
});

test("config: a file merges over defaults field by field", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(
		path,
		JSON.stringify({
			judge: { model: "typesafe/jev-latest", timeoutMs: 4000 },
			candidates: [{ provider: "x", model: "y", tier: "high", cost: 3.5, description: "best" }],
			thinkingLadder: { low: ["low", "high"] },
			policy: { skipThreshold: 0.95, fallbackProfile: "high:max" },
			stateChars: 9000,
		}),
	);
	try {
		const loaded = loadConfig({ path, env: {} });
		assert.equal(loaded.judge.model, "typesafe/jev-latest");
		assert.equal(loaded.judge.provider, "openrouter", "an unset field keeps the default");
		assert.equal(loaded.judge.timeoutMs, 4000);
		assert.equal(loaded.candidates.length, 1);
		assert.equal(loaded.candidates[0]?.cost, 3.5, "the cost must survive the config read");
		assert.deepEqual(loaded.thinkingLadder.low, ["low", "high"]);
		assert.deepEqual(loaded.thinkingLadder.medium, DEFAULT_THINKING_LADDER.medium, "unset bands keep defaults");
		assert.equal(loaded.policy.skipThreshold, 0.95);
		assert.equal(loaded.policy.fallbackProfile, "high:max");
		assert.equal(loaded.stateChars, 9000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: a candidate without cost is kept with cost 0, not dropped", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(
		path,
		JSON.stringify({ candidates: [{ provider: "x", model: "y", tier: "high", description: "best" }] }),
	);
	try {
		const loaded = loadConfig({ path, env: {}, warn: () => {} });
		assert.equal(loaded.candidates.length, 1, "an older config must not silently lose candidates");
		assert.equal(loaded.candidates[0]?.cost, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: a malformed file degrades to defaults and says so once", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(path, "{ not json");
	try {
		const warnings: string[] = [];
		const loaded = loadConfig({ path, env: {}, warn: (message) => warnings.push(message) });
		assert.equal(loaded.judge.model, DEFAULT_CONFIG.judge.model);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /malformed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: a missing file is silent", () => {
	const warnings: string[] = [];
	loadConfig({ path: "/nonexistent/review-triage.json", env: {}, warn: (m) => warnings.push(m) });
	assert.deepEqual(warnings, []);
});

test("config: environment overrides the file for the judge model", () => {
	const loaded = loadConfig({
		path: "/nonexistent/review-triage.json",
		env: { PI_REVIEW_TRIAGE_JUDGE_PROVIDER: "typesafe", PI_REVIEW_TRIAGE_JUDGE_MODEL: "jev-latest" },
	});
	assert.equal(loaded.judge.provider, "typesafe");
	assert.equal(loaded.judge.model, "jev-latest");
});

test("config: an unknown candidate tier warns and falls back to medium", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(
		path,
		JSON.stringify({ candidates: [{ provider: "x", model: "y", tier: "hight", cost: 1, description: "d" }] }),
	);
	try {
		const warnings: string[] = [];
		const loaded = loadConfig({ path, env: {}, warn: (m) => warnings.push(m) });
		assert.equal(loaded.candidates[0]?.tier, "medium");
		assert.ok(warnings.some((warning) => warning.includes("unknown tier")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: policy.mandatoryReview and an explicit empty ladder band are honoured", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(path, JSON.stringify({ policy: { mandatoryReview: true }, thinkingLadder: { low: [] } }));
	try {
		const loaded = loadConfig({ path, env: {}, warn: () => {} });
		assert.equal(loaded.policy.mandatoryReview, true);
		assert.deepEqual(loaded.thinkingLadder.low, [], "an empty band means never offer it");
		assert.deepEqual(loaded.thinkingLadder.medium, DEFAULT_THINKING_LADDER.medium);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dotenv: fills unset variables and never overwrites an existing one", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, ".env");
	writeFileSync(path, 'OPENROUTER_API_KEY="from-file"\nOTHER=plain\n# comment\n');
	try {
		const env: NodeJS.ProcessEnv = { OTHER: "already-set" };
		applyDotEnv(env, path);
		assert.equal(env.OPENROUTER_API_KEY, "from-file");
		assert.equal(env.OTHER, "already-set");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// profile catalog
// ---------------------------------------------------------------------------

test("catalog: profile keys parse, and malformed ones are rejected", () => {
	assert.deepEqual(parseProfile("medium:max"), { key: "medium:max", band: "medium", thinking: "max" });
	assert.equal(parseProfile("none"), undefined);
	assert.equal(parseProfile("ultra:high"), undefined);
	assert.equal(parseProfile("low:ultra"), undefined);
	assert.equal(parseProfile("low:high:extra"), undefined);
	assert.equal(profileKey("high", "max"), "high:max");
	// A weaker profile ranks below a stronger one in the same band.
	assert.ok(profileRank("medium:high") < profileRank("medium:max"));
	assert.ok(profileRank("low:high") < profileRank("medium:high"));
});

test("catalog: generates the allowed pairs and prunes an unsupported level", () => {
	const { options, pruned } = generateCatalog({
		candidates: CANDIDATES,
		ladder: DEFAULT_THINKING_LADDER,
		available: AVAILABLE,
	});
	assert.deepEqual(
		options.map((option) => option.key),
		[...ALLOWED],
		"the allowed set is exactly the seven generated pairs",
	);
	// `medium` is null in glm-5.3-flash's runtime map, so medium:medium is not offered.
	assert.deepEqual(pruned.map((entry) => entry.key), ["medium:medium"]);
	assert.match(pruned[0]?.note ?? "", /unsupported/);
	assert.equal(options.some((option) => option.key === "medium:medium"), false);
});

test("catalog: a band model with no runtime map is kept unverified and noted", () => {
	const { options, notes, pruned } = generateCatalog({
		candidates: [
			{ provider: "p", model: "mimo", tier: "low", cost: 0.14, description: "low" },
			...CANDIDATES.slice(1),
		],
		ladder: DEFAULT_THINKING_LADDER,
		available: [{ provider: "p", id: "mimo" }, ...AVAILABLE.slice(1)],
	});
	assert.ok(options.some((option) => option.key === "low:medium"), "an unverifiable level is kept");
	assert.equal(pruned.some((entry) => entry.key.startsWith("low:")), false);
	assert.ok(notes.some((note) => note.includes("no runtime thinking map")));
});

test("catalog: the catalogue cost fills in when the candidate states none", () => {
	const { options } = generateCatalog({
		candidates: [CANDIDATES[0], { ...CANDIDATES[1], cost: 0 }, CANDIDATES[2]],
		ladder: DEFAULT_THINKING_LADDER,
		available: AVAILABLE,
	});
	const medium = options.find((option) => option.key === "medium:high");
	assert.equal(medium?.cost, 0.5, "the medium band's catalogue rate is used");
	assert.match(medium?.description ?? "", /Cost 0\.5/);
});

test("catalog: a band with no available model is not offered", () => {
	const { options, notes } = generateCatalog({
		candidates: CANDIDATES,
		ladder: DEFAULT_THINKING_LADDER,
		available: AVAILABLE.filter((model) => model.id !== "strong"),
	});
	assert.equal(options.some((option) => option.key.startsWith("high:")), false);
	assert.ok(notes.some((note) => note.includes("no available high-band model")));
});

test("catalog: pruning follows the model the band will resolve to", () => {
	// Two candidates in one band: the first available one is the one compose
	// will pick, so the prune must judge that model, not a sibling that happens
	// to support a level the chosen model rejects.
	const { options } = generateCatalog({
		candidates: [
			{ provider: "p", model: "a", tier: "medium", cost: 1, description: "a" },
			{ provider: "p", model: "b", tier: "medium", cost: 2, description: "b" },
		],
		ladder: DEFAULT_THINKING_LADDER,
		available: [
			{ provider: "p", id: "a", thinkingLevelMap: { medium: null, high: null, max: "max" } },
			{ provider: "p", id: "b", thinkingLevelMap: { medium: "medium", high: "high", max: "max" } },
		],
	});
	assert.deepEqual(options.map((option) => option.key), ["medium:max"]);
});

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

test("evidence: numstat -z sums churn and keeps binary files", () => {
	const parsed = parseNumstatZ("10\t2\tsrc/a.ts\u00005\t0\tsrc/b.ts\u0000-\t-\timage.png\u0000");
	assert.deepEqual(
		parsed.map((entry) => entry.path),
		["src/a.ts", "src/b.ts", "image.png"],
	);
	assert.equal(parsed.reduce((sum, entry) => sum + entry.added, 0), 15);
	assert.equal(parsed.reduce((sum, entry) => sum + entry.removed, 0), 2);
	assert.equal(parsed[2]?.binary, true, "`-`/`-` marks a binary file");
});

test("evidence: raw -z splits additions and deletions, renames take the destination", () => {
	const raw = [
		":000000 100644 0000000 aaa A\0src/new.ts\0",
		":100644 000000 aaa 0000000 D\0src/old.ts\0",
		":100644 100644 aaa bbb M\0src/mod.ts\0",
		":100644 100644 aaa bbb R100\0src/a.ts\0src/b.ts\0",
	].join("");
	const parsed = parseRawZ(raw);
	assert.deepEqual(
		parsed.filter((entry) => entry.status.startsWith("A")).map((entry) => entry.path),
		["src/new.ts"],
	);
	assert.deepEqual(
		parsed.filter((entry) => entry.status.startsWith("D")).map((entry) => entry.path),
		["src/old.ts"],
	);
	const rename = parsed.find((entry) => entry.status.startsWith("R"));
	assert.equal(rename?.path, "src/b.ts");
	assert.equal(rename?.oldPath, "src/a.ts");
});

test("evidence: filenames with spaces, newlines and a leading dash round-trip", () => {
	const weird = ["sp ace.txt", "new\nline.txt", "-leading.txt"];
	const numstat = weird.map((path, index) => `${index + 1}\t0\t${path}\0`).join("");
	assert.deepEqual(
		parseNumstatZ(numstat).map((entry) => entry.path),
		weird,
	);
	const raw = weird
		.map((path, index) => `:000000 100644 0000000 aaa${index} A\0${path}\0`)
		.join("");
	assert.deepEqual(
		parseRawZ(raw).map((entry) => entry.path),
		weird,
	);
	assert.deepEqual(parsePathListZ(weird.map((path) => `${path}\0`).join("")), weird);
});

test("evidence: indicators are derived from modes, status and binary counts", () => {
	const raw = [
		":100644 100755 aaa bbb M\0script.sh\0",
		":100644 120000 aaa bbb T\0link\0",
		":000000 160000 0000000 bbb A\0sub\0",
		":100644 000000 aaa 0000000 D\0gone.ts\0",
		":100644 100644 aaa bbb U\0conflict.ts\0",
	].join("");
	const byPath = Object.fromEntries(parseRawZ(raw).map((entry) => [entry.path, entry]));
	assert.equal(indicatorsFor(byPath["script.sh"]!, false).modeChange, true);
	assert.equal(indicatorsFor(byPath["link"]!, false).symlink, true);
	assert.equal(indicatorsFor(byPath["sub"]!, false).submodule, true);
	assert.equal(indicatorsFor(byPath["gone.ts"]!, false).deletion, true);
	assert.equal(indicatorsFor(byPath["conflict.ts"]!, false).conflict, true);
	assert.equal(indicatorsFor(byPath["script.sh"]!, true).binary, true);
	assert.equal(indicatorsFor(byPath["script.sh"]!, false).deletion, undefined);
	// A newly-added file has no old mode; that is not a mode change.
	assert.equal(indicatorsFor(byPath["sub"]!, false).modeChange, undefined);
	assert.equal(indicatorsFor(byPath["gone.ts"]!, false).modeChange, undefined);
});

test("evidence: the security path label fires on auth, not on unrelated paths", () => {
	assert.ok(detectSignals(["src/auth/session.ts"], "", 1, 1).some((s) => s.includes("authentication")));
	assert.ok(!detectSignals(["src/util/format.ts"], "", 1, 1).some((s) => s.includes("authentication")));
});

test("evidence: signals read the patch, not just the paths", () => {
	const patch = [
		"@@ -1,2 +1,3 @@",
		"+import { spawn } from \"node:child_process\"",
		"+const res = await fetch(url)",
		"+export function run() {}",
		"-try {",
		"+try {",
	].join("\n");
	const signals = detectSignals(["src/x.ts"], patch, 4, 1);
	assert.ok(signals.some((s) => s.includes("process execution")));
	assert.ok(signals.some((s) => s.includes("network boundary")));
	assert.ok(signals.some((s) => s.includes("public export surface")));
	assert.ok(signals.some((s) => s.includes("error handling")));
});

test("evidence: large churn and many files are labelled", () => {
	const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
	const signals = detectSignals(files, "", 500, 10);
	assert.ok(signals.some((s) => s.includes("large change")));
	assert.ok(signals.some((s) => s.includes("many files")));
});

test("evidence: a -z rename keeps its destination and re-labels the security path", () => {
	const parsed = parseNumstatZ("0\t0\t\0src/util/helper.ts\0src/auth/helper.ts\0");
	assert.deepEqual(
		parsed.map((entry) => entry.path),
		["src/auth/helper.ts"],
	);
	assert.ok(detectSignals(parsed.map((entry) => entry.path), "", 0, 0).some((s) => s.includes("authentication")));
});

test("evidence: raw -z keep-list includes rename destinations", () => {
	const parsed = parseRawZ(":100644 100644 aaa bbb R100\0src/util/helper.ts\0src/auth/helper.ts\0:000000 100644 0000000 ccc A\0src/new.ts\0");
	assert.deepEqual(
		parsed.filter((entry) => entry.status.startsWith("R")).map((entry) => entry.path),
		["src/auth/helper.ts"],
	);
	assert.deepEqual(
		parsed.filter((entry) => entry.status.startsWith("A")).map((entry) => entry.path),
		["src/new.ts"],
	);
});

test("evidence: a file header alone must not manufacture a signal", () => {
	assert.deepEqual(detectSignals(["src/spawn.ts"], "+++ b/src/spawn.ts\n--- a/src/spawn.ts\n", 0, 0), []);
});

test("evidence: a .sql file triggers the migration label", () => {
	assert.ok(detectSignals(["queries/orders.sql"], "", 1, 0).some((s) => s.includes("migration")));
});

test("evidence: collectEvidence takes a -z rename's destination", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("--numstat")) return { stdout: "0\t0\t\0src/util/h.ts\0src/auth/h.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw") && !key.includes("--diff-filter=U")) {
			return { stdout: ":100644 100644 aaa bbb R100\0src/util/h.ts\0src/auth/h.ts\0", stderr: "", code: 0 };
		}
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "move a file", target: { kind: "uncommitted" } });
	assert.deepEqual(evidence.files, ["src/auth/h.ts"]);
	assert.equal(evidence.indicators["src/auth/h.ts"]?.binary, undefined);
});

test("evidence: the range command matches the target", () => {
	assert.deepEqual(buildRangeCommand({ kind: "uncommitted" }, ["--numstat"]), ["diff", "--numstat", "HEAD"]);
	assert.deepEqual(buildRangeCommand({ kind: "branch", base: "dev" }, ["--numstat"]), [
		"diff",
		"--numstat",
		"dev...HEAD",
	]);
	assert.deepEqual(buildRangeCommand({ kind: "commit", ref: "abc" }, ["--numstat"]), [
		"show",
		"--numstat",
		"--format=",
		"abc",
	]);
	assert.equal(buildRangeCommand({ kind: "none" }, ["--numstat"]), undefined);
	assert.equal(buildRangeCommand({ kind: "branch" }, ["--numstat"]), undefined);
});

test("evidence: uncommitted collection includes NUL-listed untracked files", async () => {
	const calls: string[] = [];
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key.includes("--numstat")) return { stdout: "3\t1\tsrc/a.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw") && !key.includes("--diff-filter=U")) {
			return { stdout: ":100644 100644 aaa bbb M\0src/a.ts\0", stderr: "", code: 0 };
		}
		if (key.includes("--unified=0")) return { stdout: "+const x = 1;\n", stderr: "", code: 0 };
		if (key.includes("ls-files")) return { stdout: "src/brand-new.ts\0", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "add a thing", target: { kind: "uncommitted" } });
	assert.equal(evidence.isGit, true);
	assert.deepEqual(evidence.files, ["src/a.ts", "src/brand-new.ts"]);
	assert.deepEqual(evidence.newFiles, ["src/brand-new.ts"]);
	assert.equal(evidence.added, 3);
	const untracked = evidence.artifacts.find((artifact) => artifact.path === "src/brand-new.ts");
	assert.equal(untracked?.completeness, "missing", "an untracked file is listed but its extent is unknown");
	assert.equal(untracked?.status, "A");
	assert.ok(
		evidence.limitations.some((limitation) => limitation.blocksSkip && limitation.text.includes("untracked file(s)")),
		"unread untracked content must be recorded and must block skip",
	);
});

test("evidence: a failed secondary probe is recorded as a skip-blocking limitation", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("--numstat")) return { stdout: "1\t0\tsrc/a.ts\0", stderr: "", code: 0 };
		if (key.includes("--diff-filter=U")) return { stdout: "", stderr: "boom", code: 128 };
		if (key.includes("--raw")) return { stdout: ":100644 100644 aaa bbb M\0src/a.ts\0", stderr: "", code: 0 };
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" } });
	assert.ok(
		evidence.limitations.some((limitation) => limitation.blocksSkip && limitation.text.includes("conflict probe")),
		"a failed conflict probe must not read as 'no conflicts'",
	);
});

test("evidence: a failed raw read still yields per-file measurements from numstat", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("--numstat")) return { stdout: "2\t1\tsrc/a.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw") && !key.includes("--diff-filter=U")) {
			return { stdout: "", stderr: "boom", code: 128 };
		}
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" } });
	assert.deepEqual(
		evidence.artifacts.map((artifact) => artifact.path),
		["src/a.ts"],
		"a failed raw read must not empty the manifest",
	);
	assert.equal(evidence.artifacts[0]?.added, 2);
});

test("evidence: a truncated patch is recorded as a limitation", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("--numstat")) return { stdout: "1\t0\tsrc/a.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw") && !key.includes("--diff-filter=U")) {
			return { stdout: ":100644 100644 aaa bbb M\0src/a.ts\0", stderr: "", code: 0 };
		}
		if (key.includes("--unified=0")) return { stdout: "x".repeat(100), stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" }, patchChars: 10 });
	assert.ok(evidence.limitations.some((limitation) => limitation.text.includes("truncated")));
});

test("evidence: a phantom empty path from a truncated buffer is dropped", () => {
	assert.deepEqual(parseNumstatZ("0\t0\t\u0000only\u0000"), []);
	assert.deepEqual(parseRawZ(":100644 100644 aaa bbb R100\u0000only\u0000"), []);
});

test("evidence: a content line that starts with pluses is not mistaken for a header", () => {
	// Adding the text `++fetch(url)` produces the diff line `+++fetch(url)`; the
	// old filter dropped every line starting `+++`, hiding the signal.
	const patch = ["+++ b/x.ts", "--- a/x.ts", "+++fetch(url)"].join("\n");
	assert.ok(detectSignals(["src/x.ts"], patch, 1, 0).some((s) => s.includes("network boundary")));
});

test("evidence: the collector only issues read-only git commands", async () => {
	const commands: string[] = [];
	const exec: GitExec = async (_command, args) => {
		commands.push(args.join(" "));
		return { stdout: "", stderr: "", code: 0 };
	};
	await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" } });
	// A collector that stashed, reset or checked out would change what it is
	// supposed to be observing; the index must be left exactly as found.
	const mutating = /(^|\s)(stash|reset|checkout|commit|add|restore|clean|switch)(\s|$)/u;
	for (const command of commands) {
		assert.doesNotMatch(command, mutating, `read-only collector issued: ${command}`);
	}
});

test("evidence: a git failure degrades to a usable state with the reason attached", async () => {
	const exec: GitExec = async () => ({ stdout: "", stderr: "not a git repository", code: 128 });
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" } });
	assert.equal(evidence.isGit, false);
	assert.match(evidence.error ?? "", /not a git repository/);
	assert.equal(evidence.summary, "x");
});

test("evidence: a merge commit's empty diff is explained, not silently empty", async () => {
	const exec: GitExec = async () => ({ stdout: "", stderr: "", code: 0 });
	const evidence = await collectEvidence(exec, { summary: "merge", target: { kind: "commit", ref: "abc" } });
	assert.match(evidence.error ?? "", /merge commit/);
});

// ---------------------------------------------------------------------------
// task scope and snapshot stability (§6)
// ---------------------------------------------------------------------------

function stableExec(untracked = ""): { exec: GitExec; commands: string[] } {
	const commands: string[] = [];
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		commands.push(key);
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (key.includes("--diff-filter=U")) return { stdout: "", stderr: "", code: 0 };
		if (key.includes("--numstat")) return { stdout: "2\t1\tsrc/task.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw")) return { stdout: ":100644 100644 aaa bbb M\0src/task.ts\0", stderr: "", code: 0 };
		if (key.includes("--unified=0")) return { stdout: "+x\n-x\n", stderr: "", code: 0 };
		return { stdout: untracked, stderr: "", code: 0 };
	};
	return { exec, commands };
}

test("evidence: the task scope diffs the baseline ref, never HEAD", async () => {
	const { exec, commands } = stableExec();
	const evidence = await collectEvidence(exec, {
		summary: "did the task",
		target: { kind: "task", baselineRef: "abc123" },
		fsExists: () => false,
	});
	assert.equal(evidence.error, undefined);
	assert.equal(evidence.target, "task");
	assert.equal(evidence.baseline, "abc123");
	assert.equal(evidence.unstable, false);
	for (const marker of ["--numstat", "--raw", "--unified=0"]) {
		const command = commands.find((issued) => issued.includes(marker));
		assert.ok(command, `a ${marker} command was issued`);
		assert.match(command, /abc123/u, "the range is the task's baseline");
		assert.doesNotMatch(command, /HEAD/u, "pre-existing dirty work must not be attributed to the task");
	}
});

test("evidence: the task scope lists untracked files but cannot baseline them", async () => {
	const { exec, commands } = stableExec("src/new.ts\0");
	const evidence = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "task", baselineRef: "abc123" },
		fsExists: () => false,
	});
	assert.deepEqual(evidence.newFiles, ["src/new.ts"]);
	const slug = evidence.limitations.find((limitation) => limitation.text.includes("cannot be attributed"));
	assert.ok(slug, "the attribution caveat is recorded");
	assert.equal(slug.blocksSkip, false, "it is an attribution caveat, not missing evidence");
	assert.ok(commands.every((issued) => !issued.includes("git show")), "the task scope never uses git show");
});

test("evidence: a task scope without a baseline fails the scope, and takes no diff", async () => {
	const { exec, commands } = stableExec();
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "task" } });
	assert.match(evidence.error ?? "", /baseline ref/u);
	assert.ok(!commands.some((issued) => issued.includes("--numstat")), "no diff was taken");
	assert.equal(evidence.unstable, false, "nothing was inspected, so nothing was unstable");
});

test("evidence: an in-progress merge marks the snapshot unstable", async () => {
	const { exec } = stableExec();
	const evidence = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "uncommitted" },
		fsExists: (path) => path.endsWith("MERGE_HEAD"),
	});
	assert.equal(evidence.unstable, true);
	assert.ok(evidence.limitations.some((limitation) => limitation.text.includes("a merge is in progress")));
	assert.ok(
		!evidence.limitations.some((limitation) => limitation.blocksSkip && limitation.text.includes("unstable")),
		"instability is its own gate, not a borrowed incompleteness",
	);
});

test("evidence: a probe that throws refuses to read as stable, and says so once", async () => {
	const { exec } = stableExec();
	const evidence = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "uncommitted" },
		fsExists: () => {
			throw new Error("eproperm");
		},
	});
	assert.equal(evidence.unstable, true);
	assert.equal(
		evidence.limitations.filter((limitation) => limitation.text.includes("stability probe")).length,
		1,
		"two probes, one failure record",
	);
});

test("evidence: stability that cannot be located reads as unstable", async () => {
	const commands: string[] = [];
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		commands.push(key);
		if (key.includes("rev-parse")) return { stdout: "", stderr: "", code: 0 };
		if (key.includes("--numstat")) return { stdout: "1\t0\tsrc/a.ts\0", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "x", target: { kind: "uncommitted" } });
	assert.equal(evidence.unstable, true);
	assert.equal(evidence.error, undefined, "the diffs still read; only stability failed");
});

test("evidence: a quiet .git reads as stable", async () => {
	const { exec } = stableExec();
	const evidence = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "uncommitted" },
		fsExists: () => false,
	});
	assert.equal(evidence.unstable, false);
});

test("evidence: a numstat failure still carries the stability facts", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("numstat")) return { stdout: "", stderr: "lock contention", code: 128 };
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "uncommitted" },
		fsExists: (path) => path.endsWith("index.lock"),
	});
	assert.ok(evidence.error, "the inspection failed");
	assert.equal(evidence.unstable, true, "stability is verified before the diff is trusted");
	assert.ok(evidence.limitations.some((limitation) => limitation.text.includes("the git index is locked")));
});

test("evidence: an unstable empty-commit inspection still carries its stability facts", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (key.includes("--raw")) return { stdout: "", stderr: "unreadable", code: 128 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, {
		summary: "merge",
		target: { kind: "commit", ref: "abc" },
		fsExists: (path) => path.endsWith("MERGE_HEAD"),
	});
	assert.ok(evidence.error);
	assert.equal(evidence.unstable, true);
	assert.ok(evidence.limitations.some((limitation) => limitation.text.includes("a merge is in progress")));
});

test("evidence: committed work since the baseline is caveated as attributed, and only for the task scope", async () => {
	const { exec } = stableExec();
	const task = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "task", baselineRef: "abc123" },
		fsExists: () => false,
	});
	assert.ok(
		task.limitations.some((limitation) => limitation.text.includes("commits that landed on the branch for other reasons")),
	);
	const uncommitted = await collectEvidence(exec, {
		summary: "x",
		target: { kind: "uncommitted" },
		fsExists: () => false,
	});
	assert.ok(
		!uncommitted.limitations.some((limitation) => limitation.text.includes("commits that landed on the branch for other reasons")),
		"the caveat names a baseline; the default scope has none",
	);
});

test("evidence: every instability marker route is named and matched", () => {
	assert.ok(INSTABILITY_MARKERS.some((marker) => marker.file === "rebase-merge" && /rebase/u.test(marker.reason)));
	assert.ok(INSTABILITY_MARKERS.some((marker) => marker.file === "index.lock"));
	for (const marker of INSTABILITY_MARKERS) {
		const probed = detectInstability("/git", (path) => path === `/git/${marker.file}`);
		assert.deepEqual(probed, { reasons: [marker.reason], failed: false });
	}
	const probed = detectInstability("/git", () => false);
	assert.deepEqual(probed, { reasons: [], failed: false });
});

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

function classifierResult(
	answers: Record<string, ClassifierAnswer>,
	extra: Partial<ClassifierResult> = {},
): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		answers,
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	} as unknown as ClassifierResult;
}

const ADV_PROBS: Record<string, number> = {
	none: 0.05,
	"low:low": 0.02,
	"low:medium": 0.03,
	"low:high": 0.05,
	"medium:high": 0.1,
	"medium:max": 0.1,
	"high:high": 0.25,
	"high:max": 0.4,
};
const CX_PROBS: Record<string, number> = {
	none: 0.55,
	"low:low": 0.1,
	"low:medium": 0.1,
	"low:high": 0.05,
	"medium:high": 0.05,
	"medium:max": 0.05,
	"high:high": 0.05,
	"high:max": 0.05,
};

function reverseOf(record: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(record).reverse());
}

function fullAnswers(overrides: Record<string, ClassifierAnswer> = {}): Record<string, ClassifierAnswer> {
	return {
		[QUESTION_IDS.adversarialProfile]: { type: "choice", choice: "high:max", probabilities: ADV_PROBS, confidence: 0.4 },
		[QUESTION_IDS.adversarialProfileReversed]: {
			type: "choice",
			choice: "high:max",
			probabilities: reverseOf(ADV_PROBS),
			confidence: 0.4,
		},
		[QUESTION_IDS.complexityProfile]: { type: "choice", choice: "none", probabilities: CX_PROBS, confidence: 0.55 },
		[QUESTION_IDS.complexityProfileReversed]: {
			type: "choice",
			choice: "none",
			probabilities: reverseOf(CX_PROBS),
			confidence: 0.55,
		},
		...overrides,
	};
}

test("judge: the batch offers none plus every profile, each Choice in both orders", () => {
	const options = catalog();
	const questions = buildQuestions(config(), options);
	assert.equal(Object.keys(questions).length, 4);
	const forward = questions[QUESTION_IDS.adversarialProfile];
	const reverse = questions[QUESTION_IDS.adversarialProfileReversed];
	assert.equal(forward.type, "choice");
	assert.equal(reverse.type, "choice");
	if (forward.type === "choice" && reverse.type === "choice") {
		assert.deepEqual(Object.keys(forward.criteria), ["none", ...options.map((option) => option.key)]);
		assert.deepEqual(Object.keys(reverse.criteria), Object.keys(forward.criteria).reverse());
	}
});

test("judge: reverseChoice:false asks two questions and needs no reverse answer", () => {
	const questions = buildQuestions(config({ reverseChoice: false }), catalog());
	assert.equal(Object.keys(questions).length, 2, "the reversed pairs must not be sent and paid for");
	assert.equal(QUESTION_IDS.adversarialProfileReversed in questions, false);

	const forwardOnly = { ...fullAnswers() };
	delete forwardOnly[QUESTION_IDS.adversarialProfileReversed];
	delete forwardOnly[QUESTION_IDS.complexityProfileReversed];
	const parsed = parseJudgment(classifierResult(forwardOnly), config({ reverseChoice: false }), 5);
	assert.equal(parsed.adversarial.reviewAlternative, "high:max");
});

test("judge: a missing answer is a malformed judge error, not a zero", () => {
	const result = classifierResult({
		[QUESTION_IDS.adversarialProfile]: { type: "choice", choice: "high:max", probabilities: { "high:max": 1 }, confidence: 0.9 },
	});
	assert.throws(() => parseJudgment(result, config(), 10), (error: unknown) => {
		return error instanceof JudgeError && error.failure === "malformed";
	});
});

test("judge: averaging cancels a first-option lean", () => {
	const averaged = averageChoice(
		{ probabilities: { cheap: 0.8, strong: 0.2 }, confidence: 0.8 },
		{ probabilities: { cheap: 0.2, strong: 0.8 }, confidence: 0.8 },
	);
	assert.equal(averaged.probabilities.cheap, 0.5);
	assert.equal(averaged.probabilities.strong, 0.5);
	assert.ok(averaged.confidence <= 0.5, "a split must not read as confident");
});

test("judge: both orders agreeing raises confidence", () => {
	const averaged = averageChoice(
		{ probabilities: { cheap: 0.9, strong: 0.1 }, confidence: 0.9 },
		{ probabilities: { cheap: 0.85, strong: 0.15 }, confidence: 0.85 },
	);
	assert.equal(averaged.choice, "cheap");
	assert.ok(averaged.confidence > 0.85);
});

test("judge: derived fields come from the one distribution, not extra questions", () => {
	const parsed = parseJudgment(classifierResult(fullAnswers()), config(), 123);
	const near = (actual: number, expected: number, label: string) =>
		assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !~ ${expected}`);
	near(parsed.adversarial.skipConfidence, 0.05, "adversarial P(none)");
	near(parsed.complexity.skipConfidence, 0.55, "complexity P(none)");
	assert.equal(parsed.adversarial.reviewAlternative, "high:max");
	near(parsed.adversarial.routingConfidence, 0.4, "adversarial routing");
	assert.equal(parsed.complexity.reviewAlternative, "low:low");
	assert.equal(parsed.adversarial.choice, "high:max");
	assert.equal(parsed.complexity.choice, "none");
	assert.equal(parsed.latencyMs, 123);
	// The judge is never asked for free text; nothing here fabricates one.
	assert.equal("rationale" in parsed.adversarial, false);
});

test("judge: summarizeChoice keeps every profile and treats none as the skip signal", () => {
	const summary = summarizeChoice({
		choice: "none",
		confidence: 0.91,
		probabilities: { none: 0.91, "high:max": 0.05, "high:high": 0.04 },
	});
	assert.equal(summary.skipConfidence, 0.91);
	assert.equal(summary.reviewAlternative, "high:max");
	assert.equal(summary.routingConfidence, 0.05);
	assert.equal(summary.choice, "none");
});

test("judge: a zero-mass profile is not an endorsement", () => {
	const summary = summarizeChoice({
		choice: "none",
		confidence: 1,
		probabilities: { none: 1, "high:max": 0 },
	});
	assert.equal(summary.reviewAlternative, undefined, "zero mass must not read as a pick");
	assert.equal(summary.routingConfidence, 0);
});

test("judge: records the judge's token usage with the right field names", () => {
	const result = classifierResult(fullAnswers(), {
		usage: { input: 966, output: 215, totalTokens: 1181, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00004 } } as never,
	});
	const parsed = parseJudgment(result, config(), 10);
	assert.equal(parsed.usage?.inputTokens, 966);
	assert.equal(parsed.usage?.outputTokens, 215);
	assert.equal(parsed.usage?.cost, 0.00004);
});

test("judge: an abort is its own failure, not a reason to fail open", async () => {
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async () => ({ ...classifierResult(fullAnswers()), stopReason: "aborted" }),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), emptyDossier(), catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "aborted",
	);
});

test("judge: an absent classifier model fails as unavailable", async () => {
	const registry = { findOfType: () => undefined, classify: async () => classifierResult(fullAnswers()) };
	await assert.rejects(
		() => askJudge(registry as never, config(), emptyDossier(), catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "unavailable",
	);
});

test("judge: a provider error becomes a JudgeError, never a silent judgement", async () => {
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async () => ({ ...classifierResult(fullAnswers()), stopReason: "error", errorMessage: "boom" }),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), emptyDossier(), catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "error",
	);
});

test("judge: the state Jev receives is the dossier itself", async () => {
	let seen: Record<string, unknown> | undefined;
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async (_model: unknown, context: { state: Record<string, unknown> }) => {
			seen = context.state;
			return classifierResult(fullAnswers());
		},
	};
	const built = emptyDossier();
	await askJudge(registry as never, config(), built, catalog());
	assert.equal(
		(seen as { scope?: { target?: string } } | undefined)?.scope?.target,
		"none",
		"Jev is handed the dossier itself, not a second serialization",
	);
	assert.ok("manifest" in (seen ?? {}), "the dossier's sections are what Jev sees");
});

// ---------------------------------------------------------------------------
// dossier adapter
// ---------------------------------------------------------------------------

const ADAPTER_EVIDENCE = {
	target: "uncommitted" as const,
	isGit: true,
	files: ["src/a.ts", "src/b.ts"],
	added: 3,
	removed: 1,
	newFiles: [],
	deletedFiles: [],
	indicators: { "src/a.ts": { modeChange: true } },
	artifacts: [
		{ path: "src/a.ts", added: 2, removed: 1, status: "M", binary: false },
		{ path: "src/b.ts", added: 1, removed: 0, status: "M", binary: false },
	],
	limitations: [{ text: "a gap in the evidence", blocksSkip: true }],
	signals: ["changes error handling"],
	notes: ["on-disk format changed"],
	summary: "a change",
	patchExcerpt: [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 111..222 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1 +1 @@",
		"-old line",
		"+new line",
		"diff --git a/src/b.ts b/src/b.ts",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/src/b.ts",
		"@@ -0,0 +1 @@",
		"+fresh",
	].join("\n"),
	truncated: false,
	unstable: false,
};

test("adapter: splitPatchByPath keys each hunk by its file", () => {
	const split = splitPatchByPath(ADAPTER_EVIDENCE.patchExcerpt);
	assert.equal(split.size, 2);
	assert.match(split.get("src/a.ts") ?? "", /-old line/u);
	assert.match(split.get("src/b.ts") ?? "", /\+fresh/u, "a new file's patch comes from its +++ line");
});

test("adapter: toEvidenceItems emits one artifact item per file with its own patch", () => {
	const items = toEvidenceItems(ADAPTER_EVIDENCE);
	const artifacts = items.filter((item) => item.kind === "artifact-change");
	assert.equal(artifacts.length, 2);
	const a = artifacts.find((item) => item.path === "src/a.ts");
	assert.equal(a?.added, 2);
	assert.equal(a?.removed, 1);
	assert.match(a?.patch ?? "", /-old line/u);
	assert.deepEqual(a?.flags, { modeChange: true });
	assert.ok(items.some((item) => item.kind === "risk-signal" && item.signal === "changes error handling"));
	assert.ok(items.some((item) => item.kind === "limitation" && item.text.includes("a gap")));
});

test("adapter: the same evidence through the adapter gives the same dossier fingerprint", () => {
	const build = () =>
		buildDossier({
			items: toEvidenceItems(ADAPTER_EVIDENCE),
			task: { summary: "a change" },
			scope: { target: "uncommitted", snapshot: "abc" },
			catalog: [],
		});
	assert.equal(build().fingerprint, build().fingerprint);
	assert.match(build().fingerprint, /^[0-9a-f]{64}$/u);
});

test("adapter: a patch section with no recoverable path is recorded, not silently lost", () => {
	const evidence = {
		...ADAPTER_EVIDENCE,
		artifacts: [{ path: "src/a.ts", added: 0, removed: 0, status: "M", binary: false }],
		patchExcerpt: "diff --git malformed-header\n@@ -1 +1 @@\n-x\n+y\n",
	};
	const items = toEvidenceItems(evidence);
	assert.ok(
		items.some((item) => item.kind === "limitation" && item.text.includes("could not be attributed")),
		"an unattributable patch section must be recorded as a limitation",
	);
});

test("adapter: a pure rename attributes to its new path, a binary from its diff header", () => {
	const patch = [
		"diff --git a/old-name.ts b/new-name.ts",
		"similarity index 100%",
		"rename from old-name.ts",
		"rename to new-name.ts",
		"diff --git a/logo.png b/logo.png",
		"index 111..222 100644",
		"Binary files a/logo.png and b/logo.png differ",
	].join("\n");
	const split = splitPatchByPath(patch);
	assert.ok(split.has("new-name.ts"), "a pure rename is attributed to its new path");
	assert.ok(split.has("logo.png"), "a headerless binary change is attributed from its diff line");
});

test("adapter: a truncated excerpt says later files may carry no patch", () => {
	const items = toEvidenceItems({ ...ADAPTER_EVIDENCE, truncated: true });
	assert.ok(
		items.some((item) => item.kind === "limitation" && item.text.includes("truncated")),
		"a cut excerpt must record that later files have no per-file patch",
	);
});

const PIPELINE_CANDIDATES = [
	{ provider: "p", model: "cheap", tier: "low", cost: 0.1, description: "cheap" },
	{ provider: "p", model: "mid", tier: "medium", cost: 0.5, description: "mid" },
	{ provider: "p", model: "strong", tier: "high", cost: 2, description: "strong" },
];

interface PipelinePlan {
	fingerprint?: string;
	status?: string;
	policyOverrides?: { skipThreshold?: number; mandatoryReview?: boolean };
	task?: { summary?: string; objective?: string; identity?: string };
	scope?: { target?: string; snapshot?: string };
	limitations?: string[];
	versions?: Record<string, string>;
	adversarial?: {
		needed?: boolean;
		reasonCodes?: string[];
		calibration?: string;
		requestedThinking?: string;
		resolvedThinking?: string;
		rationale?: string;
		task?: string;
	};
	complexity?: { needed?: boolean };
}

/** Run `fn` with a temp agent dir, so `loadConfig` sees only the given config. */
async function withAgentDir<T>(config: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "review-triage-agent-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "review-triage.json"), JSON.stringify(config));
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

interface FakeTool {
	name?: string;
	execute?: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ details: unknown }>;
}

interface FakePi {
	tools: FakeTool[];
	commands: Map<string, { handler: (args: string | undefined, ctx: unknown) => Promise<void> }>;
	appended: {
		type: string;
		entry: { fingerprint?: string; plan?: PipelinePlan; evidence?: { files?: string[] } };
	}[];
	messages: string[];
	notifications: string[];
}

/** A mock extension host: it records registrations and effects, and runs nothing. */
function fakePi(exec: GitExec): FakePi & Record<string, unknown> {
	const tools: FakeTool[] = [];
	const commands = new Map<string, { handler: (args: string | undefined, ctx: unknown) => Promise<void> }>();
	const appended: FakePi["appended"] = [];
	const messages: string[] = [];
	const notifications: string[] = [];
	return {
		tools,
		commands,
		appended,
		messages,
		notifications,
		registerTool: (definition: FakeTool) => {
			tools.push(definition);
		},
		registerCommand: (
			name: string,
			definition: { handler: (args: string | undefined, ctx: unknown) => Promise<void> },
		) => {
			commands.set(name, definition);
		},
		appendEntry: (type: string, entry: { fingerprint?: string }) => {
			appended.push({ type, entry });
		},
		exec,
		sendUserMessage: (message: string) => {
			messages.push(message);
		},
	};
}

function fakeCtx(answers: Record<string, ClassifierAnswer>, notifications: string[]): Record<string, unknown> {
	return {
		modelRegistry: {
			getAvailable: () => AVAILABLE,
			findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
			classify: async () => classifierResult(answers),
		},
		cwd: "/repo",
		signal: undefined,
		hasUI: false,
		ui: { notify: (message: string) => notifications.push(message) },
	};
}

/**
 * Drive the registered tool once, with a temp agent dir so `loadConfig` sees no
 * stray user config. Returns the tool result's details, every appended session
 * entry, and the mock host.
 */
async function runPipeline(options: {
	exec: GitExec;
	answers: Record<string, ClassifierAnswer>;
	params?: Record<string, unknown>;
	config?: Record<string, unknown>;
}): Promise<{
	details: { fingerprint?: string; plan?: PipelinePlan };
	appended: FakePi["appended"];
	pi: FakePi;
}> {
	const pi = fakePi(options.exec);
	return withAgentDir(options.config ?? { candidates: PIPELINE_CANDIDATES }, async () => {
		reviewTriageExtension(pi as never);
		assert.ok(pi.tools[0]?.execute, "the extension registered the tool");
		const result = await pi.tools[0].execute(
			"id",
			{ summary: "wire the dossier", target: "uncommitted", ...(options.params ?? {}) },
			undefined,
			undefined,
			fakeCtx(options.answers, pi.notifications),
		);
		return { details: result.details as never, appended: pi.appended, pi };
	});
}

test("wiring: the session entry carries the dossier fingerprint", async () => {
	const { details, appended } = await runPipeline({ exec: stableExec().exec, answers: fullAnswers() });
	assert.match(details.fingerprint ?? "", /^[0-9a-f]{64}$/u, "the run records a dossier fingerprint");
	assert.equal(details.plan?.fingerprint, details.fingerprint, "the plan records the same fingerprint");
	const entry = appended.find((item) => item.type === "review-triage");
	assert.equal(entry?.entry.fingerprint, details.fingerprint, "the session entry carries it too");
});

test("wiring: the session entry persists the published recommendation fields", async () => {
	const { details, appended } = await runPipeline({ exec: stableExec().exec, answers: fullAnswers() });
	const plan = details.plan;
	assert.equal(plan?.status, "recommended");
	assert.equal(plan?.scope?.target, "uncommitted");
	assert.equal(plan?.scope?.snapshot, "uncommitted", "one snapshot identity for items and scope");
	assert.equal(plan?.task?.summary, "wire the dossier");
	assert.deepEqual(plan?.policyOverrides, { skipThreshold: 0.9, mandatoryReview: false });
	assert.equal(plan?.versions?.plan, "1");
	assert.equal(plan?.versions?.riskRules, "1");
	assert.equal(plan?.adversarial?.calibration, "uncalibrated");
	assert.ok(
		plan?.limitations?.some((limitation) => limitation.includes("no validation results were supplied")),
		"an empty validation section says so rather than reading as 'everything passed'",
	);

	// The entry persists the plan itself, so every published field survives.
	const entry = appended.find((item) => item.type === "review-triage")?.entry as { plan?: PipelinePlan };
	assert.deepEqual(entry?.plan, plan, "the persisted plan is the published plan");
});

/** Answers that put almost all the mass on `none`, so the gates are what refuse. */
function skipEverythingAnswers(): Record<string, ClassifierAnswer> {
	const skipProbs: Record<string, number> = {
		none: 0.99,
		"low:low": 0.005,
		"low:medium": 0.002,
		"low:high": 0.001,
		"medium:high": 0.001,
		"medium:max": 0.0005,
		"high:high": 0.0005,
		"high:max": 0.0005,
	};
	const choice = (probabilities: Record<string, number>): ClassifierAnswer => ({
		type: "choice",
		choice: "none",
		probabilities,
		confidence: 0.99,
	});
	return {
		[QUESTION_IDS.adversarialProfile]: choice(skipProbs),
		[QUESTION_IDS.adversarialProfileReversed]: choice(reverseOf(skipProbs)),
		[QUESTION_IDS.complexityProfile]: choice(skipProbs),
		[QUESTION_IDS.complexityProfileReversed]: choice(reverseOf(skipProbs)),
	};
}

test("wiring: a dossier that overflows cannot skip, even at P(none)=0.99", async () => {
	// 201 files overflow the 200-entry manifest limit, so the dossier is
	// incomplete and the skip gate must refuse regardless of the judge's answer.
	const files = Array.from({ length: 201 }, (_, i) => `src/file-${i}.ts`);
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (key.includes("--diff-filter=U")) return { stdout: "", stderr: "", code: 0 };
		if (key.includes("--numstat")) {
			return { stdout: `${files.map((path) => `1\t0\t${path}`).join("\0")}\0`, stderr: "", code: 0 };
		}
		if (key.includes("--raw")) {
			return {
				stdout: files.map((path) => `:100644 100644 aaa bbb M\0${path}\0`).join(""),
				stderr: "",
				code: 0,
			};
		}
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const answers = skipEverythingAnswers();
	const { details } = await runPipeline({ exec, answers });
	assert.equal(details.plan?.adversarial?.needed, true, "an incomplete dossier cannot skip");
	assert.ok(
		details.plan?.adversarial?.reasonCodes?.includes("incomplete-evidence"),
		"the reason says the evidence was incomplete",
	);
	assert.equal(details.plan?.complexity?.needed, true);
});

// ---------------------------------------------------------------------------
// Pi adapter: command primary, tool behind a switch
// ---------------------------------------------------------------------------

test("adapter: tool:false drops the tool but keeps the command as the entry point", async () => {
	const pi = fakePi(stableExec().exec);
	await withAgentDir({ tool: false }, () => {
		reviewTriageExtension(pi as never);
	});
	assert.deepEqual(pi.tools, [], "the tool is not registered when it is switched off");
	assert.deepEqual([...pi.commands.keys()], ["triage"], "the command is still the primary entry point");
});

test("adapter: a disabled extension registers no tool, but keeps the command", async () => {
	const pi = fakePi(stableExec().exec);
	await withAgentDir({ enabled: false }, () => {
		reviewTriageExtension(pi as never);
	});
	assert.deepEqual(pi.tools, [], "a disabled extension does not pay the tool's prompt weight");
	assert.deepEqual([...pi.commands.keys()], ["triage"], "the command still explains that it is disabled");
});

test("adapter: the tool is registered by default", async () => {
	const pi = fakePi(stableExec().exec);
	await withAgentDir({}, () => {
		reviewTriageExtension(pi as never);
	});
	assert.deepEqual(pi.tools.map((tool) => tool.name), ["triage_change"]);
	assert.deepEqual([...pi.commands.keys()], ["triage"]);
});

test("adapter: registration touches nothing but the tool and command slots", async () => {
	const pi = fakePi(stableExec().exec);
	const touched: string[] = [];
	const observed = new Proxy(pi, {
		get(target, property) {
			if (typeof property === "string") touched.push(property);
			return Reflect.get(target, property);
		},
	});
	await withAgentDir({}, () => {
		reviewTriageExtension(observed as never);
	});
	assert.deepEqual(
		[...new Set(touched)].sort(),
		["registerCommand", "registerTool"],
		"no event subscription, reviewer launch, model switch or test run",
	);
});

test("adapter: the command produces the structured plan and appends the session entry", async () => {
	const pi = fakePi(stableExec().exec);
	await withAgentDir({ candidates: PIPELINE_CANDIDATES }, async () => {
		reviewTriageExtension(pi as never);
		const command = pi.commands.get("triage");
		assert.ok(command, "the command is registered");
		await command.handler('uncommitted --summary "wire the dossier"', fakeCtx(fullAnswers(), pi.notifications));
	});
	assert.equal(pi.messages.length, 1, "one user message");
	assert.match(pi.messages[0] ?? "", /Review triage — /u);
	const entry = pi.appended.find((item) => item.type === "review-triage");
	assert.match(entry?.entry.fingerprint ?? "", /^[0-9a-f]{64}$/u, "the command persists the structured entry");
	assert.deepEqual(pi.notifications, [], "no error was reported");
});

test("adapter: caller-supplied collector inputs reach the dossier", async () => {
	const withContext = await runPipeline({
		exec: stableExec().exec,
		answers: fullAnswers(),
		params: {
			context: JSON.stringify({
				validations: [{ check: "node --test", outcome: "failed", provenance: "bash", ranAt: Date.now() }],
				harness: {
					objective: "wire the collectors",
					identity: "TODO-aed9dd5e",
					unresolvedIssues: ["one test is flaky"],
				},
			}),
		},
	});
	const without = await runPipeline({ exec: stableExec().exec, answers: fullAnswers() });
	assert.notEqual(
		withContext.details.fingerprint,
		without.details.fingerprint,
		"the supplied context is part of the judged dossier",
	);
	assert.equal(withContext.details.plan?.task?.objective, "wire the collectors");
	assert.equal(withContext.details.plan?.task?.identity, "TODO-aed9dd5e");
	assert.ok(
		withContext.details.plan?.limitations?.some((limitation) => limitation.includes("flaky")),
		"an unresolved issue is recorded as a limitation",
	);
	assert.ok(
		!withContext.details.plan?.limitations?.some((limitation) => limitation.includes("no validation results")),
		"a supplied validation result silences the absence note",
	);
	assert.ok(
		without.details.plan?.limitations?.some((limitation) => limitation.includes("no validation results")),
		"without results the absence note is present",
	);
});

test("adapter: a supplied-but-dropped validation does not also claim nothing was supplied", async () => {
	const dropped = await runPipeline({
		exec: stableExec().exec,
		answers: fullAnswers(),
		params: { context: JSON.stringify({ validations: [{ outcome: "passed" }] }) },
	});
	const limitations = dropped.details.plan?.limitations ?? [];
	assert.ok(
		limitations.some((limitation) => limitation.includes("without a usable check name")),
		"the collector explains the drop",
	);
	assert.ok(
		!limitations.some((limitation) => limitation.includes("no validation results were supplied")),
		"the absence note would contradict the drop record",
	);
});

test("command: --context names a JSON file, and a bad payload warns instead of throwing", () => {
	const parsed = parseTriageArgs("uncommitted --context /tmp/ctx.json");
	assert.equal(parsed.contextPath, "/tmp/ctx.json");
	assert.equal(parsed.context, undefined);

	const missing = resolveContext({ summary: "x", contextPath: "/nonexistent/ctx.json" });
	assert.equal(missing.artifacts, undefined);
	assert.ok(missing.warnings.some((warning) => warning.includes("could not be read")));

	const bad = resolveContext({ summary: "x", context: "{not json" });
	assert.equal(bad.validations, undefined);
	assert.ok(bad.warnings.some((warning) => warning.includes("not valid JSON")));

	const wrongShape = resolveContext({ summary: "x", context: "[1,2]" });
	assert.ok(wrongShape.warnings.some((warning) => warning.includes("must be a JSON object")));

	const resolved = resolveContext({
		summary: "x",
		context: JSON.stringify({ validations: [{ check: "t", outcome: "failed" }], harness: { identity: "T1" } }),
	});
	assert.equal(resolved.validations?.length, 1);
	assert.equal(resolved.harness?.identity, "T1");
	assert.deepEqual(resolved.warnings, []);
});

test("adapter: an undeclared tool param cannot reach the pipeline", async () => {
	// The schema declares `context`, not `contextPath`; a smuggled path must not
	// make the pipeline read a file.
	const pi = fakePi(stableExec().exec);
	await withAgentDir({ candidates: PIPELINE_CANDIDATES }, async () => {
		reviewTriageExtension(pi as never);
		const tool = pi.tools[0];
		assert.ok(tool?.execute);
		const result = await tool.execute(
			"id",
			{ summary: "x", target: "uncommitted", contextPath: "/etc/hostname" },
			undefined,
			undefined,
			fakeCtx(fullAnswers(), pi.notifications),
		);
		const details = result.details as { plan?: PipelinePlan };
		assert.ok(
			!details.plan?.limitations?.some((limitation) => limitation.includes("could not be read")),
			"the smuggled path was ignored",
		);
	});
});

test("adapter: the command reads a context file into the dossier", async () => {
	const pi = fakePi(stableExec().exec);
	const dir = mkdtempSync(join(tmpdir(), "review-triage-ctx-"));
	const contextPath = join(dir, "context.json");
	writeFileSync(
		contextPath,
		JSON.stringify({
			validations: [{ check: "node --test", outcome: "passed", provenance: "bash" }],
			harness: { objective: "read the context file", identity: "TODO-ctx" },
		}),
	);
	try {
		await withAgentDir({ candidates: PIPELINE_CANDIDATES }, async () => {
			reviewTriageExtension(pi as never);
			const command = pi.commands.get("triage");
			assert.ok(command, "the command is registered");
			await command.handler(
				`uncommitted --summary "read it" --context ${contextPath}`,
				fakeCtx(fullAnswers(), pi.notifications),
			);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const entry = pi.appended.find((item) => item.type === "review-triage")?.entry as { plan?: PipelinePlan };
	assert.equal(entry?.plan?.task?.objective, "read the context file");
	assert.ok(
		!entry?.plan?.limitations?.some((limitation) => limitation.includes("no validation results")),
		"a supplied validation result silences the absence note",
	);
});

test("adapter: a bad context payload becomes a limitation, not a failed run", async () => {
	const bad = await runPipeline({
		exec: stableExec().exec,
		answers: fullAnswers(),
		params: { context: "{not json" },
	});
	assert.ok(
		bad.details.plan?.limitations?.some((limitation) => limitation.includes("not valid JSON")),
		"a bad context is recorded, not swallowed",
	);
});

test("wiring: a configured redaction keeps the excluded path out of the plan", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (key.includes("--diff-filter=U")) return { stdout: "", stderr: "", code: 0 };
		if (key.includes("--numstat")) return { stdout: "1\t0\tsrc/auth/secret.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw")) {
			return { stdout: ":100644 100644 aaa bbb M\0src/auth/secret.ts\0", stderr: "", code: 0 };
		}
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const { details, appended } = await runPipeline({
		exec,
		answers: fullAnswers(),
		config: { candidates: PIPELINE_CANDIDATES, redaction: { paths: ["src/auth/**"] } },
	});
	const limitations = details.plan?.limitations ?? [];
	assert.ok(limitations.some((limitation) => limitation.includes("paths withheld")));
	assert.ok(
		!limitations.some((limitation) => limitation.includes("src/auth/secret.ts")),
		"the excluded path must never reach the plan",
	);
	const entry = appended.find((item) => item.type === "review-triage")?.entry;
	assert.ok(
		!(entry?.evidence?.files ?? []).some((path) => path.includes("src/auth/secret.ts")),
		"the session entry's evidence list must not carry the withheld path either",
	);
});

test("wiring: a path redaction refuses skip even at P(none)=0.99", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key.includes("rev-parse")) return { stdout: "/repo/.git\n", stderr: "", code: 0 };
		if (key.includes("--diff-filter=U")) return { stdout: "", stderr: "", code: 0 };
		if (key.includes("--numstat")) return { stdout: "1\t0\tsrc/auth/secret.ts\0", stderr: "", code: 0 };
		if (key.includes("--raw")) {
			return { stdout: ":100644 100644 aaa bbb M\0src/auth/secret.ts\0", stderr: "", code: 0 };
		}
		if (key.includes("--unified=0")) return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const { details } = await runPipeline({
		exec,
		answers: skipEverythingAnswers(),
		config: { candidates: PIPELINE_CANDIDATES, redaction: { paths: ["src/auth/**"] } },
	});
	assert.equal(details.plan?.adversarial?.needed, true, "a redacted dossier cannot skip");
	assert.ok(details.plan?.adversarial?.reasonCodes?.includes("incomplete-evidence"));
});

test("wiring: a masked summary is what the rendered task and the entry carry", async () => {
	const { details, appended } = await runPipeline({
		exec: stableExec().exec,
		answers: fullAnswers(),
		config: { candidates: PIPELINE_CANDIDATES, redaction: { patterns: ["wire"], mask: "[gone]" } },
	});
	assert.match(details.plan?.task?.summary ?? "", /\[gone\]/);
	assert.match(details.plan?.adversarial?.task ?? "", /\[gone\]/, "the subagent task uses the masked summary");
	assert.doesNotMatch(
		details.plan?.adversarial?.task ?? "",
		/wire/u,
		"the raw summary must not survive in the task the plan renders",
	);
	const entry = appended.find((item) => item.type === "review-triage")?.entry;
	assert.match(entry?.plan?.adversarial?.task ?? "", /\[gone\]/, "the persisted task is masked too");
});

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

const policyConfig = { ...DEFAULT_CONFIG.policy };

test("policy: P(none) of exactly 0.90 cannot skip; 0.91 with every gate still can", () => {
	const atThreshold = decidePolicy({
		judgment: { skipConfidence: 0.9, reviewAlternative: "high:max" },
		gates: gates(),
		config: policyConfig,
		catalog: [...ALLOWED],
	});
	assert.equal(atThreshold.skip, false, "the comparison is strictly greater");
	assert.ok(atThreshold.reasonCodes.includes(POLICY_REASONS.skipBelowThreshold));

	const above = decidePolicy({
		judgment: { skipConfidence: 0.91, reviewAlternative: "high:max" },
		gates: gates(),
		config: policyConfig,
		catalog: [...ALLOWED],
	});
	assert.equal(above.skip, true);
	assert.equal(above.status, "skipped");
	assert.equal(above.source, "none");
});

test("policy: a high P(none) still cannot skip when any single gate fails", () => {
	const cases: Array<[Partial<PolicyGates>, string]> = [
		[{ stable: false }, POLICY_REASONS.unstableSnapshot],
		[{ conflicts: true }, POLICY_REASONS.unresolvedConflicts],
		[{ evidenceComplete: false }, POLICY_REASONS.incompleteEvidence],
		[{ mandatoryReview: true }, POLICY_REASONS.mandatoryReview],
	];
	for (const [gate, code] of cases) {
		const decision = decidePolicy({
			judgment: { skipConfidence: 0.99, reviewAlternative: "high:max" },
			gates: gates(gate),
			config: policyConfig,
			catalog: [...ALLOWED],
		});
		assert.equal(decision.skip, false, `${code} must keep the review`);
		assert.ok(decision.reasonCodes.includes(code), `${code} must be recorded`);
		assert.equal(decision.status, "recommended", "a refused skip still uses Jev's alternative");
		assert.equal(decision.profile, "high:max");
	}
});

test("policy: a refused skip with no usable alternative falls to the minimum profile", () => {
	const decision = decidePolicy({
		judgment: { skipConfidence: 0.5, reviewAlternative: "not-in-catalog" },
		gates: gates(),
		config: policyConfig,
		catalog: [...ALLOWED],
	});
	assert.equal(decision.skip, false);
	assert.equal(decision.status, "fallback");
	assert.equal(decision.source, "policy-fallback");
	assert.equal(decision.profile, "low:low", "the weakest catalog entry is the floor");
	assert.ok(decision.reasonCodes.includes(POLICY_REASONS.policyFallback));
});

test("policy: a judge failure never skips and is marked policy-fallback", () => {
	const decision = decidePolicy({
		failure: "timeout",
		gates: gates(),
		config: policyConfig,
		catalog: [...ALLOWED],
	});
	assert.equal(decision.skip, false);
	assert.equal(decision.status, "fallback");
	assert.equal(decision.source, "policy-fallback");
	assert.equal(decision.profile, "high:max", "the strongest catalog entry is the conservative default");
	assert.ok(decision.reasonCodes.includes(POLICY_REASONS.judgeFailure));
});

test("policy: a configured conservative profile is honoured on failure", () => {
	const decision = decidePolicy({
		failure: "unavailable",
		gates: gates(),
		config: { ...policyConfig, fallbackProfile: "medium:high" },
		catalog: [...ALLOWED],
	});
	assert.equal(decision.profile, "medium:high");
});

test("policy: nothing resolves to unavailable, never a fictional model", () => {
	const decision = decidePolicy({
		failure: "unavailable",
		gates: gates(),
		config: policyConfig,
		catalog: [],
	});
	assert.equal(decision.skip, false);
	assert.equal(decision.status, "unavailable");
	assert.equal("profile" in decision, false);
	assert.ok(decision.reasonCodes.includes(POLICY_REASONS.noProfileAvailable));
});

test("policy: an empty catalog cannot skip even at P(none)=1", () => {
	// A broken model registry must not read as a confident "no review".
	const decision = decidePolicy({
		judgment: { skipConfidence: 1, reviewAlternative: undefined },
		gates: gates(),
		config: policyConfig,
		catalog: [],
	});
	assert.equal(decision.skip, false);
	assert.equal(decision.status, "unavailable");
});

test("policy: mandatoryReview refuses skip whatever the probabilities say", () => {
	const decision = decidePolicy({
		judgment: { skipConfidence: 1, reviewAlternative: "high:max" },
		gates: gates({ mandatoryReview: true }),
		config: policyConfig,
		catalog: [...ALLOWED],
	});
	assert.equal(decision.skip, false);
	assert.equal(decision.profile, "high:max");
	assert.ok(decision.reasonCodes.includes(POLICY_REASONS.mandatoryReview));
});

test("policy: a missing judgement on the normal path refuses skip and falls back", () => {
	const decision = decidePolicy({ gates: gates(), config: policyConfig, catalog: [...ALLOWED] });
	assert.equal(decision.skip, false);
	assert.equal(decision.status, "fallback");
	assert.ok(decision.reasonCodes.includes(POLICY_REASONS.noJudgement));
});

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

test("compose: tierFromPrice buckets by catalogue price", () => {
	assert.equal(tierFromPrice(0.2), "low");
	assert.equal(tierFromPrice(3), "medium");
	assert.equal(tierFromPrice(30), "high");
	assert.equal(tierFromPrice(undefined), "medium");
});

test("compose: resolveCandidates prefers config, else buckets the available models", () => {
	assert.deepEqual(resolveCandidates(config({ candidates: CANDIDATES }), AVAILABLE), CANDIDATES);
	const synthesized = resolveCandidates(
		config(),
		[
			{ provider: "p", id: "a", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } as never },
			{ provider: "p", id: "b", cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } as never },
			{ provider: "p", id: "c", cost: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 } as never },
		],
	);
	assert.deepEqual(
		synthesized.map((c) => c.tier),
		["low", "medium", "high"],
	);
	assert.deepEqual(synthesized.map((c) => c.cost), [0.1, 3, 20], "the catalogue cost travels with the candidate");
});

test("compose: thinking is clamped for a model that cannot reason", () => {
	assert.equal(clampThinking("high", { provider: "p", id: "m", reasoning: false }), "off");
	assert.equal(clampThinking("high", { provider: "p", id: "m", reasoning: true }), "high");
	assert.equal(
		clampThinking("high", { provider: "p", id: "m", thinkingLevelMap: { high: null, medium: "m", low: "l" } }),
		"medium",
	);
});

test("compose: a profile resolves to its band's available model", () => {
	const resolved = resolveProfileModel({ profile: "medium:max", candidates: CANDIDATES, available: AVAILABLE });
	assert.equal(resolved.model?.model, "mid");
	assert.equal(resolved.model?.tier, "medium");
	assert.deepEqual(resolved.notes, []);
});

test("compose: a profile whose band has no available model resolves to nothing", () => {
	const resolved = resolveProfileModel({
		profile: "high:max",
		candidates: CANDIDATES,
		available: AVAILABLE.filter((model) => model.id !== "strong"),
	});
	assert.equal(resolved.model, undefined);
	assert.ok(resolved.notes.some((note) => note.includes("no available high-band model")));
});

test("compose: a recommended plan uses the profile's model and thinking verbatim", () => {
	const plan = compose();
	assert.equal(plan.verdict, "adversarial + complexity");
	assert.equal(plan.adversarial.needed, true);
	assert.equal(plan.adversarial.proposedChoice, "high:max");
	assert.equal(plan.adversarial.finalChoice, "high:max");
	assert.equal(plan.adversarial.routingConfidence, 0.4);
	assert.equal(plan.adversarial.model?.model, "strong");
	assert.equal(plan.adversarial.requestedThinking, "max");
	assert.equal(plan.adversarial.resolvedThinking, "max");
	assert.equal(plan.adversarial.calibration, "uncalibrated");
	assert.equal(plan.adversarial.status, "recommended");
	assert.equal(plan.adversarial.source, "jev");
	assert.ok(plan.adversarial.task?.includes("falsify"), "the adversarial task must be hostile");
	assert.ok(plan.complexity.task?.includes("over-engineered"));
});

test("compose: the plan publishes its status, policy, task, scope, limitations and versions", () => {
	const plan = compose();
	assert.equal(plan.status, "recommended");
	assert.deepEqual(plan.policyOverrides, { skipThreshold: 0.9, mandatoryReview: false });
	assert.deepEqual(plan.task, { summary: "add a thing" });
	assert.deepEqual(plan.scope, { target: "uncommitted", snapshot: "HEAD" });
	assert.deepEqual(plan.limitations, ["a known gap"]);
	assert.equal(plan.versions.plan, "1");
	assert.equal(plan.versions.riskRules, "1");
});

test("compose: the plan status is the best actionable outcome, not the worst", () => {
	// A genuine recommendation survives the other track failing to resolve; the
	// per-track status is where that degradation is visible.
	const mixed = compose({
		judgment: judgment({ adversarial: track({ reviewAlternative: "medium:max" }) }),
		available: AVAILABLE.filter((model) => model.id !== "strong"),
	});
	assert.equal(mixed.adversarial.status, "recommended");
	assert.equal(mixed.complexity.status, "unavailable");
	assert.equal(mixed.status, "recommended");

	// A judge failure marks both tracks as policy fallbacks.
	assert.equal(compose({ failure: "timeout" }).status, "fallback");

	// Both tracks skipped is the only skipped plan.
	const skipped = compose({
		judgment: judgment({
			adversarial: track({ skipConfidence: 0.99, choice: "none" }),
			complexity: track({ skipConfidence: 0.99, choice: "none" }),
		}),
	});
	assert.equal(skipped.status, "skipped");
});

test("compose: the policy in force is published with the decision", () => {
	const plan = compose({
		config: config({ policy: { skipThreshold: 0.5, mandatoryReview: true, minimumProfile: "low:low" } }),
		gates: gates({ mandatoryReview: true }),
	});
	assert.deepEqual(plan.policyOverrides, {
		skipThreshold: 0.5,
		mandatoryReview: true,
		minimumProfile: "low:low",
	});

	// Mandatory review keeps the track even at P(none)=0.99.
	const mandatory = compose({
		config: config({ policy: { skipThreshold: 0.9, mandatoryReview: true } }),
		gates: gates({ mandatoryReview: true }),
		judgment: judgment({
			adversarial: track({ skipConfidence: 0.99, choice: "none" }),
			complexity: track({ skipConfidence: 0.99, choice: "none" }),
		}),
	});
	assert.notEqual(mandatory.status, "skipped");
	assert.ok(mandatory.adversarial.reasonCodes.includes(POLICY_REASONS.mandatoryReview));
});

test("rationale: every published sentence is a template over reasonCodes, never Jev's prose", () => {
	assert.equal(
		rationaleFor([POLICY_REASONS.skipConfidence, POLICY_REASONS.gatesPassed]),
		"the judged probability of no review cleared the threshold; every skip gate passed.",
	);
	// An unknown code is carried through verbatim rather than dropped.
	assert.match(rationaleFor(["new-code"]), /new-code/u);
	assert.equal(rationaleFor([]), "no specific reason was recorded.");

	// The plan's rationale is exactly the template for its codes: no free text
	// from the judge can reach it.
	const plan = compose();
	assert.equal(plan.adversarial.rationale, rationaleFor(plan.adversarial.reasonCodes));
	assert.equal(plan.complexity.rationale, rationaleFor(plan.complexity.reasonCodes));
	// And a failed judge still produces a rationale from its (policy) codes.
	assert.equal(compose({ failure: "timeout" }).adversarial.rationale, rationaleFor(["judge-failure", "policy-fallback"]));
});

test("compose: a chosen profile's request survives the model failing to resolve", () => {
	const plan = compose({ available: [] });
	assert.equal(plan.adversarial.status, "unavailable");
	assert.equal(plan.adversarial.requestedThinking, "max", "the request is published, not conflated with off");
	assert.equal(plan.adversarial.resolvedThinking, undefined, "nothing ran, so nothing resolved");
});

test("compose: a needed review that cannot resolve is not published as 'no review'", () => {
	const plan = compose({ available: [] });
	assert.equal(plan.status, "unavailable");
	assert.equal(plan.verdict, "no review (no review model resolved)");
	assert.match(formatPlan(plan), /no review \(no review model resolved\) \[unavailable\]/);
});

test("compose: an over-long answer key is bounded, never published whole", () => {
	const plan = compose({ judgment: judgment({ adversarial: track({ reviewAlternative: "x".repeat(500) }) }) });
	assert.ok(
		plan.adversarial.proposedChoice.length <= 80,
		"a model-controlled key must not bloat the published plan",
	);
});

test("compose: a withheld redaction is published without the excluded value", () => {
	const built = buildDossier({
		items: [
			{
				source: "git",
				kind: "artifact-change",
				provenance: "p",
				snapshot: "s",
				completeness: "complete",
				trust: "observed",
				path: "src/auth/secret.ts",
				added: 1,
				removed: 0,
			},
		],
		task: { summary: "x" },
		scope: { target: "uncommitted" },
		catalog: [],
		redaction: { paths: ["src/auth/**"] },
	});
	// The same merge index.ts performs: the plan publishes the dossier's
	// limitations and exclusions.
	const plan = compose({
		context: {
			task: built.dossier.task,
			scope: built.dossier.scope,
			limitations: [...new Set([...built.dossier.limitations, ...built.dossier.exclusions])],
			versions: built.dossier.versions,
		},
	});
	assert.ok(plan.limitations.some((limitation) => limitation.includes("paths withheld")));
	assert.ok(
		!plan.limitations.some((limitation) => limitation.includes("src/auth/secret.ts")),
		"publishing the excluded path would defeat the redaction",
	);
});

test("compose: unstable evidence cannot skip, even with a high P(none)", () => {
	const plan = compose({
		judgment: judgment({
			adversarial: track({ skipConfidence: 0.99, choice: "none" }),
			complexity: track({ skipConfidence: 0.99, choice: "none" }),
		}),
		gates: { stable: false, conflicts: false, evidenceComplete: true, mandatoryReview: false },
	});
	assert.notEqual(plan.adversarial.status, "skipped");
	assert.ok(plan.adversarial.reasonCodes.includes(POLICY_REASONS.unstableSnapshot));
});

test("compose: a plan where policy allows skip needs no task or model", () => {
	const plan = compose({
		judgment: judgment({
			adversarial: track({ skipConfidence: 0.99, choice: "none" }),
			complexity: track({ skipConfidence: 0.95, choice: "none" }),
		}),
	});
	assert.equal(plan.verdict, "no review");
	assert.equal(plan.adversarial.needed, false);
	assert.equal(plan.adversarial.proposedChoice, "none", "a skip proposes none");
	assert.equal(plan.adversarial.status, "skipped");
	assert.equal(plan.adversarial.model, undefined);
	assert.equal(plan.adversarial.task, undefined);
});

test("compose: a profile the model cannot actually run is logged, not silently changed", () => {
	// A hand-built catalog entry that the runtime map rejects: policy still
	// resolves it, and the clamp must announce the change rather than lie.
	const forged: ProfileOption[] = [
		{ key: "medium:medium", band: "medium", thinking: "medium", description: "forged", model: { provider: "p", model: "mid" } },
	];
	const plan = compose({
		judgment: judgment({ adversarial: track({ reviewAlternative: "medium:medium" }) }),
		catalog: forged,
	});
	assert.equal(plan.adversarial.finalChoice, "medium:medium");
	assert.equal(plan.adversarial.model?.model, "mid");
	assert.equal(plan.adversarial.resolvedThinking, "low", "the clamp walks down to a supported level");
	assert.equal(plan.adversarial.requestedThinking, "medium", "the request is still published");
	assert.ok(plan.adversarial.notes.some((note) => note.includes("clamps it to low")));
});

test("compose: a plan with no catalog reports unavailable, never a fictional model", () => {
	const plan = compose({ catalog: [] });
	assert.equal(plan.adversarial.status, "unavailable");
	assert.equal(plan.adversarial.needed, true);
	assert.equal(plan.adversarial.model, undefined);
	assert.equal(plan.adversarial.task, undefined);
});

test("compose: fail-open routes through policy and is marked as a fallback", () => {
	const plan = failOpenPlan({
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		catalog: catalog(),
		gates: gates(),
		evidence: EVIDENCE,
		summary: "x",
		context: PLAN_CONTEXT,
		reason: "timeout",
	});
	assert.equal(plan.adversarial.needed, true);
	assert.equal(plan.adversarial.status, "fallback");
	assert.equal(plan.adversarial.source, "policy-fallback");
	assert.equal(plan.adversarial.finalChoice, "high:max");
	assert.ok(plan.verdict.includes("judge unavailable"));
});

test("compose: a disabled extension says so instead of judging", () => {
	const plan = disabledPlan(EVIDENCE, config().policy);
	assert.equal(plan.verdict, "disabled (review-triage is off)");
	assert.equal(plan.adversarial.needed, false);
	assert.equal(plan.adversarial.reasonCodes.includes("disabled"), true);
	assert.equal(plan.judge, "disabled");
});

test("format: the rendered plan names the profile, thinking level and model", () => {
	const text = formatPlan(compose());
	assert.match(text, /Review triage/);
	assert.match(text, /profile high:max/);
	assert.match(text, /thinking max/);
	assert.match(text, /p\/strong/);
	assert.match(text, /falsify/);
});

test("format: a skipped plan says not needed with the skip confidence", () => {
	const text = formatPlan(
		compose({
			judgment: judgment({
				adversarial: track({ skipConfidence: 0.99, choice: "none" }),
				complexity: track({ skipConfidence: 0.95, choice: "none" }),
			}),
		}),
	);
	assert.match(text, /not needed \(P\(none\) 0\.99\)/);
});

test("format: the rendered plan carries the status, rationale, fingerprint and limitations", () => {
	const text = formatPlan(compose({ fingerprint: "a".repeat(64) }));
	assert.match(text, /Review triage — adversarial \+ complexity \[recommended\]/);
	assert.match(text, /because: .*the judge preferred a review profile.*\[.*review-alternative.*\]/);
	assert.match(text, /Dossier aaaaaaaaaaaa…/);
	assert.match(text, /Limitations: a known gap/);
	assert.doesNotMatch(text, /\u001b\[/u, "plain text, no escape codes");
});

test("format: the rendered limitation list is bounded", () => {
	const text = formatPlan(
		compose({
			context: {
				task: { summary: "add a thing" },
				scope: { target: "uncommitted", snapshot: "HEAD" },
				limitations: Array.from({ length: 9 }, (_, i) => `gap ${i}`),
				versions: { riskRules: "1" },
			},
		}),
	);
	assert.match(text, /Limitations: gap 0; gap 1; gap 2; gap 3; gap 4; \+4 more/);
	assert.doesNotMatch(text, /gap 8/u, "the transcript shows a bounded sample");
});

// ---------------------------------------------------------------------------
// acceptance properties
// ---------------------------------------------------------------------------

test("acceptance: a filename that looks like an instruction is never copied into a signal", () => {
	// Signals are fixed labels plus integers; untrusted text must not reach them.
	const signals = detectSignals(["rm -rf / # export const x = 1"], "", 0, 0);
	assert.ok(signals.every((signal) => !signal.includes("rm -rf")));
});

test("acceptance: composing a plan is pure and renders reason codes as plain text", () => {
	const adversarial = track({ skipConfidence: 0.5, reviewAlternative: "not-in-catalog" });
	const first = compose({ judgment: judgment({ adversarial }) });
	const second = compose({ judgment: judgment({ adversarial }) });
	assert.deepEqual(first, second, "the same judgement yields the same plan");
	const text = formatPlan(first);
	assert.match(text, /policy-fallback/);
	assert.doesNotMatch(text, /\u001b\[/u, "plain text, no escape codes");
});

// ---------------------------------------------------------------------------
// command parsing
// ---------------------------------------------------------------------------

test("command: the task scope resolves a baseline from args or config", () => {
	assert.deepEqual(resolveTarget(parseTriageArgs("task abc123")), { kind: "task", baselineRef: "abc123" });
	assert.deepEqual(resolveTarget(parseTriageArgs("task"), "dev~2"), { kind: "task", baselineRef: "dev~2" });
	assert.deepEqual(resolveTarget(parseTriageArgs("task")), { kind: "task" }, "no silent HEAD fallback");
	assert.deepEqual(resolveTarget(parseTriageArgs("--baseline abc")), { kind: "task", baselineRef: "abc" });
	assert.deepEqual(resolveTarget(parseTriageArgs("task abc --baseline dev")), {
		kind: "task",
		baselineRef: "dev",
	}, "flag beats positional");
	assert.deepEqual(
		resolveTarget({ summary: "x", target: "uncommitted", baseline: "abc" }),
		{ kind: "task", baselineRef: "abc" },
		"a supplied baseline is never silently ignored",
	);
	assert.deepEqual(
		resolveTarget(parseTriageArgs("none --baseline dev")),
		{ kind: "task", baselineRef: "dev" },
		"a baseline beats an explicit none",
	);
});

test("command: positional and flag forms both resolve the target", () => {
	assert.deepEqual(resolveTarget(parseTriageArgs("branch dev")), { kind: "branch", base: "dev" });
	assert.deepEqual(resolveTarget(parseTriageArgs("commit abc123")), { kind: "commit", ref: "abc123" });
	assert.deepEqual(resolveTarget(parseTriageArgs("")), { kind: "uncommitted" });
	assert.deepEqual(resolveTarget(parseTriageArgs("none")), { kind: "none" });
	assert.equal(parseTriageArgs('--summary "fix the parser" --note "changes a format"').summary, "fix the parser");
	assert.deepEqual(parseTriageArgs('--summary "x" --note "on-disk format"').notes, ["on-disk format"]);
	assert.deepEqual(resolveTarget(parseTriageArgs("--ref deadbeef")), { kind: "commit", ref: "deadbeef" });
});
