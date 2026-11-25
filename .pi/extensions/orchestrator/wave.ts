/**
 * Pure wave-orchestration state machine.
 *
 * Zero I/O, zero globals, injectable `now`. Every transition produces a new
 * immutable `WaveState`, any disk `WaveSideEffect`s the runtime should apply, and
 * a serializable `WaveJournalEntry` that `reconstructWaveState` can replay
 * deterministically from the session branch.
 */

import { resolvePin } from "./wave-ladder.mjs";
import { blockingIssues, resolveTier } from "./wave-tickets.mjs";

export const WAVE_ENTRY_TYPE = "orchestrator-wave";
export const WAVE_VERSION = 1;

export type WaveTicketPhase =
	| "pending"
	| "triaged"
	| "implementing"
	| "reviewing"
	| "verifying"
	| "ready_to_commit"
	| "done"
	| "blocked";

export type WaveTierSource = "tier-override" | "triage" | "default" | "escalation";

export interface WaveHistoryEntry {
	at: number;
	action: string;
	from?: WaveTicketPhase;
	to: WaveTicketPhase;
	tier?: number;
	outcome?: string;
	verdict?: string;
	detail?: string;
}

export interface WaveTicketState {
	id: string;
	file: string;
	title: string;
	phase: WaveTicketPhase;
	blockedBy?: string[];
	tier?: number;
	tierSource?: WaveTierSource;
	tierReason?: string;
	crashesAtTier: number;
	reviewerVerdict?: string;
	verifierVerdict?: string;
	verifierEvidence?: string;
	commitSha?: string;
	blockedReason?: string;
	activeRunId?: string;
	history: WaveHistoryEntry[];
}

export interface WaveState {
	folder: string;
	status: "active" | "completed" | "aborted";
	startedAt: number;
	updatedAt: number;
	ladderSource: string;
	startHeadSha?: string;
	sessionModelWarned?: boolean;
	tickets: Record<string, WaveTicketState>;
	eventCount: number;
}

export type WaveSideEffect = {
	kind: "set-ticket-status";
	file: string;
	status: "in-progress" | "done" | "blocked";
	reason?: string;
};

export interface WaveModelSpec {
	provider: string;
	model: string;
	thinking?: string;
}

export interface WaveLadderTier {
	tier: number;
	provider: string;
	model: string;
	thinking: string;
}

export interface WaveLadder {
	version?: number;
	roster?: readonly string[];
	tiers: readonly WaveLadderTier[];
	pins?: Record<string, unknown>;
	gates?: { reviewer?: { throughTier?: number } };
}

export interface WaveTicketNode {
	id: string;
	file: string;
	title?: string;
	status: string;
	blockedBy: readonly string[];
	tierOverride?: number;
}

export interface WaveTicketIssue {
	code: string;
	severity: string;
	message: string;
	[key: string]: unknown;
}

export interface WaveTicketGraph {
	dir?: string | null;
	tickets: readonly WaveTicketNode[];
	byId?: ReadonlyMap<string, WaveTicketNode>;
	issues: readonly WaveTicketIssue[];
}

export type WaveAction =
	| {
			type: "start";
			folder: string;
			ladderSource?: string;
			startHeadSha?: string;
			sessionModelWarned?: boolean;
	  }
	| {
			type: "triage";
			ticketId: string;
			tier?: number;
			reason?: string;
			classification?: { tier?: number; justification?: string } | null;
	  }
	| { type: "start_implement"; ticketId: string; runId?: string }
	| {
			type: "implement_result";
			ticketId: string;
			outcome: "completed" | "crashed";
			summary?: string;
			error?: string;
			runId?: string;
	  }
	| { type: "record_review"; ticketId: string; verdict: "pass" | "escalate"; reason?: string; summary?: string }
	| {
			type: "record_verify";
			ticketId: string;
			verdict: "pass" | "fail";
			evidence?: string;
			reason?: string;
			summary?: string;
	  }
	| { type: "record_commit"; ticketId: string; commitSha: string }
	| { type: "abort"; reason?: string };

export interface WaveActionContext {
	graph?: WaveTicketGraph | null;
	ladderSource?: string;
	startHeadSha?: string;
	sessionModelWarned?: boolean;
}

export type WaveJournalEntry =
	| {
			version: typeof WAVE_VERSION;
			type: "start";
			at: number;
			folder: string;
			ladderSource: string;
			startHeadSha?: string;
			sessionModelWarned?: boolean;
			status: "active" | "completed";
			tickets: Array<{
				id: string;
				file: string;
				title: string;
				phase: WaveTicketPhase;
				blockedBy?: string[];
			}>;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "triage";
			at: number;
			ticketId: string;
			tier: number;
			tierSource: WaveTierSource;
			tierReason?: string;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "start_implement";
			at: number;
			ticketId: string;
			tier?: number;
			tierSource?: WaveTierSource;
			tierReason?: string;
			runId?: string;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "implement_result";
			at: number;
			ticketId: string;
			outcome: "completed" | "crashed";
			nextPhase: WaveTicketPhase;
			tier?: number;
			tierSource?: WaveTierSource;
			tierReason?: string;
			crashesAtTier: number;
			blockedReason?: string;
			detail?: string;
			waveCompleted?: boolean;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "record_review";
			at: number;
			ticketId: string;
			verdict: "pass" | "escalate";
			nextPhase: WaveTicketPhase;
			tier?: number;
			tierSource?: WaveTierSource;
			tierReason?: string;
			crashesAtTier: number;
			blockedReason?: string;
			detail?: string;
			waveCompleted?: boolean;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "record_verify";
			at: number;
			ticketId: string;
			verdict: "pass" | "fail";
			evidence?: string;
			nextPhase: WaveTicketPhase;
			tier?: number;
			tierSource?: WaveTierSource;
			tierReason?: string;
			crashesAtTier: number;
			blockedReason?: string;
			detail?: string;
			waveCompleted?: boolean;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "record_commit";
			at: number;
			ticketId: string;
			commitSha: string;
			waveCompleted: boolean;
	  }
	| {
			version: typeof WAVE_VERSION;
			type: "abort";
			at: number;
			reason?: string;
	  };

export interface WaveActionResult {
	ok: boolean;
	error?: string;
	state: WaveState | null;
	sideEffects: WaveSideEffect[];
	entry?: WaveJournalEntry;
	dispatch?: WaveModelSpec;
	nextPin?: WaveModelSpec;
	warnings?: string[];
}

export interface WaveDispatchReadyItem {
	id: string;
	file: string;
	title: string;
	phase: WaveTicketPhase;
	tier?: number;
	tierSource?: WaveTierSource;
	action: "triage" | "start_implement";
	dispatch?: WaveModelSpec;
}

export interface WaveDispatchWaitingItem {
	id: string;
	file: string;
	title: string;
	phase: WaveTicketPhase;
	reasons: string[];
}

export interface WaveNextAction {
	ticketId: string;
	action: string;
	detail: string;
}

export interface WaveDispatchPlan {
	blockingErrors: WaveTicketIssue[];
	warnings: WaveTicketIssue[];
	ready: WaveDispatchReadyItem[];
	waiting: WaveDispatchWaitingItem[];
	summary: string;
	nextActions: WaveNextAction[];
}

export interface WaveGateReport {
	unfinishedIds: string[];
	summary: string;
	evidence: string;
}

