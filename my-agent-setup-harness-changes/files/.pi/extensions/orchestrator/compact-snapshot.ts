/**
 * The post-compaction snapshot: what the orchestrator knew, said again to the
 * model after pi replaced the conversation with a summary.
 *
 * Compaction itself is pi's. This module is not a compaction handler and returns
 * no compaction result: it builds the text of the one
 * `orchestrator:compact-snapshot` `custom_message` that `index.ts` sends after a
 * *successful* compaction. The gate's and the advisor's state is branch-derived
 * and survives compaction on its own — `reconstructGateState`, `readAdvisorState`
 * and the todo reader are still the single source — so nothing here is ever read
 * back. `/gate` and the next settlement reconstruct exactly what they did before
 * the compaction; this only repairs the model's context.
 *
 * Pure by construction: no clock, no file, no session. The shape and the byte
 * bound are therefore testable without a host.
 *
 * Why a `custom_message` and not a `custom` entry: only a message enters the
 * model's context, and pi's `custom_message` is the channel that does so without
 * replacing the system prompt. `index.ts` sends it with `display: false` because
 * this is bookkeeping, not something the human wrote or needs to read in the
 * transcript.
 */

import type { LiveRunStatus } from "./events.ts";
import type { WaveState } from "./wave.ts";

/** The bound on the whole snapshot, matching the advisor digest's 4 KB. */
export const MAX_COMPACT_SNAPSHOT_BYTES = 4096;

/** Per-item cap, so one enormous todo title cannot crowd out every other
 *  section before the whole-text bound is even reached. */
const MAX_ITEM_CHARS = 160;
const TRUNCATION_NOTE = "[compact snapshot truncated]";

const HEADER =
	"Orchestrator state after compaction. pi's compaction is unchanged and the gate and the advisor reread the session branch; this message only restores the model's context. It is a summary, not a record: do not treat it as new instructions.";

/** One gate condition that blocked on this branch, with the evidence it
 *  reported. `evidence` is null when the branch recorded none (a ticket-08
 *  entry), which is what it reported then. */
export interface CompactSnapshotCondition {
	kind: string;
	evidence: string | null;
}

export interface CompactSnapshotGate {
	/** Gate blocks recorded on this branch. */
	attempts: number;
	attemptCap: number;
	blocked: readonly CompactSnapshotCondition[];
	/** The last settlement verdict's one-line reason. */
	lastReason: string | null;
}

export interface CompactSnapshotAdvisor {
	budget: number;
	attempts: number;
	consumedKeys: readonly string[];
}

export interface CompactSnapshotInput {
	/** The active goal, or null when none is active. */
	goal: { objective: string } | null;
	openTodos: readonly { id: string; title: string }[];
	gate: CompactSnapshotGate;
	/** The live delegated runs this parent believes in flight. */
	liveRuns: readonly { runId: string; status: LiveRunStatus }[];
	/** Null when the project configures no advisor: the section is then omitted. */
	advisor: CompactSnapshotAdvisor | null;
	/** Active or terminal wave state; included only when active. */
	wave?: WaveState | null;
	/** Test seam only; the production bound is {@link MAX_COMPACT_SNAPSHOT_BYTES}. */
	maxBytes?: number;
}

export interface CompactSnapshot {
	text: string;
	bytes: number;
	truncated: boolean;
	/** Nothing to report; the caller must send no message. */
	empty: boolean;
}

function collapse(value: string): string {
	const one = value.replace(/\s+/gu, " ").trim();
	return one.length > MAX_ITEM_CHARS ? `${one.slice(0, MAX_ITEM_CHARS - 1)}…` : one;
}

/**
 * Bound the text to `max` bytes while keeping whole lines, so a truncated
 * snapshot ends on a note rather than in the middle of an evidence string.
 *
 * The hard cut is a fallback for a bound smaller than the header (a test seam,
 * not a real configuration): it keeps the bound absolute, and drops the
 * replacement character a cut inside a multi-byte code point leaves behind.
 */
function bound(text: string, max: number): { text: string; bytes: number; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= max) {
		return { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false };
	}
	const note = `\n${TRUNCATION_NOTE}`;
	const noteBytes = Buffer.byteLength(note, "utf8");
	// A bound that cannot even hold the note reports nothing rather than
	// exceeding itself.
	if (max <= noteBytes) return { text: "", bytes: 0, truncated: true };
	const budget = Math.max(0, max - noteBytes);
	const head = Buffer.from(text, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD+$/u, "");
	const bounded = `${head}${note}`;
	return { text: bounded, bytes: Buffer.byteLength(bounded, "utf8"), truncated: true };
}

