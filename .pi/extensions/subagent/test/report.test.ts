// Unit tests for the child report contract (report.ts).
//
// These are the pure seams: the envelope parser and validator, the lenient
// resolution between a child's structured field and its text, the bounded copy
// that reaches `runs.json`, and the bounded artifact read. The lifecycle file
// beside this one proves the parent actually writes the artifact and settles.
//
// Risk covered: a child may run another branch's build, so every rejection must
// be a value rather than an exception, a compatible different version must be
// accepted with skew recorded, and a very long report must not enter the run
// index whole.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

import {
	CHILD_REPORT_VERSION,
	REPORT_FENCE,
	boundChildReport,
	buildChildTaskPrompt,
	buildRunReport,
	parseChildReportText,
	readReportHead,
	resolveChildReport,
	validateChildReport,
	writeReportArtifact,
	type ChildReport,
} from "../report.ts";

function validReport(overrides: Partial<Record<keyof ChildReport, unknown>> = {}): Record<string, unknown> {
	return {
		version: CHILD_REPORT_VERSION,
		status: "ok",
		summary: "the task is done",
		files: ["src/thing.ts"],
		commands: ["node --test"],
		unresolved: [],
		...overrides,
	};
}

/** A child's final message with a report block, as the instruction asks for. */
function withEnvelope(report: unknown, body = "I did the thing."): string {
	return `${body}\n\n\`\`\`${REPORT_FENCE}\n${JSON.stringify(report)}\n\`\`\`\n`;
}

function rejection(value: unknown): string {
	const read = validateChildReport(value);
	assert.equal(read.ok, false, `expected a rejection for ${JSON.stringify(value)}`);
	return read.ok ? "" : read.error;
}

test("a complete envelope parses with every documented field", () => {
	const read = parseChildReportText(withEnvelope(validReport()));
	assert.equal(read.ok, true);
	if (!read.ok) return;
	assert.deepEqual(read.report, validReport());
	assert.equal(read.skew, undefined);
});

test("a report without optional lists is accepted", () => {
	const read = validateChildReport({ version: 1, status: "blocked", summary: "need a decision" });
	assert.equal(read.ok, true);
	if (read.ok) {
		assert.equal(read.report.status, "blocked");
		assert.equal(read.report.files, undefined);
	}
});

test("the last report block in the text wins", () => {
	const text = `${withEnvelope(validReport({ summary: "the first quote" }))}\nThen a corrected conclusion.\n${withEnvelope(
		validReport({ summary: "the real answer" }),
	)}`;
	const read = parseChildReportText(text);
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.report.summary, "the real answer");
});

test("an unrelated JSON fence is not a report", () => {
	const read = parseChildReportText('Here is config:\n\n```json\n{"version":1,"status":"ok","summary":"not a report"}\n```\n');
	assert.equal(read.ok, false);
	if (!read.ok) assert.equal(read.reason, "missing");
});

test("plain text with no envelope is missing, not an error", () => {
	const read = parseChildReportText("I finished, but forgot the block.");
	assert.equal(read.ok, false);
	if (!read.ok) {
		assert.equal(read.reason, "missing");
		assert.match(read.error, /no subagent-report block/);
	}
});

test("an unterminated block is still read when its JSON is usable", () => {
	const text = `Done.\n\n\`\`\`${REPORT_FENCE}\n${JSON.stringify(validReport())}`;
	const read = parseChildReportText(text);
	assert.equal(read.ok, true);
});

test("invalid JSON in the block is malformed, not thrown", () => {
	const read = parseChildReportText(`\`\`\`${REPORT_FENCE}\n{"version": 1,\n\`\`\``);
	assert.equal(read.ok, false);
	if (!read.ok) {
		assert.equal(read.reason, "malformed");
		assert.match(read.error, /not valid JSON/);
	}
});

