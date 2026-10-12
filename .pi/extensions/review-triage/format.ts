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
		return `${headline}: not needed (P(none) ${track.skipConfidence.toFixed(2)})`;
	}

	const fallback = track.status === "fallback" ? " · policy fallback" : "";
	const lines = [`${headline}: NEEDED${fallback}`];
	if (track.model) {
		lines.push(
			`  profile ${track.finalChoice} · thinking ${track.thinking} · model ${track.model.provider}/${track.model.model} (${track.model.tier})`,
		);
	} else {
		lines.push(`  no review model available for ${track.finalChoice ?? "a review"} (${track.status})`);
	}
	if (track.reasonCodes.length > 0) lines.push(`  because: ${track.reasonCodes.join(", ")}`);
	if (track.notes.length > 0) {
		lines.push(`  notes: ${track.notes.join(" ")}`);
	}
	if (track.task) {
		lines.push("  task:");
		lines.push(indent(track.task, "    "));
	}
	return lines.join("\n");
}

export function formatPlan(plan: ReviewPlan): string {
	const lines = [`Review triage — ${plan.verdict}`];
	lines.push(
		`Judge ${plan.judge} in ${plan.latencyMs} ms · ${plan.evidence.files} file(s), +${plan.evidence.added}/-${plan.evidence.removed}`,
	);
	if (plan.evidence.signals.length > 0) lines.push(`Signals: ${plan.evidence.signals.join("; ")}`);
	lines.push("");
	lines.push(formatTrack(plan.adversarial));
	lines.push("");
	lines.push(formatTrack(plan.complexity));
	return lines.join("\n");
}
