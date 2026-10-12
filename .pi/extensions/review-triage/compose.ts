/**
 * Composition: Jev judges, policy decides, code resolves.
 *
 * Nothing in here calls a model or reads a file. It takes the per-track profile
 * judgement, applies the pure skip/fallback policy, and resolves the chosen
 * profile to a concrete model:
 *
 *   - the profile's band selects the model from the candidate list;
 *   - the profile's thinking level is used verbatim, with the old clamp kept
 *     only as a defensive assertion that logs when it would have changed;
 *   - a judge failure is routed through policy, so it is marked as a fallback
 *     rather than ever being read as a judgement.
 *
 * Keeping this pure is what makes the gate auditable: every decision it makes
 * can be replayed from a saved judgement, a catalog and a config.
 */

import type {
	Candidate,
	CapabilityTier,
	ProfileOption,
	ThinkingLevel,
	TriageConfig,
	TrackName,
} from "./config.ts";
import { PROFILE_NONE, parseProfile, THINKING_RANK } from "./config.ts";
import type { Judgment, TrackJudgment } from "./judge.ts";
import { decidePolicy, type PolicyGates, type PolicySource, type PolicyStatus } from "./policy.ts";

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
	/** P(none): the skip signal Jev returned. */
	skipConfidence: number;
	/** The winning non-none profile's averaged probability. */
	routingConfidence: number;
	/** Jev's overall argmax (may be `none`), kept for the audit trail. */
	proposedChoice: string;
	/** The profile policy resolved to, present when a review is recommended. */
	finalChoice?: string;
	thinking: ThinkingLevel;
	model?: ModelRef;
	status: PolicyStatus;
	source: PolicySource;
	/** Deterministic tags; the rendered rationale is a template over these. */
	reasonCodes: string[];
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
 * that appear in the synthesised list on a machine with no config at all. It is
 * a coarse last resort: price cannot tell `deepseek-v4.1-flash` from
 * `glm-5.3-flash` (both 0.15), which is why the real ordering comes from an
 * explicit `tier`.
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
			cost: model.cost?.input ?? 0,
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
 * Clamp a thinking level to what the model actually supports. The catalog
 * should already have pruned unsupported pairs, so in the normal path this
 * changes nothing; it is kept as a defensive assertion for the case where the
 * runtime map changed after the catalog was generated. A model that cannot
 * reason must not be handed "high" — the subagent would silently run at its
 * default and the plan would be a lie.
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
	ref: Pick<ModelRef, "provider" | "model">,
	available: readonly AvailableModel[],
): AvailableModel | undefined {
	return available.find((model) => model.provider === ref.provider && model.id === ref.model);
}

/**
 * Resolve a profile to a concrete model: the band selects the candidate, and
 * the candidate must be available in this session. There is deliberately no
 * run-down-the-thinking-ladder or cross-band leak here — the catalog already
 * decided which pairs are legitimate, so this is a lookup. A band with no
 * available model resolves to nothing and the caller reports it as unavailable.
 */
export function resolveProfileModel(args: {
	profile: string;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
}): { model?: ModelRef; notes: string[] } {
	const parsed = parseProfile(args.profile);
	if (!parsed) return { notes: [`unknown profile "${args.profile}"`] };
	const inBand = args.candidates.filter((candidate) => candidate.tier === parsed.band);
	const model = inBand
		.map((candidate): ModelRef => ({
			provider: candidate.provider,
			model: candidate.model,
			tier: candidate.tier,
		}))
		.find((ref) => Boolean(findAvailable(ref, args.available)));
	if (!model) {
		return { notes: [`no available ${parsed.band}-band model for profile ${args.profile}`] };
	}
	return { model, notes: [] };
}

/** A one-line task for the `subagent` tool, kept in the plan so it can be pasted. */
export function buildTask(
	track: TrackName,
	profile: string,
	evidence: ReviewPlan["evidence"],
	summary: string,
): string {
	const facts = [
		`${evidence.files} file(s), +${evidence.added}/-${evidence.removed}`,
		evidence.signals.length > 0 ? `signals: ${evidence.signals.join("; ")}` : "no risk signals detected",
	].join(". ");
	if (track === "adversarial") {
		return [
			`Adversarially review this change using profile ${profile}. Your job is to falsify it, not to summarise it.`,
			`Change: ${summary}`,
			`Evidence: ${facts}.`,
			"Look for correctness bugs, security holes, unhandled edge cases, untrusted-input handling, and silent error recovery that hides failures.",
			"Report discrete, actionable findings with evidence (file and line), worst first, and say explicitly if you find nothing.",
		].join("\n");
	}
	return [
		`Review the design complexity of this change using profile ${profile}.`,
		`Change: ${summary}`,
		`Evidence: ${facts}.`,
		"Judge whether it is over-engineered, whether a simpler design fits the codebase, and whether any new abstraction earns its keep.",
		"Flag unnecessary wrappers, indirection and speculative generality; also note the parts of the design that are right.",
		"Report discrete, actionable findings with evidence (file and line), and say explicitly if the design is sound.",
	].join("\n");
}