test("a non-object envelope is malformed", () => {
	const read = parseChildReportText(`\`\`\`${REPORT_FENCE}\n[]\n\`\`\``);
	assert.equal(read.ok, false);
	if (!read.ok) {
		assert.equal(read.reason, "malformed");
		assert.match(read.error, /must be a JSON object/);
	}
});

test("every required field is checked", () => {
	assert.match(rejection({ ...validReport(), version: undefined }), /version is missing or is not an integer/);
	assert.match(rejection({ ...validReport(), version: 1.5 }), /version is missing or is not an integer/);
	assert.match(rejection({ ...validReport(), status: "done" }), /status is "done"/);
	assert.match(rejection({ ...validReport(), summary: 42 }), /summary is missing or is not a string/);
});

test("optional lists must be arrays of strings", () => {
	for (const field of ["files", "commands", "unresolved"]) {
		assert.match(rejection({ ...validReport(), [field]: "one" }), new RegExp(`${field} must be an array of strings`));
		assert.match(rejection({ ...validReport(), [field]: [1] }), new RegExp(`${field} must be an array of strings`));
	}
});

test("a newer compatible version is accepted and records skew", () => {
	const read = validateChildReport(validReport({ version: CHILD_REPORT_VERSION + 1 }));
	assert.equal(read.ok, true);
	if (!read.ok) return;
	assert.equal(read.report.version, CHILD_REPORT_VERSION + 1);
	assert.deepEqual(read.skew, { writer: CHILD_REPORT_VERSION + 1, reader: CHILD_REPORT_VERSION });
});

test("an older compatible version is accepted and records skew", () => {
	const read = validateChildReport(validReport({ version: CHILD_REPORT_VERSION - 1 }));
	assert.equal(read.ok, true);
	if (read.ok) assert.deepEqual(read.skew, { writer: CHILD_REPORT_VERSION - 1, reader: CHILD_REPORT_VERSION });
});

test("an incompatible newer version is reported as skew, not thrown", () => {
	const detail = rejection(validReport({ version: CHILD_REPORT_VERSION + 1, summary: undefined }));
	assert.match(detail, /summary is missing/);
	assert.match(detail, new RegExp(`report version ${CHILD_REPORT_VERSION + 1}`));
	assert.match(detail, /different build/);
	const read = validateChildReport(validReport({ version: CHILD_REPORT_VERSION + 1, summary: undefined }));
	if (!read.ok) assert.equal(read.reason, "skew");
});

test("an incompatible current version stays malformed, without inventing skew", () => {
	const read = validateChildReport(validReport({ summary: undefined }));
	assert.equal(read.ok, false);
	if (!read.ok) {
		assert.equal(read.reason, "malformed");
		assert.doesNotMatch(read.error, /report version/);
	}
});

test("an absent report is missing, and a bad one is not mistaken for absent", () => {
	assert.equal((validateChildReport(undefined) as { reason?: string }).reason, "missing");
	assert.equal((validateChildReport(null) as { reason?: string }).reason, "malformed");
});

test("resolveChildReport prefers the structured field, then the text", () => {
	const fromField = resolveChildReport(
		validReport({ summary: "from the field" }),
		withEnvelope(validReport({ summary: "from the text" })),
	);
	assert.equal(fromField.ok, true);
	if (fromField.ok) assert.equal(fromField.report.summary, "from the field");

	const fromText = resolveChildReport({ version: 2, status: "ok" }, withEnvelope(validReport({ summary: "from the text" })));
	assert.equal(fromText.ok, true);
	if (fromText.ok) assert.equal(fromText.report.summary, "from the text");

	const neither = resolveChildReport(undefined, "no block here");
	assert.equal(neither.ok, false);
	if (!neither.ok) assert.equal(neither.reason, "missing");

	// A structured report that is present but unusable is the more informative
	// failure when the text has no usable block either.
	const badField = resolveChildReport({ version: 2, status: "ok" }, "no block here");
	assert.equal(badField.ok, false);
	if (!badField.ok) assert.equal(badField.reason, "skew");
});

