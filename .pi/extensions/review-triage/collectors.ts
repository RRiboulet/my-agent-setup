/**
 * The thin collectors: caller-supplied context, adapted into evidence items.
 *
 * The git collector measures the repository. These collectors measure nothing.
 * They take what the caller already holds — before/after file snapshots, the
 * session's record of its own edits, results a check left behind — and shape
 * it into the `EvidenceItem`s the dossier consumes. Three rules hold across all
 * three:
 *
 *   - **Nothing is run and nothing is read.** No filesystem, no child process,
 *     and no clock that was not handed in as an argument. The validation
 *     collector in particular only *consumes* results: running a check would
 *     make the evidence depend on when the tool happened to be called, and a
 *     check started by the triage tool would be a side effect a recommendation
 *     is not allowed to have.
 *   - **A gap is recorded, not filled.** Without a baseline there is no diff,
 *     and no diff is invented: the artifact is recorded with its extent
 *     unknown and a limitation says exactly what is missing. An assumed-zero
 *     change is how a confident "no review" gets fabricated.
 *   - **Caller text is data.** Paths, check names and outcome labels arrive
 *     from outside; they are carried as untrusted text, never as instructions,
 *     and an outcome label this collector does not recognise becomes `unknown`,
 *     never `passed`.
 *
 * Everything here is pure: the same caller input and reference time always
 * yields the same items. The validation collector is the one consumer of a
 * clock, and it only reads the `now` it was handed; with none, freshness is
 * `unknown` and the items are wall-clock independent. Caller strings are
 * capped per field, with the truncation recorded rather than silent.
 *
 * The artifact and validation collectors return items; the harness collector
 * also returns the task fields and supplementary context it produces, because
 * those are not evidence items.
 */

import type { ArtifactFlags } from "./evidence.ts";
import type {
	EvidenceCompleteness,
	EvidenceFreshness,
	EvidenceItem,
	EvidenceSource,
	LimitationItem,
	ValidationOutcome,
} from "./dossier.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Trimmed caller text, or undefined when there is none. Caller text is data. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Longest caller-supplied text carried per field. Caller strings are unbounded,
 * and one enormous entry can otherwise crowd the dossier's budget and evict the
 * caller's own other evidence. This is a safety valve, not a design limit.
 */
export const MAX_CALLER_TEXT = 2_000;

/**
 * Read caller text with the per-field cap, counting truncations so the
 * collector can record them once. Caller text is data, never instructions.
 */
function textReader(): { read(value: unknown): string | undefined; truncated(): number } {
	let truncated = 0;
	return {
		read(value: unknown): string | undefined {
			const trimmed = text(value);
			if (trimmed === undefined) return undefined;
			if (trimmed.length <= MAX_CALLER_TEXT) return trimmed;
			truncated += 1;
			return trimmed.slice(0, MAX_CALLER_TEXT);
		},
		truncated: () => truncated,
	};
}

/** A limitation item: the collector's own observation about a gap, as evidence. */
function limitation(
	source: EvidenceSource,
	provenance: string,
	message: string,
	completeness: EvidenceCompleteness,
): LimitationItem {
	return {
		source,
		kind: "limitation",
		provenance,
		snapshot: "unknown",
		completeness,
		trust: "observed",
		text: message,
	};
}

// ---------------------------------------------------------------------------
// Artifact collector (no git)
// ---------------------------------------------------------------------------

export interface CallerArtifact {
	/** The path, as the caller knows it. */
	path: string;
	/** Content before the change. With `after`, the collector diffs the two. */
	before?: string;
	/** Content after the change. With `before`, the collector diffs the two. */
	after?: string;
	/** Asserted counts, when the caller has them instead of snapshots. */
	added?: number;
	removed?: number;
	/** Status letter when the caller knows it (`A`, `M`, `D`, …). */
	status?: string;
	flags?: ArtifactFlags;
}

export interface ArtifactCollectorOptions {
	/** Baseline identity stamped on every item; `unknown` when the caller has none. */
	baseline?: string;
}

/**
 * The line cap on a computed diff. The diff is quadratic in the line count, so
 * a snapshot pair beyond the cap is recorded with its extent unknown — and a
 * limitation says to supply explicit counts for large artifacts — rather than
 * diffed at a cost that grows with the file.
 */
export const MAX_DIFF_LINES = 1_000;

