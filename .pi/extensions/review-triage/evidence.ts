/**
 * Evidence gathering for review triage.
 *
 * This module is deliberately dumb. It measures the change — files, churn,
 * the added/removed lines, structural indicators — and labels whatever
 * risk-shaped things it can see in the paths and the patch. It does not score
 * them and it does not decide anything: the labelled evidence is serialised
 * into the dossier, and Jev makes the judgement. The prose labels are what Jev
 * reads, so they are written for a reader, not for a threshold table.
 *
 * Two rules shape the git plumbing:
 *
 *   - **Paths are read NUL-separated.** `--numstat -z`, `--raw -z` and
 *     `ls-files -z` emit one NUL-terminated record per field, so a filename
 *     containing a newline, a space or a leading `-` round-trips exactly. A
 *     line-splitting parser silently mangles all three.
 *   - **Read-only.** The collector never stashes, resets, checks out, commits
 *     or otherwise touches the index; it only asks git to describe the tree.
 *
 * Every parser in here is pure and exported through `__test__` so the git
 * plumbing can be covered without a repository or a child process.
 */

import { existsSync } from "node:fs";

import type { EvidenceCompleteness, EvidenceItem } from "./dossier.ts";

export type TriageTargetKind = "uncommitted" | "branch" | "commit" | "none" | "task";

export interface TriageTarget {
	kind: TriageTargetKind;
	/** Branch name for `branch`. */
	base?: string;
	/** Commit sha for `commit`. */
	ref?: string;
	/** Baseline ref for `task`: the ref captured or configured before the task started. */
	baselineRef?: string;
}

/** Structural facts about one changed path, independent of its content. */
export interface ArtifactFlags {
	binary?: boolean;
	deletion?: boolean;
	modeChange?: boolean;
	symlink?: boolean;
	submodule?: boolean;
	conflict?: boolean;
}

/**
 * A known gap in the evidence. `blocksSkip` marks a gap serious enough that a
 * confident "no review" would be unsafe — a failed probe or unread content.
 */
export interface EvidenceLimitation {
	text: string;
	blocksSkip: boolean;
}

/** One file's measurement, retained so the dossier can build a real manifest. */
export interface ArtifactMeasurement {
	path: string;
	added: number;
	removed: number;
	/** git status letter, when known (`A`, `M`, `D`, `R100`, `U`, …). */
	status?: string;
	binary: boolean;
	/**
	 * How complete this measurement is. Normal tracked changes are `complete`;
	 * an untracked file is listed but its content was never read, so it is
	 * `missing` rather than silently reading as a zero-line change.
	 */
	completeness?: EvidenceCompleteness;
}

export interface ChangeEvidence {
	target: TriageTargetKind;
	base?: string;
	ref?: string;
	isGit: boolean;
	/** Paths touched, deduplicated. */
	files: string[];
	added: number;
	removed: number;
	newFiles: string[];
	deletedFiles: string[];
	/** Structural indicators, keyed by path. */
	indicators: Record<string, ArtifactFlags>;
	/** Per-file measurements, retained so the dossier can build a real manifest. */
	artifacts: ArtifactMeasurement[];
	/** Known gaps, recorded rather than silently assumed away. */
	limitations: EvidenceLimitation[];
	/** Human-readable risk labels; Jev reads these, nothing else scores them. */
	signals: string[];
	/** Risk the caller declared by hand. */
	notes: string[];
	/** The task scope's baseline ref (the snapshot the change is measured from). */
	baseline?: string;
	/** The agent's own one-line description of the change. */
	summary: string;
	/** Bounded, zero-context diff text. */
	patchExcerpt: string;
	truncated: boolean;
	/**
	 * True when the snapshot looked unstable around collection — an operation
	 * in progress or a probe that could not run. Policy refuses to skip on
	 * unstable evidence: a tree that changed while it was being measured
	 * cannot produce a confident "no review".
	 */
	unstable: boolean;
	/** Populated when the target could not be inspected. */
	error?: string;
}

export interface GitExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type GitExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; cwd?: string; timeout?: number },
) => Promise<GitExecResult>;

