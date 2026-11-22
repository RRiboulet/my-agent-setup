/**
 * The project's verification command, run at the settlement boundary.
 *
 * Why the gate runs it instead of asking the model to: "the command was run
 * after the edit" only means something if the run is observable, and a model's
 * own shell call is not observable as *that* command unless the gate parses the
 * transcript. Running it here gives one answer with one shape, including the two
 * cases that matter and cannot be reported otherwise — a command that outlives
 * its timeout, and a command whose output does not fit. `scanEditVerification`
 * still recognises the model running the configured command itself, so a run
 * that already verified is not asked twice.
 *
 * The command goes through the host's own `pi.exec`, which already implements
 * the termination behaviour this repository relies on elsewhere: a timeout and
 * `maxBuffer` both kill the process (`SIGTERM`, then `SIGKILL` five seconds
 * later), and the result says which happened. Nothing here re-implements that.
 *
 * **Fail-open is a rule, not an error path.** A command that is killed, whose
 * output was truncated, that cannot be started, or whose result cannot be parsed
 * has told us nothing about the code. Blocking a settlement on it would trap the
 * session on the gate's own failure, so those statuses are recorded in the
 * verdict and the run settles. Only a command that *ran to completion* with a
 * non-zero exit is evidence against the change.
 *
 * This module performs no I/O of its own: `runVerification` takes the `exec`
 * function, which is `pi.exec` in production and a scripted double in tests.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type VerificationStatus = "passed" | "failed" | "timed-out" | "truncated" | "unavailable";

/** Statuses that settle the run instead of blocking it (R33's fail-open rule). */
export const FAIL_OPEN_STATUSES: ReadonlySet<VerificationStatus> = new Set<VerificationStatus>([
	"timed-out",
	"truncated",
	"unavailable",
]);

export interface VerificationSpec {
	command: string;
	timeoutMs: number;
	maxOutputBytes: number;
}

export interface VerificationOutcome {
	status: VerificationStatus;
	command: string;
	/** The exit code, or `null` when the command never produced one. */
	exitCode: number | null;
	durationMs: number;
	killed: boolean;
	truncated: boolean;
	/** One line for the verdict. */
	summary: string;
	/** Bounded head-and-tail output, for the continuation message. */
	output: string;
}

export interface VerificationExecOptions {
	cwd?: string;
	timeout?: number;
	maxBuffer?: number;
	signal?: AbortSignal;
}

/** `pi.exec`'s shape, narrowed to what this module needs. */
export type VerificationExec = (
	command: string,
	args: string[],
	options?: VerificationExecOptions,
) => Promise<ExecResult>;

/**
 * How to run a command line.
 *
 * `pi.exec` deliberately takes an argument vector and no shell, so the shell
 * comes from here: `bash -lc` on POSIX, because a verification command is
 * usually `npm test`-shaped and needs the login PATH a model's shell tool would
 * get; PowerShell on Windows, matching the host tool the repository already
 * documents. A platform this does not cover still gets `bash`, and a missing
 * shell surfaces as `unavailable` — reported, never a pass.
 */
export function verificationInvocation(
	commandLine: string,
	platform: string = process.platform,
): { command: string; args: string[] } {
	if (platform === "win32") {
		return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", commandLine] };
	}
	return { command: "bash", args: ["-lc", commandLine] };
}

/**
 * Bound combined output for a message while keeping both ends: a test summary
 * lives in the tail, the first error in the head. Bytes, not characters, because
 * the bound is what keeps a chatty command out of the context window.
 */
export function boundVerificationOutput(
	stdout: string,
	stderr: string,
	maxBytes: number,
	separator = "\n--- stderr ---\n",
): string {
	const head = String(stdout ?? "").trim();
	const tail = String(stderr ?? "").trim();
	const text = head && tail ? `${head}${separator}${tail}` : head || tail;
	const limit = Math.max(0, Math.floor(maxBytes));
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= limit) return text;
	// Split the budget unevenly on purpose: the tail of a failing command is
	// where the failing assertion is, so it gets the larger share.
	const headBudget = Math.floor(limit / 3);
	const tailBudget = limit - headBudget;
	const headPart = Buffer.from(text, "utf8").subarray(0, headBudget).toString("utf8");
	const tailPart = Buffer.from(text, "utf8").subarray(bytes - tailBudget).toString("utf8");
	return `${headPart}\n… (${bytes - limit} bytes omitted) …\n${tailPart}`;
}