test("boundChildReport clips a very long summary and list with pi's limits", () => {
	const huge = `${"x".repeat(DEFAULT_MAX_BYTES)}\n${"y".repeat(DEFAULT_MAX_BYTES)}`;
	const bounded = boundChildReport({
		version: 1,
		status: "ok",
		summary: huge,
		files: huge.split("\n"),
		commands: ["short"],
	});
	assert.equal(bounded.truncated, true);
	assert.ok(Buffer.byteLength(bounded.summary, "utf8") <= DEFAULT_MAX_BYTES);
	assert.equal(bounded.commands?.join("\n"), "short");
});

test("buildRunReport carries the pointer, head and a visible degradation", () => {
	const degraded = buildRunReport({
		artifactPath: "/run/report.md",
		head: { head: "the plain text", bytes: 4096, truncated: true },
		parsed: { ok: false, reason: "missing", error: "no block" },
	});
	assert.equal(degraded.artifactPath, "/run/report.md");
	assert.equal(degraded.artifactBytes, 4096);
	assert.equal(degraded.head, "the plain text");
	assert.equal(degraded.truncated, true);
	assert.equal(degraded.degradation, "no block");
	assert.equal(degraded.status, undefined);

	const accepted = buildRunReport({
		artifactPath: "/run/report.md",
		head: { head: "head", bytes: 10, truncated: false },
		parsed: validateChildReport(validReport({ version: 2 })),
	});
	assert.equal(accepted.status, "ok");
	assert.equal(accepted.summary, "the task is done");
	assert.deepEqual(accepted.files, ["src/thing.ts"]);
	assert.deepEqual(accepted.skew, { writer: 2, reader: CHILD_REPORT_VERSION });
	assert.equal(accepted.degradation, undefined);

	// A write failure is visible even when the envelope itself was usable.
	const unwritten = buildRunReport({
		artifactPath: "/run/report.md",
		head: { head: "head", bytes: 0, truncated: false },
		parsed: validateChildReport(validReport()),
		degradation: "the report artifact could not be written: EACCES",
	});
	assert.equal(unwritten.status, "ok");
	assert.match(unwritten.degradation ?? "", /could not be written/);
});

test("readReportHead reads a bounded head and reports the full artifact size", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-report-"));
	try {
		const file = path.join(dir, "report.md");
		const tail = "TAIL-MARKER-AT-THE-END";
		const line = `${"z".repeat(99)}\n`;
		const text = `${line.repeat(Math.ceil((DEFAULT_MAX_BYTES * 3) / line.length))}${tail}`;
		await writeReportArtifact(file, text);
		assert.equal(await readFile(file, "utf8"), text, "the artifact is the complete text, not the bounded head");

		const head = await readReportHead(file);
		assert.equal(head.bytes, Buffer.byteLength(text, "utf8"));
		assert.equal(head.truncated, true);
		assert.ok(Buffer.byteLength(head.head, "utf8") <= DEFAULT_MAX_BYTES);
		assert.ok(!head.head.includes(tail), "the parent must not hold the tail in the run index");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readReportHead leaves a short artifact whole", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-report-"));
	try {
		const file = path.join(dir, "report.md");
		await writeReportArtifact(file, "a short report\n");
		const head = await readReportHead(file);
		assert.equal(head.head, "a short report\n");
		assert.equal(head.bytes, Buffer.byteLength("a short report\n"));
		assert.equal(head.truncated, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the child task prompt carries the task and the envelope instruction", () => {
	const prompt = buildChildTaskPrompt("Fix the parser.");
	assert.match(prompt, /^# Delegated task\n\nFix the parser\./);
	assert.ok(prompt.includes(REPORT_FENCE));
	assert.ok(prompt.includes(`"version":${CHILD_REPORT_VERSION}`));
	assert.match(prompt, /files/);
	assert.match(prompt, /commands/);
	assert.match(prompt, /unresolved/);
});
