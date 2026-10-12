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
		return `${headline}: not needed (P(depth = none) ${(1 - track.neededProbability).toFixed(2)})`;
	}

	// The whole distribution is shown, not just the rung it landed on: a
	// near-tie between standard and deep is exactly what the confidence gate is
	// deciding on, and hiding it would make the plan look more certain than it is.
	const depth = (["none", "light", "standard", "deep"] as const)
		.map((level) => `${level} ${(track.depth[level] ?? 0).toFixed(2)}`)
		.join(" · ");
	const lines = [
		`${headline}: NEEDED`,
		`  depth ${depth} · tier ${track.tier}`,
	];
	if (track.model) {
		lines.push(
			`  model ${track.model.provider}/${track.model.model} (${track.model.tier}) · thinking ${track.thinking}${track.fallbackUsed ? " · fallback" : ""}`,
		);
	} else {
		lines.push(`  no review model available — choose one for a ${track.tier} review, thinking ${track.thinking}`);
	}
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
