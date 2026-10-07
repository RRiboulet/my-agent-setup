// Turn-level interrupt marker for the subagent extension.
//
// A "turn-level interrupt" stops the child's current turn without stopping the
// child: Escape (`app.interrupt`) aborts the in-flight provider call, pi fires
// `turn_end` with `outcome: "aborted"` and then `agent_settled`, and the child
// sits back at its prompt with its session file and tmux session intact. The
// point is to be able to steer a run that is going the wrong way instead of
// killing it and losing the transcript.
//
// Without this module the reporter treats an abort as a failure: it writes a
// failed `result.json` and calls `ctx.shutdown()`, which the parent reads as
// "the run is over". So the child writes `<runDir>/interrupt.json` on an
// aborted settle instead, and the parent reads it to mark the run `interrupted`
// while keeping the child alive.
//
// Design notes:
//   - One writer (the child), one reader (the parent), one file per run:
//     `<runDir>/interrupt.json`, next to `result.json` and `activity.json`.
//   - `result.json` semantics are deliberately untouched. The marker is a
//     separate, later-observed signal, so the completion path is unchanged and a
//     run that is interrupted and then finished still reports normally.
//   - Reads never throw: an absent, unreadable, malformed or mismatched file is
//     reported, not raised, because a missing marker must never break the
//     watcher.
//   - `interrupts` is a per-child counter so the parent can raise its own count
//     monotonically instead of losing an interrupt that arrived while it was
//     busy. It is a count of what this child observed, never a wall clock.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

const INTERRUPT_FILE = "interrupt.json";
const DEFAULT_MAX_WRITE_FAILURES = 3;

export interface SubagentInterruptMarker {
	version: 1;
	/** Run id of the child that wrote this marker. Verified on read. */
	runId: string;
	/** When the child settled an aborted turn. */
	interruptedAt: number;
	/** 1-based count of aborted turns this child has settled. */
	interrupts: number;
	/** The assistant message's stopReason; "aborted" for a real interrupt. */
	stopReason?: string;
}

export type InterruptReadResult =
	| { ok: true; marker: SubagentInterruptMarker }
	| { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export interface InterruptMarkerWriterOptions {
	filePath: string;
	runId: string;
	now?: () => number;
	write: (filePath: string, value: unknown) => Promise<void>;
	maxWriteFailures?: number;
	onError?: (error: unknown) => void;
}

export interface InterruptMarkerWriter {
	/** Record one aborted turn. Resolves once the marker is durable. */
	mark(info?: { stopReason?: string }): Promise<void>;
	/** 1-based count of interrupts this writer has recorded. */
	count(): number;
}

/** Path of the interrupt marker for a run directory. */
export function getInterruptFilePath(runDir: string): string {
	return path.join(runDir, INTERRUPT_FILE);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function invalid(error: string): InterruptReadResult {
	return { ok: false, reason: "invalid", error };
}

/** Validate an already-parsed marker value. */
export function validateInterruptMarker(value: unknown, expectedRunId: string): InterruptReadResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("interrupt marker must be an object");
	const object = value as Record<string, unknown>;
	if (object.version !== 1) return invalid("unsupported interrupt marker version");
	if (typeof object.runId !== "string" || object.runId.length === 0) return invalid("runId must be a non-empty string");
	if (object.runId !== expectedRunId) return { ok: false, reason: "wrong-id" };
	if (!isFiniteNumber(object.interruptedAt)) return invalid("interruptedAt must be finite");
	if (!Number.isInteger(object.interrupts) || (object.interrupts as number) < 1) {
		return invalid("interrupts must be a positive integer");
	}
	for (const field of ["stopReason"] as const) {
		const raw = object[field];
		if (raw !== undefined && (typeof raw !== "string" || /[\r\n]/.test(raw) || raw.length > 64)) {
			return invalid(`${field} must be a short single-line string when present`);
		}
	}
	return { ok: true, marker: object as unknown as SubagentInterruptMarker };
}

/**
 * Read and validate the marker for `runId`. Never throws: a missing or broken
 * marker means "not interrupted", never a watcher error.
 */
export async function readInterruptMarker(filePath: string, runId: string): Promise<InterruptReadResult> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return { ok: false, reason: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return invalid(`interrupt marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateInterruptMarker(parsed, runId);
}

/**
 * Create the marker writer used inside a subagent child.
 *
 * Writes are serialized so a slow write can never interleave with a later one,
 * and after repeated failures the writer disables itself rather than spamming a
 * doomed path — a lost marker degrades to "the parent still sees a running
 * child", which is the same state an interrupt that never landed would give.
 */
export function createInterruptMarkerWriter(options: InterruptMarkerWriterOptions): InterruptMarkerWriter {
	const now = options.now ?? Date.now;
	const maxWriteFailures = options.maxWriteFailures ?? DEFAULT_MAX_WRITE_FAILURES;
	const onError = options.onError;

	let count = 0;
	let failures = 0;
	let disabled = false;
	let chain: Promise<void> = Promise.resolve();

	return {
		mark: (info) => {
			if (disabled) return chain;
			count += 1;
			const marker: SubagentInterruptMarker = {
				version: 1,
				runId: options.runId,
				interruptedAt: now(),
				interrupts: count,
				...(typeof info?.stopReason === "string" ? { stopReason: info.stopReason } : {}),
			};
			chain = chain
				.then(() => options.write(options.filePath, marker))
				.then(
					() => {
						failures = 0;
					},
					(error: unknown) => {
						failures += 1;
						onError?.(error);
						if (failures >= maxWriteFailures) disabled = true;
					},
				);
			return chain;
		},
		count: () => count,
	};
}