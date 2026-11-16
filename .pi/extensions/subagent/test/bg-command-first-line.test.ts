// Boundary pins for `commandFirstLine` (`bg/store.ts`), the one projection of a
// job's command that every `bg` message shows: `start`'s answer, `status`'s
// listing, `logs`, and the settle notice.
//
// Risk covered: the cap is what keeps one long command from pushing a listing off
// the screen, and it fails quietly in both directions — off by one and nothing is
// truncated, or the ellipsis is appended on top of the full limit and the line is
// one character wider than every caller budgets for. So the exact boundary is
// pinned: a command of exactly the limit is returned untouched, one character more
// is cut to `maxLength - 1` plus one ellipsis character (not three dots), giving
// exactly `maxLength`.
//
// The second behaviour is the one a heredoc depends on: leading whitespace-only
// lines are skipped, so a command that opens with a newline still shows its first
// real line rather than nothing. Trimming happens before the cap, which is checked
// here too, because a line padded past the limit would otherwise be truncated for
// punctuation it does not display.
//
// What is deliberately NOT pinned: the slice counts UTF-16 code units, not
// grapheme clusters, so a long command of astral-plane characters can be cut
// mid-pair. That is a known limit of the implementation, not a claim of this test,
// and every command the tool sees is ASCII shell text.

import assert from "node:assert/strict";
import { test } from "node:test";

import { commandFirstLine } from "../../bg/store.ts";

/** The cap every `bg` surface relies on when it does not pass one. */
const LIMIT = 160;

test("a command of exactly the limit is returned untouched", () => {
	const command = `${"e".repeat(LIMIT - 4)}ZEND`;
	assert.equal(command.length, LIMIT);

	const shown = commandFirstLine(command);
	assert.equal(shown, command, "the limit itself is inside the limit");
	assert.doesNotMatch(shown, /…/);
	assert.equal(shown.length, LIMIT);
});

test("one character over the limit is cut to maxLength - 1 plus one ellipsis", () => {
	const command = `${"e".repeat(LIMIT - 4)}ZEND!`;
	assert.equal(command.length, LIMIT + 1);

	const shown = commandFirstLine(command);
	const expected = `${"e".repeat(LIMIT - 4)}ZEN…`;
	assert.equal(shown, expected, "keeps the first maxLength - 1 characters, not the last");
	assert.equal(shown.length, LIMIT, "the ellipsis fits inside the cap rather than extending it");
	assert.ok(shown.endsWith("…"), "one ellipsis character, not '...'");
	assert.ok(!shown.includes("!"), "the character past the boundary is dropped");
});

test("whitespace-only leading lines are skipped, so a heredoc shows its first real line", () => {
	const command = "\n   \n\t\ncat <<'EOF' > notes.txt\nfirst body line\nEOF\n";
	assert.equal(commandFirstLine(command), "cat <<'EOF' > notes.txt");
});

test("the first real line is trimmed before the cap applies", () => {
	const padded = `   ${"e".repeat(LIMIT)}   `;
	assert.equal(commandFirstLine(padded), "e".repeat(LIMIT), "padding is removed, then the limit is tested");
});

test("a command of nothing but whitespace has no first line", () => {
	assert.equal(commandFirstLine(""), "(empty command)");
	assert.equal(commandFirstLine(" \n\t\n  \n"), "(empty command)");
});

test("the cap follows maxLength when a caller passes one", () => {
	assert.equal(commandFirstLine("abcdef", 6), "abcdef");
	assert.equal(commandFirstLine("abcdefg", 6), "abcde…");
});
