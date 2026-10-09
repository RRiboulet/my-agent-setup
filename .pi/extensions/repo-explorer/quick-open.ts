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
// missing one, `not-a-file` for a gitlink the browser cannot enter). That split
// is why the browser can stay a small navigator (see file-browser.ts's header):
// deep files never need it.
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
// repository. The one git call the handler adds on top is `listBranches`, for
// the explicit-branch match; a tag or sha that matches no listed branch falls
// through to `tipOf` in git.ts, which is what raises `unknown-branch`.

import { buildBranchMenu, type BranchChoice, type ExploreBranchState } from "./branch-menu.ts";
import type { BranchList } from "./git.ts";

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
	let path = raw;
	while (path.startsWith("./")) path = path.slice(2);
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	return path === "." ? "" : path;
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
			const branch = token.slice(0, colon);
			const path = normalizeRepoPath(token.slice(colon + 1));
			if (path.startsWith("/")) return { error: `absolute paths are not supported: "${path}"` };
			return { path, branch };
		}
		const path = normalizeRepoPath(token);
		if (path.startsWith("/")) return { error: `absolute paths are not supported: "${path}"` };
		return { path };
	}

	const path = normalizeRepoPath(tokens[0]);
	if (path.startsWith("/")) return { error: `absolute paths are not supported: "${path}"` };
	return { path, branch: tokens[1] };
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
 * that matches nothing is handed back raw: it may be a tag or a sha, and
 * git.ts's `tipOf` is what knows whether that resolves.
 */
export function resolveQuickBranch(
	list: BranchList,
	last: ExploreBranchState,
	explicit?: string,
): { choice?: BranchChoice; error?: string } {
	const menu = buildBranchMenu(list);

	if (explicit) {
		const byRefname = menu.entries.find((entry) => entry.refname === explicit);
		if (byRefname) return { choice: byRefname };

		const byLabel = menu.entries.find((entry) => entry.label === explicit);
		if (byLabel) return { choice: byLabel };

		const byName = list.branches.filter((branch) => branch.name === explicit);
		if (byName.length === 1) {
			const entry = menu.entries.find((candidate) => candidate.refname === byName[0].refname);
			return { choice: entry ?? { refname: byName[0].refname, label: byName[0].name } };
		}
		if (byName.length > 1) {
			const labels = byName.map((branch) => menu.entries.find((candidate) => candidate.refname === branch.refname)?.label ?? branch.refname);
			return { error: `branch "${explicit}" is ambiguous (matches ${labels.join(", ")}) — use the full refname` };
		}
		return { choice: { refname: explicit, label: explicit } };
	}

	if (last.refname) return { choice: { refname: last.refname, label: last.label ?? last.refname } };

	if (!menu.defaultRef) {
		return { error: "no branch to browse — the repository has no commits and no branches" };
	}
	const entry = menu.entries.find((candidate) => candidate.refname === menu.defaultRef);
	return { choice: entry ?? { refname: menu.defaultRef, label: menu.defaultRef } };
}
