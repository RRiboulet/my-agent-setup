// Read-only measurement harness behind the `bg` spec's replay baselines.
//
//   node tools/measure-bash-blocking.mjs
//
// One pass over pi's session JSONL, producing the numbers the spec's
// acceptance criteria use:
//
//   1. blocking bash seconds  — sum of `message.durationMs` over bash tool results
//   2. bash calls over 60 s   — how many of those calls exceeded 60 000 ms
//   3. full-suite runs        — how many tool calls ran a repository's whole test
//                               suite, split by the tool that ran it (`bash`, or
//                               `bg start`, which is the point of the change)
//   4. task wall-clock        — last timestamp minus first timestamp in the file
//   5. overlap                — for a suite run started through `bg`, the seconds
//                               of that job's life during which other tool work
//                               was happening. Read from the job's own record
//                               (`<agent dir>/bg-jobs/<session>/<id>/job.json`),
//                               never inferred from the tool call that started it,
//                               so a job that outlives the call still counts.
//
// Overlap needs the job records, not just the session file, so the script also
// globs every `bg-jobs` directory under `~/.pi` one level down (agent dirs
// such as `agent` and `agent-replay-feature`): replay runs use two agent
// directories (the default one and the package-free feature one), and both
// write their jobs somewhere else than their sessions. Matching is by the
// record's `sessionId`, so a job can only ever be attributed to its own session.

// The pairing is explicit: an assistant `toolCall` block is indexed by its
// `id`, and every `toolResult` is joined to it through `toolCallId`. The
// duration is read from the RESULT entry's `message.durationMs` — the field the
// spec's 2026-11-16 baseline was derived from (verified on this machine against
// the same 82 files: it reproduces 994 bash calls, 23 over 60 s, and a
// 4 175-4 208 s bash total depending on the sampling window).
//
// It writes nothing and takes no positional arguments on purpose: every number
// is about the machine and the sessions it runs on, so the baselines document
// dates its figures instead of presenting them as constants. It reads the
// default agent directory (`~/.pi/agent/sessions`), which is where the spec's
// baseline and the replay runs live, because the feature runs' agent directory
// symlinks its `sessions` there; a replay run is one session file.
//
// What it deliberately does NOT measure:
//   * model time, tool latency for read/edit/write, tokens, or cost;
//   * idle time (the gap between a tool result and the next assistant turn).
//     Wall-clock is the file's span, so a session left open overnight counts as
//     wall-clock, which is what makes the spec's 81 % idle figure visible — but
//     this script reports the span, not a breakdown of it;
//   * whether a slow call was necessary, repeated, or polled in a `sleep` loop.
//     Those are diagnoses, not columns; `durationMs` cannot tell them apart;
//   * subagent child sessions under the agent dir's `tmux-subagents/` tree.
//     The spec's baseline is `sessions/` only, so including them would move the
//     goalposts. Point a separate run at them if you need that comparison.
//
// Deliberately independent of the extension: the script reimplements the join
// from the JSONL alone, so a bug in the `bg` extension cannot hide itself by
// being used on both sides of the comparison.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSIONS = path.join(os.homedir(), ".pi", "agent", "sessions");
const OVER_THRESHOLD_MS = 60_000;

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield full;
	}
}

/** Milliseconds since the epoch for a top-level entry timestamp, or null. */
function millis(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		// Older entries carry `message.timestamp` as epoch ms; ISO strings are the
		// current top-level form.
		return value < 1e12 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}

/**
 * A "full-suite run" is a bash command that runs a repository's whole test
 * suite, not one file. Three shapes appear in this repo's sessions:
 *
 *   - node --test .pi/extensions/subagent/test/*.test.ts   (my-agent-setup)
 *   - npm test / npm run test                              (pupkeep)
 *   - uv run pytest / pytest with no path and no -k        (analytics-agent)
 *
 * The command is first split into `;`/`&&`/`||`/newline chunks (not `|`, so a
 * real run piped into `tail` still counts), and a chunk that starts with a
 * read-only or scripting command is skipped — otherwise `grep 'npm test' …` and
 * a Python heredoc that *mentions* the suite both count as runs. Chunks with a
 * heredoc are skipped outright for the same reason. The match boundary includes
 * quotes, because a suite run is often nested: `bash -lc 'npm test'`.
 *
 * The pytest case is the only remaining heuristic: a token ending in `.py`, a
 * `tests/` or `::` selector, or a `-k` expression means a subset and is not
 * counted. Every detected run's command is printed, so the classification can be
 * checked by eye rather than trusted.
 */
