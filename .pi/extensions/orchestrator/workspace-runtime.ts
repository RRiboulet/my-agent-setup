/**
 * The pi-facing half of workspace coordination.
 *
 * `workspace.ts` owns the store, the records and the decisions; this file owns
 * the session: the tools, the heartbeat, the inbox poller, the write guard and
 * every timer's lifetime. Keeping the two apart is what lets the store be
 * tested against real temporary repositories without a pi host.
 *
 * Three rules this file exists to keep:
 *
 *   - **Joining is explicit.** Loading the extension starts no timer and writes
 *     nothing. A session joins through `orchestrator_workspace`, which is the
 *     only path that starts the heartbeat and the inbox poller.
 *   - **No timer outlives the session.** Every interval is `unref`'d and held in
 *     one place; `session_shutdown` clears it, removes the presence entry and
 *     releases this session's reservations. The subagent watcher already paid
 *     for this lesson in a different timer.
 *   - **A guard failure must never trap a write.** Resolving the repository,
 *     reading the registry, or a corrupt record all fail open: the write runs.
 *     Reservations are advisory by design, and a false block is worse than a
 *     missed collision.
 *
 * The write guard is deliberately a second `tool_call` handler in the
 * orchestrator extension. pi stops at the first handler that returns
 * `{ block: true }`, so this is registered before the loop breaker: a reserved
 * path refuses the call, and the loop breaker only ever sees calls that were
 * allowed to run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { unlink } from "node:fs/promises";
import { join as joinPath } from "node:path";

import {
	DEFAULT_PRESENCE_TTL_MS,
	MAX_MESSAGE_BODY_BYTES,
	MAX_REASON_BYTES,
	WORKSPACE_VERSION,
	buildPeerMessage,
	buildPresence,
	buildReservationPaths,
	canonicalPath,
	clampMessageTtl,
	clampPresenceTtl,
	clampReservationTtl,
	formatPeerMessage,
	inboxDir,
	listPresence,
	liveReservations,
	markMessageDelivered,
	presenceHeartbeatMs,
	presencePath,
	readInbox,
	releaseReservations,
	removePeerMessage,
	reservationMatches,
	reservationsDir,
	reservePaths,
	resolveWorkspaceScope,
	reservationPathMatches,
	touchPresence,
	writePeerMessage,
	writePresence,
	type GitRun,
	type PeerMessage,
	type PresenceRecord,
	type ReservationRecord,
	type ScopeResult,
	type WorkspaceScope,
} from "./workspace.ts";

export const WORKSPACE_TOOL = "orchestrator_workspace";
export const RESERVE_TOOL = "orchestrator_reserve";
export const MESSAGE_TOOL = "orchestrator_message";

export const RESERVATION_OVERRIDE_ENTRY_TYPE = "orchestrator-workspace-reservation-override";
export const PEER_MESSAGE_TYPE = "orchestrator-peer-message";
export const PEER_MESSAGE_EXPIRED_TYPE = "orchestrator-peer-message-expired";

const DEFAULT_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;

export interface WorkspaceRuntimeOptions {
	/** `pi.exec` in production; a real-git double in tests. */
	run?: GitRun;
	now?: () => number;
	/** Presence TTL for a join that does not name one. */
	presenceTtlMs?: number;
	/** Heartbeat period; defaults to a third of the TTL. */
	heartbeatMs?: number;
	/** Inbox poll period; tests use a short one. */
	pollMs?: number;
	/** Test seam for a deterministic message id. */
	messageId?: () => string;
	/** Test seam: make a heartbeat observable and delayable. */
	touch?: typeof touchPresence;
}

interface Joined {
	sessionId: string;
	scope: WorkspaceScope;
	record: PresenceRecord;
	ctx: ExtensionContext;
	heartbeat: ReturnType<typeof setInterval> | null;
	heartbeatMs: number;
	poller: ReturnType<typeof setInterval> | null;
	heartbeatInFlight: boolean;
	polling: boolean;
}

