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
import { buildAttachCommand } from "../subagent/panel.ts";
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

/** What the launch core needs from its caller; tests inject their own. */
export interface BtwDeps {
	exec: ExtensionAPI["exec"];
	notify: (message: string, type: "info" | "warning" | "error") => void;
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

/**
 * Start a /btw panel: fork the live branch, write the question and the side
 * prompt, and run a child pi in its own tmux session.
 *
 * This chunk stops at the attach command. The popup, the reattach path and the
 * lifetime rules are the following chunks; the split keeps every tmux call and
 * every guard drivable by a fake `deps` here.
 *
 * A new question always replaces the previous panel: the old session is
 * killed and its transcript removed before the fork, so a side conversation
 * never outlives the context snapshot it was opened on.
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

		deps.notify(`BTW panel started. Attach with: ${buildAttachCommand(paths.socket, paths.session)}`, "info");
	} catch (error) {
		await cleanupPanel(deps, paths);
		deps.notify(
			`Could not start the BTW panel (a previous panel, if any, may have been closed): ${messageOf(error)}`,
			"error",
		);
	}
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
				const typed = args.trim();
				const question = typed || (await ctx.ui.input("BTW question:", "ask about this conversation"));
				if (!question?.trim()) return;
				await launchBtwPanel(
					{
						exec: (command, argv, options) => pi.exec(command, argv, options),
						notify: (message, type = "info") => ctx.ui.notify(message, type),
						agentDir: getAgentDir(),
						extensionDir: EXTENSION_DIR,
					},
					ctx,
					question,
				);
			} finally {
				launching = false;
			}
		},
	});
}
