// repo-explorer/file-browser.ts — the /explore file browser.
//
// A directory-by-directory browser over one branch's tree, run through
// `ctx.ui.custom()`. It is deliberately a *navigator* with a dir-scoped fuzzy
// filter, not a repository-wide fuzzy finder: type to narrow the current
// directory, Enter to open a folder or finish on a file, ←/⌫ to walk up, Esc to
// back out. Jumping straight to a deep path is the quick-open step's job
// (TODO-bfdd2343), which is what keeps this component small.
//
// Two layers, for the same reason the subagent widget has two:
//   - `listDirectory` / `parentPath` are pure functions over the flat path list
//     that git.ts's `listFiles` returns. Directories are synthesized from the
//     path prefixes here, and the ordering rule (folders first, then files, each
//     alphabetical) lives here, so both are unit-testable without a terminal.
//   - `FileBrowser` is the pi component: it composes pi's `SelectList` (which
//     already gives arrow wraparound, scrolling and width-safe rows), `Input`
//     (the filter) and a `Container`, and it owns only the state SelectList
//     cannot: the current directory and what Enter means there.
//
// The interaction rules worth stating, because they are what the keys trade off:
//   - Enter on a folder drills in and clears the filter; Enter on a file calls
//     the completion callback with that file's repo-relative path.
//   - ← and ⌫ walk to the parent directory, but only while the filter is empty.
//     With text in the filter they belong to it — ⌫ deletes a character, ← moves
//     the cursor — or the filter could never be corrected. At the root there is
//     nowhere to walk, so they do nothing; Esc is the cancel, never ⌫.
//   - Esc is the way back from a non-empty filter: it clears the filter first,
//     then walks up, then cancels at the root. Pi maps Ctrl+C to the same
//     action, so both take that path; there is no separate "abort now" key.
//
// Every line the component emits is width-bounded, through pi's own components
// or `truncateToWidth`, never by string length.

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	Spacer,
	type Component,
	type Focusable,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeDisplay } from "./sanitize.ts";
/** One row of a directory listing: a file, or a directory synthesized from path prefixes. */
export interface BrowserEntry {
	/** Basename, as it should be shown (folders get a trailing "/" in the list, not here). */
	name: string;
	/** Repo-relative path — exactly what `readFile` takes. */
	path: string;
	isDir: boolean;
}

export interface FileBrowserOptions {
	/** Breadcrumb stem, normally the picked branch's menu label. */
	branchLabel: string;
	/** Every file path in the branch, from `listFiles`. */
	files: string[];
	/** Directory to open in; "" (the default) is the repository root. */
	initialDir?: string;
}

/** What the browser resolves to: the chosen file, or null when the user backed all the way out. */
export type FileBrowserResult = { path: string } | null;

/** The slice of pi's KeybindingsManager the component uses; a structural type keeps it drivable in tests. */
export interface KeyMatcher {
	matches(data: string, action: string): boolean;
}

/** Rows shown at once before SelectList starts scrolling; the terminal height is not the component's to know. */
const MAX_VISIBLE = 12;

/**
 * Direct children of `dir` in `files`, folders first then files, each alphabetical.
 *
 * A folder exists in the listing only as the prefix of the paths under it, so
 * it is collected by first path segment. The `rest.length === 0` guard is what
 * keeps a file whose path *is* the current directory (not something git can
 * produce for a blob, but cheap to be safe about) out of its own listing.
 */
export function listDirectory(files: string[], dir: string): BrowserEntry[] {
	const prefix = dir.length > 0 ? `${dir}/` : "";
	const directories = new Map<string, BrowserEntry>();
	const entries: BrowserEntry[] = [];
	for (const path of files) {
		if (!path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest.length === 0) continue;
		const slash = rest.indexOf("/");
		if (slash === -1) {
			entries.push({ name: rest, path, isDir: false });
		} else {
			const name = rest.slice(0, slash);
			if (!directories.has(name)) directories.set(name, { name, path: `${prefix}${name}`, isDir: true });
		}
	}
	const byName = (a: BrowserEntry, b: BrowserEntry): number => a.name.localeCompare(b.name);
	return [...directories.values()].sort(byName).concat(entries.sort(byName));
}

/** Parent of a directory path; the root's parent is the root, so callers test `dir !== ""` before going up. */
export function parentPath(dir: string): string {
	const slash = dir.lastIndexOf("/");
	return slash === -1 ? "" : dir.slice(0, slash);
}

/**
 * A single-line, width-exact, themed line that re-reads its text every render.
 *
 * pi's `TruncatedText` is the nearest built-in, but it is immutable and this
 * line changes with the directory and the theme, so the getter form is both
 * shorter and immune to stale colour strings after a theme change (tui.md's
 * "stateless components" guidance).
 *
 * The width arithmetic below is not cosmetic: pi-tui throws (and writes a crash
 * log) when a rendered line is wider than the viewport, so a degenerate resize
 * to 0–2 columns has to yield a short line, not a 3-cell one. The side padding
 * is clamped to the width first and the result truncated again after, which is
 * what keeps the invariant at every width rather than only at ≥3.
 */
function singleLine(get: () => string, paddingX = 1): Component {
	return {
		render: (width: number): string[] => {
			const spacing = " ".repeat(Math.max(0, Math.min(paddingX, width)));
			const available = Math.max(0, width - visibleWidth(spacing) * 2);
			const line = spacing + truncateToWidth(get(), available) + spacing;
			const bounded = visibleWidth(line) > width ? truncateToWidth(line, Math.max(0, width)) : line;
			return [bounded + " ".repeat(Math.max(0, width - visibleWidth(bounded)))];
		},
		invalidate: () => undefined,
	};
}