const VALID_PHASES: ReadonlySet<WaveTicketPhase> = new Set([
	"pending",
	"triaged",
	"implementing",
	"reviewing",
	"verifying",
	"ready_to_commit",
	"done",
	"blocked",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareTicketIds(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

function cloneState(state: WaveState): WaveState {
	const tickets: Record<string, WaveTicketState> = {};
	for (const [id, ticket] of Object.entries(state.tickets)) {
		tickets[id] = {
			...ticket,
			...(ticket.blockedBy ? { blockedBy: [...ticket.blockedBy] } : {}),
			history: ticket.history.map((h) => ({ ...h })),
		};
	}
	return { ...state, tickets };
}

function findDiskTicket(graph: WaveTicketGraph | null | undefined, id: string): WaveTicketNode | undefined {
	if (!graph) return undefined;
	if (graph.byId) return graph.byId.get(id);
	return graph.tickets.find((t) => t.id === id);
}

function allTicketsSettled(tickets: Record<string, WaveTicketState>): boolean {
	const values = Object.values(tickets);
	return values.length > 0 && values.every((t) => t.phase === "done" || t.phase === "blocked");
}

function lookupTierDispatch(ladder: WaveLadder, tier: number): WaveModelSpec | null {
	const entry = ladder.tiers.find((t) => t.tier === tier);
	if (!entry) return null;
	return { provider: entry.provider, model: entry.model, thinking: entry.thinking };
}

function resolvePinSpec(ladder: WaveLadder, role: string): WaveModelSpec | undefined {
	const resolved = resolvePin(ladder as never, role) as WaveModelSpec | null;
	return resolved ?? undefined;
}

function fail(state: WaveState | null, error: string): WaveActionResult {
	return { ok: false, error, state, sideEffects: [] };
}

function applyJournalEvent(state: WaveState | null, raw: unknown): WaveState | null {
	if (!isRecord(raw) || typeof raw.type !== "string") return state;
	const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : 0;

	if (raw.type === "start") {
		if (typeof raw.folder !== "string" || !raw.folder.trim() || !Array.isArray(raw.tickets)) return state;
		const tickets: Record<string, WaveTicketState> = {};
		for (const item of raw.tickets) {
			if (!isRecord(item) || typeof item.id !== "string" || typeof item.file !== "string") return state;
			const phase = item.phase as WaveTicketPhase;
			if (!VALID_PHASES.has(phase)) return state;
			const blockedBy = Array.isArray(item.blockedBy)
				? item.blockedBy.filter((b): b is string => typeof b === "string")
				: undefined;
			tickets[item.id] = {
				id: item.id,
				file: item.file,
				title: typeof item.title === "string" && item.title ? item.title : item.id,
				phase,
				...(blockedBy ? { blockedBy } : {}),
				crashesAtTier: 0,
				history: [],
			};
		}
		const status = raw.status === "completed" ? "completed" : "active";
		const startHeadSha =
			typeof raw.startHeadSha === "string" && raw.startHeadSha.trim() ? raw.startHeadSha.trim() : undefined;
		return {
			folder: raw.folder,
			status,
			startedAt: at,
			updatedAt: at,
			ladderSource: typeof raw.ladderSource === "string" ? raw.ladderSource : "file",
			...(startHeadSha ? { startHeadSha } : {}),
			...(typeof raw.sessionModelWarned === "boolean" ? { sessionModelWarned: raw.sessionModelWarned } : {}),
			tickets,
			eventCount: 1,
		};
	}

	if (!state) return state;

	if (raw.type === "abort") {
		const next = cloneState(state);
		next.status = "aborted";
		next.updatedAt = at;
		next.eventCount += 1;
		return next;
	}

	const ticketId = typeof raw.ticketId === "string" ? raw.ticketId : "";
	const existing = state.tickets[ticketId];
	if (!existing) return state;

	const next = cloneState(state);
	const ticket = next.tickets[ticketId]!;
	const from = ticket.phase;

	switch (raw.type) {
		case "triage": {
			if (typeof raw.tier !== "number" || !Number.isInteger(raw.tier) || raw.tier < 1) return state;
			const tierSource =
				raw.tierSource === "tier-override" ||
				raw.tierSource === "triage" ||
				raw.tierSource === "default" ||
				raw.tierSource === "escalation"
					? raw.tierSource
					: "triage";
			ticket.phase = "triaged";
			ticket.tier = raw.tier;
			ticket.tierSource = tierSource;
			if (typeof raw.tierReason === "string") ticket.tierReason = raw.tierReason;
			else delete ticket.tierReason;
			ticket.history.push({
				at,
				action: "triage",
				from,
				to: "triaged",
				tier: raw.tier,
				...(ticket.tierReason ? { detail: ticket.tierReason } : {}),
			});
			break;
		}
		case "start_implement": {
			ticket.phase = "implementing";
			if (typeof raw.tier === "number" && Number.isInteger(raw.tier) && raw.tier >= 1) {
				ticket.tier = raw.tier;
			}
			if (
				raw.tierSource === "tier-override" ||
				raw.tierSource === "triage" ||
				raw.tierSource === "default" ||
				raw.tierSource === "escalation"
			) {
				ticket.tierSource = raw.tierSource;
			}
			if (typeof raw.tierReason === "string") ticket.tierReason = raw.tierReason;
			if (typeof raw.runId === "string" && raw.runId.length > 0) ticket.activeRunId = raw.runId;
			else delete ticket.activeRunId;
			ticket.history.push({
				at,
				action: "start_implement",
				from,
				to: "implementing",
				...(ticket.tier !== undefined ? { tier: ticket.tier } : {}),
				...(ticket.activeRunId ? { detail: ticket.activeRunId } : {}),
			});
			break;
		}
		case "implement_result": {
			const nextPhase = raw.nextPhase as WaveTicketPhase;
			if (!VALID_PHASES.has(nextPhase)) return state;
			if (raw.outcome !== "completed" && raw.outcome !== "crashed") return state;
			delete ticket.activeRunId;
			ticket.phase = nextPhase;
			if (typeof raw.tier === "number" && Number.isInteger(raw.tier) && raw.tier >= 1) {
				ticket.tier = raw.tier;
			}
			if (
				raw.tierSource === "tier-override" ||
				raw.tierSource === "triage" ||
				raw.tierSource === "default" ||
				raw.tierSource === "escalation"
			) {
				ticket.tierSource = raw.tierSource;
			}
			if (typeof raw.tierReason === "string") ticket.tierReason = raw.tierReason;
			if (typeof raw.crashesAtTier === "number" && Number.isInteger(raw.crashesAtTier) && raw.crashesAtTier >= 0) {
				ticket.crashesAtTier = raw.crashesAtTier;
			}
			if (typeof raw.blockedReason === "string") ticket.blockedReason = raw.blockedReason;
			if (raw.waveCompleted === true) next.status = "completed";
			ticket.history.push({
				at,
				action: "implement_result",
				from,
				to: nextPhase,
				...(ticket.tier !== undefined ? { tier: ticket.tier } : {}),
				outcome: raw.outcome,
				...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
			});
			break;
		}
		case "record_review": {
			const nextPhase = raw.nextPhase as WaveTicketPhase;
			if (!VALID_PHASES.has(nextPhase)) return state;
			if (raw.verdict !== "pass" && raw.verdict !== "escalate") return state;
			ticket.reviewerVerdict = raw.verdict;
			ticket.phase = nextPhase;
			if (typeof raw.tier === "number" && Number.isInteger(raw.tier) && raw.tier >= 1) {
				ticket.tier = raw.tier;
			}
			if (
				raw.tierSource === "tier-override" ||
				raw.tierSource === "triage" ||
				raw.tierSource === "default" ||
				raw.tierSource === "escalation"
			) {
				ticket.tierSource = raw.tierSource;
			}
			if (typeof raw.tierReason === "string") ticket.tierReason = raw.tierReason;
			if (typeof raw.crashesAtTier === "number" && Number.isInteger(raw.crashesAtTier) && raw.crashesAtTier >= 0) {
				ticket.crashesAtTier = raw.crashesAtTier;
			}
			if (typeof raw.blockedReason === "string") ticket.blockedReason = raw.blockedReason;
			if (raw.waveCompleted === true) next.status = "completed";
			ticket.history.push({
				at,
				action: "record_review",
				from,
				to: nextPhase,
				...(ticket.tier !== undefined ? { tier: ticket.tier } : {}),
				verdict: raw.verdict,
				...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
			});
			break;
		}
		case "record_verify": {
			const nextPhase = raw.nextPhase as WaveTicketPhase;
			if (!VALID_PHASES.has(nextPhase)) return state;
			if (raw.verdict !== "pass" && raw.verdict !== "fail") return state;
			ticket.verifierVerdict = raw.verdict;
			if (typeof raw.evidence === "string") ticket.verifierEvidence = raw.evidence;
			ticket.phase = nextPhase;
			if (typeof raw.tier === "number" && Number.isInteger(raw.tier) && raw.tier >= 1) {
				ticket.tier = raw.tier;
			}
			if (
				raw.tierSource === "tier-override" ||
				raw.tierSource === "triage" ||
				raw.tierSource === "default" ||
				raw.tierSource === "escalation"
			) {
				ticket.tierSource = raw.tierSource;
			}
			if (typeof raw.tierReason === "string") ticket.tierReason = raw.tierReason;
			if (typeof raw.crashesAtTier === "number" && Number.isInteger(raw.crashesAtTier) && raw.crashesAtTier >= 0) {
				ticket.crashesAtTier = raw.crashesAtTier;
			}
			if (typeof raw.blockedReason === "string") ticket.blockedReason = raw.blockedReason;
			if (raw.waveCompleted === true) next.status = "completed";
			ticket.history.push({
				at,
				action: "record_verify",
				from,
				to: nextPhase,
				...(ticket.tier !== undefined ? { tier: ticket.tier } : {}),
				verdict: raw.verdict,
				...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
			});
			break;
		}
		case "record_commit": {
			if (typeof raw.commitSha !== "string" || !raw.commitSha.trim()) return state;
			ticket.phase = "done";
			ticket.commitSha = raw.commitSha.trim();
			if (raw.waveCompleted === true) next.status = "completed";
			ticket.history.push({
				at,
				action: "record_commit",
				from,
				to: "done",
				...(ticket.tier !== undefined ? { tier: ticket.tier } : {}),
				detail: ticket.commitSha,
			});
			break;
		}
		default:
			return state;
	}

	if (next.status === "active" && allTicketsSettled(next.tickets)) {
		next.status = "completed";
	}
	next.updatedAt = at;
	next.eventCount += 1;
	return next;
}

/**
 * Reconstruct the latest `WaveState` by replaying `orchestrator-wave` custom
 * entries from the active session branch. Malformed entries are skipped safely.
 */
export function reconstructWaveState(entries: readonly unknown[]): WaveState | null {
	let state: WaveState | null = null;
	for (const item of entries) {
		if (!isRecord(item) || item.type !== "custom" || item.customType !== WAVE_ENTRY_TYPE) continue;
		state = applyJournalEvent(state, item.data);
	}
	return state;
}

/**
 * Apply one transition to the wave state machine. Pure: returns `{ ok, state,
 * sideEffects, entry, ... }` without touching disk or clocks.
 */
export function applyWaveAction(
	state: WaveState | null,
	action: WaveAction,
	context: WaveActionContext = {},
	ladder: WaveLadder,
	now = 0,
): WaveActionResult {
	const ts = typeof now === "number" && Number.isFinite(now) ? now : 0;
	const maxTier = Math.max(1, ladder?.tiers?.length ?? 0);

	if (action.type === "start") {
		if (state && state.status === "active") {
			return fail(
				state,
				`An active wave already exists for "${state.folder}"; abort or complete it before starting another`,
			);
		}
		const graph = context.graph;
		if (!graph) {
			return fail(state, "A ticket graph is required to start a wave");
		}
		const blockers = blockingIssues(graph as never) as WaveTicketIssue[];
		if (blockers.length > 0) {
			return fail(
				state,
				`Cannot start wave: ticket graph has ${blockers.length} blocking issue(s): ${blockers.map((b) => b.message).join("; ")}`,
			);
		}
		if (graph.tickets.length === 0) {
			return fail(state, `Cannot start wave: no tickets found in "${action.folder}"`);
		}

		const initialTickets = graph.tickets.map((t) => {
			const phase: WaveTicketPhase =
				t.status === "done" ? "done" : t.status === "blocked" ? "blocked" : "pending";
			return {
				id: t.id,
				file: t.file,
				title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : t.id,
				phase,
				blockedBy: [...t.blockedBy],
			};
		});
		const status: "active" | "completed" = initialTickets.every(
			(t) => t.phase === "done" || t.phase === "blocked",
		)
			? "completed"
			: "active";
		const ladderSource = action.ladderSource ?? context.ladderSource ?? "file";
		const startHeadShaRaw = action.startHeadSha ?? context.startHeadSha;
		const startHeadSha =
			typeof startHeadShaRaw === "string" && startHeadShaRaw.trim() ? startHeadShaRaw.trim() : undefined;
		const sessionModelWarned = action.sessionModelWarned ?? context.sessionModelWarned;

		const entry: WaveJournalEntry = {
			version: WAVE_VERSION,
			type: "start",
			at: ts,
			folder: action.folder,
			ladderSource,
			...(startHeadSha ? { startHeadSha } : {}),
			...(typeof sessionModelWarned === "boolean" ? { sessionModelWarned } : {}),
			status,
			tickets: initialTickets,
		};
		const nextState = applyJournalEvent(null, entry);
		return { ok: true, state: nextState, sideEffects: [], entry };
	}

	if (!state || state.status !== "active") {
		return fail(state, `Action "${action.type}" requires an active wave`);
	}

	if (action.type === "abort") {
		const entry: WaveJournalEntry = {
			version: WAVE_VERSION,
			type: "abort",
			at: ts,
			...(action.reason ? { reason: action.reason } : {}),
		};
		const nextState = applyJournalEvent(state, entry);
		return { ok: true, state: nextState, sideEffects: [], entry };
	}

	const ticket = state.tickets[action.ticketId];
	if (!ticket) {
		return fail(state, `Unknown ticket "${action.ticketId}" in wave "${state.folder}"`);
	}
	const diskTicket = findDiskTicket(context.graph, action.ticketId);

	switch (action.type) {
		case "triage": {
			if (ticket.phase === "done" || ticket.phase === "blocked") {
				return fail(state, `Ticket "${action.ticketId}" is already ${ticket.phase} and cannot be triaged`);
			}
			if (ticket.phase !== "pending" && ticket.phase !== "triaged") {
				return fail(
					state,
					`Ticket "${action.ticketId}" is in phase "${ticket.phase}" and cannot be triaged`,
				);
			}
			if (
				ticket.tierSource === "escalation" ||
				ticket.crashesAtTier > 0 ||
				ticket.history.some((h) => h.action === "start_implement")
			) {
				return fail(
					state,
					`Ticket "${action.ticketId}" has already been attempted or escalated and cannot be re-triaged`,
				);
			}
			const classification =
				action.classification !== undefined
					? action.classification
					: action.tier !== undefined
						? { tier: action.tier, justification: action.reason }
						: null;
			const resolutionTarget = diskTicket ?? { id: ticket.id };
			const resolved = resolveTier(resolutionTarget as never, classification as never, { maxTier });
			const tierReason =
				action.reason ??
				classification?.justification ??
				(resolved.source === "tier-override" ? "tier-override from ticket frontmatter" : undefined);
			const warnings = resolved.issues.map((i: { message: string }) => i.message);
			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "triage",
				at: ts,
				ticketId: ticket.id,
				tier: resolved.tier,
				tierSource: resolved.source as WaveTierSource,
				...(tierReason ? { tierReason } : {}),
			};
			const nextState = applyJournalEvent(state, entry);
			return {
				ok: true,
				state: nextState,
				sideEffects: [],
				entry,
				...(warnings.length > 0 ? { warnings } : {}),
			};
		}

		case "start_implement": {
			let resolvedTier = ticket.tier;
			let resolvedSource = ticket.tierSource;
			let resolvedReason = ticket.tierReason;

			if (ticket.phase === "triaged") {
				if (resolvedTier === undefined) {
					resolvedTier = 1;
					resolvedSource = "default";
				}
			} else if (ticket.phase === "pending") {
				const override = diskTicket?.tierOverride;
				if (
					typeof override !== "number" ||
					!Number.isInteger(override) ||
					override < 1 ||
					override > maxTier
				) {
					return fail(
						state,
						`Ticket "${ticket.id}" is still pending and must be triaged before implementing (no valid tier-override on disk)`,
					);
				}
				const resolved = resolveTier(diskTicket as never, null, { maxTier });
				resolvedTier = resolved.tier;
				resolvedSource = resolved.source as WaveTierSource;
				resolvedReason = "tier-override from ticket frontmatter";
			} else {
				return fail(
					state,
					`Ticket "${ticket.id}" is in phase "${ticket.phase}" and cannot start implementing`,
				);
			}

			const blockers = ticket.blockedBy ?? diskTicket?.blockedBy ?? [];
			const unmet = blockers.filter((blockerId) => state.tickets[blockerId]?.phase !== "done");
			if (unmet.length > 0) {
				return fail(
					state,
					`Ticket "${ticket.id}" cannot start implementing while blocked by: ${unmet.join(", ")}`,
				);
			}

			const dispatch = lookupTierDispatch(ladder, resolvedTier!);
			if (!dispatch) {
				return fail(state, `Ladder does not define tier ${resolvedTier} for ticket "${ticket.id}"`);
			}

			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "start_implement",
				at: ts,
				ticketId: ticket.id,
				tier: resolvedTier,
				...(resolvedSource ? { tierSource: resolvedSource } : {}),
				...(resolvedReason ? { tierReason: resolvedReason } : {}),
				...(action.runId ? { runId: action.runId } : {}),
			};
			const nextState = applyJournalEvent(state, entry);
			return {
				ok: true,
				state: nextState,
				sideEffects: [{ kind: "set-ticket-status", file: ticket.file, status: "in-progress" }],
				entry,
				dispatch,
			};
		}

		case "implement_result": {
			if (ticket.phase !== "implementing") {
				return fail(
					state,
					`Ticket "${ticket.id}" is in phase "${ticket.phase}", expected "implementing"`,
				);
			}
			const currentTier = ticket.tier ?? 1;
			const throughTier = ladder.gates?.reviewer?.throughTier ?? 1;

			if (action.outcome === "completed") {
				const needsReview = currentTier <= throughTier;
				const nextPhase: WaveTicketPhase = needsReview ? "reviewing" : "verifying";
				const nextPin = resolvePinSpec(ladder, needsReview ? "reviewer" : "verifier");
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "implement_result",
					at: ts,
					ticketId: ticket.id,
					outcome: "completed",
					nextPhase,
					crashesAtTier: ticket.crashesAtTier,
					...(action.summary ? { detail: action.summary } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return {
					ok: true,
					state: nextState,
					sideEffects: [],
					entry,
					...(nextPin ? { nextPin } : {}),
				};
			}

			// outcome === "crashed"
			if (ticket.crashesAtTier === 0) {
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "implement_result",
					at: ts,
					ticketId: ticket.id,
					outcome: "crashed",
					nextPhase: "triaged",
					tier: currentTier,
					crashesAtTier: 1,
					...(action.error ? { detail: action.error } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return { ok: true, state: nextState, sideEffects: [], entry };
			}

			// crashesAtTier >= 1 -> escalate to tier + 1 or block if at top tier
			if (currentTier + 1 > maxTier) {
				const blockedReason = `Exhausted tier ${currentTier} (max tier ${maxTier}) after repeated crashes${action.error ? `: ${action.error}` : ""}`;
				const provisional: Record<string, WaveTicketState> = {
					...state.tickets,
					[ticket.id]: { ...ticket, phase: "blocked" },
				};
				const waveCompleted = allTicketsSettled(provisional);
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "implement_result",
					at: ts,
					ticketId: ticket.id,
					outcome: "crashed",
					nextPhase: "blocked",
					crashesAtTier: ticket.crashesAtTier,
					blockedReason,
					...(action.error ? { detail: action.error } : {}),
					...(waveCompleted ? { waveCompleted: true } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return {
					ok: true,
					state: nextState,
					sideEffects: [
						{ kind: "set-ticket-status", file: ticket.file, status: "blocked", reason: blockedReason },
					],
					entry,
				};
			}

			const nextTier = currentTier + 1;
			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "implement_result",
				at: ts,
				ticketId: ticket.id,
				outcome: "crashed",
				nextPhase: "triaged",
				tier: nextTier,
				tierSource: "escalation",
				tierReason: `escalated after repeated crash at tier ${currentTier}`,
				crashesAtTier: 0,
				...(action.error ? { detail: action.error } : {}),
			};
			const nextState = applyJournalEvent(state, entry);
			return { ok: true, state: nextState, sideEffects: [], entry };
		}

		case "record_review": {
			if (ticket.phase !== "reviewing") {
				return fail(
					state,
					`Ticket "${ticket.id}" is in phase "${ticket.phase}", expected "reviewing"`,
				);
			}
			const currentTier = ticket.tier ?? 1;

			if (action.verdict === "pass") {
				const nextPin = resolvePinSpec(ladder, "verifier");
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "record_review",
					at: ts,
					ticketId: ticket.id,
					verdict: "pass",
					nextPhase: "verifying",
					crashesAtTier: ticket.crashesAtTier,
					...(action.summary ? { detail: action.summary } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return {
					ok: true,
					state: nextState,
					sideEffects: [],
					entry,
					...(nextPin ? { nextPin } : {}),
				};
			}

			// verdict === "escalate"
			if (currentTier + 1 > maxTier) {
				const blockedReason =
					action.reason?.trim() || `Reviewer escalated from top tier ${currentTier} (max tier ${maxTier})`;
				const provisional: Record<string, WaveTicketState> = {
					...state.tickets,
					[ticket.id]: { ...ticket, phase: "blocked" },
				};
				const waveCompleted = allTicketsSettled(provisional);
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "record_review",
					at: ts,
					ticketId: ticket.id,
					verdict: "escalate",
					nextPhase: "blocked",
					crashesAtTier: ticket.crashesAtTier,
					blockedReason,
					...(action.summary ?? action.reason ? { detail: action.summary ?? action.reason } : {}),
					...(waveCompleted ? { waveCompleted: true } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return {
					ok: true,
					state: nextState,
					sideEffects: [
						{ kind: "set-ticket-status", file: ticket.file, status: "blocked", reason: blockedReason },
					],
					entry,
				};
			}

			const nextTier = currentTier + 1;
			const tierReason = action.reason?.trim() || `escalated by reviewer from tier ${currentTier}`;
			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "record_review",
				at: ts,
				ticketId: ticket.id,
				verdict: "escalate",
				nextPhase: "triaged",
				tier: nextTier,
				tierSource: "escalation",
				tierReason,
				crashesAtTier: 0,
				...(action.summary ?? action.reason ? { detail: action.summary ?? action.reason } : {}),
			};
			const nextState = applyJournalEvent(state, entry);
			return { ok: true, state: nextState, sideEffects: [], entry };
		}

		case "record_verify": {
			if (ticket.phase !== "verifying") {
				return fail(
					state,
					`Ticket "${ticket.id}" is in phase "${ticket.phase}", expected "verifying"`,
				);
			}
			const currentTier = ticket.tier ?? 1;

			if (action.verdict === "pass") {
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "record_verify",
					at: ts,
					ticketId: ticket.id,
					verdict: "pass",
					...(action.evidence !== undefined ? { evidence: action.evidence } : {}),
					nextPhase: "ready_to_commit",
					crashesAtTier: ticket.crashesAtTier,
					...(action.summary ? { detail: action.summary } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return { ok: true, state: nextState, sideEffects: [], entry };
			}

			// verdict === "fail"
			if (currentTier + 1 > maxTier) {
				const blockedReason =
					action.reason?.trim() || `Verifier failed at top tier ${currentTier} (max tier ${maxTier})`;
				const provisional: Record<string, WaveTicketState> = {
					...state.tickets,
					[ticket.id]: { ...ticket, phase: "blocked" },
				};
				const waveCompleted = allTicketsSettled(provisional);
				const entry: WaveJournalEntry = {
					version: WAVE_VERSION,
					type: "record_verify",
					at: ts,
					ticketId: ticket.id,
					verdict: "fail",
					...(action.evidence !== undefined ? { evidence: action.evidence } : {}),
					nextPhase: "blocked",
					crashesAtTier: ticket.crashesAtTier,
					blockedReason,
					...(action.summary ?? action.reason ? { detail: action.summary ?? action.reason } : {}),
					...(waveCompleted ? { waveCompleted: true } : {}),
				};
				const nextState = applyJournalEvent(state, entry);
				return {
					ok: true,
					state: nextState,
					sideEffects: [
						{ kind: "set-ticket-status", file: ticket.file, status: "blocked", reason: blockedReason },
					],
					entry,
				};
			}

			const nextTier = currentTier + 1;
			const tierReason = action.reason?.trim() || `escalated after verification failure at tier ${currentTier}`;
			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "record_verify",
				at: ts,
				ticketId: ticket.id,
				verdict: "fail",
				...(action.evidence !== undefined ? { evidence: action.evidence } : {}),
				nextPhase: "triaged",
				tier: nextTier,
				tierSource: "escalation",
				tierReason,
				crashesAtTier: 0,
				...(action.summary ?? action.reason ? { detail: action.summary ?? action.reason } : {}),
			};
			const nextState = applyJournalEvent(state, entry);
			return { ok: true, state: nextState, sideEffects: [], entry };
		}

		case "record_commit": {
			if (ticket.phase !== "ready_to_commit") {
				return fail(
					state,
					`Ticket "${ticket.id}" is in phase "${ticket.phase}", expected "ready_to_commit"`,
				);
			}
			const commitSha = typeof action.commitSha === "string" ? action.commitSha.trim() : "";
			if (!commitSha) {
				return fail(state, `record_commit requires a non-empty commitSha for ticket "${ticket.id}"`);
			}
			if (state.startHeadSha && commitSha === state.startHeadSha) {
				return fail(
					state,
					`Cannot record_commit for ticket "${ticket.id}": commit "${commitSha}" matches pre-wave baseline startHeadSha; make a new commit for this ticket.`,
				);
			}
			const duplicate = Object.values(state.tickets).find(
				(other) => other.id !== ticket.id && other.commitSha === commitSha,
			);
			if (duplicate) {
				return fail(
					state,
					`Cannot record_commit for ticket "${ticket.id}": commit "${commitSha}" is already recorded on ticket "${duplicate.id}"; each ticket requires a unique commit.`,
				);
			}
			const provisional: Record<string, WaveTicketState> = {
				...state.tickets,
				[ticket.id]: { ...ticket, phase: "done", commitSha },
			};
			const waveCompleted = allTicketsSettled(provisional);
			const entry: WaveJournalEntry = {
				version: WAVE_VERSION,
				type: "record_commit",
				at: ts,
				ticketId: ticket.id,
				commitSha,
				waveCompleted,
			};
			const nextState = applyJournalEvent(state, entry);
			return {
				ok: true,
				state: nextState,
				sideEffects: [{ kind: "set-ticket-status", file: ticket.file, status: "done" }],
				entry,
			};
		}
	}
}

function expectedDiskStatusForPhase(st: WaveTicketState): string {
	if (st.phase === "done") return "done";
	if (st.phase === "blocked") return "blocked";
	if (st.phase === "pending") return "ready";
	if (st.phase === "triaged") {
		const alreadyStarted =
			st.tierSource === "escalation" ||
			st.crashesAtTier > 0 ||
			st.history.some((h) => h.action === "start_implement");
		return alreadyStarted ? "in-progress" : "ready";
	}
	return "in-progress";
}

/**
 * Merge live disk `graph` with branch `state` to produce the current dispatch
 * plan: blocking errors, warnings, ready-to-dispatch tickets, waiting tickets,
 * concise summary, and concrete next actions.
 *
 * When a wave `state` exists, `state.tickets` is the single owner for dispatch,
 * blocker satisfaction, and counts; mid-wave disk additions or disk-vs-branch
 * status mismatches are surfaced as warnings instead of emitting un-executable
 * actions.
 */
export function planWaveDispatch(
	state: WaveState | null,
	graph: WaveTicketGraph,
	ladder: WaveLadder,
): WaveDispatchPlan {
	const blockingErrors = blockingIssues(graph as never) as WaveTicketIssue[];
	const warnings = graph.issues.filter((issue) => issue.severity !== "error") as WaveTicketIssue[];

	const sortedDiskTickets = [...graph.tickets].sort((a, b) => compareTicketIds(a.id, b.id));
	const maxTier = Math.max(1, ladder?.tiers?.length ?? 0);

	if (state) {
		for (const disk of sortedDiskTickets) {
			const st = state.tickets[disk.id];
			if (!st) {
				warnings.push({
					code: "untracked-disk-ticket",
					severity: "warning",
					message: `Ticket "${disk.id}" exists on disk (${disk.file}) outside active wave state and is ignored for dispatch`,
				});
				continue;
			}
			const expectedStatus = expectedDiskStatusForPhase(st);
			if (disk.status !== expectedStatus) {
				warnings.push({
					code: "disk-status-mismatch",
					severity: "warning",
					message: `Ticket "${disk.id}" disk status "${disk.status}" disagrees with branch phase "${st.phase}"`,
				});
			}
		}
	}

	const ready: WaveDispatchReadyItem[] = [];
	const waiting: WaveDispatchWaitingItem[] = [];
	const nextActions: WaveNextAction[] = [];

	let doneCount = 0;
	let blockedCount = 0;
	let inFlightCount = 0;

	const entries = state
		? Object.values(state.tickets)
				.sort((a, b) => compareTicketIds(a.id, b.id))
				.map((st) => ({
					id: st.id,
					file: st.file,
					title: st.title || findDiskTicket(graph, st.id)?.title || st.id,
					phase: st.phase,
					blockedBy: st.blockedBy ?? findDiskTicket(graph, st.id)?.blockedBy ?? [],
					tier: st.tier,
					tierSource: st.tierSource,
					tierOverride: findDiskTicket(graph, st.id)?.tierOverride,
				}))
		: sortedDiskTickets.map((disk) => ({
				id: disk.id,
				file: disk.file,
				title: (typeof disk.title === "string" && disk.title.trim()) || disk.id,
				phase: (disk.status === "done"
					? "done"
					: disk.status === "blocked"
						? "blocked"
						: "pending") as WaveTicketPhase,
				blockedBy: [...disk.blockedBy],
				tier: undefined,
				tierSource: undefined,
				tierOverride: disk.tierOverride,
			}));

	const phaseById = new Map(entries.map((entry) => [entry.id, entry.phase]));

	for (const item of entries) {
		const phase = item.phase;

		if (phase === "done") {
			doneCount += 1;
			continue;
		}
		if (phase === "blocked") {
			blockedCount += 1;
			continue;
		}

		if (phase === "implementing" || phase === "reviewing" || phase === "verifying" || phase === "ready_to_commit") {
			inFlightCount += 1;
			const actionMap: Record<
				"implementing" | "reviewing" | "verifying" | "ready_to_commit",
				{ action: string; detail: string }
			> = {
				implementing: { action: "implement_result", detail: "wait for implementer and record outcome" },
				reviewing: { action: "record_review", detail: "dispatch reviewer pin and record verdict" },
				verifying: { action: "record_verify", detail: "dispatch verifier pin and record verdict" },
				ready_to_commit: { action: "record_commit", detail: "commit changes and record commitSha" },
			};
			const mapped = actionMap[phase];
			nextActions.push({ ticketId: item.id, action: mapped.action, detail: mapped.detail });
			continue;
		}

		// phase is "pending" or "triaged"
		const unmetReasons: string[] = [];
		for (const blockerId of item.blockedBy) {
			const blockerPhase = phaseById.get(blockerId);
			if (!blockerPhase) unmetReasons.push(`missing blocker ${blockerId}`);
			else if (blockerPhase !== "done") unmetReasons.push(`waiting on ${blockerId} (${blockerPhase})`);
		}

		if (blockingErrors.length > 0 || unmetReasons.length > 0) {
			waiting.push({
				id: item.id,
				file: item.file,
				title: item.title,
				phase,
				reasons:
					unmetReasons.length > 0
						? unmetReasons
						: blockingErrors.map((e) => e.message),
			});
			continue;
		}

		if (phase === "triaged") {
			const tier = item.tier ?? 1;
			const dispatch = lookupTierDispatch(ladder, tier) ?? undefined;
			ready.push({
				id: item.id,
				file: item.file,
				title: item.title,
				phase,
				tier,
				...(item.tierSource ? { tierSource: item.tierSource } : {}),
				action: "start_implement",
				...(dispatch ? { dispatch } : {}),
			});
			nextActions.push({
				ticketId: item.id,
				action: "start_implement",
				detail: `dispatch tier ${tier} implementer`,
			});
			continue;
		}

		// phase === "pending"
		const override = item.tierOverride;
		const validOverride =
			typeof override === "number" && Number.isInteger(override) && override >= 1 && override <= maxTier;
		if (validOverride) {
			const dispatch = lookupTierDispatch(ladder, override) ?? undefined;
			ready.push({
				id: item.id,
				file: item.file,
				title: item.title,
				phase,
				tier: override,
				tierSource: "tier-override",
				action: "start_implement",
				...(dispatch ? { dispatch } : {}),
			});
			nextActions.push({
				ticketId: item.id,
				action: "start_implement",
				detail: `dispatch tier ${override} implementer (tier-override)`,
			});
		} else {
			ready.push({
				id: item.id,
				file: item.file,
				title: item.title,
				phase,
				action: "triage",
			});
			nextActions.push({
				ticketId: item.id,
				action: "triage",
				detail: "classify ticket complexity tier",
			});
		}
	}

	const label = state?.folder ?? graph.dir ?? "tickets";
	const summary =
		blockingErrors.length > 0
			? `Wave (${label}): ${blockingErrors.length} blocking graph error(s); dispatch halted`
			: `Wave (${label}): ${ready.length} ready, ${inFlightCount} in-flight, ${waiting.length} waiting, ${doneCount} done, ${blockedCount} blocked`;

	return {
		blockingErrors,
		warnings,
		ready,
		waiting,
		summary,
		nextActions,
	};
}

// --- Shell command detection for git commit gating -------------------------

const SHELL_ENV_WITH_ARG = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const SHELL_LEADING_KEYWORDS = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"]);
const NESTED_SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const GIT_GLOBAL_OPTS_WITH_ARG = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--exec-path",
	"--config-env",
]);

interface ShellToken {
	value: string;
	quoted: boolean;
	envAssignable?: boolean;
	isRedirectOp?: boolean;
	hasAttachedTarget?: boolean;
}

function extractDollarParenSubstitution(command: string, startAfterOpen: number): { body: string; endIndex: number } {
	let depth = 1;
	let quote: "'" | "$'" | '"' | null = null;
	let atWordStart = true;

	for (let i = startAfterOpen; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];

		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === "$'") {
			if (ch === "\\" && next !== undefined) i += 1;
			else if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && next !== undefined) i += 1;
			else if (ch === '"') quote = null;
			continue;
		}

		if (ch === "\\" && next !== undefined) {
			atWordStart = false;
			i += 1;
			continue;
		}
		if (ch === "#" && atWordStart) {
			while (i < command.length && command[i] !== "\n") i += 1;
			atWordStart = true;
			continue;
		}
		if (ch === "$" && next === "'") {
			quote = "$'";
			atWordStart = false;
			i += 1;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			atWordStart = false;
			continue;
		}
		if (ch === "(") {
			depth += 1;
			atWordStart = true;
			continue;
		}
		if (ch === ")") {
			depth -= 1;
			if (depth === 0) {
				return { body: command.slice(startAfterOpen, i), endIndex: i };
			}
			atWordStart = true;
			continue;
		}
		atWordStart = /\s/.test(ch) || ch === ";" || ch === "\n" || ch === "|" || ch === "&";
	}

	return { body: command.slice(startAfterOpen), endIndex: command.length - 1 };
}

