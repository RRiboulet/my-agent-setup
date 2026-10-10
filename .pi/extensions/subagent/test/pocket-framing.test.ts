// Unit tests for pocket's JSONL framing.
//
// Node's own readline splits on U+2028 and U+2029 as well as \n. Both are legal
// inside a JSON string — a diff of a JavaScript file that happens to contain one
// is a routine occurrence — so readline would cut a perfectly valid JSON-RPC
// frame in half and report a parse failure on garbage. `splitFrames` deliberately
// knows about one separator only, and these tests are the ones that notice if
// that is ever "simplified" back.
//
// The second risk is the carry: the child's stdout arrives in whatever-sized
// chunks the OS offers, so a frame routinely spans a boundary. Dropping or
// duplicating a byte there is indistinguishable from a corrupt protocol.

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitFrames } from "../../pocket/rpc.ts";

/** Convenience: feed a whole string and return the frames plus the carry. */
function splitAll(text: string): { frames: string[]; carry: string } {
	const result = splitFrames(text, "");
	return result;
}

test("a complete line is one frame without its newline", () => {
	assert.deepEqual(splitAll('{"a":1}\n').frames, ['{"a":1}']);
	assert.equal(splitAll('{"a":1}\n').carry, "");
});

test("a partial line is carried, not guessed at", () => {
	const first = splitFrames('{"a":', "");
	assert.equal(first.carry, '{"a":');
	assert.deepEqual(first.frames, []);
	// The rest of the line is joined to the carry before it is framed, so what
	// comes back is the whole frame, not the fragment that arrived second.
	const second = splitFrames("1}\n", first.carry);
	assert.equal(second.carry, "");
	assert.deepEqual(second.frames, ['{"a":1}']);
});

test("U+2028 and U+2029 inside a JSON string do not end a frame", () => {
	// Line and paragraph separators are legal in JSON strings and are the exact
	// case readline gets wrong. A frame containing one must survive whole.
	const payload = JSON.stringify({ text: "before\u2028after\u2029end" });
	const result = splitAll(`${payload}\n`);
	assert.deepEqual(result.frames, [payload]);
	assert.equal(JSON.parse(result.frames[0]).text, "before\u2028after\u2029end");
});

test("several lines in one chunk all come out", () => {
	assert.deepEqual(splitAll('{"n":1}\n{"n":2}\n{"n":3}\n').frames, ['{"n":1}', '{"n":2}', '{"n":3}']);
});

test("blank lines are dropped", () => {
	assert.deepEqual(splitAll('\n{"n":1}\n\n{"n":2}\n').frames, ['{"n":1}', '{"n":2}']);
	assert.deepEqual(splitAll("\n\n").frames, []);
});

test("a trailing line stays in the carry until its newline arrives", () => {
	const first = splitFrames('{"n":1}\n{"n":', "");
	assert.equal(first.carry, '{"n":');
	assert.deepEqual(first.frames, ['{"n":1}']);
	const second = splitFrames("2}\n", first.carry);
	assert.equal(second.carry, "");
	assert.deepEqual(second.frames, ['{"n":2}']);
});

test("CRLF framing does not leave a carriage return inside a frame", () => {
	assert.deepEqual(splitAll('{"n":1}\r\n{"n":2}\r\n').frames, ['{"n":1}', '{"n":2}']);
});

test("a lone CR is part of the payload, not a separator", () => {
	// Only \n is a separator. A carriage return inside a JSON string stays in
	// the data, which is what makes this framing predictable to re-split when a
	// stream is resumed across a reconnect.
	const payload = JSON.stringify({ text: "a\rb" });
	assert.deepEqual(splitAll(`${payload}\n`).frames, [payload]);
});

test("a chunk with no newline at all is entirely carry", () => {
	const result = splitFrames("nothing here yet", "");
	assert.equal(result.carry, "nothing here yet");
	assert.deepEqual(result.frames, []);
});

test("re-splitting every byte one at a time returns the same frames", () => {
	// The strongest form of the carry test: the frames must not depend on how
	// the OS chunked the stream, so drip one character at a time and compare.
	const text = '{"a":1}\n{"b":"x\\ny"}\n{"c":3}\n';
	const perByte: string[] = [];
	let carry = "";
	for (const character of text) {
		const result = splitFrames(character, carry);
		carry = result.carry;
		perByte.push(...result.frames);
	}
	assert.equal(carry, "");
	const whole = splitAll(text).frames;
	assert.deepEqual(perByte, whole);
});