/**
 * Split content into comparable lines. A trailing newline does not start a new
 * (empty) line, and a CR before each LF is dropped, so the same content with
 * different line endings compares equal instead of diffing on every line.
 */
function toLines(content: string): string[] {
	if (content === "") return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * The minimal line diff between two snapshots, as counts and a zero-context
 * patch (`-`/`+` lines, the shape the git collector's patch budget reads).
 * LCS-based: an edit shows as one removal and one addition, a pure insert or
 * delete shows as only one side, and the walk keeps line order. A tie in the
 * backtrack prefers the removal, so the same pair of snapshots always yields
 * the same patch.
 */
function diffSnapshots(before: string, after: string): { added: number; removed: number; patch: string } {
	const left = toLines(before);
	const right = toLines(after);
	// Suffix-form LCS table: lcs[i][j] is the LCS length of left[i:] and right[j:].
	const width = right.length + 1;
	const lcs = new Uint32Array((left.length + 1) * width);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			lcs[i * width + j] =
				left[i] === right[j]
					? lcs[(i + 1) * width + j + 1] + 1
					: Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
		}
	}

	const patch: string[] = [];
	let added = 0;
	let removed = 0;
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			i++;
			j++;
		} else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
			patch.push(`-${left[i++]}`);
			removed++;
		} else {
			patch.push(`+${right[j++]}`);
			added++;
		}
	}
	while (i < left.length) {
		patch.push(`-${left[i++]}`);
		removed++;
	}
	while (j < right.length) {
		patch.push(`+${right[j++]}`);
		added++;
	}
	return { added, removed, patch: patch.join("\n") };
}

interface DiffedContext {
	snapshot: string;
	/** Asserted counts, when the caller supplied them alongside snapshots. */
	asserted?: { added: number; removed: number };
	status?: string;
	flags?: ArtifactFlags;
}

/**
 * The computed-diff path: both snapshots present. The diff is derived from
 * the content the caller supplied, so it is observed, not asserted — and the
 * caller's own status, when there is one, outranks the inference.
 */
function diffedArtifact(path: string, before: string, after: string, context: DiffedContext): EvidenceItem[] {
	const beforeLines = toLines(before);
	const afterLines = toLines(after);

	// Beyond the cap the snapshots are recorded with their extent unknown
	// rather than diffed at quadratic cost.
	if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
		const inferred =
			beforeLines.length === 0 && afterLines.length > 0
				? "A"
				: afterLines.length === 0 && beforeLines.length > 0
					? "D"
					: undefined;
		const status = context.status ?? inferred;
		return [
			{
				source: "filesystem",
				kind: "artifact-change",
				provenance: "caller-supplied before/after snapshots",
				snapshot: context.snapshot,
				completeness: context.asserted ? "complete" : "missing",
				trust: "asserted",
				path,
				added: context.asserted?.added ?? 0,
				removed: context.asserted?.removed ?? 0,
				...(status ? { status } : {}),
				...(context.flags ? { flags: context.flags } : {}),
			},
			limitation(
				"filesystem",
				"caller-supplied before/after snapshots",
				context.asserted
					? `the snapshot for ${path} exceeds ${MAX_DIFF_LINES} lines and was not diffed; the stated counts (+${context.asserted.added}/-${context.asserted.removed}) were used`
					: `the snapshot for ${path} exceeds ${MAX_DIFF_LINES} lines and was not diffed; its extent is unknown — supply explicit counts for large artifacts`,
				"partial",
			),
		];
	}

	const diff = diffSnapshots(before, after);
	const inferred =
		beforeLines.length === 0 && afterLines.length > 0
			? "A"
			: afterLines.length === 0 && beforeLines.length > 0
				? "D"
				: undefined;
	const status = context.status ?? inferred;

	const items: EvidenceItem[] = [
		{
			source: "filesystem",
			kind: "artifact-change",
			provenance: "computed from caller-supplied before/after snapshots",
			snapshot: context.snapshot,
			completeness: "complete",
			trust: "observed",
			path,
			added: diff.added,
			removed: diff.removed,
			...(status ? { status } : {}),
			...(diff.patch ? { patch: diff.patch } : {}),
			...(context.flags ? { flags: context.flags } : {}),
		},
	];

	// Asserted counts that disagree with the computed diff lose, and the
	// disagreement is recorded rather than silently resolved.
	if (context.asserted && (context.asserted.added !== diff.added || context.asserted.removed !== diff.removed)) {
		items.push(
			limitation(
				"filesystem",
				"caller-supplied before/after snapshots",
				`the asserted counts for ${path} (+${context.asserted.added}/-${context.asserted.removed}) disagree with the snapshot diff (+${diff.added}/-${diff.removed}); the computed diff was used`,
				"partial",
			),
		);
	}

	return items;
}

