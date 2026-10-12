/**
 * Composition: Jev judges, code owns the budget.
 *
 * Nothing in here calls a model or reads a file. It takes Jev's probabilities
 * and turns them into a plan by applying policy that a human wrote down:
 *
 *   - a noul probability at or above the track's threshold means the review is
 *     recommended;
 *   - the strength score picks a tier, and each tier carries a cost floor and a
 *     thinking level;
 *   - Jev's Choice names the model, but only within the floor — a confident
 *     pick of a cheap model for a deep review is promoted, because the score,
 *     not the Choice, decides how much capability the work deserves;
 *   - a low-confidence Choice, or one naming an unavailable or floor-breaking
 *     model, walks the configured fallback chain instead.
 *
 * Keeping this pure is what makes the gate auditable: every decision it makes
 * can be replayed from a saved judgement and a config.
 */

import type { Candidate, CostTier, ThinkingLevel, Tier, TrackConfig, TriageConfig, TrackName } from "./config.ts";
import { COST_RANK, THINKING_RANK } from "./config.ts";
import type { Judgment, TrackJudgment } from "./judge.ts";
import { candidateKey } from "./judge.ts";

/** The subset of a pi catalogue model this tool needs. */
export interface AvailableModel {
	provider: string;
	id: string;
	reasoning?: boolean;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Record<string, string | null> | null | undefined;
}

export interface ModelRef {
	provider: string;
	model: string;
	cost: CostTier;
}

export interface TrackPlan {
	track: TrackName;
	needed: boolean;
	neededProbability: number;
	strength: number;
	strengthConfidence: number;
	tier: string;
	thinking: ThinkingLevel;
	model?: ModelRef;
	/** Jev's raw pick, kept even when overridden, so the override is visible. */
	choice: string;
	choiceConfidence: number;
	fallbackUsed: boolean;
	notes: string[];
	/** Ready-to-paste task for the `subagent` tool, present only when needed. */
	task?: string;
}

export interface ReviewPlan {
	verdict: string;
	adversarial: TrackPlan;
	complexity: TrackPlan;
	judge: string;
	latencyMs: number;
	evidence: { files: number; added: number; removed: number; signals: string[] };
}

/**
 * Price bucket for a catalogue model, used only for models named by a fallback
 * chain rather than described in config. Thresholds are per million input
 * tokens; they are coarse on purpose, because a chain entry is a last resort
 * and the exact rung matters less than "is this in the ballpark".
 */
export function costBucket(inputPerMillion: number | undefined): CostTier {
	if (inputPerMillion === undefined || !Number.isFinite(inputPerMillion)) return "medium";
	if (inputPerMillion < 1) return "low";
	if (inputPerMillion < 5) return "medium";
	return "high";
}

/**
 * The candidate list. A curated config list wins; otherwise, and only then, the
 * models this session can actually use are ranked by catalogue price and split
 * into three buckets, so a fresh install still gets a working Choice without
 * anyone writing config first.
 */
export function resolveCandidates(config: TriageConfig, available: readonly AvailableModel[]): Candidate[] {
	if (config.candidates.length > 0) return [...config.candidates];

	const ranked = [...available]
		.filter((model) => Boolean(model.provider) && Boolean(model.id))
		.sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
	if (ranked.length === 0) return [];

	// Up to three per bucket: enough for a real Choice, short enough that Jev is
	// not choosing from a wall of near-identical ids.
	const perBucket: Record<CostTier, number> = { low: 0, medium: 0, high: 0 };
	const candidates: Candidate[] = [];
	for (const model of ranked) {
		const cost = costBucket(model.cost?.input);
		if (perBucket[cost] >= 3) continue;
		perBucket[cost] += 1;
		candidates.push({
			provider: model.provider,
			model: model.id,
			cost,
			description:
				cost === "low"
					? "Low cost and fast. A quick second read for obvious mistakes."
					: cost === "medium"
						? "Mid-cost and competent. A full correctness pass on ordinary work."
						: "Highest cost, strongest reasoning. Hostile review of subtle or high-stakes work.",
		});
	}
	return candidates;
}

