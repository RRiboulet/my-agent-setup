// The child→parent escalation channel for the subagent extension (local patch 23).
//
// A child is a separate pi process in a separate tmux session, so it cannot call
// its parent. When it needs a decision it writes a request file and waits for a
// reply; when it merely wants to report progress it writes the same kind of file
// and carries on. The parent's existing per-run watcher tick (index.ts) reads the
// requests, and `subagent_answer` — a normal tool call, after `ctx.ui.confirm` —
// writes the reply the child is polling for.
//
// Design notes:
//   - One writer per file, one reader, one directory per run:
//     `<runDir>/escalation/<id>.request.json` and `<id>.reply.json`, next to
//     `result.json` and `activity.json`. The directory is the channel: a child
//     that was launched without one (an older parent, a stripped environment)
//     registers no tool at all and simply cannot ask.
//   - Every write is a temp file in the same directory plus a rename, so a reader
//     can never see a half-written file. A leftover `*.tmp` never matches the
//     request/reply suffix, so a crashed write is invisible rather than invalid.
//   - The shape is the gate, the version is advisory — the rule result.ts and
//     interrupt.ts already follow, because a child may run another branch's
//     build. A newer peer with a compatible shape is accepted; an incompatible
//     one is reported and ignored, and the child's own deadline ends the wait.
//   - `parent.alive` is the parent's heartbeat, rewritten on each watcher tick
//     while a request is pending. It is what lets a blocked child fail FAST when
//     the parent session ends, instead of sitting on its deadline: a stopped
//     watcher stops refreshing it, and the child reads the staleness. It carries
//     no meaning beyond "a parent was ticking here a moment ago".
//   - Nothing here decides anything about a run: the parent's tick and the two
//     tools own the behaviour. This module is the file protocol, so it can be
//     tested without tmux, a child process or a model.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * The protocol version this build writes.
 *
 * Advisory on read, exactly like `CHILD_RESULT_VERSION`: a shape this build
 * understands is accepted whatever the number says, and the number is quoted
 * only when it explains a rejection.
 */
export const ESCALATION_VERSION = 1;

/** The channel directory, inside the run directory. */
export const ESCALATION_DIR = "escalation";

/** The parent's liveness marker inside the channel. */
export const HEARTBEAT_FILE = "parent.alive";

const REQUEST_SUFFIX = ".request.json";
const REPLY_SUFFIX = ".reply.json";

/**
 * Size bounds. A question is read by a human and rendered in the parent's
 * session, so it is bounded like any other tool text; a reply is bounded the
 * same way so neither side can be handed a 10 MB "question".
 */
export const MAX_TEXT_CHARS = 4_000;
export const MAX_ANSWER_CHARS = 4_000;
export const MAX_OPTIONS = 8;
export const MAX_OPTION_CHARS = 300;

/** How long a child waits for an answer by default. */
export const DEFAULT_QUESTION_TIMEOUT_MS = 300_000;

/**
 * How long a child accepts silence from the parent before deciding nobody is
 * there to answer. The parent's watcher ticks every 500 ms while a request is
 * pending, so five seconds is ten missed ticks — long enough not to fire on a
 * slow tick, short enough that a shut-down parent is detected in seconds rather
 * than at the deadline.
 */
export const DEFAULT_QUESTION_GRACE_MS = 5_000;
/**
 * How old the parent's heartbeat may be before a waiting child calls it gone.
 *
 * Deliberately NOT a fraction of the grace window: the parent touches the
 * heartbeat at the START of a tick and schedules the next one after the tick
 * body completes, and that body budgets a 5 s `capture-pane` plus a
 * `display-message`. A 4 s threshold (80 % of a 5 s grace) therefore declares a
 * live parent dead whenever a tmux call stalls, and the child abandons a
 * question a human was about to answer. 15 s is above that worst case by a wide
 * margin, so a false "no parent" needs a genuinely dead ticker.
 */
export const HEARTBEAT_STALE_MS = 15_000;

/** How often a waiting child re-reads the reply file. */
export const DEFAULT_POLL_MS = 200;

export type EscalationKind = "question" | "progress";

/**
 * A child's request.
 *
 * `text` is the question for `kind: "question"` and the update for
 * `kind: "progress"`. `deadlineAt` belongs to a question only: a progress update
 * is never answered, so it has nothing to expire.
 */
