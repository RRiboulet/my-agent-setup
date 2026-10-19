#!/usr/bin/env node
// The /btw pane's viewer: renders answer.md as ANSI Markdown and keeps up as
// the answer streams in. The pane execs this script; it only ever writes to
// the pty, so tmux keeps the keys and scrolling stays native (copy mode,
// mouse wheel) exactly like the subagent attach views.
//
// The viewer appends only: the renderer is incremental-stable (see
// markdown.mjs), so a line already on screen is never re-rendered differently
// as the answer grows, and the pane's scrollback stays the document itself.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";

import { renderFrom } from "./markdown.mjs";

async function runViewer(answerPath) {
	const DEBOUNCE_MS = 120;
	const color = !process.env.NO_COLOR;
	let rendered = 0;
	let fenceOpen = false;
	let timer;
	const paint = async () => {
		let text;
		try {
			text = await readFile(answerPath, "utf8");
		} catch {
			return; // not created yet; the watch below fires when it appears
		}
		const all = text.split("\n");
		if (all.length < rendered) {
			// The file was replaced under us (a reset kills the server with the
			// old viewer, so this is defensive): start the screen over.
			process.stdout.write("\x1b[2J\x1b[H");
			rendered = 0;
			fenceOpen = false;
		}
		const { lines, fenceOpen: next } = renderFrom(text, rendered, fenceOpen, { color });
		if (lines.length > 0) process.stdout.write(`${lines.join("\r\n")}\r\n`);
		rendered += lines.length;
		fenceOpen = next;
	};
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			paint().catch(() => undefined);
		}, DEBOUNCE_MS);
	};
	watch(answerPath, schedule);
	await paint();
}

runViewer(process.argv[2]);
