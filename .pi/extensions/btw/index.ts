import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	forkLiveBranch,
	getPiInvocationParts,
	requireExistingSession,
	type ParentBranchEntry,
} from "../subagent/handoff.ts";
import { buildAttachCommand, buildEscapeBindArgs, buildPanelLaunch } from "../subagent/panel.ts";
import {
	BTW_SIDE_PROMPT,
	buildBtwChildCommand,
	buildBtwChildPiArgs,
	buildBtwKillSessionArgs,
	buildBtwPaths,
	buildBtwRemainOnExitArgs,
	buildBtwSendKeysArgs,
	buildBtwSessionCreateArgs,
	buildBtwSubmitArgs,
	requireBtwQuestion,
	type BtwPaths,
} from "./launch.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESCRIPTION = "Ask a side question from this conversation in a separate panel; nothing is added to the transcript.";
/** Every tmux call is bounded: a wedged server must not hang the command handler. */
const TMUX_TIMEOUT_MS = 5_000;

/** How the popup CLI is started, injectable so tests never spawn one. */
export type PanelLauncher = (
	command: string,
	args: string[],
	options: { detached: true; stdio: "ignore" },
	onError: (message: string) => void,
) => void;

/**
 * Start the popup detached, so pi neither waits for it nor is kept alive by it.
 * A spawn error is the only failure this can report: once tmux is running, a
 * display-popup failure exits in an unobserved process.
 */
const defaultPanelLauncher: PanelLauncher = (command, args, options, onError) => {
	const child = spawn(command, args, options);
	child.once("error", (error) => onError(error instanceof Error ? error.message : String(error)));
	child.unref();
};

// A module-level binding rather than a direct call so factory-driven tests can
// substitute it (`__test__.setPanelLauncher`). The extension reads it at popup
// time, so a test can change it without reloading the factory.
let panelLauncher: PanelLauncher = defaultPanelLauncher;

/** What the launch core needs from its caller; tests inject their own. */
export interface BtwDeps {
	exec: ExtensionAPI["exec"];
	notify: (message: string, type: "info" | "warning" | "error") => void;
	launch: PanelLauncher;
	/** The pi agent dir, absolute; tests point it at a temp directory. */
	agentDir: string;
	/**
	 * This extension's directory, for the provider-extension lookup. Injected
	 * rather than derived here so the argv pin can use a fake layout.
	 */
	extensionDir: string;
}

/** The slice of pi's command context the launch core reads. */
export type BtwContext = Pick<ExtensionContext, "mode" | "cwd" | "model" | "thinkingLevel"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getLeafId" | "getBranch">;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The TMUX env var's socket component, when this process runs under tmux. */
function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

async function runTmux(deps: BtwDeps, args: string[], what: string): Promise<void> {
	const result = await deps.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
	if (result.code !== 0) {
		// pi.exec resolves rather than rejects on a non-zero exit, and leaves
		// stderr empty when the binary itself could not be spawned.
		const reason = result.stderr.trim() || `tmux exited ${result.code} without output (tmux may be unavailable)`;
		throw new Error(`${what}: ${reason}`);
	}
}

/**
 * Kill the panel's tmux session.
 *
 * A missing session exits non-zero, which is the normal first-run and
 * post-cleanup case, so the result is deliberately ignored. The catch covers a
 * thrown exec (for example an aborted turn), not a non-zero exit.
 */
async function killPanelSession(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	try {
		await deps.exec("tmux", buildBtwKillSessionArgs({ socket: paths.socket, session: paths.session }), {
			timeout: TMUX_TIMEOUT_MS,
		});
	} catch {
		// Nothing to kill, or the abort already tore the command down.
	}
}

/**
 * Kill this panel's session and recreate its scratch directory.
 *
 * The remove sits deliberately between the kill and the mkdir, so a replace
 * cannot inherit the previous panel's fork file.
 */
async function resetPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	await killPanelSession(deps, paths);
	await rm(paths.runDir, { recursive: true, force: true });
	await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
}

/** Remove everything resetPanel created after a failed launch, best effort. */
async function cleanupPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	await killPanelSession(deps, paths);
	await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
}

