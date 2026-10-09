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
//    "<remote>/<name>"; every entry carries its full refname (a local branch
//    literally named like a remote ref is possible — update-ref allows it);
//    the branch HEAD points at is flagged isCurrent, and a detached HEAD
//    comes back as detachedTip instead.
//  - listFiles(branch) caches the tree per branch name and keys the cache on
//    the branch tip: an unchanged tip reuses it, a new commit refetches. A
//    listing that arrives mojibake-corrupted is refused whole rather than
//    served with filenames that can never be re-opened.
//  - readFile(branch, path) never puts binary, mojibake or oversized pages
//    into text: a NUL byte inside the first BINARY_SNIFF_BYTES refuses the
//    read (git's own binary heuristic), U+FFFD refuses it too (a multi-byte
//    UTF-8 sequence was split while the executor accumulated stdout — wire
//    pi.exec through a Buffer-accumulating runner, not per-chunk
//    toString()), a blob above MAX_BLOB_BYTES is refused before it is
//    fetched, text is clipped at LINE_CAP lines and MAX_TEXT_BYTES bytes,
//    and every cut leaves text an exact byte prefix of the blob. The `note`
//    field carries the banner phrasing of whichever cut engaged.
//  - Symlink gitlinks list and read as the symlink's target path in TEXT
//    (the entry is stored as a blob of the literal path), and submodule
//    gitlinks refuse as not-found — their commit lives in the submodule's
//    own object store.

export type GitErrorKind =
	| "not-a-repo"
	| "unknown-branch"
	| "not-found"
	| "not-a-file"
	| "binary"
	| "mojibake"
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

/** Result shape is pi's `ExecResult`; index.ts supplies the runner itself as the one-liner `(args, cwd) => pi.exec("git", args, { cwd })`. */
export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export interface GitBranch {
	/** Full refname ("refs/remotes/origin/main") — the only unambiguous handle when a local branch is literally named like a remote-tracking one (update-ref allows "refs/heads/origin/main"); pass this to listFiles/readFile. */
	refname: string;
	/** Display name: short name for locals ("main"), "<remote>/<name>" for remote-tracking refs ("origin/main"). Collides with refname="refs/heads/origin/main"; refname disambiguates. */
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
	/** Blob content, at most LINE_CAP lines and MAX_TEXT_BYTES bytes (text only — see the header), always an exact prefix of the blob. */
	text: string;
	totalLines: number;
	shownLines: number;
	/** True when either clip (lines or bytes) engaged. */
	truncated: boolean;
	/** Banner-ready phrasing of the truncation, set when truncated. */
	note?: string;
	/** Full blob size in bytes, from `cat-file -s` — NOT reduced by the line/byte clip (the clip shows a prefix of these bytes). */
	sizeBytes: number;
}

/** Lines of a file the transcript is ever shown. (Model-facing cap, per the design notes.) */
export const LINE_CAP = 2000;
/** First-byte window scanned for a NUL, git's own binary heuristic. */
export const BINARY_SNIFF_BYTES = 8000;
/** Blobs above this are refused without fetching; pi.exec buffers whole stdout, so refuse before the pipe. */
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
/** Bytes a page may occupy on top of the LINE_CAP line count — huge single lines (minified JS, base64 dumps) slip past the line cap otherwise. Cuts at the last complete line inside the budget; a first line beyond it refuses the read. */
export const MAX_TEXT_BYTES = 256 * 1024;

