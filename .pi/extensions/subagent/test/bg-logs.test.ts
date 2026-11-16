// Behaviour pins for `bg logs` and for the log cap (ticket 03).
//
// Risk covered: a log reader that returns the whole log (a 5000-line test suite
// would bury the session), one that re-orders the two streams, one that refuses a
// running job (the only interesting case), and — the one with no visible symptom
// until the disk is full — a cap that never applies, applies twice per tick, or
// leaves two markers behind. The cap is checked both on its own (a file, three
// calls) and through the real watcher driving a real job, because "bounded under
// a running process" is the claim, and a unit test cannot make it.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	BG_LOG_CAP_BYTES,
	BG_LOG_READ_WINDOW_BYTES,
	enforceLogCap,
	logCapMarker,
	logWasCapped,
	readLogTail,
} from "../../bg/logs.ts";
import { withBgHarness, type BgToolResult } from "./bg-harness.ts";
import { waitFor } from "./helpers.ts";

function jobOf(result: BgToolResult): Record<string, unknown> {
	const job = result.details.job as Record<string, unknown> | undefined;
	assert.ok(job, `the result must carry the job: ${result.text}`);
	return job;
}

/** How many times a log carries the cap marker — the count that must never exceed one. */
function markerCount(text: string): number {
	return text.split(logCapMarker().trim()).length - 1;
}

test("a job writing 5000 lines returns the tail with the truncation notice", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "seq 1 5000" });
		const id = jobOf(start).id as string;
		await h.waitForJob(id, (job) => job.state === "exited");

		const logs = await h.call({ action: "logs", id });
		assert.doesNotMatch(logs.text, /^Error:/, logs.text);
		assert.equal(logs.details.truncated, true, "5000 lines must be truncated");
		assert.equal(logs.details.truncatedBy, "lines", "the line limit is what was hit");
		assert.equal(logs.details.totalLines, 5000, "the total reported is the log's, not the window's");
		assert.equal(logs.details.outputLines, 2000);

		// The tail, not the head: the last line is there, the first is not.
		assert.match(logs.text, /\n5000(\n|$)/, "the end of the log is what is shown");
		assert.doesNotMatch(logs.text, /(^|\n)1(\n|$)/, "the beginning is gone");
		// Rendered like pi's bash tool renders the same situation.
		assert.match(logs.text, /\[Showing lines 3001-5000 of 5000\. Full output up to the cap: /);
		assert.equal(logs.details.capped, false, "a log under the cap is not a capped log");
	});
});

test("a log past the byte limit is cut at the byte limit, not the line count", async () => {
	// 40 lines of 2000 characters: 80KB in 40 lines, so only the byte limit bites.
	const command = 'i=1; while [ $i -le 40 ]; do head -c 2000 /dev/zero | tr "\\0" "x"; echo; i=$((i+1)); done';
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command });
		const id = jobOf(start).id as string;
		await h.waitForJob(id, (job) => job.state === "exited");

		const logs = await h.call({ action: "logs", id });
		assert.equal(logs.details.truncated, true);
		assert.equal(logs.details.truncatedBy, "bytes", "the byte limit is what was hit");
		assert.ok((logs.details.outputLines as number) < 40, "fewer lines than the log holds");
		assert.match(logs.text, /50\.0KB limit/, "the notice names the byte limit it applied");
		assert.ok(logs.text.length < 51_200, `the result must stay near the byte limit (${logs.text.length})`);
	});
});

test("stdout and stderr are one stream, in write order", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "echo one; echo two >&2; echo three; echo four >&2" });
		const id = jobOf(start).id as string;
		await h.waitForJob(id, (job) => job.state === "exited");

		const logs = await h.call({ action: "logs", id });
		assert.equal(logs.details.truncated, false, "a small log is returned whole");
		assert.deepEqual(logs.text.split("\n").slice(0, 4), ["one", "two", "three", "four"], "interleaved, not concatenated");
	});
});