/** What the tmux server says about a panel session. */
type PanelState = "missing" | "dead" | "live" | "unknown";

/**
 * Probe the panel's tmux session and its child.
 *
 * `unknown` exists for a thrown exec (an aborted turn): the caller must not
 * replace a panel it could not inspect, and must not pretend it is live either.
 */
async function panelState(deps: BtwDeps, paths: BtwPaths): Promise<PanelState> {
	try {
		const alive = await deps.exec("tmux", ["-S", paths.socket, "has-session", "-t", paths.session], {
			timeout: TMUX_TIMEOUT_MS,
		});
		if (alive.code !== 0) return "missing";
		const dead = await deps.exec(
			"tmux",
			["-S", paths.socket, "display-message", "-p", "-t", paths.session, "#{pane_dead}"],
			{ timeout: TMUX_TIMEOUT_MS },
		);
		// A query that cannot answer is treated as live: replacing a panel that
		// may still be running is worse than attaching to one that is not.
		return dead.code === 0 && dead.stdout.trim() === "1" ? "dead" : "live";
	} catch (error) {
		deps.notify(`Could not check the BTW panel: ${messageOf(error)}`, "error");
		return "unknown";
	}
}

/**
 * Open the popup over pi's client for an existing panel session.
 *
 * Returns true when the popup was launched. Every false path notifies with the
 * reason and the manual attach command, because the popup is the only way the
 * panel is shown. The binding is re-applied on every open: the popup's exit
 * command unbinds Escape, so a reattach without a fresh bind would leave
 * Escape falling through to the child.
 *
 * Two limits are deliberate. A popup tmux itself rejects after the detached
 * spawn (the client detached in between, tmux too old) exits unobserved; only a
 * spawn error is reportable. And the unbind runs in the old popup's shell when
 * it exits, so kill-then-reopen can in principle land `unbind` after the new
 * `bind`; the bind is re-applied on every open, and the panel's own socket
 * bounds any stale binding to this one session's server.
 */
async function openBtwPopup(deps: BtwDeps, paths: BtwPaths, sessionId: string): Promise<boolean> {
	const attach = buildAttachCommand(paths.socket, paths.session);
	const fallback = (message: string, type: "info" | "warning"): false => {
		deps.notify(`${message} Attach with: ${attach}`, type);
		return false;
	};

	try {
		const outerSocket = currentTmuxSocket();
		const outerPane = process.env.TMUX_PANE?.trim();
		if (!outerSocket || !outerPane) return fallback("Not running inside tmux.", "info");

		// Scope the popup to a client actually looking at pi's window: `-t <pane>`
		// alone resolves the most recently active client on the whole server.
		const target = await deps.exec(
			"tmux",
			["-S", outerSocket, "display-message", "-p", "-t", outerPane, "#{window_id}"],
			{ timeout: TMUX_TIMEOUT_MS },
		);
		const outerWindow = target.stdout.trim();
		if (target.code !== 0 || !outerWindow) return fallback("That tmux pane is gone.", "warning");

		const clients = await deps.exec(
			"tmux",
			["-S", outerSocket, "list-clients", "-F", "#{client_tty}\t#{window_id}\t#{client_activity}"],
			{ timeout: TMUX_TIMEOUT_MS },
		);
		const client = clients.stdout
			.split("\n")
			.map((line) => line.split("\t"))
			.filter(([, window]) => window?.trim() === outerWindow)
			.map(([tty, , activity]) => ({ tty: tty?.trim() ?? "", activity: Number.parseInt(activity ?? "", 10) || 0 }))
			.filter((entry) => entry.tty)
			.sort((a, b) => b.activity - a.activity)[0]?.tty;
		if (clients.code !== 0 || !client) return fallback("No attached tmux client is viewing this pane.", "warning");

		const alive = await deps.exec("tmux", ["-S", paths.socket, "has-session", "-t", paths.session], {
			timeout: TMUX_TIMEOUT_MS,
		});
		if (alive.code !== 0) {
			deps.notify("The BTW panel session is gone. Run /btw again to start a fresh one.", "warning");
			return false;
		}

		const bound = await deps.exec("tmux", buildEscapeBindArgs(paths.socket), { timeout: TMUX_TIMEOUT_MS });
		if (bound.code !== 0) {
			return fallback(
				`Could not set up the panel's Escape binding: ${bound.stderr.trim() || `tmux exited ${bound.code}`}.`,
				"warning",
			);
		}

		const launch = buildPanelLaunch({
			outerSocket,
			pane: outerPane,
			client,
			socket: paths.socket,
			session: paths.session,
			runId: sessionId,
			titlePrefix: "btw",
		});
		deps.launch(launch.command, launch.args, { detached: true, stdio: "ignore" }, (message) => {
			deps.notify(`Could not open the panel: ${message}. Attach with: ${attach}`, "error");
		});
		return true;
	} catch (error) {
		deps.notify(`Could not open the panel: ${messageOf(error)}. Attach with: ${attach}`, "error");
		return false;
	}
}

