// bg/logs.ts — reading a job's output, and keeping it bounded.
//
// Two jobs, and they are the two halves of one problem: a log the model can read
// and a log that cannot fill the agent directory.
//
//   - `readLogTail` answers `bg logs <id>`: the tail of the combined stdout+stderr,
//     cut with the repository's own tail-truncation limits (pi's `truncateTail`,
//     2000 lines / 50KB, and the notice shape its bash tool prints), so a log
//     reads exactly like any other tool output. A running job answers with what
//     exists so far rather than an error: the point of logs is to look at a job
//     that has not finished.
//   - `enforceLogCap` bounds the file itself. A plain log file cannot cap itself,
//     and a capped pipe reader would defeat detachment (the reader would have to
//     outlive the process that writes), so the cap is applied from outside by the
//     watcher's existing poll — see `watch.ts`. Truncation is from the FRONT: the
//     end of a log is the part that explains why a job failed.
//
// Idempotence, because the poll runs twice a second:
//
//   - Below the cap, enforcement is a `stat` and nothing else.
//   - At the cap, it keeps the last `cap - marker` bytes and re-appends exactly
//     one marker; any marker already in the kept window is stripped first. So a
//     log never holds two markers, and a file that was just capped is at most
//     `cap` bytes, which is the condition the next tick checks — it does nothing.
//     A job that keeps writing is capped again only once it has written past the
//     cap, which is the bound doing its job.
//   - The marker is a fixed string for a given cap, so "was this log capped?" is
//     decidable by looking for it, without a second file to keep in sync.