export class FileBrowser extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeyMatcher;
	private readonly files: string[];
	private readonly branchLabel: string;
	private readonly onDone: (result: FileBrowserResult) => void;
	private readonly query: Input;
	private readonly noMatch: Component;
	private readonly listContainer: Container;

	private dir: string;
	/** The current directory's full listing; `activate` resolves a selected path against it. */
	private entries: BrowserEntry[] = [];
	private list: SelectList | undefined;
	/** The dir `entries` was computed for; `files` is immutable, so this is the only invalidation key. */
	private listingDir: string | undefined;
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	/** Propagated to the Input: without it the terminal cannot place an IME candidate window at the cursor. */
	set focused(value: boolean) {
		this._focused = value;
		this.query.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeyMatcher,
		options: FileBrowserOptions,
		done: (result: FileBrowserResult) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.files = options.files;
		this.branchLabel = options.branchLabel;
		this.onDone = done;
		this.dir = options.initialDir ?? "";

		this.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		this.addChild(singleLine(() => this.headerLine()));
		this.query = new Input({ placeholder: "type to filter" });
		this.addChild(this.query);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(singleLine(() => this.theme.fg("dim", "type to filter · ↑↓ move · ⏎ open · ←/⌫ up · esc back")));
		this.addChild(new DynamicBorder((str: string) => theme.fg("accent", str)));
		// Created once and reused: the getter reads the current directory and
		// filter at render time, so it never goes stale.
		this.noMatch = singleLine(() => this.theme.fg("muted", this.emptyMessage()), 1);

		this.rebuild();
	}

	private headerLine(): string {
		return this.theme.fg("accent", this.theme.bold(`Explore ${sanitizeDisplay(this.branchLabel)} › ${sanitizeDisplay(this.dir || ".")}`));
	}

	private emptyMessage(): string {
		return this.entries.length === 0
			? "(empty directory)"
			: `no match for "${sanitizeDisplay(this.query.getValue())}"`;
	}

	/** The list theme, as closures over `this.theme`, so a theme change is picked up on the next render. */
	private selectTheme(): SelectListTheme {
		return {
			selectedPrefix: (text: string) => this.theme.fg("accent", text),
			selectedText: (text: string) => this.theme.fg("accent", text),
			description: (text: string) => this.theme.fg("muted", text),
			scrollInfo: (text: string) => this.theme.fg("dim", text),
			noMatch: (text: string) => this.theme.fg("warning", text),
		};
	}

	/** Recompute the listing for the current directory and filter, and swap the list child. */
	private rebuild(): void {
		// `files` never changes for one browser, so the directory listing is worth
		// keeping until the directory does: without this the whole flat list is
		// rescanned on every filter keystroke (measurably tens of ms on a repo
		// with hundreds of thousands of paths).
		if (this.listingDir !== this.dir) {
			this.entries = listDirectory(this.files, this.dir);
			this.listingDir = this.dir;
		}
		const query = this.query.getValue();
		const shown = query.length > 0 ? fuzzyFilter(this.entries, query, (entry) => entry.name) : this.entries;

		this.listContainer.clear();
		if (shown.length === 0) {
			this.list = undefined;
			this.listContainer.addChild(this.noMatch);
			return;
		}
		const items: SelectItem[] = shown.map((entry) => ({
			// Display is sanitized; `value` stays the byte-faithful path.
			value: entry.path,
			label: sanitizeDisplay(entry.isDir ? `${entry.name}/` : entry.name),
		}));
		const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), this.selectTheme());
		list.onSelect = (item) => this.activate(item.value);
		// No onCancel: `handleInput` routes Esc/Ctrl+C to `back` before the list
		// ever sees them, so a cancel handler here would be unreachable.
		this.list = list;
		this.listContainer.addChild(list);
	}

	/** Enter: a directory becomes the new root of the listing, a file finishes the interaction. */
	private activate(path: string): void {
		const entry = this.entries.find((candidate) => candidate.path === path);
		if (!entry) return;
		if (!entry.isDir) {
			this.finish({ path: entry.path });
			return;
		}
		this.dir = entry.path;
		this.query.setValue("");
		this.rebuild();
		this.tui.requestRender();
	}

	/** Esc / Ctrl+C: drop the filter, then walk up, then cancel. */
	private back(): void {
		if (this.query.getValue().length > 0) {
			this.query.setValue("");
			this.rebuild();
			this.tui.requestRender();
			return;
		}
		if (this.dir !== "") {
			this.walkUp();
			return;
		}
		this.finish(null);
	}

	/** Move to the parent directory; a no-op at the root, where there is none. */
	private walkUp(): void {
		if (this.dir === "") return;
		this.dir = parentPath(this.dir);
		this.rebuild();
		this.tui.requestRender();
	}

	private finish(result: FileBrowserResult): void {
		if (this.closed) return;
		this.closed = true;
		this.onDone(result);
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.list?.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			// SelectList.confirm invokes onSelect, which is `activate`.
			this.list?.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.back();
			return;
		}
		// Navigation keys only while the filter is empty; otherwise they are the
		// filter's own editing keys (see the header). At the root `walkUp` does
		// nothing — ⌫ must not throw the browse away.
		if (this.query.getValue().length === 0 && (matchesKey(data, Key.backspace) || matchesKey(data, Key.left))) {
			this.walkUp();
			return;
		}
		this.query.handleInput(data);
		this.rebuild();
		this.tui.requestRender();
	}
}
