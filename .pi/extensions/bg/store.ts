// bg/store.ts — where a background job's state lives on disk.
//
// Layout, under the pi agent directory (`PI_CODING_AGENT_DIR`, else
// `~/.pi/agent`):
//
//   <agentDir>/bg-jobs/<sessionId>/<jobId>/job.json      metadata, atomic write
//   <agentDir>/bg-jobs/<sessionId>/<jobId>/output.log    combined stdout+stderr
//
// One directory per job rather than one index for the session, deliberately: two
// `start` calls fired without awaiting each other would race on a shared index,
// and a torn index loses every job at once. A job's own `job.json` is small,
// written once at start and once at settle, and replaced atomically
// (write-then-rename) so a reader never sees half a record. `<agentDir>` rather
// than `/tmp` because a container rebuild empties `/tmp`, and because a job
// belongs to the session that started it.
//
// Nothing here throws on a corrupt record: `readJobMeta` reports what it found
// and `listJobs` returns the readable jobs plus the problems it skipped, so the
// repair path (which runs on session start) can report and move on.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Directory under the pi agent dir that holds every session's job directories. */
export const BG_ROOT_DIRNAME = "bg-jobs";
/** Metadata file inside a job directory. Written atomically; see `writeJobMeta`. */
export const JOB_META_FILENAME = "job.json";
/** Combined stdout+stderr of the job, inside its job directory. */
export const JOB_LOG_FILENAME = "output.log";

/**
 * `running` until the process is observed gone; `exited` when it stopped on its
 * own; `killed` when the tool terminated it; `failed-to-start` when no process
 * ever existed for the job, so there is nothing to poll.
 */
export type BgJobState = "running" | "exited" | "killed" | "failed-to-start";

/**
 * One job, as persisted in `<jobDir>/job.json`.
 *
 * `pid` and `pgid` are equal for every job this extension starts: the spawn is
 * detached, so the child leads its own process group and one negative-pid signal
 * reaches the whole tree. They are separate fields because a record read back in
 * a later session is the only evidence of that group, and stating it beats
 * re-deriving it.
 *
 * `exitCode` is null while the job runs, when it was killed by a signal that left
 * no code, and for a job adopted after a restart — this process never reaped that
 * child, so no exit status exists to report. Null therefore means "not known",
 * never zero.
 */
export interface BgJobRecord {
	/** Eight hex characters, unique within the session. */
	id: string;
	sessionId: string;
	pid: number | null;
	pgid: number | null;
	/** The command exactly as the caller gave it. */
	command: string;
	cwd: string;
	logPath: string;
	state: BgJobState;
	exitCode: number | null;
	/** Epoch milliseconds. */
	startedAt: number;
	finishedAt: number | null;
	/** Why the job never started, when `state` is `failed-to-start`. */
	error?: string;
}

/** A job directory whose metadata could not be trusted. Reported, never thrown. */
export interface BgJobProblem {
	dir: string;
	error: string;
}

export type BgJobRead =
	| { ok: true; job: BgJobRecord }
	| { ok: false; reason: "missing" | "invalid" | "unreadable"; error: string };

const STATES: readonly BgJobState[] = ["running", "exited", "killed", "failed-to-start"];

/**
 * Session ids are uuids from pi, but the directory name comes from the session
 * manager and is joined into a path, so anything that is not plainly a name is
 * replaced rather than trusted. Two ids that differ only in replaced characters
 * would then collide, which pi's uuids cannot do.
 */
export function sessionDirName(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return safe.length > 0 ? safe : "session";
}

export function bgRootDir(): string {
	return path.join(getAgentDir(), BG_ROOT_DIRNAME);
}

export function sessionJobsDir(sessionId: string): string {
	return path.join(bgRootDir(), sessionDirName(sessionId));
}

export function jobDirFor(sessionId: string, id: string): string {
	return path.join(sessionJobsDir(sessionId), id);
}

