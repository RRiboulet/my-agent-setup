// Unit tests for the review-triage extension.
//
// The risks worth pinning here are the ones where a quiet bug changes a review
// decision rather than breaking a call:
//
//   - the config merge, because a field silently ignored means the machine runs
//     a policy its owner did not choose;
//   - the evidence scan, because a missing signal is what makes Jev blind and a
//     false one is merely discounted;
//   - the forward/reverse Choice averaging, because Jev's first-option bias is
//     the documented failure mode and averaging is the fix;
//   - the cost floor and fallback composition, because "the strong tier quietly
//     ran on the cheap model" is the failure this whole tool exists to prevent.
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
	DEFAULT_TRACKS,
	loadConfig,
	type Candidate,
	type TriageConfig,
} from "../../review-triage/config.ts";
import {
	buildRangeCommand,
	collectEvidence,
	detectSignals,
	parseNameStatus,
	parseNumstat,
	renameDestination,
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
} from "../../review-triage/judge.ts";
import {
	clampThinking,
	composePlan,
	tierFromPrice,
	disabledPlan,
	failOpenPlan,
	resolveCandidates,
	selectModel,
	tierForScore,
	type AvailableModel,
} from "../../review-triage/compose.ts";
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
		tracks: {
			adversarial: { ...DEFAULT_TRACKS.adversarial, tiers: [...DEFAULT_TRACKS.adversarial.tiers], fallbackChain: [] },
			complexity: { ...DEFAULT_TRACKS.complexity, tiers: [...DEFAULT_TRACKS.complexity.tiers], fallbackChain: [] },
		},
		candidates: [],
		...overrides,
	};
}

const CANDIDATES: Candidate[] = [
	{ provider: "p", model: "cheap", tier: "low", description: "cheap" },
	{ provider: "p", model: "mid", tier: "medium", description: "mid" },
	{ provider: "p", model: "strong", tier: "high", description: "strong" },
];

const AVAILABLE: AvailableModel[] = [
	{ provider: "p", id: "cheap", reasoning: true },
	{ provider: "p", id: "mid", reasoning: true },
	{ provider: "p", id: "strong", reasoning: true },
];

function trackJudgment(overrides: Partial<Parameters<typeof composePlan>[0]["judgment"]["adversarial"]> = {}) {
	return {
		neededProbability: 0.9,
		strength: 2.0,
		strengthConfidence: 0.9,
		choice: "p/mid",
		choiceConfidence: 0.9,
		choiceProbabilities: { "p/cheap": 0.05, "p/mid": 0.9, "p/strong": 0.05 },
		...overrides,
	};
}

function judgment(overrides: Partial<Parameters<typeof composePlan>[0]["judgment"]> = {}) {
	return {
		adversarial: trackJudgment(),
		complexity: trackJudgment({ choice: "p/mid" }),
		judge: "openrouter/typesafe/jev-1.13",
		latencyMs: 500,
		...overrides,
	};
}

const EVIDENCE = { files: 3, added: 40, removed: 10, signals: ["changes error handling"] };

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config: defaults apply when no file exists", () => {
	const loaded = loadConfig({ path: "/nonexistent/review-triage.json", env: {} });
	assert.equal(loaded.enabled, true);
	assert.equal(loaded.judge.provider, "openrouter");
	assert.equal(loaded.judge.model, "typesafe/jev-1.13");
	assert.equal(loaded.onJudgeError, "conservative");
	assert.equal(loaded.reverseChoice, true);
	assert.deepEqual(loaded.tracks.adversarial.tiers, DEFAULT_TRACKS.adversarial.tiers);
});