/** The last tier whose score floor the reading clears. Tiers are pre-sorted. */
export function tierForScore(track: TrackConfig, score: number): Tier {
	let chosen = track.tiers[0];
	for (const tier of track.tiers) {
		if (score >= tier.minScore) chosen = tier;
	}
	return chosen;
}

/**
 * Clamp a thinking level to what the model actually supports. A model that
 * cannot reason must not be handed "high": the subagent would silently run at
 * its default and the plan would be a lie. `thinkingLevelMap` is authoritative
 * when present; otherwise `reasoning: false` caps the level at `off`.
 */
export function clampThinking(level: ThinkingLevel, model: AvailableModel | undefined): ThinkingLevel {
	if (!model) return level;
	const map = model.thinkingLevelMap;
	if (map && typeof map === "object") {
		for (let rank = THINKING_RANK[level]; rank >= 0; rank--) {
			const name = (Object.keys(THINKING_RANK) as ThinkingLevel[]).find(
				(candidate) => THINKING_RANK[candidate] === rank,
			);
			if (name && map[name] !== null && map[name] !== undefined) return name;
		}
		return "off";
	}
	if (model.reasoning === false) return "off";
	return level;
}

function findAvailable(
	ref: ModelRef,
	available: readonly AvailableModel[],
): AvailableModel | undefined {
	return available.find((model) => model.provider === ref.provider && model.id === ref.model);
}

function availableModelFor(
	key: string,
	available: readonly AvailableModel[],
): AvailableModel | undefined {
	const slash = key.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = key.slice(0, slash);
	const id = key.slice(slash + 1);
	return available.find((model) => model.provider === provider && model.id === id);
}

/** Resolve a fallback-chain key to a candidate: config first, catalogue second. */
function refFromKey(
	key: string,
	candidates: readonly Candidate[],
	available: readonly AvailableModel[],
): ModelRef | undefined {
	const described = candidates.find((candidate) => candidateKey(candidate) === key);
	if (described) return { provider: described.provider, model: described.model, cost: described.cost };
	const model = availableModelFor(key, available);
	if (!model) return undefined;
	return { provider: model.provider, model: model.id, cost: costBucket(model.cost?.input) };
}

function isAvailable(ref: ModelRef, available: readonly AvailableModel[]): boolean {
	return Boolean(findAvailable(ref, available));
}

interface Selection {
	model?: ModelRef;
	fallbackUsed: boolean;
	notes: string[];
}

/**
 * Pick the review model. The order is the policy:
 *   1. Jev's Choice, when it is confident and clears the tier's cost floor;
 *   2. the highest-probability candidate that clears the floor;
 *   3. the configured fallback chain, floor-clearing entries first;
 *   4. the cheapest floor-clearing model that is available;
 *   5. anything available at all, then the session model, with a note.
 */
