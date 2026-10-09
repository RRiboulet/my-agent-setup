// repo-explorer/quick-open.ts — the argument grammar and branch resolution
// behind `/explore <path>`, the fast repeat-use path.
//
// The menu flow answers "which branch, then which file"; quick-open answers
// both in one line, which is the point: on a phone over tmux, re-opening the
// file you were just reading should be one command, not a menu and a browse.
//
// Grammar (all forms share the branch resolution below):
//   /explore <path>            — path on the last-picked branch, else HEAD's
//   /explore <path> <branch>   — path first, branch second
//   /explore <branch>:<path>   — git's own rev spelling, branch first
// A path that names a blob prints directly; a path that names a tree opens the
// fuzzy browser at that directory; a bad path is refused (`not-found` for a
// missing path or a gitlink, `not-a-file` for anything else the browser cannot
// enter). That split is why the browser can stay a small navigator (see
// file-browser.ts's header): deep files never need it.
//
// Two deliberate readings of the todo, both recorded because a refresh should
// not silently reverse them:
//  - `<path> <branch>` keeps the path first, matching the primary
//    `/explore <path>` form; the colon form matches git's `<rev>:<path>`.
//    A path that itself contains a colon survives the two-token form untouched
//    (colon splitting applies only to a single token), so that is the escape
//    hatch for the one ambiguous shape.
//  - a single token is always a path. `/explore main` therefore looks for a
//    file named `main`, not a branch; the explicit spellings are
//    `/explore main:` and `/explore main:.`, and the menu remains the way to
//    browse a branch without naming a path.
//
// Everything here is pure over `args` / a `BranchList` / the remembered state,
// so the grammar and the refname rule are unit-testable without a terminal or a
// repository. The git call the handler adds on top is `listBranches`, both to
// match an explicit branch and to re-validate the remembered pick; a tag or sha
// that matches no listed branch falls through to `tipOf` in git.ts, which is
// what raises `unknown-branch`.

import { buildBranchMenu, type BranchChoice, type ExploreBranchState } from "./branch-menu.ts";
import type { BranchList } from "./git.ts";
import { sanitizeDisplay } from "./sanitize.ts";

/** Everything `/explore` arguments can ask for. `path` is undefined only when no path was given; an empty string is the repository root. */
export interface ExploreArgs {
	/** Repo-relative path, normalized (no leading `./`, no trailing `/`; "" is the root). */
	path?: string;
	/** Explicit branch argument, as typed and unresolved — the handler resolves it to a refname. */
	branch?: string;
	/** Set when the arguments cannot be interpreted; the handler reports it and stops. */
	error?: string;
}

/**
 * Split a command line into tokens, honouring single and double quotes and
 * backslash escapes inside them. The shell normally does this before an
 * argument reaches the handler, but `/explore "my file.ts"` typed into pi's
 * command box arrives whole, so paths with spaces need the same treatment here.
 */
export function tokenizeArgs(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === "\\" && i + 1 < value.length) {
				current += value[i + 1];
				i += 1;
				continue;
			}
			if (char === quote) {
				quote = null;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (current.length > 0) tokens.push(current);
	return tokens;
}

/**
 * Fold the path spellings a person actually types into the one `readFile` and
 * the browser's `initialDir` take: `./`, `//`, a trailing `/` and a bare `.`
 * all become the canonical repo-relative form ("" for the root). The result is
 * still only a candidate — whether it exists is git's answer, not this
 * function's.
 */
export function normalizeRepoPath(raw: string): string {
	// Split and rejoin so empty segments ("a//b") and "." components ("a/./b")
	// fold away together; git rejects "." as a tree path, so a file that exists
	// must not be reported missing because of how it was spelled. ".." segments
	// are left for git to refuse. A leading "/" is preserved so the caller can
	// reject an absolute path rather than silently treating it as relative.
	const segments = raw.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	return raw.startsWith("/") ? `/${segments.join("/")}` : segments.join("/");
}

/** Normalize a path token and reject the one form that cannot be repo-relative. */
function pathArg(raw: string): ExploreArgs {
	const path = normalizeRepoPath(raw);
	if (path.startsWith("/")) return { error: `absolute paths are not supported: "${path}"` };
	return { path };
}

