// Unit tests for the child→parent result protocol (result.ts).
//
// These are the table the watcher's retry policy stands on. The lifecycle suite
// exercises the paths a run actually takes; this file pins every rejection and
// acceptance rule directly, including the branches a harness cannot reach
// (a non-object top level, a missing version, a non-finite finishedAt).
//
// Risk covered: result.json is spoken across extension versions, so the reader
// must reject an unusable shape with a *value* (never throw) and accept a usable
// one whose version it does not recognise. The version is advisory by design —
// it explains a failure, it does not gate a success.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { CHILD_RESULT_VERSION, parseChildResult, readChildResultFile, validateChildResult } from "../result.ts";

const FINISHED_AT = 1_700_000_000_000;

/** A complete, well-formed result. Every rejection test starts from this shape. */
function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { version: CHILD_RESULT_VERSION, status: "completed", output: "the answer", finishedAt: FINISHED_AT, ...overrides };
}

/** Assert a value is rejected, and return the detail for a message assertion. */
function rejection(value: unknown): string {
	const read = validateChildResult(value);
	assert.equal(read.ok, false, `expected a rejection for ${JSON.stringify(value)}`);
	assert.equal(read.ok ? undefined : read.reason, "invalid");
	return read.ok ? "" : (read.error ?? "");
}

test("a complete v1 result validates", () => {
	const read = validateChildResult(validResult({ error: "boom", sessionFile: "/tmp/s.jsonl" }));
	assert.equal(read.ok, true);
	if (!read.ok) return;
	assert.equal(read.result.status, "completed");
	assert.equal(read.result.output, "the answer");
	assert.equal(read.result.error, "boom");
	assert.equal(read.result.sessionFile, "/tmp/s.jsonl");
	assert.equal(read.result.finishedAt, FINISHED_AT);
});

test("an empty output is valid: a failed child may have no text", () => {
	const read = validateChildResult(validResult({ status: "failed", output: "" }));
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.result.output, "");
});

test("a complete result from a newer protocol version validates and keeps its version", () => {
	// The shape is the gate, not the version: this parent understands everything
	// it needs, so an answer from a newer build is collected, not discarded.
	const read = validateChildResult(validResult({ version: 2 }));
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.result.version, 2);
});

test("a missing version is tolerated when the shape is complete", () => {
	// The writer always sets it; the reader does not depend on it for success.
	const { version: _dropped, ...withoutVersion } = validResult();
	const read = validateChildResult(withoutVersion);
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.result.version, CHILD_RESULT_VERSION);
});

test("unknown extra fields are ignored", () => {
	const read = validateChildResult(validResult({ futureField: { nested: true } }));
	assert.equal(read.ok, true);
});

test("a shape failure on a different version names the skew as the likely cause", () => {
	// The one place the version earns its keep: explaining a rejection.
	const detail = rejection(validResult({ version: 2, output: undefined }));
	assert.match(detail, /output is missing or is not a string/);
	assert.match(detail, /protocol version 2/);
	assert.match(detail, /different build of this extension/);
});

test("a shape failure on this version does not invent a skew", () => {
	const detail = rejection(validResult({ output: undefined }));
	assert.match(detail, /output is missing or is not a string/);
	assert.doesNotMatch(detail, /protocol version/);
});

test("a non-object top level is rejected", () => {
	for (const value of [null, undefined, [], "result", 42, true]) {
		assert.match(rejection(value), /result must be a JSON object/);
	}
});

test("an unknown status is rejected", () => {
	assert.match(rejection(validResult({ status: "done" })), /status is "done"/);
	assert.match(rejection(validResult({ status: undefined })), /not "completed" or "failed"/);
	assert.match(rejection(validResult({ status: 1 })), /not "completed" or "failed"/);
});

test("a missing or non-string output is rejected", () => {
	assert.match(rejection(validResult({ output: undefined })), /output is missing/);
	assert.match(rejection(validResult({ output: null })), /output is missing/);
	assert.match(rejection(validResult({ output: ["chunks"] })), /output is missing/);
});

test("every optional string field must be a string when present", () => {
	// These feed `??` and `.trim()` in finalizeRun: a wrong type either throws in
	// the watch tick or is persisted as wrong data.
	for (const field of ["error", "stopReason", "sessionFile", "provider", "model", "thinking"]) {
		const detail = rejection(validResult({ [field]: 42 }));
		assert.match(detail, new RegExp(`${field} is not a string`), `field ${field} must be validated`);
	}
});

test("finishedAt must be a finite number", () => {
	for (const value of [undefined, null, "1700000000000", Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.match(rejection(validResult({ finishedAt: value })), /finishedAt is missing or is not a finite number/);
	}
});

test("parseChildResult reports bytes that are not JSON", () => {
	const read = parseChildResult('{"version": 1, "status": "completed", "outp');
	assert.equal(read.ok, false);
	if (read.ok) return;
	assert.equal(read.reason, "invalid");
	// No version can be read from bad bytes, so there is no skew to name.
	assert.match(read.error ?? "", /not valid JSON/);
});

test("parseChildResult validates what it parses", () => {
	const read = parseChildResult(JSON.stringify(validResult({ status: "nope" })));
	assert.equal(read.ok, false);
	if (!read.ok) assert.match(read.error ?? "", /not "completed" or "failed"/);
});

test("readChildResultFile distinguishes a missing file from an unreadable path", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-result-"));
	try {
		const file = path.join(dir, "result.json");
		// Not written yet: the ordinary "still running" state.
		assert.deepEqual(await readChildResultFile(file), { ok: false, reason: "missing" });

		// A directory in the file's place is there, and will never become a result.
		await mkdir(file);
		const unreadable = await readChildResultFile(file);
		assert.equal(unreadable.ok, false);
		if (!unreadable.ok) {
			assert.equal(unreadable.reason, "invalid");
			assert.match(unreadable.error ?? "", /could not be read/);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readChildResultFile parses a real file", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-result-"));
	try {
		const file = path.join(dir, "result.json");
		await writeFile(file, `${JSON.stringify(validResult({ output: "from disk" }))}\n`, "utf8");
		const read = await readChildResultFile(file);
		assert.equal(read.ok, true);
		if (read.ok) assert.equal(read.result.output, "from disk");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