export function selectModel(args: {
	track: TrackName;
	tier: Tier;
	judgment: TrackJudgment;
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	current?: ModelRef | undefined;
}): Selection {
	const { track, tier, judgment, config, candidates, available, current } = args;
	const notes: string[] = [];
	const floor = COST_RANK[tier.costFloor];
	const clearsFloor = (ref: ModelRef) => COST_RANK[ref.cost] >= floor;
	const usable = (ref: ModelRef | undefined) =>
		Boolean(ref && clearsFloor(ref) && isAvailable(ref, available));

	const pick = refFromKey(judgment.choice, candidates, available);
	const lowConfidence = judgment.choiceConfidence < config.judge.minConfidence;

	if (pick && !lowConfidence) {
		if (!clearsFloor(pick)) {
			notes.push(
				`Jev chose ${judgment.choice} (${pick.cost}) below the ${tier.costFloor} floor for a ${tier.name} review; promoted.`,
			);
		} else if (!isAvailable(pick, available)) {
			notes.push(`Jev chose ${judgment.choice}, which this session cannot use; used the fallback policy.`);
		} else {
			return { model: pick, fallbackUsed: false, notes };
		}
	} else if (lowConfidence) {
		notes.push(
			`Choice confidence ${judgment.choiceConfidence.toFixed(2)} is below ${config.judge.minConfidence}; ignored Jev's pick in favour of the fallback policy.`,
		);
	} else {
		notes.push("Jev named no usable candidate; used the fallback policy.");
	}

	// 2. Best described candidate that clears the floor, by Jev's own ranking.
	// Skipped on a low-confidence Choice: an untrusted distribution must not be
	// allowed to name the runner-up either — the human's fallback chain is the
	// stop for that case, below.
	const ranked = lowConfidence
		? []
		: [...candidates]
		.map((candidate) => ({ ref: { provider: candidate.provider, model: candidate.model, cost: candidate.cost } }))
		.filter(({ ref }) => clearsFloor(ref))
		.sort(
			(a, b) =>
				(judgment.choiceProbabilities[candidateKey(a.ref)] ?? 0) -
				(judgment.choiceProbabilities[candidateKey(b.ref)] ?? 0),
		)
		.reverse();
	for (const { ref } of ranked) {
		if (isAvailable(ref, available)) return { model: ref, fallbackUsed: true, notes };
	}

	// 3. Configured chain for this track, floor-clearing entries first, then any.
	const trackChain = config.tracks[track].fallbackChain;
	const refs = trackChain
		.map((key) => refFromKey(key, candidates, available))
		.filter((ref): ref is ModelRef => ref !== undefined);
	for (const ref of refs) if (usable(ref)) return { model: ref, fallbackUsed: true, notes };
	for (const ref of refs) {
		if (isAvailable(ref, available)) {
			notes.push(`${ref.provider}/${ref.model} is below the ${tier.costFloor} floor but is the only configured fallback.`);
			return { model: ref, fallbackUsed: true, notes };
		}
	}

	// 4. Cheapest available candidate that still clears the floor.
	const cheapest = candidates
		.map((candidate): ModelRef => ({ provider: candidate.provider, model: candidate.model, cost: candidate.cost }))
		.filter((ref) => usable(ref))
		.sort((a, b) => COST_RANK[a.cost] - COST_RANK[b.cost])[0];
	if (cheapest) return { model: cheapest, fallbackUsed: true, notes };

	// 5. Anything available, then the session's current model.
	const anyAvailable = candidates
		.map((candidate): ModelRef => ({ provider: candidate.provider, model: candidate.model, cost: candidate.cost }))
		.find((ref) => isAvailable(ref, available));
	if (anyAvailable) {
		notes.push(`No model clearing the ${tier.costFloor} floor is available; downgraded to ${anyAvailable.cost}.`);
		return { model: anyAvailable, fallbackUsed: true, notes };
	}
	if (current && isAvailable(current, available)) {
		notes.push(`No configured review model is available; using the session model.`);
		return { model: current, fallbackUsed: true, notes };
	}

	notes.push("No review model is available; the agent must choose one.");
	return { model: undefined, fallbackUsed: false, notes };
}

/** A one-line task for the `subagent` tool, kept in the plan so it can be pasted. */
export function buildTask(track: TrackName, tier: string, evidence: ReviewPlan["evidence"], summary: string): string {
	const facts = [
		`${evidence.files} file(s), +${evidence.added}/-${evidence.removed}`,
		evidence.signals.length > 0 ? `signals: ${evidence.signals.join("; ")}` : "no risk signals detected",
	].join(". ");
	if (track === "adversarial") {
		return [
			`Adversarially review this change at a ${tier} depth. Your job is to falsify it, not to summarise it.`,
			`Change: ${summary}`,
			`Evidence: ${facts}.`,
			"Look for correctness bugs, security holes, unhandled edge cases, untrusted-input handling, and silent error recovery that hides failures.",
			"Report discrete, actionable findings with evidence (file and line), worst first, and say explicitly if you find nothing.",
		].join("\n");
	}
	return [
		`Review the design complexity of this change at a ${tier} depth.`,
		`Change: ${summary}`,
		`Evidence: ${facts}.`,
		"Judge whether it is over-engineered, whether a simpler design fits the codebase, and whether any new abstraction earns its keep.",
		"Flag unnecessary wrappers, indirection and speculative generality; also note the parts of the design that are right.",
		"Report discrete, actionable findings with evidence (file and line), and say explicitly if the design is sound.",
	].join("\n");
}