test("logs of a running job return what exists so far instead of an error", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "echo early-line; sleep 30" });
		const id = jobOf(start).id as string;
		await waitFor(async () => (await h.readLog(id)).includes("early-line"));

		const logs = await h.call({ action: "logs", id });
		assert.doesNotMatch(logs.text, /^Error:/, logs.text);
		assert.match(logs.text, /early-line/, "the output written so far is returned");
		assert.equal(logs.details.state, "running");
		assert.equal(logs.details.truncated, false);
		assert.match(logs.text, new RegExp(`still running`), "the partial output says it is partial");
		assert.equal((await h.readJob(id)).state, "running", "reading the log does not settle the job");
	});
});

test("logs of an unknown job is a clear error, not a crash", async () => {
	await withBgHarness(async (h) => {
		const missing = await h.call({ action: "logs", id: "deadbeef" });
		assert.match(missing.text, /^Error: /, missing.text);
		assert.equal(missing.details.action, "logs");
		assert.match(String(missing.details.error), /no job deadbeef/);

		const noId = await h.call({ action: "logs" });
		assert.match(noId.text, /^Error: /, noId.text);
		assert.match(String(noId.details.error), /needs a job id/);
	});
});

test("a job with no output says so rather than returning an empty result", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "true" });
		const id = jobOf(start).id as string;
		await h.waitForJob(id, (job) => job.state === "exited");
		const logs = await h.call({ action: "logs", id });
		assert.match(logs.text, /\(no output\)/);
		assert.equal(logs.details.bytesRead, 0);
	});
});

