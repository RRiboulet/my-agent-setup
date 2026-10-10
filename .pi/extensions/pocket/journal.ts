// pocket — the per-session replay journal
//
// A phone that loses signal mid-run must be able to come back and be told what
// it missed. Two tiers make that work, and they are deliberately not the same
// store:
//
//   1. pi's own session file is the authoritative, unbounded conversation. It is
//      resumed by respawning a child, so it survives everything.
//   2. this journal is a bounded replay buffer of the events the child emitted
//      while away. It is capped (PI_POCKET_JOURNAL_MAX) so a long-lived daemon
//      cannot grow one file per session forever.
//
// A client sends the last sequence number it saw; `readSince` returns only what
// came after it, or `reset: true` when that cursor has aged out of the buffer —
// at which point the client reloads history through get_messages instead. The
// cursor is a line sequence, not a byte offset, so it stays meaningful across a
// daemon restart as long as the buffer was not trimmed underneath it.
//
// Ordering is load-bearing: every append goes through a per-session promise
// chain, and the sequence number is handed out *inside* that chain. Two appends
// that started together must not both read the same "next number", or the file
// would carry two records claiming one sequence and a replay would drop one of
// them.

import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.ts";

export interface JournalRecord {
	seq: number;
	at: string;
	kind: string;
	[key: string]: unknown;
}

export interface JournalRead {
	records: JournalRecord[];
	/** Sequence to send as `cursor` next time. */
	cursor: number;
	/** True when the requested cursor aged out: reload history, do not patch. */
	reset: boolean;
}

interface JournalState {
	/** Sequence of the oldest record still in the file (1 unless trimmed). */
	startSeq: number;
	/** Sequence of the newest record written. */
	count: number;
	/** Serializes writes for this session. */
	queue: Promise<void>;
}

function startSidecarPath(journalFile: string): string {
	return `${journalFile}.start`;
}

/** Records above this size are journaled truncated: the buffer is for reconnect, not for archiving. */
const JOURNAL_RECORD_BYTE_CAP = 64 * 1024;

/**
 * Cap a record before it is journaled, keeping enough shape to render it.
 *
 * Tool results are unbounded — one `git diff` on a large change can run to
 * megabytes — and the journal is a bounded reconnect buffer, not an archive.
 * The marker keeps what identifies the record (`kind`, and the event's `type`)
 * so the phone can say "a large tool result happened here" instead of showing
 * a placeholder with no idea where it came from.
 */