function composeTrack(args: {
	track: TrackName;
	judgment: TrackJudgment;
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	current?: ModelRef | undefined;
	evidence: ReviewPlan["evidence"];
	summary: string;
}): TrackPlan {
	const { track, judgment, config } = args;
	const trackConfig = config.tracks[track];
	const base: TrackPlan = {
		track,
		needed: judgment.neededProbability >= trackConfig.threshold,
		neededProbability: judgment.neededProbability,
		strength: judgment.strength,
		strengthConfidence: judgment.strengthConfidence,
		tier: "none",
		thinking: "off",
		choice: judgment.choice,
		choiceConfidence: judgment.choiceConfidence,
		fallbackUsed: false,
		notes: [],
	};

	if (!base.needed) {
		base.notes.push(
			`needed probability ${judgment.neededProbability.toFixed(2)} is below the ${trackConfig.threshold} threshold.`,
		);
		return base;
	}

	const tier = tierForScore(trackConfig, judgment.strength);
	const selection = selectModel({
		track,
		tier,
		judgment,
		config,
		candidates: args.candidates,
		available: args.available,
		current: args.current,
	});
	const catalogue = selection.model
		? findAvailable(selection.model, args.available)
		: undefined;

	return {
		...base,
		tier: tier.name,
		thinking: clampThinking(tier.thinking, catalogue),
		...(selection.model ? { model: selection.model } : {}),
		fallbackUsed: selection.fallbackUsed,
		notes: [...base.notes, ...selection.notes],
		task: buildTask(track, tier.name, args.evidence, args.summary),
	};
}

export function composePlan(args: {
	judgment: Judgment;
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	current?: ModelRef | undefined;
	evidence: { files: number; added: number; removed: number; signals: string[] };
	summary: string;
}): ReviewPlan {
	const adversarial = composeTrack({
		track: "adversarial",
		judgment: args.judgment.adversarial,
		config: args.config,
		candidates: args.candidates,
		available: args.available,
		current: args.current,
		evidence: args.evidence,
		summary: args.summary,
	});
	const complexity = composeTrack({
		track: "complexity",
		judgment: args.judgment.complexity,
		config: args.config,
		candidates: args.candidates,
		available: args.available,
		current: args.current,
		evidence: args.evidence,
		summary: args.summary,
	});

	const verdict = [
		adversarial.needed ? "adversarial" : undefined,
		complexity.needed ? "complexity" : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" + ");

	return {
		verdict: verdict || "no review",
		adversarial,
		complexity,
		judge: args.judgment.judge,
		latencyMs: args.judgment.latencyMs,
		evidence: args.evidence,
	};
}

/**
 * What to do when Jev cannot be reached. "Conservative" recommends both reviews
 * at their middle rung: an unreachable judge should cost the user a review, not
 * buy them a skipped one. "Skip" is for a machine that must not spend review
 * tokens when the judge is down.
 */
export function failOpenPlan(args: {
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	current?: ModelRef | undefined;
	evidence: ReviewPlan["evidence"];
	summary: string;
	reason: string;
}): ReviewPlan {
	if (args.config.onJudgeError === "skip") {
		const empty: TrackPlan = {
			track: "adversarial",
			needed: false,
			neededProbability: 0,
			strength: 0,
			strengthConfidence: 0,
			tier: "none",
			thinking: "off",
			choice: "",
			choiceConfidence: 0,
			fallbackUsed: false,
			notes: [`judge unavailable: ${args.reason}`],
		};
		const complexity: TrackPlan = { ...empty, track: "complexity" };
		return {
			verdict: "no review (judge unavailable)",
			adversarial: empty,
			complexity,
			judge: "unavailable",
			latencyMs: 0,
			evidence: args.evidence,
		};
	}

	const synthesize = (track: TrackName): TrackJudgment => ({
		needed: true,
		neededProbability: 0.5,
		strength: 1.5,
		strengthConfidence: 0,
		choice: "",
		choiceConfidence: 0,
		choiceProbabilities: {},
	});
	const judgment: Judgment = {
		adversarial: synthesize("adversarial"),
		complexity: synthesize("complexity"),
		judge: "unavailable",
		latencyMs: 0,
	};
	const plan = composePlan({ ...args, judgment });
	plan.verdict = `${plan.verdict} (judge unavailable — conservative default)`;
	plan.adversarial.notes.unshift(`judge unavailable: ${args.reason}`);
	plan.complexity.notes.unshift(`judge unavailable: ${args.reason}`);
	return plan;
}
