/**
 * The pi-facing half of workspace presence.
 *
 * `workspace.ts` owns the store and the records; this file owns the session: the
 * join/leave/list tool, the heartbeat and every timer's lifetime. Keeping the
 * two apart is what lets the store be tested against real temporary
 * repositories without a pi host.
 *
 * Two rules this file exists to keep:
 *
 *   - **Joining is explicit.** Loading the extension starts no timer and writes
 *     nothing. A session joins through `orchestrator_workspace`, which is the
 *     only path that starts the heartbeat.
 *   - **No timer outlives the session.** The interval is `unref`'d, held in one
 *     place, and cleared by `session_shutdown`, which also removes the presence
 *     entry. The subagent watcher already paid for this lesson in a different
 *     timer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { unlink } from "node:fs/promises";

import {
	DEFAULT_PRESENCE_TTL_MS,
	buildPresence,
	clampPresenceTtl,
	listPresence,
	presenceHeartbeatMs,
	presencePath,
	resolveWorkspaceScope,
	touchPresence,
	writePresence,
	type GitRun,
	type PresenceRecord,
	type ScopeResult,
	type WorkspaceScope,
} from "./workspace.ts";

export const WORKSPACE_TOOL = "orchestrator_workspace";

export interface WorkspaceRuntimeOptions {
	/** `pi.exec` in production; a real-git double in tests. */
	run?: GitRun;
	now?: () => number;
	/** Presence TTL for a join that does not name one. */
	presenceTtlMs?: number;
	/** Heartbeat period; defaults to a third of the TTL. */
	heartbeatMs?: number;
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
	heartbeatInFlight: boolean;
}

export interface WorkspaceRuntime {
	join(ctx: ExtensionContext, options?: { ttlMs?: number }): Promise<string>;
	leave(ctx?: ExtensionContext): Promise<string>;
	peers(ctx: ExtensionContext): Promise<string>;
	/** For tests and `/workspace`: whether this runtime is joined. */
	isJoined(): boolean;
	shutdown(): Promise<void>;
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

export function registerWorkspace(pi: ExtensionAPI, options: WorkspaceRuntimeOptions = {}): WorkspaceRuntime {
	const now = options.now ?? Date.now;
	const presenceTtlMs = clampPresenceTtl(options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS);
	const heartbeatMs = options.heartbeatMs ?? Math.round(presenceTtlMs / 3);
	const touch = options.touch ?? touchPresence;
	/**
	 * A join's TTL and its beat must agree. A `ttlSeconds` below the default
	 * would otherwise expire the record between beats — and a peer's sweep then
	 * deletes it — so a live session flickers out of every peer list.
	 */
	const heartbeatFor = (ttlMs: number): number => presenceHeartbeatMs(ttlMs, heartbeatMs);
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
		// Cache a settled answer, never a rejected promise: one failing git call
		// would otherwise poison every later peers/list call for the session.
		const pending = resolveWorkspaceScope(cwd, run).catch((error: unknown) => ({
			ok: false as const,
			reason: `git failed: ${error instanceof Error ? error.message : String(error)}`,
		}));
		scopes.set(cwd, pending);
		return pending;
	};

	let joined: Joined | null = null;
	let shuttingDown = false;

	const clearHeartbeat = (state: Joined): void => {
		if (state.heartbeat) {
			clearInterval(state.heartbeat);
			state.heartbeat = null;
		}
	};

	const shutdown = async (): Promise<void> => {
		shuttingDown = true;
		if (!joined) return;
		const state = joined;
		joined = null;
		clearHeartbeat(state);
		try {
			await writeJsonPresenceRemoval(state.scope.registryDir, state.sessionId);
		} catch {
			// A failed leave is bounded by the presence TTL. Shutdown must not hang.
		}
	};

	const startHeartbeat = (state: Joined): void => {
		const heartbeat = setInterval(() => {
			if (shuttingDown || state.heartbeatInFlight) return;
			state.heartbeatInFlight = true;
			void touch(state.scope.registryDir, state.record, now())
				.then(async (next) => {
					// A leave/shutdown that raced this write must not be undone by it.
					// The record the beat just recreated is removed again, unless a new
					// join for this session is already the authority.
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
	};

	const join = async (ctx: ExtensionContext, joinOptions: { ttlMs?: number } = {}): Promise<string> => {
		const sessionId = sessionIdOf(ctx);
		if (!sessionId) return "This host exposed no session id, so the workspace cannot publish a presence entry.";
		if (joined) {
			if (joinOptions.ttlMs !== undefined) {
				joined.record = { ...joined.record, ttlMs: clampPresenceTtl(joinOptions.ttlMs) };
				const nextBeat = heartbeatFor(joined.record.ttlMs);
				if (nextBeat !== joined.heartbeatMs) {
					clearHeartbeat(joined);
					joined.heartbeatMs = nextBeat;
					startHeartbeat(joined);
				}
			}
			joined.record = await touch(joined.scope.registryDir, joined.record, now());
			const peers = await listPresence(joined.scope.registryDir, now());
			return `Already joined ${joined.scope.registryDir} as ${sessionId}.\n${peerSummary(peers.peers, now(), sessionId)}`;
		}
		const scope = await scopeFor(ctx.cwd, true);
		if (!scope.ok) {
			return `Workspace not joined: ${scope.reason}. Presence is a no-op outside a git repository.`;
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
			heartbeatInFlight: false,
		};
		joined = state;
		shuttingDown = false;
		startHeartbeat(state);
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
		if (!joined) return "This session is not joined to a workspace.";
		const state = joined;
		joined = null;
		clearHeartbeat(state);
		try {
			await writeJsonPresenceRemoval(state.scope.registryDir, state.sessionId);
		} catch (error) {
			return `Left the workspace in memory, but could not remove the presence record (${(error as Error).message}). It expires within its TTL.`;
		}
		const ctxId = ctx ? sessionIdOf(ctx) : state.sessionId;
		if (ctxId && ctxId !== state.sessionId) {
			return `Left the workspace as ${state.sessionId}; this context belongs to ${ctxId}, which was not joined.`;
		}
		return `Left the workspace as ${state.sessionId}; presence removed.`;
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

	pi.registerTool({
		name: WORKSPACE_TOOL,
		label: "Workspace presence",
		description:
			"See and announce this session in the repository-wide workspace shared by the main checkout and every linked worktree. Actions: join publishes a presence entry (pid, session, working directory, branch) and starts the heartbeat; leave removes it; peers lists live sessions with their directory, branch and last-seen time. Joining is explicit: loading the extension writes nothing. The registry lives in the git common directory, never in the working tree. Outside a git repository the action is a no-op that says why.",
		promptSnippet: "Join, leave, or list peer sessions in this repository's shared workspace",
		promptGuidelines: [
			"Join the workspace to publish this session's presence; `leave` removes it.",
			"Use `orchestrator_workspace` action \"peers\" to see which sessions are live in this repository.",
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

	pi.on("session_start", async () => {
		// A session_start without a preceding shutdown must not leak the old
		// heartbeat. Joining is explicit, so the new session starts unjoined.
		await shutdown();
		shuttingDown = false;
	});

	pi.on("session_shutdown", async () => {
		await shutdown();
	});

	const runtime: WorkspaceRuntime = {
		join,
		leave,
		peers,
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
