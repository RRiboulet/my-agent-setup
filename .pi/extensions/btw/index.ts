import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

import { buildAttachCommand, buildEscapeBindArgs, buildPanelLaunch } from "../subagent/panel.ts";
import {
	buildBtwKillServerArgs,
	buildBtwPaths,
	buildBtwRemainOnExitArgs,
	buildBtwSendKeysArgs,
	buildBtwSessionCreateArgs,
	buildBtwSubmitArgs,
	buildBtwViewerCommand,
	btwRootDir,
	requireBtwQuestion,
	type BtwPaths,
} from "./launch.ts";
import { runBtwRequest, sanitizeAnswerText, type BtwOutcome } from "./request.ts";

const DESCRIPTION = "Open a side-question panel that asks for the question and answers without adding anything to the transcript.";
/** Every tmux call is bounded: a wedged server must not hang the command handler. */
const TMUX_TIMEOUT_MS = 5_000;
const FOOTER = "\n\n---\n";

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
	/** Process liveness for the owner-pid reap; injected so tests can fake it. */
	isPidAlive: (pid: number) => boolean;
	/** Mirror the main loop's image-blocking wrapper when the setting is on. */
	blockImages: boolean;
}

/** The slice of pi's command context the launch core reads. */
export type BtwContext = Pick<ExtensionContext, "mode" | "cwd" | "model" | "modelRegistry"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getEntries" | "getLeafId">;
};

