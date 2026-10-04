// Session handoff for the subagent extension: how a child Pi process is
// launched, and how its session file is seeded.
//
// Three handoff modes exist, all built on pi's native session flags rather
// than hand-rolled transcript rewriting at runtime:
//
//   standalone - a fresh session, addressed by --session-dir/--session-id.
//   lineage    - a fresh, EMPTY session that records the parent session in
//                its v3 header, so pi shows the relationship but the child
//                does NOT inherit the parent's context.
//   fork       - a new session seeded with the parent's live branch, so the
//                child continues the conversation the parent was actually on.
//   resume     - re-open the run's existing session file and append to it.
//
// pi 1.0 constraints, verified against the installed package:
//
//   - `--session` is mutually exclusive with `--session-id`, `--continue` and
//     `--resume`; combining them is a hard `process.exit(1)` in
//     `dist/main.js:243-256`. We therefore never emit `--session-id`
//     alongside `--session`.
//   - Note that `--fork` is NOT in that list: `--fork` and `--session-id` do
//     compose, and pairing them is pi's sanctioned way to fork with a chosen
//     id. Only duplicate ids error. (`--session` + `--continue` also compose,
//     with `--session` winning.)
//   - `pi --session <missing-file>` silently starts a fresh empty session AND
//     invents a new UUID id, so the conversation silently diverges from the
//     parent's instead of merely being empty. Every mode that hands over an
//     existing file checks it exists first; the guard is mandatory, not
//     defensive.
//   - `SessionManager._loadEntries` assigns `leafId` to each non-header entry
//     in file order, which means a session file's ACTIVE BRANCH is simply its
//     last non-header line. There is no persisted leaf pointer.
//
// That last point is why `SessionManager.forkFrom` is not used for `fork`
// mode: it copies every non-header entry from the source, so the child's leaf
// becomes the source file's last line. If the parent's own tail is not its
// live branch, the child silently resumes the wrong branch. Writing the live
// branch ourselves - ancestors first, live leaf last - is what makes the
// branch correct, and it is also a deterministic snapshot taken in the parent
// process rather than asynchronously inside the child.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

/** Mirrors pi's `CURRENT_SESSION_VERSION`, which is exported from its entry point. */
export const SESSION_VERSION = CURRENT_SESSION_VERSION;

export type LaunchMode = "standalone" | "lineage" | "fork" | "resume";

/** Modes that hand the child an existing session file rather than a new id. */
const SESSION_FILE_MODES: ReadonlySet<LaunchMode> = new Set<LaunchMode>(["lineage", "fork", "resume"]);

export interface ChildLaunchSpec {
	mode: LaunchMode;
	/** argv prefix identifying how to start pi (see `getPiInvocationParts`). */
	invocation: string[];
	provider: string;
	model: string;
	thinking: string;
	/** Required for `standalone`. */
	sessionDir?: string;
	/** Required for `lineage`, `fork` and `resume`. */
	sessionFile?: string;
	/** Required for `standalone`. */
	sessionId?: string;
	tmuxSession: string;
	trusted: boolean;
	extensionPath: string;
	promptPath: string;
}

/**
 * Build the argv for the child `pi` process.
 *
 * Pure, so the per-mode flag combinations can be asserted without launching
 * anything. Throws rather than emitting a combination pi would reject at exit.
 */
export function buildChildPiArgs(spec: ChildLaunchSpec): string[] {
	const fileMode = usesSessionFile(spec.mode);

	if (fileMode && !spec.sessionFile) {
		throw new Error(`launch mode ${spec.mode} requires a sessionFile`);
	}
	if (!fileMode && (!spec.sessionDir || !spec.sessionId)) {
		throw new Error(`launch mode ${spec.mode} requires a sessionDir and a sessionId`);
	}

	// pi rejects --session together with --session-id, so exactly one form of
	// session addressing may appear.
	const sessionArgs = fileMode
		? ["--session", spec.sessionFile as string]
		: ["--session-dir", spec.sessionDir as string, "--session-id", spec.sessionId as string];

	return [
		...spec.invocation,
		"--provider",
		spec.provider,
		"--model",
		spec.model,
		"--thinking",
		spec.thinking,
		...sessionArgs,
		"--name",
		spec.tmuxSession,
		spec.trusted ? "--approve" : "--no-approve",
		"--extension",
		spec.extensionPath,
		`@${spec.promptPath}`,
	];
}

