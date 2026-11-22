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
 *
 * The wrapper below is deliberately total: a missing bus, a bus whose `emit`
 * throws, or a subscriber that throws synchronously must never change the
 * operation that published. Callers therefore ignore the return value; it
 * exists for tests and diagnostics only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GateVerdict } from "./gate.ts";

/** The documented channels. The `orchestrator:` prefix keeps them out of the
 *  collision set of third-party extension event names. */
export const ORCHESTRATION_EVENTS = {
	runSettled: "orchestrator:run-settled",
	planSettled: "orchestrator:plan-settled",
	todoChanged: "orchestrator:todo-changed",
	triagePlanned: "orchestrator:triage-planned",
	gateDecided: "orchestrator:gate-decided",
} as const;

export type OrchestrationChannel = (typeof ORCHESTRATION_EVENTS)[keyof typeof ORCHESTRATION_EVENTS];

/** A subagent run reached a final state. `settled` means the child reported a
 *  final answer (completed or failed), matching the report artifact's rule. */
export interface RunSettledPayload {
	runId: string;
	status: "completed" | "failed";
	planId?: string;
	stepId?: string;
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

/** A triage plan was appended to the session. Bounded on purpose: the full
 *  plan stays in the `review-triage` entry, and a subscriber that wants it can
 *  read that entry rather than receiving a copy of it here. */
export interface TriagePlannedPayload {
	target: string;
	verdict: string;
	status: string;
	judge: string;
	files: number;
	added: number;
	removed: number;
	signals: number;
	fingerprint?: string;
}

/** The settlement gate recorded a verdict. */
export interface GateDecidedPayload {
	verdict: GateVerdict;
}

export interface OrchestrationEventMap {
	"orchestrator:run-settled": RunSettledPayload;
	"orchestrator:plan-settled": PlanSettledPayload;
	"orchestrator:todo-changed": TodoChangedPayload;
	"orchestrator:triage-planned": TriagePlannedPayload;
	"orchestrator:gate-decided": GateDecidedPayload;
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
