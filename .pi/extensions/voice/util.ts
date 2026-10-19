/**
 * Text helpers shared by the voice modules.
 *
 * `firstLine` and `describeError` are both used by the recorder (its ssh
 * failure messages) and by transcription (its HTTP and network messages), so
 * they live here rather than as a second copy in each file — a duplicate is a
 * second place to fix the same bug.
 */

/** A warning sink: config loading and shortcut parsing both report through
 * one shape, so a warning cannot be reformatted (or dropped) in between. */
export type Warn = (message: string) => void;

/** The first non-blank line of a possibly multi-line message. */
export function firstLine(text: string): string {
	return text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}

/** An Error's message joined with its `cause` chain, for a one-line report. */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause: unknown = error.cause;
	if (cause === undefined || cause === null) return error.message;
	return `${error.message} (${cause instanceof Error ? cause.message : String(cause)})`;
}
