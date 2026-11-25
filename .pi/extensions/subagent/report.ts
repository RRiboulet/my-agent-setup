// The child's final report: the structured envelope it ends with, and the
// standalone artifact the parent writes beside the run's transcript.
//
// Why this exists. `result.json` carries a child's *final text*, and the parent
// truncates that text with pi's tool-output bounds into `RunRecord.output`. A
// human who wants the rest has to open the child's session JSONL, which is a
// versioned internal format rather than a contract. The report artifact is the
// contract: the complete final text, in its own file, readable without parsing a
// transcript. The bounded copy is duplicated into the run record on purpose —
// a consumer that reads only `subagent_status`/`runs.json` still works, and a
// consumer that wants everything reads one file.
//
// The envelope is a fenced block tagged `subagent-report`, so it can be found
// in ordinary prose without guessing which JSON block was meant:
//
//     ```subagent-report
//     {"version":1,"status":"ok","summary":"...","files":["..."],"commands":["..."],"unresolved":["..."]}
//     ```
//
// Versioning, and what an older peer sees. The envelope carries its own
// `version`, independent of `CHILD_RESULT_VERSION` in result.ts, because this
// contract can evolve without changing the result file's shape:
//   - A parent that predates the artifact simply ignores the extra optional
//     `report` field in `result.json` (the result validator gates on shape, not
//     version) and keeps using `output` as it always did.
//   - A child that predates this contract writes no `report` field and no
//     envelope; the new parent degrades to the child's plain final text and
//     says so in `RunReport.degradation`. That is a normal outcome, not an
//     error: children may run another branch's build.
//   - A newer child with a compatible shape is accepted and `skew` records the
//     version difference. A newer *incompatible* shape is reported as skew too,
//     but as a degradation — a run never fails because its report is unusable.
//
// The reader follows result.ts's convention: the shape is the gate, the version
// is advisory and is quoted when it explains a rejection. No branch here throws
// on a child's bytes.
//
// Bounded reads. `readReportHead` reads at most one truncation window from the
// artifact and stats the file for its full size, so a 100 MB report cannot be
// loaded into the parent's run index. The head is bounded with pi's own
// `truncateHead`/`DEFAULT_MAX_*` — no new limits are invented here.

import { randomUUID } from "node:crypto";
import { open, rename, rm, stat, writeFile } from "node:fs/promises";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

/** The report contract version this build understands. */
export const CHILD_REPORT_VERSION = 1;

/** The fence tag that identifies the machine-readable envelope. */
export const REPORT_FENCE = "subagent-report";

/** The standalone artifact, beside `result.json` in the run directory. */
export const REPORT_FILE_NAME = "report.md";

export type ReportStatus = "ok" | "blocked" | "failed";

/** The envelope a child ends its final message with. */
export interface ChildReport {
	version: number;
	status: ReportStatus;
	summary: string;
	files?: string[];
	commands?: string[];
	unresolved?: string[];
}

/**
 * A parsed or rejected envelope.
 *
 * `missing` means there was no block at all; `malformed` means a block or a
 * value was there and unusable; `skew` means the version differs and the shape
 * cannot be read by this build. `ok` with `skew` is the third case: a different
 * version whose shape this build understands.
 */
export type ChildReportValidation =
	| { ok: true; report: ChildReport; skew?: { writer: number; reader: number } }
	| { ok: false; reason: "missing" | "malformed" | "skew"; error: string };

/** What the parent keeps of a report's own fields, after bounding. */
export interface BoundedReport {
	status: ReportStatus;
	summary: string;
	files?: string[];
	commands?: string[];
	unresolved?: string[];
	/** Some field was clipped to the truncation window. */
	truncated: boolean;
}

/** A bounded head read from an artifact, plus the artifact's full size. */
export interface ReportHead {
	head: string;
	bytes: number;
	truncated: boolean;
}

/**
 * The report as it appears in a `RunRecord` / `runs.json`.
 *
 * `artifactPath` and `artifactBytes` are the pointer a consumer follows;
 * `head` is the bounded copy it can use without following it. The envelope
 * fields are present only when a report parsed, so their absence is the signal
 * that `degradation` applies.
 */
export interface RunReport extends Partial<BoundedReport> {
	artifactPath: string;
	artifactBytes: number;
	head: string;
	truncated: boolean;
	version?: number;
	degradation?: string;
	skew?: { writer: number; reader: number };
}

const REPORT_STATUSES: ReadonlySet<string> = new Set<ReportStatus>(["ok", "blocked", "failed"]);

