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

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Bumped only when an older reader could misread a newer record. */
export const WORKSPACE_VERSION = 1;
/**
 * Reservations version separately from presence and messages, and had to: a
 * v1 reservation is a bare absolute path, while a v2 one carries the namespace
 * its patterns live in. Bumping the shared version instead would also invalidate
 * every presence entry and undelivered peer message for a session on the other
 * build. A build that predates the field ignores a v2 record (an unknown
 * version is unusable, so it blocks nothing) rather than misreading a
 * shared-root pattern as a concrete absolute path.
 */
export const RESERVATION_VERSION = 2;
/** v2 added `scope` and `root`; a v1 record is a worktree-scoped claim. */
const RESERVATION_VERSION_LEGACY = 1;
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
	/**
	 * The session's own worktree top level (`git rev-parse --show-toplevel`, made
	 * canonical). This is the root a `"repo"` lock scope makes paths relative to,
	 * so it must be the worktree rather than the common dir: two linked worktrees
	 * have one common dir and two roots.
	 */
	root: string;
	/**
	 * The main checkout's root — the directory that owns the git common dir, and
	 * therefore the one namespace every linked worktree can map into.
	 */
	sharedRoot: string;
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
	// The branch is display metadata; a failed branch read must not turn a valid
	// repository into a no-op join.
	const branch = await readWorkspaceBranch(cwd, run).catch(() => null);
	// The root is load-bearing for a `"repo"` lock scope, but a failed read must
	// not turn a valid repository into a no-op: the session's cwd is the honest
	// fallback, and a worktree-scoped reservation ignores the value entirely.
	const topLevel = await readWorkspaceTopLevel(cwd, run);
	const root = canonicalPath(cwd, topLevel ?? ".");
	// Both sides of a repo-scoped comparison are spelled from this string, so it
	// is canonicalised too: a symlinked checkout would otherwise make the main
	// tree's identity differ from its own worktrees'.
	const sharedRoot = canonicalPath(commonDir, dirname(commonDir));
	return {
		ok: true,
		scope: { registryDir: join(commonDir, WORKSPACE_DIRNAME), commonDir, cwd, root, sharedRoot, branch },
	};
}

/** The worktree top level, or `null` when git cannot name one. */
async function readWorkspaceTopLevel(cwd: string, run: GitRun): Promise<string | null> {
	try {
		const top = await run(["rev-parse", "--show-toplevel"], cwd);
		const value = top.stdout.trim();
		return top.code === 0 && value && isAbsolute(value) ? value : null;
	} catch {
		return null;
	}
}