/** True when the mode addresses an existing session file instead of a new id. */
export function usesSessionFile(mode: LaunchMode): boolean {
	return SESSION_FILE_MODES.has(mode);
}

/** The v3 header pi writes for a new session. */
export function buildSessionHeader(options: {
	id: string;
	cwd: string;
	parentSession?: string;
	timestamp?: string;
}): Record<string, unknown> {
	const header: Record<string, unknown> = {
		type: "session",
		version: SESSION_VERSION,
		id: options.id,
		timestamp: options.timestamp ?? new Date().toISOString(),
		cwd: options.cwd,
	};
	if (options.parentSession) header.parentSession = options.parentSession;
	return header;
}

/** Count the newline-terminated entries in a JSONL session file. */
export async function countSessionLines(sessionFile: string): Promise<number> {
	const content = await readFile(sessionFile, "utf8");
	if (content.length === 0) return 0;
	const lines = content.split("\n");
	// A trailing newline yields a final empty element that is not an entry.
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/**
 * Seed an empty session file that records `parentSession` in its header.
 *
 * The file must exist before the child starts: `pi --session <missing>` would
 * otherwise silently create a fresh session and drop the lineage link.
 */
export async function seedLineageSession(options: {
	sessionFile: string;
	id?: string;
	cwd: string;
	parentSession: string;
}): Promise<{ sessionFile: string; id: string }> {
	const id = options.id ?? randomUUID();
	const header = buildSessionHeader({ id, cwd: options.cwd, parentSession: options.parentSession });
	await writeFile(options.sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return { sessionFile: options.sessionFile, id };
}

/** One ancestor-to-leaf slice of a parent transcript. */
export interface ParentBranchEntry {
	id: string;
	parentId: string | null;
	[key: string]: unknown;
}

export interface ForkResult {
	sessionFile: string;
	/** Entries inherited from the parent (excluding the new header). */
	inheritedEntries: number;
}

/**
 * Write a new session file seeded with the parent's LIVE branch.
 *
 * `branch` must be ordered ancestors-first with the live leaf LAST, because
 * the last non-header line is what pi adopts as the active leaf. The caller is
 * responsible for obtaining that ordering (pi's `SessionManager.getBranch()`
 * returns exactly this).
 */
export async function forkLiveBranch(options: {
	sessionFile: string;
	branch: ParentBranchEntry[];
	id?: string;
	cwd: string;
	parentSession: string;
}): Promise<ForkResult> {
	const id = options.id ?? randomUUID();
	const header = buildSessionHeader({ id, cwd: options.cwd, parentSession: options.parentSession });
	const body = options.branch.map((entry) => JSON.stringify(entry)).join("\n");
	const content = body.length > 0 ? `${JSON.stringify(header)}\n${body}\n` : `${JSON.stringify(header)}\n`;
	await writeFile(options.sessionFile, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return { sessionFile: options.sessionFile, inheritedEntries: options.branch.length };
}

/**
 * Guard for handing pi an existing file: `pi --session <missing-file>`
 * silently starts an empty session instead of failing, which would discard a
 * run's entire conversation without any error.
 */
export function requireExistingSession(sessionFile: string | undefined, runId: string): string {
	if (!sessionFile) {
		throw new Error(`Run ${runId} has no recorded sessionFile to resume; the run never reported one.`);
	}
	if (!existsSync(sessionFile)) {
		throw new Error(`Session file for run ${runId} is missing: ${sessionFile}`);
	}
	return sessionFile;
}