/**
 * Open the popup for a panel that is already running, without re-forking.
 *
 * Returns false when there is nothing live to reuse: no session, or a pane the
 * child left behind (remain-on-exit keeps the corpse visible, but attaching to
 * it would show a stale error instead of a side panel). A live panel that
 * merely cannot be shown here returns true, so the caller does not replace it
 * by launching a new question.
 */
export async function reattachBtwPanel(deps: BtwDeps, ctx: BtwContext): Promise<boolean> {
	let sessionId: string;
	let paths: BtwPaths;
	try {
		sessionId = ctx.sessionManager.getSessionId();
		paths = buildBtwPaths(deps.agentDir, sessionId);
	} catch {
		return false;
	}
	const state = await panelState(deps, paths);
	if (state === "missing") return false;
	if (state === "unknown") {
		// The probe told the user what went wrong; replacing a panel we could not
		// inspect would be the worse guess.
		return true;
	}
	if (state === "dead") {
		deps.notify("The previous BTW panel is no longer running; ask a new question to start one.", "warning");
		return false;
	}
	const shown = await openBtwPopup(deps, paths, sessionId);
	if (!shown) {
		deps.notify("The running BTW panel was left in place; /btw <question> replaces it with a fresh one.", "info");
	}
	return true;
}

/**
 * Start a /btw panel: fork the live branch, write the question and the side
 * prompt, and run a child pi in its own tmux session.
 *
 * A new question always replaces the previous panel: the old session is
 * killed and its transcript removed before the fork, so a side conversation
 * never outlives the context snapshot it was opened on. The popup is opened
 * after the launch and is deliberately outside the cleanup path: a popup that
 * cannot be shown must not tear down a panel that started fine.
 */