function extractBacktickSubstitution(command: string, startAfterOpen: number): { body: string; endIndex: number } {
	let body = "";
	for (let i = startAfterOpen; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];
		if (ch === "\\" && next !== undefined) {
			if (next === "`" || next === "$" || next === "\\") {
				body += next;
			} else {
				body += ch + next;
			}
			i += 1;
			continue;
		}
		if (ch === "`") {
			return { body, endIndex: i };
		}
		body += ch;
	}
	return { body, endIndex: command.length - 1 };
}

function collectCommandSubstitutions(command: string): string[] {
	const substitutions: string[] = [];
	let quote: "'" | "$'" | '"' | null = null;
	let atWordStart = true;

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];

		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === "$'") {
			if (ch === "\\" && next !== undefined) i += 1;
			else if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && next !== undefined) {
				i += 1;
				continue;
			}
			if (ch === '"') {
				quote = null;
				continue;
			}
			if (ch === "$" && next === "(") {
				const extracted = extractDollarParenSubstitution(command, i + 2);
				substitutions.push(extracted.body);
				i = extracted.endIndex;
				continue;
			}
			if (ch === "`") {
				const extracted = extractBacktickSubstitution(command, i + 1);
				substitutions.push(extracted.body);
				i = extracted.endIndex;
				continue;
			}
			continue;
		}

		// Unquoted
		if (ch === "\\" && next !== undefined) {
			atWordStart = false;
			i += 1;
			continue;
		}
		if (ch === "#" && atWordStart) {
			while (i < command.length && command[i] !== "\n") i += 1;
			atWordStart = true;
			continue;
		}
		if (ch === "$" && next === "'") {
			quote = "$'";
			atWordStart = false;
			i += 1;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			atWordStart = false;
			continue;
		}
		if (ch === "$" && next === "(") {
			const extracted = extractDollarParenSubstitution(command, i + 2);
			substitutions.push(extracted.body);
			i = extracted.endIndex;
			atWordStart = false;
			continue;
		}
		if (ch === "`") {
			const extracted = extractBacktickSubstitution(command, i + 1);
			substitutions.push(extracted.body);
			i = extracted.endIndex;
			atWordStart = false;
			continue;
		}
		atWordStart = /\s/.test(ch) || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "|" || ch === "&";
	}

	return substitutions;
}

