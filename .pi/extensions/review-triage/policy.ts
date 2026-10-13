/**
 * Skip eligibility and fallback — the part of the decision that is policy, not
 * judgement.
 *
 * Jev answers one question per track: a distribution over `none` and the
 * allowed profiles. This module turns that distribution, plus a handful of
 * deterministic gates, into the decision the rest of the tool acts on:
 *
 *   - `none` is permitted only when **every** gate passes. A high `P(none)` is
 *     necessary, never sufficient: a stable snapshot, no unresolved conflict,
 *     complete-enough evidence, and no mandatory-review restriction must all
 *     hold. One failing gate is enough to keep the review.
 *   - When skip is refused, the review routes to Jev's best non-`none` option,
 *     then to the configured minimum profile, then to the weakest profile the
 *     catalog offers.
 *   - When the judge failed (malformed, timeout, unavailable, insufficient
 *     evidence), `none` is never returned: the conservative profile is used and
 *     marked `policy-fallback`. If nothing at all resolves, the status is
 *     `unavailable` — never a fictional model.
 *
 * This file is pure. It does not read config, files or a clock; every input is
 * an argument, so a decision can be replayed from a saved judgement.
 */

import { profileRank, type PolicyConfig } from "./config.ts";
import type { TrackJudgment } from "./judge.ts";

/** Deterministic tags explaining a decision. Treated as data, never executed. */
export const POLICY_REASONS = {
	skipConfidence: "skip-confidence",
	gatesPassed: "gates-passed",
	skipBelowThreshold: "skip-below-threshold",
	mandatoryReview: "mandatory-review",
	unstableSnapshot: "unstable-snapshot",
	unresolvedConflicts: "unresolved-conflicts",
	incompleteEvidence: "incomplete-evidence",
	budgetTrimmed: "budget-trimmed",
	judgeFailure: "judge-failure",
	noJudgement: "no-judgement",
	reviewAlternative: "review-alternative",
	policyFallback: "policy-fallback",
	noProfileAvailable: "no-profile-available",
} as const;

export type PolicyStatus = "skipped" | "recommended" | "fallback" | "unavailable";
export type PolicySource = "jev" | "policy-fallback" | "none";

/**
 * A deterministic sentence per reason code. `rationale` is a template over
 * `reasonCodes`, never free text — Jev is not asked for prose, so the plan can
 * only publish sentences this table wrote. An unknown code is carried through
 * verbatim rather than dropped, so a new trigger is visible before its sentence
 * is written. `disabled` is not a policy decision but lives here so the
 * disabled plan's rationale comes from the same template.
 */
const RATIONALE_SENTENCES: Record<string, string> = {
	[POLICY_REASONS.skipConfidence]: "the judged probability of no review cleared the threshold",
	[POLICY_REASONS.gatesPassed]: "every skip gate passed",
	[POLICY_REASONS.skipBelowThreshold]: "the judged probability of no review was at or below the threshold",
	[POLICY_REASONS.mandatoryReview]: "policy makes a review mandatory for this track",
	[POLICY_REASONS.unstableSnapshot]: "the snapshot was unstable during collection",
	[POLICY_REASONS.unresolvedConflicts]: "unresolved merge conflicts were present",
	[POLICY_REASONS.incompleteEvidence]: "the evidence was incomplete",
	[POLICY_REASONS.budgetTrimmed]: "the dossier was too large for the character budget and was trimmed",
	[POLICY_REASONS.judgeFailure]: "the judge failed, so a conservative profile was used",
	[POLICY_REASONS.noJudgement]: "no judgement was available",
	[POLICY_REASONS.reviewAlternative]: "the judge preferred a review profile",
	[POLICY_REASONS.policyFallback]: "policy fell back to a conservative profile",
	[POLICY_REASONS.noProfileAvailable]: "no profile resolved to an available model",
	disabled: "review-triage is disabled, so nothing was judged",
};

/** Render a reason-code list as one sentence list. Pure and order-preserving. */
export function rationaleFor(reasonCodes: readonly string[]): string {
	if (reasonCodes.length === 0) return "no specific reason was recorded.";
	const parts = reasonCodes.map(
		(code) => RATIONALE_SENTENCES[code] ?? `unrecognised reason code ${JSON.stringify(code)}`,
	);
	return `${parts.join("; ")}.`;
}

/**
 * The deterministic conditions that must all hold before `none` is allowed.
 * Each is supplied by the caller: `stable`, `conflicts` and `evidenceComplete`
 * come from the collector (see the dossier/collector work); `mandatoryReview`
 * is a configured restriction.
 */
export interface PolicyGates {
	/** The collector reported a stable snapshot (no index lock, no in-progress operation). */
	stable: boolean;
	/** Unresolved merge conflicts are present. */
	conflicts: boolean;
	/** Required evidence is present and omissions are within the completeness threshold. */
	evidenceComplete: boolean;
	/**
	 * The character budget — not the manifest limit or a redaction — forced the
	 * omission. Only a reason code: `evidenceComplete` already refuses the skip.
	 */
	budgetTrimmed: boolean;
	/** Policy forbids skipping this track. */
	mandatoryReview: boolean;
}

/** Everything `decidePolicy` needs: the judgement, the gates, the threshold and the catalog. */
export interface PolicyInput {
	/** Present when the judge answered. */
	judgment?: Pick<TrackJudgment, "skipConfidence" | "reviewAlternative"> | undefined;
	/** Set when the judge failed; a failure never skips. */
	failure?: string | undefined;
	gates: PolicyGates;
	config: PolicyConfig;
	/** Allowed profile keys, weakest first. `none` is never a member. */
	catalog: readonly string[];
}

