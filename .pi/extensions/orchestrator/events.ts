/**
 * Typed orchestration events.
 *
 * The settlement gate is the first consumer of this bus, so the bus lives with
 * it (`.pi/extensions/orchestrator/`) rather than in `subagent`: a bus in the
 * delegation extension would invert the dependency, and a shared directory that
 * is not an extension would fail the package-manifest rule that every directory
 * under `.pi/extensions/` has an entry point.
 *
 * Scope: these events are LOCAL to one pi parent session. `pi.events` is an
 * in-process emitter; publication is synchronous but subscriber handlers are
 * async-wrapped, errors are swallowed by the host, and the call does not await
 * them. There is no cross-process, cross-worktree or cross-session delivery —
 * a child Pi process has its own bus, and a linked worktree has its own session.
 * The run lifecycle channels are for one process watching its own delegations:
 * the settlement gate keeps a live-run set from them so it can park instead of
 * spending an attempt, and a reload rebuilds that set from `runs-snapshot`.
 *
 * The wrapper below is deliberately total: a missing bus, a bus whose `emit`
 * throws, or a subscriber that throws synchronously must never change the
 * operation that published. Callers therefore ignore the return value; it
 * exists for tests and diagnostics only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GateVerdict, LoopVerdict } from "./gate.ts";

/** The documented channels. The `orchestrator:` prefix keeps them out of the
 *  collision set of third-party extension event names. */
export const ORCHESTRATION_EVENTS = {
	runStarted: "orchestrator:run-started",
	runsSnapshot: "orchestrator:runs-snapshot",
	runSettled: "orchestrator:run-settled",
	planSettled: "orchestrator:plan-settled",
	todoChanged: "orchestrator:todo-changed",
	gateDecided: "orchestrator:gate-decided",
	subagentDispatch: "orchestrator:subagent-dispatch",
} as const;

export type OrchestrationChannel = (typeof ORCHESTRATION_EVENTS)[keyof typeof ORCHESTRATION_EVENTS];

/**
 * The session entry types this extension writes besides its `custom` records.
 * `compactSnapshot` is a `custom_message`, the only channel that enters the
 * model's context without replacing the system prompt; see `compact-snapshot.ts`.
 */
export const ORCHESTRATOR_CUSTOM_TYPES = {
	compactSnapshot: "orchestrator:compact-snapshot",
} as const;

/** The status of a run that is still live. `interrupted` is terminal for parking
 *  and is never published as live, so it is not part of this union. */
export type LiveRunStatus = "queued" | "running";

/** Summary of one file modified or written by a child subagent. */
export interface ChildFileEditSummary {
	path: string;
	changedLines: number;
	lastEditAt?: number;
}

/** Summary of one passing shell command executed by a child subagent. */
export interface ChildPassedCommandSummary {
	command: string;
	at: number;
}

/** Structured summary of file edits and passing commands reported by a child subagent. */
export interface ChildActivitySummary {
	editedFiles: ChildFileEditSummary[];
	passedCommands: ChildPassedCommandSummary[];
	lastEditAt?: number;
}

/** A run was admitted, before its child is necessarily alive. Published once per
 *  run id: a plan retry creates a new id and therefore publishes its own. */
export interface RunStartedPayload {
	runId: string;
	status: LiveRunStatus;
	resumeOf?: string;
	planId?: string;
	stepId?: string;
	role?: string;
	provider?: string;
	model?: string;
	startedAt?: number;
	at: number;
}

/** The live runs a reload rebuilt from disk, so a parent that starts after a
 *  restart knows what is in flight before its first settlement. `interrupted`
 *  is not live: it is terminal for parking in-process, and listing it after a
 *  reload would park a parent whose interrupt event can no longer fire. */
export interface RunsSnapshotPayload {
	runs: { runId: string; status: LiveRunStatus }[];
	at: number;
}

/** A subagent run reached a final state. `settled` means terminal, and every
 *  terminal status is reported, because a parked parent must be released by a
 *  cancellation or an interrupt as well as by a completed or failed run. */
