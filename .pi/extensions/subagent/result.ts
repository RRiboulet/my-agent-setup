// The child→parent result file for the subagent extension.
//
// The child publishes `<runDir>/result.json` when it settles and the parent's
// watcher reads it on every tick: it is the completion signal, not a diagnostic
// (that is activity.json). This build writes it with an atomic rename, but the
// reader must not assume the writer is this build — a child can be launched from
// a trusted copy of the extension, including another branch's checkout — so the
// file is a protocol spoken across versions.
//
// Design notes:
//   - `missing` is the ordinary "the child has not settled yet" state and the
//     only one worth retrying indefinitely. `invalid` means the path is there and
//     unusable; the watcher counts consecutive invalid reads and fails the run
//     once that count proves the file is not about to change.
//   - The *shape* is the gate, not the version. Every field `finalizeRun`
//     dereferences is checked, so a child that adds a field (a newer protocol
//     version with a compatible shape) still reports, while a renamed or dropped
//     field fails with a message naming the version skew as the likely cause.
//     Rejecting on version equality instead would throw away a complete answer
//     this parent can read perfectly well.
//   - Read errors are not assumed permanent either: `EMFILE`, `ESTALE` and a
//     permission blip are the same "invalid" state as bad bytes. Only the
//     watcher's counter can tell a blip from a file that will never parse, so
//     this module reports, and never sleeps or retries on its own.
//   - One writer, one reader, one file per run, exactly like activity.ts and
//     interrupt.ts — hence the same `{ ok, reason }` result shape.

import { readFile } from "node:fs/promises";

/**
 * The protocol version this build writes.
 *
 * Advisory on read: `validateChildResult` reports it in failures and otherwise
 * gates on the shape. Exported so the writer and the validator can never drift
 * apart, which is the bug class this whole module exists for.
 */
export const CHILD_RESULT_VERSION = 1;

export interface ChildResult {
	/** The writer's protocol version. Reported in failures; never gated on. */
	version: number;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
}

export type ChildResultReadResult =
	| { ok: true; result: ChildResult }
	| { ok: false; reason: "missing" | "invalid"; error?: string };

/**
 * Optional fields `finalizeRun` reads.
 *
 * A non-string here is not cosmetic: `error` is passed to `.trim()` and throws,
 * and the rest are copied into `runs.json` through `??`, where a wrong type
 * survives as wrong data. Validated in one loop because they share the rule.
 */
const OPTIONAL_STRING_FIELDS = ["error", "stopReason", "sessionFile", "provider", "model", "thinking"] as const;

const KNOWN_STATUSES = new Set(["completed", "failed"]);

function invalid(error: string): ChildResultReadResult {
	return { ok: false, reason: "invalid", error };
}

/** A read error that means "no file yet", as opposed to "a file I cannot read". */
function isMissingFile(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * Validate an already-parsed `result.json`.
 *
 * Everything `finalizeRun` dereferences is checked here, because a blind cast is
 * what let a child with a renamed field throw inside the watch tick: the error
 * was logged, the tick rescheduled, and the run stayed `running` forever while
 * its result was never consumed. A rejection is a value, never an exception.
 */
export function validateChildResult(value: unknown): ChildResultReadResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid("result must be a JSON object");
	}
	const candidate = value as Record<string, unknown>;
	const version = candidate.version;
	// Shape errors carry the version when it is not this build's. That is the one
	// place the version earns its keep: it explains the FAILURE, and names the
	// likely cause (a child from a different build) rather than leaving a reader
	// to guess why a complete-looking file was rejected.
	const shapeError = (detail: string): ChildResultReadResult =>
		typeof version === "number" && version !== CHILD_RESULT_VERSION
			? invalid(
					`${detail}; it is protocol version ${version} and this parent speaks version ${CHILD_RESULT_VERSION}, so the child is probably a different build of this extension`,
				)
			: invalid(detail);

	if (typeof candidate.status !== "string" || !KNOWN_STATUSES.has(candidate.status)) {
		return shapeError(`status is ${JSON.stringify(candidate.status)}, not "completed" or "failed"`);
	}
	if (typeof candidate.output !== "string") {
		return shapeError("output is missing or is not a string");
	}
	for (const field of OPTIONAL_STRING_FIELDS) {
		const fieldValue = candidate[field];
		if (fieldValue !== undefined && typeof fieldValue !== "string") {
			return shapeError(`${field} is not a string`);
		}
	}
	if (typeof candidate.finishedAt !== "number" || !Number.isFinite(candidate.finishedAt)) {
		return shapeError("finishedAt is missing or is not a finite number");
	}
	// Normalised rather than cast: the shape is trusted now, but `version` is
	// still typed as a number on the interface, and a writer that omits it must
	// not turn the type into a lie.
	return {
		ok: true,
		result: {
			version: typeof version === "number" ? version : CHILD_RESULT_VERSION,
			status: candidate.status as ChildResult["status"],
			output: candidate.output,
			...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
			...(typeof candidate.stopReason === "string" ? { stopReason: candidate.stopReason } : {}),
			...(typeof candidate.sessionFile === "string" ? { sessionFile: candidate.sessionFile } : {}),
			...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
			...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
			...(typeof candidate.thinking === "string" ? { thinking: candidate.thinking } : {}),
			finishedAt: candidate.finishedAt,
		},
	};
}

/** Parse and validate the raw contents of a `result.json`. */
export function parseChildResult(raw: string): ChildResultReadResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// No version is available here, so there is no skew to report — the bytes
		// may simply have been caught mid-write by a non-atomic writer.
		return invalid(`result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateChildResult(parsed);
}

/**
 * Read and validate a child's `result.json`.
 *
 * A missing file is `missing`; anything else that goes wrong — bad bytes, a
 * directory in the file's place, a permission error — is `invalid`, because only
 * the caller's retry policy can decide which of those will fix itself.
 */
export async function readChildResultFile(filePath: string): Promise<ChildResultReadResult> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { ok: false, reason: "missing" };
		return invalid(`result could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseChildResult(raw);
}
