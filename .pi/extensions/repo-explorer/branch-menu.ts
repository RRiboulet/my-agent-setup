// repo-explorer/branch-menu.ts — step one of the /explore flow: which branch
// to browse.
//
// The menu itself is one ctx.ui.select() over a row per candidate, which is
// what the commissioning todo asked for: a searchable menu only earns its
// complexity once the branch list gets long. It is worth knowing what that
// costs — pi's built-in extension selector renders every row without
// scrolling, so a repository with hundreds of branches will outgrow it, and
// when it does this becomes a ctx.ui.custom() SelectList (the component the
// file-browser todo builds is the pattern to follow).
//
// Ordering and labelling are decided here rather than at the call site so they
// can be tested without a terminal:
//  - the detached-HEAD tip comes first when HEAD is detached — browsing where
//    HEAD actually is beats an alphabetical list — then locals in refname
//    order (git.ts's order), then remote-tracking refs;
//  - the current branch is marked, and every label maps back to exactly one
//    refname. That uniqueness is not cosmetic: `update-ref` allows a local
//    branch literally named "origin/main", whose display name collides with
//    the remote-tracking ref, and picking the wrong one silently browses the
//    wrong tree. The entry the flow carries is therefore always the refname.

import { basename } from "node:path";
import type { BranchList, RepoGit } from "./git.ts";
import { sanitizeDisplay } from "./sanitize.ts";

/** The branch the user picked: the argument listFiles/readFile take, plus the label their title reuses. */
export interface BranchChoice {
	/** Full refname ("refs/remotes/origin/main"), or the detached-HEAD tip sha. */
	refname: string;
	/** The row the user picked, already collision-disambiguated. Labelling is kind-aware; the row's remote-ness is not needed downstream, and derivable from the refname when it is. */
	label: string;
}

/**
 * What the flow remembers between steps: the last branch picked. Deliberately
 * not persisted to the session log — it is a convenience for the next screen,
 * not state a reload has to reconstruct (the plumbing re-derives everything
 * from the repository).
 */
export interface ExploreBranchState {
	refname?: string;
	label?: string;
}

export interface BranchMenu {
	/** Rows in display order; one per candidate, labels unique. The labels passed to ctx.ui.select are `entries.map((entry) => entry.label)`. */
	entries: BranchChoice[];
	/** What the flow falls back to when no menu is shown: HEAD's branch, else the detached tip. Absent when neither resolves. */
	defaultRef?: string;
}

/** The slice of ctx.ui the menu needs, so tests drive it without a terminal. */
export interface BranchMenuUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface Row {
	refname: string;
	/** Label before collision-disambiguation; already carries the `(current)` marker. */
	base: string;
	isRemote: boolean;
	/** True for the synthesized detached-HEAD row (not a ref in refs/heads). */
	detached: boolean;
}

/** Suffix that tells two colliding rows apart in the list. */
const kindTag = (row: Row): "local" | "remote" | "detached" =>
	row.detached ? "detached" : row.isRemote ? "remote" : "local";

const shortSha = (sha: string): string => sha.slice(0, 7);

function buildRows(list: BranchList): Row[] {
	const rows: Row[] = [];
	// Detached first: there is no current branch to mark, and this tip is what
	// `listFiles` and `readFile` accept directly.
	if (list.detachedTip) {
		rows.push({
			refname: list.detachedTip,
			base: `HEAD (detached at ${shortSha(list.detachedTip)})`,
			isRemote: false,
			detached: true,
		});
	}
	for (const branch of list.branches) {
		rows.push({
			refname: branch.refname,
			base: branch.isCurrent ? `${branch.name} (current)` : branch.name,
			isRemote: branch.isRemote,
			detached: false,
		});
	}
	return rows;
}

/**
 * Disambiguate labels so each maps back to exactly one row.
 *
 * Two passes: first qualify every row of a colliding set by kind (a local
 * branch named like a remote-tracking ref becomes "<name> [local]" while the
 * tracking ref becomes "<name> [remote]" — both, not just the second, so the
 * list reads honestly). A second sweep is the pathological case: a branch
 * *named* like an already-qualified label. Refnames are unique by definition,
 * so qualifying with one always settles it.
 */