/** A running panel: abort it on replace/shutdown, await it before reusing paths. */
export interface BtwLaunch {
	controller: AbortController;
	completion: Promise<void>;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a pid belongs to a live process. EPERM means the process exists but
 * is not ours, which still counts as alive.
 */
function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
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
 * Kill the panel's tmux server, reporting whether the command exited 0.
 *
 * A missing server exits non-zero, which is the normal first-run case; the
 * boolean lets `destroyPanel` skip its confirmation probe on a clean kill
 * without ever reading a failure as success.
 */
async function killPanel(deps: BtwDeps, paths: BtwPaths): Promise<boolean> {
	try {
		const result = await deps.exec("tmux", buildBtwKillServerArgs({ socket: paths.socket }), {
			timeout: TMUX_TIMEOUT_MS,
		});
		return result.code === 0;
	} catch {
		// Nothing to kill, or the abort already tore the command down.
		return false;
	}
}

/**
 * Kill the panel's server and report whether it is gone.
 *
 * A clean kill (exit 0) means gone. On an ambiguous result the has-session
 * probe decides: a live session, a thrown probe or a timed-out one all count
 * as alive, so every caller keeps the answer and the socket for a later retry.
 */
async function closePanelServer(deps: BtwDeps, paths: BtwPaths): Promise<boolean> {
	if (await killPanel(deps, paths)) return true;
	try {
		const still = await deps.exec("tmux", ["-S", paths.socket, "has-session", "-t", paths.session], {
			timeout: TMUX_TIMEOUT_MS,
		});
		return still.code !== 0 && still.killed !== true;
	} catch {
		return false;
	}
}

/**
 * Kill this panel's server and recreate its scratch directory.
 *
 * The remove sits between a confirmed close and the mkdir, so a replace cannot
 * inherit the previous answer and a server that would not die cannot take that
 * answer down with it. The owner is the main pi process: a later start or sweep
 * reaps this panel only when this pid is gone, which is what makes a second
 * live pi on the same session id safe.
 */
async function resetPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	if (!(await closePanelServer(deps, paths))) {
		throw new Error("the previous BTW panel is still running; close it and try again");
	}
	await rm(paths.runDir, { recursive: true, force: true });
	await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
	await writeFile(paths.ownerPid, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
}


/**
 * Read the owner pid of a panel directory. A missing or malformed file counts
 * as dead: the only writer creates the directory first.
 */
async function readOwnerPid(paths: BtwPaths): Promise<number | undefined> {
	try {
		const raw = (await readFile(paths.ownerPid, "utf8")).trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Kill the server, then remove the scratch dir and the socket file.
 *
 * Kill must come before the deletes. The socket is removed here because tmux
 * leaves it behind when a server exits, and one socket per session would
 * otherwise accumulate. If the kill fails or times out, nothing is deleted: the
 * socket is the only handle to a possibly live viewer, and the answer should
 * not be unlinked under it.
 */
async function destroyPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	if (!(await closePanelServer(deps, paths))) return;
	await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
	await rm(paths.socket, { force: true }).catch(() => undefined);
}

/** Reap one panel directory when its owning pi process is gone. */
async function reapPanel(deps: BtwDeps, sessionId: string): Promise<void> {
	let paths: BtwPaths;
	try {
		paths = buildBtwPaths(deps.agentDir, sessionId);
	} catch {
		return;
	}
	try {
		await stat(paths.runDir);
	} catch {
		return; // no panel was ever created for this session
	}
	const owner = await readOwnerPid(paths);
	if (owner !== undefined && deps.isPidAlive(owner)) return;
	await destroyPanel(deps, paths);
}

/**
 * Sweep every panel directory whose owner is dead. This catches a crash whose
 * next pi start uses a different session id, which the per-session reap cannot
 * see; a live sibling process keeps its panel.
 */
async function sweepPanels(deps: BtwDeps): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(btwRootDir(deps.agentDir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		await reapPanel(deps, entry.name).catch(() => undefined);
	}
}

/**
 * `session_start`: a reload keeps the panel (the runtime is rebuilt, the panel
 * is still ours); every other start reaps this session's dead panel and sweeps
 * orphans. The owner-pid check is what keeps a live sibling alive.
 */
export async function reapBtwPanels(deps: BtwDeps, reason: string, sessionId: string): Promise<void> {
	if (reason === "reload") return;
	await reapPanel(deps, sessionId);
	await sweepPanels(deps);
}

/**
 * `session_shutdown`: quit and session replacement tear the panel down; reload
 * keeps it. Only the process that launched the panel, or a dead owner's
 * leftovers, may destroy it.
 */
export async function destroyBtwPanel(deps: BtwDeps, reason: string, sessionId: string): Promise<void> {
	if (reason === "reload") return;
	let paths: BtwPaths;
	try {
		paths = buildBtwPaths(deps.agentDir, sessionId);
	} catch {
		return;
	}
	if (!existsSync(paths.runDir) && !existsSync(paths.socket)) return;
	const owner = await readOwnerPid(paths);
	if (owner !== undefined && owner !== process.pid && deps.isPidAlive(owner)) return;
	await destroyPanel(deps, paths);
}

/** What the tmux server says about the viewer session. */
type PanelState = "missing" | "dead" | "live" | "unknown";

/**
 * Probe the panel's tmux session and its viewer.
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
 * Escape falling through to the viewer.
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

/** Start (or restart) the view-only tmux session for an existing answer file. */
async function startViewer(deps: BtwDeps, paths: BtwPaths, cwd: string): Promise<void> {
	await runTmux(
		deps,
		buildBtwSessionCreateArgs({ socket: paths.socket, session: paths.session, cwd }),
		"Could not create the BTW tmux session",
	);
	await runTmux(
		deps,
		buildBtwRemainOnExitArgs({ socket: paths.socket, session: paths.session }),
		"Could not keep the BTW pane after exit",
	);
	await runTmux(
		deps,
		buildBtwSendKeysArgs({ socket: paths.socket, target: paths.target, command: buildBtwViewerCommand(paths.answer) }),
		"Could not start the BTW viewer",
	);
	await runTmux(
		deps,
		buildBtwSubmitArgs({ socket: paths.socket, target: paths.target }),
		"Could not submit the BTW viewer",
	);
}

/**
 * Open the popup for a panel that is already running, without asking again.
 *
 * Returns false when there is nothing to reuse: no session, no answer file, and
 * no dead viewer to restart. A live panel that merely cannot be shown here
 * returns true, so the caller does not replace it by launching a new question.
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
	if (state === "unknown") return true;
	if (state === "missing" || state === "dead") {
		if (!existsSync(paths.answer)) {
			if (state === "dead") {
				deps.notify("The previous BTW panel is no longer running; ask a new question to start one.", "warning");
			}
			return false;
		}
		try {
			// The session may still exist (a viewer that exited leaves a dead
			// pane), and new-session refuses a duplicate name; the socket is
			// per-session, so closing it first is scoped and cheap.
			if (!(await closePanelServer(deps, paths))) {
				throw new Error("the previous BTW panel is still running; close it and try again");
			}
			await startViewer(deps, paths, ctx.cwd);
		} catch (error) {
			deps.notify(`Could not reopen the BTW panel: ${messageOf(error)}`, "warning");
			return true;
		}
		await openBtwPopup(deps, paths, sessionId);
		return true;
	}
	const shown = await openBtwPopup(deps, paths, sessionId);
	if (!shown) {
		deps.notify("The running BTW panel was left in place; run /btw and submit a question to replace it.", "info");
	}
	return true;
}

/** The answer file's footer. */
export function formatBtwUsage(usage: Usage | undefined): string {
	if (usage === undefined) return "";
	const number = (value: number): string => value.toLocaleString("en-US");
	const parts = [`input ${number(usage.input)}`];
	if (usage.cacheRead > 0) parts.push(`cache read ${number(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`cache write ${number(usage.cacheWrite)}`);
	parts.push(`output ${number(usage.output)}`);
	return parts.join(" · ");
}

/** Append the outcome to the answer file, where the viewer sees it. */
async function appendFooter(deps: BtwDeps, paths: BtwPaths, outcome: BtwOutcome): Promise<void> {
	// A sibling pi that reset this run dir under us owns the answer file now;
	// writing the footer into it would interleave two answers.
	if ((await readOwnerPid(paths)) !== process.pid) return;
	const toolNote =
		outcome.ignoredToolCalls === undefined
			? undefined
			: `${outcome.ignoredToolCalls} tool call${outcome.ignoredToolCalls === 1 ? "" : "s"} ignored`;
	const withToolNote = (text: string): string => (toolNote === undefined ? text : `${text} · ${toolNote}`);
	const summary =
		outcome.status === "ok"
			? withToolNote(formatBtwUsage(outcome.usage))
			: outcome.status === "cancelled"
				? withToolNote(`cancelled${outcome.usage ? ` · ${formatBtwUsage(outcome.usage)}` : ""}`)
				: withToolNote(`error: ${outcome.message}${outcome.usage ? ` · ${formatBtwUsage(outcome.usage)}` : ""}`);
	await appendFile(paths.answer, `${FOOTER}${sanitizeAnswerText(summary)}\n`, "utf8").catch(() => undefined);
	if (outcome.status === "error") deps.notify(`BTW: ${outcome.message}`, "error");
	// A zero cache read is the one failure the footer cannot show (it omits
	// the `cache read` segment when the value is 0), so it is notified too — but
	// only when the context was large enough that a cache read was clearly
	// expected. A short session, or the first question after an idle gap,
	// cold-starts with a small `input` that the footer already shows; warning
	// those trains the user to distrust the warning.
	const ZERO_CACHE_WARN_INPUT_TOKENS = 20_000;
	if (
		outcome.status === "ok" &&
		outcome.usage !== undefined &&
		outcome.usage.cacheRead === 0 &&
		outcome.usage.input >= ZERO_CACHE_WARN_INPUT_TOKENS
	) {
		deps.notify("BTW: the answer reported 0 cached tokens read — the cache invariants in CACHE.md are broken", "warning");
	}
}

/**
 * Start a /btw panel: reset the scratch dir, write the answer header, start the
 * viewer, open the popup, and begin the in-process request.
 *
 * The request runs in the background and is returned as `completion`, so the
 * command handler returns while the answer streams into the viewer. A new
 * question aborts the controller and awaits the completion before resetting the
 * paths, which keeps the old request from writing into the new answer file.
 */
export async function launchBtwPanel(deps: BtwDeps, ctx: BtwContext, rawQuestion: string): Promise<BtwLaunch | null> {
	if (ctx.mode !== "tui") {
		deps.notify("BTW needs the TUI.", "warning");
		return null;
	}
	let question: string;
	try {
		question = requireBtwQuestion(rawQuestion);
	} catch (error) {
		deps.notify(messageOf(error), "warning");
		return null;
	}
	const model = ctx.model;
	if (!model) {
		deps.notify("BTW needs a selected model.", "warning");
		return null;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	let paths: BtwPaths;
	try {
		paths = buildBtwPaths(deps.agentDir, sessionId);
	} catch (error) {
		deps.notify(`Could not start the BTW panel: ${messageOf(error)}`, "error");
		return null;
	}

	try {
		await resetPanel(deps, paths);
		const quoted = sanitizeAnswerText(question).split("\n").join("\n> ");
		await writeFile(paths.answer, `# /btw\n\n> ${quoted}\n\n`, { encoding: "utf8", mode: 0o600 });
		await startViewer(deps, paths, ctx.cwd);
		await openBtwPopup(deps, paths, sessionId);
	} catch (error) {
		await destroyPanel(deps, paths);
		deps.notify(`Could not start the BTW panel: ${messageOf(error)}`, "error");
		return null;
	}

	const controller = new AbortController();
	const completion = (async (): Promise<void> => {
		let outcome: BtwOutcome;
		try {
			outcome = await runBtwRequest({
				modelRegistry: ctx.modelRegistry,
				model,
				sessionId,
				blockImages: deps.blockImages,
				entries: ctx.sessionManager.getEntries(),
				leafId: ctx.sessionManager.getLeafId(),
				question,
				signal: controller.signal,
				abort: () => controller.abort(),
				onText: async (text) => {
					// A second pi on the same session id resets this run dir under us
					// and writes its own owner pid; appending then interleaves two
					// answers into one file. Stop the request instead of writing into
					// a panel this process no longer owns.
					if ((await readOwnerPid(paths)) !== process.pid) {
						controller.abort();
						return;
					}
					await appendFile(paths.answer, text, "utf8");
				},
			});
		} catch (error) {
			outcome = { status: "error", message: messageOf(error) };
		}
		await appendFooter(deps, paths, outcome);
	})();
	return { controller, completion };
}

export default function btwExtension(pi: ExtensionAPI): void {
	let active: BtwLaunch | undefined;
	let starting = false;
	const depsFor = (ctx: ExtensionContext): BtwDeps => {
		const settings = pi.getSettings();
		return {
			exec: (command, argv, options) => pi.exec(command, argv, options),
			launch: (command, argv, options, onError) => panelLauncher(command, argv, options, onError),
			notify: (message, type = "info") => ctx.ui.notify(message, type),
			agentDir: getAgentDir(),
			isPidAlive: defaultIsPidAlive,
			blockImages: settings.images?.blockImages === true,
			// The main loop forwards these so the provider maps thinking and
			// attributes the request identically; see request.ts.
			thinkingBudgets: settings.thinkingBudgets,
			thinkingLevel: pi.getThinkingLevel(),
			enableInstallTelemetry: settings.enableInstallTelemetry === true,
		};
	};
	const stopActive = async (): Promise<void> => {
		const current = active;
		active = undefined;
		if (!current) return;
		current.controller.abort();
		await current.completion.catch(() => undefined);
	};

	pi.registerCommand("btw", {
		description: DESCRIPTION,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				// Checked before the prompt: in JSON/print the input is a silent
				// no-op, so this is the guard that keeps a pointless prompt away.
				ctx.ui.notify("BTW needs the TUI.", "warning");
				return;
			}
			if (args.trim().length > 0) {
				// The command takes no arguments: the question comes from the input
				// prompt, so spaces and punctuation in it cannot be parsed as
				// command arguments or lost on the way in.
				ctx.ui.notify("BTW takes no arguments: run /btw and the panel will ask for the question.", "warning");
				return;
			}
			if (starting) {
				// The setup owns the run dir and socket until it hands back a
				// launch; a second command in that window would interleave rm,
				// mkdir and new-session on the same paths.
				ctx.ui.notify("BTW is still starting the previous panel.", "warning");
				return;
			}
			starting = true;
			try {
				const deps = depsFor(ctx);
				// The command is deliberately argument-free. An empty submission
				// reopens the existing panel; a question starts (or replaces) one.
				// The hint rides in the title: pi's input component ignores the
				// placeholder argument, so a hint passed there is never rendered.
				const question = await ctx.ui.input(
					"BTW question (submit empty to reopen the panel):",
					"ask about this conversation",
				);
				if (question === undefined) return; // cancelled
				if (!question.trim()) {
					if (!(await reattachBtwPanel(deps, ctx))) {
						deps.notify("No BTW panel is running; type a question to start one.", "info");
					}
					return;
				}
				await stopActive();
				const launch = await launchBtwPanel(deps, ctx, question);
				if (launch) {
					active = launch;
					// The completion holds the launch's closure; drop the slot once
					// it finishes so the entries snapshot is not retained.
					void launch.completion.catch(() => undefined).finally(() => {
						if (active === launch) active = undefined;
					});
				}
			} finally {
				starting = false;
			}
		},
	});

	// The panel outlives a reload (the runtime is rebuilt, the tmux session and
	// its answer are still ours); quit and session replacement clean it up.
	pi.on("session_start", async (event, ctx) => {
		await reapBtwPanels(depsFor(ctx), event.reason, ctx.sessionManager.getSessionId());
	});
	pi.on("session_shutdown", async (event, ctx) => {
		await stopActive();
		await destroyBtwPanel(depsFor(ctx), event.reason, ctx.sessionManager.getSessionId());
	});
}

/** Internals exposed for unit tests; nothing here is used at runtime. */
export const __test__ = {
	setPanelLauncher: (launcher?: PanelLauncher): void => {
		panelLauncher = launcher ?? defaultPanelLauncher;
	},
	defaultPanelLauncher,
};
