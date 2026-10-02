// Child-side liveness snapshot for the subagent extension.
//
// The child process writes a small, throttled JSON snapshot describing what it
// is doing right now. The parent reads it on every watcher tick so a run can be
// reported as starting / active / waiting / done instead of an undifferentiated
// "running". The snapshot is diagnostic state only: nothing about completion,
// cancellation or failure depends on it, and an unreadable or stale snapshot
// degrades to "no activity observed".
//
// Design notes:
//   - One writer (the child), one reader (the parent), one file per run:
//     `<runDir>/activity.json`, next to `result.json`.
//   - `runningChildId` is checked on read so a snapshot left over from an
//     earlier child in the same run dir can never be attributed to the
//     current one. `sequence` is checked the same way, so an older snapshot can
//     never overwrite a newer one the parent already saw.
//   - Writes are throttled and serialized; after repeated failures the
//     recorder disables itself rather than spamming a doomed path.
//   - The event set is deliberately small: only events that carry information
//     the parent renders are recorded, which keeps read-side validation strict
//     and honest.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";
export type SubagentActivityScope = "agent" | "provider" | "streaming" | "tool";

export type SubagentActivityEvent =
	| "session_start"
	| "input"
	| "before_provider_request"
	| "after_provider_response"
	| "message_update"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "agent_end"
	| "agent_settled"
	| "session_shutdown";

export interface SubagentActivityState {
	version: 1;
	/** Run id of the child that owns this snapshot. Verified on read. */
	runningChildId: string;
	createdAt: number;
	updatedAt: number;
	/** Monotonic counter of recorded events; the parent ignores non-increasing values. */
	sequence: number;
	latestEvent: SubagentActivityEvent;
	phase: SubagentActivityPhase;
	agentActive: boolean;
	providerActive: boolean;
	toolActive: boolean;
	activeScope?: SubagentActivityScope;
	activeSince?: number;
	waitingSince?: number;
	toolName?: string;
}