const NON_RUNNING = new Set([
	"grep", "rg", "sed", "awk", "echo", "printf", "cat", "ls", "find", "git",
	"python", "python3", "curl", "which", "command", "test", "[", "head", "tail",
]);
function isFullSuite(command) {
	if (!command || command.includes("<<")) return false;
	const chunks = command
		.split(/(?:&&|\|\||;|\n)/)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
	for (const chunk of chunks) {
		// A dry run prints the command without running it, so `DEVC_DRY_RUN=1 devc …
		// -- npm test` is not a suite execution.
		if (/\bDEVC_DRY_RUN=/.test(chunk)) continue;
		// `cd …` is folded into the next chunk's text; inspect the first word after
		// any `cd X` prefix, so `cd /repo && npm test` is seen as `npm test`.
		const bare = chunk.replace(/^cd\s+\S+\s+/, "");
		const first = bare.split(/\s+/)[0] ?? "";
		if (NON_RUNNING.has(first)) continue;
		if (first === "node" && /^node\s+(-e|-p|--eval|--print)\b/.test(bare)) continue;
		if (/(^|[\s;&|()'"`])npm\s+(run\s+)?test\b/.test(bare)) return true;
		if (/node\s+--test[^\n]*\.pi\/extensions\/subagent\/test\/\*\.test\.ts/.test(bare)) return true;
		const pytest = bare.match(/(^|[\s;&|()'"`])(uv\s+run\s+)?pytest\b([^\n|]*)/);
		if (!pytest) continue;
		const rest = pytest[3] ?? "";
		if (/(^|\s)(-k|--deselect)\b/.test(rest)) continue;
		if (/(^|\s)[^\s]*\.py\b/.test(rest)) continue;
		if (/(^|\s)[^\s]*\/[^\s]*/.test(rest)) continue;
		if (/(^|\s)[^\s]*::/.test(rest)) continue;
		return true;
	}
	return false;
}

/**
 * Every `bg` job record on this machine, keyed by the session that owns it.
 *
 * The records live under an agent directory, and a replay run may use a
 * different one from the default (`~/.pi/agent-replay-feature` is the
 * package-free directory the feature task needs), so each agent directory under
 * `~/.pi` that has a `bg-jobs` tree is scanned. The record's own `sessionId` is
 * the join key; the directory nesting is only a cross-check, and a record is
 * filed under `sessionId` even when its directory disagrees with it.
 */
function loadBgJobs() {
	const root = path.join(os.homedir(), ".pi");
	const bySession = new Map();
	let agentDirs;
	try {
		agentDirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {
		return bySession;
	}
	for (const agentDir of agentDirs) {
		const bgRoot = path.join(root, agentDir.name, "bg-jobs");
		let sessionDirs;
		try {
			sessionDirs = fs.readdirSync(bgRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		} catch {
			continue;
		}
		for (const sessionDir of sessionDirs) {
			let jobDirs;
			try {
				jobDirs = fs.readdirSync(path.join(bgRoot, sessionDir.name), { withFileTypes: true });
			} catch {
				continue;
			}
			for (const jobDir of jobDirs) {
				if (!jobDir.isDirectory()) continue;
				let record;
				try {
					record = JSON.parse(fs.readFileSync(path.join(bgRoot, sessionDir.name, jobDir.name, "job.json"), "utf8"));
				} catch {
					continue; // a job whose metadata is unreadable is simply not evidence
				}
				const sessionId = record.sessionId ?? sessionDir.name;
				if (!bySession.has(sessionId)) bySession.set(sessionId, []);
				bySession.get(sessionId).push({ ...record, agentDir: agentDir.name });
			}
		}
	}
	return bySession;
}

/** Total milliseconds covered by the union of a set of closed intervals. */
function unionMs(intervals) {
	const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
	let total = 0;
	let cursor = null;
	let cursorStart = 0;
	for (const interval of sorted) {
		if (cursor === null || interval.start > cursor) {
			if (cursor !== null) total += cursor - cursorStart;
			cursorStart = interval.start;
			cursor = interval.end;
		} else if (interval.end > cursor) {
			cursor = interval.end;
		}
	}
	if (cursor !== null) total += cursor - cursorStart;
	return total;
}

function parseSession(file) {
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	const calls = new Map(); // toolCall id -> { name, command, action, targetId }
	const intervals = []; // completed tool calls, as [start, end] epoch ms
	let id = null;
	let cwd = null;
	let startedMs = null;
	let endedMs = null;
	let bashCalls = 0;
	let bashMs = 0;
	let over60 = 0;
	let over60Ms = 0;
	const suiteRuns = [];

	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		const at = millis(entry.timestamp);
		if (at !== null) {
			if (startedMs === null || at < startedMs) startedMs = at;
			if (endedMs === null || at > endedMs) endedMs = at;
		}
		if (entry.type === "session") {
			id = entry.id ?? id;
			cwd = entry.cwd ?? cwd;
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message ?? entry;
		const atMessage = millis(message.timestamp);
		if (atMessage !== null) {
			if (startedMs === null || atMessage < startedMs) startedMs = atMessage;
			if (endedMs === null || atMessage > endedMs) endedMs = atMessage;
		}

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type !== "toolCall") continue;
				const args = block.arguments ?? {};
				calls.set(block.id, {
					name: block.name,
					command: typeof args.command === "string" ? args.command : undefined,
					action: typeof args.action === "string" ? args.action : undefined,
					targetId: typeof args.id === "string" ? args.id : undefined,
				});
			}
		}

		if (message.role !== "toolResult") continue;
		// The pair is the join key; the result's own `toolName` is a cross-check.
		const call = calls.get(message.toolCallId);
		const toolName = message.toolName ?? call?.name;
		const finishedMs = millis(entry.timestamp) ?? millis(message.timestamp);
		const duration = Number.isFinite(message.durationMs) ? message.durationMs : 0;
		if (finishedMs !== null) {
			intervals.push({
				id: message.toolCallId,
				name: toolName ?? "?",
				command: call?.command,
				action: call?.action,
				targetId: call?.targetId,
				start: finishedMs - duration,
				end: finishedMs,
			});
		}
		if (toolName !== "bash" && toolName !== "bg") continue;

		// A suite run started through `bg` is still a suite run: it is the change
		// this measurement exists to judge, so `bg start` counts and is reported
		// separately from `bash` rather than folded in silently.
		if (toolName === "bg") {
			if (call?.action === "start" && isFullSuite(call.command)) {
				suiteRuns.push({ tool: "bg", command: (call.command ?? "").replace(/\s+/g, " ").slice(0, 100) });
			}
			continue;
		}

		bashCalls += 1;
		bashMs += duration;
		if (duration > OVER_THRESHOLD_MS) {
			over60 += 1;
			over60Ms += duration;
		}
		if (isFullSuite(call?.command)) {
			suiteRuns.push({ tool: "bash", command: (call.command ?? "").replace(/\s+/g, " ").slice(0, 100) });
		}
	}

	return {
		file,
		id: id ?? path.basename(file).replace(/\.jsonl$/, ""),
		cwd: cwd ?? "",
		startedMs,
		endedMs,
		wallMs: startedMs !== null && endedMs !== null ? Math.max(0, endedMs - startedMs) : 0,
		bashCalls,
		bashMs,
		over60,
		over60Ms,
		suiteRuns,
		intervals,
	};
}

/**
 * The seconds of a suite job's life during which other tool work was happening.
 *
 * "Other tool work" is every completed tool call whose interval intersects the
 * job's `[startedAt, finishedAt]` window, with two deliberate exclusions:
 *
 *   - the `bg start` call that launched the job (its interval is the launch, not
 *     work done beside the job);
 *   - any `bg` call naming the job (wait/logs/kill/status): waiting on a job is
 *     the thing this measurement is trying to show is avoidable, so counting it
 *     as overlap would let a blocking `wait` score as concurrency. The excluded
 *     seconds are reported separately as `wait s`.
 *
 * The union is taken, so two parallel calls that run at the same time through
 * the same seconds count once — this is seconds of the suite run covered, not
 * seconds of tool time spent.
 */
function suiteOverlap(session, jobs) {
	const records = jobs ?? [];
	// A job with no start time, or one that never started a process, has no window
	// to intersect and must not be read as zero overlap or as all of it.
	const suiteJobs = records.filter(
		(job) => isFullSuite(job.command) && job.state !== "failed-to-start" && Number.isFinite(job.startedAt),
	);
	const now = Date.now();
	const perJob = suiteJobs.map((job) => {
		const window = { start: job.startedAt, end: job.finishedAt ?? now };
		const work = [];
		const waits = [];
		for (const call of session.intervals) {
			const intersect = { start: Math.max(call.start, window.start), end: Math.min(call.end, window.end) };
			if (intersect.end <= intersect.start) continue;
			if (call.name === "bg") {
				const namesThisJob = call.targetId === job.id || (call.action === "start" && isFullSuite(call.command));
				if (namesThisJob) {
					if (call.action === "wait") waits.push(intersect);
					continue;
				}
			}
			work.push({ ...intersect, call });
		}
		const overlapping = work.filter((entry) => entry.end > entry.start);
		return {
			job,
			window,
			elapsedMs: window.end - window.start,
			overlapMs: unionMs(overlapping),
			waitMs: unionMs(waits),
			calls: overlapping.map((entry) => entry.call),
		};
	});
	return {
		jobs: suiteJobs,
		allJobs: records,
		perJob,
		overlapMs: perJob.reduce((sum, entry) => sum + entry.overlapMs, 0),
		waitMs: perJob.reduce((sum, entry) => sum + entry.waitMs, 0),
	};
}

const files = [...walk(SESSIONS)];
if (files.length === 0) {
	console.error(`no session files under ${SESSIONS}`);
	process.exit(2);
}

const sessions = files.map(parseSession);
const jobsBySession = loadBgJobs();
for (const session of sessions) session.overlap = suiteOverlap(session, jobsBySession.get(session.id));
// Newest first, so the replay runs — the reason most readers open this — are at
// the top. The filename starts with the ISO timestamp, so sorting by start is
// enough and does not depend on mtime (which a copy rewrites).
sessions.sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0));

const seconds = (ms) => (ms / 1000).toFixed(1);
const started = (ms) => (ms === null ? "—" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const shortCwd = (value) => {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
};

const header = [
	"session".padEnd(34),
	"started".padEnd(16),
	"wall s".padStart(9),
	"bash".padStart(6),
	"bash s".padStart(10),
	">60 s".padStart(6),
	">60 s sum".padStart(10),
	"suite".padStart(6),
	"overlap s".padStart(10),
	"cwd",
].join("  ");
console.log(header);
console.log("-".repeat(header.length));

let totalWall = 0;
let totalBash = 0;
let totalBashMs = 0;
let totalOver60 = 0;
let totalOver60Ms = 0;
let totalSuite = 0;
const suiteCommands = [];

for (const session of sessions) {
	totalWall += session.wallMs;
	totalBash += session.bashCalls;
	totalBashMs += session.bashMs;
	totalOver60 += session.over60;
	totalOver60Ms += session.over60Ms;
	totalSuite += session.suiteRuns.length;
	for (const run of session.suiteRuns) suiteCommands.push({ session: session.id, ...run });
	const bashRuns = session.suiteRuns.filter((run) => run.tool === "bash").length;
	const bgRuns = session.suiteRuns.length - bashRuns;
	const suiteCell = session.suiteRuns.length === 0 ? "0" : `${session.suiteRuns.length} (${bashRuns}b/${bgRuns}g)`;
	console.log(
		[
			session.id.padEnd(34),
			started(session.startedMs).padEnd(16),
			seconds(session.wallMs).padStart(9),
			String(session.bashCalls).padStart(6),
			seconds(session.bashMs).padStart(10),
			String(session.over60).padStart(6),
			seconds(session.over60Ms).padStart(10),
			suiteCell.padStart(6),
			seconds(session.overlap.overlapMs).padStart(10),
			shortCwd(session.cwd),
		].join("  "),
	);
}

console.log("-".repeat(header.length));
console.log(
	[
		`TOTAL (${sessions.length} sessions)`.padEnd(34),
		"".padEnd(16),
		seconds(totalWall).padStart(9),
		String(totalBash).padStart(6),
		seconds(totalBashMs).padStart(10),
		String(totalOver60).padStart(6),
		seconds(totalOver60Ms).padStart(10),
		String(totalSuite).padStart(6),
		seconds(sessions.reduce((sum, session) => sum + session.overlap.overlapMs, 0)).padStart(10),
	].join("  "),
);

if (suiteCommands.length > 0) {
	console.log("\nfull-suite runs detected (tool and command text, for checking the classification):");
	for (const { session, tool, command } of suiteCommands) console.log(`  ${session}  [${tool}]  ${command}`);
}

// The overlap figure is only meaningful beside the job it was read from, so the
// jobs are printed: id, state, elapsed, whether the command is a suite run, and
// how many other tool calls fell inside the job's window. A `bg` job that failed
// to start has no window and must not be read as zero overlap.
const jobsWithSessions = sessions.filter((session) => session.overlap.allJobs.length > 0);
if (jobsWithSessions.length > 0) {
	console.log("\nbg jobs recorded for these sessions (from <agent dir>/bg-jobs/<session>/<id>/job.json):");
	for (const session of jobsWithSessions) {
		for (const job of session.overlap.allJobs) {
			const elapsed = job.finishedAt === null ? null : job.finishedAt - job.startedAt;
			const isSuite = isFullSuite(job.command);
			const detail = session.overlap.perJob.find((entry) => entry.job.id === job.id);
			console.log(
				[
					`  ${session.id}`,
					job.id,
					String(job.state).padEnd(15),
					`exit ${job.exitCode ?? "—"}`.padEnd(8),
					`${seconds(elapsed ?? 0)} s`.padStart(9),
					`suite ${isSuite ? "yes" : "no "}`,
					isSuite ? `overlap ${seconds(detail?.overlapMs ?? 0)} s / wait ${seconds(detail?.waitMs ?? 0)} s / ${detail?.calls.length ?? 0} calls` : "",
					(job.command ?? "").replace(/\s+/g, " ").slice(0, 70),
				].join("  "),
			);
		}
	}
}