test("enforceLogCap bounds a log once, keeps one marker, and does nothing twice more", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bg-log-cap-"));
	const logPath = path.join(dir, "output.log");
	try {
		// Numbered lines so the kept window is checkable: 120k lines of ~20 bytes.
		const lines = Array.from({ length: 120_000 }, (_, index) => `line ${String(index + 1).padStart(6, "0")} padding`);
		await writeFile(logPath, `${lines.join("\n")}\n`);
		const before = (await stat(logPath)).size;
		assert.ok(before > BG_LOG_CAP_BYTES * 2, `the fixture must be well past the cap (${before})`);

		const first = await enforceLogCap(logPath);
		assert.equal(first.capped, true, "the first call caps the file");
		assert.equal(first.bytesBefore, before);
		const after = await readFile(logPath, "utf8");
		assert.ok(Buffer.byteLength(after) <= BG_LOG_CAP_BYTES, `capped under the limit (${Buffer.byteLength(after)})`);
		assert.equal(markerCount(after), 1, "exactly one marker");
		assert.ok(after.endsWith(`${logCapMarker()}`), "the marker ends the file");
		// Truncated from the FRONT: the last line written is still there.
		assert.match(after, /\nline 120000 padding\n/, "the newest output survives");
		assert.doesNotMatch(after, /line 000001 padding/, "the oldest output is gone");
		// The kept window opens on a line boundary, not mid-line and not mid-rune.
		const kept = after.split("\n").filter((line) => line.length > 0);
		assert.match(kept[0] ?? "", /^line \d{6} padding$/, "the first kept line is complete");

		// Idempotence: no new output, so nothing to do and nothing to rewrite.
		const sizeAfterFirst = (await stat(logPath)).size;
		const second = await enforceLogCap(logPath);
		const third = await enforceLogCap(logPath);
		assert.equal(second.capped, false, "a bounded log is left alone");
		assert.equal(third.capped, false);
		assert.equal((await stat(logPath)).size, sizeAfterFirst, "the file did not change");
		assert.equal(markerCount(await readFile(logPath, "utf8")), 1, "still exactly one marker");

		// Output resumes past the cap: the next pass caps again and moves the
		// marker, rather than appending a second one.
		await writeFile(logPath, `${await readFile(logPath, "utf8")}${"more output\n".repeat(60_000)}`);
		const fourth = await enforceLogCap(logPath);
		assert.equal(fourth.capped, true);
		const final = await readFile(logPath, "utf8");
		assert.equal(markerCount(final), 1, "one marker after any number of cappings");
		assert.ok(Buffer.byteLength(final) <= BG_LOG_CAP_BYTES);
		assert.ok(final.endsWith("more output\n") === false, "the marker still ends the capped file");

		// The read path agrees with the file: capped, and it says so.
		const tail = await readLogTail(logPath);
		assert.equal(tail.capped, true);
		assert.equal(logWasCapped(final), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("enforceLogCap leaves an absent log, and a log under the cap, untouched", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "bg-log-cap-small-"));
	const logPath = path.join(dir, "output.log");
	try {
		const missing = await enforceLogCap(logPath);
		assert.deepEqual(missing, { capped: false, bytesBefore: 0, bytesAfter: 0 }, "no log is not an error");

		const small = "one\ntwo\n";
		await writeFile(logPath, small);
		const result = await enforceLogCap(logPath);
		assert.equal(result.capped, false);
		assert.equal(await readFile(logPath, "utf8"), small, "an under-cap log is not rewritten");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a log bigger than the read window is read from its end, and says so", async () => {
	// The guard for the window between a burst and the next poll: a log that
	// outran the cap must not be loaded whole just because someone asked for it.
	const dir = await mkdtemp(path.join(tmpdir(), "bg-log-window-"));
	const logPath = path.join(dir, "output.log");
	try {
		const filler = `window filler line that is long enough to matter ${'y'.repeat(80)}\n`;
		const count = Math.ceil((BG_LOG_READ_WINDOW_BYTES * 2) / Buffer.byteLength(filler));
		await writeFile(logPath, `${filler.repeat(count)}last-line-of-the-log\n`);
		assert.ok((await stat(logPath)).size > BG_LOG_READ_WINDOW_BYTES * 1.5);

		const tail = await readLogTail(logPath);
		assert.equal(tail.windowed, true, "the head was never read");
		assert.equal(tail.capped, false, "reading a big log does not claim it was capped");
		assert.ok(tail.bytesRead <= BG_LOG_READ_WINDOW_BYTES, `read stayed inside the window (${tail.bytesRead})`);
		assert.match(tail.content, /last-line-of-the-log/, "the end of the log is what is shown");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the watcher caps a running job's log, once, and logs reports the cap", async () => {
	// ~2MB in a burst, then a sleep so the job is still running when the poll
	// gets to it: the cap has to work on a live, growing file.
	const command =
		'i=1; while [ $i -le 40000 ]; do echo "log line $i aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done; echo burst-done; sleep 30';
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command });
		const id = jobOf(start).id as string;
		const logPath = path.join(h.jobDir(id), "output.log");

		// The watcher's poll is the only thing that caps it. Waiting for the burst to
		// finish (`burst-done` is the last line the job writes) before checking the
		// size is what makes this a stable measurement: while the job is still
		// writing, a log can be capped at one tick and past the cap again at the
		// next, and the size read would be neither one nor the other.
		await waitFor(async () => {
			const text = await h.readLog(id);
			return text.includes("burst-done") && (await stat(logPath)).size <= BG_LOG_CAP_BYTES;
		}, 30_000);
		const cappedSize = (await stat(logPath)).size;
		assert.ok(cappedSize <= BG_LOG_CAP_BYTES, `the log is bounded (${cappedSize})`);
		const text = await h.readLog(id);
		assert.equal(markerCount(text), 1, "one marker");
		assert.match(text, /log line 40000 /, "the newest output is what survives");
		assert.match(text, /burst-done\n\n\[bg\] log capped at 256KB/, "the marker follows the last output, once");
		assert.equal((await h.readJob(id)).state, "running", "capping does not settle the job");

		const logs = await h.call({ action: "logs", id });
		assert.equal(logs.details.capped, true, "logs reports that the log hit its cap");
		assert.match(logs.text, /hit its 256KB cap; the earliest output was discarded/);
		assert.match(logs.text, /still running/);

		// Several more ticks pass with the job asleep: no second truncation, so
		// the poll converges instead of rewriting the file twice a second.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.equal((await stat(logPath)).size, cappedSize, "a capped, quiet log is not touched again");
		assert.equal(markerCount(await h.readLog(id)), 1);
	});
});
