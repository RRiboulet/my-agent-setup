// Pure status classifier for subagent runs.
//
// The child already publishes a snapshot of what it is doing (activity.ts), and
// the parent already reduces it to `run.activity` on every watcher tick. This
// module turns that stream into a *status*: "active", "waiting", "stalled", and
// the transitions between them. It is display-only — nothing here decides
// whether a run is finished, and nothing here wakes the parent.
//
// Ported from HazAT/pi-interactive-subagents (`pi-extension/subagents/status.ts`),
// with three deliberate changes:
//   - no `source: "pi" | "claude"` split (this extension only runs pi children,
//     so the claude branch was dead code and the "running" kind went with it),
//   - the stall threshold is ours and configurable (see DEFAULT_STALL_AFTER_MS:
//     our children shut themselves down at `agent_settled`, so "waiting" is
//     transient, and a legitimately silent long `bash` must not look stalled),
//   - no config file, no statusline formatters, no interrupt inference.
//
// Two rules that are easy to get wrong, and are pinned by tests:
//   - ORDER comes from the child's `sequence`, not from `updatedAt`. Both are
//     written by the same child process on this host, so there is no clock skew
//     to defend against, whereas `sequence` is a monotonic counter that survives
//     a replayed file. This is the same rule the parent applies to `run.activity`
//     (local patch 11); if the two ever disagreed, subagent_status and the widget
//     would report different phases for the same snapshot in the same tick.
//   - a snapshot that is VALID but STALE is the interesting one. A run whose
//     child is wedged keeps reporting the last phase it ever reached, so silence
//     is measured from `lastActivityAtMs`, not only from the absence of a file.
//
// The `runStatus` in the state is authoritative: a run the parent has explicitly
// marked `interrupted` reports that, whatever the snapshot says. An explicit
// state beats a guess.

/** How long a run may go without a usable snapshot before it is called stalled. */
export const DEFAULT_STALL_AFTER_MS = 180_000;

/**
 * The same threshold for a run sitting in a tool call.
 *
 * A tool has no heartbeat by construction: pi only fires `tool_execution_update`
 * when the tool produces OUTPUT (`core/tools/bash.js` skips an update when nothing
 * is dirty), so `npm ci`, `make`, `pytest -k` or a deliberate `sleep` are silent
 * for minutes while working perfectly well. Judging them by the ordinary stall
 * threshold calls a healthy child hung, which is the one mistake a status display
 * must not make. Fifteen minutes is long enough for real builds and short enough
 * that a genuinely wedged tool still shows up.
 */
export const DEFAULT_TOOL_STALL_AFTER_MS = 900_000;

export type SubagentStatusKind = "queued" | "starting" | "active" | "waiting" | "stalled" | "interrupted";
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

/** The only run statuses worth classifying: a finished run has no liveness. */
export type LiveRunStatus = "queued" | "running" | "interrupted";

export type StatusObservation =
	| {
			snapshot: "present";
			updatedAt: number;
			sequence: number;
			phase: StatusActivityPhase;
			activeScope?: string;
			toolName?: string;
			activeSince?: number;
			waitingSince?: number;
	  }
	| {
			snapshot: "missing" | "invalid" | "wrong-id";
			snapshotError?: string;
	  };

export interface SubagentStatusState {
	/** Authoritative run status. `interrupted` is never overwritten by inference. */
	runStatus: LiveRunStatus;
	startTimeMs: number;
	/** How long this run may be silent before it counts as stalled. */
	stallAfterMs: number;
	/** The same, for a run whose last known phase is a tool call (see above). */
	toolStallAfterMs: number;
	firstObservationAtMs: number | null;
	lastActivityAtMs: number | null;
	lastActivitySequence: number | null;
	activeNow: boolean;
	activeSinceMs: number | null;
	activeScope: string | null;
	toolName: string | null;
	waitingSinceMs: number | null;
	phase: StatusActivityPhase | null;
	snapshotState: StatusSnapshotState;
	/** When the current snapshot problem began; the first problem's clock sticks. */
	snapshotProblemSinceMs: number | null;
	snapshotError: string | null;
	currentKind: SubagentStatusKind;
}