/**
 * Adapt caller-supplied artifacts into evidence items, for changes the git
 * collector cannot see (no repository, or files git is not tracking).
 *
 * Both snapshots present → the diff is computed. Otherwise the artifact is
 * recorded with its extent unknown — asserted counts when the caller has
 * them, `missing` completeness when not — and a limitation says what is
 * missing. A diff without a baseline is never fabricated.
 */
export function collectArtifacts(
	entries: readonly CallerArtifact[],
	options: ArtifactCollectorOptions = {},
): EvidenceItem[] {
	const items: EvidenceItem[] = [];
	const { read, truncated } = textReader();
	const snapshot = read(options.baseline) ?? "unknown";

	if (entries !== undefined && !Array.isArray(entries)) {
		// A non-list would iterate as characters or throw on .map — the same
		// silent-garbage failure the harness collector guards against.
		items.push(
			limitation(
				"filesystem",
				"caller artifact list",
				"the artifact list was not a list; nothing was read",
				"missing",
			),
		);
		return items;
	}

	for (const entry of entries ?? []) {
		const path = read(entry?.path);
		if (!path) {
			items.push(
				limitation(
					"filesystem",
					"caller artifact list",
					"an artifact entry without a usable path was dropped",
					"missing",
				),
			);
			continue;
		}

		const before = typeof entry.before === "string" ? entry.before : undefined;
		const after = typeof entry.after === "string" ? entry.after : undefined;
		// Counts must be usable line counts: a negative or non-numeric value is
		// a caller mistake, recorded rather than trusted.
		const usableCount = (value: unknown): value is number =>
			Number.isFinite(value) && (value as number) >= 0;
		const asserted =
			usableCount(entry.added) && usableCount(entry.removed)
				? { added: entry.added as number, removed: entry.removed as number }
				: undefined;
		const rawFlags = entry.flags;
		const flags = rawFlags && typeof rawFlags === "object" ? rawFlags : undefined;
		if (rawFlags !== undefined && flags === undefined) {
			items.push(
				limitation(
					"filesystem",
					"caller artifact list",
					`the flags supplied for ${path} were not an object; they were dropped`,
					"partial",
				),
			);
		}
		const status = read(entry.status);

		if (before !== undefined && after !== undefined) {
			items.push(...diffedArtifact(path, before, after, { snapshot, asserted, status, flags }));
			continue;
		}

		// No usable baseline — one side of the snapshot, or none at all.
		items.push({
			source: "filesystem",
			kind: "artifact-change",
			provenance: "caller artifact list",
			snapshot,
			completeness: asserted ? "complete" : "missing",
			trust: "asserted",
			path,
			added: asserted?.added ?? 0,
			removed: asserted?.removed ?? 0,
			...(status ? { status } : {}),
			...(flags ? { flags } : {}),
		});
		if (!asserted) {
			items.push(
				limitation(
					"filesystem",
					"caller artifact list",
					before !== undefined || after !== undefined
						? `only one side of the snapshot was supplied for ${path}; with no baseline its extent is unknown and no diff was fabricated`
						: `the artifact list entry for ${path} states no usable counts (${JSON.stringify(entry.added)}/${JSON.stringify(entry.removed)}) and no snapshots; its extent is unknown`,
					"missing",
				),
			);
		}
	}

	if (truncated() > 0) {
		items.push(
			limitation(
				"filesystem",
				"caller artifact list",
				`${truncated()} caller text field(s) were truncated to ${MAX_CALLER_TEXT} characters`,
				"partial",
			),
		);
	}

	return items;
}

// ---------------------------------------------------------------------------
// Harness context collector
// ---------------------------------------------------------------------------

export interface HarnessEditRecord {
	path: string;
	/** The tool that made the edit, when the harness record knows it. */
	tool?: string;
}