export function metaPathFor(sessionId: string, id: string): string {
	return path.join(jobDirFor(sessionId, id), JOB_META_FILENAME);
}

export function logPathFor(sessionId: string, id: string): string {
	return path.join(jobDirFor(sessionId, id), JOB_LOG_FILENAME);
}

/** Create the session's job root. Called on session start, and by every start. */
export async function ensureSessionJobsDir(sessionId: string): Promise<string> {
	const dir = sessionJobsDir(sessionId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * Allocate a job directory, retrying if the name is taken.
 *
 * `mkdir` without `recursive` is the exclusivity test: it fails with EEXIST
 * rather than silently reusing another job's directory, which is what makes a
 * colliding id harmless instead of destructive. Anything else is a real error.
 */
export async function createJobDir(sessionId: string): Promise<{ id: string; dir: string }> {
	await ensureSessionJobsDir(sessionId);
	for (let attempt = 0; attempt < 8; attempt++) {
		const id = randomBytes(4).toString("hex");
		const dir = jobDirFor(sessionId, id);
		try {
			await mkdir(dir, { mode: 0o700 });
			return { id, dir };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error("could not allocate a unique job id after 8 attempts");
}

/**
 * Write a job's metadata atomically: a temp file in the same directory, then a
 * rename. A reader therefore sees the previous record or the new one, never a
 * truncated one — which matters because the watcher rewrites the record at settle
 * while `status` may be reading it.
 *
 * Two writers of the SAME record (the watcher settling, a kill recording its own
 * outcome) race only on which rename wins; neither can produce a torn file. That
 * is the whole concurrency argument for per-job files.
 */
export async function writeJobMeta(job: BgJobRecord): Promise<void> {
	const dir = jobDirFor(job.sessionId, job.id);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const target = path.join(dir, JOB_META_FILENAME);
	const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, target);
	} catch (error) {
		// Leaving a `.tmp` behind would be its own litter, and the next start in
		// this directory must not find a half-written record it cannot name.
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Read one job directory's metadata.
 *
 * A missing file is `missing` (normal: the directory was created but the spawn
 * failed before metadata landed); unparseable JSON or a record missing what it
 * cannot be interpreted without is `invalid`; anything else from the filesystem
 * is `unreadable`. All three are values, not exceptions.
 */
export async function readJobMeta(dir: string): Promise<BgJobRead> {
	let raw: string;
	try {
		raw = await readFile(path.join(dir, JOB_META_FILENAME), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, reason: "missing", error: "metadata file is missing" };
		return { ok: false, reason: "unreadable", error: error instanceof Error ? error.message : String(error) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { ok: false, reason: "invalid", error: `metadata is not valid JSON: ${(error as Error).message}` };
	}

	const job = normaliseRecord(parsed, dir);
	if (typeof job === "string") return { ok: false, reason: "invalid", error: job };
	return { ok: true, job };
}

/**
 * Turn a parsed record into a `BgJobRecord`, or explain what is wrong with it.
 *
 * The fields with no sane default are required. The rest are filled in, because a
 * record from an older build of this extension is worth reading rather than
 * discarding: `logPath` is derivable from the directory, and a missing
 * `exitCode`/`finishedAt` is exactly the null they would have been.
 */
function normaliseRecord(value: unknown, dir: string): BgJobRecord | string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "metadata is not a JSON object";
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) return "metadata has no id";
	if (typeof record.sessionId !== "string") return "metadata has no sessionId";
	if (typeof record.command !== "string") return "metadata has no command";
	if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return "metadata has no startedAt";
	const state = record.state;
	if (typeof state !== "string" || !STATES.includes(state as BgJobState)) {
		return `metadata has an unknown state: ${JSON.stringify(state)}`;
	}

	const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null;
	const exitCode = typeof record.exitCode === "number" && Number.isInteger(record.exitCode) ? record.exitCode : null;
	const finishedAt = typeof record.finishedAt === "number" && Number.isFinite(record.finishedAt) ? record.finishedAt : null;
	const job: BgJobRecord = {
		id: record.id,
		sessionId: record.sessionId,
		pid,
		pgid: typeof record.pgid === "number" && Number.isInteger(record.pgid) ? record.pgid : pid,
		command: record.command,
		cwd: typeof record.cwd === "string" ? record.cwd : "",
		logPath: typeof record.logPath === "string" ? record.logPath : path.join(dir, JOB_LOG_FILENAME),
		state: state as BgJobState,
		exitCode,
		startedAt: record.startedAt,
		finishedAt,
	};
	if (typeof record.error === "string") job.error = record.error;
	return job;
}

/** One job of this session, or undefined when the directory holds no readable record. */
export async function loadJob(sessionId: string, id: string): Promise<BgJobRecord | undefined> {
	const read = await readJobMeta(jobDirFor(sessionId, id));
	return read.ok ? read.job : undefined;
}

/**
 * Every readable job of this session, plus the directories that were skipped.
 *
 * Sorted oldest first: a listing that reorders itself between calls is harder to
 * read than one that only ever appends.
 */
export async function listJobs(sessionId: string): Promise<{ jobs: BgJobRecord[]; problems: BgJobProblem[] }> {
	let entries: string[];
	try {
		const dirents = await readdir(sessionJobsDir(sessionId), { withFileTypes: true });
		entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], problems: [] };
		throw error;
	}

	const jobs: BgJobRecord[] = [];
	const problems: BgJobProblem[] = [];
	for (const name of entries.sort()) {
		const dir = path.join(sessionJobsDir(sessionId), name);
		const read = await readJobMeta(dir);
		if (read.ok) jobs.push(read.job);
		else problems.push({ dir, error: `${read.reason}: ${read.error}` });
	}
	jobs.sort((a, b) => a.startedAt - b.startedAt);
	return { jobs, problems };
}

/**
 * The command's first line, trimmed — what every listing and notification shows.
 *
 * Whitespace-only or empty leading lines are skipped so a heredoc-style command
 * still shows something recognisable, and the result is capped so one long
 * command cannot push the rest of a listing off the screen.
 */
export function commandFirstLine(command: string, maxLength = 160): string {
	const first = command
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) return "(empty command)";
	return first.length > maxLength ? `${first.slice(0, maxLength - 1)}…` : first;
}