export interface EscalationRequest {
	version: number;
	id: string;
	/** The run that asked. Verified on read, so a file cannot answer another run. */
	runId: string;
	kind: EscalationKind;
	text: string;
	/** Proposed answers, shown to the human. Never required. */
	options?: string[];
	askedAt: number;
	deadlineAt?: number;
}

/** A human-confirmed answer, written by the parent. */
export interface EscalationReply {
	version: number;
	id: string;
	runId: string;
	answer: string;
	answeredAt: number;
}

/**
 * A question waiting for an answer, as the PARENT records it on the run.
 *
 * Persisted in `runs.json` (not derived from the channel directory), so
 * `subagent_status` can report a blocked run after a reload, and so
 * `subagent_answer` has something to find without re-reading the child's files.
 */
export interface PendingQuestion {
	id: string;
	text: string;
	options?: string[];
	askedAt: number;
	deadlineAt: number;
}

export type EscalationReadResult<T> =
	| { ok: true; value: T }
	| { ok: false; reason: "missing" | "invalid"; error?: string };

/** The child's verdict on a blocking wait. */
export type EscalationWaitOutcome =
	| { state: "answered"; answer: string }
	| { state: "expired"; deadlineAt: number }
	| { state: "no-parent"; detail: string }
	| { state: "aborted" };

/** The channel directory for a run. */
export function escalationDir(runDir: string): string {
	return path.join(runDir, ESCALATION_DIR);
}

/** Path of the request file for one request id. */
export function requestPath(dir: string, id: string): string {
	return path.join(dir, `${id}${REQUEST_SUFFIX}`);
}

/** Path of the reply file for one request id. */
export function replyPath(dir: string, id: string): string {
	return path.join(dir, `${id}${REPLY_SUFFIX}`);
}

/**
 * Whether an id is usable as a filename.
 *
 * The id becomes a path component on both sides, so it is validated rather than
 * trusted: `..` or a slash in a request id would otherwise let a child write
 * outside its own channel.
 */
export function isValidRequestId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(id);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function invalid<T>(error: string): EscalationReadResult<T> {
	return { ok: false, reason: "invalid", error };
}

function requireObject(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > max) return null;
	if (/[\r\n]{3,}/.test(trimmed)) return null;
	return trimmed;
}

/** Validate an already-parsed request against the run it claims to belong to. */
export function validateEscalationRequest(value: unknown, expected: { runId: string }): EscalationReadResult<EscalationRequest> {
	const object = requireObject(value);
	if (!object) return invalid("request must be a JSON object");
	const version = object.version;
	const skewed = (detail: string): EscalationReadResult<EscalationRequest> =>
		typeof version === "number" && version !== ESCALATION_VERSION
			? invalid(
					`${detail}; it is protocol version ${version} and this build speaks version ${ESCALATION_VERSION}, so the child is probably a different build of this extension`,
				)
			: invalid(detail);
	if (typeof object.id !== "string" || !isValidRequestId(object.id)) return skewed("id is missing or not a filename-safe id");
	if (typeof object.runId !== "string" || object.runId.length === 0) return skewed("runId is missing");
	if (object.runId !== expected.runId) return skewed(`runId ${JSON.stringify(object.runId)} is not this run's`);
	if (object.kind !== "question" && object.kind !== "progress") {
		return skewed(`kind is ${JSON.stringify(object.kind)}, not "question" or "progress"`);
	}
	const text = boundedText(object.text, MAX_TEXT_CHARS);
	if (text === null) return skewed(`text is missing, empty or longer than ${MAX_TEXT_CHARS} characters`);
	if (!isFiniteNumber(object.askedAt)) return skewed("askedAt is missing or is not a finite number");
	let options: string[] | undefined;
	if (object.options !== undefined) {
		if (object.kind !== "question") return skewed("only a question may carry options");
		if (!Array.isArray(object.options) || object.options.length === 0 || object.options.length > MAX_OPTIONS) {
			return skewed(`options must be a non-empty list of at most ${MAX_OPTIONS} strings`);
		}
		const cleaned: string[] = [];
		for (const option of object.options) {
			if (typeof option !== "string") return skewed("every option must be a string");
			const trimmed = option.trim();
			if (!trimmed || trimmed.length > MAX_OPTION_CHARS) return skewed(`every option must be non-empty and at most ${MAX_OPTION_CHARS} characters`);
			cleaned.push(trimmed);
		}
		options = cleaned;
	}
	if (object.kind === "question") {
		if (!isFiniteNumber(object.deadlineAt)) return skewed("a question must carry a finite deadlineAt");
	} else if (object.deadlineAt !== undefined && !isFiniteNumber(object.deadlineAt)) {
		return skewed("deadlineAt must be a finite number when present");
	}
	return {
		ok: true,
		value: {
			version: typeof version === "number" ? version : ESCALATION_VERSION,
			id: object.id,
			runId: object.runId,
			kind: object.kind,
			text,
			...(options === undefined ? {} : { options }),
			askedAt: object.askedAt,
			...(isFiniteNumber(object.deadlineAt) ? { deadlineAt: object.deadlineAt } : {}),
		},
	};
}

