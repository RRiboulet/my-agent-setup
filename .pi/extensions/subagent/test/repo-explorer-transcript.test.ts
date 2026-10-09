// Behavior tests for /explore's print-to-transcript step
// (.pi/extensions/repo-explorer/file-transcript.ts) and the display boundary it
// shares with the browser (.pi/extensions/repo-explorer/sanitize.ts).
//
// The risks pinned here:
//
//  - The numbering must reflect the file, not the page. `readFile.text` is an
//    exact prefix of the blob and may or may not end in a newline; a trailing
//    "" is the blob's terminator, not an empty line, and `shownLines`/
//    `totalLines` are what the header and the truncation note have to agree
//    with.
//  - The model reads `content` and the terminal reads the renderer's output,
//    and the two must not be confused. The content keeps the file's own bytes
//    (tabs and line endings); the renderer is where a hostile file — a log
//    holding ESC, BEL, or a lone CR — is made inert, and where a long line is
//    bounded instead of overflowing (pi-tui throws on an over-width line).
//  - Rendered output must be plain lines: the default custom-message renderer
//    runs the body through Markdown, which would reinterpret a file that
//    contains ``` or `*` and would pass control bytes through untouched.

import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	FILE_MESSAGE_TYPE,
	fileMessageRenderer,
	formatFileTranscript,
	numberLines,
} from "../../repo-explorer/file-transcript.ts";
import type { FileRead } from "../../repo-explorer/git.ts";
import { sanitizeDisplay, sanitizeFileContent } from "../../repo-explorer/sanitize.ts";

/** A stand-in for pi's Theme whose `fg`/`bold` are visible, so styling can be asserted. */
const mark = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (text: string) => `*${text}*` } as never;