export interface HarnessContextInput {
	/** What the change is trying to achieve. */
	objective?: string;
	/** How the caller will know it is done. */
	acceptanceCriteria?: readonly string[];
	/** Which task this is, e.g. a todo id. */
	identity?: string;
	/** Edits the harness itself recorded — see the coverage limitation. */
	recordedEdits?: readonly HarnessEditRecord[];
	/** Recorded tool output that is context, not an artifact or a check. */
	toolResults?: readonly string[];
	/** What the author knows is still broken or unfinished. */
	unresolvedIssues?: readonly string[];
}

export interface HarnessContext {
	/** The task fields the dossier's task section takes directly. */
	task: { objective?: string; acceptance: string[]; identity?: string };
	/** Recorded tool output, passed through verbatim. */
	supplementary: string[];
	items: EvidenceItem[];
}

/**
 * Adapt the harness's own record of the session into evidence. The objective,
 * acceptance criteria and identity become the dossier's task fields; recorded
 * edits become artifact items with their extent unknown; recorded tool output
 * becomes supplementary context; unresolved issues become self-reported
 * limitations.
 *
 * The coverage limitation is the point of the edit record: the harness sees
 * its own edit and write tool calls, so an agent that changed a file through a
 * shell command leaves no trace the collector can find. The record is partial
 * even when it is non-empty, and says so.
 */
export function collectHarnessContext(input: HarnessContextInput): HarnessContext {
	const items: EvidenceItem[] = [];

	if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
		// Every field of a non-object reads as undefined, which would make an
		// unusable context look like an empty one; say what happened instead.
		return {
			task: { acceptance: [] },
			supplementary: [],
			items: [
				limitation(
					"harness",
					"the session record",
					"the harness context was not an object; it was not read",
					"missing",
				),
			],
		};
	}

	const { read, truncated } = textReader();
	const objective = read(input?.objective);
	const identity = read(input?.identity);
	const acceptance = (input?.acceptanceCriteria ?? [])
		.map((criterion) => read(criterion))
		.filter((criterion): criterion is string => criterion !== undefined);

	const edits = input?.recordedEdits;
	if (edits !== undefined && !Array.isArray(edits)) {
		// A non-list would iterate as characters or throw on .map; the same
		// guard pattern covers the other two harness lists below.
		items.push(
			limitation(
				"harness",
				"the session record",
				"the recorded edits were not a list; the edit record was not read",
				"missing",
				),
		);
	} else if (Array.isArray(edits)) {
		for (const edit of edits) {
			const path = read(edit?.path);
			if (!path) {
				items.push(
					limitation(
						"harness",
						"session tool record",
						"a recorded edit without a usable path was dropped",
						"missing",
					),
				);
				continue;
			}
			const tool = read(edit?.tool);
			items.push({
				source: "harness",
				kind: "artifact-change",
				provenance: tool ? `session tool record (${tool})` : "session tool record",
				snapshot: "unknown",
				// The record says the file was edited, not by how much: no
				// counts and no patch are invented for it.
				completeness: "partial",
				trust: "observed",
				path,
				added: 0,
				removed: 0,
			});
		}
		items.push(
			limitation(
				"harness",
				"session tool record",
				edits.length === 0
					? "the harness record contains no recorded edits; edits made through shell commands are invisible to it, so the change's footprint is unknown"
					: "the harness record covers edit and write tool calls only; edits made through shell commands are invisible to it, so recorded coverage of the change is partial",
				"partial",
			),
		);
	}

	const toolResults = input?.toolResults;
	let supplementary: string[] = [];
	if (toolResults !== undefined && !Array.isArray(toolResults)) {
		items.push(
			limitation(
				"harness",
				"the session record",
				"the recorded tool results were not a list; they were not read",
				"missing",
				),
		);
	} else {
		supplementary = (toolResults ?? [])
			.map((result) => read(result))
			.filter((result): result is string => result !== undefined);
	}

	const issues = input?.unresolvedIssues;
	if (issues !== undefined && !Array.isArray(issues)) {
		items.push(
			limitation(
				"harness",
				"the change's author",
				"the unresolved issues were not a list; they were not read",
				"missing",
				),
		);
	} else {
		for (const issue of issues ?? []) {
			const unresolved = read(issue);
			if (!unresolved) continue;
			items.push({
				source: "harness",
				kind: "limitation",
				provenance: "the change's author",
				snapshot: "unknown",
				completeness: "missing",
				trust: "self-reported",
				text: unresolved,
			});
		}
	}

	if (truncated() > 0) {
		items.push(
			limitation(
				"harness",
				"the session record",
				`${truncated()} caller text field(s) were truncated to ${MAX_CALLER_TEXT} characters`,
				"partial",
			),
		);
	}

	return {
		task: {
			...(objective ? { objective } : {}),
			acceptance,
			...(identity ? { identity } : {}),
		},
		supplementary,
		items,
	};
}

