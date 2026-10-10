// Unit tests for the pocket replay journal.
//
// The journal's whole job is answering one question correctly: *what happened
// while the phone was away?* The answer is only correct if the cursor arithmetic
// is right, so these tests pin the three cursor cases (in range, trimmed away,
// ahead of the buffer) and the trim itself.
//
// The trim is the part with teeth: it rewrites the buffer from underneath a
// reader, so a restart has to be able to tell where the survivors start. The
// sidecar exists for that, and `a restarted journal still knows where the
// survivors start` is the test that proves it is not decoration.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { SessionJournal } from "../../pocket/journal.ts";

async function journalRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pocket-journal-"));
}

test("records are sequenced and come back in order", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		const first = await journal.append("s-1", { kind: "pi_event", event: { type: "turn_start" } });
		const second = await journal.append("s-1", { kind: "pi_event", event: { type: "message_start" } });
		assert.equal(first.seq, 1);
		assert.equal(second.seq, 2);
		const read = await journal.readSince("s-1", 0);
		assert.deepEqual(
			read.records.map((record) => record.seq),
			[1, 2],
		);
		assert.equal(read.reset, false);
		assert.equal(read.cursor, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent appends keep the sequence and the file in agreement", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 200);
		// Fired without awaiting, so the per-session promise chain is what keeps
		// the numbering from racing itself: two appends that interleave would
		// hand out the same seq, and a replay would drop one of them.
		await Promise.all(Array.from({ length: 25 }, (_unused, index) => journal.append("s-race", { kind: "pi_event", index })));
		const read = await journal.readSince("s-race", 0);
		assert.equal(read.records.length, 25);
		assert.deepEqual(
			read.records.map((record) => record.seq),
			Array.from({ length: 25 }, (_unused, index) => index + 1),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a cursor past the newest record resets rather than skipping", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		await journal.append("s-1", { kind: "gateway_event", event: "session_started" });
		const read = await journal.readSince("s-1", 99);
		// A client that thinks it has seen 99 records against a buffer of 1 is
		// talking about a different session than this one. Sending it "nothing
		// new" would leave it believing it was caught up.
		assert.equal(read.reset, true);
		assert.equal(read.cursor, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an unknown session reads as empty, not as an error", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		const read = await journal.readSince("s-missing", 0);
		assert.deepEqual(read.records, []);
		assert.equal(read.reset, false);
		assert.equal(read.cursor, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a record above the byte cap is journaled truncated, not dropped", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		// One megabyte of tool output: the cap turns this into a marker before it
		// is appended, and the marker has to stay recognisable — a record that
		// lost its `kind` and its event type would render as a blank hole in the
		// transcript instead of a named, truncated entry.
		const huge = { kind: "pi_event", event: { type: "message_end", output: "x".repeat(1_000_000) } };
		await journal.append("s-huge", huge);
		const read = await journal.readSince("s-huge", 0);
		const record = read.records[0] as unknown as Record<string, unknown>;
		const serialized = JSON.stringify(record);
		assert.ok(serialized.length < 80_000, `journaled a ${serialized.length}-byte record`);
		assert.equal(record.kind, "pi_event");
		assert.equal((record.event as { type?: string })?.type, "message_end");
		assert.equal((record.event as { truncated?: boolean })?.truncated, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("trim keeps the newest max records and leaves the rest behind", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 3);
		for (let index = 1; index <= 10; index += 1) await journal.append("s-1", { kind: "gateway_event", index });
		const read = await journal.readSince("s-1", 0);
		assert.deepEqual(
			read.records.map((record) => record.seq),
			[8, 9, 10],
		);
		// A cursor at the trimmed boundary is still in range: the client is
		// offered exactly what it has not seen.
		const boundary = await journal.readSince("s-1", 7);
		assert.equal(boundary.reset, false);
		assert.deepEqual(
			boundary.records.map((record) => record.seq),
			[8, 9, 10],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a cursor older than the trimmed buffer resets with everything still held", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 3);
		for (let index = 1; index <= 10; index += 1) await journal.append("s-1", { kind: "gateway_event", index });
		const read = await journal.readSince("s-1", 2);
		assert.equal(read.reset, true);
		assert.equal(read.cursor, 10);
		assert.deepEqual(
			read.records.map((record) => record.seq),
			[8, 9, 10],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a restarted journal still knows where the survivors start", async () => {
	const root = await journalRoot();
	try {
		const first = new SessionJournal(root, 3);
		for (let index = 1; index <= 10; index += 1) await first.append("s-1", { kind: "gateway_event", index });
		// A second instance over the same root is the daemon-restart case: it has
		// no in-memory state at all, so the sidecar is the only thing that can
		// tell it that seq 1..7 are gone.
		const restarted = new SessionJournal(root, 3);
		const inRange = await restarted.readSince("s-1", 9);
		assert.equal(inRange.reset, false);
		assert.deepEqual(
			inRange.records.map((record) => record.seq),
			[10],
		);
		const stale = await restarted.readSince("s-1", 3);
		assert.equal(stale.reset, true);
		assert.equal(stale.cursor, 10);
		assert.equal(await restarted.latestSeq("s-1"), 10);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("trim leaves no temp file behind", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 2);
		for (let index = 1; index <= 6; index += 1) await journal.append("s-1", { kind: "gateway_event", index });
		const dir = path.join(root, "journal");
		const files = await (await import("node:fs/promises")).readdir(dir);
		assert.deepEqual(files.sort(), ["s-1.jsonl", "s-1.jsonl.start"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("drop removes the buffer and its sidecar", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		await journal.append("s-1", { kind: "gateway_event", event: "session_started" });
		await journal.drop("s-1");
		const file = path.join(root, "journal", "s-1.jsonl");
		const sidecar = `${file}.start`;
		await assert.rejects(readFile(file, "utf8"), /ENOENT/);
		await assert.rejects(readFile(sidecar, "utf8"), /ENOENT/);
		assert.equal(await journal.latestSeq("s-1"), 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a journal whose data root was deleted mid-life still answers", async () => {
	const root = await journalRoot();
	try {
		const journal = new SessionJournal(root, 100);
		await journal.append("s-1", { kind: "gateway_event", event: "session_started" });
		await rm(root, { recursive: true, force: true });
		// The append queue swallows the failure (the buffer is an optimisation on
		// top of pi's own session file), so the caller still gets an answer with
		// a sequence number — and the daemon keeps running, which is the point.
		const appended = await journal.append("s-1", { kind: "gateway_event", event: "child_exited" });
		assert.equal(appended.seq, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
