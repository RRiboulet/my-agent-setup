// Tests for the /btw pane's Markdown renderer.
//
// Risk covered: the renderer is the only thing between the answer file's raw
// Markdown and the pane. A bug here shows raw markup or mangles text, and the
// incremental contract — a line already printed is never re-rendered differently
// as the answer grows — is what lets the viewer append without re-drawing. All
// of it is deterministic, so it is pinned directly.

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFrom, renderMarkdown } from "../../btw/markdown.mjs";

const ESC = "\x1b[";
const RESET = "\x1b[0m";
const DASHES = "─".repeat(56);

/** Render with color on, as the pane does. */
const styled = (text: string, options: Record<string, unknown> = {}): string =>
	renderMarkdown(text, { color: true, ...options });
/** Render plain, for structure assertions. */
const plain = (text: string): string => renderMarkdown(text, { color: false });

test("ATX headings render at three levels", () => {
	assert.equal(styled("# Title"), `${ESC}1;97mTitle${RESET}`);
	assert.equal(styled("## Sub"), `${ESC}1mSub${RESET}`);
	assert.equal(styled("### Sub"), `${ESC}2mSub${RESET}`);
	assert.equal(styled("#### Deep"), `${ESC}2mDeep${RESET}`, "h4+ collapse to dim");
	assert.equal(plain("# Title"), "Title", "the # marker is stripped");
});

test("blockquotes, rules, lists and tasks", () => {
	assert.equal(styled("> quoted"), `${ESC}2m│ ${RESET}quoted`);
	assert.equal(styled("---"), `${ESC}2m${DASHES}${RESET}`);
	assert.equal(styled("- item"), `${ESC}2m• ${RESET}item`);
	assert.equal(styled("1. first"), `${ESC}2m1. ${RESET}first`);
	assert.equal(styled("- [ ] todo"), `${ESC}2m☐ ${RESET}todo`);
	assert.equal(styled("- [x] done"), `${ESC}2m☑ ${RESET}done`);
});

test("code fences dim their markers and pass content through", () => {
	const out = styled("```ts\nconst x = 1;\n```").split("\n");
	assert.equal(out[0], `${ESC}2m\`\`\`ts${RESET}`);
	assert.equal(out[1], "const x = 1;", "fence content is untouched");
	assert.equal(out[2], `${ESC}2m\`\`\`${RESET}`);
});

test("inline spans: code, links, bold, italic, strike", () => {
	assert.equal(styled("use `x` here"), `use ${ESC}7m x ${RESET} here`);
	assert.equal(styled("[label](https://x.dev)"), `${ESC}4mlabel${RESET}${ESC}2m (https://x.dev)${RESET}`);
	assert.equal(styled("a **b** c"), `a ${ESC}1mb${RESET} c`);
	assert.equal(styled("a *i* c"), `a ${ESC}3mi${RESET} c`);
	assert.equal(styled("a ~~s~~ c"), `a ${ESC}9ms${RESET} c`);
});

test("escapes and HTML tags are neutralised", () => {
	assert.equal(plain("a \\*not\\* b"), "a *not* b");
	assert.equal(plain("a <b>bold</b> c"), "a bold c");
});

test("the usage footer is dimmed", () => {
	assert.equal(styled("input 10 · cache read 500 · output 3"), `${ESC}2minput 10 · cache read 500 · output 3${RESET}`);
});

test("the gutter is opt-in", () => {
	assert.deepEqual(renderFrom("a\nb", 0, false, { color: false }).lines, ["a", "b"]);
	assert.deepEqual(renderFrom("a\nb", 0, false, { color: false, gutter: true }).lines, ["   1 a", "   2 b"]);
});

test("resume keeps the fence state and appends without re-rendering", () => {
	const first = renderFrom("```\ncode\n```\nafter", 0, false, { color: false });
	assert.deepEqual(first, { lines: ["```", "code", "```", "after"], fenceOpen: false });
	const resumed = renderFrom("```\ncode\n```\nafter\nmore", first.lines.length, first.fenceOpen, { color: false });
	assert.deepEqual(resumed.lines, ["more"], "only the new line is rendered");
});

test("a line's rendering does not depend on later lines", () => {
	// Setext headings and 4-space indented code are deliberately unsupported
	// because they would break this property; the incremental viewer relies on it.
	const single = plain("underlined by the next line");
	const pair = renderFrom("underlined by the next line\n===", 0, false, { color: false }).lines[0];
	assert.equal(single, pair, "a paragraph line is not re-styled by a later '==='");
});

test("color off renders no escape sequences", () => {
	const out = renderMarkdown("# Title\n\n- item", { color: false });
	assert.ok(!out.includes("\x1b"), "no ANSI sequences when color is off");
	assert.equal(out, "Title\n\n• item");
});