/**
 * Split a shell command string into statement token arrays, respecting single
 * quotes, double quotes, ANSI-C `$'...'` quotes, backslash escapes, `#` comments,
 * redirections (`>/dev/null`, `> /dev/null`, `2>&1`), and shell operators
 * (`&&`, `||`, `;`, `|`, `&`, `\n`, `(`, `)`).
 */
function splitShellStatements(command: string): ShellToken[][] {
	const statements: ShellToken[][] = [];
	let tokens: ShellToken[] = [];
	let current = "";
	let hasToken = false;
	let quoted = false;
	let escaped = false;
	let envAssignable = false;
	let sawEquals = false;
	let quote: "'" | "$'" | '"' | null = null;

	const flushToken = (): void => {
		if (hasToken) {
			tokens.push({ value: current, quoted, envAssignable });
			current = "";
			hasToken = false;
			quoted = false;
			escaped = false;
			envAssignable = false;
			sawEquals = false;
		}
	};

	const flushStatement = (): void => {
		flushToken();
		if (tokens.length > 0) {
			statements.push(tokens);
			tokens = [];
		}
	};

	const consumeRedirect = (startIdx: number, prefix: string): number => {
		let i = startIdx;
		let op = prefix;
		const ch = command[i]!;
		const next = command[i + 1];
		const third = command[i + 2];

		if (ch === "&" && next === ">") {
			if (third === ">") {
				op += "&>>";
				i += 3;
			} else {
				op += "&>";
				i += 2;
			}
		} else if (ch === "<") {
			if (next === "<" && third === "<") {
				op += "<<<";
				i += 3;
			} else if (next === "<" || next === "&" || next === ">") {
				op += ch + next;
				i += 2;
			} else {
				op += ch;
				i += 1;
			}
		} else {
			// ch === ">"
			if (next === ">" || next === "&" || next === "|") {
				op += ch + next;
				i += 2;
			} else {
				op += ch;
				i += 1;
			}
		}

		// Consume attached target if not separated by whitespace or metacharacter
		let attached = "";
		let targetQuote: "'" | "$'" | '"' | null = null;
		while (i < command.length) {
			const c = command[i]!;
			const n = command[i + 1];
			if (targetQuote === "'") {
				attached += c;
				if (c === "'") targetQuote = null;
				i += 1;
				continue;
			}
			if (targetQuote === "$'") {
				if (c === "\\" && n !== undefined) {
					attached += c + n;
					i += 2;
				} else {
					attached += c;
					if (c === "'") targetQuote = null;
					i += 1;
				}
				continue;
			}
			if (targetQuote === '"') {
				if (c === "\\" && n !== undefined) {
					attached += c + n;
					i += 2;
				} else {
					attached += c;
					if (c === '"') targetQuote = null;
					i += 1;
				}
				continue;
			}
			if (/\s/.test(c) || c === ";" || c === "\n" || c === "(" || c === ")" || c === "|" || c === "&" || c === "<" || c === ">" || c === "#") {
				break;
			}
			if (c === "\\" && n !== undefined) {
				attached += n;
				i += 2;
				continue;
			}
			if (c === "$" && n === "'") {
				targetQuote = "$'";
				attached += "$'";
				i += 2;
				continue;
			}
			if (c === "'" || c === '"') {
				targetQuote = c;
				attached += c;
				i += 1;
				continue;
			}
			attached += c;
			i += 1;
		}

		tokens.push({
			value: op + attached,
			quoted: false,
			isRedirectOp: true,
			hasAttachedTarget: attached.length > 0,
		});
		return i - 1;
	};

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i]!;
		const next = command[i + 1];

		if (quote === "'") {
			if (ch === "'") {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		if (quote === "$'") {
			if (ch === "\\" && next !== undefined) {
				current += ch + next;
				i += 1;
			} else if (ch === "'") {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		if (quote === '"') {
			if (ch === "\\" && next !== undefined) {
				current += next;
				i += 1;
			} else if (ch === '"') {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}

		// Unquoted context
		if (ch === "\\" && next !== undefined) {
			if (next === "\n") {
				i += 1;
				continue;
			}
			hasToken = true;
			escaped = true;
			current += next;
			i += 1;
			continue;
		}

		if (ch === "$" && next === "'") {
			quote = "$'";
			quoted = true;
			hasToken = true;
			i += 1;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			quoted = true;
			hasToken = true;
			continue;
		}

		if (ch === "#" && !hasToken) {
			while (i < command.length && command[i] !== "\n") i += 1;
			flushStatement();
			continue;
		}

		if (ch === "<" || ch === ">" || (ch === "&" && next === ">")) {
			let prefix = "";
			if ((ch === "<" || ch === ">") && hasToken && !quoted && !escaped && /^[0-9]+$/.test(current)) {
				prefix = current;
				current = "";
				hasToken = false;
				escaped = false;
			} else {
				flushToken();
			}
			i = consumeRedirect(i, prefix);
			continue;
		}

		if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
			flushStatement();
			continue;
		}

		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			flushStatement();
			i += 1;
			continue;
		}

		if (ch === "|" || ch === "&") {
			flushStatement();
			continue;
		}

		if (/\s/.test(ch)) {
			flushToken();
			continue;
		}

		if (ch === "=" && !sawEquals) {
			sawEquals = true;
			if (!quoted && !escaped && /^[A-Za-z_][A-Za-z0-9_]*$/.test(current)) {
				envAssignable = true;
			}
		}

		hasToken = true;
		current += ch;
	}

	flushStatement();
	return statements;
}

function commandBasename(word: string): string {
	const idx = word.lastIndexOf("/");
	return idx >= 0 ? word.slice(idx + 1) : word;
}

function isEnvAssignment(token: ShellToken): boolean {
	return Boolean(token.envAssignable);
}

function isEnvArgAssignment(token: ShellToken): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);
}

