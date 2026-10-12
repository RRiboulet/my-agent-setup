/**
 * Composition: Jev judges, code owns the budget.
 *
 * Nothing in here calls a model or reads a file. It takes Jev's probabilities
 * and turns them into a plan by applying policy that a human wrote down:
 *
 *   - a noul probability at or above the track's threshold means the review is
 *     recommended;
 *   - the strength score picks a tier, and each tier carries an capability floor and a
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

import type {
	Candidate,
	CapabilityTier,
	DepthLevel,
	ThinkingLevel,
	Tier,
	TrackConfig,
	TriageConfig,
	TrackName,
} from "./config.ts";
import { DEPTH_LEVELS, DEPTH_RANK, THINKING_RANK } from "./config.ts";
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
	tier: CapabilityTier;
}

export interface TrackPlan {
	track: TrackName;
	needed: boolean;
	/** P(depth >= light): the probability a review is warranted. */
	neededProbability: number;
	/** The averaged depth distribution Jev returned, kept for the audit trail. */
	depth: Record<DepthLevel, number>;
	/** Rung name: "none" when skipped, else light/standard/deep. */
	tier: string;
	thinking: ThinkingLevel;
	model?: ModelRef;
	/** Jev's raw model pick, kept even when it fell outside the rung's band. */
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
 * Capability tier inferred from catalogue price. This exists only for models
 * that appear in a fallback chain but not in the curated candidate list — and
 * for the synthesised list on a machine with no config at all. It is a coarse
 * last resort: price cannot tell `deepseek-v4.1-flash` from `glm-5.3-flash`
 * (both 0.15), which is why the real ordering comes from an explicit `tier`.
 */
export function tierFromPrice(inputPerMillion: number | undefined): CapabilityTier {
	if (inputPerMillion === undefined || !Number.isFinite(inputPerMillion)) return "medium";
	if (inputPerMillion < 1) return "low";
	if (inputPerMillion < 5) return "medium";
	return "high";
}

/**
 * The candidate list. A curated config list wins; otherwise, and only then, the
 * models this session can actually use are ranked by catalogue price and split
 * into three buckets, so a fresh install still gets a working Choice without
 * anyone writing config first. That fallback is a price guess, not a capability
 * judgement — a config with real `tier`s is what makes the Choice meaningful.
 */
export function resolveCandidates(config: TriageConfig, available: readonly AvailableModel[]): Candidate[] {
	if (config.candidates.length > 0) return [...config.candidates];

	const ranked = [...available]
		.filter((model) => Boolean(model.provider) && Boolean(model.id))
		.sort((a, b) => priceOf(a) - priceOf(b));
	if (ranked.length === 0) return [];

	// Up to three per bucket: enough for a real Choice, short enough that Jev is
	// not choosing from a wall of near-identical ids.
	const perBucket: Record<CapabilityTier, number> = { low: 0, medium: 0, high: 0 };
	const candidates: Candidate[] = [];
	for (const model of ranked) {
		const tier = tierFromPrice(model.cost?.input);
		if (perBucket[tier] >= 3) continue;
		perBucket[tier] += 1;
		candidates.push({
			provider: model.provider,
			model: model.id,
			tier,
			description:
				tier === "low"
					? "Lowest price tier. A quick second read for obvious mistakes."
					: tier === "medium"
						? "Middle price tier. A full correctness pass on ordinary work."
						: "Highest price tier. Expected to be the strongest reasoner; for hostile or high-stakes review.",
		});
	}
	return candidates;
}

/**
 * Sort key for the synthesised list. An unknown price sorts last rather than
 * first, so a catalogue entry with no published cost cannot crowd a genuinely
 * cheap model out of the low bucket.
 */
function priceOf(model: AvailableModel): number {
	const input = model.cost?.input;
	return typeof input === "number" && Number.isFinite(input) ? input : Number.POSITIVE_INFINITY;
}

/**
 * The rung for a depth distribution: the deepest rung whose CUMULATIVE
 * probability clears its own `minConfidence`. That single rule is both the
 * gate and the cost control — because `P(depth >= rung)` shrinks as the rung
 * deepens, an expensive rung has to be argued for, and the two distributions
 * we used to ask separately (needed? how hard?) collapse into one.
 *
 * Tiers are sorted ascending, and cumulative probability is monotonic in depth,
 * so a plain sweep is enough: a rung that clears its bar implies every shallower
 * rung clears its lower bar too.
 */
