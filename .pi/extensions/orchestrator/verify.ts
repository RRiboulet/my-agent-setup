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
 * **Exit code 0 is not the same as verified.** Two cheap qualifications keep a
 * green status from being meaningless: a command line that syntactically
 * discards its own failure (`npm test || true`, a trailing `2>/dev/null`) and a
 * run whose output reports zero tests are both reported, and both are fail-open
 * so a false positive cannot trap a session. `verification.successPattern` is
 * the opt-in third check for a runner whose output is the real contract. The
 * construct, indicator or pattern that decided a qualified status is kept in
 * `VerificationOutcome.evidence`, so the verdict can say what to fix.
 *
 * This module performs no I/O of its own: `runVerification` takes the `exec`
 * function, which is `pi.exec` in production and a scripted double in tests.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type VerificationStatus =
	| "passed"
	| "failed"
	| "timed-out"
	| "truncated"
	| "unavailable"
	| "weak-command"
	| "inconclusive";

/** Statuses that settle the run instead of blocking it (R33's fail-open rule). */
export const FAIL_OPEN_STATUSES: ReadonlySet<VerificationStatus> = new Set<VerificationStatus>([
	"timed-out",
	"truncated",
	"unavailable",
	"weak-command",
	"inconclusive",
]);

export interface VerificationSpec {
	command: string;
	timeoutMs: number;
	maxOutputBytes: number;
	/** Opt-in regular expression the bounded output must match for `passed`. */
	successPattern?: string | null;
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
	/** The construct, indicator or pattern that decided a qualified status
	 *  (`weak-command`, `inconclusive`, a pattern mismatch), for a reader who needs
	 *  to fix the command. Optional because verdicts persisted by an earlier build
	 *  do not carry it. */
	evidence?: string | null;
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
 * reason a reader can act on. This is the exit-code-only reading, kept for
 * callers that have no command or output; `classifyVerificationEvidence` is the
 * one the gate's own run uses.
 */
export function classifyVerification(result: unknown): { status: VerificationStatus; exitCode: number | null } {
	if (!isExecResult(result)) return { status: "unavailable", exitCode: null };
	if (result.truncated) return { status: "truncated", exitCode: result.code };
	if (result.killed) return { status: "timed-out", exitCode: result.code };
	if (result.code === 0) return { status: "passed", exitCode: 0 };
	return { status: "failed", exitCode: result.code };
}

// --- Evidence: what a zero exit code is worth -------------------------------

/**
 * Constructs that make a shell command line discard its own failure. Each entry
 * is a documented construct and the pattern that recognises it.
 *
 * The list is deliberately mechanical, not a shell parser:
 *
 *   * `|| true`, `|| :` — the right-hand side always succeeds;
 *   * `; true`, `; exit 0` — the last command's status is the line's status;
 *   * `set +e` — the shell stops reporting a non-zero exit at all;
 *   * a trailing `2>/dev/null` — the diagnostic that would explain a failure is
 *     redirected away, and only as the LAST thing on the line, where it applies
 *     to the whole command rather than to one stage of a pipeline.
 *
 * The known false positive is a construct inside a quoted argument
 * (`node -e "... || true"`). It is accepted because the consequence is
 * fail-open: the run settles and says the command looks weak.
 */
const WEAK_COMMAND_CONSTRUCTS: readonly { construct: string; pattern: RegExp }[] = [
	{ construct: "|| true", pattern: /\|\|\s*true\b/ },
	{ construct: "|| :", pattern: /\|\|\s*:(?=\s|$)/ },
	{ construct: "; true", pattern: /;\s*true\b/ },
	{ construct: "; exit 0", pattern: /;\s*exit\s+0\b/ },
	{ construct: "set +e", pattern: /\bset\s+\+e\b/ },
	// Only at the end of the trimmed command: mid-pipeline it applies to one
	// stage, not to the exit code the whole line reports.
	{ construct: "2>/dev/null", pattern: /2>\s*\/dev\/null\s*$/ },
];

/**
 * The failure-swallowing construct in a command line, or `null` when it has
 * none. Named rather than boolean so the verdict can tell the model what to fix.
 */
export function detectWeakCommand(command: string): string | null {
	const text = String(command ?? "").trim();
	if (!text) return null;
	for (const { construct, pattern } of WEAK_COMMAND_CONSTRUCTS) {
		if (pattern.test(text)) return construct;
	}
	return null;
}

/**
 * Output indicators that a runner matched no tests. Case-insensitive, because
 * runners capitalise differently; each entry is the documented spelling and the
 * pattern that recognises it.
 *
 *   * `0 passing` — mocha's summary when every test was skipped or none existed;
 *   * `no tests found` — jest;
 *   * `ran 0 tests` — tap and friends;
 *   * `0 tests` — the generic count line (`0 tests completed`);
 *   * `no test files` — vitest's empty-suite note.
 *
 * `0 tests failed` is NOT an indicator: it is the success line of a runner that
 * ran tests and none failed, so the pattern for `0 tests` refuses a `failed`,
 * `failing` or `failure` continuation.
 */
const ZERO_TEST_INDICATORS: readonly { indicator: string; pattern: RegExp }[] = [
	{ indicator: "0 passing", pattern: /\b0\s+passing\b/i },
	{ indicator: "no tests found", pattern: /\bno\s+tests?\s+found\b/i },
	{ indicator: "ran 0 tests", pattern: /\bran\s+0\s+tests?\b/i },
	{ indicator: "0 tests", pattern: /\b0\s+tests?\b(?!\s+(?:failed|failing|failures?)\b)/i },
	{ indicator: "no test files", pattern: /\bno\s+test\s+files?\b/i },
];

/** The zero-test indicator in bounded output, or `null` when there is none. */
export function detectZeroTests(output: string): string | null {
	const text = String(output ?? "");
	if (!text) return null;
	for (const { indicator, pattern } of ZERO_TEST_INDICATORS) {
		if (pattern.test(text)) return indicator;
	}
	return null;
}

/**
 * Compile the opt-in pattern, or `null` when there is none to apply. An invalid
 * expression is treated as absent here as well as at config time, because a
 * classifier that threw would turn a bad regex into a trapped session.
 */
function compileSuccessPattern(pattern: string | null | undefined): RegExp | null {
	if (typeof pattern !== "string" || !pattern.trim()) return null;
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

/**
 * Does the bounded output satisfy the opt-in pattern?
 *
 * `null` means the question does not apply (no pattern configured, or one that
 * does not compile); `false` is a real mismatch and makes the run `failed`.
 */
export function successPatternMatches(pattern: string | null | undefined, output: string): boolean | null {
	const compiled = compileSuccessPattern(pattern);
	if (!compiled) return null;
	return compiled.test(String(output ?? ""));
}

export interface VerificationEvidenceInput {
	result: unknown;
	/** The command line that produced the result. */
	command: string;
	/** Bounded output. Classification reads it, so the bound is what decides. */
	output: string;
	successPattern?: string | null;
}

export interface VerificationEvidence {
	status: VerificationStatus;
	exitCode: number | null;
	/** The construct, indicator or pattern behind a qualified status. */
	evidence: string | null;
}

/**
 * Classify a verification run from all the evidence available, not only its exit
 * code. Order:
 *
 *   1. a result that says nothing either way (`unavailable`, `truncated`,
 *      `timed-out`) — the existing fail-open statuses keep precedence;
 *   2. a command that syntactically discards failures — `weak-command`, never
 *      `passed`, whatever the exit code says;
 *   3. a non-zero exit — `failed`;
 *   4. output matching a zero-test indicator — `inconclusive`, because a run
 *      that matched no tests verified nothing;
 *   5. a configured `successPattern` that does not match — `failed`;
 *   6. `passed`.
 */
export function classifyVerificationEvidence(input: VerificationEvidenceInput): VerificationEvidence {
	const base = classifyVerification(input.result);
	if (base.status !== "passed" && base.status !== "failed") return { ...base, evidence: null };

	const weak = detectWeakCommand(input.command);
	if (weak) return { status: "weak-command", exitCode: base.exitCode, evidence: weak };
	if (base.status === "failed") return { ...base, evidence: null };

	const zeroTests = detectZeroTests(input.output);
	if (zeroTests) return { status: "inconclusive", exitCode: base.exitCode, evidence: zeroTests };

	if (successPatternMatches(input.successPattern, input.output) === false) {
		return { status: "failed", exitCode: base.exitCode, evidence: input.successPattern ?? null };
	}
	return { status: "passed", exitCode: base.exitCode, evidence: null };
}

function summarize(
	outcome: Omit<VerificationOutcome, "summary">,
	timeoutMs: number,
	patternWarning: string | null = null,
): string {
	const duration = `${outcome.durationMs} ms`;
	const warning = patternWarning ? ` (${patternWarning})` : "";
	switch (outcome.status) {
		case "passed":
			return `verification command \`${outcome.command}\` passed in ${duration}${warning}`;
		case "failed":
			if (outcome.evidence) {
				return `verification command \`${outcome.command}\` failed: its output did not match verification.successPattern \`${outcome.evidence}\` (exit code ${outcome.exitCode}) in ${duration}${warning}`;
			}
			return `verification command \`${outcome.command}\` failed with exit code ${outcome.exitCode} in ${duration}${warning}`;
		case "timed-out":
			return `verification command \`${outcome.command}\` was terminated after ${duration} (timeout ${timeoutMs} ms or abort)${warning}`;
		case "truncated":
			return `verification command \`${outcome.command}\` exceeded its output cap after ${duration}; output is incomplete${warning}`;
		case "unavailable":
			return `verification command \`${outcome.command}\` could not be run${warning}`;
		case "weak-command":
			return `verification command \`${outcome.command}\` discards failures with \`${outcome.evidence}\`, so its exit code is not evidence of a pass (fail-open, ${duration})${warning}`;
		case "inconclusive":
			return `verification command \`${outcome.command}\` reported no tests (\`${outcome.evidence}\`), so nothing was verified (fail-open, ${duration})${warning}`;
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

	// The bound is what classification reads: an indicator outside it did not reach
	// the reader either, so both see the same text.
	const output = isExecResult(result)
		? boundVerificationOutput(result.stdout, result.stderr, spec.maxOutputBytes)
		: "";
	const classified = classifyVerificationEvidence({
		result,
		command: spec.command,
		output,
		successPattern: spec.successPattern,
	});
	// Validated at config time; a pattern that still does not compile here is
	// ignored rather than thrown, and the summary says so.
	let patternWarning: string | null = null;
	if (typeof spec.successPattern === "string" && spec.successPattern.trim()) {
		try {
			new RegExp(spec.successPattern);
		} catch {
			patternWarning = `verification.successPattern did not compile and was ignored: ${spec.successPattern}`;
		}
	}
	const outcome: Omit<VerificationOutcome, "summary"> = {
		...base,
		status: classified.status,
		exitCode: classified.exitCode,
		durationMs: Date.now() - startedAt,
		killed: isExecResult(result) ? result.killed : false,
		truncated: isExecResult(result) ? result.truncated : false,
		output,
		evidence: classified.evidence,
	};
	return { ...outcome, summary: summarize(outcome, spec.timeoutMs, patternWarning) };
}

/** True when the outcome says nothing either way about the change. */
export function verificationFailedOpen(outcome: VerificationOutcome | null | undefined): boolean {
	return outcome ? FAIL_OPEN_STATUSES.has(outcome.status) : false;
}