function statementInvokesGitCommit(rawTokens: ShellToken[]): boolean {
	// Strip redirection operators and standalone redirect target tokens
	const tokens: ShellToken[] = [];
	for (let i = 0; i < rawTokens.length; i += 1) {
		const token = rawTokens[i]!;
		if (token.isRedirectOp) {
			if (!token.hasAttachedTarget) i += 1;
			continue;
		}
		tokens.push(token);
	}

	let idx = 0;

	// Skip leading keywords, env assignments, and command wrappers in any combination
	while (idx < tokens.length) {
		const token = tokens[idx]!;
		if (!token.quoted && SHELL_LEADING_KEYWORDS.has(token.value)) {
			idx += 1;
			continue;
		}
		if (isEnvAssignment(token)) {
			idx += 1;
			continue;
		}

		const cmd = commandBasename(token.value);
		if (cmd === "env") {
			idx += 1;
			while (idx < tokens.length) {
				const t = tokens[idx]!;
				if (isEnvArgAssignment(t)) {
					idx += 1;
					continue;
				}
				if (t.value === "--") {
					idx += 1;
					break;
				}
				if (t.value.startsWith("-")) {
					if (SHELL_ENV_WITH_ARG.has(t.value)) idx += 2;
					else idx += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (cmd === "command") {
			idx += 1;
			let lookupOnly = false;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-")) {
				const flag = tokens[idx]!.value;
				if (flag === "-v" || flag === "-V") lookupOnly = true;
				idx += 1;
				if (flag === "--") break;
			}
			if (lookupOnly) return false;
			continue;
		}
		if (cmd === "exec") {
			idx += 1;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-")) {
				const flag = tokens[idx]!.value;
				if (flag === "--") {
					idx += 1;
					break;
				}
				if (flag === "-a") {
					idx += 2;
					continue;
				}
				idx += 1;
			}
			continue;
		}
		if (cmd === "time") {
			idx += 1;
			while (idx < tokens.length && tokens[idx]!.value.startsWith("-")) {
				const flag = tokens[idx]!.value;
				idx += 1;
				if (flag === "--") break;
			}
			continue;
		}
		if (cmd === "nohup") {
			idx += 1;
			if (idx < tokens.length && tokens[idx]!.value === "--") idx += 1;
			continue;
		}
		break;
	}

	if (idx >= tokens.length) return false;
	const cmd = commandBasename(tokens[idx]!.value);

	if (NESTED_SHELL_COMMANDS.has(cmd)) {
		idx += 1;
		let sawC = false;
		while (idx < tokens.length) {
			const arg = tokens[idx]!.value;
			if (arg === "--") {
				idx += 1;
				break;
			}
			if (arg === "-o" || arg === "+o") {
				idx += 2;
				continue;
			}
			if (arg === "-" || (!arg.startsWith("-") && !arg.startsWith("+"))) {
				break;
			}
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
				sawC = true;
			}
			idx += 1;
		}
		if (sawC && idx < tokens.length) {
			return isGitCommitCommand(tokens[idx]!.value);
		}
		return false;
	}

	if (cmd !== "git") return false;
	idx += 1;

	while (idx < tokens.length) {
		const arg = tokens[idx]!.value;
		if (arg === "--") {
			idx += 1;
			break;
		}
		if (GIT_GLOBAL_OPTS_WITH_ARG.has(arg)) {
			idx += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			idx += 1;
			continue;
		}
		return arg === "commit";
	}

	return idx < tokens.length && tokens[idx]!.value === "commit";
}

