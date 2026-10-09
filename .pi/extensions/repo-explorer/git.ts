// repo-explorer/git.ts — read-only git plumbing behind the /explore flow.
//
// No UI here on purpose: this is the only layer that shells out to git, and
// the executor arrives as a parameter — repo-explorer's index.ts wires
// `pi.exec`, the unit tests wire a real `git` binary against a temporary
// repository (subagent/test/repo-explorer-git.test.ts, the repo's test home).
// Everything is read-only — no checkout, no mutation — and everything resolves
// against the repository root found from the session cwd at openGit() time.
//
// Contracts the rest of the flow relies on, all of them pinned by tests:
//  - listBranches() lists ref/heads first, then remote-tracking refs as
//    "<remote>/<name>"; the branch HEAD points at is flagged isCurrent, and a
//    detached HEAD comes back as detachedTip instead.
//  - listFiles(branch) caches the tree per branch name and keys the cache on
//    the branch tip: an unchanged tip reuses it, a new commit refetches.
//  - readFile(branch, path) never puts binary or oversized pages into text:
//    a NUL byte inside the first BINARY_SNIFF_BYTES refuses the read, a blob
//    above MAX_BLOB_BYTES is refused before it is fetched, and text is
//    clipped at LINE_CAP with a `note` meant for the print banner.

export type GitErrorKind =
	| "not-a-repo"
	| "unknown-branch"
	| "not-found"
	| "not-a-file"
	| "binary"
	| "too-large"
	| "git-failed";

/** Thrown by every helper; `kind` lets the UI react (menus, quick-open hints) without matching on message text. */
export class RepoGitError extends Error {
	readonly kind: GitErrorKind;
	constructor(kind: GitErrorKind, message: string) {
		super(message);
		this.name = "RepoGitError";
		this.kind = kind;
	}
}

/** Same shape as pi's `exec` result, so `pi.exec("git", args, { cwd })` fits GitRunner directly. */
export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export interface GitBranch {
	/** Local branches by short name ("main"), remote-tracking refs as "<remote>/<name>" ("origin/main"). */
	name: string;
	isRemote: boolean;
	/** True for the branch HEAD points at (local branches only). */
	isCurrent: boolean;
}

export interface BranchList {
	branches: GitBranch[];
	/** Name of the branch HEAD points at; absent when detached or unresolved. */
	current?: string;
	/** Tip sha when HEAD is detached; the branch arg for listFiles too. */
	detachedTip?: string;
}

export interface FileRead {
	/** Blob content, at most LINE_CAP lines (text only — see the header), always an exact prefix of the blob. */
	text: string;
	totalLines: number;
	shownLines: number;
	truncated: boolean;
	/** Banner-ready phrasing of the truncation, set when truncated. */
	note?: string;
	/** Full blob size in bytes, from `cat-file -s` — content-visible size after clipping. */
	sizeBytes: number;
}

/** Lines of a file the transcript is ever shown. (Model-facing cap, per the design notes.) */
export const LINE_CAP = 2000;
/** First-byte window scanned for a NUL, git's own binary heuristic. */
export const BINARY_SNIFF_BYTES = 8000;
/** Blobs above this are refused without fetching; pi.exec buffers whole stdout, so refuse before the pipe. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;

export interface RepoGit {
	/** Absolute repository root every call runs from. */
	root: string;
	listBranches(): Promise<BranchList>;
	listFiles(branch: string): Promise<string[]>;
	readFile(branch: string, path: string): Promise<FileRead>;
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

