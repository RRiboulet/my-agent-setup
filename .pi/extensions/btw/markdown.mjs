// A small Markdown-to-ANSI renderer for the /btw pane viewer.
//
// The pane is a plain pty: the viewer only writes and tmux keeps the keys, so
// scrolling stays native (copy mode, mouse wheel) exactly like the subagent
// attach views. Three consequences shape this renderer:
//
// 1. Line-oriented and 1:1 — every input line becomes exactly one output line
//    (no wrapping; the terminal wraps long lines). The pane's scrollback is
//    therefore the document itself.
// 2. Incremental-stable — a line's rendering depends only on the code-fence
//    state above it, never on lines below, so a line already printed is never
//    rendered differently as the answer grows. The viewer only ever appends.
// 3. Width-independent — no column math, so it cannot disagree with the pane.
//
// Deliberately unsupported: setext headings and 4-space indented code blocks
// (both would make an earlier line's style depend on a later one, breaking
// property 2), table reflow, and nested emphasis. LLMs answer with ATX
// headings and fenced code, so the covered subset is what answers contain.
//
// `gutter` (default off) prepends a dim line number to every line; a scrollbar
// could read the viewport back out of those numbers, but the pane ships
// without one, so a clean render is the default.

const RESET = "\x1b[0m";

/** Wrap `text` in one SGR sequence, or pass it through when color is off. */
function style(color, ...codes) {
	return color ? (text) => `\x1b[${codes.join(";")}m${text}${RESET}` : (text) => text;
}

/** A fence opener: ``` or ~~~ with an optional info string. */
const FENCE_OPEN = /^ {0,3}(```|~~~)[^\s`~]*\s*$/;
/** A fence closer: ``` or ~~~ alone (CommonMark allows a longer closing run). */
const FENCE_CLOSE = /^ {0,3}(```|~~~)\s*$/;

/**
 * Render the whole document. Equivalent to resuming from line 0 with no fence
 * open — the form the unit tests use.
 */
export function renderMarkdown(text, options = {}) {
	return renderFrom(text, 0, false, options).lines.join("\n");
}

/**
 * Render only the lines from `fromLine` onward, resuming with the fence state
 * the previous render ended with. Returns the rendered lines and the fence
 * state at the end, so a caller can keep appending as the document grows
 * without re-rendering (or re-reading) what it already printed.
 */
export function renderFrom(text, fromLine = 0, fenceOpen = false, options = {}) {
	const color = options.color !== false;
	const gutter = options.gutter === true;
	const s = {
		dim: style(color, 2),
		bold: style(color, 1),
		italic: style(color, 3),
		underline: style(color, 4),
		strike: style(color, 9),
		reverse: style(color, 7),
		heading1: style(color, 1, 97),
	};

	const lines = text.split("\n");
	const out = [];
	let inFence = fenceOpen;
	for (let i = fromLine; i < lines.length; i++) {
		const line = lines[i];
		// The gutter: a dim line number every line carries when `gutter` is on.
		const g = gutter ? `${s.dim(String(i + 1).padStart(4))} ` : "";
		if (inFence) {
			if (FENCE_CLOSE.test(line)) {
				out.push(`${g}${s.dim(line)}`);
				inFence = false;
			} else {
				out.push(line === "" ? g : `${g}${line}`);
			}
			continue;
		}
		if (FENCE_OPEN.test(line)) {
			out.push(`${g}${s.dim(line)}`);
			inFence = true;
			continue;
		}
		out.push(line === "" ? g : `${g}${classify(line, s)}`);
	}
	return { lines: out, fenceOpen: inFence };
}

/** The block-level style of one line outside a code fence. */
function classify(line, s) {
	const heading = line.match(/^( {0,3})(#{1,6})\s+(.*)$/);
	if (heading) {
		const text = inline(heading[3].trim(), s);
		if (heading[2].length === 1) return s.heading1(text);
		if (heading[2].length === 2) return s.bold(text);
		return s.dim(text);
	}
	const quote = line.match(/^>\s?(.*)$/);
	if (quote) return `${s.dim("│ ")}${inline(quote[1], s)}`;
	if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return s.dim("─".repeat(56));
	const task = line.match(/^( *)([-*+]) \[([ xX])\] (.*)$/);
	if (task) return `${task[1]}${s.dim(task[3] === " " ? "☐ " : "☑ ")}${inline(task[4], s)}`;
	const unordered = line.match(/^( *)([-*+]) (.*)$/);
	if (unordered) return `${unordered[1]}${s.dim("• ")}${inline(unordered[3], s)}`;
	const ordered = line.match(/^( *)(\d+)([.)]) (.*)$/);
	if (ordered) return `${ordered[1]}${s.dim(`${ordered[2]}${ordered[3]} `)}${inline(ordered[4], s)}`;
	// A table separator row (|---|---| or |:--|--:|); the pipe layout itself is
	// passed through untouched.
	if (/^ *\|?[\s:|-]+\|?$/.test(line) && line.includes("-")) return s.dim(line);
	// The usage footer the parent appends after the answer.
	if (/^(input +[\d,]+|cancelled|error:)/.test(line)) return s.dim(inline(line, s));
	return inline(line, s);
}

/** Inline spans: code, links, bold, italic, strike, escapes, HTML tags. */
function inline(text, s) {
	let out = text.replace(
		/<\/?(details|summary|br|hr|div|span|p|table|thead|tbody|tr|td|th|ul|ol|li|strong|em|code|pre|a|img|b|i|u|s|mark|sub|sup)\b[^>]*>/gi,
		"",
	);
	// Protect code spans and backslash escapes from the emphasis passes.
	const codes = [];
	out = out.replace(/`([^`]+)`/g, (_, code) => {
		codes.push(s.reverse(` ${code} `));
		return `\x00${codes.length - 1}\x00`;
	});
	const escapes = [];
	out = out.replace(/\\([\\`*_{}[\]()#+\-.!~>|_])/g, (_, char) => {
		escapes.push(char);
		return `\x01${escapes.length - 1}\x01`;
	});
	out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => linkify(alt, url, s));
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => linkify(label, url, s));
	out = out.replace(/\*\*([^*]+)\*\*/g, (_, x) => s.bold(x));
	out = out.replace(/__([^_]+)__/g, (_, x) => s.bold(x));
	out = out.replace(/\*([^*]+)\*/g, (_, x) => s.italic(x));
	out = out.replace(/\b_([^_]+)_\b/g, (_, x) => s.italic(x));
	out = out.replace(/~~([^~]+)~~/g, (_, x) => s.strike(x));
	out = out.replace(/\x01(\d+)\x01/g, (_, i) => escapes[Number(i)]);
	out = out.replace(/\x00(\d+)\x00/g, (_, i) => codes[Number(i)]);
	return out;
}

/** `[label](url)` → underlined label and the dim url beside it. */
function linkify(label, url, s) {
	return `${s.underline(label)}${s.dim(` (${url})`)}`;
}