/**
 * A classified run, at one instant.
 *
 * Only the formatted durations are exposed. The raw `*Ms` clocks stay inside
 * `SubagentStatusState`: nothing that consumes a snapshot aggregates or sorts by
 * them — the widget and `subagent_status` both render the text.
 */
export interface StatusSnapshot {
	kind: SubagentStatusKind;
	elapsedText: string;
	activeDurationText: string | null;
	activeScope: string | null;
	toolName: string | null;
	waitingDurationText: string | null;
	snapshotState: StatusSnapshotState;
	snapshotError: string | null;
	/** How long the snapshot has been unusable, as text. Null when it is fine. */
	snapshotProblemText: string | null;
	/**
	 * How long the snapshot has been silent, as text. Set only by the
	 * valid-but-stale stall, where there is no "problem" clock to read.
	 */
	quietDurationText: string | null;
	/** A short qualifier for the row, e.g. "wrong activity id" or "no activity". */
	statusLabel: string | null;
}

/**
 * Compact duration.
 *
 * Same shape as `formatDuration` in index.ts up to an hour, where that one has no
 * hours branch and would read "65m 5s". Two formatters exist because one works in
 * milliseconds of elapsed time and this one is a pure helper, so they agree by
 * hand — which is why the tests pin both.
 */
export function formatElapsedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	if (hours > 0) return `${hours}h ${minutes}m`;

	// Seconds are kept below an hour: a widget that only changes once a minute
	// looks broken even when it is correct.
	return `${minutes}m ${totalSeconds % 60}s`;
}

export function createStatusState(params: {
	runStatus: LiveRunStatus;
	startTimeMs: number;
	stallAfterMs?: number;
	toolStallAfterMs?: number;
}): SubagentStatusState {
	return {
		runStatus: params.runStatus,
		startTimeMs: params.startTimeMs,
		stallAfterMs: params.stallAfterMs ?? DEFAULT_STALL_AFTER_MS,
		toolStallAfterMs: params.toolStallAfterMs ?? DEFAULT_TOOL_STALL_AFTER_MS,
		firstObservationAtMs: null,
		lastActivityAtMs: null,
		lastActivitySequence: null,
		activeNow: false,
		activeSinceMs: null,
		activeScope: null,
		toolName: null,
		waitingSinceMs: null,
		phase: null,
		snapshotState: "unseen",
		snapshotProblemSinceMs: null,
		snapshotError: null,
		// A queued run has not started; everything else starts out active-ish and
		// is refined by the first observation.
		currentKind: params.runStatus === "interrupted" ? "interrupted" : "starting",
	};
}

/** Record a new authoritative run status without discarding observed history. */
export function withRunStatus(state: SubagentStatusState, runStatus: LiveRunStatus): SubagentStatusState {
	if (state.runStatus === runStatus) return state;
	// classifyStatus reports `runStatus` for queued and interrupted runs directly,
	// so no inference state needs rewiring here: only `currentKind` moves, which is
	// what lets the next advance tell a stall's edge from its level.
	// A run that has just left the queue starts its liveness fresh; "queued" is not
	// a kind it can ever report again, and leaving it here would be a lie the next
	// advance has to correct.
	return { ...state, runStatus, currentKind: runStatus === "running" ? "starting" : runStatus };
}

/**
 * Fold one observation into the state.
 *
 * Order comes from `sequence`, the child's own write counter: it is monotonic by
 * construction, so a replayed or out-of-order read cannot rewind the phase or
 * its since-markers. `updatedAt` is a clock, not an ordering, and is used only
 * to measure how long the current state has held.
 */