export interface CollectOptions {
	summary: string;
	notes?: string[];
	target: TriageTarget;
	cwd?: string;
	signal?: AbortSignal;
	/** Cap on the serialised patch carried into the state. */
	patchChars?: number;
	/**
	 * Existence probe for snapshot-stability markers, by absolute path.
	 * Defaults to the real filesystem; tests inject a fake so no test needs
	 * a file inside .git.
	 */
	fsExists?: (path: string) => boolean;
}

const DEFAULT_PATCH_CHARS = 8_000;

/**
 * Fixed git options. `diff.noprefix=false` keeps the `a/`/`b/` prefixes the
 * patch parser expects; `core.quotePath=false` stops git octal-escaping UTF-8
 * paths; `--no-ext-diff --no-textconv` stop a user's diff driver or textconv
 * filter from running (and from changing what the evidence says).
 */
const GIT_CONFIG_ARGS = [
	"-c",
	"diff.noprefix=false",
	"-c",
	"core.quotePath=false",
	// Rename detection is a repo-local setting; pin it so the same tree gives the
	// same evidence (and fingerprint) in every checkout.
	"-c",
	"diff.renames=true",
	"-c",
	"diff.relative=false",
];
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

// ---------------------------------------------------------------------------
// NUL-separated parsers
// ---------------------------------------------------------------------------

export interface NumstatEntry {
	path: string;
	oldPath?: string;
	added: number;
	removed: number;
	binary: boolean;
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename
 * `added\tremoved\t\0old\0new\0`. The path is everything after the second tab,
 * so a filename containing a tab survives; only the first two tabs delimit.
 */
export function parseNumstatZ(stdout: string): NumstatEntry[] {
	const records = stdout.split("\0");
	const entries: NumstatEntry[] = [];
	let index = 0;
	while (index < records.length) {
		const record = records[index++];
		if (record === "") continue;
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab >= 0 ? record.indexOf("\t", firstTab + 1) : -1;
		if (firstTab < 0 || secondTab < 0) continue;
		const rawAdded = record.slice(0, firstTab);
		const rawRemoved = record.slice(firstTab + 1, secondTab);
		const path = record.slice(secondTab + 1);
		const binary = rawAdded === "-" || rawRemoved === "-";
		const added = binary ? 0 : Number.parseInt(rawAdded, 10);
		const removed = binary ? 0 : Number.parseInt(rawRemoved, 10);
		const entry: NumstatEntry = {
			path,
			added: Number.isFinite(added) ? added : 0,
			removed: Number.isFinite(removed) ? removed : 0,
			binary,
		};
		if (path === "") {
			// A rename: the empty path field is followed by the old and new paths.
			const oldPath = records[index++];
			const newPath = records[index++];
			entry.oldPath = oldPath;
			entry.path = newPath ?? "";
		}
		// A truncated buffer can leave the rename records missing; drop the
		// phantom entry rather than let an empty path into the file list.
		if (entry.path === "") continue;
		entries.push(entry);
	}
	return entries;
}

export interface RawEntry {
	oldMode: string;
	newMode: string;
	oldSha: string;
	newSha: string;
	/** Status letter plus optional score, e.g. `M`, `A`, `D`, `R100`, `U`. */
	status: string;
	path: string;
	oldPath?: string;
}

const RAW_HEADER = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z]\d*)$/u;

/**
 * `git diff --raw -z`: `:<oldmode> <newmode> <oldsha> <newsha> <status>\0path\0`,
 * with `old\0new\0` for a rename or copy. The modes are what make mode changes,
 * symlinks and submodules visible.
 */