/** Validate an already-parsed reply against the request it claims to answer. */
export function validateEscalationReply(
	value: unknown,
	expected: { runId: string; id: string },
): EscalationReadResult<EscalationReply> {
	const object = requireObject(value);
	if (!object) return invalid("reply must be a JSON object");
	const version = object.version;
	const skewed = (detail: string): EscalationReadResult<EscalationReply> =>
		typeof version === "number" && version !== ESCALATION_VERSION
			? invalid(
					`${detail}; it is protocol version ${version} and this build speaks version ${ESCALATION_VERSION}, so the parent is probably a different build of this extension`,
				)
			: invalid(detail);
	if (typeof object.id !== "string" || object.id !== expected.id) return skewed("id does not match the request");
	if (typeof object.runId !== "string" || object.runId !== expected.runId) return skewed("runId does not match this run");
	const answer = boundedText(object.answer, MAX_ANSWER_CHARS);
	if (answer === null) return skewed(`answer is missing, empty or longer than ${MAX_ANSWER_CHARS} characters`);
	if (!isFiniteNumber(object.answeredAt)) return skewed("answeredAt is missing or is not a finite number");
	return {
		ok: true,
		value: {
			version: typeof version === "number" ? version : ESCALATION_VERSION,
			id: object.id,
			runId: object.runId,
			answer,
			answeredAt: object.answeredAt,
		},
	};
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 *
 * `rename` within one directory is atomic on the filesystems this runs on, so a
 * reader sees either the previous file or the whole new one — never the middle
 * of a write. The mode is 0600 because a question can quote project content.
 */
async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

async function readJsonFile(filePath: string): Promise<EscalationReadResult<unknown>> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === "ENOENT") return { ok: false, reason: "missing" };
		return invalid(`could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (error) {
		// Expected during a NON-atomic write by an older build; the caller retries
		// until its deadline rather than treating one bad read as final.
		return invalid(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Publish a request. Throws on a shape this build refuses to write, so the
 * child's tool can tell its model why (an oversized question is a caller bug,
 * not a transient failure).
 */
export async function writeEscalationRequest(dir: string, request: EscalationRequest): Promise<void> {
	const validated = validateEscalationRequest(request, { runId: request.runId });
	if (!validated.ok) throw new Error(`Refusing to write an unusable escalation request: ${validated.error}`);
	await writeJsonFile(requestPath(dir, request.id), request);
}

/** Publish a reply. Same contract as `writeEscalationRequest`. */
export async function writeEscalationReply(dir: string, reply: EscalationReply): Promise<void> {
	const validated = validateEscalationReply(reply, { runId: reply.runId, id: reply.id });
	if (!validated.ok) throw new Error(`Refusing to write an unusable escalation reply: ${validated.error}`);
	await writeJsonFile(replyPath(dir, reply.id), reply);
}

/** Read and validate one request file. Never throws. */
export async function readEscalationRequest(
	filePath: string,
	expected: { runId: string },
): Promise<EscalationReadResult<EscalationRequest>> {
	const raw = await readJsonFile(filePath);
	if (!raw.ok) return raw;
	return validateEscalationRequest(raw.value, expected);
}

/** Read and validate one reply file. Never throws. */
export async function readEscalationReply(
	filePath: string,
	expected: { runId: string; id: string },
): Promise<EscalationReadResult<EscalationReply>> {
	const raw = await readJsonFile(filePath);
	if (!raw.ok) return raw;
	return validateEscalationReply(raw.value, expected);
}

/**
 * Every request file in a channel, oldest name first.
 *
 * A missing directory is an empty channel — the ordinary case for a run whose
 * child never asked anything. Only names matching the request suffix and a
 * filename-safe id are listed, so a `.tmp` from a crashed write and anything
 * else in the directory are invisible.
 */
export async function listEscalationRequests(dir: string): Promise<{ id: string; file: string }[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(REQUEST_SUFFIX))
		.map((name) => ({ id: name.slice(0, -REQUEST_SUFFIX.length), file: path.join(dir, name) }))
		.filter((entry) => isValidRequestId(entry.id))
		.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Publish a request and wait for its reply.
 *
 * The loop is bounded by the deadline, by the caller's abort signal and by the
 * parent's heartbeat, so every way out is a value rather than a hang:
 *   - `answered` when a valid reply lands;
 *   - `aborted` when the tool call is cancelled (the child's turn was aborted);
 *   - `expired` at the deadline — the parent refuses a reply after it too, so a
 *     late answer can never be mistaken for an in-time one;
 *   - `no-parent` once the grace window has passed and the heartbeat is absent or
 *     stale, which is a parent that shut down or was never there.
 *
 * The single timer this loop owns is cleared on every exit, so nothing survives
 * the call. There is deliberately no retry budget for an unreadable reply file:
 * one bad read is a non-atomic writer caught mid-write, and the next poll fixes
 * it, while a persistently broken file is bounded by the deadline.
 */
export async function waitForEscalationReply(options: {
	dir: string;
	id: string;
	runId: string;
	deadlineAt: number;
	signal?: AbortSignal;
	pollMs?: number;
	graceMs?: number;
	now?: () => number;
}): Promise<EscalationWaitOutcome> {
	const now = options.now ?? Date.now;
	const pollMs = Math.max(10, Math.min(options.pollMs ?? DEFAULT_POLL_MS, 5_000));
	const graceMs = Math.max(0, options.graceMs ?? DEFAULT_QUESTION_GRACE_MS);
	const startedAt = now();

	for (;;) {
		if (options.signal?.aborted) return { state: "aborted" };
		const reply = await readEscalationReply(replyPath(options.dir, options.id), {
			runId: options.runId,
			id: options.id,
		});
		// A reply is accepted even if the deadline passed while it was being
		// written: the parent refuses to write one after the deadline, so its
		// existence is the in-time signal.
		if (reply.ok) return { state: "answered", answer: reply.value.answer };
		if (now() >= options.deadlineAt) return { state: "expired", deadlineAt: options.deadlineAt };
		if (now() - startedAt >= graceMs) {
			const heartbeat = await readEscalationHeartbeat(options.dir);
			// 80% of the grace window: the parent rewrites the heartbeat every
			// watcher tick, so anything older than that is several missed ticks.
			if (heartbeat === undefined || now() - heartbeat > HEARTBEAT_STALE_MS) {
				return {
					state: "no-parent",
					detail:
						heartbeat === undefined
							? "no parent session ever read this request"
							: `the parent session stopped answering ${Math.round((now() - heartbeat) / 1000)}s ago`,
				};
			}
		}
		await waitWithSignal(pollMs, options.signal);
	}
}

/** A delay that resolves early — without throwing — when `signal` aborts. */
function waitWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const finish = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

/**
 * Refresh the parent's heartbeat. Called from the watcher tick, never on a timer
 * of its own: the tick is the clock.
 */
export async function touchEscalationHeartbeat(dir: string): Promise<void> {
	await writeJsonFile(path.join(dir, HEARTBEAT_FILE), { version: ESCALATION_VERSION, at: Date.now() });
}

/**
 * When the parent last ticked, or undefined if it never did.
 *
 * The mtime, not the content: the heartbeat says one thing ("a parent was here"),
 * and a file whose bytes were mangled still says it as long as it is fresh.
 */
export async function readEscalationHeartbeat(dir: string): Promise<number | undefined> {
	try {
		const info = await stat(path.join(dir, HEARTBEAT_FILE));
		return info.mtimeMs;
	} catch {
		return undefined;
	}
}

/** Remove the heartbeat, so a closed session is not mistaken for a live one. */
export async function clearEscalationHeartbeat(dir: string): Promise<void> {
	await rm(path.join(dir, HEARTBEAT_FILE), { force: true });
}

/**
 * Remove both files of one exchange.
 *
 * The child calls this after it has taken the answer, which is what makes a
 * replayed reply harmless: the file it would replay is gone, and the request it
 * belonged to is gone too.
 */
export async function consumeEscalationExchange(dir: string, id: string): Promise<void> {
	await rm(requestPath(dir, id), { force: true });
	await rm(replyPath(dir, id), { force: true });
}