export type ActivityReadResult =
	| { ok: true; activity: SubagentActivityState }
	| { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export interface SubagentActivityRecorder {
	sessionStart(): Promise<void>;
	input(): Promise<void>;
	providerRequest(): Promise<void>;
	providerResponse(): Promise<void>;
	messageUpdate(): Promise<void>;
	toolStart(toolName?: string): Promise<void>;
	toolUpdate(toolName?: string): Promise<void>;
	toolEnd(toolName?: string): Promise<void>;
	agentEnd(): Promise<void>;
	/** Terminal event. Forces a write so the snapshot is durable before the
	 *  parent can observe `result.json`. */
	settled(): Promise<void>;
	shutdown(): Promise<void>;
	/** Wait for any in-flight write to land. */
	flush(): Promise<void>;
	/** Snapshot of the current state, for tests and diagnostics. */
	current(): SubagentActivityState;
}

export interface ActivityRecorderOptions {
	filePath: string;
	childId: string;
	now?: () => number;
	write: (filePath: string, value: unknown) => Promise<void>;
	throttleMs?: number;
	maxWriteFailures?: number;
	onError?: (error: unknown) => void;
}

const ACTIVITY_FILE = "activity.json";
const DEFAULT_THROTTLE_MS = 500;
const DEFAULT_MAX_WRITE_FAILURES = 3;
const MAX_ACTIVITY_STRING_LENGTH = 200;

const KNOWN_PHASES = new Set<SubagentActivityPhase>(["starting", "active", "waiting", "done"]);
const KNOWN_SCOPES = new Set<SubagentActivityScope>(["agent", "provider", "streaming", "tool"]);
const KNOWN_EVENTS = new Set<SubagentActivityEvent>([
	"session_start",
	"input",
	"before_provider_request",
	"after_provider_response",
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"agent_end",
	"agent_settled",
	"session_shutdown",
]);

/** Path of the activity snapshot for a run directory. */
export function getActivityFilePath(runDir: string): string {
	return path.join(runDir, ACTIVITY_FILE);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function requireObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function invalid(error: string): ActivityReadResult {
	return { ok: false, reason: "invalid", error };
}

function optionalString(object: Record<string, unknown>, field: string): string | undefined {
	return object[field] === undefined ? undefined : (object[field] as string);
}

function validateActivity(value: unknown, expectedChildId: string): ActivityReadResult {
	const object = requireObject(value);
	if (!object) return invalid("activity must be an object");
	if (object.version !== 1) return invalid("unsupported activity version");
	if (typeof object.runningChildId !== "string" || object.runningChildId.length === 0) {
		return invalid("runningChildId must be a non-empty string");
	}
	if (object.runningChildId !== expectedChildId) return { ok: false, reason: "wrong-id" };
	if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
		return invalid("unknown latestEvent");
	}
	if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
		return invalid("unknown activity phase");
	}
	if (object.activeScope !== undefined && !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope)) {
		return invalid("unknown activeScope");
	}
	if (!isFiniteNumber(object.createdAt)) return invalid("createdAt must be finite");
	if (!isFiniteNumber(object.updatedAt)) return invalid("updatedAt must be finite");
	if (object.updatedAt < object.createdAt) return invalid("updatedAt must not precede createdAt");
	if (!Number.isInteger(object.sequence)) return invalid("sequence must be an integer");
	if ((object.sequence as number) < 0) return invalid("sequence must not be negative");
	const phase = object.phase as SubagentActivityPhase;
	const agentActive = object.agentActive === true;
	const providerActive = object.providerActive === true;
	const toolActive = object.toolActive === true;
	if (phase === "active" && object.activeScope === undefined) return invalid("an active snapshot must name a scope");
	if (phase === "active" && object.activeSince === undefined) return invalid("an active snapshot must record when it started");
	if (phase !== "active" && object.activeSince !== undefined) return invalid("only an active snapshot may carry activeSince");
	if (phase !== "waiting" && object.waitingSince !== undefined) return invalid("only a waiting snapshot may carry waitingSince");
	if (phase === "done" && (agentActive || providerActive || toolActive)) return invalid("a done snapshot cannot have active work");
	if (phase === "done" && object.toolName !== undefined) return invalid("a done snapshot cannot name a tool");
	for (const field of ["agentActive", "providerActive", "toolActive"]) {
		if (typeof object[field] !== "boolean") return invalid(`${field} must be a boolean`);
	}
	for (const field of ["activeSince", "waitingSince"]) {
		if (object[field] !== undefined && !isFiniteNumber(object[field])) return invalid(`${field} must be finite when present`);
	}
	for (const field of ["toolName"]) {
		const raw = optionalString(object, field);
		if (raw === undefined) continue;
		if (typeof raw !== "string" || /[\r\n]/.test(raw) || raw.length > MAX_ACTIVITY_STRING_LENGTH) {
			return invalid(`${field} must be a single-line string of at most ${MAX_ACTIVITY_STRING_LENGTH} characters`);
		}
	}

	return { ok: true, activity: object as unknown as SubagentActivityState };
}

/** Validate an already-parsed snapshot value. */
export function validateActivityState(value: unknown, expectedChildId: string): ActivityReadResult {
	return validateActivity(value, expectedChildId);
}

/**
 * Read and validate the snapshot for `childId`. Never throws: an absent,
 * unreadable, malformed or mismatched file is reported, not raised, because a
 * missing snapshot must never break the watcher.
 */