import { open, stat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { commandFirstLine, loadJob, type BgJobRecord } from "./store.ts";

/**
 * One log's ceiling. 256KB is five times the 50KB a single `logs` result can
 * show, so the visible window survives a couple of re-reads at different points
 * without the earlier output being thrown away for nothing, while a fan-out of
 * parallel jobs still costs megabytes rather than gigabytes.
 */
export const BG_LOG_CAP_BYTES = 256 * 1024;

/**
 * How much of a log a read is willing to load at once.
 *
 * Normally the file is already at or below the cap and this never matters. It
 * exists for the window between a burst of output and the next poll: a job that
 * dumps 500MB in one go must not be read into memory, so the read takes the tail
 * and says so. Four times the cap is a window wide enough that the reported line
 * numbers still describe the whole (capped) log in every ordinary case.
 */
export const BG_LOG_READ_WINDOW_BYTES = 4 * BG_LOG_CAP_BYTES;

/** "256KB" — the marker's own size label, without the tail's decimal. */
function capLabel(maxBytes: number): string {
	return `${Math.round(maxBytes / 1024)}KB`;
}

/**
 * Appended once to a log that hit its cap. Ends the file rather than starting it
 * because a log is read from the end, and it is the end of the file a reader of
 * a capped log is looking at.
 */
export function logCapMarker(maxBytes: number = BG_LOG_CAP_BYTES): string {
	return `\n[bg] log capped at ${capLabel(maxBytes)}: earlier output was discarded\n`;
}

/** The marker without its separating newline — what to look for inside a log. */
function markerBody(marker: string): string {
	return marker.trim();
}

/**
 * Whether a log's text carries the cap marker, i.e. whether output was dropped.
 * Used by `logs` to say so and by enforcement to stay idempotent.
 */
export function logWasCapped(text: string, maxBytes: number = BG_LOG_CAP_BYTES): boolean {
	return text.includes(markerBody(logCapMarker(maxBytes)));
}

export interface EnforceLogCapOptions {
	maxBytes?: number;
	/** Override for a caller that wants a different marker; must match what `logWasCapped` looks for. */
	marker?: string;
}

export interface EnforceLogCapResult {
	/** Whether this call actually rewrote the log. False means "already bounded". */
	capped: boolean;
	bytesBefore: number;
	bytesAfter: number;
}

/**
 * Keep `logPath` at or below `maxBytes`, discarding the oldest output.
 *
 * Safe to call on every poll: it stats first and returns immediately when the
 * file is within the cap, so the steady state costs one syscall per tick. Errors
 * are the caller's to handle — the watcher logs and keeps ticking.
 *
 * The rewrite is in place (write from offset 0, then truncate), not a
 * write-then-rename: the job holds an open descriptor to this inode and is
 * appending to it, and a rename would leave the job writing to a file nothing
 * reads any more. Writing in place keeps that descriptor pointing at the log.
 * A reader interleaved with the rewrite can see the file mid-pass (new text plus
 * the old tail, before the truncate); that is a torn read of a capped log, not a
 * corrupt one, and the alternative — a lock — would put a writer's file size
 * behind a reader's patience.
 */
export async function enforceLogCap(logPath: string, options: EnforceLogCapOptions = {}): Promise<EnforceLogCapResult> {
	const maxBytes = options.maxBytes ?? BG_LOG_CAP_BYTES;
	const marker = options.marker ?? logCapMarker(maxBytes);
	const markerBytes = Buffer.byteLength(marker, "utf8");
	// The kept window has to carry something besides the marker, and the rewrite
	// below assumes the file is longer than the window.
	if (maxBytes <= markerBytes * 2) {
		throw new Error(`log cap must exceed twice the marker size (${maxBytes} <= ${markerBytes * 2})`);
	}

	let bytesBefore: number;
	try {
		bytesBefore = (await stat(logPath)).size;
	} catch (error) {
		// No log yet is not a problem: a job that has written nothing, or one that
		// failed to start, has no log file to bound.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { capped: false, bytesBefore: 0, bytesAfter: 0 };
		throw error;
	}
	if (bytesBefore <= maxBytes) return { capped: false, bytesBefore, bytesAfter: bytesBefore };

	const keep = maxBytes - markerBytes;
	const start = bytesBefore - keep;
	const handle = await open(logPath, "r+");
	try {
		const buffer = Buffer.alloc(keep);
		const { bytesRead } = await handle.read(buffer, 0, keep, start);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
		// `start` is always past 0 here, so the window can open mid-line and
		// mid-character: drop through the first newline, which removes both a
		// fragment of a line and the replacement character a split rune became.
		const firstNewline = text.indexOf("\n");
		text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
		// Exactly one marker, always at the end: an older one may sit inside the
		// kept window, and re-appending without stripping would accumulate them.
		text = text.split(markerBody(marker)).join("");
		const out = Buffer.from(`${text}${marker}`, "utf8");
		await handle.write(out, 0, out.length, 0);
		await handle.truncate(out.length);
		return { capped: true, bytesBefore, bytesAfter: out.length };
	} finally {
		await handle.close();
	}
}

export interface LogTail {
	/** The truncated content, without any notice lines. */
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	outputLines: number;
	/** Bytes of the log that were read, not necessarily of the whole file. */
	bytesRead: number;
	/** True when the log was longer than the read window, so the head was never loaded. */
	windowed: boolean;
	/** True when this log carries the cap marker, i.e. output was discarded by `enforceLogCap`. */
	capped: boolean;
}

/**
 * Read a job's log and cut it to the repository's tail limits.
 *
 * The file is read with `BG_LOG_READ_WINDOW_BYTES` as a hard ceiling so a log
 * that outran the cap between polls cannot be loaded whole, and `windowed` says
 * when that happened. A missing log is an empty one: the job has produced no
 * output, which is a fact, not an error.
 */
export async function readLogTail(logPath: string, options: { maxBytes?: number; maxLines?: number } = {}): Promise<LogTail> {
	let bytesRead = 0;
	let text = "";
	let windowed = false;
	let size = 0;
	try {
		size = (await stat(logPath)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") size = 0;
		else throw error;
	}
	if (size > 0) {
		const start = Math.max(0, size - BG_LOG_READ_WINDOW_BYTES);
		windowed = start > 0;
		const handle = await open(logPath, "r");
		try {
			const buffer = Buffer.alloc(size - start);
			const read = await handle.read(buffer, 0, buffer.length, start);
			bytesRead = read.bytesRead;
			text = buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	const tail = truncateTail(text, {
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
	});
	return {
		content: tail.content,
		truncated: tail.truncated,
		truncatedBy: tail.truncatedBy,
		totalLines: tail.totalLines,
		outputLines: tail.outputLines,
		bytesRead,
		windowed,
		capped: logWasCapped(text),
	};
}

/**
 * The notice lines for a truncated log, in the shape pi's bash tool prints
 * ("[Showing lines 3001-5000 of 5000. Full output: …]") — the same words for the
 * same situation, so a reader does not have to learn a second convention. The
 * "full output" it points at is the log file itself, which is worth naming: it
 * is the one place the dropped *head* of a capped log is also gone.
 */
export function formatLogNotice(tail: LogTail, logPath: string): string[] {
	const notices: string[] = [];
	if (tail.truncated) {
		const startLine = Math.max(1, tail.totalLines - tail.outputLines + 1);
		const endLine = tail.totalLines;
		const limit = tail.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
		notices.push(`[Showing lines ${startLine}-${endLine} of ${tail.totalLines}${limit}. Full output up to the cap: ${logPath}]`);
	}
	if (tail.windowed) {
		notices.push(`[The log is larger than the ${formatSize(BG_LOG_READ_WINDOW_BYTES)} read window; only its end was read.]`);
	}
	if (tail.capped) {
		notices.push(`[This log hit its ${capLabel(BG_LOG_CAP_BYTES)} cap; the earliest output was discarded.]`);
	}
	return notices;
}

/** The `bg` tool result shape, kept local so `index.ts`'s dispatch entry is the only thing this ticket edits there. */
interface BgLogsResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

function logsError(message: string): BgLogsResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { action: "logs", error: message } };
}

/**
 * `bg({ action: "logs", id })` — the tail of one job's combined output.
 *
 * A running job is answered, not refused: "what has it printed so far?" is the
 * question a running job raises, and the trailing sentence says which state the
 * answer came from so the output is not read as final.
 */
export async function readLogsAction(
	params: { id?: string },
	ctx: ExtensionContext,
): Promise<BgLogsResult> {
	if (!params.id) return logsError("logs needs a job id (see status for this session's jobs)");
	const sessionId = ctx.sessionManager.getSessionId();
	const job: BgJobRecord | undefined = await loadJob(sessionId, params.id);
	if (!job) return logsError(`no job ${params.id} in this session`);

	let tail: LogTail;
	try {
		tail = await readLogTail(job.logPath);
	} catch (error) {
		return logsError(`could not read the log of ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const lines: string[] = [];
	lines.push(tail.content.length > 0 ? tail.content : job.state === "running" ? "(no output yet)" : "(no output)");
	const notices = formatLogNotice(tail, job.logPath);
	if (notices.length > 0) lines.push("", ...notices);
	if (job.state === "running") {
		// Named so a partial tail is never mistaken for a complete one.
		lines.push("", `[Job ${job.id} is still running; this is the output so far. Follow it with status.]`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "logs",
			sessionId,
			id: job.id,
			state: job.state,
			logPath: job.logPath,
			command: commandFirstLine(job.command),
			truncated: tail.truncated,
			truncatedBy: tail.truncatedBy,
			totalLines: tail.totalLines,
			outputLines: tail.outputLines,
			bytesRead: tail.bytesRead,
			windowed: tail.windowed,
			capped: tail.capped,
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
			capBytes: BG_LOG_CAP_BYTES,
		},
	};
}
