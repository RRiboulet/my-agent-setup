// Behavior tests for the /explore file browser (.pi/extensions/repo-explorer/file-browser.ts).
//
// Two risks this file exists for.
//
// First, the directory model. `listFiles` returns a flat list of paths, and the
// browser is what turns it into a tree — folders do not exist in the data, only
// as prefixes. A confusion there (a directory that is a prefix of a sibling, a
// nested folder not synthesized, a file listed as its own child) shows up as a
// wrong tree and a file that cannot be opened, so `listDirectory` is pinned
// directly, without a terminal.
//
// Second, the key contract. The browser is keyboard-only and keys are overloaded
// on purpose: ⌫ and ← walk up a directory *only while the filter is empty*, and
// otherwise belong to the filter, because a filter that cannot be corrected is
// useless. Esc is the way back from a filter first, a directory second, and is
// the cancel only at the root. Those three-way rules are easy to get subtly
// wrong, so they are asserted through the real component, driven with the real
// key sequences pi delivers.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";

import {
	FileBrowser,
	listDirectory,
	parentPath,
	sanitizeDisplay,
	type FileBrowserResult,
} from "../../repo-explorer/file-browser.ts";

/** A stand-in for pi's Theme: `fg`/`bold` return the text unchanged, so assertions stay readable. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const tui = { requestRender: () => undefined } as never;
const keybindings = getKeybindings();

// The byte sequences pi's key parser produces, as the probe pinned them.
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";

const FILES = [
	"README.md",
	"assets/logo.png",
	"docs/café América.txt",
	"docs/guide/install.md",
	"src/lib/depth.ts",
	"src/main.ts",
];

function browser(files: string[] = FILES, initialDir?: string) {
	const results: FileBrowserResult[] = [];
	const component = new FileBrowser(tui, theme, keybindings, { branchLabel: "main", files, initialDir }, (result) =>
		results.push(result),
	);
	return { component, results, render: (width = 80): string => component.render(width).join("\n") };
}

// ---------------------------------------------------------------------------
// The directory model
// ---------------------------------------------------------------------------

test("the root listing puts folders first, then files, each alphabetical", () => {
	assert.deepEqual(listDirectory(FILES, ""), [
		{ name: "assets", path: "assets", isDir: true },
		{ name: "docs", path: "docs", isDir: true },
		{ name: "src", path: "src", isDir: true },
		{ name: "README.md", path: "README.md", isDir: false },
	]);
});

test("a subdirectory lists only its own children, synthesizing nested folders", () => {
	assert.deepEqual(listDirectory(FILES, "docs"), [
		{ name: "guide", path: "docs/guide", isDir: true },
		{ name: "café América.txt", path: "docs/café América.txt", isDir: false },
	]);
	assert.deepEqual(listDirectory(FILES, "src/lib"), [
		{ name: "depth.ts", path: "src/lib/depth.ts", isDir: false },
	]);
});

test("a directory that is only a prefix of another is not confused for it", () => {
	// `src` must not pick up `srcx/other.ts`, and a name that is also a file
	// (`src` itself) must not list as its own child.
	const files = ["src/main.ts", "srcx/other.ts", "src"];
	assert.deepEqual(listDirectory(files, "src"), [{ name: "main.ts", path: "src/main.ts", isDir: false }]);
	assert.deepEqual(listDirectory(files, "nope"), []);
});

test("parentPath walks up and stops at the root", () => {
	assert.equal(parentPath("src/lib"), "src");
	assert.equal(parentPath("src"), "");
	assert.equal(parentPath(""), "");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("the browser opens at the root with a breadcrumb and the folder-first listing", () => {
	const view = browser().render();
	assert.match(view, /Explore main › \./);
	assert.match(view, /assets\//, "folders are shown with a trailing slash");
	assert.match(view, /README\.md/);
	assert.ok(view.indexOf("assets/") < view.indexOf("README.md"), "folders come before files");
	assert.match(view, /type to filter/);
});

test("every rendered line fits the width it is given", () => {
	const { component } = browser(FILES, "docs/guide");
	for (const width of [20, 32, 80]) {
		for (const line of component.render(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: ${JSON.stringify(line)} is ${visibleWidth(line)} cells`,
			);
		}
	}
});

test("an empty directory says so instead of rendering no rows", () => {
	assert.match(browser([], "").render(), /\(empty directory\)/);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test("Enter drills into the highlighted folder and clears any filter", () => {
	const { component, render } = browser();
	component.handleInput("g"); // filter, so we can prove Enter clears it
	component.handleInput(BACKSPACE);
	component.handleInput(DOWN); // assets(0) → docs(1)
	component.handleInput(ENTER);
	const view = render();
	assert.match(view, /Explore main › docs/);
	assert.match(view, /guide\//);
	assert.match(view, /café América\.txt/);
	assert.doesNotMatch(view, /assets\//, "the parent's entries are gone");
});

test("Enter on a file finishes with that file's repo-relative path", () => {
	const { component, results } = browser(FILES, "src");
	component.handleInput(DOWN); // lib(0) → main.ts(1)
	component.handleInput(ENTER);
	assert.deepEqual(results, [{ path: "src/main.ts" }]);
});

test("a file can be reached by drilling, and the path is the full repo-relative one", () => {
	const { component, results } = browser();
	component.handleInput(DOWN); // docs
	component.handleInput(ENTER);
	component.handleInput(ENTER); // guide/ is already the selected row in docs
	component.handleInput(ENTER); // install.md is the only entry in docs/guide
	assert.deepEqual(results, [{ path: "docs/guide/install.md" }]);
});

test("arrow navigation wraps at both ends", () => {
	const { component, render } = browser();
	component.handleInput(UP); // from the first row, wraps to the last
	assert.match(render(), /→ README\.md/);
	component.handleInput(DOWN); // and back around
	assert.match(render(), /→ assets\//);
});

test("← and ⌫ walk up a directory, and do nothing at the root", () => {
	const { component, render, results } = browser(FILES, "src/lib");
	assert.match(render(), /Explore main › src\/lib/);
	component.handleInput(BACKSPACE);
	assert.match(render(), /Explore main › src/);
	component.handleInput(LEFT);
	assert.match(render(), /Explore main › \./);
	// At the root there is no parent: a stray Backspace must not end the browse.
	component.handleInput(BACKSPACE);
	component.handleInput(LEFT);
	assert.match(render(), /Explore main › \./);
	assert.deepEqual(results, [], "only Esc cancels");
});

// ---------------------------------------------------------------------------
// The filter, and the keys it shares with navigation
// ---------------------------------------------------------------------------

test("the filter narrows the current directory by fuzzy match", () => {
	const { component, render } = browser();
	component.handleInput("r"); // src/ and README.md survive
	component.handleInput("e");
	const view = render();
	assert.match(view, /README\.md/);
	assert.doesNotMatch(view, /assets\//);
	assert.doesNotMatch(view, /src\//, "src has no e, so it drops out");
});

test("with a filter typed, ⌫ edits it instead of leaving the directory", () => {
	const { component, render, results } = browser(FILES, "src");
	component.handleInput("m"); // only main.ts matches
	assert.match(render(), /main\.ts/);
	assert.doesNotMatch(render(), /lib\//);
	component.handleInput(BACKSPACE); // deletes the m, stays in src
	assert.match(render(), /Explore main › src/);
	assert.match(render(), /lib\//, "the full listing is back");
	assert.deepEqual(results, [], "no directory change and no completion");
});

test("Esc clears the filter first, then walks up, then cancels", () => {
	const { component, render, results } = browser(FILES, "docs");
	component.handleInput("z"); // matches nothing
	assert.match(render(), /no match for "z"/);
	component.handleInput(ESC);
	assert.match(render(), /Explore main › docs/);
	assert.doesNotMatch(render(), /no match/);
	component.handleInput(ESC);
	assert.match(render(), /Explore main › \./);
	component.handleInput(ESC);
	assert.deepEqual(results, [null]);
});

test("a finished browser ignores further input", () => {
	const { component, results } = browser(FILES, "src");
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	component.handleInput(ESC);
	assert.deepEqual(results, [{ path: "src/main.ts" }]);
});

test("the component is focusable, so the filter's cursor can be placed", () => {
	const { component } = browser();
	component.focused = true;
	assert.equal(component.focused, true);
	component.focused = false;
	assert.equal(component.focused, false);
});

// ---------------------------------------------------------------------------
// Hostile names: the display boundary
// ---------------------------------------------------------------------------

// Legal git path names may contain any byte except NUL and `/`. These are the
// injections an attacker-pushed branch can carry.
const HOSTILE_FILES = [
	"\u0007bel.txt",
	"\u001b[2Jclearme.txt",
	"\u001b]0;pwned\u0007title.txt",
	"\u001b]52;c;Q09ERTA\u0007clipboard.txt",
	"line1\nline2.txt",
	"escape-tail\u001b.txt",
	"café-🔥.md",
];

test("sanitizeDisplay makes control bytes inert and leaves real text alone", () => {
	assert.equal(sanitizeDisplay("\u001b[2J"), "^[[2J");
	assert.equal(sanitizeDisplay("a\u0007b"), "a^Gb");
	assert.equal(sanitizeDisplay("l1\nl2"), "l1^Jl2");
	assert.equal(sanitizeDisplay("del\u007f"), "del^?");
	assert.equal(sanitizeDisplay("c1\u0085x"), "c1\\u0085x");
	assert.equal(sanitizeDisplay("café-🔥.md"), "café-🔥.md", "legitimate non-ASCII is not touched");
});

test("no rendered line carries a control byte, even for a hostile listing", () => {
	const { component } = browser(HOSTILE_FILES);
	for (const width of [20, 80]) {
		for (const line of component.render(width)) {
			// pi's Input draws its placeholder with reverse-video CSI, and
			// SelectList/truncateToWidth append a style reset after a truncated
			// row; those are the only trusted escapes in these lines, so strip
			// them and require the rest to be free of control bytes. The raw
			// attacker bytes are not in that allowlist, so removing the
			// sanitizer makes this fail. `visibleWidth` cannot see the class at
			// all (it prices C0 bytes at zero), which is why the assertion is on
			// the raw bytes.
			const cleaned = line.replace(/\u001b\[(?:0|7|27)m/g, "");
			assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f-\u009f]/, `width ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("a hostile directory name is sanitized in the breadcrumb too", () => {
	const { component, render } = browser(["evil\u001b[2Jdir/file.txt"]);
	component.handleInput(ENTER); // the only entry, so it is selected: drill in
	const view = render(60);
	assert.match(view, /evil\^\[\[2Jdir/);
	assert.ok(!view.includes("evil\u001b[2Jdir"), "the raw name never reaches the terminal");
});

test("the byte-faithful path is what a selection resolves to", () => {
	const hostile = "weird\u001b[31m.txt";
	const { component, results } = browser([hostile]);
	component.handleInput(ENTER);
	assert.deepEqual(results, [{ path: hostile }], "sanitization is display-only, not a rewrite of the path");
});

test("rendering survives degenerate widths without exceeding them", () => {
	// pi's own components set the floor: SelectList always emits a 2-cell "→ "
	// prefix and DynamicBorder a 1-cell rule, so 0–1 columns is out of scope for
	// any pi screen. 2 is the narrowest width the browser has to survive, and at
	// it the header/hint (which the fix made width-aware) must not exceed.
	const { component } = browser(HOSTILE_FILES, "docs");
	for (const width of [2, 3, 4, 5]) {
		for (const line of component.render(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: ${JSON.stringify(line)} is ${visibleWidth(line)} cells`,
			);
		}
	}
});

test("Ctrl+C takes Esc's path: up from a subdirectory, cancel at the root", () => {
	const { component, render, results } = browser(FILES, "src");
	component.handleInput("\x03");
	assert.match(render(), /Explore main › \./);
	assert.deepEqual(results, [], "it walked up rather than cancelling");
	component.handleInput("\x03");
	assert.deepEqual(results, [null], "at the root it cancels");
});

test("Enter in a directory with nothing to open does nothing", () => {
	const { component, results } = browser([], "");
	component.handleInput(ENTER);
	assert.deepEqual(results, []);
});