export interface RunSettledPayload {
	runId: string;
	status: "completed" | "failed" | "cancelled" | "interrupted";
	cwd?: string;
	planId?: string;
	stepId?: string;
	role?: string;
	provider?: string;
	model?: string;
	startedAt?: number;
	activitySummary?: ChildActivitySummary;
	error?: string;
	finishedAt: number;
}

/** A dependency plan became terminal: completed, failed or cancelled. */
export interface PlanSettledPayload {
	planId: string;
	status: "completed" | "failed" | "cancelled";
	reason?: string;
	finishedAt: number;
}

/** A successful mutation of the todo store, from the tool or the `/todos` UI. */
export interface TodoChangedPayload {
	action: "create" | "update" | "append" | "delete" | "claim" | "release";
	id: string;
	title?: string;
	status?: string;
	sessionId?: string;
}

/**
 * The settlement gate acted: it recorded a settlement verdict, or the loop
 * breaker blocked (or overrode) a repeated tool call. A discriminated union, so
 * a subscriber that reacts to loops (the advisor in ticket 10) cannot mistake a
 * loop record for a verdict.
 */
export type GateDecidedPayload =
	| { action: "settle"; verdict: GateVerdict }
	| { action: "loop-block"; loop: LoopVerdict };

/** Result handed back asynchronously (or synchronously) to a `subagent-dispatch` caller. */
export interface SubagentDispatchResult {
	ok: boolean;
	runId?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	error?: string;
}

/**
 * Cross-extension request to start an isolated single-run subagent via `subagent/index.ts`.
 * `provider` and `model` should be omitted when inheriting the active parent model.
 */
export interface SubagentDispatchPayload {
	task: string;
	cwd?: string;
	role?: string;
	tools?: string[];
	provider?: string;
	model?: string;
	thinking?: string;
	handoff?: boolean | "standalone" | "lineage" | "fork";
	source?: string;
	onAccepted?: () => void;
	onDispatched?: (result: SubagentDispatchResult) => void;
}

export interface OrchestrationEventMap {
	"orchestrator:run-started": RunStartedPayload;
	"orchestrator:runs-snapshot": RunsSnapshotPayload;
	"orchestrator:run-settled": RunSettledPayload;
	"orchestrator:plan-settled": PlanSettledPayload;
	"orchestrator:todo-changed": TodoChangedPayload;
	"orchestrator:gate-decided": GateDecidedPayload;
	"orchestrator:subagent-dispatch": SubagentDispatchPayload;
}

export interface PublishResult {
	published: boolean;
	error?: string;
}

type EventHost = Pick<ExtensionAPI, "events"> | undefined;

/**
 * Publish one typed payload. Never throws and never awaits subscribers.
 *
 * A subscriber that throws cannot affect the caller: pi wraps handlers in an
 * async try/catch itself, and the synchronous throw a test bus can produce is
 * caught here. The result is diagnostic; no caller may branch on it.
 */
export function publishOrchestrationEvent<K extends OrchestrationChannel>(
	pi: EventHost,
	channel: K,
	payload: OrchestrationEventMap[K],
): PublishResult {
	try {
		const events = pi?.events;
		if (!events || typeof events.emit !== "function") {
			return { published: false, error: "the extension host has no event bus" };
		}
		// `emit` is typed void; deliberately not relying on a return value.
		events.emit(channel, payload);
		return { published: true };
	} catch (error) {
		return { published: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Subscribe with a typed payload. Returns a no-op unsubscribe when the host has
 * no bus or `on` throws, so a caller never has to guard the wiring.
 */
export function subscribeOrchestrationEvent<K extends OrchestrationChannel>(
	pi: EventHost,
	channel: K,
	handler: (payload: OrchestrationEventMap[K]) => void,
): () => void {
	try {
		const events = pi?.events;
		if (!events || typeof events.on !== "function") return () => {};
		const unsubscribe = events.on(channel, (data: unknown) => handler(data as OrchestrationEventMap[K]));
		if (typeof unsubscribe !== "function") return () => {};
		return () => {
			try {
				unsubscribe();
			} catch {
				// An unsubscribe failure must not escape a shutdown path.
			}
		};
	} catch {
		return () => {};
	}
}