function malformedOrSkew(value: unknown, detail: string): ChildReportValidation {
	const version = (value as { version?: unknown } | null)?.version;
	if (typeof version === "number" && Number.isInteger(version) && version !== CHILD_REPORT_VERSION) {
		return {
			ok: false,
			reason: "skew",
			error:
				`${detail}; it is report version ${version} and this parent reads version ${CHILD_REPORT_VERSION}, ` +
				`so the child is probably a different build of this extension`,
		};
	}
	return { ok: false, reason: "malformed", error: detail };
}

/**
 * Validate an already-parsed report envelope.
 *
 * Every field a consumer dereferences is checked, and unknown extra fields are
 * ignored — the same compatibility rule result.ts applies to `result.json`.
 * A rejection is a value, never an exception.
 */
export function validateChildReport(value: unknown): ChildReportValidation {
	if (value === undefined) {
		return { ok: false, reason: "missing", error: "the child supplied no subagent-report block" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return malformedOrSkew(value, "the subagent-report block must be a JSON object");
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.version !== "number" || !Number.isInteger(candidate.version)) {
		return malformedOrSkew(value, "version is missing or is not an integer");
	}
	if (typeof candidate.status !== "string" || !REPORT_STATUSES.has(candidate.status)) {
		return malformedOrSkew(value, `status is ${JSON.stringify(candidate.status)}, not "ok", "blocked" or "failed"`);
	}
	if (typeof candidate.summary !== "string") {
		return malformedOrSkew(value, "summary is missing or is not a string");
	}
	const lists: Record<"files" | "commands" | "unresolved", string[] | undefined> = {
		files: undefined,
		commands: undefined,
		unresolved: undefined,
	};
	for (const field of ["files", "commands", "unresolved"] as const) {
		const raw = candidate[field];
		if (raw === undefined) continue;
		if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
			return malformedOrSkew(value, `${field} must be an array of strings when present`);
		}
		lists[field] = raw as string[];
	}
	const report: ChildReport = {
		version: candidate.version,
		status: candidate.status as ReportStatus,
		summary: candidate.summary,
		...(lists.files === undefined ? {} : { files: lists.files }),
		...(lists.commands === undefined ? {} : { commands: lists.commands }),
		...(lists.unresolved === undefined ? {} : { unresolved: lists.unresolved }),
	};
	return candidate.version === CHILD_REPORT_VERSION
		? { ok: true, report }
		: { ok: true, report, skew: { writer: candidate.version, reader: CHILD_REPORT_VERSION } };
}

/**
 * Find the last fenced `subagent-report` block in a child's final text.
 *
 * Last, not first: a child may quote the instruction earlier in its answer. An
 * unterminated block is taken to the end of the text rather than discarded,
 * because a writer whose stream was cut off still wrote something usable in
 * every other respect.
 */
function extractReportBlock(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	let block: string[] | undefined;
	let found: string | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (block === undefined) {
			const opener = /^(```+|~~~+)\s*(.*)$/.exec(trimmed);
			if (opener && opener[2]?.toLowerCase().split(/\s+/, 1)[0] === REPORT_FENCE) block = [];
			continue;
		}
		if (/^(```+|~~~+)\s*$/.test(trimmed)) {
			found = block.join("\n");
			block = undefined;
			continue;
		}
		block.push(line);
	}
	if (block !== undefined) found = block.join("\n");
	return found;
}

