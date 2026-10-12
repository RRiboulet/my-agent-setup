/**
 * Rendering for review triage.
 *
 * The tool result is read by the agent and, later, by a human scrolling the
 * transcript, so it is plain text with no escape codes and no layout that only
 * makes sense at one terminal width. The structured plan travels in the tool's
 * `details`; this file is presentation only.
 */

import type { ReviewPlan, TrackPlan } from "./compose.ts";

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function formatTrack(track: TrackPlan): string {
	const headline = track.track === "adversarial" ? "Adversarial" : "Complexity";
	if (!track.needed) {
		return `${headline}: not needed (P(none) ${track.skipConfidence.toFixed(2)}) — ${track.rationale}`;
	}

	const fallback = track.status === "fallback" ? " · policy fallback" : "";
	const lines = [`${headline}: NEEDED${fallback}`];
	if (track.model) {
		const resolved = track.resolvedThinking ?? "off";
		const requested = track.requestedThinking;
		const thinking =
			requested === undefined || requested === resolved
				? `thinking ${resolved}`
				: `thinking ${resolved} (requested ${requested}, clamped)`;
		lines.push(
			`  profile ${track.finalChoice} · ${thinking} · model ${track.model.provider}/${track.model.model} (${track.model.tier})`,
		);
	} else {
		lines.push(`  no review model available for ${track.finalChoice ?? "a review"} (${track.status})`);
	}
	// The rationale is the human sentence; the codes stay next to it so the
	// audit trail is visible in the transcript, not only in `details`.
	lines.push(`  because: ${track.rationale} [${track.reasonCodes.join(", ")}]`);
	if (track.notes.length > 0) {
		lines.push(`  notes: ${track.notes.join(" ")}`);
	}
	if (track.task) {
		lines.push("  task:");
		lines.push(indent(track.task, "    "));
	}
	return lines.join("\n");
}

/** How many evidence limitations the plain-text plan shows before counting the rest. */
const RENDERED_LIMITATIONS = 5;

export function formatPlan(plan: ReviewPlan): string {
	const lines = [`Review triage — ${plan.verdict} [${plan.status}]`];
	// The scope identity is a published field, so the transcript shows what was
	// measured from where, not just how much.
	const scope =
		plan.scope.snapshot && plan.scope.snapshot !== plan.scope.target
			? `${plan.scope.target} @ ${plan.scope.snapshot}`
			: plan.scope.target;
	lines.push(
		`Judge ${plan.judge} in ${plan.latencyMs} ms · scope ${scope} · ${plan.evidence.files} file(s), +${plan.evidence.added}/-${plan.evidence.removed}`,
	);
	if (plan.evidence.signals.length > 0) lines.push(`Signals: ${plan.evidence.signals.join("; ")}`);
	if (plan.fingerprint) lines.push(`Dossier ${plan.fingerprint.slice(0, 12)}…`);
	if (plan.limitations.length > 0) {
		// A large change can carry hundreds of trims and redactions; the full list
		// stays in the structured plan, but the transcript shows a bounded sample.
		const shown = plan.limitations.slice(0, RENDERED_LIMITATIONS);
		const extra = plan.limitations.length - shown.length;
		lines.push(`Limitations: ${shown.join("; ")}${extra > 0 ? `; +${extra} more` : ""}`);
	}
	lines.push("");
	lines.push(formatTrack(plan.adversarial));
	lines.push("");
	lines.push(formatTrack(plan.complexity));
	return lines.join("\n");
}