export async function launchBtwPanel(deps: BtwDeps, ctx: BtwContext, rawQuestion: string): Promise<void> {
	if (ctx.mode !== "tui") {
		deps.notify("BTW needs the TUI.", "warning");
		return;
	}
	let question: string;
	try {
		question = requireBtwQuestion(rawQuestion);
	} catch (error) {
		deps.notify(messageOf(error), "warning");
		return;
	}
	if (!ctx.model) {
		deps.notify("BTW needs a selected model.", "warning");
		return;
	}
	const mainFile = ctx.sessionManager.getSessionFile();
	if (!mainFile) {
		deps.notify("BTW needs a saved session: an in-memory session has no branch to fork.", "warning");
		return;
	}

	const sessionId = ctx.sessionManager.getSessionId();
	let paths: BtwPaths;
	let piArgs: string[];
	let command: string;
	let createArgs: string[];
	let remainArgs: string[];
	let sendArgs: string[];
	let submitArgs: string[];
	try {
		// Every builder is pure, so a bad path or provider mapping fails before
		// the previous panel is touched.
		paths = buildBtwPaths(deps.agentDir, sessionId);
		piArgs = buildBtwChildPiArgs({
			invocation: getPiInvocationParts(),
			provider: ctx.model.provider,
			model: ctx.model.id,
			thinking: ctx.thinkingLevel,
			sessionFile: paths.fork,
			questionPath: paths.question,
			sidePromptPath: paths.sidePrompt,
			btwDir: deps.extensionDir,
			name: paths.session,
		});
		command = buildBtwChildCommand(piArgs);
		createArgs = buildBtwSessionCreateArgs({ socket: paths.socket, session: paths.session, cwd: ctx.cwd });
		remainArgs = buildBtwRemainOnExitArgs({ socket: paths.socket, session: paths.session });
		sendArgs = buildBtwSendKeysArgs({ socket: paths.socket, target: paths.target, command });
		submitArgs = buildBtwSubmitArgs({ socket: paths.socket, target: paths.target });
	} catch (error) {
		deps.notify(`Could not start the BTW panel: ${messageOf(error)}`, "error");
		return;
	}

	const leafId = ctx.sessionManager.getLeafId();
	const branch = (leafId ? ctx.sessionManager.getBranch(leafId) : []) as unknown as ParentBranchEntry[];
	if (branch.length === 0) {
		deps.notify(
			"BTW: this session has no messages yet, so the panel starts with an empty conversation; only its read-only tools can answer.",
			"warning",
		);
	}

	try {
		await resetPanel(deps, paths);

		// Both files must exist before the child argv reads them: pi appends a
		// non-existent --append-system-prompt value as literal text, and pi skips
		// an empty @file, which would leave the child with nothing to answer.
		await writeFile(paths.question, `${question}\n`, { encoding: "utf8", mode: 0o600 });
		await writeFile(paths.sidePrompt, `${BTW_SIDE_PROMPT}\n`, { encoding: "utf8", mode: 0o600 });

		await forkLiveBranch({ sessionFile: paths.fork, branch, cwd: ctx.cwd, parentSession: mainFile });
		// pi opens a missing --session file as a fresh EMPTY session, so this is
		// what turns a failed fork write into an error instead of a panel that
		// looks alive with no inherited context.
		requireExistingSession(paths.fork, sessionId);

		// Order matters: remain-on-exit has to be in place before the child can
		// crash, and the Enter must be its own call because send-keys -l would
		// type the word "Enter" instead of pressing it.
		await runTmux(deps, createArgs, "Could not create the BTW tmux session");
		await runTmux(deps, remainArgs, "Could not keep the BTW pane after exit");
		await runTmux(deps, sendArgs, "Could not type the BTW command");
		await runTmux(deps, submitArgs, "Could not submit the BTW command");
	} catch (error) {
		await cleanupPanel(deps, paths);
		deps.notify(
			`Could not start the BTW panel (a previous panel, if any, may have been closed): ${messageOf(error)}`,
			"error",
		);
		return;
	}

	await openBtwPopup(deps, paths, sessionId);
}

export default function btwExtension(pi: ExtensionAPI): void {
	let launching = false;
	pi.registerCommand("btw", {
		description: DESCRIPTION,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				// Checked before the prompt: in JSON/print the input is a silent
				// no-op, so this is the guard that keeps a pointless prompt away.
				ctx.ui.notify("BTW needs the TUI.", "warning");
				return;
			}
			if (launching) {
				ctx.ui.notify("BTW is still starting the previous panel.", "warning");
				return;
			}
			launching = true;
			try {
				const deps: BtwDeps = {
					exec: (command, argv, options) => pi.exec(command, argv, options),
					launch: (command, argv, options, onError) => panelLauncher(command, argv, options, onError),
					notify: (message, type = "info") => ctx.ui.notify(message, type),
					agentDir: getAgentDir(),
					extensionDir: EXTENSION_DIR,
				};
				const typed = args.trim();
				if (typed) {
					await launchBtwPanel(deps, ctx, typed);
					return;
				}
				// No question: reattach to a running panel instead of replacing it.
				if (await reattachBtwPanel(deps, ctx)) return;
				const question = await ctx.ui.input("BTW question:", "ask about this conversation");
				if (!question?.trim()) return;
				await launchBtwPanel(deps, ctx, question);
			} finally {
				launching = false;
			}
		},
	});
}

/** Internals exposed for unit tests; nothing here is used at runtime. */
export const __test__ = {
	setPanelLauncher: (launcher?: PanelLauncher): void => {
		panelLauncher = launcher ?? defaultPanelLauncher;
	},
	defaultPanelLauncher,
};
