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
	PolicyConfig,
	ProfileOption,
	ThinkingLevel,
	TriageConfig,
	TrackName,
} from "./config.ts";
import { PROFILE_NONE, parseProfile, THINKING_RANK } from "./config.ts";
import type { Judgment, TrackJudgment } from "./judge.ts";
import type { DossierScope, DossierTask } from "./dossier.ts";
import {
	decidePolicy,
	rationaleFor,
	type PolicyGates,
	type PolicySource,
	type PolicyStatus,
} from "./policy.ts";

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
	/**
	 * Jev's probabilities are not calibrated, so the marker travels with them:
	 * a consumer must not read `skipConfidence`/`routingConfidence` as
	 * frequentist confidence. Published, never inferred.
	 */
	calibration: "uncalibrated";
	/** The winning non-none profile's averaged probability. */
	routingConfidence: number;
	/** Jev's overall argmax (may be `none`), kept for the audit trail. */
	proposedChoice: string;
	/** The profile policy resolved to, present when a review is recommended. */
	finalChoice?: string;
	/**
	 * The thinking level the resolved profile asked for. Present whenever a
	 * profile was chosen, even if no model resolved it, so the request is not
	 * confused with a track that never had one.
	 */
	requestedThinking?: ThinkingLevel;
	/**
	 * The level after the runtime clamp. Present only when a model resolved and
	 * something will actually run; absent is "nothing ran", which is distinct
	 * from a model that runs at `off`.
	 */
	resolvedThinking?: ThinkingLevel;
	model?: ModelRef;
	status: PolicyStatus;
	source: PolicySource;
	/** Deterministic tags; `rationale` is a template over these. */
	reasonCodes: string[];
	/** One sentence per reason code. Never Jev's prose. */
	rationale: string;
	notes: string[];
	/** Ready-to-paste task for the `subagent` tool, present only when needed. */
	task?: string;
}

/** The plan-level rollup of the two track statuses, plus the disabled state. */
export type PlanStatus = PolicyStatus | "disabled";

/**
 * The configured policy in force for this run. A profile named here is what the
 * config offered, not necessarily what ran: if the catalog did not allow it,
 * `decidePolicy` fell through to the weakest allowed profile or to
 * `unavailable`, and the track's `reasonCodes` say which.
 */
export interface PolicyOverrides {
	/** `P(none)` must be strictly greater than this to skip. */
	skipThreshold: number;
	/** When true, `none` was never allowed for either track. */
	mandatoryReview: boolean;
	/** The configured floor used when no alternative resolved. */
	minimumProfile?: string;
	/** The conservative profile used when the judge failed. */
	fallbackProfile?: string;
}

/** The task identity the plan publishes: the dossier's task, unchanged. */
export type PlanTask = DossierTask;

/** The scope identity the plan publishes: the dossier's scope, unchanged. */
export type PlanScope = DossierScope;

/** Recommendation context published alongside the decision. */
export interface PlanContext {
	task: PlanTask;
	scope: PlanScope;
	/** Known gaps in the evidence; the recommendation is read with them. */
	limitations: string[];
	/** Version identifiers for the rules that produced the evidence. */
	versions: Record<string, string>;
}

/** Identifies the published plan shape, so a consumer knows which fields to expect. */
export const PLAN_VERSION = "1";