export function observeStatus(
	state: SubagentStatusState,
	observation: StatusObservation,
	now: number,
): SubagentStatusState {
	if (observation.snapshot !== "present") {
		return {
			...state,
			firstObservationAtMs: state.firstObservationAtMs ?? now,
			snapshotState: observation.snapshot,
			// The first problem's clock is what matters: a snapshot that keeps
			// failing must not look like it just started failing.
			snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
			snapshotError: observation.snapshotError ?? null,
		};
	}

	const { updatedAt, sequence } = observation;
	// Strictly greater, matching the rule the parent applies to run.activity. An
	// identical replay is REJECTED, and that is what makes it idempotent: the state
	// returned is the one already held, so a repeated read of the same file cannot
	// restart a duration.
	if (state.lastActivitySequence !== null && sequence <= state.lastActivitySequence) return state;

	const phase = observation.phase;
	const activeNow = phase === "active";
	const activeSinceMs = activeNow ? observation.activeSince ?? state.activeSinceMs ?? updatedAt : null;
	const waitingSinceMs = phase === "waiting" ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt : null;

	return {
		...state,
		firstObservationAtMs: state.firstObservationAtMs ?? now,
		lastActivityAtMs: updatedAt,
		lastActivitySequence: sequence,
		activeNow,
		activeSinceMs,
		activeScope: activeNow ? observation.activeScope ?? null : null,
		toolName: activeNow ? observation.toolName ?? null : null,
		waitingSinceMs,
		phase,
		snapshotState: "present",
		snapshotProblemSinceMs: null,
		snapshotError: null,
	};
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
	// Only a mismatched id is worth surfacing. "missing" on a run that has just
	// started is the normal case and would be noise.
	if (snapshotState === "wrong-id") return "wrong activity id";
	return null;
}

/**
 * How long a valid snapshot may stop being rewritten before it counts as a stall.
 *
 * A tool call gets the long leash (see DEFAULT_TOOL_STALL_AFTER_MS): pi emits no
 * events for a tool that is not printing anything, so `npm ci` or a deliberate
 * `sleep` is silent for minutes while working perfectly well.
 *
 * This is only about EVENTS, so it applies to the "file is fine but has stopped
 * moving" case. A file that is missing or unreadable is a different signal — the
 * child died, or never wrote — and keeps the ordinary threshold.
 */
function stallThresholdMs(state: SubagentStatusState): number {
	return state.activeNow && state.activeScope === "tool" ? state.toolStallAfterMs : state.stallAfterMs;
}

function classifyProblemState(
	state: SubagentStatusState,
	now: number,
): Pick<StatusSnapshot, "kind" | "statusLabel"> {
	const problemLabel = snapshotProblemLabel(state.snapshotState);

	if (state.lastActivityAtMs === null) {
		// Nothing has ever been observed: this is a run that may not have started.
		const elapsedMs = Math.max(0, now - (state.firstObservationAtMs ?? state.startTimeMs));
		return elapsedMs >= state.stallAfterMs ? { kind: "stalled", statusLabel: problemLabel } : { kind: "starting", statusLabel: null };
	}

	const problemMs = Math.max(0, now - (state.snapshotProblemSinceMs ?? now));
	// Deliberately NOT stallThresholdMs: the tool exemption is about events, and
	// an unreadable file is not an event.
	if (problemMs >= state.stallAfterMs) return { kind: "stalled", statusLabel: problemLabel };

	// The snapshot is broken but was healthy a moment ago: keep reporting the last
	// thing we knew rather than claiming a fresh start.
	const lastHealthyKind: SubagentStatusKind = state.activeNow
		? "active"
		: state.waitingSinceMs !== null || state.phase === "done"
			? "waiting"
			: state.currentKind === "stalled"
				? "starting"
				: state.currentKind;
	return { kind: lastHealthyKind, statusLabel: problemLabel };
}