export interface WorkspaceRuntime {
	join(ctx: ExtensionContext, options?: { ttlMs?: number }): Promise<string>;
	leave(ctx?: ExtensionContext): Promise<string>;
	peers(ctx: ExtensionContext): Promise<string>;
	reserve(ctx: ExtensionContext, input: ReserveInput): Promise<string>;
	release(ctx: ExtensionContext, id?: string): Promise<string>;
	listReservations(ctx: ExtensionContext): Promise<string>;
	armOverride(ctx: ExtensionContext, reason: string): Promise<string>;
	send(ctx: ExtensionContext, input: SendInput): Promise<string>;
	/** The poller's single tick, exposed so tests do not have to race a timer. */
	tick(): Promise<void>;
	/** The write/edit guard, exposed so tests can drive it without a model turn. */
	checkToolCall(
		event: { toolName?: string; input?: unknown },
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined>;
	/** For tests and `/workspace`: whether this runtime is joined. */
	isJoined(): boolean;
	shutdown(): Promise<void>;
}

export interface ReserveInput {
	paths: string[];
	reason: string;
	ttlMs?: number;
}

export interface SendInput {
	to: string;
	body: string;
	ttlMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function ageText(now: number, at: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}

function peerLine(record: PresenceRecord, now: number, self: string | null): string {
	const marks = [
		record.sessionId === self ? " (you)" : "",
		record.branch ? ` branch ${record.branch}` : " detached HEAD",
	].join("");
	return `- ${record.sessionId}${marks} — ${record.cwd} — last seen ${ageText(now, record.lastSeenAt)} ago`;
}

function sessionIdOf(ctx: ExtensionContext): string | null {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id ? id : null;
	} catch {
		return null;
	}
}

function formatReservation(record: ReservationRecord, now: number): string {
	const remaining = Math.max(0, Math.round((record.expiresAt - now) / 1000));
	const left = remaining < 90 ? `${remaining}s` : `${Math.round(remaining / 60)}m`;
	const paths = record.paths.map((path) => `${path.kind}:${path.pattern}`).join(", ");
	return `- ${record.id} by ${record.sessionId} — ${paths} — ${record.reason} — ${record.expiresAt <= now ? "expired" : `expires in ${left}`}`;
}

function reservationRefusal(
	tool: string,
	candidate: string,
	conflicts: { reservation: ReservationRecord; path: { pattern: string; kind: string } }[],
): string {
	const holder = conflicts[0]!.reservation;
	const lines = [
		`\`${tool}\` refused: ${candidate} is reserved by another session.`,
		"",
		`Holder: ${holder.sessionId} in ${holder.cwd}${holder.branch ? ` (branch ${holder.branch})` : ""}`,
		`Reason: ${holder.reason}`,
		`Reserved: ${conflicts.map((conflict) => `${conflict.path.kind}:${conflict.path.pattern}`).join(", ")}`,
		"",
		"Reservations are advisory: they guard this repository's write and edit tools, not shell commands or nested tool execution. If the collision is expected, grant a one-shot override with `orchestrator_reserve` (`action: \"override\"`) and a reason, then retry — the override is recorded in the session. Otherwise coordinate with the holder, or wait for the reservation to expire.",
	];
	return lines.join("\n");
}

export function registerWorkspace(pi: ExtensionAPI, options: WorkspaceRuntimeOptions = {}): WorkspaceRuntime {
	const now = options.now ?? Date.now;
	const presenceTtlMs = clampPresenceTtl(options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS);
	const heartbeatMs = options.heartbeatMs ?? Math.round(presenceTtlMs / 3);
	const touch = options.touch ?? touchPresence;
	const heartbeatFor = (ttlMs: number): number => presenceHeartbeatMs(ttlMs, heartbeatMs);
	const pollMs = Math.min(MAX_POLL_MS, Math.max(1, options.pollMs ?? DEFAULT_POLL_MS));
	const run: GitRun =
		options.run ??
		(async (args, cwd) => {
			if (typeof pi.exec !== "function") {
				return { stdout: "", stderr: "this host provides no pi.exec", code: 1, killed: false };
			}
			return pi.exec("git", args, { cwd, timeout: 15_000 });
		});

	/** One resolution per cwd; `join` may force a retry after a `git init`. */
	const scopes = new Map<string, Promise<ScopeResult>>();
	const scopeFor = (cwd: string, force = false): Promise<ScopeResult> => {
		const cached = scopes.get(cwd);
		if (cached && !force) return cached;
		const pending = resolveWorkspaceScope(cwd, run).catch((error: unknown) => ({
			ok: false as const,
			reason: `git failed: ${error instanceof Error ? error.message : String(error)}`,
		}));
		scopes.set(cwd, pending);
		return pending;
	};

	let joined: Joined | null = null;
	let shuttingDown = false;
	let humanPromptOpen = false;
	let releasedThisTurn = false;
	let overrideArmed: { reason: string; at: number } | null = null;
	const deliveredIds = new Set<string>();

	const clearJoinedTimers = (state: Joined): void => {
		if (state.heartbeat) {
			clearInterval(state.heartbeat);
			state.heartbeat = null;
		}
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};

	const releaseOwnReservations = async (registryDir: string, sessionId: string): Promise<ReservationRecord[]> => {
		try {
			const result = await releaseReservations(registryDir, { sessionId, now: now() });
			return result.released;
		} catch {
			return [];
		}
	};

	const shutdown = async (): Promise<void> => {
		shuttingDown = true;
		if (!joined) return;
		const state = joined;
		joined = null;
		clearJoinedTimers(state);
		await releaseOwnReservations(state.scope.registryDir, state.sessionId);
		try {
			await writeJsonPresenceRemoval(state.scope.registryDir, state.sessionId);
		} catch {
			// A failed leave is bounded by the presence TTL. Shutdown must not hang.
		}
	};

	const startTimers = (state: Joined): void => {
		const heartbeat = setInterval(() => {
			if (shuttingDown || state.heartbeatInFlight) return;
			state.heartbeatInFlight = true;
			void touch(state.scope.registryDir, state.record, now())
				.then(async (next) => {
					if (shuttingDown || joined === null || joined.sessionId !== state.sessionId) {
						await writeJsonPresenceRemoval(state.scope.registryDir, state.sessionId).catch(() => undefined);
						return;
					}
					state.record = next;
				})
				.catch(() => {
					// A lost beat is recovered by the next one; the TTL is the bound.
				})
				.finally(() => {
					state.heartbeatInFlight = false;
				});
		}, state.heartbeatMs);
		heartbeat.unref?.();
		state.heartbeat = heartbeat;

		const poller = setInterval(() => {
			void runtime.tick();
		}, pollMs);
		poller.unref?.();
		state.poller = poller;
	};

	const join = async (ctx: ExtensionContext, joinOptions: { ttlMs?: number } = {}): Promise<string> => {
		const sessionId = sessionIdOf(ctx);
		if (!sessionId) return "This host exposed no session id, so the workspace cannot publish a presence entry.";
		if (joined) {
			if (joinOptions.ttlMs !== undefined) {
				joined.record = { ...joined.record, ttlMs: clampPresenceTtl(joinOptions.ttlMs) };
				const nextBeat = heartbeatFor(joined.record.ttlMs);
				if (nextBeat !== joined.heartbeatMs) {
					clearJoinedTimers(joined);
					joined.heartbeatMs = nextBeat;
					startTimers(joined);
				}
			}
			joined.record = await touch(joined.scope.registryDir, joined.record, now());
			const peers = await listPresence(joined.scope.registryDir, now());
			return `Already joined ${joined.scope.registryDir} as ${sessionId}.\n${peerSummary(peers.peers, now(), sessionId)}`;
		}
		const scope = await scopeFor(ctx.cwd, true);
		if (!scope.ok) {
			return `Workspace not joined: ${scope.reason}. Presence, reservations and peer messages are a no-op outside a git repository.`;
		}
		const record = buildPresence({
			sessionId,
			pid: process.pid,
			cwd: ctx.cwd,
			branch: scope.scope.branch,
			now: now(),
			ttlMs: joinOptions.ttlMs ?? presenceTtlMs,
		});
		try {
			await writePresence(scope.scope.registryDir, record);
		} catch (error) {
			return `Workspace not joined: could not write the presence record: ${(error as Error).message}`;
		}
		const state: Joined = {
			sessionId,
			scope: scope.scope,
			record,
			ctx,
			heartbeat: null,
			heartbeatMs: heartbeatFor(record.ttlMs),
			poller: null,
			heartbeatInFlight: false,
			polling: false,
		};
		joined = state;
		shuttingDown = false;
		releasedThisTurn = false;
		startTimers(state);
		const peers = await listPresence(scope.scope.registryDir, now());
		return [
			`Joined the workspace for ${scope.scope.commonDir} as ${sessionId}${scope.scope.branch ? ` on branch ${scope.scope.branch}` : " (detached HEAD)"}.`,
			`Registry: ${scope.scope.registryDir} (outside the working tree).`,
			`Presence expires in ${Math.round(record.ttlMs / 1000)}s without a heartbeat; this session heartbeats every ${Math.round(state.heartbeatMs / 1000)}s.`,
			"",
			peerSummary(peers.peers, now(), sessionId),
		].join("\n");
	};

	const peerSummary = (peers: PresenceRecord[], at: number, self: string | null): string => {
		const others = peers.filter((peer) => peer.sessionId !== self);
		if (others.length === 0) {
			return peers.some((peer) => peer.sessionId === self)
				? "No other session is in this repository's workspace."
				: "No live sessions are in this repository's workspace.";
		}
		return [`Live peers (${others.length}):`, ...others.map((peer) => peerLine(peer, at, self))].join("\n");
	};

	const leave = async (ctx?: ExtensionContext): Promise<string> => {
		if (!joined) {
			// A read-only peers call does not join, but `leave` is idempotent: saying
			// so is more useful than an error.
			return "This session is not joined to a workspace.";
		}
		const state = joined;
		joined = null;
		clearJoinedTimers(state);
		const released = await releaseOwnReservations(state.scope.registryDir, state.sessionId);
		try {
			await writeJsonPresenceRemoval(state.scope.registryDir, state.sessionId);
		} catch (error) {
			return `Left the workspace in memory, but could not remove the presence record (${(error as Error).message}). It expires within its TTL.`;
		}
		const ctxId = ctx ? sessionIdOf(ctx) : state.sessionId;
		if (ctxId && ctxId !== state.sessionId) {
			return `Left the workspace as ${state.sessionId}; this context belongs to ${ctxId}, which was not joined.`;
		}
		return `Left the workspace as ${state.sessionId}; presence removed${released.length ? ` and ${released.length} reservation${released.length === 1 ? "" : "s"} released` : ""}.`;
	};

	const peers = async (ctx: ExtensionContext): Promise<string> => {
		const sessionId = sessionIdOf(ctx);
		const scope = await scopeFor(ctx.cwd);
		if (!scope.ok) return `Workspace unavailable: ${scope.reason}. Nothing is read or written outside a git repository.`;
		const result = await listPresence(scope.scope.registryDir, now());
		const lines = [`Registry: ${scope.scope.registryDir}`];
		if (sessionId) {
			const own = result.peers.find((peer) => peer.sessionId === sessionId);
			lines.push(own ? `You: ${sessionId} (${own.cwd}${own.branch ? `, branch ${own.branch}` : ", detached"})` : `You: ${sessionId} — not joined (call \`${WORKSPACE_TOOL}\` with action "join")`);
		}
		lines.push("", peerSummary(result.peers, now(), sessionId));
		if (result.invalid.length > 0) lines.push("", `Ignored ${result.invalid.length} unparsable presence file(s).`);
		return lines.join("\n");
	};

	const reserve = async (ctx: ExtensionContext, input: ReserveInput): Promise<string> => {
		if (!joined) return `Reserve requires a joined workspace: call \`${WORKSPACE_TOOL}\` with action "join" first.`;
		let paths;
		try {
			paths = buildReservationPaths(ctx.cwd, input.paths);
		} catch (error) {
			return `Reservation failed: ${(error as Error).message}`;
		}
		if (paths.length === 0) return "No reservation paths were given.";
		let result;
		try {
			result = await reservePaths(joined.scope.registryDir, {
				sessionId: joined.sessionId,
				cwd: ctx.cwd,
				branch: joined.scope.branch,
				paths,
				reason: input.reason,
				now: now(),
				ttlMs: input.ttlMs,
			});
		} catch (error) {
			return `Reservation failed: ${(error as Error).message}`;
		}
		if (!result.ok) {
			const lines = [
				"Reservation refused: another session already holds an overlapping path.",
				...result.conflicts.map(
					(conflict) =>
						`- ${conflict.reservation.sessionId} holds ${conflict.path.kind}:${conflict.path.pattern} — ${conflict.reservation.reason}`,
				),
			];
			return lines.join("\n");
		}
		return [
			`Reserved ${result.reservation.paths.map((path) => `${path.kind}:${path.pattern}`).join(", ")}.`,
			`Id: ${result.reservation.id}; expires at ${new Date(result.reservation.expiresAt).toISOString()}.${result.replaced.length ? ` Superseded ${result.replaced.length} earlier reservation${result.replaced.length === 1 ? "" : "s"} for the same paths.` : ""}`,
			"Advisory only: `write` and `edit` in another session are refused, but shell commands and nested tool execution are not prevented.",
		].join("\n");
	};

	const release = async (ctx: ExtensionContext, id?: string): Promise<string> => {
		if (!joined) return `Release requires a joined workspace: call \`${WORKSPACE_TOOL}\` with action "join" first.`;
		try {
			const result = await releaseReservations(joined.scope.registryDir, {
				sessionId: joined.sessionId,
				id,
				now: now(),
			});
			if (result.released.length === 0) {
				return id ? `No reservation ${id} held by this session.` : "This session held no reservations.";
			}
			return `Released ${result.released.map((record) => record.id).join(", ")}.`;
		} catch (error) {
			return `Release failed: ${(error as Error).message}`;
		}
	};

	const listOwnReservations = async (ctx: ExtensionContext): Promise<string> => {
		const scope = await scopeFor(ctx.cwd);
		if (!scope.ok) return `Workspace unavailable: ${scope.reason}.`;
		let records;
		try {
			records = await liveReservations(scope.scope.registryDir, now());
		} catch (error) {
			return `Could not read reservations: ${(error as Error).message}`;
		}
		if (records.live.length === 0) return `No live reservations in ${reservationsDir(scope.scope.registryDir)}.`;
		const at = now();
		return [`Live reservations (${records.live.length}):`, ...records.live.map((record) => formatReservation(record, at))].join("\n");
	};

	const armOverride = async (ctx: ExtensionContext, reason: string): Promise<string> => {
		const trimmed = reason.trim();
		if (!trimmed) return "An override needs a non-empty reason; it is recorded in the session so it is auditable.";
		const at = now();
		overrideArmed = { reason: trimmed.slice(0, MAX_REASON_BYTES), at };
		pi.appendEntry(RESERVATION_OVERRIDE_ENTRY_TYPE, {
			version: WORKSPACE_VERSION,
			action: "grant",
			reason: overrideArmed.reason,
			sessionId: sessionIdOf(ctx),
			at,
		});
		return `Reservation override granted once: ${overrideArmed.reason}. The next write or edit blocked by a reservation will proceed, and the override is recorded.`;
	};

	const send = async (ctx: ExtensionContext, input: SendInput): Promise<string> => {
		if (!joined) return `Sending requires a joined workspace: call \`${WORKSPACE_TOOL}\` with action "join" first.`;
		const body = input.body.trim();
		if (!body) return "A peer message needs a non-empty body.";
		if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BODY_BYTES) {
			return `A peer message may be at most ${MAX_MESSAGE_BODY_BYTES} bytes; this one is ${Buffer.byteLength(body, "utf8")}.`;
		}
		const self = joined.sessionId;
		const to = input.to.trim();
		if (!to) return "A peer message needs a recipient session id (see `orchestrator_workspace` action \"peers\").";
		if (to === self) return "Refusing to message this session; pick a peer from `orchestrator_workspace` action \"peers\".";
		const peers = await listPresence(joined.scope.registryDir, now());
		const matched = peers.peers.filter((peer) => peer.sessionId === to || peer.sessionId.startsWith(to));
		const others = matched.filter((peer) => peer.sessionId !== self);
		if (others.length === 0) {
			if (matched.some((peer) => peer.sessionId === self) || self.startsWith(to)) {
				return "Refusing to message this session; pick a peer from `orchestrator_workspace` action \"peers\".";
			}
			return `Peer ${to} is gone: no live presence entry in ${joined.scope.registryDir}. The session left, was killed, or its TTL passed.`;
		}
		if (others.length > 1 && !others.some((peer) => peer.sessionId === to)) {
			return `Peer id ${to} is ambiguous; it matches ${others.map((peer) => peer.sessionId).join(", ")}.`;
		}
		const target = others.find((peer) => peer.sessionId === to) ?? others[0]!;
		let message: PeerMessage;
		try {
			message = buildPeerMessage({
				id: options.messageId?.(),
				sessionId: self,
				cwd: ctx.cwd,
				branch: joined.scope.branch,
				to: target.sessionId,
				body,
				now: now(),
				ttlMs: input.ttlMs,
			});
			await writePeerMessage(joined.scope.registryDir, message);
		} catch (error) {
			return `Could not queue the message: ${(error as Error).message}`;
		}
		return [
			`Queued message ${message.id} for ${target.sessionId} (${target.cwd}${target.branch ? `, branch ${target.branch}` : ""}).`,
			`It is delivered by the recipient's own poller: at its next safe boundary if idle or busy, and after any pending human input. One peer message is released per turn. It expires at ${new Date(message.expiresAt).toISOString()}.`,
		].join("\n");
	};