export async function readWorkspaceBranch(cwd: string, run: GitRun): Promise<string | null> {
	// A detached HEAD is `null`; a git that failed to run throws. The caller's
	// heartbeat keeps the last known branch on a throw, but must be able to
	// distinguish that from a genuine detached HEAD.
	const symbolic = await run(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
	const name = symbolic.stdout.trim();
	if (symbolic.code === 0 && name) return name;
	const rev = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	const fallback = rev.stdout.trim();
	if (rev.code === 0 && fallback && fallback !== "HEAD") return fallback;
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
	/** Live peers dropped by MAX_PRESENCE_PEERS (oldest heartbeat first). */
	truncated: number;
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
	const result: PresenceList = { peers: [], expired: [], invalid: [], truncated: 0 };
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
		const file = join(dir, name);
		const read = await readJson(file);
		if (!read.ok) {
			if (read.kind === "invalid" && (await sweepOldInvalidPresence(file, now))) continue;
			if (read.kind === "invalid") result.invalid.push(name);
			continue;
		}
		const record = validatePresence(read.value);
		if (!record || record.sessionId !== sessionId) {
			// A newer build's record is unknown, not corrupt. Leave it while its
			// mtime is recent; a stale one is swept like any other dead record.
			if (await sweepOldInvalidPresence(file, now)) continue;
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
	if (result.peers.length > MAX_PRESENCE_PEERS) {
		result.truncated = result.peers.length - MAX_PRESENCE_PEERS;
		result.peers.length = MAX_PRESENCE_PEERS;
	}
	return result;
}

/**
 * Remove an unparsable presence file once it is old enough that no live writer
 * can still own it. A future-version peer heartbeats (updating the mtime), so it
 * survives; a corrupt file left by a crash is eventually cleaned instead of
 * being re-reported forever.
 */
async function sweepOldInvalidPresence(file: string, now: number): Promise<boolean> {
	try {
		const info = await stat(file);
		if (now - info.mtimeMs <= MAX_PRESENCE_TTL_MS) return false;
		// Re-stat immediately before unlinking: a writer may have renamed a fresh
		// record over this path since the first look. Not airtight, but it shrinks
		// the window to the unlink syscall.
		const again = await stat(file);
		if (again.mtimeMs !== info.mtimeMs) return false;
		await unlink(file);
		return true;
	} catch {
		// A file that cannot be removed stays visible in `invalid`; silently
		// claiming it was swept would hide the problem forever.
		return false;
	}
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
interface LockOwner {
	token: string;
	pid: number;
	at: number;
}

function ownerPath(dir: string): string {
	return join(dir, "owner.json");
}

async function readLockOwner(dir: string): Promise<LockOwner | null> {
	const read = await readJson(ownerPath(dir));
	if (!read.ok || !isRecord(read.value)) return null;
	const { token, pid, at } = read.value;
	if (typeof token !== "string" || !token || !finiteNumber(pid) || !finiteNumber(at)) return null;
	return { token, pid, at };
}

/**
 * Release only the lock this call owns.
 *
 * A stale sweep may have broken the lock and another holder may own the same
 * path by the time this runs. Deleting by path alone would then remove *their*
 * lock and let a third process in — the mutual-exclusion hole this check
 * exists to close. Rename first so the removal is still atomic.
 */
async function releaseLock(dir: string, token: string): Promise<void> {
	const owner = await readLockOwner(dir);
	if (!owner || owner.token !== token) return;
	const aside = `${dir}.release.${process.pid}.${tmpCounter++}`;
	try {
		await rename(dir, aside);
	} catch {
		return;
	}
	await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

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
	const token = `${process.pid}-${randomUUID()}`;
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
	// The owner file makes release ownership-checked. It is written immediately
	// after mkdir, before the critical section, so a contender that sees EEXIST
	// in that window waits on a fresh mtime rather than breaking a live lock.
	try {
		await writeJsonAtomic(ownerPath(dir), { token, pid: process.pid, at: Date.now() });
	} catch (error) {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	// Refresh the mtime while the section runs: "stale" then means the holder
	// stopped refreshing (crashed or wedged), not "the section took a while".
	// A short section would never notice; a long one should not be broken.
	const refresh = setInterval(() => {
		const at = new Date();
		void utimes(dir, at, at).catch(() => undefined);
	}, Math.max(10, Math.round(staleMs / 3)));
	refresh.unref?.();
	try {
		return await fn();
	} finally {
		clearInterval(refresh);
		await releaseLock(dir, token).catch(() => undefined);
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

// --- Reservations -----------------------------------------------------------

export type ReservationKind = "file" | "dir" | "glob";

/**
 * Which namespace a record's patterns live in. Kept as a string union rather
 * than imported from `config.ts` so the store does not depend on the reader;
 * the two spellings are the same two values.
 */
export type ReservationScope = "worktree" | "repo";

export interface ReservationPath {
	/** Absolute, canonical path. A glob keeps its `*`/`?` characters. */
	pattern: string;
	kind: ReservationKind;
}

export interface ReservationRecord {
	version: number;
	id: string;
	sessionId: string;
	/**
	 * The process that held it. Absent on records written before this field.
	 * A reservation is held by a live process, not by the file: once the pid is
	 * gone the claim stops blocking, so a killed writer cannot hold a path for its
	 * full TTL.
	 */
	pid?: number;
	cwd: string;
	branch: string | null;
	/**
	 * Which namespace `paths` is in. `"worktree"` (the default) means the paths
	 * are canonical absolute paths in the reserving session's own tree;
	 * `"repo"` means they were mapped into `sharedRoot` before storage, so every
	 * worktree compares the same repository-relative path.
	 */
	scope: ReservationScope;
	/**
	 * The reserving session's worktree root. A `"repo"` record's patterns are
	 * already shared-root based, but a `"worktree"` record has no other way to
	 * be mapped into the shared namespace later, and the record outlives the
	 * session that wrote it.
	 */
	root: string;
	paths: ReservationPath[];
	reason: string;
	createdAt: number;
	expiresAt: number;
}

export interface ReservationConflict {
	reservation: ReservationRecord;
	path: ReservationPath;
}

/**
 * Canonicalise a concrete path through the deepest existing ancestor. That is
 * what makes `./src/x`, `/repo/src/x`, and a symlinked spelling of the same file
 * compare equal; `realpath` on the whole path cannot be used because the file
 * being reserved often does not exist yet.
 */
export function canonicalPath(cwd: string, input: string): string {
	const absolute = resolve(cwd, input);
	let probe = absolute;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = realpathSync.native(probe);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(probe);
			if (parent === probe) return absolute;
			tail.push(basename(probe));
			probe = parent;
		}
	}
}

function hasGlob(input: string): boolean {
	return input.includes("*") || input.includes("?");
}

// --- Lock-scope path mapping ------------------------------------------------
//
// A reservation is compared in one namespace, chosen by the config's
// `workspace.lockScope`. The default (`"worktree"`) is the canonical absolute
// path this module always used, so linked worktrees never collide. `"repo"`
// makes the path relative to the reserving worktree and re-anchors it at the
// shared root (the main checkout), which is the one spelling every linked
// worktree can agree on.
//
// A path outside the worktree has no repository-relative form, so it keeps its
// absolute pattern: `../../secrets` does not acquire cross-tree meaning just
// because a project asked for repository-wide locking.

/**
 * The path relative to `root`, or `null` when it is outside it (or not
 * absolute). Textual only — the file need not exist, and a glob is a string like
 * any other, so `src/*.ts` maps exactly as a concrete path would.
 */
export function repoRelative(root: string, absolute: string): string | null {
	if (!root || !isAbsolute(absolute)) return null;
	const relativePath = relative(root, absolute);
	if (relativePath === "") return ".";
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
	return relativePath;
}

/**
 * Re-anchor an absolute path from `root`'s tree at `sharedRoot`. A path outside
 * `root` is returned unchanged, which is what makes it stay absolute.
 */
export function mapToSharedRoot(root: string, sharedRoot: string, absolute: string): string {
	const relativePath = repoRelative(root, absolute);
	if (relativePath === null) return absolute;
	if (relativePath === ".") return sharedRoot;
	return join(sharedRoot, relativePath);
}

/** Options that decide which namespace a built pattern is stored in. */
export interface ReservationPathOptions {
	scope?: ReservationScope;
	/** The session's worktree root; required for `"repo"`. */
	root?: string;
	/** The main checkout root; required for `"repo"`. */
	sharedRoot?: string;
}

function scopePattern(path: ReservationPath, options: ReservationPathOptions): ReservationPath {
	if (options.scope !== "repo" || !options.root || !options.sharedRoot) return path;
	const pattern = mapToSharedRoot(options.root, options.sharedRoot, path.pattern);
	return pattern === path.pattern ? path : { pattern, kind: path.kind };
}

/** Classify and canonicalise one user-supplied path. */
export function buildReservationPath(cwd: string, input: string, options: ReservationPathOptions = {}): ReservationPath {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("a reservation path may not be empty");
	if (hasGlob(trimmed)) {
		// Canonicalise only the static prefix, then put the glob back. Resolving
		// the whole thing would fail on the `*`, and dropping it would let two
		// spellings of the static directory reserve different regions.
		const cut = trimmed.search(/[*?]/);
		const prefix = trimmed.slice(0, cut);
		const rest = trimmed.slice(cut);
		const base = canonicalPath(cwd, prefix || ".");
		// A prefix that ends mid-segment (`src/fi*`) must not get a separator; an
		// empty prefix and a directory prefix both must.
		const needsSep = !base.endsWith(sep) && (prefix === "" || prefix.endsWith("/"));
		return scopePattern({ pattern: `${base}${needsSep ? sep : ""}${rest}`.replace(/\/+/g, "/"), kind: "glob" }, options);
	}
	const canonical = canonicalPath(cwd, trimmed);
	const wantsDir = trimmed.endsWith("/") || trimmed === "." || trimmed === "..";
	let isDir = wantsDir;
	try {
		isDir = lstatSync(canonical).isDirectory();
	} catch {
		// Missing path: a trailing slash is the only signal that it is a directory.
	}
	return scopePattern({ pattern: canonical, kind: isDir ? "dir" : "file" }, options);
}

export function buildReservationPaths(
	cwd: string,
	inputs: string[],
	options: ReservationPathOptions = {},
): ReservationPath[] {
	const seen = new Set<string>();
	const paths: ReservationPath[] = [];
	for (const input of inputs) {
		const built = buildReservationPath(cwd, input, options);
		const key = `${built.kind}:${built.pattern}`;
		if (seen.has(key)) continue;
		seen.add(key);
		paths.push(built);
	}
	return paths;
}

function escapeRegExp(char: string): string {
	return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` stays inside one path segment; `**` crosses segments; `**` followed by a separator may match zero segments. */
export function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				i++;
				if (pattern[i + 1] === sep) {
					source += "(?:.*/)?";
					i++;
				} else {
					source += ".*";
				}
			} else {
				source += `[^${escapeRegExp(sep)}]*`;
			}
		} else if (char === "?") {
			source += `[^${escapeRegExp(sep)}]`;
		} else {
			source += escapeRegExp(char);
		}
	}
	return new RegExp(`${source}$`);
}

export function reservationPathMatches(path: ReservationPath, candidate: string): boolean {
	if (path.kind === "glob") return globToRegExp(path.pattern).test(candidate);
	if (path.kind === "dir") return candidate === path.pattern || candidate.startsWith(path.pattern + sep);
	return candidate === path.pattern;
}

export function reservationMatches(record: ReservationRecord, candidate: string): boolean {
	return record.paths.some((path) => reservationPathMatches(path, candidate));
}

/** The writer's own position, which decides how its candidate is re-anchored. */
export interface ReservationWriter {
	root: string;
	sharedRoot: string;
}

/**
 * The candidate in the **holder's** namespace: the hook that makes a
 * repository-scoped claim enforceable against a writer that never opted in.
 *
 * A worktree-scoped holder compares the canonical absolute path, exactly as
 * before. A repo-scoped holder's patterns are shared-root based, so the
 * writer's candidate is made relative to the writer's own worktree and
 * re-anchored at the shared root — the same relative path in two linked trees
 * then compares equal. A candidate outside the writer's worktree keeps its
 * absolute form and therefore cannot match a repo claim.
 */
export function reservationCandidateFor(
	record: ReservationRecord,
	candidate: string,
	writer: ReservationWriter,
): string {
	if (record.scope !== "repo") return candidate;
	return mapToSharedRoot(writer.root, writer.sharedRoot, candidate);
}

/**
 * One conflict check needs both sides in the same namespace, and only the repo
 * side knows which namespace that is. A worktree record is mapped through the
 * root it stored; a worktree request through the root it has now.
 */
function reservationComparisonPair(
	request: { scope: ReservationScope; root: string; sharedRoot?: string },
	record: ReservationRecord,
	requestPaths: ReservationPath[],
): { requestPaths: ReservationPath[]; holderPaths: ReservationPath[] } {
	if (request.scope === record.scope || !request.sharedRoot) {
		return { requestPaths, holderPaths: record.paths };
	}
	const sharedRoot = request.sharedRoot;
	const toShared = (paths: ReservationPath[], root: string): ReservationPath[] =>
		paths.map((path) => ({ pattern: mapToSharedRoot(root, sharedRoot, path.pattern), kind: path.kind }));
	return request.scope === "repo"
		? { requestPaths, holderPaths: toShared(record.paths, record.root) }
		: { requestPaths: toShared(requestPaths, request.root), holderPaths: record.paths };
}

function within(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent + sep);
}

/**
 * Do two reservation scopes overlap?
 *
 * Deliberately conservative for globs: a literal glob-overlap decision is a
 * different problem (regex intersection), and this is an advisory collision
 * check. Rejecting two wildcards with overlapping static prefixes is a cheap
 * false conflict; missing a real one is the expensive mistake.
 */
export function reservationPathsOverlap(a: ReservationPath, b: ReservationPath): boolean {
	if (a.pattern === b.pattern) return true;
	if (a.kind === "glob" || b.kind === "glob") {
		const aStatic = a.pattern.split(/[*?]/)[0]!;
		const bStatic = b.pattern.split(/[*?]/)[0]!;
		if (a.kind === "glob" && b.kind === "glob") {
			return within(aStatic, bStatic) || within(bStatic, aStatic) || within(a.pattern, b.pattern) || within(b.pattern, a.pattern);
		}
		const concrete = a.kind === "glob" ? b : a;
		const glob = a.kind === "glob" ? a : b;
		if (reservationPathMatches(glob, concrete.pattern)) return true;
		if (concrete.kind === "dir" && within(glob.pattern.split(/[*?]/)[0]!, concrete.pattern)) return true;
		return within(concrete.pattern, glob.pattern.split(/[*?]/)[0]!);
	}
	if (a.kind === "dir") return within(b.pattern, a.pattern);
	if (b.kind === "dir") return within(a.pattern, b.pattern);
	return false;
}

export function validateReservation(value: unknown): ReservationRecord | null {
	if (!isRecord(value)) return null;
	if (value.version !== RESERVATION_VERSION && value.version !== RESERVATION_VERSION_LEGACY) return null;
	if (typeof value.id !== "string" || !isSafeId(value.id)) return null;
	if (typeof value.sessionId !== "string" || !isSafeId(value.sessionId)) return null;
	if (typeof value.cwd !== "string" || !value.cwd) return null;
	if (value.branch !== null && typeof value.branch !== "string") return null;
	if (typeof value.reason !== "string" || !value.reason) return null;
	if (value.pid !== undefined && !finiteNumber(value.pid)) return null;
	if (!finiteNumber(value.createdAt) || !finiteNumber(value.expiresAt)) return null;
	if (!Array.isArray(value.paths) || value.paths.length === 0) return null;
	// A v1 record predates the scope field, and its paths are canonical absolute
	// paths: reading it as worktree-scoped with its own cwd as the root is the
	// only honest interpretation, and no migration write is needed.
	let scope: ReservationScope = "worktree";
	let root = value.cwd;
	if (value.version === RESERVATION_VERSION) {
		if (value.scope !== "worktree" && value.scope !== "repo") return null;
		if (typeof value.root !== "string" || !isAbsolute(value.root)) return null;
		scope = value.scope;
		root = value.root;
	}
	const paths: ReservationPath[] = [];
	for (const raw of value.paths) {
		if (!isRecord(raw)) return null;
		if (raw.kind !== "file" && raw.kind !== "dir" && raw.kind !== "glob") return null;
		if (typeof raw.pattern !== "string" || !isAbsolute(raw.pattern)) return null;
		paths.push({ pattern: raw.pattern, kind: raw.kind });
	}
	return {
		version: RESERVATION_VERSION,
		id: value.id,
		sessionId: value.sessionId,
		...(value.pid === undefined ? {} : { pid: Math.trunc(value.pid) }),
		cwd: value.cwd,
		branch: value.branch,
		scope,
		root,
		paths,
		reason: value.reason.slice(0, MAX_REASON_BYTES),
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
	};
}

export function reservationPath(registryDir: string, id: string): string {
	return join(reservationsDir(registryDir), `${safeId(id)}.json`);
}

/** Read every record without taking the lock; expiry is decided by the caller. */
export async function readReservations(registryDir: string): Promise<{ reservations: ReservationRecord[]; invalid: string[] }> {
	const dir = reservationsDir(registryDir);
	const invalid: string[] = [];
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reservations: [], invalid };
		throw error;
	}
	const reservations: ReservationRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		const read = await readJson(join(dir, name));
		if (!read.ok) {
			if (read.kind === "invalid") invalid.push(name);
			continue;
		}
		const record = validateReservation(read.value);
		if (!record || `${record.id}.json` !== name) {
			invalid.push(name);
			continue;
		}
		reservations.push(record);
	}
	return { reservations, invalid };
}

/** Sweep under the lock. Only the mutating paths call this. */
async function sweepReservationsLocked(registryDir: string, now: number): Promise<ReservationRecord[]> {
	const { reservations } = await readReservations(registryDir);
	const expired: ReservationRecord[] = [];
	for (const record of reservations) {
		if (record.expiresAt <= now || (record.pid !== undefined && !pidLooksAlive(record.pid))) {
			await unlink(reservationPath(registryDir, record.id)).catch(() => undefined);
			expired.push(record);
		}
	}
	return expired;
}

export interface ReserveRequest {
	sessionId: string;
	/** Defaults to this process; tests use a dead pid to exercise the sweep. */
	pid?: number;
	cwd: string;
	branch: string | null;
	/**
	 * Reserved patterns **already in this request's namespace**: canonical
	 * absolute for `"worktree"`, shared-root based for `"repo"`. The caller
	 * builds them with `buildReservationPaths` and the same options, so the store
	 * does not remap a pattern the caller already placed.
	 */
	paths: ReservationPath[];
	reason: string;
	now: number;
	ttlMs?: number;
	/** Defaults to `"worktree"`, the behaviour that shipped before the key. */
	scope?: ReservationScope;
	/** The reserving session's worktree root; defaults to `cwd`. */
	root?: string;
	/** The main checkout root, needed to compare with a worktree-scoped record. */
	sharedRoot?: string;
}

export type ReserveResult =
	| { ok: true; reservation: ReservationRecord; expired: ReservationRecord[]; replaced: ReservationRecord[] }
	| { ok: false; conflicts: ReservationConflict[]; expired: ReservationRecord[] };

export function clampReservationTtl(ttlMs: number): number {
	if (!Number.isFinite(ttlMs)) return DEFAULT_RESERVATION_TTL_MS;
	return Math.min(MAX_RESERVATION_TTL_MS, Math.max(MIN_RESERVATION_TTL_MS, Math.round(ttlMs)));
}

/**
 * Reserve paths under the shared lock.
 *
 * The lock is what makes "two reservers cannot both believe they hold the same
 * path" true: the check and the write are one critical section. The records are
 * still advisory — anything outside this extension may write the file.
 */
export async function reservePaths(registryDir: string, request: ReserveRequest): Promise<ReserveResult> {
	if (request.paths.length === 0) throw new Error("a reservation needs at least one path");
	const reason = request.reason.trim();
	if (!reason) throw new Error("a reservation needs a non-empty reason");
	const now = request.now;
	const expiresAt = now + clampReservationTtl(request.ttlMs ?? DEFAULT_RESERVATION_TTL_MS);
	const scope: ReservationScope = request.scope === "repo" ? "repo" : "worktree";
	const root = request.root ?? request.cwd;
	const comparison = { scope, root, ...(request.sharedRoot ? { sharedRoot: request.sharedRoot } : {}) };
	return withWorkspaceLock(registryDir, async () => {
		const expired = await sweepReservationsLocked(registryDir, now);
		const { reservations } = await readReservations(registryDir);
		const conflicts: ReservationConflict[] = [];
		for (const reservation of reservations) {
			if (reservation.sessionId === request.sessionId) continue;
			const pair = reservationComparisonPair(comparison, reservation, request.paths);
			for (const path of pair.requestPaths) {
				const index = pair.holderPaths.findIndex((held) => reservationPathsOverlap(held, path));
				// The holder's own pattern is reported, not the mapped one: a refusal
				// should name the path the holder actually reserved in its own tree.
				if (index >= 0) conflicts.push({ reservation, path: reservation.paths[index] ?? pair.holderPaths[index]! });
			}
		}
		if (conflicts.length > 0) return { ok: false, conflicts, expired };
		// Re-reserving is how a session extends or widens its own claim. Supersede
		// its overlapping records in the same critical section rather than leaving
		// every earlier TTL behind as a duplicate that list shows and peers trip on.
		// The same namespace comparison applies: a session that changed lock scope
		// must not leave a stale claim behind in the other namespace.
		const replaced: ReservationRecord[] = [];
		for (const reservation of reservations) {
			if (reservation.sessionId !== request.sessionId) continue;
			const pair = reservationComparisonPair(comparison, reservation, request.paths);
			const overlaps = pair.holderPaths.some((held) => pair.requestPaths.some((path) => reservationPathsOverlap(held, path)));
			if (!overlaps) continue;
			await unlink(reservationPath(registryDir, reservation.id)).catch(() => undefined);
			replaced.push(reservation);
		}
		const reservation: ReservationRecord = {
			version: RESERVATION_VERSION,
			id: randomUUID(),
			sessionId: safeId(request.sessionId),
			pid: request.pid ?? process.pid,
			cwd: request.cwd,
			branch: request.branch,
			scope,
			root,
			paths: request.paths,
			reason: reason.slice(0, MAX_REASON_BYTES),
			createdAt: now,
			expiresAt,
		};
		await writeJsonAtomic(reservationPath(registryDir, reservation.id), reservation);
		return { ok: true, reservation, expired, replaced };
	});
}

export interface ReleaseResult {
	released: ReservationRecord[];
	expired: ReservationRecord[];
}

/** Release one reservation by id, or every reservation this session holds. */
export async function releaseReservations(
	registryDir: string,
	request: { sessionId: string; id?: string; now: number },
): Promise<ReleaseResult> {
	return withWorkspaceLock(registryDir, async () => {
		const expired = await sweepReservationsLocked(registryDir, request.now);
		const { reservations } = await readReservations(registryDir);
		const released: ReservationRecord[] = [];
		for (const reservation of reservations) {
			if (reservation.sessionId !== request.sessionId) continue;
			if (request.id !== undefined && reservation.id !== request.id) continue;
			await unlink(reservationPath(registryDir, reservation.id)).catch(() => undefined);
			released.push(reservation);
		}
		return { released, expired };
	});
}

export interface LiveReservations {
	live: ReservationRecord[];
	expired: ReservationRecord[];
	invalid: string[];
}

/** Expiry is read-time truth: a TTL that passed stops blocking even before a sweep. */
export function partitionReservations(
	records: ReservationRecord[],
	now: number,
): { live: ReservationRecord[]; expired: ReservationRecord[] } {
	const live: ReservationRecord[] = [];
	const expired: ReservationRecord[] = [];
	for (const record of records) {
		const deadHolder = record.pid !== undefined && !pidLooksAlive(record.pid);
		if (record.expiresAt > now && !deadHolder) live.push(record);
		else expired.push(record);
	}
	return { live, expired };
}

/** The guard's hot path: no lock, no sweep, expiry filtered in memory. */
export async function liveReservations(registryDir: string, now: number): Promise<LiveReservations> {
	const { reservations, invalid } = await readReservations(registryDir);
	const { live, expired } = partitionReservations(reservations, now);
	if (expired.length > 0) {
		await withWorkspaceLock(registryDir, async () => {
			for (const record of expired) {
				await unlink(reservationPath(registryDir, record.id)).catch(() => undefined);
			}
		}).catch(() => undefined);
	}
	return { live, expired, invalid };
}

// --- Peer messages ----------------------------------------------------------

export interface PeerMessage {
	version: number;
	id: string;
	from: { sessionId: string; cwd: string; branch: string | null };
	to: string;
	body: string;
	createdAt: number;
	expiresAt: number;
}

export interface SendMessageRequest {
	id?: string;
	sessionId: string;
	cwd: string;
	branch: string | null;
	to: string;
	body: string;
	now: number;
	ttlMs?: number;
}

export function clampMessageTtl(ttlMs: number): number {
	if (!Number.isFinite(ttlMs)) return DEFAULT_MESSAGE_TTL_MS;
	return Math.min(MAX_MESSAGE_TTL_MS, Math.max(MIN_MESSAGE_TTL_MS, Math.round(ttlMs)));
}

export function buildPeerMessage(request: SendMessageRequest): PeerMessage {
	const body = request.body.trim();
	if (!body) throw new Error("a peer message needs a non-empty body");
	if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BODY_BYTES) {
		throw new Error(`a peer message may be at most ${MAX_MESSAGE_BODY_BYTES} bytes`);
	}
	return {
		version: WORKSPACE_VERSION,
		id: request.id ?? randomUUID(),
		from: { sessionId: safeId(request.sessionId), cwd: request.cwd, branch: request.branch },
		to: safeId(request.to),
		body,
		createdAt: request.now,
		expiresAt: request.now + clampMessageTtl(request.ttlMs ?? DEFAULT_MESSAGE_TTL_MS),
	};
}

export function validatePeerMessage(value: unknown): PeerMessage | null {
	if (!isRecord(value)) return null;
	if (value.version !== WORKSPACE_VERSION) return null;
	if (typeof value.id !== "string" || !isSafeId(value.id)) return null;
	if (typeof value.body !== "string" || !value.body.trim()) return null;
	if (Buffer.byteLength(value.body, "utf8") > MAX_MESSAGE_BODY_BYTES) return null;
	if (typeof value.to !== "string" || !isSafeId(value.to)) return null;
	if (!finiteNumber(value.createdAt) || !finiteNumber(value.expiresAt)) return null;
	if (!isRecord(value.from)) return null;
	if (typeof value.from.sessionId !== "string" || !isSafeId(value.from.sessionId)) return null;
	if (typeof value.from.cwd !== "string" || !value.from.cwd) return null;
	if (value.from.branch !== null && typeof value.from.branch !== "string") return null;
	return {
		version: WORKSPACE_VERSION,
		id: value.id,
		from: { sessionId: value.from.sessionId, cwd: value.from.cwd, branch: value.from.branch },
		to: value.to,
		body: value.body,
		createdAt: value.createdAt,
		expiresAt: value.expiresAt,
	};
}

export function messagePath(registryDir: string, recipient: string, id: string): string {
	return join(inboxDir(registryDir, recipient), `${safeId(id)}.json`);
}

export function deliveredMarkerPath(registryDir: string, recipient: string, id: string): string {
	return join(deliveredDir(registryDir, recipient), `${safeId(id)}.json`);
}

export async function writePeerMessage(registryDir: string, message: PeerMessage): Promise<void> {
	await writeJsonAtomic(messagePath(registryDir, message.to, message.id), message);
}

export async function readPeerMessage(
	registryDir: string,
	recipient: string,
	id: string,
): Promise<PeerMessage | null> {
	const read = await readJson(messagePath(registryDir, recipient, id));
	if (!read.ok) return null;
	const message = validatePeerMessage(read.value);
	if (!message || message.to !== recipient || message.id !== id) return null;
	return message;
}

/** Oldest first: a peer's first message is not starved by a chatty one. */
export function sortMessages(messages: PeerMessage[]): PeerMessage[] {
	return [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export interface InboxRead {
	live: PeerMessage[];
	expired: PeerMessage[];
	invalid: string[];
	/** Ids already delivered: the idempotence ledger, not a second mailbox. */
	delivered: Set<string>;
}

export async function readInbox(registryDir: string, recipient: string, now: number): Promise<InboxRead> {
	const dir = inboxDir(registryDir, recipient);
	const result: InboxRead = { live: [], expired: [], invalid: [], delivered: new Set() };
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	const delivered = new Set<string>();
	try {
		for (const name of await readdir(deliveredDir(registryDir, recipient))) {
			if (name.endsWith(".json")) delivered.add(name.slice(0, -".json".length));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".")) continue;
		const id = name.slice(0, -".json".length);
		if (!isSafeId(id)) {
			result.invalid.push(name);
			continue;
		}
		const read = await readJson(join(dir, name));
		if (!read.ok) {
			if (read.kind === "invalid") result.invalid.push(name);
			continue;
		}
		const message = validatePeerMessage(read.value);
		if (!message || message.to !== recipient || message.id !== id) {
			result.invalid.push(name);
			continue;
		}
		if (delivered.has(id)) {
			// A previously delivered file that outlived its deletion (a crash
			// between send and unlink) is removed, never delivered twice.
			await unlink(join(dir, name)).catch(() => undefined);
			continue;
		}
		if (message.expiresAt <= now) result.expired.push(message);
		else result.live.push(message);
	}
	result.live = sortMessages(result.live);
	result.expired = sortMessages(result.expired);
	result.delivered = delivered;
	return result;
}

/** How many delivered ids one recipient keeps before the oldest are pruned. */
export const MAX_DELIVERED_MARKERS = 512;

/**
 * Keep the delivered ledger bounded. The ledger exists to make a replay
 * idempotent, not to be a permanent archive, and a long-lived repository would
 * otherwise accumulate one file per peer message forever.
 */
export async function pruneDeliveredMarkers(
	registryDir: string,
	recipient: string,
	max = MAX_DELIVERED_MARKERS,
): Promise<number> {
	if (!Number.isFinite(max) || max < 0) {
		throw new RangeError(`delivered-marker cap must be a non-negative finite number, got ${max}`);
	}
	const cap = Math.floor(max);
	const dir = deliveredDir(registryDir, recipient);
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	if (names.length <= cap) return 0;
	const stamped: { name: string; mtimeMs: number }[] = [];
	for (const name of names) {
		try {
			stamped.push({ name, mtimeMs: (await stat(join(dir, name))).mtimeMs });
		} catch {
			// A marker removed by another recipient's prune is already gone.
		}
	}
	stamped.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
	let removed = 0;
	for (const entry of stamped.slice(0, Math.max(0, stamped.length - cap))) {
		try {
			await unlink(join(dir, entry.name));
			removed++;
		} catch {
			// A concurrent prune may have removed it first; do not count it.
		}
	}
	return removed;
}

export async function markMessageDelivered(
	registryDir: string,
	recipient: string,
	message: PeerMessage,
	now: number,
	maxDelivered = MAX_DELIVERED_MARKERS,
): Promise<void> {
	await writeJsonAtomic(deliveredMarkerPath(registryDir, recipient, message.id), {
		version: WORKSPACE_VERSION,
		id: message.id,
		from: message.from.sessionId,
		deliveredAt: now,
	});
	await pruneDeliveredMarkers(registryDir, recipient, maxDelivered).catch(() => undefined);
}

export async function removePeerMessage(registryDir: string, recipient: string, id: string): Promise<void> {
	await unlink(messagePath(registryDir, recipient, id)).catch(() => undefined);
}

export function formatPeerMessage(message: PeerMessage): string {
	const branch = message.from.branch ? ` on branch ${message.from.branch}` : "";
	const at = new Date(message.createdAt).toISOString();
	return [
		`Peer message from session ${message.from.sessionId} in ${message.from.cwd}${branch} at ${at}:`,
		"",
		message.body,
		"",
		`This message was sent by another pi session in the same repository, not by the human at this keyboard. Reply with \`orchestrator_message\` to ${message.from.sessionId} if a reply is needed.`,
	].join("\n");
}


