#!/usr/bin/env node
// The /btw pane's viewer: the answer, rendered the way the TUI renders it.
//
// The pane is a plain pty: the viewer only writes and tmux keeps the keys, so
// scrolling stays native (copy mode, mouse wheel) exactly like the subagent
// attach views. The drawing is pi-tui's own `TuiMainScreen` with pi-tui's own
// `Markdown` component, so the panel shows the answer the way the transcript
// shows an assistant message - tables, nested lists, syntax-highlighted code,
// the theme's colors - rather than a second and worse rendering of it.
//
// The screen is redrawn differentially: pi-tui rewrites the lines that changed
// and leaves the rest alone. That is what makes a streaming answer correct
// itself in place. The renderer this replaces was append-only, so the tail of
// every half-written line was dropped and never redrawn - the panel showed the
// answer up to its last newline and lost the rest.
//
// The viewer reads the answer file and the theme spec the parent wrote; it
// writes to the pane and nothing else.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";

import { TuiMainScreen } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { createMarkdownView } from "./markdown.mjs";
import { installThemeSpec } from "./theme.mjs";

/** How long to wait for the answer file to settle before redrawing. */
const DEBOUNCE_MS = 80;

/**
 * A write-only terminal.
 *
 * pi-tui's terminal interface also owns the keyboard, and this pane must not
 * take it: tmux keeps the keys so that copy mode and the mouse wheel scroll
 * the panel natively. Only the drawing half of the interface is implemented;
 * `start` is never called, so nothing ever reads stdin.
 */
function panelTerminal() {
	return {
		write: (data) => process.stdout.write(data),
		get columns() {
			return process.stdout.columns || 80;
		},
		get rows() {
			return process.stdout.rows || 24;
		},
		hideCursor: () => process.stdout.write("\x1b[?25l"),
		showCursor: () => process.stdout.write("\x1b[?25h"),
		clearLine: () => process.stdout.write("\x1b[K"),
		clearFromCursor: () => process.stdout.write("\x1b[J"),
		clearScreen: () => process.stdout.write("\x1b[2J\x1b[H"),
		moveBy: () => {},
		setTitle: () => {},
		setProgress: () => {},
		setProgramStatus: () => {},
		start: () => {},
		stop: () => {},
		drainInput: async () => {},
		kittyProtocolActive: false,
	};
}

/**
 * The theme the panel renders with.
 *
 * The spec the parent wrote is pi's own resolved theme. A panel left over
 * from an older version has no spec, and a spec that cannot be read is no
 * better than none: the viewer's own default is used in both cases, which is
 * the terminal's palette rather than the transcript's colors. The panel still
 * opens and still reads; only its colors differ.
 */
async function loadMarkdownTheme(themePath) {
	try {
		const spec = JSON.parse(await readFile(themePath, "utf8"));
		return installThemeSpec(spec);
	} catch {
		initTheme();
		return getMarkdownTheme();
	}
}

async function runViewer(answerPath, themePath) {
	const theme = await loadMarkdownTheme(themePath);
	const view = createMarkdownView(theme);
	const tui = new TuiMainScreen(panelTerminal());
	tui.addChild(view);

	// The pane's shell echoed the command that started this viewer, and the
	// answer belongs at the top of the panel rather than under it. Clearing
	// the scrollback too keeps the panel's history the answer's history.
	process.stdout.write("\x1b[2J\x1b[H\x1b[3J");

	const paint = async () => {
		let text;
		try {
			text = await readFile(answerPath, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return; // file replaced under us; the watch fires again
			throw error;
		}
		view.setText(text);
		tui.renderNow();
	};

	// A resize changes the layout, and with it the width every table and code
	// block is laid out at; pi-tui redraws the whole screen when it notices.
	process.stdout.on("resize", () => tui.renderNow());

	let timer;
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			paint().catch((error) => {
				console.error(`btw viewer paint failed: ${error?.message ?? error}`);
			});
		}, DEBOUNCE_MS);
	};
	watch(answerPath, schedule);
	await paint();
}

runViewer(process.argv[2], process.argv[3]).catch((error) => {
	console.error(`btw viewer failed: ${error?.message ?? error}`);
});
