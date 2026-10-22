// Tests for the /btw panel's Markdown rendering.
//
// Risk covered: the renderer is the only thing between the answer file's raw
// Markdown and the panel. The panel used to carry its own line-oriented
// renderer, which could not draw a table and dropped the tail of every
// half-written line; it now renders through pi-tui's `Markdown` component, the
// one the TUI renders an assistant message with. These tests pin that the
// panel draws what the TUI draws - tables, nested lists, highlighted code -
// and that the theme it draws in is the transcript's theme.
//
// The viewer is exercised as a process, because the claim that matters is what
// lands in the pane: a streamed answer that grows must show its new tail, not
// the answer as far as its last newline. The unit tests below cover the
// wiring the process test cannot see - the theme round-trip and the fallback
// for a panel with no theme spec.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { getPackageDir, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

import { resolvePiEntryPoints } from "../../btw/entry-points.mjs";
import { createMarkdownView } from "../../btw/markdown.mjs";
import { buildThemeSpec, installThemeSpec, themeTokenValues } from "../../btw/theme.mjs";

const VIEWER = path.join(import.meta.dirname, "..", "..", "btw", "viewer.mjs");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

/** Strip the escape sequences so the assertions read the drawn text. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * pi's theme module, as the viewer imports it: the module inside pi's
 * installation, which is the one that carries the API that installs a theme
 * instance.
 */
const piThemeModule = async () =>
	(await import(pathToFileURL(path.join(getPackageDir(), "dist", "modes", "interactive", "theme", "theme.js")).href)) as never;

/** pi's live theme, as the parent sees it. */
function liveTheme() {
	initTheme("dark");
	return globalThis[THEME_KEY];
}

/** Render a document the way the panel does, through the panel's own view. */
function render(text: string, width: number, theme: unknown): string {
	const view = createMarkdownView(Markdown, theme as never);
	view.setText(text);
	return view.render(width).join("\n");
}