	const deliver = (message: PeerMessage, state: Joined): void => {
		pi.sendMessage(
			{
				customType: PEER_MESSAGE_TYPE,
				content: formatPeerMessage(message),
				display: true,
				details: {
					version: WORKSPACE_VERSION,
					id: message.id,
					from: message.from,
					to: message.to,
					createdAt: message.createdAt,
					expiresAt: message.expiresAt,
				},
			},
			// Always steer *and* allow a turn. `isIdle()` sampled here can flip before
			// sendMessage runs; a steer without triggerTurn would then sit in an idle
			// session without waking it, and no turn_end would reset
			// `releasedThisTurn`. The docs ignore triggerTurn while streaming, so one
			// option set is correct in both states.
			{ deliverAs: "steer", triggerTurn: true },
		);
		deliveredIds.add(message.id);
	};

	const tick = async (): Promise<void> => {
		const state = joined;
		if (!state || shuttingDown || state.polling) return;
		state.polling = true;
		try {
			const read = await readInbox(state.scope.registryDir, state.sessionId, now());
			// A shutdown can land while the inbox read was in flight; do not deliver
			// into a session that is already gone.
			if (shuttingDown || joined !== state) return;
			for (const invalid of read.invalid.slice(0, 5)) {
				// An unusable file is reported once and removed; leaving it would
				// append the same warning every poll for the life of the session.
				await unlink(joinPath(inboxDir(state.scope.registryDir, state.sessionId), invalid)).catch(() => undefined);
				pi.appendEntry(PEER_MESSAGE_EXPIRED_TYPE, {
					version: WORKSPACE_VERSION,
					kind: "invalid",
					file: invalid,
					at: now(),
				});
			}
			for (const message of read.expired.slice(0, 5)) {
				await removePeerMessage(state.scope.registryDir, state.sessionId, message.id);
				pi.appendEntry(PEER_MESSAGE_EXPIRED_TYPE, {
					version: WORKSPACE_VERSION,
					kind: "expired",
					id: message.id,
					from: message.from,
					expiresAt: message.expiresAt,
					at: now(),
				});
				if (state.ctx.hasUI) {
					state.ctx.ui.notify(
						`Peer message ${message.id} from ${message.from.sessionId} expired before it could be delivered.`,
						"warning",
					);
				}
			}
			if (releasedThisTurn || read.live.length === 0) return;
			// A human prompt or queued input owns the next boundary. The message
			// waits rather than pre-empting it.
			if (humanPromptOpen) return;
			let pending = true;
			try {
				pending = state.ctx.hasPendingMessages();
			} catch {
				// Not knowing whether a human is waiting is a reason to wait, not to
				// pre-empt them.
			}
			if (pending) return;
			const next = read.live.find((message) => !deliveredIds.has(message.id));
			if (!next) return;
			if (state.ctx.signal?.aborted) return;
			deliver(next, state);
			releasedThisTurn = true;
			let marked = false;
			try {
				await markMessageDelivered(state.scope.registryDir, state.sessionId, next, now());
				marked = true;
			} catch {
				// Without the durable marker, remove the file only when a later read
				// cannot deliver it twice. The in-memory ledger covers this process;
				// keeping the file makes a crash at-most-once-but-retryable rather
				// than silently losing the message.
			}
			if (marked) await removePeerMessage(state.scope.registryDir, state.sessionId, next.id);
		} catch {
			// The poller is a convenience; a bad record must not kill it. The next
			// tick retries and the TTL bounds a permanently broken entry.
		} finally {
			state.polling = false;
		}
	};