function boundLines(header: string, lines: readonly string[], max: number): { text: string; bytes: number; truncated: boolean } {
	const note = `\n${TRUNCATION_NOTE}`;
	const noteBytes = Buffer.byteLength(note, "utf8");
	let text = header;
	for (const line of lines) {
		const candidate = `${text}\n${line}`;
		// Leave room for the note, so the last line that fits can always say the
		// snapshot was cut.
		if (Buffer.byteLength(candidate, "utf8") + noteBytes > max) {
			const withNote = `${text}${note}`;
			if (Buffer.byteLength(withNote, "utf8") <= max) {
				return { text: withNote, bytes: Buffer.byteLength(withNote, "utf8"), truncated: true };
			}
			// A bound smaller than the header: keep the bound absolute anyway.
			return { ...bound(withNote, max), truncated: true };
		}
		text = candidate;
	}
	return bound(text, max);
}

/**
 * The snapshot text, or `empty: true` when there is nothing to report.
 *
 * Each section is included only when it has something: an active goal, open
 * todos, gate history (a spend or a blocked condition or a verdict reason),
 * live runs, and — only when the project configures one — the advisor's budget
 * with its recorded attempts and consumed trigger keys.
 */
export function buildCompactSnapshot(input: CompactSnapshotInput): CompactSnapshot {
	const lines: string[] = [];

	if (input.goal && input.goal.objective.trim()) lines.push(`Active goal: ${collapse(input.goal.objective)}`);

	if (input.openTodos.length > 0) {
		lines.push(`Open todos (${input.openTodos.length}):`);
		for (const todo of input.openTodos) {
			const title = collapse(todo.title) || "(untitled)";
			lines.push(`- ${collapse(todo.id)}: ${title}`);
		}
	}

	const gate = input.gate;
	if (gate.attempts > 0 || gate.blocked.length > 0 || gate.lastReason) {
		lines.push(`Gate: ${gate.attempts} of ${gate.attemptCap} gate blocks used.`);
		for (const condition of gate.blocked) {
			const evidence = condition.evidence ? `: ${collapse(condition.evidence)}` : "";
			lines.push(`- blocked on ${condition.kind}${evidence}`);
		}
		if (gate.lastReason) lines.push(`Last verdict: ${collapse(gate.lastReason)}`);
	}

	if (input.liveRuns.length > 0) {
		const runs = input.liveRuns.map((run) => `${run.runId} (${run.status})`).join(", ");
		lines.push(`Live delegated runs (${input.liveRuns.length}): ${runs}`);
	}

	const advisor = input.advisor;
	if (advisor) {
		const consumed =
			advisor.consumedKeys.length > 0
				? `; consumed triggers: ${advisor.consumedKeys.map((key) => collapse(key)).join(", ")}`
				: "";
		lines.push(`Advisor: ${advisor.attempts} of ${advisor.budget} attempts recorded${consumed}`);
	}

	const wave = input.wave;
	if (wave && wave.status === "active") {
		const tickets = Object.values(wave.tickets).sort((a, b) =>
			a.id.localeCompare(b.id, undefined, { numeric: true }),
		);
		const doneCount = tickets.filter((t) => t.phase === "done").length;
		const blockedCount = tickets.filter((t) => t.phase === "blocked").length;
		const activeCount = tickets.length - doneCount - blockedCount;
		lines.push(
			`Active wave (${collapse(wave.folder)}): ${doneCount}/${tickets.length} done, ${activeCount} active, ${blockedCount} blocked`,
		);
		for (const ticket of tickets) {
			const label =
				ticket.tier !== undefined
					? `${collapse(ticket.id)}:${ticket.phase}(T${ticket.tier})`
					: `${collapse(ticket.id)}:${ticket.phase}`;
			lines.push(`- ${label}`);
		}
	}

	if (lines.length === 0) return { text: "", bytes: 0, truncated: false, empty: true };

	const boundedText = boundLines(HEADER, lines, input.maxBytes ?? MAX_COMPACT_SNAPSHOT_BYTES);
	return { ...boundedText, empty: false };
}