export interface ReviewPlan {
	verdict: string;
	/** The best actionable outcome across the tracks; see `planStatus`. */
	status: PlanStatus;
	adversarial: TrackPlan;
	complexity: TrackPlan;
	judge: string;
	latencyMs: number;
	/** SHA-256 of the dossier Jev judged, so a verdict can be replayed against its evidence. */
	fingerprint?: string;
	/** The policy in force, published so a decision can be replayed. */
	policyOverrides: PolicyOverrides;
	/** The task the evidence was measured for. */
	task: PlanTask;
	/** The scope the evidence was measured from. */
	scope: PlanScope;
	/** Known gaps and omissions in the evidence. */
	limitations: string[];
	/** Version identifiers for the rules and contract that produced the plan. */
	versions: Record<string, string>;
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

/**
 * Jev's pick, verbatim but bounded. It is model output read from untrusted
 * evidence, so it may name a profile the catalog does not allow; `finalChoice`
 * is what policy actually resolved. The bound keeps a malformed answer from
 * bloating the session entry.
 */
function boundedChoice(choice: string | undefined): string {
	if (!choice) return "";
	return choice.length > 80 ? `${choice.slice(0, 77)}...` : choice;
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
		calibration: "uncalibrated",
		routingConfidence: args.judgment?.routingConfidence ?? 0,
		proposedChoice: decision.skip ? PROFILE_NONE : boundedChoice(args.judgment?.reviewAlternative),
		...(decision.profile ? { finalChoice: decision.profile } : {}),
		status: decision.status,
		source: decision.source,
		reasonCodes: decision.reasonCodes,
		rationale: rationaleFor(decision.reasonCodes),
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

	// The profile was chosen, so the request is published even if no model
	// resolves it: "requested max, nothing ran" must not read as "requested off".
	const requested: TrackPlan = { ...base, requestedThinking: profile.thinking };

	const resolution = resolveProfileModel({
		profile: decision.profile,
		candidates: args.candidates,
		available: args.available,
	});
	requested.notes.push(...resolution.notes);
	if (!resolution.model) {
		return { ...requested, status: "unavailable" };
	}

	const catalogue = findAvailable(resolution.model, args.available);
	const resolvedThinking = clampThinking(profile.thinking, catalogue);
	if (resolvedThinking !== profile.thinking) {
		// Reaching here means the catalog was generated against a different
		// runtime map. Log it rather than silently claiming the requested level.
		requested.notes.push(
			`profile ${decision.profile} requests thinking ${profile.thinking}, but ` +
				`${resolution.model.provider}/${resolution.model.model} clamps it to ${resolvedThinking}.`,
		);
	}

	return {
		...requested,
		resolvedThinking,
		model: resolution.model,
		task: buildTask(args.track, decision.profile, args.evidence, args.summary),
	};
}

export interface ComposeArgs {
	/** The judge's answer; absent when the judge failed. */
	judgment?: Judgment;
	/** A judge failure reason; set only when `judgment` is absent. */
	failure?: string;
	/** SHA-256 of the dossier that was judged, recorded for replay. */
	fingerprint?: string;
	config: TriageConfig;
	candidates: readonly Candidate[];
	available: readonly AvailableModel[];
	catalog: readonly ProfileOption[];
	gates: PolicyGates;
	evidence: { files: number; added: number; removed: number; signals: string[] };
	summary: string;
	/** The task, scope, limitations and versions published with the plan. */
	context: PlanContext;
}

/**
 * The rollup of the two track statuses. It is the best actionable outcome, not
 * the worst — a genuine recommendation is still a recommendation when the other
 * track could not resolve — and each track publishes its own status, so the
 * degradation is not hidden. Precedence: both-skipped > recommended > fallback
 * > unavailable.
 */
function planStatus(adversarial: TrackPlan, complexity: TrackPlan): PlanStatus {
	const statuses = [adversarial.status, complexity.status];
	if (statuses.every((status) => status === "skipped")) return "skipped";
	if (statuses.some((status) => status === "recommended")) return "recommended";
	if (statuses.some((status) => status === "fallback")) return "fallback";
	return "unavailable";
}

/**
 * The effective policy, published so a decision can be replayed without the
 * config file. `mandatoryReview` is read from the gate the decision actually
 * used, not re-derived from the config, so the published policy cannot disagree
 * with the decision when a caller supplies the two separately.
 */
function policyOverridesOf(policy: PolicyConfig, mandatoryReview: boolean): PolicyOverrides {
	return {
		skipThreshold: policy.skipThreshold,
		mandatoryReview,
		...(policy.minimumProfile ? { minimumProfile: policy.minimumProfile } : {}),
		...(policy.fallbackProfile ? { fallbackProfile: policy.fallbackProfile } : {}),
	};
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

	const wanted = [
		adversarial.needed ? "adversarial" : undefined,
		complexity.needed ? "complexity" : undefined,
	].filter((part): part is string => part !== undefined);
	// A verdict must not read "no review" over a track that needed one but could
	// not resolve a model: that is "no review was possible", not "none needed".
	const resolvable = [adversarial, complexity].some(
		(track) => track.status === "recommended" || track.status === "fallback",
	);
	const verdict =
		wanted.length === 0
			? "no review"
			: resolvable
				? wanted.join(" + ")
				: "no review (no review model resolved)";

	return {
		verdict,
		status: planStatus(adversarial, complexity),
		adversarial,
		complexity,
		judge: args.judgment?.judge ?? "unavailable",
		latencyMs: args.judgment?.latencyMs ?? 0,
		...(args.fingerprint ? { fingerprint: args.fingerprint } : {}),
		policyOverrides: policyOverridesOf(args.config.policy, args.gates.mandatoryReview),
		task: args.context.task,
		scope: args.context.scope,
		limitations: args.context.limitations,
		// The built-in plan version is authoritative and cannot be shadowed by a
		// caller-supplied `plan` key, mirroring the dossier's `riskRules`.
		versions: { ...args.context.versions, plan: PLAN_VERSION },
		evidence: args.evidence,
	};
}

/**
 * What to return when the extension is switched off. It is not "no review" —
 * that would be a judgement the tool was told not to make — so the verdict says
 * plainly that nothing was judged.
 */
export function disabledPlan(evidence: ReviewPlan["evidence"], policy: PolicyConfig): ReviewPlan {
	const track = (name: TrackName): TrackPlan => {
		const reasonCodes = ["disabled"];
		return {
			track: name,
			needed: false,
			skipConfidence: 0,
			calibration: "uncalibrated",
			routingConfidence: 0,
			proposedChoice: "",
			status: "unavailable",
			source: "none",
			reasonCodes,
			rationale: rationaleFor(reasonCodes),
		};
	};
	return {
		verdict: "disabled (review-triage is off)",
		status: "disabled",
		adversarial: track("adversarial"),
		complexity: track("complexity"),
		judge: "disabled",
		latencyMs: 0,
		policyOverrides: policyOverridesOf(policy, policy.mandatoryReview ?? false),
		task: { summary: "" },
		scope: { target: "none", snapshot: "none" },
		limitations: ["review-triage is disabled (enabled:false or PI_REVIEW_TRIAGE_OFF)"],
		versions: { plan: PLAN_VERSION },
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