	const guard = async (
		event: { toolName?: string; input?: unknown },
		ctx: ExtensionContext,
	): Promise<{ block: true; reason: string } | undefined> => {
		const tool = event.toolName;
		if (tool !== "write" && tool !== "edit") return undefined;
		if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;
		const scope = await scopeFor(ctx.cwd);
		if (!scope.ok) return undefined;
		const sessionId = sessionIdOf(ctx);
		let live: ReservationRecord[];
		try {
			live = (await liveReservations(scope.scope.registryDir, now())).live;
		} catch {
			return undefined; // fail open, never trap a write
		}
		if (live.length === 0) return undefined;
		const candidate = canonicalPath(ctx.cwd, event.input.path);
		const conflicts: { reservation: ReservationRecord; path: { pattern: string; kind: string } }[] = [];
		for (const reservation of live) {
			if (sessionId && reservation.sessionId === sessionId) continue;
			const path = reservation.paths.find((held) => reservationPathMatches(held, candidate));
			if (path) conflicts.push({ reservation, path });
		}
		if (conflicts.length === 0) return undefined;
		if (overrideArmed) {
			const used = overrideArmed;
			overrideArmed = null;
			pi.appendEntry(RESERVATION_OVERRIDE_ENTRY_TYPE, {
				version: WORKSPACE_VERSION,
				action: "use",
				reason: used.reason,
				sessionId,
				tool,
				path: candidate,
				holder: conflicts[0]!.reservation.sessionId,
				at: now(),
			});
			return undefined;
		}
		return { block: true, reason: reservationRefusal(tool, candidate, conflicts) };
	};

