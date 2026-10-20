// The panel's theme: pi's own theme, carried into the viewer process.
//
// pi's TUI renders Markdown with `getMarkdownTheme()`, which reads the live
// theme instance out of pi's theme module. The viewer runs in its own process
// (the tmux pane), so it has no theme of its own: `initTheme(name)` would
// rebuild one from the theme file, which is exact for a named theme but NOT
// for the generated `system` theme - that one is built from the colors the
// terminal reported, and only pi asked the terminal.
//
// So the parent resolves the theme it is using right now and hands the
// resolved colors to the viewer, which rebuilds a `Theme` from them and then
// renders through the same `getMarkdownTheme()` the TUI uses. The panel is
// then the transcript's own colors, not an approximation of them.

import { Theme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { colorToHex } from "@earendil-works/pi-tui";

/**
 * pi's theme module keeps the live theme on `globalThis` under this symbol, so
 * that every copy of the module (node's ESM loader and jiti) shares one
 * instance. The viewer installs its rebuilt theme under the same symbol, which
 * is what makes `getMarkdownTheme()` - and the syntax highlighting behind it -
 * use the parent's colors.
 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
/** The symbol pi used before the rename; pi's own `setGlobalTheme` sets both. */
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

/**
 * The theme the panel renders with, in the form the viewer can rebuild.
 *
 * Every token's resolved color travels, not just the markdown ones: the
 * syntax highlighting inside a code block reads the syntax tokens, and a
 * theme that renders the panel's headings in the transcript's colors but its
 * code in another theme's would not be the transcript's colors.
 *
 * `colors` holds every token, foreground and background alike; pi's `Theme`
 * constructor splits them by slot itself, so the split is not repeated here.
 */
export function buildThemeSpec(theme) {
	const colors = {};
	for (const [token, color] of Object.entries(theme.colors)) {
		colors[token] = colorToHex(color);
	}
	return { name: theme.name ?? "system", mode: theme.getColorMode(), colors };
}

/**
 * Rebuild pi's theme from a spec, install it as the live theme, and return the
 * Markdown theme the TUI renders assistant messages with.
 *
 * The installation is the point: `getMarkdownTheme()` reads the live theme
 * through pi's own proxy, so installing the rebuilt theme is what makes the
 * panel's Markdown - and the code highlighting inside it - come out in the
 * parent's colors.
 */
export function installThemeSpec(spec) {
	const theme = new Theme(spec.colors, {}, spec.mode, { name: spec.name });
	globalThis[THEME_KEY] = theme;
	globalThis[THEME_KEY_OLD] = theme;
	return getMarkdownTheme();
}
