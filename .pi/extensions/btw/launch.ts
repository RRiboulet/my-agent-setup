// Pure launch core for the /btw side panel.
//
// A panel is a separate pi process running a fork of the main session in its
// own tmux session. `index.ts` owns the command, the guards and the side
// effects; this module owns everything that can be decided from its inputs
// alone — the scratch paths, the tool allowlist, the side-prompt text, the
// question validator, the child argv, the tmux argv and the shell command
// string — so the suite can pin them without a TTY or a tmux server.
//
// Two decisions here are load-bearing and explained at their definitions: the
// per-main-session socket (a shared server would let one panel's close unbind
// another panel's Escape) and the `-e` that loads back an extension-registered
// provider the child's `--no-extensions` would otherwise lose.

import * as path from "node:path";
import { shellQuote } from "../subagent/shell.ts";

/**
 * The side panel's tool allowlist: pi's read-only set.
 *
 * `--tools` replaces the registry rather than filtering at call time, so bash,
 * edit and write are never registered and the read-only guarantee does not
 * depend on the model obeying a prompt.
 */
export const BTW_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * The appendix written to `side-prompt.md` and passed to the child with
 * `--append-system-prompt`.
 *
 * The replayed-loadout bullet exists because a forked session carries the
 * parent's system messages and tool declarations (`toolsAdded`/`toolsRemoved`
 * are session entries). The child's registry holds only BTW_TOOLS, so without
 * that line the model sees bash/edit/write in its own context and can promise
 * work it has no way to do.
 */
export const BTW_SIDE_PROMPT = [
	"You are answering a side question in a BTW panel: a throwaway fork of the main conversation, shown in its own terminal panel.",
	"",
	"- Answer from the conversation above; it is the inherited context, and the user can ask follow-up questions here.",
	"- Nothing said here is added to the main conversation, and the user returns to it by pressing Escape.",
	"- Only read, grep, find and ls are available. There is no bash, edit or write: do not claim to change anything.",
	"- The transcript above may replay the main session's system sections and tool declarations (for example bash or edit). Those do not apply to you; only the tools actually available do.",
	"- If the context does not contain the answer, say what is missing instead of guessing.",
].join("\n");

/**
 * Refuse a relative path, with the reason in the message.
 *
 * tmux and the shell never expand `~`, so a caller that passes
 * `"~/.pi/agent"` would make the path literal and wrong. The guard catches
 * that at the builder instead of at a failed launch.
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
 * the run directory, and the guard keeps that from becoming exploitable if a
 * future caller ever takes the id from somewhere else.
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
 * A single shared socket would host several panels at once, and the popup's
 * Escape binding is global to the server that owns it (see
 * `../subagent/panel.ts`): the first panel to close would unbind Escape for
 * every other panel still open, and a rebind race could leave a new panel
 * bound to nothing. One socket per main session keeps the borrowed recipe
 * correct and scopes `kill-server` at session end to this session's panel.
 *
 * The name carries the FULL session id. pi mints ids with UUIDv7, whose
 * leading hex digits are a millisecond timestamp: two sessions started within
 * the same ~65 s window share their first 8 characters, so a shortened id
 * would collide on this socket and on the session name below. The full id
 * keeps the socket path well under the ~108-byte sun_path limit.
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

/**
 * The panel's scratch directory, keyed by the full session id and removed when
 * the session ends: the fork file inside it is a copy of the conversation and
 * must not outlive the panel.
 */
export function btwRunDir(agentDir: string, sessionId: string): string {
	return underAgentDir(agentDir, "btw", requireSessionId(sessionId));
}

/** The forked transcript the child opens with `--session`. */
export function btwForkPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "fork.jsonl");
}

/** The question, passed as `@question.md` so argv parsing never sees its text. */
export function btwQuestionPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "question.md");
}

/**
 * The system-prompt appendix, passed by path to `--append-system-prompt`.
 *
 * The file must exist before the child launches: pi treats a non-existent
 * `--append-system-prompt` value as literal text, so a missing file would
 * silently put this path in the system prompt instead of the instructions.
 */
export function btwSidePromptPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "side-prompt.md");
}

/** Every path one panel owns, derived from the agent dir and session id. */
export interface BtwPaths {
	socket: string;
	session: string;
	target: string;
	runDir: string;
	fork: string;
	question: string;
	sidePrompt: string;
}

/** Build the path set once, so a caller never mixes a short and a full id. */
export function buildBtwPaths(agentDir: string, sessionId: string): BtwPaths {
	return {
		socket: btwSocketPath(agentDir, sessionId),
		session: btwSessionName(sessionId),
		target: btwTarget(sessionId),
		runDir: btwRunDir(agentDir, sessionId),
		fork: btwForkPath(agentDir, sessionId),
		question: btwQuestionPath(agentDir, sessionId),
		sidePrompt: btwSidePromptPath(agentDir, sessionId),
	};
}

