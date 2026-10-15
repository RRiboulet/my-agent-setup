// Pure builders for the click-to-open subagent panel.
//
// Clicking a live-subagent row in the status widget opens a tmux popup (drawn
// over pi's client, on the outer server) that runs a nested `tmux attach`
// client against the subagent server. Opening a terminal, a nested tmux
// client and a tmux format string is exactly the kind of work that cannot be
// exercised in the unit suite, so everything that CAN be pure — the argv, the
// nested command string and the quoting — is built here and asserted by
// `panel.test.ts`. `index.ts` is left with the guards, the `pi.exec` calls and
// the `spawn`, which the tests drive through a fake.
//
// See /tmp/subagent-panel-plan.md §3.3 for the design this implements.

import { shellQuote } from "./shell.ts";

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
 * The panel's title, derived from a run id.
 *
 * `subagent <id8>` is deliberately literal text from a UUID: tmux renders `-T`
 * as a *format string*, so a title containing `#` or `%` would be expanded
 * (including `#(...)` shell commands) rather than shown. Task text is
 * untrusted and never becomes the title.
 */
export function buildPanelTitle(runId: string): string {
	return `subagent ${runId.slice(0, 8)}`;
}

/**
 * The detached tmux CLI that draws the popup over pi's client.
 *
 * `-t` pins the popup to pi's pane; `-E` closes it when the nested command
 * exits; `-w`/`-h` size it relative to the client. The title is validated
 * rather than escaped: it is a format string, and the only intended source is
 * `buildPanelTitle`, so a caller passing format metacharacters is a bug worth
 * failing on at the boundary (build time and test time) rather than silently
 * expanding untrusted text in the user's terminal.
 */
export function buildPanelLaunch(input: {
	outerSocket: string;
	pane: string;
	socket: string;
	session: string;
	title: string;
}): Launch {
	if (/[#%]/.test(input.title)) {
		throw new TypeError(`panel title must not contain '#' or '%' (it is a tmux format string): ${input.title}`);
	}
	return {
		command: "tmux",
		args: [
			"-S",
			input.outerSocket,
			"display-popup",
			"-E",
			"-t",
			input.pane,
			"-w",
			"90%",
			"-h",
			"90%",
			"-T",
			input.title,
			buildAttachCommand(input.socket, input.session),
		],
	};
}