/** Interpret the raw argument string. */
export function parseExploreArgs(args: string | undefined): ExploreArgs {
	const trimmed = args?.trim() ?? "";
	if (trimmed.length === 0) return {};

	const tokens = tokenizeArgs(trimmed);
	if (tokens.length === 0) return {};
	if (tokens.length > 2) {
		return { error: `too many arguments — expected "/explore <path> [branch]" (got ${tokens.length})` };
	}

	if (tokens.length === 1) {
		const token = tokens[0];
		// Only a single token gets colon splitting, so a path with a colon can
		// always be written unambiguously as the first of two tokens.
		const colon = token.indexOf(":");
		if (colon > 0) {
			const path = pathArg(token.slice(colon + 1));
			if (path.error) return path;
			return { path: path.path, branch: token.slice(0, colon) };
		}
		return pathArg(token);
	}

	const path = pathArg(tokens[0]);
	if (path.error) return path;
	return { path: path.path, branch: tokens[1] };
}

/**
 * Resolve the branch quick-open should use: an explicit argument, else the
 * last pick, else HEAD (the same default the menu pre-selects).
 *
 * An explicit argument is matched against the listing by full refname, then by
 * the menu's disambiguated label, then by short name. A short name that matches
 * both a local branch and a remote-tracking ref is refused rather than guessed —
 * that is the `origin/main` collision branch-menu.ts exists to make visible, and
 * picking the wrong side here would silently read the wrong tree. An argument
 * that matches nothing is handed back raw (`listed: false`): it may be a tag or
 * a sha, and git.ts's `tipOf` is what knows whether that resolves.
 *
 * The result flags that ride alongside the choice let the handler act without
 * re-deriving them:
 *  - `listed` is true when the choice is a ref the listing carries (a branch or
 *    the detached tip). The handler remembers the branch only then, so a
 *    one-off tag/sha read does not become the "last branch".
 *  - `fellBack` is true when a remembered ref was not in the fresh listing and
 *    the default was substituted, so the handler can announce the switch.
 */
export function resolveQuickBranch(
	list: BranchList,
	last: ExploreBranchState,
	explicit?: string,
): { choice?: BranchChoice; error?: string; listed?: boolean; fellBack?: boolean } {
	const menu = buildBranchMenu(list);

	if (explicit) {
		const byRefname = menu.entries.find((entry) => entry.refname === explicit);
		if (byRefname) return { choice: byRefname, listed: true };

		// Compared in display form: the menu offers `sanitizeDisplay(entry.label)`,
		// so a user pasting a label the menu showed must match here too.
		const byLabel = menu.entries.find((entry) => sanitizeDisplay(entry.label) === explicit);
		if (byLabel) return { choice: byLabel, listed: true };

		const byName = list.branches.filter((branch) => branch.name === explicit);
		if (byName.length === 1) {
			const entry = menu.entries.find((candidate) => candidate.refname === byName[0].refname);
			return { choice: entry ?? { refname: byName[0].refname, label: byName[0].name }, listed: true };
		}
		if (byName.length > 1) {
			const labels = byName.map((branch) => menu.entries.find((candidate) => candidate.refname === branch.refname)?.label ?? branch.refname);
			return { error: `branch "${explicit}" is ambiguous (matches ${labels.join(", ")}) — use the full refname` };
		}
		return { choice: { refname: explicit, label: explicit }, listed: false };
	}

	let fellBack = false;
	if (last.refname) {
		// Re-check the remembered pick against the fresh listing: a branch deleted
		// since it was picked must fall back to the default rather than become a
		// sticky failure. A listed ref returns its fresh entry, so the label carries
		// the current `(current)` marker and collision qualification rather than a
		// stale copy. A remembered tag/sha is not in the listing (it is never
		// remembered now, but state could be older) and falls back too.
		const remembered = menu.entries.find((candidate) => candidate.refname === last.refname);
		if (remembered) return { choice: remembered, listed: true };
		fellBack = true;
	}

	if (!menu.defaultRef) {
		return { error: "no branch to browse — the repository has no commits and no branches" };
	}
	const entry = menu.entries.find((candidate) => candidate.refname === menu.defaultRef);
	return { choice: entry ?? { refname: menu.defaultRef, label: menu.defaultRef }, listed: true, ...(fellBack ? { fellBack: true } : {}) };
}
