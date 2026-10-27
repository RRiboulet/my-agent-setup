// The effectful half of the click-to-open popup, shared by the subagent
// extension and by `/btw`.
//
// `panel.ts` builds the argv and the quoting and stays pure; `openSubagentPanel`
// (in `index.ts`) and `openBtwPopup` (in `btw/index.ts`) hold their own guard
// ladders, because those ladders are not the same: the subagent one admits a
// run that still shows a pane, refuses to run from inside a subagent pane, and
// reports through the status widget, while `/btw` has no run record, passes a
// timeout to every probe and phrases every fallback around its own attach
// command. What they DID copy verbatim — the launcher, the `TMUX` socket helper
// and the window/client resolution — lives here. The differences that remain
// are parameters (`timeoutMs`, the launcher binding), not branches merged into
// one blob.

import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How the popup CLI is started, injectable so tests never spawn one. */
export type PanelLauncher = (
	command: string,
	args: string[],
	options: { detached: true; stdio: "ignore" },
	onError: (message: string) => void,
) => void;

/**
 * Start the popup detached, so pi neither waits for it nor is kept alive by it,
 * and report a spawn failure through the callback. A spawn error is the only
 * failure this can report: once tmux is running, a display-popup failure exits
 * in an unobserved process.
 */
export const defaultPanelLauncher: PanelLauncher = (command, args, options, onError) => {
	const child = spawn(command, args, options);
	child.once("error", (error) => onError(error instanceof Error ? error.message : String(error)));
	child.unref();
};

/** The `TMUX` env var's socket component, when this process runs under tmux. */
export function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

/**
 * The client the popup has to draw over, or why there is none.
 *
 * The two failure kinds are separate because the callers say different things
 * about them: a vanished pane means the click's target is gone, while no client
 * means the popup would have nowhere to appear. A failed `list-clients` is
 * folded into `no-client` — at this point the two are indistinguishable to the
 * caller and both mean "do not launch".
 */
export type PaneClient = { kind: "client"; client: string } | { kind: "pane-gone" } | { kind: "no-client" };

/**
 * Resolve the outermost client to draw the popup over.
 *
 * `display-message -t <pane>` names the window the pane is in. Then EVERY
 * client is listed and filtered by that window: `list-clients -t <session>` is
 * not enough, because a grouped session linked to the same window makes the
 * pane's `#{session_name}` resolve to a session whose clients are not the ones
 * viewing the pane — the client looking straight at it would be missed
 * entirely. Among the clients on that window, the most recently active one
 * wins: the tap that fired the handler updated its own client's activity, so
 * that is usually the clicked client; `client_activity` is whole seconds,
 * though, so a same-second tie falls back to tmux's own client order. Best
 * effort, not a guarantee that the clicked client wins.
 *
 * `timeoutMs` bounds each probe where the caller needs it (`/btw` bounds every
 * tmux call); the subagent ladder passes none, as it always has.
 */
export async function resolvePaneClient(
	exec: ExtensionAPI["exec"],
	outerSocket: string,
	outerPane: string,
	options: { timeoutMs?: number } = {},
): Promise<PaneClient> {
	const probe = options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs };
	const target = await exec(
		"tmux",
		["-S", outerSocket, "display-message", "-p", "-t", outerPane, "#{window_id}"],
		probe,
	);
	const outerWindow = target.stdout.trim();
	if (target.code !== 0 || !outerWindow) return { kind: "pane-gone" };

	const clients = await exec(
		"tmux",
		["-S", outerSocket, "list-clients", "-F", "#{client_tty}\t#{window_id}\t#{client_activity}"],
		probe,
	);
	const client = clients.stdout
		.split("\n")
		.map((line) => line.split("\t"))
		.filter(([, window]) => window?.trim() === outerWindow)
		.map(([tty, , activity]) => ({ tty: tty?.trim() ?? "", activity: Number.parseInt(activity ?? "", 10) || 0 }))
		.filter((entry) => entry.tty)
		.sort((a, b) => b.activity - a.activity)[0]?.tty;
	if (clients.code !== 0 || !client) return { kind: "no-client" };
	return { kind: "client", client };
}