export function parseRawZ(stdout: string): RawEntry[] {
	const records = stdout.split("\0");
	const entries: RawEntry[] = [];
	let index = 0;
	while (index < records.length) {
		const header = records[index++];
		if (header === "") continue;
		const match = RAW_HEADER.exec(header);
		if (!match) continue;
		const [, oldMode, newMode, oldSha, newSha, status] = match as unknown as [
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const entry: RawEntry = { oldMode, newMode, oldSha, newSha, status, path: "" };
		if (status.startsWith("R") || status.startsWith("C")) {
			entry.oldPath = records[index++];
			entry.path = records[index++] ?? "";
		} else {
			entry.path = records[index++] ?? "";
		}
		if (entry.path === "") continue;
		entries.push(entry);
	}
	return entries;
}

/** `git ls-files -z` (any variant): one NUL-terminated path per record. */
export function parsePathListZ(stdout: string): string[] {
	return stdout.split("\0").filter((path) => path !== "");
}

export function indicatorsFor(entry: RawEntry, binary: boolean): ArtifactFlags {
	const deletion = entry.status.startsWith("D") || entry.newMode === "000000";
	// A new file has no old mode (`000000`), and a deletion has no new mode; a
	// mode change is only meaningful when both modes exist and differ.
	const created = entry.status.startsWith("A") || entry.oldMode === "000000";
	const modeChange = !deletion && !created && entry.oldMode !== entry.newMode;
	return {
		...(binary ? { binary: true } : {}),
		...(deletion ? { deletion: true } : {}),
		...(modeChange ? { modeChange: true } : {}),
		...(entry.newMode === "120000" ? { symlink: true } : {}),
		...(entry.newMode === "160000" ? { submodule: true } : {}),
		...(entry.status.startsWith("U") ? { conflict: true } : {}),
	};
}

// ---------------------------------------------------------------------------
// Risk labelling
// ---------------------------------------------------------------------------

/** Path categories shared with the dossier's budget ordering, so the two cannot drift. */
export const SECURITY_PATH = /(^|\/)(auth|oauth|token|secret|credential|password|passwd|crypto|cipher|permission|acl|rbac|session|cookie|login|signup|billing|payment)/iu;
export const MIGRATION_PATH = /(^|\/)(migrations?|schema)|\.sql$|prisma/iu;
const DEPENDENCY_PATH = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile|pyproject\.toml)/iu;
const INFRA_PATH = /(^|\/)(Dockerfile|\.github|\.gitlab-ci|devcontainer|docker-compose|Makefile|\.circleci)/iu;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/iu;

/** Added/removed patch lines only, so a signal is about the change, not the file. */
function changedLines(patch: string): string[] {
	return patch
		.split(/\r?\n/u)
		.filter((line) => {
			// Only the file headers (`+++ b/...`, `--- a/...`) carry a space; a
			// content line like `++x` is a real change and must survive.
			if (/^(?:\+\+\+|---) /u.test(line)) return false;
			return line.startsWith("+") || line.startsWith("-");
		});
}

/**
 * Label the change. Each label is a sentence fragment Jev can weigh; the set is
 * intentionally broad, because a false label is cheap (Jev discounts it) and a
 * missing label is what makes the judgement blind.
 */
