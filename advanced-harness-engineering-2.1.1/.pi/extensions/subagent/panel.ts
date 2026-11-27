// Pure builders for the click-to-open subagent panel, reused by the btw side
// panel.
//
// Clicking a live-subagent row in the status widget is meant to open a tmux
// popup (drawn over pi's client, on the outer server) that runs a nested
// `tmux attach` client against the subagent server. Opening a terminal, a
// nested tmux client and a tmux format string is exactly the kind of work that
// cannot be exercised in the unit suite, so everything that CAN be pure — the
// argv, the nested command string and the quoting — is built here and asserted
// by `panel.test.ts`. `index.ts` holds the guard ladder and popup.ts the
// `pi.exec` probe and the detached `spawn` (see `openSubagentPanel`, local patch
// 17); this module stays pure and side-effect-free.
//
// The btw extension reuses these builders for its own panel, passing
// `titlePrefix: "btw"` and, when it has one, the question it is answering as
// `titleSuffix`; nothing else in the argv varies between the callers.

import { shellQuote } from "./shell.ts";

/**
 * How much of a title suffix to keep. The popup is 90% of the client's width,
 * and the suffix follows a prefix and an id; forty characters is enough to
 * recognise the question in a border without crowding the rest of the title.
 */
const TITLE_SUFFIX_MAX = 40;

/** A detached command: the binary and the argv to hand it. */
export interface Launch {
	command: string;
	args: string[];
}

/**
 * tmux argv for the idempotent Escape binding on the subagent server.
 *
 * `-n` makes it a root-table binding, so Escape reaches the server's key table
 * without the prefix; it is set directly on the server that owns the panel's
 * session. `bind` (not `set -g`) keeps it a no-op if applied twice, and
 * `detach-client` runs in the context of the client that pressed the key — the
 * popup client — so it closes the panel, not pi.
 */
export function buildEscapeBindArgs(socket: string): string[] {
	return ["-S", socket, "bind", "-n", "Escape", "detach-client"];
}

/**
 * The nested attach command run *inside* the popup.
 *
 * The popup inherits pi's environment, including `TMUX` (the outer server) and
 * `TMUX_PANE` (pi's pane). A nested tmux client refuses to start while `TMUX`
 * is set and is confused by `TMUX_PANE` from a different server, so both are
 * unset — the same pair `attachToSubagentAndExit` clears. Socket and session
 * are shell-quoted because this string is parsed by `/bin/sh`, not exec'd as
 * argv.
 */
export function buildAttachCommand(socket: string, session: string): string {
	return `env -u TMUX -u TMUX_PANE tmux -S ${shellQuote(socket)} attach -t ${shellQuote(session)}`;
}

/**
 * The command the popup runs: attach to the subagent session, then remove the
 * Escape binding on the way out.
 *
 * The binding is in the subagent server's ROOT table, so it is global to that
 * server, not to the popup's client: left in place it swallows Escape for every
 * client of that server for the life of the server, including a direct
 * `pi --attach-subagent` session, where Escape is an ordinary key. `display-popup
 * -E` runs this through `/bin/sh -c`, so the unbind is a second command in the
 * same string; it runs when the attach client exits, which the Escape binding
 * itself causes.
 */
export function buildPopupCommand(socket: string, session: string): string {
	return `${buildAttachCommand(socket, session)}; tmux -S ${shellQuote(socket)} unbind -n Escape`;
}

/**
 * The panel's title: `<titlePrefix> <id8> [<titleSuffix>]`, the prefix naming
 * the owning extension (`subagent` by default, `btw` for the side-panel
 * extension).
 *
 * The id half is derived, never task text, because tmux renders `-T` as a
 * *format string*: `#` starts an expansion (including `#(...)` shell commands),
 * so an arbitrary title would be executed or mangled rather than shown. The
 * prefix is a literal the caller owns, and the `#` check below covers the
 * composed title, so neither half can smuggle a metacharacter in.
 *
 * Deriving from a run id is not sufficient on its own: `runId` is a plain
 * string, and today's `randomUUID()` producers are a convention, not a type.
 * The `#` check is what actually enforces the invariant, at the one point the
 * title is composed. Its message deliberately omits the run id so an untrusted
 * value is never echoed into a log or notification.
 *
 * `titleSuffix` is the exception to the derived-only rule: the caller owns it
 * and passes text worth showing (the btw question). It is sanitized before it
 * reaches the composed title — one line, no `#`, truncated — because the
 * format-string rules apply to it exactly as to the rest.
 */
function panelTitle(input: { runId: string; titlePrefix: string; titleSuffix?: string }): string {
	const head = `${input.titlePrefix} ${input.runId.slice(0, 8)}`;
	const title = input.titleSuffix ? `${head} ${input.titleSuffix}` : head;
	if (title.includes("#")) {
		throw new TypeError("refusing to build a panel title containing '#' (a tmux format metacharacter)");
	}
	return title;
}

/**
 * The detached tmux CLI that draws the popup over pi's client.
 *
 * `-c` names the client to draw over. `-t <pane>` alone is NOT enough: tmux
 * resolves the client context to the most recently active client on the whole
 * server, so on a server with a second attached terminal the popup can land
 * there instead of over pi. `-E` closes it when the nested command exits;
 * `-w`/`-h` size it relative to the client. The attach command is one argv
 * element, so exactly one layer parses it as shell (tmux's own `sh -c`), which
 * is the layer the builders quote for.
 */
export function buildPanelLaunch(input: {
	outerSocket: string;
	pane: string;
	client: string;
	socket: string;
	session: string;
	/** The full run id; the title is derived from its first 8 characters. */
	runId: string;
	/**
	 * Names the owning extension in the popup title. Defaults to `subagent`;
	 * the btw extension passes `btw`. A blank value falls back to the default
	 * rather than composing a title with a leading space.
	 */
	titlePrefix?: string;
	/**
	 * Appended to the title after the run id, sanitized: one line, no `#`,
	 * truncated. The btw extension passes the question, so the popup shows what
	 * the panel is answering.
	 */
	titleSuffix?: string;
}): Launch {
	return {
		command: "tmux",
		args: [
			"-S",
			input.outerSocket,
			"display-popup",
			"-E",
			"-c",
			input.client,
			"-t",
			input.pane,
			"-w",
			"90%",
			"-h",
			"90%",
			"-T",
			panelTitle({
				runId: input.runId,
				titlePrefix: input.titlePrefix?.trim() || "subagent",
				titleSuffix: sanitizeTitleSuffix(input.titleSuffix),
			}),
			buildPopupCommand(input.socket, input.session),
		],
	};
}

/**
 * One line, no `#`, no control characters, truncated: the popup title is a
 * tmux format string drawn in a terminal, so both layers get a say in what
 * may travel. The control ranges follow the answer text's sanitizer, adapted
 * to a title: whitespace is collapsed rather than dropped, so a multi-line
 * question still reads as one, and a split escape loses its introducer and
 * stays inert text. The question is another string a user can paste anything
 * into, so the sanitizer is a boundary, not a formality.
 *
 * Truncation counts code points, not UTF-16 units: slicing units at the
 * boundary would leave half a surrogate pair, which travels to tmux as U+FFFD.
 */
function sanitizeTitleSuffix(suffix: string | undefined): string | undefined {
	if (suffix === undefined) return undefined;
	const oneLine = suffix
		.replace(/#/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.trim();
	if (!oneLine) return undefined;
	const characters = [...oneLine];
	return characters.length > TITLE_SUFFIX_MAX
		? `${characters.slice(0, TITLE_SUFFIX_MAX - 1).join("").trimEnd()}…`
		: oneLine;
}