export function capRecord(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return value;
	if (serialized.length <= JOURNAL_RECORD_BYTE_CAP) return value;
	if (!isPlainObject(value)) return { truncated: true, bytes: serialized.length };

	const capped: Record<string, unknown> = { truncated: true, bytes: serialized.length };
	for (const [key, item] of Object.entries(value)) {
		const size = JSON.stringify(item)?.length ?? 0;
		if (size <= JOURNAL_RECORD_BYTE_CAP) capped[key] = item;
		else if (key === "event" && isPlainObject(item) && typeof item.type === "string") {
			// The event's type decides what the client renders at all.
			capped[key] = { type: item.type, truncated: true, bytes: size };
		} else if (typeof item === "string") capped[key] = `${item.slice(0, 512)}… [truncated ${size} bytes]`;
		else capped[key] = { truncated: true, bytes: size };
	}
	return capped;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SessionJournal {
	readonly dataRoot: string;
	readonly max: number;
	private readonly states = new Map<string, JournalState>();
	/** One in-flight recovery per session, so concurrent appends share a chain. */
	private readonly loading = new Map<string, Promise<JournalState>>();

	constructor(dataRoot: string, max: number) {
		this.dataRoot = dataRoot;
		this.max = max;
	}

	/** Drop one session's buffer — called when a session is deleted. */
	async drop(sessionId: string): Promise<void> {
		this.states.delete(sessionId);
		this.loading.delete(sessionId);
		await rm(paths.journalFile(this.dataRoot, sessionId), { force: true });
		await rm(startSidecarPath(paths.journalFile(this.dataRoot, sessionId)), { force: true });
	}

	/**
	 * Recover this session's position on disk.
	 *
	 * `count` is the sequence of the newest record, which after a trim is *not*
	 * the number of lines: five survivors of a hundred-record file are lines 1..5
	 * carrying sequences 96..100. Deriving the newest sequence from the line
	 * count would make a restarted daemon believe its buffer held five records
	 * and answer every cursor from a phone with a reset.
	 */
	private async state(sessionId: string): Promise<JournalState> {
		const existing = this.states.get(sessionId);
		if (existing) return existing;
		const inFlight = this.loading.get(sessionId);
		if (inFlight) return inFlight;
		// Memoizing the *work*, not the result: recovering a session reads two
		// files, so two appends arriving together would otherwise each build a
		// private chain and both hand out sequence one. Serialized callers never
		// hit this — which is exactly why only a concurrent test can see it.
		const loading = this.recover(sessionId).finally(() => this.loading.delete(sessionId));
		this.loading.set(sessionId, loading);
		return loading;
	}

	/** Build a session's state from what is on disk. */
	private async recover(sessionId: string): Promise<JournalState> {
		const journalFile = paths.journalFile(this.dataRoot, sessionId);
		let lines = 0;
		try {
			const raw = await readFile(journalFile, "utf8");
			lines = raw.split("\n").filter((line) => line.trim() !== "").length;
		} catch {
			lines = 0;
		}
		let startSeq = 1;
		try {
			const parsed = Number.parseInt((await readFile(startSidecarPath(journalFile), "utf8")).trim(), 10);
			if (Number.isFinite(parsed) && parsed > 1) startSeq = parsed;
		} catch {
			startSeq = 1;
		}
		const state: JournalState = {
			startSeq: lines === 0 ? 1 : startSeq,
			count: lines === 0 ? 0 : Math.max(startSeq, 1) + lines - 1,
			queue: Promise.resolve(),
		};
		this.states.set(sessionId, state);
		return state;
	}

	/** Append one record and resolve with the sequenced copy. */
	async append(sessionId: string, record: Omit<JournalRecord, "seq" | "at">): Promise<JournalRecord> {
		const state = await this.state(sessionId);
		const journalFile = paths.journalFile(this.dataRoot, sessionId);
		const capped = capRecord(record) as Omit<JournalRecord, "seq" | "at">;

		// The sequence is assigned where the write happens, not where the append
		// was requested: a caller that fires several appends at once would
		// otherwise hand them all the same number.
		const written = state.queue.then(async (): Promise<JournalRecord> => {
			const seq = state.count + 1;
			const sequenced: JournalRecord = { seq, at: new Date().toISOString(), ...capped };
			await mkdir(path.dirname(journalFile), { recursive: true });
			await appendFile(journalFile, `${JSON.stringify(sequenced)}\n`);
			state.count = seq;
			await this.trimIfNeeded(sessionId, state);
			return sequenced;
		});

		// The chain continues whether or not the last write worked: a buffer on a
		// disk that filled up must not stop the sessions from running.
		state.queue = written.then(
			() => undefined,
			(error) => {
				console.error(`[pocket] journal append failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
		// The record is returned with the sequence it *would* have taken, because
		// its content is real even though the buffer will not hold it. pi's own
		// session file remains the authority on the conversation.
		return written.catch(() => {
			const seq = state.count + 1;
			return { seq, at: new Date().toISOString(), ...capped } as JournalRecord;
		});
	}

	/**
	 * Keep only the newest `max` records. The first surviving sequence is written
	 * to a sidecar, because after a restart the file alone cannot prove what the
	 * oldest line used to be.
	 */
	private async trimIfNeeded(sessionId: string, state: JournalState): Promise<void> {
		const overflow = state.count - state.startSeq + 1 - this.max;
		if (overflow <= 0) return;
		const journalFile = paths.journalFile(this.dataRoot, sessionId);
		const raw = await readFile(journalFile, "utf8");
		const lines = raw.split("\n").filter((line) => line.trim() !== "");
		const kept = lines.slice(Math.max(0, lines.length - this.max));
		const newStart = state.count - kept.length + 1;
		if (newStart <= state.startSeq) return;
		// Write the sidecar before the rename, so a crash between the two leaves
		// a buffer whose survivors still resolve to the same sequences.
		await writeFile(startSidecarPath(journalFile), `${newStart}\n`);
		const temporary = `${journalFile}.trim`;
		await writeFile(temporary, `${kept.join("\n")}\n`);
		await rename(temporary, journalFile);
		state.startSeq = newStart;
	}

	/** Records strictly after `after`, or a reset signal when `after` is out of range. */
	async readSince(sessionId: string, after: number): Promise<JournalRead> {
		const state = await this.state(sessionId);
		const journalFile = paths.journalFile(this.dataRoot, sessionId);
		let lines: string[] = [];
		try {
			lines = (await readFile(journalFile, "utf8")).split("\n").filter((line) => line.trim() !== "");
		} catch {
			return { records: [], cursor: after, reset: false };
		}

		const newest = state.count;
		// A cursor past the newest record means the two sides disagree about the
		// session (a fresh daemon over an old journal, say): reset rather than
		// silently skipping whatever the client has not seen.
		if (after > newest) return { records: [], cursor: newest, reset: true };
		// A cursor before the oldest surviving record means it was trimmed away.
		if (after < state.startSeq - 1) {
			const records = lines.map(parseLine).filter(isRecord);
			return { records, cursor: newest, reset: true };
		}

		const records: JournalRecord[] = [];
		for (const line of lines) {
			const record = parseLine(line);
			if (record && record.seq > after) records.push(record);
		}
		const cursor = records.length > 0 ? records[records.length - 1].seq : after;
		return { records, cursor, reset: false };
	}

	/** Newest sequence, for a client that just connected. */
	async latestSeq(sessionId: string): Promise<number> {
		return (await this.state(sessionId)).count;
	}
}

function parseLine(line: string): JournalRecord | undefined {
	try {
		const parsed = JSON.parse(line) as JournalRecord;
		return typeof parsed.seq === "number" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: JournalRecord | undefined): value is JournalRecord {
	return value !== undefined;
}