function composeTrack(args: {
	track: TrackName;
	judgment?: TrackJudgment;
	failure?: string;
	gates: PolicyGates;
	config: TriageConfig;
	catalog: readonly ProfileOption[];
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	evidence: ReviewPlan["evidence"];
	summary: string;
}): TrackPlan {
	const decision = decidePolicy({
		judgment: args.judgment,
		failure: args.failure,
		gates: args.gates,
		config: args.config.policy,
		catalog: args.catalog.map((option) => option.key),
	});

	const base: TrackPlan = {
		track: args.track,
		needed: decision.status !== "skipped",
		skipConfidence: decision.skipConfidence,
		routingConfidence: args.judgment?.routingConfidence ?? 0,
		proposedChoice: decision.skip ? PROFILE_NONE : (args.judgment?.reviewAlternative ?? ""),
		...(decision.profile ? { finalChoice: decision.profile } : {}),
		thinking: "off",
		status: decision.status,
		source: decision.source,
		reasonCodes: decision.reasonCodes,
		notes: [],
	};

	if (decision.status === "skipped") {
		base.notes.push(
			`P(none) ${decision.skipConfidence.toFixed(2)} > ${args.config.policy.skipThreshold} and every gate passed.`,
		);
		return base;
	}

	if (!decision.profile) {
		base.notes.push("no allowed profile resolves to an available model.");
		return base;
	}

	const profile = parseProfile(decision.profile);
	if (!profile) {
		base.notes.push(`policy returned an unparseable profile "${decision.profile}".`);
		return { ...base, status: "unavailable" };
	}

	const resolution = resolveProfileModel({
		profile: decision.profile,
		candidates: args.candidates,
		available: args.available,
	});
	base.notes.push(...resolution.notes);
	if (!resolution.model) {
		return { ...base, status: "unavailable" };
	}

	const catalogue = findAvailable(resolution.model, args.available);
	const resolvedThinking = clampThinking(profile.thinking, catalogue);
	if (resolvedThinking !== profile.thinking) {
		// Reaching here means the catalog was generated against a different
		// runtime map. Log it rather than silently claiming the requested level.
		base.notes.push(
			`profile ${decision.profile} requests thinking ${profile.thinking}, but ` +
				`${resolution.model.provider}/${resolution.model.model} clamps it to ${resolvedThinking}.`,
		);
	}

	return {
		...base,
		thinking: resolvedThinking,
		model: resolution.model,
		task: buildTask(args.track, decision.profile, args.evidence, args.summary),
	};
}

export interface ComposeArgs {
	/** The judge's answer; absent when the judge failed. */
	judgment?: Judgment;
	/** A judge failure reason; set only when `judgment` is absent. */
	failure?: string;
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	catalog: readonly ProfileOption[];
	gates: PolicyGates;
	evidence: { files: number; added: number; removed: number; signals: string[] };
	summary: string;
}

export function composePlan(args: ComposeArgs): ReviewPlan {
	const adversarial = composeTrack({
		track: "adversarial",
		judgment: args.judgment?.adversarial,
		failure: args.failure,
		gates: args.gates,
		config: args.config,
		catalog: args.catalog,
		candidates: args.candidates,
		available: args.available,
		evidence: args.evidence,
		summary: args.summary,
	});
	const complexity = composeTrack({
		track: "complexity",
		judgment: args.judgment?.complexity,
		failure: args.failure,
		gates: args.gates,
		config: args.config,
		catalog: args.catalog,
		candidates: args.candidates,
		available: args.available,
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
		judge: args.judgment?.judge ?? "unavailable",
		latencyMs: args.judgment?.latencyMs ?? 0,
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
		skipConfidence: 0,
		routingConfidence: 0,
		proposedChoice: "",
		thinking: "off",
		status: "unavailable",
		source: "none",
		reasonCodes: ["disabled"],
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
 * What to do when Jev cannot be reached. Routed through policy so the result is
 * a `fallback` marked `policy-fallback` — a conservative profile, never `none`
 * and never mistaken for a judgement. This is the one place the extension
 * spends review tokens it was not asked for, and it is deliberate: an
 * unreachable judge should not buy a skipped review.
 */
export function failOpenPlan(args: Omit<ComposeArgs, "judgment" | "failure"> & { reason: string }): ReviewPlan {
	const plan = composePlan({ ...args, failure: args.reason });
	plan.verdict = `${plan.verdict} (judge unavailable)`;
	return plan;
}
