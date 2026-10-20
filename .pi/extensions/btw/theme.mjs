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

/** The escape a palette index is drawn with. */
const INDEXED_ESCAPE = /^\x1b\[(?:38|48);5;(\d+)m$/;
/** The escape a truecolor value is drawn with. */
const TRUECOLOR_ESCAPE = /^\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m$/;
/** The SGR 2 that marks a faint token. */
const FAINT = "\x1b[2m";
/** What a token the theme leaves to the terminal is drawn with. */
const DEFAULT_FOREGROUND = "\x1b[39m";
const DEFAULT_BACKGROUND = "\x1b[49m";

/**
 * The color value an escape stands for, or "" for the terminal's own default.
 *
 * pi's `Theme` takes color *values* - a hex string or a palette index - and
 * turns them into escape sequences. The panel is handed values, so that a
 * palette index stays an index: a terminal with a palette of its own draws
 * index 5 in its own magenta, and a hex would pin the standard one.
 *
 * Reading the value back out of the escape the theme opens the token with is
 * exact. The theme's resolved colour map is not: it mixes a faint token's
 * colour toward the background, so a value taken from there would be faded
 * twice - once by the mix, and once by the SGR 2 the theme draws it with.
 */
function colorValueFromAnsi(ansi, defaultEscape) {
	if (ansi === defaultEscape) return "";
	const indexed = INDEXED_ESCAPE.exec(ansi);
	if (indexed) return Number(indexed[1]);
	const truecolor = TRUECOLOR_ESCAPE.exec(ansi);
	if (truecolor) {
		const [, r, g, b] = truecolor;
		return `#${[r, g, b].map((channel) => channel.padStart(2, "0")).join("")}`;
	}
	return undefined;
}

/**
 * The colour values, and the faint tokens, a theme's tokens stand for.
 *
 * Every token travels, not just the markdown ones: the syntax highlighting
 * inside a code block reads the syntax tokens, and a theme that renders the
 * panel's headings in the transcript's colours but its code in another
 * theme's would not be the transcript's colours.
 */
export function themeTokenValues(theme) {
	const colors = {};
	const dim = [];
	for (const token of Object.keys(theme.colors)) {
		// A token is in exactly one slot, and the other slot refuses it.
		let ansi;
		let foreground;
		try {
			ansi = theme.getFgAnsi(token);
			foreground = true;
		} catch {
			try {
				ansi = theme.getBgAnsi(token);
				foreground = false;
			} catch {
				// A token in neither slot is not drawn by the theme, so there
				// is nothing to carry over. The panel's theme falls back to
				// pi's own default for it.
				continue;
			}
		}
		const faint = ansi.endsWith(FAINT);
		const color = faint ? ansi.slice(0, -FAINT.length) : ansi;
		const value = colorValueFromAnsi(color, foreground ? DEFAULT_FOREGROUND : DEFAULT_BACKGROUND);
		if (value === undefined) continue;
		colors[token] = value;
		if (faint && foreground) dim.push(token);
	}
	return { colors, dim };
}

/**
 * The theme the panel renders with, in the form the viewer can rebuild.
 *
 * `colors` holds every token, foreground and background alike; pi's `Theme`
 * constructor splits them by slot itself, so the split is not repeated here.
 */
export function buildThemeSpec(theme, options = {}) {
	const { colors, dim } = themeTokenValues(theme);
	return {
		name: theme.name ?? "system",
		mode: theme.getColorMode(),
		colors,
		dim,
		// The indent the transcript gives a code block. Left out when the
		// setting is at pi-tui's own default, which is what it is then.
		codeBlockIndent: options.codeBlockIndent,
	};
}

/**
 * Rebuild pi's theme from a spec, install it as the live theme, and return the
 * Markdown theme the TUI renders assistant messages with.
 *
 * The installation is the point: `getMarkdownTheme()` reads the live theme
 * through pi's own proxy, so installing the rebuilt theme is what makes the
 * panel's Markdown - and the code highlighting inside it - come out in the
 * parent's colours.
 *
 * pi's theme module is passed in rather than imported: the panel runs in its
 * own process, where a bare specifier does not resolve (see
 * `entry-points.mjs`).
 */
export function installThemeSpec(spec, piThemeModule) {
	const { Theme, getMarkdownTheme } = piThemeModule;
	const theme = new Theme(spec.colors, {}, spec.mode, { dim: spec.dim, name: spec.name });
	globalThis[THEME_KEY] = theme;
	globalThis[THEME_KEY_OLD] = theme;
	const markdownTheme = getMarkdownTheme();
	// pi's theme module reads the live theme through a proxy keyed by a symbol
	// it owns. If that symbol ever moves, the install above is a no-op and the
	// panel would quietly draw in whatever theme pi happens to have; the probe
	// turns that into a fallback instead.
	if (markdownTheme.heading("x") !== theme.fg("mdHeading", "x")) {
		throw new Error("the panel's theme did not take effect");
	}
	if (spec.codeBlockIndent !== undefined) markdownTheme.codeBlockIndent = spec.codeBlockIndent;
	return markdownTheme;
}
