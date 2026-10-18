// Pure launch core for the /btw side panel.
//
// A panel is a separate pi process running a fork of the main session in its
// own tmux session. `index.ts` owns the command, the guards and the side
// effects; this module owns everything that can be decided from its inputs
// alone — the scratch paths, the child argv, the tmux argv and the shell
// command string — so the suite can pin them without a TTY or a tmux server.
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

/** First 8 characters of a session id, the panel's stable short key. */
function shortId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

/**
 * Join under the agent dir, refusing a relative one.
 *
 * tmux and the shell never expand `~`, so a caller that passes
 * `"~/.pi/agent"` would make every path here literal and wrong. The guard
 * catches that at the builder instead of at a failed launch.
 */
function underAgentDir(agentDir: string, ...parts: string[]): string {
	if (!path.isAbsolute(agentDir)) {
		throw new Error(`btw needs an absolute agent directory, got ${JSON.stringify(agentDir)}`);
	}
	return path.join(agentDir, ...parts);
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
 */
export function btwSocketPath(agentDir: string, sessionId: string): string {
	return underAgentDir(agentDir, `tmux-btw-${shortId(sessionId)}.sock`);
}

/** The tmux session name on that socket. */
export function btwSessionName(sessionId: string): string {
	return `btw-${shortId(sessionId)}`;
}

/** The pane every send-keys call addresses. */
export function btwTarget(sessionId: string): string {
	return `${btwSessionName(sessionId)}:0.0`;
}

/**
 * The panel's scratch directory, keyed by the full session id and removed when
 * the session ends: the fork file inside it is a copy of the conversation and
 * must not outlive the panel.
 */
export function btwRunDir(agentDir: string, sessionId: string): string {
	return underAgentDir(agentDir, "btw", sessionId);
}

/** The forked transcript the child opens with `--session`. */
export function btwForkPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "fork.jsonl");
}

/** The question, passed as `@question.md` so argv parsing never sees its text. */
export function btwQuestionPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "question.md");
}

/** The system-prompt appendix, passed by path to `--append-system-prompt`. */
export function btwSidePromptPath(agentDir: string, sessionId: string): string {
	return path.join(btwRunDir(agentDir, sessionId), "side-prompt.md");
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
 */
const PROVIDER_EXTENSIONS: Readonly<Record<string, string>> = {
	"opencode-go": "../opencode-go-provider/index.ts",
};

/** The absolute entry point for an extension-registered provider, if any. */
export function providerExtensionPath(provider: string, btwDir: string): string | undefined {
	const relative = PROVIDER_EXTENSIONS[provider];
	return relative === undefined ? undefined : path.resolve(btwDir, relative);
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
 * `--no-approve` keeps project-local files out of a panel that has no business
 * acting on the project, and the rest of the `--no-*` flags keep the child's
 * context to the fork plus the side prompt: no skills, prompts, context files
 * or MCP servers. `--tools` is an allowlist, so BTW_TOOLS is the whole
 * registry.
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
 */
export function buildBtwRemainOnExitArgs(input: { socket: string; session: string }): string[] {
	return ["-S", input.socket, "set-window-option", "-t", `${input.session}:0`, "remain-on-exit", "on"];
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