export function detectSignals(files: string[], patch: string, added: number, removed: number): string[] {
	const signals = new Set<string>();
	const add = (label: string) => signals.add(label);

	if (files.some((path) => SECURITY_PATH.test(path))) {
		add("touches authentication, credentials, permissions or session handling");
	}
	if (files.some((path) => MIGRATION_PATH.test(path))) add("touches a database migration or schema");
	if (files.some((path) => DEPENDENCY_PATH.test(path))) add("changes a dependency manifest or lockfile");
	if (files.some((path) => INFRA_PATH.test(path))) add("changes CI, container or infrastructure configuration");
	if (files.some((path) => TEST_PATH.test(path))) add("includes test changes");
	if (added + removed > 400) add(`large change (${added} added, ${removed} removed lines)`);
	if (files.length > 8) add(`spans many files (${files.length})`);

	const lines = changedLines(patch).join("\n");
	if (/\b(fetch|XMLHttpRequest|axios|WebSocket|socket\.io|https?\.request)\b/u.test(lines)) {
		add("changes a network boundary");
	}
	if (/\b(child_process|spawn|execSync|execFile|fork)\b/u.test(lines)) {
		add("changes process execution");
	}
	if (/\b(writeFile|writeFileSync|unlink|rmSync|rmdir|chmod|rename)\b/u.test(lines)) {
		add("changes filesystem writes");
	}
	if (/(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,80}\b(FROM|WHERE|VALUES)\b|\.query\(|\.prepare\(/iu.test(lines)) {
		add("changes query construction");
	}
	if (/^[+-]\s*export\b/mu.test(lines)) add("changes the public export surface");
	if (/^[+-].*\b(try|catch|finally)\b/mu.test(lines)) add("changes error handling");
	if (/^[+-].*\b(async|await|Promise|mutex|lock|Atomics|worker_threads)\b/mu.test(lines)) {
		add("changes asynchronous or concurrent code");
	}
	if (/^[+-].*\b(interface|abstract|class|factory|adapter|wrapper|singleton)\b/mu.test(lines)) {
		add("introduces an abstraction or new type");
	}
	return [...signals];
}

// ---------------------------------------------------------------------------
// Snapshot stability
// ---------------------------------------------------------------------------

/**
 * Marker paths, relative to .git, whose existence means a git operation may
 * still be running — so the tree being measured can change mid-collect, and
 * whatever the diffs say is provisional. `rebase-merge`/`rebase-apply` are
 * directories; the rest are files. `BISECT_LOG` is included: a bisect moves
 * HEAD without touching it in a way `diff` would notice.
 */
export const INSTABILITY_MARKERS: readonly { file: string; reason: string }[] = [
	{ file: "index.lock", reason: "the git index is locked; another git operation may still be running" },
	{ file: "MERGE_HEAD", reason: "a merge is in progress" },
	{ file: "rebase-merge", reason: "a rebase is in progress" },
	{ file: "rebase-apply", reason: "a rebase or patch application is in progress" },
	{ file: "CHERRY_PICK_HEAD", reason: "a cherry-pick is in progress" },
	{ file: "REVERT_HEAD", reason: "a revert is in progress" },
	{ file: "BISECT_LOG", reason: "a bisect is in progress" },
];

export type ExistsFn = (path: string) => boolean;

/**
 * Which markers are present under a .git directory. A probe that throws is
 * also a failure — the stability of the snapshot is simply not knowable,
 * which reads as unstable, never as stable.
 */
export function detectInstability(
	gitDir: string,
	exists: ExistsFn,
): { reasons: string[]; failed: boolean } {
	const reasons: string[] = [];
	let failed = false;
	for (const marker of INSTABILITY_MARKERS) {
		let present: boolean;
		try {
			present = Boolean(exists(`${gitDir}/${marker.file}`));
		} catch {
			failed = true;
			continue;
		}
		if (present) reasons.push(marker.reason);
	}
	return { reasons, failed };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function buildTargetArgs(target: TriageTarget): { range: string[]; show: boolean } | undefined {
	switch (target.kind) {
		case "uncommitted":
			// HEAD-inclusive: covers staged and unstaged tracked changes in one range.
			return { range: ["HEAD"], show: false };
		case "branch":
			return target.base ? { range: [`${target.base}...HEAD`], show: false } : undefined;
		case "commit":
			return target.ref ? { range: [target.ref], show: true } : undefined;
		case "task":
			// Two-dot against the baseline ref, not `...HEAD`: `git diff <ref>`
			// measures the worktree against the ref, so work committed since the
			// baseline AND the dirty worktree are in, while whatever was committed
			// before the task started stays out. A three-dot range would measure
			// from the merge base and drop uncommitted work entirely.
			return target.baselineRef ? { range: [target.baselineRef], show: false } : undefined;
		default:
			return undefined;
	}
}

/** `git diff` for a working tree / branch range, `git show` for a single commit. */
export function buildRangeCommand(target: TriageTarget, formatArgs: string[]): string[] | undefined {
	const args = buildTargetArgs(target);
	if (!args) return undefined;
	return args.show ? ["show", ...formatArgs, "--format=", ...args.range] : ["diff", ...formatArgs, ...args.range];
}

/**
 * Collect the evidence. Git failures degrade to "no evidence" with the reason
 * attached rather than throwing: a `summary` plus `notes` is still a usable
 * state, and a triage tool that dies outside a repository is worse than one
 * that says it could not look.
 */
export async function collectEvidence(exec: GitExec, options: CollectOptions): Promise<ChangeEvidence> {
	const base: ChangeEvidence = {
		target: options.target.kind,
		...(options.target.base ? { base: options.target.base } : {}),
		...(options.target.ref ? { ref: options.target.ref } : {}),
		isGit: false,
		files: [],
		added: 0,
		removed: 0,
		newFiles: [],
		deletedFiles: [],
		indicators: {},
		artifacts: [],
		limitations: [],
		signals: [],
		notes: options.notes ?? [],
		summary: options.summary,
		patchExcerpt: "",
		truncated: false,
		unstable: false,
		...(options.target.baselineRef ? { baseline: options.target.baselineRef } : {}),
	};

	if (options.target.kind === "none") return base;

	const execOptions = { cwd: options.cwd, signal: options.signal };
	// Every command is read-only; the fixed options are prepended so a repo's
	// diff drivers cannot change the evidence.
	const run = (args: string[]) => exec("git", [...GIT_CONFIG_ARGS, ...args], execOptions);

	if (options.target.kind === "task" && !options.target.baselineRef) {
		// Without a baseline the diff would be `git diff HEAD`, which attributes
		// work committed or dirtied before the task started to the task. That
		// is exactly what this scope exists to avoid, so the scope fails
		// explicitly rather than falling back.
		return {
			...base,
			error:
				"the task scope needs a baseline ref (the ref captured or configured before the task started); no diff was taken",
		};
	}

	const rangeCommand = buildRangeCommand(options.target, ["--numstat", "-z", ...DIFF_FLAGS]);
	if (!rangeCommand) {
		return { ...base, error: "missing base branch or commit ref for the requested target" };
	}

	const numstat = await run(rangeCommand);

	// Stability around collection: an index lock, merge, rebase, cherry-pick,
	// revert or bisect in progress means the tree may change while it is being
	// measured, so what the diffs say is provisional. Probed after the numstat
	// read and again after the others; either hit marks the evidence unstable,
	// and policy refuses to skip on unstable evidence. A probe that cannot
	// run is a failure too — stability that cannot be verified is not
	// stability, which is why the probe runs even on the failure paths below,
	// and every later return carries the facts it accumulated.
	const limitations: EvidenceLimitation[] = [];
	const gitDir = await run(["rev-parse", "--absolute-git-dir"]);
	const gitDirPath = gitDir.code === 0 && gitDir.stdout.trim() !== "" ? gitDir.stdout.trim() : undefined;
	const exists = options.fsExists ?? existsSync;
	const stabilityReasons: string[] = [];
	let stabilityFailed = false;
	let probeFailureRecorded = false;
	if (!gitDirPath) {
		stabilityFailed = true;
		limitations.push({
			text: "the .git directory could not be located; snapshot stability could not be verified",
			blocksSkip: false,
		});
	}
	const probeStability = (): void => {
		if (!gitDirPath) return; // recorded above
		const probed = detectInstability(gitDirPath, exists);
		stabilityFailed = stabilityFailed || probed.failed;
		stabilityReasons.push(...probed.reasons);
		if (probed.failed && !probeFailureRecorded) {
			probeFailureRecorded = true;
			limitations.push({
				text: "a snapshot-stability probe failed; the snapshot is treated as unstable",
				blocksSkip: false,
			});
		}
	};
	probeStability();

	// Every return after this point carries the accumulated stability facts:
	// the boolean for the skip gate, the reasons where the state will show them.
	const unstableNow = (): boolean => stabilityReasons.length > 0 || stabilityFailed;
	const recordStability = (): void => {
		for (const reason of [...new Set(stabilityReasons)]) {
			limitations.push({ text: `snapshot unstable: ${reason}`, blocksSkip: false });
		}
	};

	if (numstat.code !== 0) {
		recordStability();
		return {
			...base,
			limitations,
			unstable: unstableNow(),
			error: numstat.stderr.trim() || `git ${rangeCommand.join(" ")} failed`,
		};
	}

	const rawCommand = buildRangeCommand(options.target, ["--raw", "-z", ...DIFF_FLAGS]);
	const patchCommand = buildRangeCommand(options.target, ["--unified=0", ...DIFF_FLAGS]);
	if (!rawCommand || !patchCommand) {
		recordStability();
		return { ...base, limitations, unstable: unstableNow(), error: "missing base branch or commit ref for the requested target" };
	}
	const raw = await run(rawCommand);
	const patch = await run(patchCommand);
	// Unmerged paths show as `U` only in the working-tree diff, not in `diff HEAD`.
	const unmerged = await run(["diff", "--diff-filter=U", "--raw", "-z", ...DIFF_FLAGS]);

	const numEntries = parseNumstatZ(numstat.stdout);
	if (raw.code !== 0) {
		limitations.push({
			text: "the raw diff could not be read; file statuses and structural indicators are incomplete",
			blocksSkip: true,
		});
	}
	const rawEntries = raw.code === 0 ? parseRawZ(raw.stdout) : [];
	if (unmerged.code !== 0) {
		// A failed conflict probe reading as "no conflicts" is exactly the silence
		// that would let an unresolved merge skip review.
		limitations.push({
			text: "the conflict probe failed; unresolved conflicts may be undetected",
			blocksSkip: true,
		});
	}
	const conflictPaths = unmerged.code === 0 ? parseRawZ(unmerged.stdout).map((entry) => entry.path) : [];
	if (patch.code !== 0) {
		limitations.push({ text: "the patch could not be read; Jev sees no diff for this change", blocksSkip: true });
	}

	const binaryByPath = new Map(numEntries.map((entry) => [entry.path, entry.binary]));
	const indicators: Record<string, ArtifactFlags> = {};
	for (const entry of rawEntries) {
		indicators[entry.path] = indicatorsFor(entry, binaryByPath.get(entry.path) ?? false);
	}
	for (const path of conflictPaths) {
		indicators[path] = { ...(indicators[path] ?? {}), conflict: true };
	}

	// Per-file measurements for the dossier manifest. Counts come from numstat,
	// status from raw; both list every changed path, so they are merged rather
	// than one being trusted over the other (a failed `--raw` read must not empty
	// the manifest). A conflicted path is in neither diff, so it is added with
	// its extent unknown rather than dropped.
	const numByPath = new Map(numEntries.map((entry) => [entry.path, entry]));
	const rawByPath = new Map(rawEntries.map((entry) => [entry.path, entry]));
	const artifactPaths = [
		...new Set([...rawEntries.map((entry) => entry.path), ...numEntries.map((entry) => entry.path)]),
	];
	const artifacts: ArtifactMeasurement[] = artifactPaths.map((path) => {
		const num = numByPath.get(path);
		const raw = rawByPath.get(path);
		return {
			path,
			added: num?.added ?? 0,
			removed: num?.removed ?? 0,
			...(raw ? { status: raw.status } : {}),
			binary: num?.binary ?? false,
		};
	});
	for (const path of conflictPaths) {
		if (!artifacts.some((artifact) => artifact.path === path)) {
			artifacts.push({ path, added: 0, removed: 0, status: "U", binary: false });
		}
	}

	const newFiles = rawEntries.filter((entry) => entry.status.startsWith("A")).map((entry) => entry.path);
	const deletedFiles = rawEntries.filter((entry) => entry.status.startsWith("D")).map((entry) => entry.path);

	// The tracked side of the same attribution limit the untracked caveat
	// states: everything committed between the baseline and now is measured,
	// including commits that landed on the branch for other reasons.
	if (options.target.kind === "task" && (numEntries.length > 0 || rawEntries.length > 0)) {
		limitations.push({
			text: "work committed between the baseline and now is attributed to the task, including commits that landed on the branch for other reasons",
			blocksSkip: false,
		});
	}

	let files = [...new Set([...rawEntries.map((entry) => entry.path), ...numEntries.map((entry) => entry.path)])];
	if (options.target.kind === "uncommitted" || options.target.kind === "task") {
		// Untracked files are absent from `git diff HEAD` (and from any diff
		// against a ref); a brand-new file is exactly the case a reviewer
		// should see, so list them explicitly.
		const untracked = await run(["ls-files", "-z", "--others", "--exclude-standard"]);
		if (untracked.code !== 0) {
			limitations.push({
				text: "untracked files could not be listed; a brand-new file may be missing from the evidence",
				blocksSkip: true,
			});
		} else {
			const known = new Set(files);
			const extras = parsePathListZ(untracked.stdout).filter((path) => !known.has(path));
			newFiles.push(...extras);
			files = [...files, ...extras];
			// An untracked path is evidence: list it in the manifest too, with its
			// extent unknown, so Jev sees the file by name rather than only in a
			// count. `missing` plus the limitation below keeps the unknown extent
			// from reading as a zero-line change.
			for (const path of extras) {
				artifacts.push({ path, added: 0, removed: 0, status: "A", binary: false, completeness: "missing" });
			}
			if (extras.length > 0) {
				// A diff excludes untracked content, so a new file's body is
				// invisible to the patch and the risk scan; say so rather than
				// pretend.
				limitations.push({
					text: `${extras.length} untracked file(s) were listed but their content was not read`,
					blocksSkip: true,
				});
			}
			if (options.target.kind === "task" && extras.length > 0) {
				// Unlike tracked dirt, an untracked file cannot be checked
				// against the baseline: one that pre-dates it cannot be told
				// apart from one the task created.
				limitations.push({
					text: "untracked files cannot be attributed to the task's baseline; a file that was already untracked before it may be listed as the task's work",
					blocksSkip: false,
				});
			}
		}
	}

	const added = numEntries.reduce((sum, entry) => sum + entry.added, 0);
	const removed = numEntries.reduce((sum, entry) => sum + entry.removed, 0);
	const patchText = patch.code === 0 ? patch.stdout : "";
	const patchCap = options.patchChars ?? DEFAULT_PATCH_CHARS;
	const truncated = patchText.length > patchCap;
	if (truncated) {
		limitations.push({ text: `the patch excerpt was truncated at ${patchCap} characters`, blocksSkip: true });
	}

	// `git show` suppresses a merge commit's diff by default, so an empty
	// numstat there reads as "nothing changed". Say why instead of letting an
	// empty evidence block become a confident "no review".
	if (options.target.kind === "commit" && rawEntries.length === 0 && patchText.trim() === "") {
		recordStability();
		return {
			...base,
			isGit: true,
			limitations,
			unstable: stabilityReasons.length > 0 || stabilityFailed,
			error:
				"the commit produced no per-file diff (a merge commit shows none by default, and an empty commit has none; use a non-merge commit or a branch target)",
		};
	}

	probeStability();

	const unstableReasons = [...new Set(stabilityReasons)];
	for (const reason of unstableReasons) {
		limitations.push({ text: `snapshot unstable: ${reason}`, blocksSkip: false });
	}

	return {
		...base,
		isGit: true,
		files,
		added,
		removed,
		newFiles: [...new Set(newFiles)],
		deletedFiles,
		indicators,
		artifacts,
		limitations,
		signals: detectSignals(files, patchText, added, removed),
		patchExcerpt: truncated ? patchText.slice(0, patchCap) : patchText,
		truncated,
		unstable: unstableReasons.length > 0 || stabilityFailed,
	};
}

// ---------------------------------------------------------------------------
// Dossier adapter (stopgap)
// ---------------------------------------------------------------------------

/**
 * Split a combined `git diff` into one patch per file, keyed by path. The
 * collector emits a single `--unified=0` patch; the dossier wants a patch per
 * artifact, so this reconstructs them from the file headers. The path comes
 * from the `+++ b/<path>` line, falling back to `--- a/<path>` for a deletion
 * (`+++ /dev/null`), `rename to <path>` for a pure rename, and the
 * `diff --git a/<old> b/<new>` line for a headerless binary or mode-only change.
 * A section with no recoverable path is dropped (and recorded by the caller).
 *
 * Only the pre-hunk head of a section is searched for `---`/`+++`, so an added
 * content line that happens to read `+++ b/x` cannot be mistaken for a header.
 */
export function splitPatchByPath(patch: string): Map<string, string> {
	const result = new Map<string, string>();
	if (!patch) return result;
	const sections = patch.split(/^(?=diff --git )/mu).filter((section) => section.startsWith("diff --git "));
	for (const text of sections) {
		const body = text.slice("diff --git ".length);
		const head = body.split(/^@@ /mu)[0] ?? body;
		const plus = /^\+\+\+ b\/(.*)$/mu.exec(head);
		const minus = /^--- a\/(.*)$/mu.exec(head);
		const rename = /^rename to (.*)$/mu.exec(head);
		const git = /^a\/(.*) b\/(.*)$/mu.exec(head);
		let path: string | undefined;
		if (plus && plus[1] !== "/dev/null") path = plus[1];
		else if (minus && minus[1] !== "/dev/null") path = minus[1];
		else if (rename) path = rename[1];
		else if (git) path = git[2];
		if (path !== undefined) result.set(path, text);
	}
	return result;
}

/**
 * The stopgap adapter from {@link ChangeEvidence} to the dossier's evidence
 * items. The git collector measures per-file counts and one combined patch;
 * this turns that into one artifact-change item per file, splitting the combined
 * patch by its `diff --git` headers so each artifact carries its own patch.
 * Until the collector emits per-file patches directly, the split is
 * reconstructed — the patch is too important to drop and too combined to
 * attribute perfectly, so an unattributable section is recorded as a limitation
 * rather than silently lost.
 *
 * `snapshot` is the identity every item is stamped with. When omitted it is
 * derived from the evidence, but the caller (index.ts) passes the same value it
 * gives the dossier scope so the two cannot default differently.
 */
export function toEvidenceItems(evidence: ChangeEvidence, snapshot?: string): EvidenceItem[] {
	const items: EvidenceItem[] = [];
	const identity = snapshot ?? evidence.baseline ?? evidence.ref ?? evidence.base ?? "unknown";
	const provenance = "git diff --numstat -z / --raw -z / --unified=0";
	const patches = splitPatchByPath(evidence.patchExcerpt);

	for (const artifact of evidence.artifacts) {
		const flags = evidence.indicators[artifact.path];
		const patch = patches.get(artifact.path);
		items.push({
			source: "git",
			kind: "artifact-change",
			provenance,
			snapshot: identity,
			completeness: artifact.completeness ?? "complete",
			trust: "observed",
			path: artifact.path,
			added: artifact.added,
			removed: artifact.removed,
			...(artifact.status ? { status: artifact.status } : {}),
			...(patch ? { patch } : {}),
			...(flags ? { flags } : {}),
		});
	}

	for (const signal of evidence.signals) {
		items.push({
			source: "git",
			kind: "risk-signal",
			provenance,
			snapshot: identity,
			completeness: "complete",
			trust: "observed",
			signal,
		});
	}

	for (const limitation of evidence.limitations) {
		items.push({
			source: "git",
			kind: "limitation",
			provenance,
			snapshot: identity,
			completeness: "partial",
			trust: "observed",
			text: limitation.text,
		});
	}

	// The collector emits one combined patch; the split above reconstructs
	// per-file patches from it. A section whose path could not be recovered (git
	// quotes control characters in a header) is not attributed, so record it
	// rather than let a missing patch read as a file that did not change. The
	// note disappears on its own once the collector emits per-file patches.
	const sections = evidence.patchExcerpt.match(/^diff --git /gmu)?.length ?? 0;
	if (sections > 0 && patches.size < sections) {
		items.push({
			source: "git",
			kind: "limitation",
			provenance,
			snapshot: identity,
			completeness: "partial",
			trust: "observed",
			text: `per-file patches were reconstructed from one combined diff; ${sections - patches.size} patch section(s) could not be attributed to a path`,
		});
	}
	// A truncated excerpt drops the sections past the cap, so a manifest entry
	// can sit there with counts but no patch. Say so rather than let it read as
	// a file with no patch.
	if (evidence.truncated) {
		items.push({
			source: "git",
			kind: "limitation",
			provenance,
			snapshot: identity,
			completeness: "partial",
			trust: "observed",
			text: "the combined patch excerpt was truncated, so later files may carry no per-file patch",
		});
	}

	if (evidence.error) {
		items.push({
			source: "git",
			kind: "limitation",
			provenance,
			snapshot: identity,
			completeness: "missing",
			trust: "observed",
			text: evidence.error,
		});
	}

	return items;
}