function qualifyLabels(rows: Row[]): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) counts.set(row.base, (counts.get(row.base) ?? 0) + 1);
	let labels = rows.map((row) => (counts.get(row.base)! > 1 ? `${row.base} [${kindTag(row)}]` : row.base));

	const overflow = new Map<string, number>();
	for (const label of labels) overflow.set(label, (overflow.get(label) ?? 0) + 1);
	labels = labels.map((label, index) => (overflow.get(label)! > 1 ? `${label} [${rows[index].refname}]` : label));
	return labels;
}

/** Build the menu rows for a branch listing, in the order the flow wants them. */
export function buildBranchMenu(list: BranchList): BranchMenu {
	const rows = buildRows(list);
	const labels = qualifyLabels(rows);
	const entries: BranchChoice[] = rows.map((row, index) => ({ refname: row.refname, label: labels[index] }));
	// The refname, not list.current's short name: a local branch literally
	// named "origin/main" has current="origin/main", and the short name would
	// resolve to the remote-tracking ref instead.
	const current = list.branches.find((branch) => branch.isCurrent);
	return {
		entries,
		defaultRef: current?.refname ?? list.detachedTip,
	};
}

/** Map a ctx.ui.select result back to its row. Undefined (cancelled) and an unrecognized label both yield undefined. */
export function resolveBranchChoice(menu: BranchMenu, choice: string | undefined): BranchChoice | undefined {
	if (choice === undefined) return undefined;
	// The options are sanitized for display (see chooseBranch), so the answer is
	// matched in the same form. For valid UTF-8 this is injective — C0/DEL, `\`,
	// `^` and space are forbidden in a refname, so the caret/`\uXXXX` notations
	// cannot be spelled literally. Refnames with invalid UTF-8 can still collapse
	// at listBranches' decode (pre-existing), leaving two indistinguishable rows;
	// that is not a wrong-tree read, because tipOf then refuses both.
	return menu.entries.find((entry) => sanitizeDisplay(entry.label) === choice);
}

/** Record the pick so later steps reuse it, and hand it back. */
function remember(state: ExploreBranchState, choice: BranchChoice): BranchChoice {
	state.refname = choice.refname;
	state.label = choice.label;
	return choice;
}

/**
 * Ask which branch to browse and remember the answer.
 *
 * Returns undefined when the user cancelled, when there is nothing to browse,
 * or when git refused to list branches — the last of those as a thrown
 * RepoGitError, which the command handler turns into one notify. Only what
 * belongs to the menu itself is notified here (an empty listing, a cancelled
 * choice); the failure message stays the handler's, because that is where the
 * error kinds are known. A single candidate is not a choice and skips the
 * menu: a fresh repository, or a detached HEAD with no local branches, should
 * not make the user confirm the obvious.
 */
export async function chooseBranch(git: RepoGit, ui: BranchMenuUI, state: ExploreBranchState): Promise<BranchChoice | undefined> {
	const menu = buildBranchMenu(await git.listBranches());
	// The repository name comes from the filesystem and the labels from refnames;
	// either can carry control or bidi bytes, so they cross the display boundary
	// here, where they become pixels. The raw labels stay in `menu`, and
	// resolveBranchChoice matches in the same sanitized form.
	const repoName = sanitizeDisplay(basename(git.root) || git.root);
	if (menu.entries.length === 0) {
		ui.notify(`repo-explorer: no branches to browse in ${repoName}`, "warning");
		return undefined;
	}
	if (menu.entries.length === 1) return remember(state, menu.entries[0]);

	const choice = await ui.select(`Explore ${repoName} — pick a branch`, menu.entries.map((entry) => sanitizeDisplay(entry.label)));
	const picked = resolveBranchChoice(menu, choice);
	if (!picked) {
		ui.notify("repo-explorer: no branch selected", "info");
		return undefined;
	}
	return remember(state, picked);
}