export function tierForDepth(track: TrackConfig, depth: Record<DepthLevel, number>): Tier {
	let chosen = track.tiers[0];
	for (const rung of track.tiers) {
		const cumulative = DEPTH_LEVELS.filter(
			(level) => DEPTH_RANK[level] >= DEPTH_RANK[rung.name],
		).reduce((sum, level) => sum + (depth[level] ?? 0), 0);
		if (cumulative >= rung.minConfidence) chosen = rung;
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
	if (described) return { provider: described.provider, model: described.model, tier: described.tier };
	const model = availableModelFor(key, available);
	if (!model) return undefined;
	return { provider: model.provider, model: model.id, tier: tierFromPrice(model.cost?.input) };
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
 * Pick the review model from the rung's band. The rung already decided how much
 * capability the review deserves (from the depth distribution), so the band is a
 * hard boundary: Jev's model pick is used only if it falls inside it. That is
 * what stops a "standard" review from quietly buying the expensive model — the
 * leak the old floor-only rule allowed.
 *
 *   1. Jev's pick, when it is inside the band and confident;
 *   2. the best-ranked available candidate in the band, by Jev's own order;
 *   3. the configured fallback chain;
 *   4. any available candidate, then the session model, with a note.
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
	const toRef = (candidate: Candidate): ModelRef => ({
		provider: candidate.provider,
		model: candidate.model,
		tier: candidate.tier,
	});
	const band = candidates.filter((candidate) => candidate.tier === tier.candidateTier);
	const pick = band.find((candidate) => candidateKey(candidate) === judgment.choice);
	const confident = judgment.choiceConfidence >= config.judge.minConfidence;

	if (pick && confident && isAvailable(toRef(pick), available)) {
		return { model: toRef(pick), fallbackUsed: false, notes };
	}
	if (pick && !confident) {
		notes.push(
			`Choice confidence ${judgment.choiceConfidence.toFixed(2)} is below ${config.judge.minConfidence}; used the band's best-ranked model.`,
		);
	} else if (pick) {
		notes.push(`Jev chose ${judgment.choice}, which this session cannot use.`);
	} else {
		const outside = candidates.find((candidate) => candidateKey(candidate) === judgment.choice);
		notes.push(
			outside
				? `Jev chose ${judgment.choice} (${outside.tier}), outside the ${tier.candidateTier} band for a ${tier.name} review; kept the band.`
				: "Jev named no candidate in the band; used the band's best-ranked model.",
		);
	}

	// 2. Best-ranked available candidate in the band, by Jev's own order.
	const rankedBand = [...band]
		.filter((candidate) => isAvailable(toRef(candidate), available))
		.sort(
			(a, b) =>
				(judgment.choiceProbabilities[candidateKey(b)] ?? 0) -
				(judgment.choiceProbabilities[candidateKey(a)] ?? 0),
		);
	if (rankedBand[0]) return { model: toRef(rankedBand[0]), fallbackUsed: true, notes };

	// 3. Configured fallback chain, in order.
	const chain = config.tracks[track].fallbackChain
		.map((key) => refFromKey(key, candidates, available))
		.filter((ref): ref is ModelRef => ref !== undefined);
	for (const ref of chain) {
		if (isAvailable(ref, available)) return { model: ref, fallbackUsed: true, notes };
	}

	// 4. Any available candidate, then the session's current model.
	const anyAvailable = candidates.map(toRef).find((ref) => isAvailable(ref, available));
	if (anyAvailable) {
		notes.push(`No ${tier.candidateTier}-band model is available; used ${anyAvailable.tier}.`);
		return { model: anyAvailable, fallbackUsed: true, notes };
	}
	if (current && isAvailable(current, available)) {
		notes.push("No configured review model is available; using the session model.");
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
		needed: judgment.depth.none < trackConfig.nothingMargin,
		neededProbability: 1 - (judgment.depth.none ?? 0),
		depth: judgment.depth,
		tier: "none",
		thinking: "off",
		choice: judgment.choice,
		choiceConfidence: judgment.choiceConfidence,
		fallbackUsed: false,
		notes: [],
	};

	if (!base.needed) {
		base.notes.push(
			`P(depth = none) is ${judgment.depth.none.toFixed(2)}, at or above the ${trackConfig.nothingMargin} margin.`,
		);
		return base;
	}

	const tier = tierForDepth(trackConfig, judgment.depth);
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
 * What to return when the extension is switched off. It is not "no review" —
 * that would be a judgement the tool was told not to make — so the verdict says
 * plainly that nothing was judged.
 */
export function disabledPlan(evidence: ReviewPlan["evidence"]): ReviewPlan {
	const track = (name: TrackName): TrackPlan => ({
		track: name,
		needed: false,
		neededProbability: 0,
		depth: { none: 1, light: 0, standard: 0, deep: 0 },
		tier: "none",
		thinking: "off",
		choice: "",
		choiceConfidence: 0,
		fallbackUsed: false,
		notes: ["review-triage is disabled (enabled:false or PI_REVIEW_TRIAGE_OFF)"],
	});
	return {
		verdict: "disabled (review-triage is off)",
		adversarial: track("adversarial"),
		complexity: track("complexity"),
		judge: "disabled",
		latencyMs: 0,
		evidence,
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
			depth: { none: 1, light: 0, standard: 0, deep: 0 },
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

	// The middle rung by INDEX, not a fixed level: a config with a different
	// rung table should land the fail-open plan on its own middle, not ours.
	const middleLevel = (track: TrackName): DepthLevel => {
		const tiers = args.config.tracks[track].tiers;
		const middle = tiers[Math.floor((tiers.length - 1) / 2)];
		return (middle?.name ?? "standard") as DepthLevel;
	};
	const synthesize = (track: TrackName): TrackJudgment => {
		// Certainty at the middle rung: all of the depth mass there, so the plan
		// recommends a review but not the deepest one, whatever the margins are.
		const depth = { none: 0, light: 0, standard: 0, deep: 0 } as Record<DepthLevel, number>;
		depth[middleLevel(track)] = 1;
		return { depth, choice: "", choiceConfidence: 0, choiceProbabilities: {} };
	};
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
