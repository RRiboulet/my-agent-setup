// repo-explorer/sanitize.ts — the display boundary for anything that came out
// of a repository.
//
// Git path names may contain any byte except NUL and `/`, and a file's bytes
// can contain anything at all, so both a hostile branch and an ordinary log
// file can carry C0/C1 control bytes. A terminal executes those: an escape can
// wipe the screen, overwrite the clipboard (OSC 52), set the window title, or —
// a lone `\r` — walk the cursor back over what was already drawn. pi-tui's
// `truncateToWidth` deliberately passes recognized escape sequences through and
// prices C0 bytes at zero width, so nothing downstream strips them, and
// `visibleWidth` cannot see them either: a width assertion is blind to the
// whole class.
//
// So every repository-derived string is sanitized *for display* here, at the
// point it becomes pixels. The byte-faithful original is never rewritten: the
// browser keeps `item.value` as the real path, and the transcript message keeps
// the file's real text in its model-facing `content`; only what the terminal
// draws passes through this file.

/**
 * Code points in `keep` are shown as-is; every other C0/C1/DEL code point — and
 * any reordering format character — becomes visible text.
 */
function sanitize(text: string, keep: string): string {
	let safe = "";
	for (const character of text) {
		if (keep.includes(character)) {
			safe += character;
			continue;
		}
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f) safe += "^?";
		else if (code < 0x20) safe += `^${String.fromCharCode(code + 64)}`;
		else if ((code >= 0x80 && code <= 0x9f) || isReorderingFormat(code)) safe += `\\u${code.toString(16).padStart(4, "0")}`;
		else safe += character;
	}
	return safe;
}

/**
 * Code points that can reorder or mask what follows while leaving no visible
 * mark: the bidi embeddings, overrides and isolates, the bidi marks
 * (LRM/RLM/ALM), and the BOM. They are valid UTF-8 — the mojibake tripwire does
 * not fire — and pi-tui prices them at zero width, so a width assertion cannot
 * see them either. In a bidi-capable terminal a filename or a code line
 * containing U+202E displays reversed while its bytes say something else, and a
 * copy gesture carries the invisible characters along. `\uXXXX` notation keeps
 * them countable and inert.
 *
 * Deliberately NOT in this set: ZWJ/ZWNJ/ZWSP (U+200B–U+200D), the soft hyphen,
 * the invisible operators and the tag characters. They are invisible but cannot
 * reorder anything, and ZWJ/ZWNJ legitimately shape text (emoji sequences,
 * Indic scripts), so notating them would visibly degrade the file the user
 * asked to read.
 */
function isReorderingFormat(code: number): boolean {
	return (
		code === 0x061c || // Arabic letter mark
		code === 0x200e || // left-to-right mark
		code === 0x200f || // right-to-left mark
		(code >= 0x202a && code <= 0x202e) || // LRE/RLE/PDF/LRO/RLO
		(code >= 0x2066 && code <= 0x2069) || // LRI/RLI/FSI/PDI
		code === 0xfeff // BOM / zero-width no-break space
	);
}

/**
 * Labels, breadcrumbs and echo lines: every control byte becomes caret notation
 * (`\x1b` → `^[`, `\n` → `^J`), so a field that must stay one line does.
 */
export function sanitizeDisplay(text: string): string {
	return sanitize(text, "");
}

/**
 * File bodies: tab and newline are the file's own formatting and stay, CRLF is
 * normalized (a trailing `\r` would walk the cursor back to column 0), and every
 * other control byte is caret-notated.
 */
export function sanitizeFileContent(text: string): string {
	return sanitize(text.replace(/\r\n/g, "\n"), "\t\n");
}
