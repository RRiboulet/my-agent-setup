/**
 * Evidence gathering for review triage.
 *
 * This module is deliberately dumb. It measures the change — files, churn,
 * the added/removed lines — and labels whatever risk-shaped things it can see
 * in the paths and the patch. It does not score them and it does not decide
 * anything: the labelled evidence is serialised into Jev's `state`, and Jev
 * makes the judgement. The prose labels are what Jev reads, so they are written
 * for a reader, not for a threshold table.
 *
 * Every parser in here is pure and exported through `__test__` so the git
 * plumbing can be covered without a repository or a child process.
 */

export type TriageTargetKind = "uncommitted" | "branch" | "commit" | "none";

export interface TriageTarget {
	kind: TriageTargetKind;
	/** Branch name for `branch`. */
	base?: string;
	/** Commit sha for `commit`. */
	ref?: string;
}

export interface ChangeEvidence {
	target: TriageTargetKind;
	base?: string;
	ref?: string;
	isGit: boolean;
	/** Paths touched, in git's order, deduplicated. */
	files: string[];
	added: number;
	removed: number;
	newFiles: string[];
	deletedFiles: string[];
	/** Human-readable risk labels; Jev reads these, nothing else scores them. */
	signals: string[];
	/** Risk the caller declared by hand. */
	notes: string[];
	/** The agent's own one-line description of the change. */
	summary: string;
	/** Bounded, zero-context diff text. */
	patchExcerpt: string;
	truncated: boolean;
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
}

const DEFAULT_PATCH_CHARS = 8_000;

function splitLines(text: string): string[] {
	return text.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

/** `git diff --numstat` / `git show --numstat`: added, removed, path. */
export function parseNumstat(stdout: string): { files: string[]; added: number; removed: number } {
	const files: string[] = [];
	let added = 0;
	let removed = 0;
	for (const line of splitLines(stdout)) {
		const [rawAdded, rawRemoved, ...rest] = line.split("\t");
		const path = rest.join("\t").trim();
		if (!path) continue;
		files.push(path);
		// Binary files report "-" for both counts; they still count as changed.
		const a = Number.parseInt(rawAdded, 10);
		const r = Number.parseInt(rawRemoved, 10);
		if (Number.isFinite(a)) added += a;
		if (Number.isFinite(r)) removed += r;
	}
	return { files, added, removed };
}

/** `git diff --name-status` / `git show --name-status`: status letter + path(s). */
export function parseNameStatus(stdout: string): { newFiles: string[]; deletedFiles: string[] } {
	const newFiles: string[] = [];
	const deletedFiles: string[] = [];
	for (const line of splitLines(stdout)) {
		const parts = line.split("\t");
		const status = (parts[0] ?? "").trim().charAt(0);
		// A rename emits "R100\told\tnew"; the destination is the last field.
		const path = (parts[parts.length - 1] ?? "").trim();
		if (!path) continue;
		if (status === "A") newFiles.push(path);
		else if (status === "D") deletedFiles.push(path);
	}
	return { newFiles, deletedFiles };
}

const SECURITY_PATH = /(^|\/)(auth|oauth|token|secret|credential|password|passwd|crypto|cipher|permission|acl|rbac|session|cookie|login|signup|billing|payment)/iu;
const MIGRATION_PATH = /(^|\/)(migrations?|schema|\.sql$)|prisma/iu;
const DEPENDENCY_PATH = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile|pyproject\.toml)/iu;
const INFRA_PATH = /(^|\/)(Dockerfile|\.github|\.gitlab-ci|devcontainer|docker-compose|Makefile|\.circleci)/iu;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/iu;

/** Added/removed patch lines only, so a signal is about the change, not the file. */
function changedLines(patch: string): string[] {
	return patch.split(/\r?\n/u).filter((line) => line.startsWith("+") || line.startsWith("-"));
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

function buildTargetArgs(target: TriageTarget): { range: string[]; show: boolean } | undefined {
	switch (target.kind) {
		case "uncommitted":
			// HEAD-inclusive: covers staged and unstaged tracked changes in one range.
			return { range: ["HEAD"], show: false };
		case "branch":
			return target.base ? { range: [`${target.base}...HEAD`], show: false } : undefined;
		case "commit":
			return target.ref ? { range: [target.ref], show: true } : undefined;
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
		signals: [],
		notes: options.notes ?? [],
		summary: options.summary,
		patchExcerpt: "",
		truncated: false,
	};

	if (options.target.kind === "none") return base;

	const execOptions = { cwd: options.cwd, signal: options.signal };
	const rangeCommand = buildRangeCommand(options.target, ["--numstat"]);
	if (!rangeCommand) {
		return { ...base, error: "missing base branch or commit ref for the requested target" };
	}

	const numstat = await exec("git", rangeCommand, execOptions);
	if (numstat.code !== 0) {
		return { ...base, error: numstat.stderr.trim() || `git ${rangeCommand.join(" ")} failed` };
	}

	const nameStatus = await exec("git", buildRangeCommand(options.target, ["--name-status"]) ?? [], execOptions);
	const patch = await exec(
		"git",
		buildRangeCommand(options.target, ["--unified=0"]) ?? [],
		execOptions,
	);

	const parsed = parseNumstat(numstat.stdout);
	const status = nameStatus.code === 0 ? parseNameStatus(nameStatus.stdout) : { newFiles: [], deletedFiles: [] };

	let files = parsed.files;
	let newFiles = [...status.newFiles];
	if (options.target.kind === "uncommitted") {
		// Untracked files are absent from `git diff HEAD`; a brand-new file is
		// exactly the case a reviewer should see, so list them explicitly.
		const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"], execOptions);
		if (untracked.code === 0) {
			const extras = splitLines(untracked.stdout);
			const known = new Set(files);
			newFiles = [...new Set([...newFiles, ...extras.filter((path) => !known.has(path))])];
			files = [...files, ...extras.filter((path) => !known.has(path))];
		}
	}

	const patchText = patch.code === 0 ? patch.stdout : "";
	const patchCap = options.patchChars ?? DEFAULT_PATCH_CHARS;
	const truncated = patchText.length > patchCap;

	return {
		...base,
		isGit: true,
		files,
		added: parsed.added,
		removed: parsed.removed,
		newFiles,
		deletedFiles: status.deletedFiles,
		signals: detectSignals(files, patchText, parsed.added, parsed.removed),
		patchExcerpt: truncated ? patchText.slice(0, patchCap) : patchText,
		truncated,
	};
}