/**
 * Detect whether a shell command invokes `git commit`, avoiding false positives
 * on inspection commands (`git status`, `git log`, `git diff`, `git show`) or
 * quoted strings (`echo "git commit"`, `grep "git commit"`).
 */
export function isGitCommitCommand(command: string): boolean {
	if (typeof command !== "string" || !command.trim()) return false;
	const statements = splitShellStatements(command);
	if (statements.some((stmt) => statementInvokesGitCommit(stmt))) {
		return true;
	}
	const substitutions = collectCommandSubstitutions(command);
	return substitutions.some((sub) => isGitCommitCommand(sub));
}

/**
 * Gate for `git commit` while a wave is active: allowed when no wave is active
 * OR at least one ticket is in `"ready_to_commit"`.
 */
export function canRunGitCommit(state: WaveState | null): { allowed: boolean; reason?: string } {
	if (!state || state.status !== "active") {
		return { allowed: true };
	}
	const ready = Object.values(state.tickets).some((t) => t.phase === "ready_to_commit");
	if (ready) {
		return { allowed: true };
	}
	const summary = Object.values(state.tickets)
		.sort((a, b) => compareTicketIds(a.id, b.id))
		.map((t) => `${t.id}:${t.phase}`)
		.join(", ");
	return {
		allowed: false,
		reason: `Cannot run \`git commit\` while wave "${state.folder}" has no ticket in "ready_to_commit" (current phases: ${summary}). Complete the verifier gate and record verification pass first.`,
	};
}