	// --- tools -------------------------------------------------------------

	pi.registerTool({
		name: WORKSPACE_TOOL,
		label: "Workspace presence",
		description:
			"See and announce this session in the repository-wide workspace shared by the main checkout and every linked worktree. Actions: join publishes a presence entry (pid, session, working directory, branch) and starts the heartbeat; leave removes it and releases this session's reservations; peers lists live sessions with their directory, branch and last-seen time. Joining is explicit: loading the extension writes nothing. The registry lives in the git common directory, never in the working tree. Outside a git repository the action is a no-op that says why.",
		promptSnippet: "Join, leave, or list peer sessions in this repository's shared workspace",
		promptGuidelines: [
			"Join the workspace before reserving paths or messaging peers; both require it.",
			"Use `orchestrator_workspace` action \"peers\" to find a peer's session id before messaging it.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("join"), Type.Literal("leave"), Type.Literal("peers")], {
				description: "join, leave, or peers",
			}),
			ttlSeconds: Type.Optional(
				Type.Number({ description: "Presence TTL for a join, in seconds (default 60, bounded 5–600)." }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = String(params.action ?? "");
			if (action === "join") {
				const ttlMs = typeof params.ttlSeconds === "number" ? clampPresenceTtl(params.ttlSeconds * 1000) : undefined;
				const text = await join(ctx, { ttlMs });
				return toolResult(text, { action, joined: joined !== null });
			}
			if (action === "leave") {
				const text = await leave(ctx);
				return toolResult(text, { action, joined: false });
			}
			if (action === "peers") {
				return toolResult(await peers(ctx), { action });
			}
			return toolResult(`Unknown action ${action}; use join, leave or peers.`, { action, ok: false });
		},
	});

