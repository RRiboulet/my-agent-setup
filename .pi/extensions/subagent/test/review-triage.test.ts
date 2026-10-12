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
	detectSignals,
	indicatorsFor,
	parseNumstatZ,
	parsePathListZ,
	parseRawZ,
	type GitExec,
} from "../../review-triage/evidence.ts";
import {
	askJudge,
	averageChoice,
	buildQuestions,
	buildState,
	JudgeError,
	parseJudgment,
	QUESTION_IDS,
	summarizeChoice,
	type Judgment,
	type TrackJudgment,
} from "../../review-triage/judge.ts";
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
import { decidePolicy, POLICY_REASONS, type PolicyGates } from "../../review-triage/policy.ts";
import { formatPlan } from "../../review-triage/format.ts";
import { parseTriageArgs, resolveTarget } from "../../review-triage/index.ts";
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
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config: defaults apply when no file exists", () => {
	const loaded = loadConfig({ path: "/nonexistent/review-triage.json", env: {} });
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.judge.provider, "openrouter");
	assert.equal(loaded.judge.model, "typesafe/jev-1.13");
	assert.equal(loaded.reverseChoice, true);
	assert.equal(loaded.policy.skipThreshold, 0.9);
	assert.deepEqual(loaded.thinkingLadder, DEFAULT_THINKING_LADDER);
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
		() => askJudge(registry as never, config(), {}, catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "aborted",
	);
});

test("judge: an absent classifier model fails as unavailable", async () => {
	const registry = { findOfType: () => undefined, classify: async () => classifierResult(fullAnswers()) };
	await assert.rejects(
		() => askJudge(registry as never, config(), {}, catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "unavailable",
	);
});

test("judge: a provider error becomes a JudgeError, never a silent judgement", async () => {
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async () => ({ ...classifierResult(fullAnswers()), stopReason: "error", errorMessage: "boom" }),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), {}, catalog()),
		(error: unknown) => error instanceof JudgeError && error.failure === "error",
	);
});

test("judge: a state over the cap is bounded even with huge notes", () => {
	const evidence = {
		target: "uncommitted" as const,
		isGit: true,
		files: Array.from({ length: 200 }, (_, i) => `src/very/long/path/number/${i}/file.ts`),
		added: 1,
		removed: 0,
		newFiles: [],
		deletedFiles: [],
		signals: [],
		notes: Array.from({ length: 50 }, () => "n".repeat(2_000)),
		summary: "s".repeat(5_000),
		patchExcerpt: "y".repeat(5_000),
		truncated: false,
	};
	const state = buildState(evidence, 2_000);
	assert.ok(JSON.stringify(state).length <= 3_000, `state was ${JSON.stringify(state).length} chars`);
});

test("judge: state trims the diff before anything else when over the cap", () => {
	const evidence = {
		target: "uncommitted" as const,
		isGit: true,
		files: ["a.ts"],
		added: 1,
		removed: 0,
		newFiles: [],
		deletedFiles: [],
		signals: [],
		notes: [],
		summary: "x",
		patchExcerpt: "y".repeat(5_000),
		truncated: false,
	};
	const state = buildState(evidence, 1_000);
	const change = state.change as Record<string, unknown>;
	assert.equal(change.diff_excerpt, undefined);
	assert.equal(change.diff_omitted, true, "the diff was removed, so say removed");
	assert.equal(change.diff_truncated, false, "git did not truncate it; don't claim it did");
	assert.ok(JSON.stringify(state).length <= 1_200);
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
	assert.equal(plan.adversarial.thinking, "max");
	assert.equal(plan.adversarial.status, "recommended");
	assert.equal(plan.adversarial.source, "jev");
	assert.ok(plan.adversarial.task?.includes("falsify"), "the adversarial task must be hostile");
	assert.ok(plan.complexity.task?.includes("over-engineered"));
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
	assert.equal(plan.adversarial.thinking, "low", "the clamp walks down to a supported level");
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
		reason: "timeout",
	});
	assert.equal(plan.adversarial.needed, true);
	assert.equal(plan.adversarial.status, "fallback");
	assert.equal(plan.adversarial.source, "policy-fallback");
	assert.equal(plan.adversarial.finalChoice, "high:max");
	assert.ok(plan.verdict.includes("judge unavailable"));
});

test("compose: a disabled extension says so instead of judging", () => {
	const plan = disabledPlan(EVIDENCE);
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

test("command: positional and flag forms both resolve the target", () => {
	assert.deepEqual(resolveTarget(parseTriageArgs("branch dev")), { kind: "branch", base: "dev" });
	assert.deepEqual(resolveTarget(parseTriageArgs("commit abc123")), { kind: "commit", ref: "abc123" });
	assert.deepEqual(resolveTarget(parseTriageArgs("")), { kind: "uncommitted" });
	assert.deepEqual(resolveTarget(parseTriageArgs("none")), { kind: "none" });
	assert.equal(parseTriageArgs('--summary "fix the parser" --note "changes a format"').summary, "fix the parser");
	assert.deepEqual(parseTriageArgs('--summary "x" --note "on-disk format"').notes, ["on-disk format"]);
	assert.deepEqual(resolveTarget(parseTriageArgs("--ref deadbeef")), { kind: "commit", ref: "deadbeef" });
});
