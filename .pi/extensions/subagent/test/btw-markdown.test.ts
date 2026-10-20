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
// the answer as far as its last newline.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";

import { renderMarkdown } from "../../btw/markdown.mjs";
import { buildThemeSpec, installThemeSpec } from "../../btw/theme.mjs";

const VIEWER = path.join(import.meta.dirname, "..", "..", "btw", "viewer.mjs");

/** Strip the escape sequences so the assertions read the drawn text. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A theme spec for the viewer, built from a real pi theme. */
function themeSpec() {
	initTheme("dark");
	const live = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	return buildThemeSpec(live);
}

/** A theme the assertions can compare against, without touching pi's global. */
function plainTheme() {
	initTheme("dark");
	return installThemeSpec(buildThemeSpec(globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]));
}

test("a table renders as a table", () => {
	const lines = renderMarkdown("| Feature | Status |\n| --- | --- |\n| Tables | yes |", 60, plainTheme());
	const text = lines.join("\n");
	assert.match(text, /│ Feature\s+│ Status\s+│/, "the header row is drawn as cells");
	assert.match(text, /│ Tables\s+│ yes\s+│/, "the body row is drawn as cells");
	assert.match(text, /[┌├└][─]*[┬┴┼]/, "the table has borders");
	assert.ok(!text.includes("| ---"), "the delimiter row is not shown as text");
});

test("headings, lists, quotes, links and code blocks render", () => {
	const theme = plainTheme();
	const heading = renderMarkdown("# Title", 40, theme).join("");
	assert.ok(!heading.includes("#"), "the heading marker is stripped");
	const list = renderMarkdown("- one\n- two\n  - nested", 40, theme).join("\n");
	assert.match(list, /one/);
	assert.match(list, /nested/);
	assert.ok(!list.includes("- one"), "the list marker is replaced, not shown as text");
	const quote = renderMarkdown("> quoted", 40, theme).join("");
	assert.match(quote, /quoted/);
	assert.ok(!quote.includes(">"), "the quote marker is replaced");
	const link = renderMarkdown("[label](https://example.dev)", 60, theme).join("");
	assert.match(link, /label/);
	assert.match(link, /example\.dev/);
	const code = plain(renderMarkdown("```ts\nconst x = 1;\n```", 40, theme).join("\n"));
	assert.match(code, /const x = 1;/, "the code is drawn");
	assert.match(code, /```/, "the fence is drawn as a fence");
});

test("the theme spec round-trips: the panel renders in the transcript's colors", () => {
	initTheme("dark");
	const live = globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")];
	const transcript = renderMarkdown("# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", 60, {
		heading: (text) => live.fg("mdHeading", text),
		link: (text) => live.fg("mdLink", text),
		linkUrl: (text) => live.fg("mdLinkUrl", text),
		code: (text) => live.fg("mdCode", text),
		codeBlock: (text) => live.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => live.fg("mdCodeBlockBorder", text),
		quote: (text) => live.fg("mdQuote", text),
		quoteBorder: (text) => live.fg("mdQuoteBorder", text),
		hr: (text) => live.fg("mdHr", text),
		listBullet: (text) => live.fg("mdListBullet", text),
		bold: (text) => live.bold(text),
		italic: (text) => live.italic(text),
		underline: (text) => live.underline(text),
		strikethrough: (text) => live.strikethrough(text),
	});
	const spec = buildThemeSpec(live);
	const panel = renderMarkdown("# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", 60, installThemeSpec(spec));
	assert.equal(panel.join("\n"), transcript.join("\n"), "the panel draws the transcript's colors");
});

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
	for (const cleanup of cleanups) await cleanup();
});

/** Run the viewer against a temp answer file and collect what it draws. */
async function startViewer(answer: string) {
	const dir = await mkdtemp(path.join(tmpdir(), "btw-viewer-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const answerPath = path.join(dir, "answer.md");
	const themePath = path.join(dir, "theme.json");
	await writeFile(answerPath, answer, "utf8");
	await writeFile(themePath, JSON.stringify(themeSpec()), "utf8");
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

test("the viewer draws the answer as Markdown and keeps a streamed tail", async () => {
	const viewer = await startViewer("# /btw\n\n> why?\n\nHello");
	assert.ok(await viewer.until("Hello"), "the answer is drawn");
	assert.ok(await viewer.until("why?"), "the question is drawn as a quote");

	await writeFile(viewer.answerPath, "# /btw\n\n> why?\n\nHello world", "utf8");
	assert.ok(await viewer.until("Hello world"), "the tail of a streamed line is drawn, not dropped");
	assert.equal(viewer.errors(), "", "the viewer reports nothing on stderr");
});