test("config: a file merges over defaults field by field", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(
		path,
		JSON.stringify({
			judge: { model: "typesafe/jev-latest", minConfidence: 0.6 },
			candidates: [{ provider: "x", model: "y", tier: "high", description: "best" }],
			tracks: { adversarial: { threshold: 0.8, fallbackChain: ["x/y"] } },
			onJudgeError: "skip",
		}),
	);
	try {
		const loaded = loadConfig({ path, env: {} });
		assert.equal(loaded.judge.model, "typesafe/jev-latest");
		assert.equal(loaded.judge.provider, "openrouter", "an unset field keeps the default");
		assert.equal(loaded.judge.minConfidence, 0.6);
		assert.equal(loaded.candidates.length, 1);
		assert.equal(loaded.candidates[0]?.tier, "high", "the capability tier must survive the config read");
		assert.equal(loaded.tracks.adversarial.threshold, 0.8);
		assert.deepEqual(loaded.tracks.adversarial.fallbackChain, ["x/y"]);
		// The complexity track was not overridden and must keep its default tiers.
		assert.deepEqual(loaded.tracks.complexity.tiers, DEFAULT_TRACKS.complexity.tiers);
		assert.equal(loaded.onJudgeError, "skip");
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
		// A policy file that exists but cannot be read is worth saying out loud;
		// silently ignoring it means the owner runs default policy without knowing.
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

test("config: an empty tiers array is ignored in favour of the defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
	const path = join(dir, "review-triage.json");
	writeFileSync(path, JSON.stringify({ tracks: { adversarial: { tiers: [] } } }));
	try {
		const loaded = loadConfig({ path, env: {}, warn: () => {} });
		assert.deepEqual(loaded.tracks.adversarial.tiers, DEFAULT_TRACKS.adversarial.tiers);
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
// evidence
// ---------------------------------------------------------------------------

test("evidence: numstat sums churn and keeps paths with tabs", () => {
	const parsed = parseNumstat("10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n-\t-\timage.png\n");
	assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts", "image.png"]);
	assert.equal(parsed.added, 15);
	assert.equal(parsed.removed, 2);
});

test("evidence: name-status splits additions and deletions, renames take the destination", () => {
	const parsed = parseNameStatus("A\tsrc/new.ts\nD\tsrc/old.ts\nM\tsrc/mod.ts\nR100\tsrc/a.ts\tsrc/b.ts\n");
	assert.deepEqual(parsed.newFiles, ["src/new.ts"]);
	assert.deepEqual(parsed.deletedFiles, ["src/old.ts"]);
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

test("evidence: a rename's numstat pseudo-path resolves to its destination", () => {
	// git emits `src/{util => auth}/helper.ts` and `old.ts => new.ts`; the
	// security-path check must see `src/auth/helper.ts`, not the abbreviation.
	assert.equal(renameDestination("src/{util => auth}/helper.ts"), "src/auth/helper.ts");
	assert.equal(renameDestination("src/a.ts => src/b.ts"), "src/b.ts");
	const parsed = parseNumstat("0\t0\tsrc/{util => auth}/helper.ts\n");
	assert.deepEqual(parsed.files, ["src/auth/helper.ts"]);
	assert.ok(detectSignals(parsed.files, "", 0, 0).some((s) => s.includes("authentication")));
});

test("evidence: name-status keep-list includes rename destinations", () => {
	const parsed = parseNameStatus("R100\tsrc/util/helper.ts\tsrc/auth/helper.ts\nA\tsrc/new.ts\n");
	assert.deepEqual(parsed.renamedFiles, ["src/auth/helper.ts"]);
	assert.deepEqual(parsed.newFiles, ["src/new.ts"]);
});

test("evidence: a file header alone must not manufacture a signal", () => {
	// `+++ b/src/spawn.ts` used to match the process-execution regex, so a diff
	// with no content was reported as touching process execution.
	assert.deepEqual(detectSignals(["src/spawn.ts"], "+++ b/src/spawn.ts\n--- a/src/spawn.ts\n", 0, 0), []);
});

test("evidence: a .sql file triggers the migration label", () => {
	assert.ok(detectSignals(["queries/orders.sql"], "", 1, 0).some((s) => s.includes("migration")));
});

test("evidence: collectEvidence folds rename destinations into the file list", async () => {
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		if (key === "diff --numstat HEAD") return { stdout: "0\t0\tsrc/{util => auth}/h.ts\n", stderr: "", code: 0 };
		if (key === "diff --name-status HEAD") return { stdout: "R100\tsrc/util/h.ts\tsrc/auth/h.ts\n", stderr: "", code: 0 };
		if (key === "diff --unified=0 HEAD") return { stdout: "", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, { summary: "move a file", target: { kind: "uncommitted" } });
	assert.deepEqual(evidence.files, ["src/auth/h.ts"]);
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

test("evidence: uncommitted collection includes untracked files", async () => {
	const calls: string[] = [];
	const exec: GitExec = async (_command, args) => {
		const key = args.join(" ");
		calls.push(key);
		if (key === "diff --numstat HEAD") return { stdout: "3\t1\tsrc/a.ts\n", stderr: "", code: 0 };
		if (key === "diff --name-status HEAD") return { stdout: "M\tsrc/a.ts\n", stderr: "", code: 0 };
		if (key === "diff --unified=0 HEAD") return { stdout: "+const x = 1;\n", stderr: "", code: 0 };
		if (key === "ls-files --others --exclude-standard") return { stdout: "src/brand-new.ts\n", stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const evidence = await collectEvidence(exec, {
		summary: "add a thing",
		target: { kind: "uncommitted" },
	});
	assert.equal(evidence.isGit, true);
	assert.deepEqual(evidence.files, ["src/a.ts", "src/brand-new.ts"]);
	assert.deepEqual(evidence.newFiles, ["src/brand-new.ts"]);
	assert.equal(evidence.added, 3);
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

function fullAnswers(overrides: Record<string, ClassifierAnswer> = {}): Record<string, ClassifierAnswer> {
	const keys = CANDIDATES.map((c) => `${c.provider}/${c.model}`);
	const forward = Object.fromEntries(keys.map((k, i) => [k, i === 1 ? 0.9 : 0.05]));
	const reverse = Object.fromEntries([...keys].reverse().map((k, i) => [k, i === 1 ? 0.85 : 0.075]));
	return {
		[QUESTION_IDS.adversarialNeeded]: { type: "bool", probability: 0.9 },
		[QUESTION_IDS.complexityNeeded]: { type: "bool", probability: 0.4 },
		[QUESTION_IDS.adversarialStrength]: { type: "score", score: 2.2, confidence: 0.8 },
		[QUESTION_IDS.complexityStrength]: { type: "score", score: 0.8, confidence: 0.7 },
		[QUESTION_IDS.adversarialModel]: { type: "choice", choice: "p/mid", probabilities: forward, confidence: 0.9 },
		[QUESTION_IDS.adversarialModelReversed]: {
			type: "choice",
			choice: "p/mid",
			probabilities: reverse,
			confidence: 0.85,
		},
		[QUESTION_IDS.complexityModel]: { type: "choice", choice: "p/mid", probabilities: forward, confidence: 0.9 },
		[QUESTION_IDS.complexityModelReversed]: {
			type: "choice",
			choice: "p/mid",
			probabilities: reverse,
			confidence: 0.85,
		},
		...overrides,
	};
}

test("judge: the batch asks eight questions, every Choice in both orders", () => {
	const questions = buildQuestions(config(), CANDIDATES);
	assert.equal(Object.keys(questions).length, 8);
	const forward = questions[QUESTION_IDS.adversarialModel];
	const reverse = questions[QUESTION_IDS.adversarialModelReversed];
	assert.equal(forward.type, "choice");
	assert.equal(reverse.type, "choice");
	if (forward.type === "choice" && reverse.type === "choice") {
		assert.deepEqual(Object.keys(reverse.criteria), Object.keys(forward.criteria).reverse());
	}
});

test("judge: a missing answer is a malformed judge error, not a zero", () => {
	const result = classifierResult({ [QUESTION_IDS.adversarialNeeded]: { type: "bool", probability: 0.9 } });
	assert.throws(() => parseJudgment(result, config(), 10), (error: unknown) => {
		return error instanceof JudgeError && error.failure === "malformed";
	});
});

test("judge: averaging cancels a first-option lean", () => {
	// Forward favours cheap; reversed favours strong. The average should not
	// hand the pick to either with high confidence.
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

test("judge: reverseChoice:false asks six questions and needs no reverse answer", () => {
	const questions = buildQuestions(config({ reverseChoice: false }), CANDIDATES);
	assert.equal(Object.keys(questions).length, 6, "the reversed pair must not be sent and paid for");
	assert.equal(QUESTION_IDS.adversarialModelReversed in questions, false);

	// parseJudgment must accept a result that has no reversed answers at all.
	const forwardOnly = { ...fullAnswers() };
	delete forwardOnly[QUESTION_IDS.adversarialModelReversed];
	delete forwardOnly[QUESTION_IDS.complexityModelReversed];
	const parsed = parseJudgment(classifierResult(forwardOnly), config({ reverseChoice: false }), 5);
	assert.equal(parsed.adversarial.choice, "p/mid");
});

test("judge: an abort is its own failure, not a reason to fail open", async () => {
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async () => ({ ...classifierResult(fullAnswers()), stopReason: "aborted" }),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), {}, CANDIDATES),
		(error: unknown) => error instanceof JudgeError && error.failure === "aborted",
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

test("judge: taking the threshold out of parseTrack keeps one source of truth", () => {
	const parsed = parseJudgment(classifierResult(fullAnswers()), config(), 123);
	// 0.9 would clear the adversarial threshold and 0.4 would not, but choosing
	// is compose's job; parseJudgment only reports the probability.
	assert.equal(parsed.adversarial.neededProbability, 0.9);
	assert.equal(parsed.complexity.neededProbability, 0.4);
	assert.equal("needed" in parsed.adversarial, false);
	assert.equal(parsed.adversarial.choice, "p/mid");
	assert.equal(parsed.adversarial.strength, 2.2);
	assert.equal(parsed.latencyMs, 123);
});

test("judge: records the judge's token usage with the right field names", () => {
	// pi-ai's Usage uses input/output; inputTokens/outputTokens are not fields,
	// and the old `?? 0` silently recorded every call as zero tokens.
	const result = classifierResult(fullAnswers(), {
		usage: { input: 966, output: 215, totalTokens: 1181, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00004 } } as never,
	});
	const parsed = parseJudgment(result, config(), 10);
	assert.equal(parsed.usage?.inputTokens, 966);
	assert.equal(parsed.usage?.outputTokens, 215);
	assert.equal(parsed.usage?.cost, 0.00004);
});

test("judge: an absent classifier model fails as unavailable", async () => {
	const registry = {
		findOfType: () => undefined,
		classify: async () => classifierResult(fullAnswers()),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), {}, CANDIDATES),
		(error: unknown) => error instanceof JudgeError && error.failure === "unavailable",
	);
});

test("judge: a provider error becomes a JudgeError, never a silent judgement", async () => {
	const registry = {
		findOfType: () => ({ provider: "openrouter", id: "typesafe/jev-1.13" }),
		classify: async () => ({ ...classifierResult(fullAnswers()), stopReason: "error", errorMessage: "boom" }),
	};
	await assert.rejects(
		() => askJudge(registry as never, config(), {}, CANDIDATES),
		(error: unknown) => error instanceof JudgeError && error.failure === "error",
	);
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
// composition
// ---------------------------------------------------------------------------

test("compose: tierFromPrice buckets by catalogue price", () => {
	assert.equal(tierFromPrice(0.2), "low");
	assert.equal(tierFromPrice(3), "medium");
	assert.equal(tierFromPrice(30), "high");
	assert.equal(tierFromPrice(undefined), "medium");
});

test("compose: tierForScore picks the last rung the score clears", () => {
	const track = DEFAULT_TRACKS.adversarial;
	assert.equal(tierForScore(track, 0).name, "light");
	assert.equal(tierForScore(track, 1.4).name, "light");
	assert.equal(tierForScore(track, 1.5).name, "standard");
	assert.equal(tierForScore(track, 2.9).name, "deep");
});

test("compose: thinking is clamped for a model that cannot reason", () => {
	assert.equal(clampThinking("high", { provider: "p", id: "m", reasoning: false }), "off");
	assert.equal(clampThinking("high", { provider: "p", id: "m", reasoning: true }), "high");
	// The level map is authoritative: a null entry means unsupported.
	assert.equal(
		clampThinking("high", { provider: "p", id: "m", thinkingLevelMap: { high: null, medium: "m", low: "l" } }),
		"medium",
	);
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
});

test("compose: a confident Choice within the floor is used as-is", () => {
	const selection = selectModel({
		track: "adversarial",
		tier: { name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
		judgment: trackJudgment(),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
	});
	assert.equal(selection.model?.model, "mid");
	assert.equal(selection.fallbackUsed, false);
});

test("compose: a cheap pick for a deep review is promoted to clear the floor", () => {
	const selection = selectModel({
		track: "adversarial",
		tier: { name: "deep", minScore: 2.5, thinking: "high", minTier: "high" },
		judgment: trackJudgment({ choice: "p/cheap", choiceProbabilities: { "p/cheap": 0.9, "p/strong": 0.1 } }),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
	});
	assert.equal(selection.model?.model, "strong");
	assert.ok(selection.notes.some((note) => note.includes("promoted")));
});

test("compose: a low-confidence Choice walks the fallback chain", () => {
	const selection = selectModel({
		track: "adversarial",
		tier: { name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
		judgment: trackJudgment({ choiceConfidence: 0.1 }),
		config: config({ tracks: { ...DEFAULT_TRACKS, adversarial: { ...DEFAULT_TRACKS.adversarial, fallbackChain: ["p/strong"] } } }),
		candidates: CANDIDATES,
		available: AVAILABLE,
	});
	assert.equal(selection.model?.model, "strong");
	assert.equal(selection.fallbackUsed, true);
});

test("compose: an unavailable pick walks the chain to a usable model", () => {
	const selection = selectModel({
		track: "adversarial",
		tier: { name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
		judgment: trackJudgment({ choice: "p/mid" }),
		config: config(),
		candidates: CANDIDATES,
		available: [{ provider: "p", id: "strong", reasoning: true }],
	});
	assert.equal(selection.model?.model, "strong");
	assert.equal(selection.fallbackUsed, true);
});

test("compose: no usable model leaves the choice to the agent with a note", () => {
	const selection = selectModel({
		track: "adversarial",
		tier: { name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
		judgment: trackJudgment(),
		config: config(),
		candidates: CANDIDATES,
		available: [],
	});
	assert.equal(selection.model, undefined);
	assert.ok(selection.notes.some((note) => note.includes("agent must choose")));
});

test("compose: a plan gates each track on its own probability", () => {
	const plan = composePlan({
		judgment: judgment(),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "add a thing",
	});
	assert.equal(plan.verdict, "adversarial + complexity");
	assert.equal(plan.adversarial.needed, true);
	assert.ok(plan.adversarial.task?.includes("falsify"), "the adversarial task must be hostile");
	assert.ok(plan.complexity.task?.includes("over-engineered"));
});

test("compose: a plan with neither track needed says so", () => {
	const plan = composePlan({
		judgment: judgment({
			adversarial: trackJudgment({ neededProbability: 0.1 }),
			complexity: trackJudgment({ neededProbability: 0.2 }),
		}),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "typo",
	});
	assert.equal(plan.verdict, "no review");
	assert.equal(plan.adversarial.model, undefined);
	assert.equal(plan.adversarial.task, undefined);
});

test("compose: fail-open is conservative by default and can be told to skip", () => {
	const conservative = failOpenPlan({
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "x",
		reason: "timeout",
	});
	assert.equal(conservative.adversarial.needed, true);
	assert.ok(conservative.verdict.includes("conservative"));

	const skip = failOpenPlan({
		config: config({ onJudgeError: "skip" }),
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "x",
		reason: "timeout",
	});
	assert.equal(skip.adversarial.needed, false);
	assert.equal(skip.verdict, "no review (judge unavailable)");
});

test("compose: fail-open stays conservative under a raised threshold", () => {
	// The regression: a hardcoded 0.5 probability against a configured 0.7
	// threshold rendered as "no review (judge unavailable — conservative)".
	const raised = config({
		tracks: {
			adversarial: { ...DEFAULT_TRACKS.adversarial, threshold: 0.7 },
			complexity: { ...DEFAULT_TRACKS.complexity, threshold: 0.95 },
		},
	});
	const plan = failOpenPlan({
		config: raised,
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "x",
		reason: "timeout",
	});
	assert.equal(plan.adversarial.needed, true);
	assert.equal(plan.complexity.needed, true);
	assert.equal(plan.verdict, "adversarial + complexity (judge unavailable — conservative default)");
});

test("compose: fail-open targets the middle rung of a custom tier table", () => {
	const custom = config({
		tracks: {
			adversarial: {
				threshold: 0.5,
				tiers: [
					{ name: "a", minScore: 0, thinking: "low", minTier: "low" },
					{ name: "b", minScore: 1, thinking: "medium", minTier: "medium" },
					{ name: "c", minScore: 2, thinking: "high", minTier: "high" },
					{ name: "d", minScore: 3, thinking: "max", minTier: "high" },
				],
				fallbackChain: [],
			},
			complexity: { ...DEFAULT_TRACKS.complexity, fallbackChain: [] },
		},
	});
	const plan = failOpenPlan({
		config: custom,
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "x",
		reason: "timeout",
	});
	// Middle of a four-rung table is index 1, not the default's "standard".
	assert.equal(plan.adversarial.tier, "b");
});

test("compose: a disabled extension says so instead of judging", () => {
	const plan = disabledPlan(EVIDENCE);
	assert.equal(plan.verdict, "disabled (review-triage is off)");
	assert.equal(plan.adversarial.needed, false);
	assert.equal(plan.judge, "disabled");
});

test("format: the rendered plan names the model, thinking level and task", () => {
	const plan = composePlan({
		judgment: judgment(),
		config: config(),
		candidates: CANDIDATES,
		available: AVAILABLE,
		evidence: EVIDENCE,
		summary: "add a thing",
	});
	const text = formatPlan(plan);
	assert.match(text, /Review triage/);
	assert.match(text, /p\/mid/);
	assert.match(text, /thinking medium/);
	assert.match(text, /falsify/);
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
	// A bare ref implies a commit target without an explicit keyword.
	assert.deepEqual(resolveTarget(parseTriageArgs("--ref deadbeef")), { kind: "commit", ref: "deadbeef" });
});