/**
 * The question, trimmed, or a refusal.
 *
 * An empty question is a silent failure, not a cosmetic one: it would be
 * written to `question.md` and passed as `@question.md`, and pi skips an empty
 * file, so the child would open with no prompt at all and the panel would look
 * broken rather than idle.
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
 * Providers that exist only because an extension registers them, mapped to
 * that extension's entry point relative to this directory.
 *
 * The child runs with `--no-extensions` so it cannot recurse into `/btw` and
 * carries no project code; that flag also disables extension-registered
 * providers (`pi --no-extensions --provider opencode-go --list-models` matches
 * nothing). Explicit `-e` paths survive `--no-extensions`, so a provider
 * listed here is loaded back in. Core providers (anthropic, openai, …) do not
 * belong here.
 *
 * A provider missing from this table is not loaded, and the child then dies at
 * model resolution; `remain-on-exit` keeps the failure visible, but the panel
 * is dead. Add an entry when a second extension-registered provider appears.
 */
const PROVIDER_EXTENSIONS: Readonly<Record<string, string>> = {
	"opencode-go": "../opencode-go-provider/index.ts",
};

/** The absolute entry point for an extension-registered provider, if any. */
export function providerExtensionPath(provider: string, btwDir: string): string | undefined {
	const relative = PROVIDER_EXTENSIONS[provider];
	return relative === undefined
		? undefined
		: path.resolve(requireAbsolute(btwDir, "extension directory"), relative);
}

export interface BtwChildPiSpec {
	/** How to start pi; see `getPiInvocationParts` in `../subagent/handoff.ts`. */
	invocation: string[];
	provider: string;
	model: string;
	/** Omitted when the main session has no explicit thinking level. */
	thinking: string | undefined;
	/** Absolute path to the forked session file. */
	sessionFile: string;
	/** Absolute path to the rendered question, appended as `@file`. */
	questionPath: string;
	/** Absolute path to the system-prompt appendix. */
	sidePromptPath: string;
	/** This extension's directory; resolves an extension-registered provider. */
	btwDir: string;
	/** The child session's display name, e.g. `btw-<sid8>`. */
	name: string;
}

/**
 * The child pi argv.
 *
 * `--no-approve` declines project trust, so trust-gated project config and
 * resources (settings, extensions, context files) never load; the panel's
 * read-only tools can still read project files, by design. The rest of the
 * `--no-*` flags leave the child's context to the fork plus the side prompt:
 * no skills, prompts, context files or MCP servers. `--tools` is an allowlist,
 * so BTW_TOOLS is the whole registry.
 *
 * The question travels as `@<file>`, never as text: a question starting with
 * `-` would otherwise be parsed as a flag, and one starting with `@` as an
 * include.
 */
export function buildBtwChildPiArgs(spec: BtwChildPiSpec): string[] {
	const providerExtension = providerExtensionPath(spec.provider, spec.btwDir);
	return [
		...spec.invocation,
		...(providerExtension === undefined ? [] : ["-e", providerExtension]),
		"--provider",
		spec.provider,
		"--model",
		spec.model,
		...(spec.thinking === undefined ? [] : ["--thinking", spec.thinking]),
		"--session",
		spec.sessionFile,
		"--name",
		spec.name,
		"--no-approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-mcp",
		"--tools",
		BTW_TOOLS.join(","),
		"--append-system-prompt",
		spec.sidePromptPath,
		`@${spec.questionPath}`,
	];
}

/**
 * `tmux new-session` for the panel: detached, named, in the main session's
 * working directory so the child's relative reads match the fork's header.
 */
export function buildBtwSessionCreateArgs(input: { socket: string; session: string; cwd: string }): string[] {
	return ["-S", input.socket, "new-session", "-d", "-s", input.session, "-n", "btw", "-c", input.cwd];
}

/**
 * Keep the pane visible after the child exits, so a crash can be read instead
 * of the panel vanishing; liveness is `has-session` plus `#{pane_dead}`.
 *
 * The target is the session, not `<session>:0`: a fresh server reads the
 * user's tmux config, where `base-index` can make the first window non-zero.
 */
export function buildBtwRemainOnExitArgs(input: { socket: string; session: string }): string[] {
	return ["-S", input.socket, "set-window-option", "-t", input.session, "remain-on-exit", "on"];
}

/**
 * Kill this panel's tmux session.
 *
 * Used before a replace and on shutdown; a missing session exits non-zero, so
 * callers ignore the result. Kept separate from the create builder because the
 * pair is the whole reset, and `btw.test.ts` pins their order.
 */
export function buildBtwKillSessionArgs(input: { socket: string; session: string }): string[] {
	return ["-S", input.socket, "kill-session", "-t", input.session];
}

/**
 * Type the child command into the pane.
 *
 * `-l` sends the bytes literally (no key-name lookup) and `--` ends option
 * parsing, so a command starting with `-` cannot become a flag. The Enter is a
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
 * The shell command typed into the pane.
 *
 * `exec` matters: without it the pane's shell outlives the child pi, so
 * `#{pane_dead}` never becomes 1 and `/btw` with no arguments would reattach
 * to a dead prompt forever. Every argv element is quoted because tmux hands
 * this string to a shell, not to exec.
 */
export function buildBtwChildCommand(piArgs: string[]): string {
	return ["exec", ...piArgs.map((argument) => shellQuote(argument))].join(" ");
}
