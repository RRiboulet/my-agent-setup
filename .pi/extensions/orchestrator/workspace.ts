/**
 * Workspace coordination: presence, reservations and the peer inbox.
 *
 * Scope. Sessions working in the same repository must see each other, including
 * sessions in linked worktrees. The only key that makes that true without
 * making unrelated projects share state is the repository's **git common
 * directory**: the main checkout's `.git` directory. A linked worktree's `.git`
 * is a file, but `git rev-parse --path-format=absolute --git-common-dir`
 * resolves it to the same main `.git`, so both trees share one store.
 *
 * The store lives at `<git-common-dir>/pi-agents/`, deliberately:
 *   - not in the working tree, so nothing here is git-visible and a checkout
 *     stays clean;
 *   - not in the agent directory, because that directory differs per project
 *     and the main checkout and its worktrees must share it.
 *
 * Files, not a database. Every record is one JSON file written atomically
 * (temp file in the same directory, then `rename`) and read whole. A reader
 * therefore sees either the previous complete record or the next complete one,
 * never a half-written file. Per-record files also mean concurrent joins and
 * heartbeats need no lock at all: they write different files.
 *
 * Where a shared decision needs read-modify-write — reserving a path is the
 * case — a directory-based lock (`mkdir` is atomic) serialises it. The lock is
 * advisory like the reservations themselves: a process that ignores the lock
 * can still write the same path. Reservations are explicitly not a security
 * boundary; shell commands and nested tool execution are not prevented. That
 * limit is stated in the tool descriptions and in every refusal.
 *
 * This module performs no pi work: the extension wires `pi.exec`, timers and
 * session events in `workspace-runtime.ts`, and the tests drive these functions
 * with a real `git` binary against real temp repositories.
 */

import { statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Bumped only when an older reader could misread a newer record. */
export const WORKSPACE_VERSION = 1;
/** One directory under the git common dir holds everything this feature owns. */
export const WORKSPACE_DIRNAME = "pi-agents";

export const PRESENCE_DIRNAME = "presence";
export const RESERVATIONS_DIRNAME = "reservations";
export const INBOX_DIRNAME = "inbox";
/** Delivered ids are kept under the recipient's inbox so one directory owns them. */
export const DELIVERED_DIRNAME = ".delivered";
export const LOCK_DIRNAME = "lock";

/**
 * Presence defaults. A heartbeat is a third of the TTL on purpose: two lost
 * beats still leave the entry live, while a killed process is gone within one
 * TTL instead of looking live forever.
 */
export const DEFAULT_PRESENCE_TTL_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 20_000;
export const MIN_PRESENCE_TTL_MS = 5_000;
export const MAX_PRESENCE_TTL_MS = 600_000;

/** A reservation is a working claim, not a lease on the file for a day. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60_000;
export const MIN_RESERVATION_TTL_MS = 5_000;
export const MAX_RESERVATION_TTL_MS = 24 * 60 * 60_000;

/** A peer message is short-lived: it is a nudge, not a mailbox. */
export const DEFAULT_MESSAGE_TTL_MS = 10 * 60_000;
export const MIN_MESSAGE_TTL_MS = 5_000;
export const MAX_MESSAGE_TTL_MS = 60 * 60_000;
export const MAX_MESSAGE_BODY_BYTES = 8 * 1024;
export const MAX_REASON_BYTES = 2 * 1024;
export const MAX_PRESENCE_PEERS = 200;

const LOCK_RETRY_MS = 15;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 15_000;

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

/** Injected so the extension supplies `pi.exec` and tests supply a real `git`. */
export type GitRun = (args: string[], cwd: string) => Promise<GitRunResult>;

// --- Scope -----------------------------------------------------------------

export interface WorkspaceScope {
	/** `<git-common-dir>/pi-agents` — the shared store. */
	registryDir: string;
	/** The absolute git common directory (the main checkout's `.git`). */
	commonDir: string;
	/** The session's working directory (a worktree or the main checkout). */
	cwd: string;
	/** Current branch short name, or `null` for a detached HEAD. */
	branch: string | null;
}

export type ScopeResult =
	| { ok: true; scope: WorkspaceScope }
	| { ok: false; reason: string };

/**
 * Resolve the shared store from a session's cwd.
 *
 * A failure here is a normal answer, not an error: outside a git repository the
 * whole feature is a no-op and the caller reports why (ticket 11's last
 * acceptance criterion). `--path-format=absolute` is load-bearing — without it
 * a linked worktree prints a path relative to the worktree, and the store would
 * land somewhere no other session looks.
 */
export async function resolveWorkspaceScope(cwd: string, run: GitRun): Promise<ScopeResult> {
	if (!cwd || !isAbsolute(cwd)) {
		return { ok: false, reason: `the session working directory is not absolute: ${cwd || "(empty)"}` };
	}
	let common: GitRunResult;
	try {
		common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	} catch (error) {
		// A failing git binary is a no-op with a reason, not a raw tool error; the
		// caller's contract is "outside a repository is reported", and a transport
		// failure is the same shape of answer.
		return { ok: false, reason: `git failed: ${(error as Error).message}` };
	}
	const commonDir = common.stdout.trim();
	if (common.code !== 0 || !commonDir) {
		const detail = common.stderr.trim().split("\n")[0];
		return {
			ok: false,
			reason: `not a git repository (${cwd})${detail ? `: ${detail}` : ""}`,
		};
	}
	if (!isAbsolute(commonDir)) {
		// A git old enough to ignore --path-format would land here; guessing would
		// write a registry relative to the caller's cwd, so refuse instead.
		return { ok: false, reason: `git returned a relative common directory: ${commonDir}` };
	}
	try {
		if (!statSync(commonDir).isDirectory()) {
			return { ok: false, reason: `the git common directory is not a directory: ${commonDir}` };
		}
	} catch {
		return { ok: false, reason: `the git common directory does not exist: ${commonDir}` };
	}
	const branch = await readBranch(cwd, run);
	return {
		ok: true,
		scope: { registryDir: join(commonDir, WORKSPACE_DIRNAME), commonDir, cwd, branch },
	};
}

async function readBranch(cwd: string, run: GitRun): Promise<string | null> {
	try {
		const symbolic = await run(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
		const name = symbolic.stdout.trim();
		if (symbolic.code === 0 && name) return name;
		const rev = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		const fallback = rev.stdout.trim();
		if (rev.code === 0 && fallback && fallback !== "HEAD") return fallback;
	} catch {
		// A detached HEAD or a git failure both mean "no branch name"; presence
		// does not depend on one.
	}
	return null;
}

export function presenceDir(registryDir: string): string {
	return join(registryDir, PRESENCE_DIRNAME);
}
export function reservationsDir(registryDir: string): string {
	return join(registryDir, RESERVATIONS_DIRNAME);
}
export function inboxDir(registryDir: string, sessionId: string): string {
	return join(registryDir, INBOX_DIRNAME, safeId(sessionId));
}
export function deliveredDir(registryDir: string, sessionId: string): string {
	return join(inboxDir(registryDir, sessionId), DELIVERED_DIRNAME);
}

// --- Small file primitives --------------------------------------------------

/**
 * A record id becomes a filename, so it is validated rather than trusted. pi
 * session ids are UUIDs; the slightly wider grammar accepts a test fixture id
 * without accepting `..` or a path separator.
 */
export function isSafeId(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function safeId(value: string): string {
	if (!isSafeId(value)) throw new Error(`unsafe workspace id: ${JSON.stringify(value)}`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

let tmpCounter = 0;

/** Atomic JSON write: a complete temp file in the same directory, then rename. */
export async function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.${basename(file)}.${process.pid}.${tmpCounter++}.tmp`);
	const handle = await open(tmp, "w", mode);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await rename(tmp, file);
	} catch (error) {
		await unlink(tmp).catch(() => undefined);
		throw error;
	}
}

type ReadJson =
	| { ok: true; value: unknown }
	| { ok: false; kind: "missing" | "invalid"; reason: string };

async function readJson(file: string): Promise<ReadJson> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { ok: false, kind: "missing", reason: "missing" };
		return { ok: false, kind: "invalid", reason: (error as Error).message };
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, kind: "invalid", reason: `not JSON: ${(error as Error).message}` };
	}
}

// --- Presence ---------------------------------------------------------------

export interface PresenceRecord {
	version: number;
	sessionId: string;
	pid: number;
	cwd: string;
	branch: string | null;
	joinedAt: number;
	lastSeenAt: number;
	/**
	 * The record carries its own TTL so a reader uses the writer's bound, not
	 * the reader's default. Two builds with different defaults can coexist.
	 */
	ttlMs: number;
}

export interface PresenceInput {
	sessionId: string;
	pid: number;
	cwd: string;
	branch: string | null;
	now: number;
	ttlMs?: number;
}

export function clampPresenceTtl(ttlMs: number): number {
	if (!Number.isFinite(ttlMs)) return DEFAULT_PRESENCE_TTL_MS;
	return Math.min(MAX_PRESENCE_TTL_MS, Math.max(MIN_PRESENCE_TTL_MS, Math.round(ttlMs)));
}

/**
 * A heartbeat period that always fits inside the TTL it refreshes. A per-join
 * `ttlSeconds` below the default would otherwise leave the record expired
 * between beats, and a peer's sweep would delete a live session.
 */
export function presenceHeartbeatMs(ttlMs: number, preferredMs: number): number {
	return Math.max(10, Math.min(preferredMs, Math.round(ttlMs / 3)));
}

export function buildPresence(input: PresenceInput): PresenceRecord {
	return {
		version: WORKSPACE_VERSION,
		sessionId: safeId(input.sessionId),
		pid: input.pid,
		cwd: input.cwd,
		branch: input.branch,
		joinedAt: input.now,
		lastSeenAt: input.now,
		ttlMs: clampPresenceTtl(input.ttlMs ?? DEFAULT_PRESENCE_TTL_MS),
	};
}

export function validatePresence(value: unknown): PresenceRecord | null {
	if (!isRecord(value)) return null;
	if (value.version !== WORKSPACE_VERSION) return null;
	if (typeof value.sessionId !== "string" || !isSafeId(value.sessionId)) return null;
	if (!finiteNumber(value.pid) || !finiteNumber(value.joinedAt) || !finiteNumber(value.lastSeenAt)) return null;
	if (!finiteNumber(value.ttlMs) || value.ttlMs <= 0) return null;
	if (typeof value.cwd !== "string" || !value.cwd) return null;
	if (value.branch !== null && typeof value.branch !== "string") return null;
	return {
		version: WORKSPACE_VERSION,
		sessionId: value.sessionId,
		pid: Math.trunc(value.pid),
		cwd: value.cwd,
		branch: value.branch,
		joinedAt: value.joinedAt,
		lastSeenAt: value.lastSeenAt,
		ttlMs: clampPresenceTtl(value.ttlMs),
	};
}

export function presencePath(registryDir: string, sessionId: string): string {
	return join(presenceDir(registryDir), `${safeId(sessionId)}.json`);
}

export function presenceIsLive(record: PresenceRecord, now: number): boolean {
	const age = now - record.lastSeenAt;
	// A beat a few seconds in the future is clock skew, not a reason to hide a
	// live peer; anything further is a corrupt or hostile record and expires.
	return age >= -5_000 && age <= record.ttlMs;
}

export async function writePresence(registryDir: string, record: PresenceRecord): Promise<void> {
	await writeJsonAtomic(presencePath(registryDir, record.sessionId), record);
}

export async function readPresence(registryDir: string, sessionId: string): Promise<PresenceRecord | null> {
	const read = await readJson(presencePath(registryDir, sessionId));
	if (!read.ok) return null;
	const record = validatePresence(read.value);
	// The filename is the identity; a record claiming another id is corruption,
	// not a peer.
	if (!record || record.sessionId !== sessionId) return null;
	return record;
}

/** Rewrite the record with a fresh heartbeat. A vanished record is recreated. */
export async function touchPresence(
	registryDir: string,
	record: PresenceRecord,
	now: number,
): Promise<PresenceRecord> {
	const next: PresenceRecord = { ...record, lastSeenAt: now };
	await writePresence(registryDir, next);
	return next;
}

export interface PresenceList {
	/** Live entries, newest heartbeat first. Includes the caller; it filters. */
	peers: PresenceRecord[];
	/** Files removed because their TTL passed or their pid is gone. */
	expired: PresenceRecord[];
	/** Files that exist but do not parse as this version's record. */
	invalid: string[];
}

/**
 * List live peers and sweep expired records.
 *
 * `pid` is a fast path, not the authority: a killed session's pid usually stops
 * existing, so its record can go immediately rather than waiting out the TTL.
 * A recycled pid or a permission error simply leaves the record to the TTL,
 * which is still correct because `presenceIsLive` uses the timestamp.
 */
export async function listPresence(registryDir: string, now: number): Promise<PresenceList> {
	const result: PresenceList = { peers: [], expired: [], invalid: [] };
	const dir = presenceDir(registryDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		const sessionId = name.slice(0, -".json".length);
		if (!isSafeId(sessionId)) continue;
		const read = await readJson(join(dir, name));
		if (!read.ok) {
			if (read.kind === "invalid") result.invalid.push(name);
			continue;
		}
		const record = validatePresence(read.value);
		if (!record || record.sessionId !== sessionId) {
			result.invalid.push(name);
			continue;
		}
		if (!presenceIsLive(record, now) || !pidLooksAlive(record.pid)) {
			await unlink(join(dir, name)).catch(() => undefined);
			result.expired.push(record);
			continue;
		}
		result.peers.push(record);
	}
	result.peers.sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.sessionId.localeCompare(b.sessionId));
	if (result.peers.length > MAX_PRESENCE_PEERS) result.peers.length = MAX_PRESENCE_PEERS;
	return result;
}

function pidLooksAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but belongs to someone else; that is alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// --- The lock ---------------------------------------------------------------

export class WorkspaceLockError extends Error {
	readonly lockDir: string;
	constructor(lockDir: string) {
		super(`workspace lock is held: ${lockDir}`);
		this.name = "WorkspaceLockError";
		this.lockDir = lockDir;
	}
}

export function lockDir(registryDir: string): string {
	return join(registryDir, LOCK_DIRNAME);
}

/**
 * Run `fn` while holding the workspace lock.
 *
 * `mkdir` is atomic on every filesystem this repository runs on, so exactly one
 * contender creates the directory. A holder that dies leaves the directory;
 * after `staleMs` the next contender renames it aside and removes it, which is
 * also atomic, so two sweepers cannot both win.
 */
export async function withWorkspaceLock<T>(
	registryDir: string,
	fn: () => Promise<T>,
	options: { now?: () => number; timeoutMs?: number; staleMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<T> {
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const dir = lockDir(registryDir);
	const deadline = now() + timeoutMs;
	await mkdir(registryDir, { recursive: true, mode: 0o700 });
	for (;;) {
		try {
			await mkdir(dir, { recursive: false, mode: 0o700 });
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			await breakStaleLock(dir, now, staleMs);
			if (now() >= deadline) throw new WorkspaceLockError(dir);
			await sleep(LOCK_RETRY_MS);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function breakStaleLock(dir: string, now: () => number, staleMs: number): Promise<void> {
	try {
		const info = await stat(dir);
		if (now() - info.mtimeMs <= staleMs) return;
	} catch {
		return; // it went away; the next mkdir attempt is the race and it is safe
	}
	const aside = `${dir}.stale.${process.pid}.${tmpCounter++}`;
	try {
		await rename(dir, aside);
	} catch {
		return; // another contender swept it first
	}
	await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}