export async function openGit(run: GitRunner, cwd: string): Promise<RepoGit> {
	const rootRes = await run(["rev-parse", "--show-toplevel"], cwd);
	const root = rootRes.stdout.trim();
	if (rootRes.code !== 0 || !root) {
		throw new RepoGitError(
			"not-a-repo",
			`Not a git repository (cwd: ${cwd || "(empty)"})${firstLine(rootRes.stderr) ? ` — ${firstLine(rootRes.stderr)}` : ""}`,
		);
	}

	// listFiles cache: branch name → the tip it was listed at. Revalidated
	// on every call against the live tip, so a branch that moved since the
	// last browse refetches while an unmoved one reuses the tree.
	const cache = new Map<string, { tip: string; files: string[] }>();

	// Resolve a branch-ish name to a commit sha. `^{commit}` keeps tags and
	// HEAD-like expressions browsable; `--end-of-options` keeps a ref name
	// that starts with a dash from being read as an option.
	async function tipOf(branch: string): Promise<string> {
		const res = await run(["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`], root);
		if (res.code !== 0) {
			throw new RepoGitError(
				"unknown-branch",
				`Unknown branch "${branch}"${firstLine(res.stderr) ? ` — ${firstLine(res.stderr)}` : ""}`,
			);
		}
		return res.stdout.trim();
	}

	async function listBranches(): Promise<BranchList> {
		const res = await run(["for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname)\t%(HEAD)\t%(symref)"], root);
		if (res.code !== 0) {
			throw new RepoGitError("git-failed", `git for-each-ref failed — ${firstLine(res.stderr)}`);
		}

		// for-each-ref orders by refname, so locals land before remotes — the
		// order the branch menu wants. Tab cannot appear inside a refname, so
		// the format is unambiguous; %(HEAD) marks the checked-out branch.
		const branches: GitBranch[] = [];
		for (const line of res.stdout.split("\n")) {
			if (line.length === 0) continue;
			const [refname, head, symref] = line.split("\t");
			// A symref (refs/remotes/origin/HEAD) is a pointer to another ref
			// that is listed in its own right; keeping it would duplicate
			// "origin/main" in the menu.
			if (symref) continue;
			const isRemote = refname.startsWith("refs/remotes/");
			const name = isRemote ? refname.slice("refs/remotes/".length) : refname.slice("refs/heads/".length);
			branches.push({ name, isRemote, isCurrent: head.trim() === "*" });
		}

		const list: BranchList = { branches };
		const headRes = await run(["rev-parse", "--abbrev-ref", "HEAD"], root);
		if (headRes.code !== 0) return list;
		const ref = headRes.stdout.trim();
		if (ref === "HEAD") {
			// Detached: no branch to flag; hand the flow the fixed tip instead,
			// which listFiles and readFile accept as a branch argument.
			const tipRes = await run(["rev-parse", "HEAD"], root);
			if (tipRes.code === 0) list.detachedTip = tipRes.stdout.trim();
		} else {
			list.current = ref;
		}
		return list;
	}

	async function listFiles(branch: string): Promise<string[]> {
		const tip = await tipOf(branch);
		const cached = cache.get(branch);
		if (cached && cached.tip === tip) return cached.files.slice();

		// -z: NUL-terminated records, so filenames with quotes, UTF-8 bytes or
		// special characters come through unquoted; splitting on "\0" keeps
		// every path intact. Resolving the tree by tip rather than branch name
		// snapshots one commit even if the branch moves mid-listing.
		const res = await run(["ls-tree", "-r", "--name-only", "--full-tree", "-z", tip], root);
		if (res.code !== 0) {
			throw new RepoGitError("git-failed", `git ls-tree failed for "${branch}" — ${firstLine(res.stderr)}`);
		}
		const files = res.stdout.split("\0").filter((p) => p.length > 0);
		cache.set(branch, { tip, files });
		return files.slice();
	}

	async function readFile(branch: string, path: string): Promise<FileRead> {
		const tip = await tipOf(branch);
		const ref = `${tip}:${path}`;

		const typeRes = await run(["cat-file", "-t", ref], root);
		if (typeRes.code !== 0) {
			throw new RepoGitError(
				"not-found",
				`Not found in "${branch}": ${path}${firstLine(typeRes.stderr) ? ` — ${firstLine(typeRes.stderr)}` : ""}`,
			);
		}
		// A tree (directory) would make `git show` print a tree listing rather
		// than file content; refuse anything that is not a blob.
		const type = typeRes.stdout.trim();
		if (type !== "blob") {
			throw new RepoGitError("not-a-file", `"${branch}:${path}" is not a file (it is a ${type})`);
		}

		const sizeRes = await run(["cat-file", "-s", ref], root);
		const sizeBytes = Number.parseInt(sizeRes.stdout.trim(), 10) || 0;
		if (sizeBytes > MAX_BLOB_BYTES) {
			throw new RepoGitError(
				"too-large",
				`"${branch}:${path}" is too large to display: ${mb(sizeBytes)} exceeds the ${mb(MAX_BLOB_BYTES)} cap`,
			);
		}

		const contentRes = await run(["show", ref], root);
		if (contentRes.code !== 0) {
			throw new RepoGitError("git-failed", `git show failed for "${branch}:${path}" — ${firstLine(contentRes.stderr)}`);
		}

		// A NUL byte inside the first window is how git itself calls content
		// binary; refusing beats printing escape soup into the transcript.
		if (contentRes.stdout.slice(0, BINARY_SNIFF_BYTES).includes("\0")) {
			throw new RepoGitError("binary", `"${branch}:${path}" is binary and cannot be displayed`);
		}

		// Split on "\n"; a trailing "" after the file's terminator is not a line,
		// interior ""s are real blank lines. `text` is always an exact prefix of
		// the blob: uncut it is the file back verbatim (terminator included),
		// cut it is the first LINE_CAP lines with the terminator restored. The
		// banner text rides in `note`, never inside `text`.
		const lines = contentRes.stdout.length > 0 ? contentRes.stdout.split("\n") : [];
		let terminator = false;
		if (contentRes.stdout.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
			terminator = true;
		}

		const truncated = lines.length > LINE_CAP;
		let text = truncated ? lines.slice(0, LINE_CAP).join("\n") : lines.join("\n");
		if (terminator && (truncated || lines.length > 0)) text += "\n";

		return {
			text,
			totalLines: lines.length,
			shownLines: truncated ? LINE_CAP : lines.length,
			truncated,
			note: truncated ? `truncated: showing the first ${LINE_CAP} of ${lines.length} lines` : undefined,
			sizeBytes,
		};
	}

	return { root, listBranches, listFiles, readFile };
}