test("a truecolor terminal round-trips too", async () => {
	// The channels in a truecolor escape are decimal, and a hex colour is
	// two hex digits per channel: reading one as the other produced a
	// nine-digit colour that pi's own parser refused, which left the panel
	// in the terminal's palette on every truecolor terminal.
	const previous = process.env.COLORTERM;
	process.env.COLORTERM = "truecolor";
	try {
		const live = liveTheme();
		const spec = buildThemeSpec(live);
		const accent = live.getFgAnsi("accent");
		const expected = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(accent);
		assert.ok(expected, "the theme draws this token in truecolor");
		const hex = `#${expected.slice(1).map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
		assert.equal(spec.colors.accent, hex, "the panel is handed the color as a hex it can parse");
		const panel = installThemeSpec(spec, await piThemeModule());
		assert.equal(panel.heading("x"), live.fg("mdHeading", "x"), "and it draws the same color the transcript does");
	} finally {
		if (previous === undefined) delete process.env.COLORTERM;
		else process.env.COLORTERM = previous;
	}
});

test("a faint token is drawn once, not twice", async () => {
	// The theme's resolved colour map mixes a faint token toward the
	// background, so a colour taken from there and drawn with the faint flag
	// on top of it is faded twice.
	const live = liveTheme();
	const { colors } = themeTokenValues(live);
	const theme = new Theme({ ...colors, mdHeading: "#888888" }, {}, live.getColorMode(), { dim: ["mdHeading"] });
	const spec = buildThemeSpec(theme);
	assert.equal(spec.dim.includes("mdHeading"), true, "the token is marked faint");
	assert.equal(spec.colors.mdHeading, "#888888", "and keeps its own color, not the mixed one");
	const panel = installThemeSpec(spec, await piThemeModule());
	assert.equal(panel.heading("x"), theme.fg("mdHeading", "x"), "the panel fades it once, like the transcript");
});

test("the entry points are where pi actually is", () => {
	const entryPoints = resolvePiEntryPoints(getPackageDir());
	assert.ok(entryPoints.tui, "pi-tui is found");
	assert.ok(entryPoints.theme, "pi's theme module is found");
	assert.ok(existsSync(entryPoints.tui), "the path pi-tui was found at is a file");
	assert.ok(existsSync(entryPoints.theme), "the path pi's theme module was found at is a file");
});

test("a palette index reaches the panel as an index, not as a hex", async () => {
	const live = liveTheme();
	const { colors } = themeTokenValues(live);
	colors.mdHeading = 5;
	const indexed = new Theme(colors, {}, live.getColorMode());

	const spec = buildThemeSpec(indexed);
	assert.equal(spec.colors.mdHeading, 5, "the index survives the hand-off");
	const panel = installThemeSpec(spec, await piThemeModule());
	assert.equal(
		panel.heading("Title"),
		indexed.fg("mdHeading", "Title"),
		"the panel draws the index the way the transcript draws it",
	);
});

test("the theme spec round-trips: the panel renders in the transcript's colors", async () => {
	const live = liveTheme();
	// Rendered before the spec is installed: pi's theme is a proxy that
	// reads the live theme when it is called, so the "before" has to be
	// taken first.
	const before = render("# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", 60, {
		heading: (text: string) => live.fg("mdHeading", text),
		link: (text: string) => live.fg("mdLink", text),
		linkUrl: (text: string) => live.fg("mdLinkUrl", text),
		code: (text: string) => live.fg("mdCode", text),
		codeBlock: (text: string) => live.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => live.fg("mdCodeBlockBorder", text),
		quote: (text: string) => live.fg("mdQuote", text),
		quoteBorder: (text: string) => live.fg("mdQuoteBorder", text),
		hr: (text: string) => live.fg("mdHr", text),
		listBullet: (text: string) => live.fg("mdListBullet", text),
		bold: (text: string) => live.bold(text),
		italic: (text: string) => live.italic(text),
		underline: (text: string) => live.underline(text),
		strikethrough: (text: string) => live.strikethrough(text),
	});
	const spec = buildThemeSpec(live);
	const after = render(
		"# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
		60,
		installThemeSpec(spec, await piThemeModule()),
	);
	assert.equal(after, before, "the panel draws the transcript's colors");
	// The comparison above is on the *raw* output: a stripped comparison
	// cannot see a colour at all, and would have passed with every token
	// drawn in the wrong one.
	assert.ok(after.includes("\x1b["), "the drawing carries colours to compare");
});

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
	for (const cleanup of cleanups) await cleanup();
});

/** Run the viewer against a temp answer file and collect what it draws. */
async function startViewer(answer: string, spec?: unknown) {
	const dir = await mkdtemp(path.join(tmpdir(), "btw-viewer-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const answerPath = path.join(dir, "answer.md");
	const themePath = path.join(dir, "theme.json");
	await writeFile(answerPath, answer, "utf8");
	if (spec !== undefined) await writeFile(themePath, JSON.stringify(spec), "utf8");
	const child = spawn("node", [VIEWER, answerPath, themePath], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
	});
	const errors: string[] = [];
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		errors.push(chunk);
	});
	cleanups.push(async () => {
		child.kill("SIGKILL");
	});
	return {
		answerPath,
		raw: () => output,
		drawn: () => plain(output),
		errors: () => errors.join(""),
		/** Wait until the drawn text contains `needle`, or give up. */
		async until(needle: string, timeoutMs = 8000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (plain(output).includes(needle)) return true;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			return false;
		},
	};
}

/**
 * A panel spec for the viewer, built from a real pi theme and the real entry
 * points.
 *
 * The entry points matter: without them the viewer falls back to the bare
 * specifiers, so the hand-off - the thing that lets the panel start in an
 * installed package - would never be exercised.
 */
function panelSpec(colors?: Record<string, string | number>) {
	const theme = buildThemeSpec(liveTheme());
	if (colors) theme.colors = { ...theme.colors, ...colors };
	return { theme, entryPoints: resolvePiEntryPoints(getPackageDir()) };
}

test("the viewer draws the answer as Markdown, tables included", async () => {
	const viewer = await startViewer(
		"# /btw\n\n> why?\n\n| Feature | Status |\n| --- | --- |\n| Tables | yes |",
		panelSpec(),
	);
	assert.ok(await viewer.until("why?"), "the question is drawn as a quote");
	assert.ok(await viewer.until("Feature"), "the table's header is drawn");
	assert.ok(await viewer.until("Tables"), "the table's rows are drawn");
	assert.ok(await viewer.until("│"), "the table is drawn as a table, not as markup");
	assert.ok(!viewer.drawn().includes("| ---"), "the delimiter row is not drawn as text");
	assert.equal(viewer.errors(), "", "the viewer reports nothing on stderr");
});

test("the viewer keeps a streamed tail", async () => {
	const viewer = await startViewer("# /btw\n\n> why?\n\nHello", panelSpec());
	assert.ok(await viewer.until("Hello"), "the answer is drawn");

	await writeFile(viewer.answerPath, "# /btw\n\n> why?\n\nHello world", "utf8");
	assert.ok(await viewer.until("Hello world"), "the tail of a streamed line is drawn, not dropped");
});

test("the viewer opens without a theme spec, in the terminal's own palette", async () => {
	const viewer = await startViewer("# /btw\n\n> why?\n\nHello", undefined);
	assert.ok(await viewer.until("Hello"), "the answer is drawn without a theme spec");
	assert.equal(viewer.errors(), "", "the viewer reports nothing on stderr");
});

test("a palette index in the spec is drawn as an index", async () => {
	const viewer = await startViewer("# /btw\n\n> why?\n\nHello", panelSpec({ mdHeading: 5 }));
	assert.ok(await viewer.until("Hello"), "the answer is drawn");
	assert.ok(
		viewer.raw().includes("\x1b[38;5;5m"),
		"the heading is drawn with the palette index, not with a hex",
	);
});