function read(overrides: Partial<FileRead> = {}): FileRead {
	return {
		text: "",
		totalLines: 0,
		shownLines: 0,
		truncated: false,
		sizeBytes: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// sanitize.ts — the display boundary
// ---------------------------------------------------------------------------

test("sanitizeDisplay makes control bytes inert and leaves real text alone", () => {
	assert.equal(sanitizeDisplay("\u001b[2J"), "^[[2J");
	assert.equal(sanitizeDisplay("a\u0007b"), "a^Gb");
	assert.equal(sanitizeDisplay("l1\nl2"), "l1^Jl2");
	assert.equal(sanitizeDisplay("del\u007f"), "del^?");
	assert.equal(sanitizeDisplay("c1\u0085x"), "c1\\u0085x");
	assert.equal(sanitizeDisplay("café-🔥.md"), "café-🔥.md", "legitimate non-ASCII is not touched");
});

test("sanitizeFileContent keeps tab and newline, normalizes CRLF, notates the rest", () => {
	assert.equal(sanitizeFileContent("a\tb"), "a\tb", "a tab is the file's own formatting");
	assert.equal(sanitizeFileContent("a\nb"), "a\nb");
	assert.equal(sanitizeFileContent("a\r\nb"), "a\nb", "CRLF is normalized, not shown as ^M");
	assert.equal(sanitizeFileContent("lone\rreturn"), "lone^Mreturn");
	assert.equal(sanitizeFileContent("\u001b[2J\u0007"), "^[[2J^G");
});

// ---------------------------------------------------------------------------
// numberLines
// ---------------------------------------------------------------------------

test("line numbers are right-aligned and survive a missing terminator", () => {
	assert.equal(numberLines("a\nb\nc\n"), "1 │ a\n2 │ b\n3 │ c");
	assert.equal(numberLines("a\nb\nc"), "1 │ a\n2 │ b\n3 │ c", "the numbering does not depend on a trailing newline");
	assert.equal(numberLines("only"), "1 │ only");
});

test("the number column widens with the line count", () => {
	const twelve = numberLines(Array.from({ length: 12 }, (_v, i) => `l${i}`).join("\n"));
	const lines = twelve.split("\n");
	assert.equal(lines[0], " 1 │ l0");
	assert.equal(lines[9], "10 │ l9");
	assert.equal(lines[11], "12 │ l11");
});

test("an empty file has no numbered lines", () => {
	assert.equal(numberLines(""), "");
});

test("interior blank lines are real lines and keep their numbers", () => {
	assert.equal(numberLines("a\n\nb\n"), "1 │ a\n2 │ \n3 │ b");
});

// ---------------------------------------------------------------------------
// formatFileTranscript
// ---------------------------------------------------------------------------

test("the content names the branch and path, then numbers the body", () => {
	const { content, details } = formatFileTranscript(
		read({ text: "alpha\nbeta\n", totalLines: 2, shownLines: 2, sizeBytes: 11 }),
		"main (current)",
		"src/main.ts",
	);
	assert.equal(content, "Explore main (current) › src/main.ts\n\n1 │ alpha\n2 │ beta");
	assert.deepEqual(details, {
		branch: "main (current)",
		path: "src/main.ts",
		note: undefined,
		shownLines: 2,
		totalLines: 2,
		sizeBytes: 11,
	});
});

test("a truncation note is the second line, and an empty file says so", () => {
	const { content } = formatFileTranscript(
		read({ text: "a\n", totalLines: 3000, shownLines: 1, truncated: true, note: "truncated: showing the first 2000 of 3000 lines" }),
		"main",
		"big.txt",
	);
	assert.equal(
		content,
		"Explore main › big.txt\ntruncated: showing the first 2000 of 3000 lines\n\n1 │ a",
	);
	assert.match(formatFileTranscript(read(), "main", "empty.txt").content, /\n\n\(empty file\)$/);
});

test("a hostile path is sanitized in the content while details keep it raw", () => {
	const hostile = "evil\u001b[2J.txt";
	const { content, details } = formatFileTranscript(read({ text: "x\n", totalLines: 1, shownLines: 1 }), "main", hostile);
	assert.match(content, /^Explore main › evil\^\[\[2J\.txt/);
	assert.ok(!content.includes("\u001b"));
	assert.equal(details.path, hostile, "the raw path is what a consumer needs");
});

// ---------------------------------------------------------------------------
// fileMessageRenderer
// ---------------------------------------------------------------------------

/** Render a message the way the transcript would, with a marking theme. */
function renderMessage(content: string, details: Record<string, unknown>, width: number): string[] {
	const component = fileMessageRenderer({ content, customType: FILE_MESSAGE_TYPE, display: true, details } as never, { expanded: false, outputPad: 1 } as never, mark);
	assert.ok(component, "the renderer must return a component");
	return component.render(width);
}

test("the header and the truncation note are the coloured lines", () => {
	const lines = renderMessage("Explore main › a.txt\nshowing 1 of 9 lines\n\n1 │ x", { note: "showing 1 of 9 lines" }, 80);
	assert.equal(lines[0], "<accent>*Explore main › a.txt*</>");
	assert.equal(lines[1], "<warning>showing 1 of 9 lines</>");
	assert.equal(lines[3], "1 │ x", "the body is verbatim, not themed");
});

test("without a note the second line is body, not a warning", () => {
	const lines = renderMessage("Explore main › a.txt\n\n1 │ x", { note: undefined }, 80);
	assert.equal(lines[1], "", "no note means no styled line to insert");
	assert.equal(lines[2], "1 │ x");
});

test("a hostile file body is inert on screen but intact for the model", () => {
	// ESC, BEL and a lone CR are what a log file can really contain.
	const content = "Explore main › log.txt\n\n1 │ \u001b[2Jclear\u0007ding\n2 │ lone\rmid";
	const lines = renderMessage(content, {}, 80);
	assert.ok(!lines.join("\n").includes("\u001b"), "no raw escape reaches the terminal");
	assert.ok(!lines.join("\n").includes("\u0007"));
	assert.equal(lines[2], "1 │ ^[[2Jclear^Gding");
	assert.equal(lines[3], "2 │ lone^Mmid");
});

test("tabs survive rendering and every line is bounded by the width", () => {
	const content = `Explore main › code.ts\n\n1 │ \tindented\tcolumns\n2 │ ${"x".repeat(200)}`;
	for (const width of [12, 40, 80]) {
		const lines = renderMessage(content, {}, width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)} is ${visibleWidth(line)} cells`);
		}
	}
	assert.equal(renderMessage(content, {}, 80)[2], "1 │ \tindented\tcolumns", "a tab is not caret-notated");
	// truncateToWidth puts a style reset after the ellipsis it inserts, so the
	// assertion is on the ellipsis, not on the line's final character.
	assert.match(renderMessage(content, {}, 20)[3] as string, /…/, "a long line ends in an ellipsis, not an overflow");
});

test("an empty or non-string content does not throw", () => {
	assert.doesNotThrow(() => renderMessage("", {}, 40));
	assert.doesNotThrow(() =>
		fileMessageRenderer({ content: [], customType: FILE_MESSAGE_TYPE, display: true } as never, { expanded: false, outputPad: 1 } as never, mark),
	);
});