/** Derive the displayable status. Pure: the same inputs always give the same output. */
export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
	const elapsedMs = Math.max(0, now - state.startTimeMs);
	const base = {
		elapsedText: formatElapsedDuration(elapsedMs),
		activeDurationText: state.activeSinceMs === null ? null : formatElapsedDuration(now - state.activeSinceMs),
		activeScope: state.activeScope,
		toolName: state.toolName,
		waitingDurationText: state.waitingSinceMs === null ? null : formatElapsedDuration(now - state.waitingSinceMs),
		snapshotState: state.snapshotState,
		snapshotError: state.snapshotError,
		snapshotProblemText: state.snapshotProblemSinceMs === null ? null : formatElapsedDuration(now - state.snapshotProblemSinceMs),
		quietDurationText: null,
	};

	// Authoritative: the parent marked this run interrupted, so no snapshot —
	// fresh, stale or contradictory — gets to say otherwise.
	if (state.runStatus === "interrupted") {
		return { ...base, kind: "interrupted", statusLabel: null };
	}

	// Also authoritative: a queued run has no child, so it has no snapshot by
	// definition and no silence to complain about. Calling it stalled would
	// invent a hung child for something that is merely waiting its turn.
	if (state.runStatus === "queued") {
		return { ...base, kind: "queued", statusLabel: null };
	}

	let kind: SubagentStatusKind;
	let statusLabel: string | null = null;

	if (state.snapshotState === "present") {
		// The stall case this feature exists for: the snapshot is perfectly valid
		// and says the child is working, but it stopped being written. A wedged
		// child (a provider call that never returns, a recorder that disabled
		// itself, a deadlocked tool) keeps reporting its last phase forever, so
		// silence must be measured from the last write, not from a missing file.
		const quietMs = Math.max(0, now - (state.lastActivityAtMs ?? state.firstObservationAtMs ?? state.startTimeMs));
		if (quietMs >= stallThresholdMs(state)) {
			return { ...base, kind: "stalled", statusLabel: "no activity", quietDurationText: formatElapsedDuration(quietMs) };
		}
		if (state.activeNow) {
			kind = "active";
		} else if (state.phase === "waiting") {
			kind = "waiting";
		} else if (state.phase === "done") {
			// The child settled but its parent has not seen result.json yet. That
			// gap is seconds, and calling it "waiting" is the honest reading.
			kind = "waiting";
			statusLabel = "done";
		} else {
			// phase "starting": the child reported in but has not begun work yet.
			kind = "starting";
		}
	} else {
		const classified = classifyProblemState(state, now);
		kind = classified.kind;
		statusLabel = classified.statusLabel;
	}

	return { ...base, kind, statusLabel };
}

/**
 * Advance the state by one step: classify, then fold the kind back into the state
 * so the next step can tell a stall's edge from its level.
 *
 * Nothing here wakes the parent: the kind is display-only, and notifying on every
 * stall would duplicate `notifyCompletion` and spam the main session with
 * something the user is already watching in the widget.
 */
export function advanceStatusState(
	state: SubagentStatusState,
	now: number,
): { nextState: SubagentStatusState; snapshot: StatusSnapshot } {
	const snapshot = classifyStatus(state, now);
	return { nextState: { ...state, currentKind: snapshot.kind }, snapshot };
}

/**
 * Build the observation for a run whose snapshot the parent has already read.
 *
 * `activeSince`/`waitingSince` come straight from the child's own recorder, so
 * the duration shown is measured from the phase change rather than from when
 * the parent happened to notice it.
 */
export function observationFromActivity(activity: {
	phase: StatusActivityPhase;
	updatedAt: number;
	sequence: number;
	scope?: string;
	toolName?: string;
	activeSince?: number;
	waitingSince?: number;
}): StatusObservation {
	return {
		snapshot: "present",
		updatedAt: activity.updatedAt,
		sequence: activity.sequence,
		phase: activity.phase,
		...(activity.scope === undefined ? {} : { activeScope: activity.scope }),
		...(activity.toolName === undefined ? {} : { toolName: activity.toolName }),
		...(activity.activeSince === undefined ? {} : { activeSince: activity.activeSince }),
		...(activity.waitingSince === undefined ? {} : { waitingSince: activity.waitingSince }),
	};
}