// ---------------------------------------------------------------------------
// Validation collector
// ---------------------------------------------------------------------------

export interface ExistingValidationResult {
	/** The check's name, as the record knows it. */
	check: string;
	/** The outcome label exactly as whatever produced it recorded it. */
	outcome?: string;
	/** What produced the result — the runner, the command, the CI step. */
	provenance?: string;
	/** When the check ran, epoch milliseconds. Absent → freshness unknown. */
	ranAt?: number;
	/** The baseline identity the check ran against. */
	snapshot?: string;
	/** Free text from the result. */
	detail?: string;
}

export interface ValidationCollectorOptions {
	/** The reference time for freshness, epoch ms. Omitted → freshness unknown. */
	now?: number;
}

/**
 * Triage runs right after a change is finished, so a result from the last hour
 * still describes the change while an older one may predate the last edits.
 */
export const DEFAULT_FRESH_WINDOW_MS = 60 * 60 * 1000;

/**
 * Adapt results a check already produced into evidence items. Nothing is run:
 * the collector only reshapes what exists. Each record carries its provenance
 * and freshness, and the four outcomes stay distinct — an unrecognised label
 * becomes `unknown`, never `passed`, because an ambiguous result laundered
 * into a pass is exactly what the review gate must not do.
 */
export function collectValidations(
	results: readonly ExistingValidationResult[],
	options: ValidationCollectorOptions = {},
): EvidenceItem[] {
	const now = options.now;
	const items: EvidenceItem[] = [];
	const { read, truncated } = textReader();

	if (results !== undefined && !Array.isArray(results)) {
		items.push(
			limitation(
				"harness",
				"caller validation record",
				"the validation results were not a list; nothing was read",
				"missing",
			),
		);
		return items;
	}

	for (const result of results ?? []) {
		const check = read(result?.check);
		if (!check) {
			items.push(
				limitation(
					"harness",
					"caller validation record",
					"a validation result without a usable check name was dropped",
					"missing",
				),
			);
			continue;
		}

		const rawOutcome = read(result?.outcome);
		const label = rawOutcome?.toLowerCase();
		let outcome: ValidationOutcome;
		let recognised: boolean;
		if (label === undefined) {
			// The check is in the record but produced no result.
			outcome = "not-run";
			recognised = true;
		} else if (label === "passed" || label === "failed" || label === "not-run" || label === "unknown") {
			outcome = label;
			recognised = true;
		} else {
			outcome = "unknown";
			recognised = false;
		}

		const provenance = read(result?.provenance);
		const ranAt = result?.ranAt;
		let freshness: EvidenceFreshness = "unknown";
		if (Number.isFinite(ranAt) && Number.isFinite(now)) {
			const age = (now as number) - (ranAt as number);
			// A run time in the future is a clock problem, not a fresh result.
			freshness = age < 0 ? "unknown" : age <= DEFAULT_FRESH_WINDOW_MS ? "fresh" : "stale";
		}

		const detailParts = [read(result?.detail)];
		if (!recognised) detailParts.push(`the recorded outcome label was ${JSON.stringify(rawOutcome)}`);
		const detail = detailParts.filter((part): part is string => part !== undefined).join(" ");

		items.push({
			source: "harness",
			kind: "validation-result",
			provenance: provenance ?? "unspecified",
			snapshot: read(result?.snapshot) ?? "unknown",
			// Completeness describes the record, not the outcome: a tool that
			// honestly reported `unknown` produced a complete record, while an
			// unrecognised label means the collector could not read the result.
			completeness: recognised && provenance !== undefined ? "complete" : "partial",
			trust: provenance !== undefined ? "asserted" : "self-reported",
			check,
			outcome,
			freshness,
			...(detail ? { detail } : {}),
		});
	}

	if (truncated() > 0) {
		items.push(
			limitation(
				"harness",
				"caller validation record",
				`${truncated()} caller text field(s) were truncated to ${MAX_CALLER_TEXT} characters`,
				"partial",
			),
		);
	}

	return items;
}
