// Pure launch core for the /btw panel.
//
// A panel is a viewer process in its own tmux session on a per-main-session
// socket. The answer itself is produced in-process by the parent (`request.ts`)
// and written to `answer.md`, which the viewer follows; `index.ts` owns the
// effects, and this module owns everything decidable from its inputs — the
// paths, the tmux argv and the viewer command — so the suite can pin them
// without a TTY or a tmux server.

import * as path from "node:path";
import { shellQuote } from "../subagent/shell.ts";

/**
 * Refuse a relative path, with the reason in the message.
 *
 * tmux and the shell never expand `~`, so a caller that passes
 * `"~/.pi/agent"` would make the path literal and wrong.
 */
function requireAbsolute(value: string, label: string): string {
	if (!path.isAbsolute(value)) {
		throw new Error(`btw needs an absolute ${label}, got ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * A session id must be a single, non-dot path component.
 *
 * pi validates its own ids to `[A-Za-z0-9._-]` with alphanumeric ends, but
 * these builders take whatever a caller passes: a `..` or a `/` would escape
 * the run directory.
 */
function requireSessionId(sessionId: string): string {
	if (!sessionId || sessionId !== path.basename(sessionId) || sessionId === "." || sessionId === "..") {
		throw new Error(`btw needs a session id that is one path component, got ${JSON.stringify(sessionId)}`);
	}
	return sessionId;
}

/** Join under the agent dir, refusing a relative one. */
function underAgentDir(agentDir: string, ...parts: string[]): string {
	return path.join(requireAbsolute(agentDir, "agent directory"), ...parts);
}

/**
 * The panel's tmux socket: one server per main session.
 *
 * A shared socket would host several panels at once, and the popup's Escape
 * binding is global to the server that owns it (see `../subagent/panel.ts`):
 * the first panel to close would unbind Escape for every other panel still
 * open. One socket per main session keeps the borrowed recipe correct and
 * scopes `kill-server` at session end to this session's panel.
 *
 * The name carries the FULL session id. pi mints ids with UUIDv7, whose leading
 * hex digits are a millisecond timestamp: two sessions started within the same
 * ~65 s window share their first 8 characters, so a shortened id would collide
 * on this socket and on the session name below.
 */
export function btwSocketPath(agentDir: string, sessionId: string): string {
	return underAgentDir(agentDir, `tmux-btw-${requireSessionId(sessionId)}.sock`);
}

/** The tmux session name on that socket; full id for the same reason. */
export function btwSessionName(sessionId: string): string {
	return `btw-${requireSessionId(sessionId)}`;
}

/**
 * The target every send-keys or capture call addresses.
 *
 * A session target resolves to its active pane, which is the only pane in a
 * one-window panel. This deliberately avoids `:0.0`: a fresh tmux server reads
 * `~/.tmux.conf`, and with `base-index`/`pane-base-index` configured the first
 * window or pane is not index zero.
 */
export function btwTarget(sessionId: string): string {
	return btwSessionName(sessionId);
}

/** The directory holding every panel's scratch dir. */
export function btwRootDir(agentDir: string): string {
	return underAgentDir(agentDir, "btw");
}

/**
 * The panel's scratch directory, keyed by the full session id and removed when
 * the session ends.
 */
export function btwRunDir(agentDir: string, sessionId: string): string {
	return underAgentDir(agentDir, "btw", requireSessionId(sessionId));
}

/** The Markdown file the parent appends to and the viewer follows. */
export function btwAnswerPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "answer.md");
}

/** The main pi process that owns the panel; a dead pid makes the panel reapable. */
export function btwOwnerPidPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "owner.pid");
}

/** Every path one panel owns, derived from the agent dir and session id. */
export interface BtwPaths {
	socket: string;
	session: string;
	target: string;
	runDir: string;
	answer: string;
	ownerPid: string;
}

/** Build the path set once, so a caller never mixes a short and a full id. */
export function buildBtwPaths(agentDir: string, sessionId: string): BtwPaths {
	return {
		socket: btwSocketPath(agentDir, sessionId),
		session: btwSessionName(sessionId),
		target: btwTarget(sessionId),
		runDir: btwRunDir(agentDir, sessionId),
		answer: btwAnswerPath(agentDir, sessionId),
		ownerPid: btwOwnerPidPath(agentDir, sessionId),
	};
}

/**
 * The question, trimmed, or a refusal.
 *
 * An empty question would open a panel that asks nothing and streams a
 * pointless answer, so it is refused before any side effect.
 */
export function requireBtwQuestion(raw: string): string {
	const question = raw.trim();
	if (!question) {
		throw new Error("A /btw question cannot be empty.");
	}
	if (question.includes("\u0000")) {
		throw new Error("A /btw question cannot contain a NUL byte.");
	}
	return question;
}

/**
 * Kill the panel's tmux server.
 *
 * The socket is per main session, so the server holds exactly this panel:
 * `kill-server` cannot leave a live session behind. A missing server exits
 * non-zero, which callers ignore.
 */
export function buildBtwKillServerArgs(input: { socket: string }): string[] {
	return ["-S", input.socket, "kill-server"];
}

/**
 * `tmux new-session` for the viewer: detached, named, in the main session's
 * working directory.
 */
export function buildBtwSessionCreateArgs(input: { socket: string; session: string; cwd: string }): string[] {
	return ["-S", input.socket, "new-session", "-d", "-s", input.session, "-n", "btw", "-c", input.cwd];
}

/**
 * Keep the pane visible after the viewer exits, so a crash can be read instead
 * of the panel vanishing; liveness is `has-session` plus `#{pane_dead}`.
 */
export function buildBtwRemainOnExitArgs(input: { socket: string; session: string }): string[] {
	return ["-S", input.socket, "set-window-option", "-t", input.session, "remain-on-exit", "on"];
}

/**
 * Type a command into the viewer pane.
 *
 * `-l` sends the bytes literally and `--` ends option parsing. The Enter is a
 * separate call because `-l` would type the word "Enter" as text.
 */
export function buildBtwSendKeysArgs(input: { socket: string; target: string; command: string }): string[] {
	return ["-S", input.socket, "send-keys", "-t", input.target, "-l", "--", input.command];
}

/** The second half of the launch: submit the command typed above. */
export function buildBtwSubmitArgs(input: { socket: string; target: string }): string[] {
	return ["-S", input.socket, "send-keys", "-t", input.target, "Enter"];
}

/**
 * The command the viewer pane runs: follow the answer file as the parent
 * appends to it. `Ctrl+C` stops following for normal paging; `q` exits. `--`
 * keeps a path starting with `-` from becoming an option, and `exec` replaces
 * the shell so `#{pane_dead}` flips when the pager exits.
 */
export function buildBtwViewerCommand(answerPath: string): string {
	return `exec less +F -- ${shellQuote(answerPath)}`;
}