function isExecResult(value: unknown): value is ExecResult {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.code === "number" &&
		Number.isFinite(record.code) &&
		typeof record.stdout === "string" &&
		typeof record.stderr === "string" &&
		typeof record.killed === "boolean" &&
		typeof record.truncated === "boolean"
	);
}

/**
 * Map one execution result onto a status. The order matters: truncated output
 * also reports `killed`, and both are fail-open, but the verdict should name the
 * reason a reader can act on.
 */
export function classifyVerification(result: unknown): { status: VerificationStatus; exitCode: number | null } {
	if (!isExecResult(result)) return { status: "unavailable", exitCode: null };
	if (result.truncated) return { status: "truncated", exitCode: result.code };
	if (result.killed) return { status: "timed-out", exitCode: result.code };
	if (result.code === 0) return { status: "passed", exitCode: 0 };
	return { status: "failed", exitCode: result.code };
}

function summarize(outcome: Omit<VerificationOutcome, "summary">, timeoutMs: number): string {
	const duration = `${outcome.durationMs} ms`;
	switch (outcome.status) {
		case "passed":
			return `verification command \`${outcome.command}\` passed in ${duration}`;
		case "failed":
			return `verification command \`${outcome.command}\` failed with exit code ${outcome.exitCode} in ${duration}`;
		case "timed-out":
			return `verification command \`${outcome.command}\` was terminated after ${duration} (timeout ${timeoutMs} ms or abort)`;
		case "truncated":
			return `verification command \`${outcome.command}\` exceeded its output cap after ${duration}; output is incomplete`;
		case "unavailable":
			return `verification command \`${outcome.command}\` could not be run`;
	}
}

/**
 * Run the configured command once and report what happened. Never throws: a
 * shell that cannot be started, a rejected `exec`, or a result of the wrong
 * shape all become `unavailable`, which the caller treats as fail-open.
 */
export async function runVerification(
	spec: VerificationSpec,
	options: { cwd?: string; signal?: AbortSignal; exec: VerificationExec },
): Promise<VerificationOutcome> {
	const startedAt = Date.now();
	const invocation = verificationInvocation(spec.command);
	const base: Omit<VerificationOutcome, "summary"> = {
		status: "unavailable",
		command: spec.command,
		exitCode: null,
		durationMs: 0,
		killed: false,
		truncated: false,
		output: "",
	};

	let result: ExecResult;
	try {
		result = await options.exec(invocation.command, invocation.args, {
			cwd: options.cwd,
			timeout: spec.timeoutMs,
			maxBuffer: spec.maxOutputBytes,
			signal: options.signal,
		});
	} catch (error) {
		const failed: Omit<VerificationOutcome, "summary"> = {
			...base,
			status: "unavailable",
			durationMs: Date.now() - startedAt,
			output: error instanceof Error ? error.message : String(error),
		};
		return { ...failed, summary: `${summarize(failed, spec.timeoutMs)}: ${failed.output.split("\n", 1)[0]}` };
	}

	const classified = classifyVerification(result);
	const outcome: Omit<VerificationOutcome, "summary"> = {
		...base,
		status: classified.status,
		exitCode: classified.exitCode,
		durationMs: Date.now() - startedAt,
		killed: isExecResult(result) ? result.killed : false,
		truncated: isExecResult(result) ? result.truncated : false,
		output: isExecResult(result)
			? boundVerificationOutput(result.stdout, result.stderr, spec.maxOutputBytes)
			: "",
	};
	return { ...outcome, summary: summarize(outcome, spec.timeoutMs) };
}

/** True when the outcome says nothing either way about the change. */
export function verificationFailedOpen(outcome: VerificationOutcome | null | undefined): boolean {
	return outcome ? FAIL_OPEN_STATUSES.has(outcome.status) : false;
}
