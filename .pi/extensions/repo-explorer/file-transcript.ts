// repo-explorer/file-transcript.ts — the "print the file into the transcript"
// step: turning a `readFile` result into the custom message /explore sends, and
// rendering that message safely.
//
// Two surfaces, one string. `content` is what the model reads, so it carries the
// file's own bytes (tabs and line structure) with line numbers and a header
// naming the branch and path — the agent should see the file as it is. The
// terminal is a different consumer, and `fileMessageRenderer` draws it
// differently: every line is emitted directly (no Markdown, so a file full of
// ``` or `*` is not reinterpreted as markup and a stray list marker cannot
// restructure the view), truncated to the viewport width, and run through
// `sanitizeFileContent` first, because the file may be a log holding ESC or a
// lone `\r`. That keeps the injection class the browser's review found out of
// this surface too, without making the model read caret notation.
//
// Two limits are recorded rather than solved. Every view appends up to a page
// (2000 lines / 256 KiB) to the session as a user-role message, so N views
// accumulate N pages with no total budget or dedup — compaction is the only
// relief. And the safety of a *replayed* message depends on this renderer
// loading: pi's CustomMessageComponent falls back to the plain Markdown
// renderer, which neither sanitizes nor avoids reinterpreting markup, if the
// registered renderer is missing or throws. The renderer must therefore stay
// total (see its test).

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FileRead } from "./git.ts";
import { sanitizeDisplay, sanitizeFileContent } from "./sanitize.ts";

/** `customType` of the transcript message a picked file produces. */
export const FILE_MESSAGE_TYPE = "repo-explorer-file";

export interface FileTranscriptDetails {
	/** The branch's menu label, for the header. */
	branch: string;
	/** Repo-relative path, raw — the value `readFile` was given, and the handle a later "re-open" or "copy path" needs. */
	path: string;
	/** readFile's truncation phrase, when a cap engaged. Raw, for the record; `content` carries the sanitized copy that is actually shown. */
	note?: string;
	shownLines: number;
	totalLines: number;
	sizeBytes: number;
}

/**
 * Line-number the page, right-aligning to the widest number so the rule stays
 * straight. `readFile.text` is an exact prefix of the blob, so a single trailing
 * `""` is the blob's own terminator rather than a line of its own.
 *
 * CRLF is normalized before splitting, which is not cosmetic: the terminator
 * pop consumes the `\n` of a final `\r\n`, and the orphaned `\r` would then
 * survive the renderer's `\r\n` normalization and show as a `^M` on the last
 * line of every Windows-authored file. Doing it here (rather than only in the
 * renderer) keeps `numberLines` correct on its own; the model-facing `content`
 * consequently carries LF endings, a fidelity concession this display rule is
 * worth.
 */
export function numberLines(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	const width = String(lines.length).length;
	return lines.map((line, index) => `${String(index + 1).padStart(width)} │ ${line}`).join("\n");
}

/**
 * Build the message content and its display details.
 *
 * Layout, relied on by the renderer below: line 0 is the banner, line 1 is the
 * truncation note when there is one, then a blank line, then the numbered body.
 */
export function formatFileTranscript(
	read: FileRead,
	branchLabel: string,
	path: string,
): { content: string; details: FileTranscriptDetails } {
	const banner = `Explore ${sanitizeDisplay(branchLabel)} › ${sanitizeDisplay(path)}`;
	// readFile builds `note`, but it is still a repo-derived string and this is
	// the boundary that owns making one safe to show.
	const note = read.note ? sanitizeDisplay(read.note) : undefined;
	const header = [banner, ...(note ? [note] : [])].join("\n");
	const body = numberLines(read.text);
	return {
		content: `${header}\n\n${body.length > 0 ? body : "(empty file)"}`,
		details: {
			branch: branchLabel,
			path,
			note: read.note,
			shownLines: read.shownLines,
			totalLines: read.totalLines,
			sizeBytes: read.sizeBytes,
		},
	};
}

/**
 * Render the message as plain, width-bounded lines.
 *
 * The header (line 0) and the truncation note (line 1, only when there is one)
 * are the coloured lines; the body is verbatim after sanitization.
 *
 * The width-truncated lines are cached per width. pi-tui re-renders the whole
 * transcript on every paint (no virtualization), and every numbered body line
 * carries the `│` separator, which puts it off pi-tui's ASCII fast path and into
 * grapheme segmentation — up to LINE_CAP lines, per viewed file, per frame.
 * `invalidate` drops the cache, so a theme change (which rebuilds this
 * component) still takes effect.
 */
export const fileMessageRenderer: MessageRenderer<FileTranscriptDetails> = (message, _options, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const hasNote = Boolean(message.details?.note);
	const lines = sanitizeFileContent(content).split("\n");
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render: (width: number): string[] => {
			if (cachedWidth === width && cachedLines) return cachedLines;
			cachedWidth = width;
			cachedLines = lines.map((line, index) => {
				const styled =
					index === 0
						? theme.fg("accent", theme.bold(line))
						: index === 1 && hasNote
							? theme.fg("warning", line)
							: line;
				return truncateToWidth(styled, width, "…");
			});
			return cachedLines;
		},
		invalidate: () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
};
