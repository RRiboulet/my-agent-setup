// repo-explorer/file-transcript.ts — the "print the file into the transcript"
// step: turning a `readFile` result into the custom message /explore sends, and
// rendering that message safely.
//
// Two surfaces, one string. `content` is what the model reads, so it carries the
// file's own bytes (tabs, line endings) with line numbers and a header naming
// the branch and path — the agent should see the file as it is. The terminal is
// a different consumer, and `fileMessageRenderer` draws it differently: every
// line is emitted directly (no Markdown, so a file full of ``` or `*` is not
// reinterpreted as markup and a stray list marker cannot restructure the view),
// truncated to the viewport width, and run through `sanitizeFileContent` first,
// because the file may be a log holding ESC or a lone `\r`. That keeps the
// injection class the browser's review found out of this surface too, without
// making the model read caret notation.

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FileRead } from "./git.ts";
import { sanitizeDisplay, sanitizeFileContent } from "./sanitize.ts";

/** `customType` of the transcript message a picked file produces. */
export const FILE_MESSAGE_TYPE = "repo-explorer-file";

export interface FileTranscriptDetails {
	/** The branch's menu label, for the header. */
	branch: string;
	/** Repo-relative path, raw — the value `readFile` was given. */
	path: string;
	/** readFile's truncation phrase, when a cap engaged. */
	note?: string;
	shownLines: number;
	totalLines: number;
	sizeBytes: number;
}

/**
 * Line-number the page, right-aligning to the widest number so the rule stays
 * straight. `readFile.text` is an exact prefix of the blob, so a single trailing
 * `""` is the blob's own terminator rather than a line of its own.
 */
export function numberLines(text: string): string {
	const lines = text.length > 0 ? text.split("\n") : [];
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
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
 * are the coloured lines; the body is verbatim after sanitization. The returned
 * component caches nothing, so a theme change is picked up on the next render.
 */
export const fileMessageRenderer: MessageRenderer<FileTranscriptDetails> = (message, _options, theme) => {
	const content = typeof message.content === "string" ? message.content : "";
	const hasNote = Boolean(message.details?.note);
	const lines = sanitizeFileContent(content).split("\n");
	return {
		render: (width: number): string[] =>
			lines.map((line, index) => {
				const styled =
					index === 0
						? theme.fg("accent", theme.bold(line))
						: index === 1 && hasNote
							? theme.fg("warning", line)
							: line;
				return truncateToWidth(styled, width, "…");
			}),
		invalidate: () => undefined,
	};
};
