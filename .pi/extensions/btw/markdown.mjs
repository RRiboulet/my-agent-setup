// The panel's Markdown rendering: pi-tui's own `Markdown` component.
//
// This used to be a hand-rolled line-oriented renderer, which could not
// render a table, a nested list or a syntax-highlighted code block - the
// answer looked like markup the model had written down rather than something
// rendered. pi-tui's `Markdown` is the component pi's own TUI renders an
// assistant message with, so using it makes the panel the transcript's
// rendering rather than a second, worse one.
//
// Two properties of that component matter here:
//
// 1. It lays the document out at a width, so the panel is as wide as its
//    pane and reflows when the pane is resized.
// 2. It is a `Component`, so pi-tui's `TuiMainScreen` can redraw the panel
//    differentially: only the lines that changed are rewritten, which is what
//    lets a streaming answer correct the tail of a half-written line instead
//    of dropping it.
//
// pi-tui's `Markdown` class is passed in rather than imported: the panel runs
// in its own process, where a bare specifier does not resolve (see
// `entry-points.mjs`).

/** The padding pi gives an assistant message's Markdown. */
const PADDING_X = 1;
const PADDING_Y = 0;

/**
 * A Markdown view over one document: `setText` replaces the document and
 * `render` lays it out at a width.
 *
 * The component is long-lived on purpose - pi-tui caches the parsed document
 * and the layout, so replacing the text is cheap where building a new
 * component for every paint would not be.
 */
export function createMarkdownView(Markdown, theme) {
	return new Markdown("", PADDING_X, PADDING_Y, theme);
}