export async function readActivityFile(filePath: string, childId: string): Promise<ActivityReadResult> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { ok: false, reason: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return invalid(`activity is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateActivity(parsed, childId);
}

/**
 * Create the recorder used inside a subagent child.
 *
 * Every method resolves after the (possibly throttled) write it scheduled, so
 * callers that need durability — `settled()` — can simply await it. Writes are
 * serialized through a promise chain so a slow write can never interleave with
 * a later one.
 */
export function createActivityRecorder(options: ActivityRecorderOptions): SubagentActivityRecorder {
	const now = options.now ?? Date.now;
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	const maxWriteFailures = options.maxWriteFailures ?? DEFAULT_MAX_WRITE_FAILURES;
	const onError = options.onError;

	const started = now();
	const state: SubagentActivityState = {
		version: 1,
		runningChildId: options.childId,
		createdAt: started,
		updatedAt: started,
		sequence: 0,
		latestEvent: "session_start",
		phase: "starting",
		agentActive: false,
		providerActive: false,
		toolActive: false,
	};

	let lastWriteAt = 0;
	let failures = 0;
	let disabled = false;
	let chain: Promise<void> = Promise.resolve();

	const current = (): SubagentActivityState => ({ ...state });

	const persist = (force: boolean): Promise<void> => {
		if (disabled) return chain;
		const timestamp = now();
		if (!force && timestamp - lastWriteAt < throttleMs) return chain;
		lastWriteAt = timestamp;
		state.updatedAt = timestamp;
		const snapshot = current();
		chain = chain
			.then(() => options.write(options.filePath, snapshot))
			.then(
				() => {
					failures = 0;
				},
				(error: unknown) => {
					failures += 1;
					onError?.(error);
					if (failures >= maxWriteFailures) disabled = true;
				},
			);
		return chain;
	};

	const record = (event: SubagentActivityEvent, mutate: () => void, force = false): Promise<void> => {
		if (disabled) return chain;
		const previousPhase = state.phase;
		state.sequence += 1;
		state.latestEvent = event;
		mutate();
		// A phase transition is the one update the parent must never miss, so it
		// bypasses the throttle; otherwise a run that starts working could look
		// idle to the watcher for a whole throttle window. Chatty updates within
		// a phase (streaming, tool progress) stay throttled.
		return persist(force || state.phase !== previousPhase);
	};

	// markActive is the single place that enters the active phase, so it owns
	// every field that phase implies. agentActive means "the child is inside an
	// agent turn", not "the user typed something at some point".
	const markActive = (scope: SubagentActivityScope, toolName?: string): void => {
		state.phase = "active";
		state.agentActive = true;
		state.waitingSince = undefined;
		if (state.activeSince === undefined) state.activeSince = now();
		state.activeScope = scope;
		if (toolName !== undefined) state.toolName = toolName;
	};

	const markWaiting = (): void => {
		state.phase = "waiting";
		state.agentActive = false;
		state.providerActive = false;
		state.toolActive = false;
		state.activeScope = undefined;
		state.activeSince = undefined;
		state.waitingSince = now();
	};

	const markDone = (): void => {
		state.phase = "done";
		state.agentActive = false;
		state.providerActive = false;
		state.toolActive = false;
		state.activeScope = undefined;
		state.activeSince = undefined;
		// Clear the trailing detail too: a finished run must not report the tool
		// it happened to be running, or when it sat waiting.
		state.waitingSince = undefined;
		state.toolName = undefined;
	};

	return {
		sessionStart: () => record("session_start", () => {}),
		input: () =>
			record("input", () => {
				markActive("agent");
			}),
		providerRequest: () =>
			record("before_provider_request", () => {
				state.providerActive = true;
				markActive("provider");
			}),
		providerResponse: () =>
			record("after_provider_response", () => {
				state.providerActive = false;
				if (!state.toolActive) markActive("agent");
			}),
		messageUpdate: () =>
			record("message_update", () => {
				if (!state.toolActive) markActive("streaming");
			}),
		toolStart: (toolName) =>
			record("tool_execution_start", () => {
				state.toolActive = true;
				markActive("tool", toolName);
			}),
		toolUpdate: (toolName) =>
			record("tool_execution_update", () => {
				state.toolActive = true;
				markActive("tool", toolName);
			}),
		toolEnd: (toolName) =>
			record("tool_execution_end", () => {
				state.toolActive = false;
				if (toolName !== undefined) state.toolName = toolName;
				markActive("agent");
			}),
		agentEnd: () =>
			record("agent_end", () => {
				markWaiting();
			}),
		settled: () =>
			record(
				"agent_settled",
				() => {
					markDone();
				},
				true,
			),
		shutdown: () =>
			record("session_shutdown", () => {
				markDone();
			}),
		flush: () => chain,
		current,
	};
}