/**
 * "0s", "42s", "3m 7s" — the one duration shape every `bg` message uses.
 *
 * Lives here because three owners each wrote their own copy of it while the
 * tickets were built in parallel. Durations appear in listings, in kill's
 * no-op message and in the settle notice; one formatter keeps them identical.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/**
 * A job's state as prose: "still running", "exited (exit 3)", "killed",
 * "failed-to-start: <reason>".
 *
 * The single description of a record's state, for the same reason as
 * `formatDuration`: `kill` and the settle notice both have to say what happened,
 * and two spellings of the same fact read as two different facts.
 */
export function describeJobState(job: BgJobRecord): string {
	if (job.state === "failed-to-start") return job.error ? `failed-to-start: ${job.error}` : "failed-to-start";
	if (job.state === "running") return "still running";
	if (job.exitCode === null) return job.state;
	return `${job.state} (exit ${job.exitCode})`;
}

/**
 * One job's exit status as a column: "exit 0", "exit 7", "killed",
 * "killed (exit 7)", "exit unknown".
 *
 * Deliberately not `describeJobState`: the settle notice lists exit status per
 * job and has no room for a sentence, while `kill` answers a question about
 * state. Two projections of one record, both owned here so neither invents a
 * third spelling.
 */
export function exitSummary(job: BgJobRecord): string {
	if (job.state === "killed") return job.exitCode === null ? "killed" : `killed (exit ${job.exitCode})`;
	if (job.exitCode === null) return "exit unknown";
	return `exit ${job.exitCode}`;
}
