import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	buildBtwRemainOnExitArgs,
	buildBtwSendKeysArgs,
	buildBtwSessionCreateArgs,
	buildBtwSubmitArgs,
	btwForkPath,
	btwQuestionPath,
	btwRunDir,
	btwSessionName,
	btwSidePromptPath,
	btwSocketPath,
	btwTarget,
	requireBtwQuestion,
} from "./launch.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const DESCRIPTION = "Ask a side question from this conversation in a separate panel; nothing is added to the transcript.";

/** What the launch core needs from its caller; tests inject their own. */
export interface BtwDeps {
	exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	notify: (message: string, type: "info" | "warning" | "error") => void;
	/** The pi agent dir, absolute; tests point it at a temp directory. */
	agentDir: string;
	/** This extension's directory, for the provider-extension lookup. */
	extensionDir: string;
}

/** The slice of the command context the launch core reads. */
export interface BtwContext {
	mode: string;
	cwd: string;
	model: { provider: string; id: string } | undefined;
	thinkingLevel?: string;
	sessionManager: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
		getLeafId(): string | null;
		getBranch(fromId?: string): unknown[];
	};
}

interface BtwPaths {
	socket: string;
	session: string;
	target: string;
	runDir: string;
	fork: string;
	question: string;
	sidePrompt: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The TMUX env var's socket component, when this process runs under tmux. */
function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

async function runTmux(deps: BtwDeps, args: string[], what: string): Promise<void> {
	const result = await deps.exec("tmux", args);
	if (result.code !== 0) {
		throw new Error(`${what}: ${result.stderr.trim() || `tmux exited ${result.code}`}`);
	}
}

/**
 * Kill this panel's session and recreate its scratch directory.
 *
 * The kill is best effort: a missing session is the normal first-run case, and
 * a missing tmux server is reported by the create call that follows. The
 * remove is deliberately before the mkdir, so a replace cannot inherit the
 * previous panel's fork file.
 */
async function resetPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	try {
		await deps.exec("tmux", buildBtwKillSessionArgs({ socket: paths.socket, session: paths.session }));
	} catch {
		// No tmux, no server or no session yet: all expected here.
	}
	await rm(paths.runDir, { recursive: true, force: true });
	await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
}

/** Remove everything resetPanel created after a failed launch, best effort. */
async function cleanupPanel(deps: BtwDeps, paths: BtwPaths): Promise<void> {
	try {
		await deps.exec("tmux", buildBtwKillSessionArgs({ socket: paths.socket, session: paths.session }));
	} catch {
		// Best effort: the failure path is already reporting a problem.
	}
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
	try {
		paths = {
			socket: btwSocketPath(deps.agentDir, sessionId),
			session: btwSessionName(sessionId),
			target: btwTarget(sessionId),
			runDir: btwRunDir(deps.agentDir, sessionId),
			fork: btwForkPath(deps.agentDir, sessionId),
			question: btwQuestionPath(deps.agentDir, sessionId),
			sidePrompt: btwSidePromptPath(deps.agentDir, sessionId),
		};
	} catch (error) {
		deps.notify(`Could not start the BTW panel: ${messageOf(error)}`, "error");
		return;
	}
	if (currentTmuxSocket() === paths.socket) {
		deps.notify("BTW cannot start from inside its own panel.", "warning");
		return;
	}

	try {
		await resetPanel(deps, paths);

		// Both files must exist before the argv below names them: pi appends a
		// non-existent --append-system-prompt value as literal text, and pi skips
		// an empty @file, which would leave the child with nothing to answer.
		await writeFile(paths.question, `${question}\n`, { encoding: "utf8", mode: 0o600 });
		await writeFile(paths.sidePrompt, `${BTW_SIDE_PROMPT}\n`, { encoding: "utf8", mode: 0o600 });

		const leafId = ctx.sessionManager.getLeafId();
		const branch = (leafId ? ctx.sessionManager.getBranch(leafId) : []) as unknown as ParentBranchEntry[];
		await forkLiveBranch({ sessionFile: paths.fork, branch, cwd: ctx.cwd, parentSession: mainFile });
		// pi opens a missing --session file as a fresh EMPTY session, so this is
		// what turns a failed fork write into an error instead of a panel that
		// looks alive with no inherited context.
		requireExistingSession(paths.fork, sessionId);

		const piArgs = buildBtwChildPiArgs({
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

		// Order matters: remain-on-exit has to be in place before the child can
		// crash, and the Enter must be its own call because send-keys -l would
		// type the word "Enter" instead of pressing it.
		await runTmux(
			deps,
			buildBtwSessionCreateArgs({ socket: paths.socket, session: paths.session, cwd: ctx.cwd }),
			"Could not create the BTW tmux session",
		);
		await runTmux(
			deps,
			buildBtwRemainOnExitArgs({ socket: paths.socket, session: paths.session }),
			"Could not keep the BTW pane after exit",
		);
		await runTmux(
			deps,
			buildBtwSendKeysArgs({ socket: paths.socket, target: paths.target, command: buildBtwChildCommand(piArgs) }),
			"Could not type the BTW command",
		);
		await runTmux(
			deps,
			buildBtwSubmitArgs({ socket: paths.socket, target: paths.target }),
			"Could not submit the BTW command",
		);

		deps.notify(`BTW panel started. Attach with: ${buildAttachCommand(paths.socket, paths.session)}`, "info");
	} catch (error) {
		await cleanupPanel(deps, paths);
		deps.notify(`Could not start the BTW panel: ${messageOf(error)}`, "error");
	}
}

export default function btwExtension(pi: ExtensionAPI): void {
	pi.registerCommand("btw", {
		description: DESCRIPTION,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("BTW needs the TUI.", "warning");
				return;
			}
			const typed = args.trim();
			const question = typed || (await ctx.ui.input("BTW question:", "ask about this conversation"));
			if (!question?.trim()) return;
			await launchBtwPanel(
				{
					exec: (command, argv) => pi.exec(command, argv),
					notify: (message, type = "info") => ctx.ui.notify(message, type),
					agentDir: getAgentDir(),
					extensionDir: EXTENSION_DIR,
				},
				ctx,
				question,
			);
		},
	});
}