export interface PolicyDecision {
	/** True only when every gate passed and `P(none)` cleared the threshold. */
	skip: boolean;
	status: PolicyStatus;
	source: PolicySource;
	/** The resolved profile key; present whenever `status` is recommended/fallback. */
	profile?: string;
	/** Deterministic tags; `rationale` in the output is a template over these. */
	reasonCodes: string[];
	/** `P(none)` that informed the decision (0 when there was no judgement). */
	skipConfidence: number;
}

function strongest(catalog: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const key of catalog) {
		if (best === undefined || profileRank(key) > profileRank(best)) best = key;
	}
	return best;
}

function weakest(catalog: readonly string[]): string | undefined {
	let worst: string | undefined;
	for (const key of catalog) {
		if (worst === undefined || profileRank(key) < profileRank(worst)) worst = key;
	}
	return worst;
}

/**
 * Resolve the profile to review with when skip is refused or the judge failed.
 * The normal path (skip refused) prefers Jev's best alternative, then the
 * configured minimum floor. The conservative path (a judge failure) prefers
 * the configured fallback, then the floor. Both end at the weakest profile the
 * catalog offers, and then at `unavailable`.
 */
function resolveReview(
	input: PolicyInput,
	allowed: ReadonlySet<string>,
): { profile?: string; status: PolicyStatus; source: PolicySource; codes: string[] } {
	const codes: string[] = [];
	const pick = (key: string | undefined): string | undefined =>
		key && allowed.has(key) ? key : undefined;

	if (input.failure === undefined) {
		const alternative = pick(input.judgment?.reviewAlternative);
		if (alternative) {
			codes.push(POLICY_REASONS.reviewAlternative);
			return { profile: alternative, status: "recommended", source: "jev", codes };
		}
		const minimum = pick(input.config.minimumProfile) ?? weakest(input.catalog);
		if (minimum) {
			codes.push(POLICY_REASONS.policyFallback);
			return { profile: minimum, status: "fallback", source: "policy-fallback", codes };
		}
		codes.push(POLICY_REASONS.noProfileAvailable);
		return { status: "unavailable", source: "policy-fallback", codes };
	}

	const conservative = pick(input.config.fallbackProfile) ?? strongest(input.catalog);
	if (conservative) {
		codes.push(POLICY_REASONS.policyFallback);
		return { profile: conservative, status: "fallback", source: "policy-fallback", codes };
	}
	const minimum = pick(input.config.minimumProfile) ?? weakest(input.catalog);
	if (minimum) {
		codes.push(POLICY_REASONS.policyFallback);
		return { profile: minimum, status: "fallback", source: "policy-fallback", codes };
	}

	codes.push(POLICY_REASONS.noProfileAvailable);
	return { status: "unavailable", source: "policy-fallback", codes };
}

/**
 * Decide whether to skip the review, and if not, which profile to use. The
 * threshold comparison is strictly greater, so with the default `0.90` a
 * `P(none)` of exactly `0.90` keeps the review.
 */
export function decidePolicy(input: PolicyInput): PolicyDecision {
	const allowed = new Set(input.catalog);
	const skipConfidence = input.judgment?.skipConfidence ?? 0;
	const reasonCodes: string[] = [];

	const gatesPassed =
		input.judgment !== undefined &&
		input.failure === undefined &&
		// A skip is only meaningful when a review was actually on the table: an
		// empty catalog means no profile could have run, so a `none` here would
		// be a confident "no review" over a broken registry, not a judgement.
		input.catalog.length > 0 &&
		skipConfidence > input.config.skipThreshold &&
		!input.gates.mandatoryReview &&
		input.gates.stable &&
		!input.gates.conflicts &&
		input.gates.evidenceComplete;

	if (gatesPassed) {
		reasonCodes.push(POLICY_REASONS.skipConfidence, POLICY_REASONS.gatesPassed);
		return { skip: true, status: "skipped", source: "none", reasonCodes, skipConfidence };
	}

	// Record precisely which gate(s) kept the review, so the audit trail says
	// why rather than only that skip did not happen.
	if (input.failure !== undefined) reasonCodes.push(POLICY_REASONS.judgeFailure);
	else if (input.judgment === undefined) reasonCodes.push(POLICY_REASONS.noJudgement);
	else if (skipConfidence <= input.config.skipThreshold) reasonCodes.push(POLICY_REASONS.skipBelowThreshold);
	if (input.gates.mandatoryReview) reasonCodes.push(POLICY_REASONS.mandatoryReview);
	if (!input.gates.stable) reasonCodes.push(POLICY_REASONS.unstableSnapshot);
	if (input.gates.conflicts) reasonCodes.push(POLICY_REASONS.unresolvedConflicts);
	if (!input.gates.evidenceComplete) {
		reasonCodes.push(POLICY_REASONS.incompleteEvidence);
		// Name the cause when it is the size of the change rather than a failed
		// collection, so the audit trail says what actually happened.
		if (input.gates.budgetTrimmed) reasonCodes.push(POLICY_REASONS.budgetTrimmed);
	}

	const review = resolveReview(input, allowed);
	return {
		skip: false,
		status: review.status,
		source: review.source,
		...(review.profile ? { profile: review.profile } : {}),
		reasonCodes: [...reasonCodes, ...review.codes],
		skipConfidence,
	};
}