/** Parse the envelope out of a child's final text. Never throws. */
export function parseChildReportText(text: string): ChildReportValidation {
	const block = extractReportBlock(text);
	if (block === undefined) {
		return { ok: false, reason: "missing", error: "the child's final text carries no subagent-report block" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(block);
	} catch (error) {
		return {
			ok: false,
			reason: "malformed",
			error: `the subagent-report block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return validateChildReport(parsed);
}

/**
 * Prefer the child's structured field, then its text.
 *
 * A child from this build sends both; an older child sends only text; a newer
 * child may send a report shape this parent cannot read while its text still
 * carries a readable envelope. Only when both fail does the result degrade, and
 * the more specific of the two failures is the one reported.
 */
export function resolveChildReport(report: unknown, text: string): ChildReportValidation {
	const structured = validateChildReport(report);
	if (structured.ok) return structured;
	const parsed = parseChildReportText(text);
	if (parsed.ok) return parsed;
	return structured.reason === "missing" ? parsed : structured;
}

/** Bound a report's own fields with pi's truncation limits. */
export function boundChildReport(report: ChildReport): BoundedReport {
	const summary = truncateHead(report.summary, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const boundList = (values: string[] | undefined): { values?: string[]; truncated: boolean } => {
		if (values === undefined) return { truncated: false };
		// Joined and re-split because pi's helpers bound text, not arrays. Report
		// list entries are single-line paths and commands in practice, so this is
		// the same window a text field would get.
		const bound = truncateHead(values.join("\n"), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		return { values: bound.content ? bound.content.split("\n") : [], truncated: bound.truncated };
	};
	const files = boundList(report.files);
	const commands = boundList(report.commands);
	const unresolved = boundList(report.unresolved);
	return {
		status: report.status,
		summary: summary.content,
		...(files.values === undefined ? {} : { files: files.values }),
		...(commands.values === undefined ? {} : { commands: commands.values }),
		...(unresolved.values === undefined ? {} : { unresolved: unresolved.values }),
		truncated: summary.truncated || files.truncated || commands.truncated || unresolved.truncated,
	};
}

/**
 * Build the run-record copy of a report from its parse result and artifact head.
 *
 * Pure, so the degradation and skew cases can be asserted without a watcher.
 * `degradation` lets a caller replace the parse failure with a more specific
 * one (an artifact write error, for instance).
 */
export function buildRunReport(options: {
	artifactPath: string;
	head: ReportHead;
	parsed: ChildReportValidation;
	degradation?: string;
}): RunReport {
	const base: RunReport = {
		artifactPath: options.artifactPath,
		artifactBytes: options.head.bytes,
		head: options.head.head,
		truncated: options.head.truncated,
	};
	if (!options.parsed.ok) {
		return { ...base, degradation: options.degradation ?? options.parsed.error };
	}
	const bounded = boundChildReport(options.parsed.report);
	return {
		...base,
		version: options.parsed.report.version,
		status: bounded.status,
		summary: bounded.summary,
		...(bounded.files === undefined ? {} : { files: bounded.files }),
		...(bounded.commands === undefined ? {} : { commands: bounded.commands }),
		...(bounded.unresolved === undefined ? {} : { unresolved: bounded.unresolved }),
		truncated: base.truncated || bounded.truncated,
		...(options.degradation === undefined ? {} : { degradation: options.degradation }),
		...(options.parsed.skew === undefined ? {} : { skew: options.parsed.skew }),
	};
}

/**
 * Write the complete final text as the artifact.
 *
 * Atomic rename, like every other file this extension publishes: the parent is
 * the only writer here, but a reader must never see a half-written report.
 */
export async function writeReportArtifact(filePath: string, text: string): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
	try {
		await rename(temporaryPath, filePath);
	} catch (error) {
		// A failed rename (a directory in the way, a read-only run dir) would
		// otherwise leave the write behind in the run dir forever.
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

/**
 * Read a bounded head of an artifact and report its full size.
 *
 * Only one truncation window is read, plus one byte to tell "exactly at the
 * bound" from "longer than the bound". `bytes` comes from `stat`, so a consumer
 * learns the real size without the parent ever holding the file in memory.
 */
export async function readReportHead(filePath: string): Promise<ReportHead> {
	const info = await stat(filePath);
	const handle = await open(filePath, "r");
	let raw: string;
	let bytesRead: number;
	try {
		const window = Math.min(info.size, DEFAULT_MAX_BYTES + 1);
		const buffer = Buffer.alloc(window);
		const read = await handle.read(buffer, 0, window, 0);
		bytesRead = read.bytesRead;
		raw = buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
	const truncated = truncateHead(raw, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	return {
		head: truncated.content,
		bytes: info.size,
		truncated: truncated.truncated || info.size > bytesRead,
	};
}

/**
 * The child-facing instruction, appended to every delegated task prompt.
 *
 * Exported so a test can assert the prompt and the parser cannot drift: the
 * fence tag here is the one `extractReportBlock` looks for, and the schema in
 * the example is the one `validateChildReport` accepts.
 */
export const CHILD_REPORT_INSTRUCTION = `## Final report

End your final message with exactly one fenced block tagged \`subagent-report\`,
as the last thing you write. It is a machine-readable summary for your parent;
the rest of your message is still the answer a human reads, so do not replace it.

\`\`\`${REPORT_FENCE}
{"version":${CHILD_REPORT_VERSION},"status":"ok","summary":"one or two sentences: what you did and whether it worked","files":["path/to/changed-file"],"commands":["command you ran to verify"],"unresolved":["anything still open"]}
\`\`\`

Rules:
- \`status\` is "ok" when the task is done, "blocked" when you stopped because a
  decision is needed, and "failed" when it did not work.
- \`summary\` is required. \`files\`, \`commands\` and \`unresolved\` are optional;
  use \`[]\` when there is nothing to list.
- List the files you changed, the commands you ran to verify the work, and any
  question the parent must answer. Do not invent entries: leave a list out when
  it does not apply.`;

/** The task prompt every child receives: the task, then the report contract. */
export function buildChildTaskPrompt(task: string): string {
	return `# Delegated task\n\n${task}\n\n${CHILD_REPORT_INSTRUCTION}\n`;
}