export interface RepoGit {
	/** Absolute repository root every call runs from. */
	root: string;
	listBranches(): Promise<BranchList>;
	listFiles(branch: string): Promise<string[]>;
	readFile(branch: string, path: string): Promise<FileRead>;
}

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const fmt = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export async function openGit(run: GitRunner, cwd: string): Promise<RepoGit> {
	const rootRes = await run(["rev-parse", "--show-toplevel"], cwd);
	const root = rootRes.stdout.trim();
	if (rootRes.code !== 0 || !root) {
		// "work-tree", not "repository": a bare repository lands here too and
		// is genuinely a repository — it just has nothing to browse. git's own
		// stderr (appended) tells the two cases apart.
		throw new RepoGitError(
			"not-a-repo",
			`Not a git work-tree (cwd: ${cwd || "(empty)"})${firstLine(rootRes.stderr) ? ` — ${firstLine(rootRes.stderr)}` : ""}`,
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
			const [fullRefname, head, symref] = line.split("\t");
			// A symref (refs/remotes/origin/HEAD) is a pointer to another ref
			// that is listed in its own right; keeping it would duplicate
			// "origin/main" in the menu.
			if (symref) continue;
			const isRemote = fullRefname.startsWith("refs/remotes/");
			const name = isRemote
				? fullRefname.slice("refs/remotes/".length)
				: fullRefname.slice("refs/heads/".length);
			branches.push({ refname: fullRefname, name, isRemote, isCurrent: head.trim() === "*" });
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
		// The listing shares readFile's mojibake hazard, and one UTF-8 filename
		// split at an executor chunk boundary becomes a name that can never be
		// re-opened. A corrupted listing is refused whole rather than served
		// quietly with broken entries.
		if (res.stdout.includes("\uFFFD")) {
			throw new RepoGitError(
				"mojibake",
				`git ls-tree output for "${branch}" arrived corrupted (U+FFFD present) — the executor decoded it chunk-wise; refusing to serve broken filenames`,
			);
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
		if (sizeRes.code !== 0) {
			throw new RepoGitError("git-failed", `git cat-file -s failed for "${ref}" — ${firstLine(sizeRes.stderr)}`);
		}
		// No `|| 0` fallback: a failed size read must fail the read, not pass
		// the cap check as 0 bytes and surface later as an opaque show error.
		const sizeBytes = Number.parseInt(sizeRes.stdout.trim(), 10);
		if (!Number.isInteger(sizeBytes)) {
			throw new RepoGitError("git-failed", `git cat-file -s returned no size for "${ref}"`);
		}
		if (sizeBytes > MAX_BLOB_BYTES) {
			throw new RepoGitError(
				"too-large",
				`"${branch}:${path}" is too large to display: ${sizeBytes.toLocaleString("en-US")} bytes exceeds the ${MAX_BLOB_BYTES.toLocaleString("en-US")}-byte cap`,
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
		// U+FFFD in git's own output means a multi-byte UTF-8 sequence was
		// split while the executor accumulated stdout (pi.exec decodes chunk
		// by chunk); the blob on disk is intact, what reached us is not, and
		// what prints would look like the file's real content. Refuse rather
		// than serve mojibake. A file that legitimately contains U+FFFD is
		// refused too — ambiguous either way — and the durable fix is wiring
		// the runner through Buffer accumulation (see index.ts's TODO).
		if (contentRes.stdout.includes("\uFFFD")) {
			throw new RepoGitError(
				"mojibake",
				`"${branch}:${path}" arrived corrupted (U+FFFD present) — the executor decoded it chunk-wise; refusing to display mojibake`,
			);
		}

		// Split on "\n"; a trailing "" after the file's terminator is not a
		// line, interior ""s are real blank lines. `text` is always an exact
		// byte prefix of the blob — both cuts below preserve that, and the
		// banner text rides in `note`, never inside `text`.
		const lines = contentRes.stdout.length > 0 ? contentRes.stdout.split("\n") : [];
		let terminator = false;
		if (contentRes.stdout.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
			terminator = true;
		}

		// Cut 1 — lines: the model-facing line count.
		const lineTruncated = lines.length > LINE_CAP;
		let selected = lineTruncated ? lines.slice(0, LINE_CAP) : lines;

		// Cut 2 — bytes: huge single lines (minified JS, base64 dumps) slip
		// past the line cap, so the page also obeys MAX_TEXT_BYTES. Cut at the
		// last complete line inside the budget; if not even the first line
		// fits, refuse — a fragment of an unknown-language monster line is
		// worse than knowing how big it is.
		let byteTruncated = false;
		if (sizeBytes > MAX_TEXT_BYTES) {
			let acc = 0;
			let fit = -1;
			for (let i = 0; i < selected.length; i++) {
				// The +1 reserves the "\n" that closes the cut: a following
				// line, or the blob's own terminator, carries it.
				acc += Buffer.byteLength(selected[i], "utf8") + (i > 0 ? 1 : 0);
				if (acc + 1 > MAX_TEXT_BYTES) {
					byteTruncated = true;
					break;
				}
				fit = i;
			}
			if (fit < 0) {
				throw new RepoGitError(
					"too-large",
					`"${branch}:${path}" — its first line alone is ${fmt(Buffer.byteLength(selected[0] ?? "", "utf8"))}, beyond the ${fmt(MAX_TEXT_BYTES)} page cap`,
				);
			}
			selected = selected.slice(0, fit + 1);
		}

		// A line-bounded cut is followed by a "\n" that exists in the blob (a
		// later line or the terminator carries it), so the prefix property
		// holds; the untouched page likewise keeps its own terminator.
		const pageCut = selected.length < lines.length;
		let text = selected.join("\n");
		if (pageCut || (!pageCut && terminator)) text += "\n";

		return {
			text,
			totalLines: lines.length,
			shownLines: selected.length,
			truncated: pageCut || byteTruncated,
			note: byteTruncated
				? `truncated at ${fmt(MAX_TEXT_BYTES)}: showing ${selected.length} of ${lines.length} lines`
				: pageCut
					? `truncated: showing the first ${LINE_CAP} of ${lines.length} lines`
					: undefined,
			sizeBytes,
		};
	}

	return { root, listBranches, listFiles, readFile };
}
