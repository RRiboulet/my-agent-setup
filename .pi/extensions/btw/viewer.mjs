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
// The viewer reads the answer file and the panel spec the parent wrote; it
// writes to the pane and nothing else.

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
 * Import a module by the path the parent resolved, or by its name.
 *
 * The parent resolves pi's packages where pi's own mapping applies; in a
 * spawned process a bare specifier only resolves when the package's own
 * `node_modules` has them, which an installed pi package does not. So the
 * path is used when there is one - and when the path does not work, the name
 * is tried, because a path that has gone stale (pi upgraded between the spec
 * being written and the viewer starting) should not take the panel down.
 */
async function importPi(specifier, entryPoint) {
	if (entryPoint) {
		try {
			return await import(pathToFileURL(entryPoint).href);
		} catch (error) {
			console.error(`btw viewer could not load ${entryPoint}: ${error?.message ?? error}`);
		}
	}
	return await import(specifier);
}

/**
 * The panel's setup: the theme it draws with, and where to find pi.
 *
 * A panel left over from an older version has no spec, and a spec that cannot
 * be read is no better than none: the panel falls back to the terminal's own
 * palette and to the bare specifiers, which is what works in a checkout whose
 * own `node_modules` has them. The panel still opens and still reads; only its
 * colors differ.
 */
async function loadPanelSetup(panelPath) {
	let spec;
	try {
		spec = JSON.parse(await readFile(panelPath, "utf8"));
	} catch {
		spec = undefined;
	}
	const entryPoints = spec?.entryPoints ?? {};
	const pitui = await importPi("@earendil-works/pi-tui", entryPoints.tui);
	const piThemeModule = await importPi("@earendil-works/pi-coding-agent", entryPoints.theme);
	let theme;
	try {
		theme = spec ? installThemeSpec(spec.theme, piThemeModule) : undefined;
	} catch (error) {
		// The panel would otherwise draw in the terminal's palette with
		// nothing said about it, which is the one failure a reader cannot
		// see for themselves.
		console.error(`btw viewer could not use your theme: ${error?.message ?? error}`);
		theme = undefined;
	}
	if (theme === undefined) {
		piThemeModule.initTheme();
		theme = piThemeModule.getMarkdownTheme();
	}
	return { pitui, theme };
}

/**
 * The panel hides the cursor while it draws; give it back when it stops.
 *
 * The pane is `remain-on-exit`, so a viewer that stops - a killed server, a
 * closed panel - would otherwise leave the panel with an invisible cursor.
 */
const restoreCursor = () => process.stdout.write("\x1b[?25h");
process.on("exit", restoreCursor);
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
	process.on(signal, () => {
		restoreCursor();
		process.exit(0);
	});
}

async function runViewer(answerPath, panelPath) {
	const { pitui, theme } = await loadPanelSetup(panelPath);
	const view = createMarkdownView(pitui.Markdown, theme);
	const tui = new pitui.TuiMainScreen(panelTerminal());
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
	process.stdout.on("resize", () => {
		try {
			tui.renderNow();
		} catch (error) {
			console.error(`btw viewer render failed: ${error?.message ?? error}`);
		}
	});

	let timer;
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			paint().catch((error) => {
				// The panel keeps its last good frame, and says what went
				// wrong. The answer keeps growing, so the next change tries
				// again - the failure is in the panel, not in the answer.
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