	pi.registerTool({
		name: RESERVE_TOOL,
		label: "Workspace reservations",
		description:
			"Reserve a file, directory (trailing slash) or wildcard (`*` within a segment, `**` across) so another session's write or edit to it is refused before it runs, naming the holder and the reason. Advisory, not a security boundary: shell commands and nested tool execution are not prevented. Actions: reserve, release (one id or all of this session's), list, override (grant a one-shot override for the next refusal, recorded in the session). Reservations expire and are released on leave or shutdown. Requires a joined workspace.",
		promptSnippet: "Reserve workspace paths, release them, list reservations, or override one refusal",
		promptGuidelines: [
			"Reserve a path with a reason before a multi-step change another session could collide with.",
			"Use override only when the collision is expected, and say why: the reason is recorded.",
		],
		parameters: Type.Object({
			action: Type.Union([Type.Literal("reserve"), Type.Literal("release"), Type.Literal("list"), Type.Literal("override")], {
				description: "reserve, release, list, or override",
			}),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to reserve; a trailing slash means a directory, * and ** are wildcards." })),
			reason: Type.Optional(Type.String({ description: "Why the paths are reserved, or why an override is justified. Required for reserve and override." })),
			id: Type.Optional(Type.String({ description: "Reservation id for release; omit to release every reservation this session holds." })),
			ttlSeconds: Type.Optional(Type.Number({ description: "Reservation TTL in seconds (default 900, bounded 5–86400)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = String(params.action ?? "");
			if (action === "reserve") {
				const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
				const reason = String(params.reason ?? "");
				const ttlMs = typeof params.ttlSeconds === "number" ? clampReservationTtl(params.ttlSeconds * 1000) : undefined;
				return toolResult(await reserve(ctx, { paths, reason, ttlMs }), { action });
			}
			if (action === "release") {
				return toolResult(await release(ctx, typeof params.id === "string" ? params.id : undefined), { action });
			}
			if (action === "list") return toolResult(await listOwnReservations(ctx), { action });
			if (action === "override") return toolResult(await armOverride(ctx, String(params.reason ?? "")), { action });
			return toolResult(`Unknown action ${action}; use reserve, release, list or override.`, { action, ok: false });
		},
	});

	pi.registerTool({
		name: MESSAGE_TOOL,
		label: "Workspace message",
		description:
			"Send one targeted message to another live session in this repository's workspace. The recipient's own poller decides when it lands: an idle session is woken, a busy one is steered at its next safe boundary, and pending human input is never pre-empted. One peer message is released per turn, delivery is once per message id, and an undelivered message expires. A peer that left or expired is reported as gone. Requires a joined workspace; use `orchestrator_workspace` action \"peers\" for the id.",
		promptSnippet: "Send a targeted message to one peer pi session in this repository",
		promptGuidelines: [
			"Message a peer only for coordination another session needs now; the message appears in its session with your id and directory.",
			"Check live peers with `orchestrator_workspace` before messaging; a gone peer is reported, not queued.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient session id (an unambiguous prefix is accepted)." }),
			body: Type.String({ description: `Message body, at most ${MAX_MESSAGE_BODY_BYTES} bytes.` }),
			ttlSeconds: Type.Optional(Type.Number({ description: "How long an undelivered message stays valid, in seconds (default 600, bounded 5–3600)." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const ttlMs = typeof params.ttlSeconds === "number" ? clampMessageTtl(params.ttlSeconds * 1000) : undefined;
			return toolResult(await send(ctx, { to: String(params.to ?? ""), body: String(params.body ?? ""), ttlMs }), {});
		},
	});

	// --- session wiring ----------------------------------------------------

	pi.on("session_start", async () => {
		// A session_start without a preceding shutdown must not leak the old
		// heartbeat. Joining is explicit, so the new session starts unjoined and
		// writes nothing until it asks.
		await shutdown();
		shuttingDown = false;
		humanPromptOpen = false;
		releasedThisTurn = false;
		overrideArmed = null;
	});

	pi.on("session_shutdown", async () => {
		await shutdown();
	});

	pi.on("ui_prompt_start", async () => {
		humanPromptOpen = true;
	});
	pi.on("ui_prompt_end", async () => {
		humanPromptOpen = false;
	});
	pi.on("turn_end", async () => {
		releasedThisTurn = false;
	});

	pi.on("tool_call", async (event, ctx) => guard(event, ctx));

	const runtime: WorkspaceRuntime = {
		join,
		leave,
		peers,
		reserve,
		release,
		listReservations: listOwnReservations,
		armOverride,
		send,
		tick,
		checkToolCall: guard,
		isJoined: () => joined !== null,
		shutdown,
	};
	return runtime;
}

/** Remove a presence record without treating a missing file as a failure. */
async function writeJsonPresenceRemoval(registryDir: string, sessionId: string): Promise<void> {
	try {
		await unlink(presencePath(registryDir, sessionId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