/**
 * Evaluate whether an active wave blocks settlement. Returns `null` when no
 * wave is active or every ticket is `"done"` or `"blocked"`.
 */
export function evaluateWaveGate(state: WaveState | null): WaveGateReport | null {
	if (!state || state.status !== "active") return null;
	const unfinished = Object.values(state.tickets)
		.filter((t) => t.phase !== "done" && t.phase !== "blocked")
		.sort((a, b) => compareTicketIds(a.id, b.id));
	if (unfinished.length === 0) return null;

	const unfinishedIds = unfinished.map((t) => t.id);
	const evidence = unfinished
		.map((t) => `${t.id}:${t.phase}${t.tier !== undefined ? `@T${t.tier}` : ""}`)
		.join(",");
	const summary = `wave "${state.folder}" is active with ${unfinished.length} unfinished ticket${unfinished.length === 1 ? "" : "s"}: ${unfinished.map((t) => `${t.id} (${t.phase})`).join(", ")}`;

	return { unfinishedIds, summary, evidence };
}

/**
 * Concise readable wave summary for `/orchestrate status` and snapshots.
 */
export function formatWaveSummary(state: WaveState): string {
	const tickets = Object.values(state.tickets).sort((a, b) => compareTicketIds(a.id, b.id));
	const doneCount = tickets.filter((t) => t.phase === "done").length;
	const blockedCount = tickets.filter((t) => t.phase === "blocked").length;
	const activeCount = tickets.length - doneCount - blockedCount;
	const items = tickets
		.map((t) => (t.tier !== undefined ? `${t.id}:${t.phase}(T${t.tier})` : `${t.id}:${t.phase}`))
		.join(", ");
	return `Wave (${state.folder}): ${state.status} · ${doneCount}/${tickets.length} done, ${activeCount} active, ${blockedCount} blocked${items ? ` · ${items}` : ""}`;
}
