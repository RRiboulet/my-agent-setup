// Unit tests for the bounded `subagent_status` list view (local patch 16).
//
// Risk covered: polling this tool is the ONLY way a model collects a result, so
// the list's cost is paid every turn. Two properties are load-bearing and easy to
// undo: the detail budget is a TOTAL (bounded lines no matter how many runs are
// live), and the one-line row still carries enough — id, status, elapsed, usage —
// to decide which run to inspect next.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";
import { compactRowText, LIST_DETAIL_BUDGET, renderRunList, runHeadline, selectDetailRuns, type ListRow } from "../listview.ts";

const { listRow, runSummary, showsPane } = __test__;

/** The minimum RunRecord the projection reads; everything else is filler. */
function makeRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "run-x",
		task: "Investigate the failing query",
		cwd: "/workspace",
		provider: "openrouter",
		model: "deepseek/deepseek-v4",
		thinking: "off",
		tmuxSession: "pi-agent-run-x",
		tmuxTarget: "pi-agent-run-x:0.0",
		attachCommand: "pi --attach-subagent 'run-x'",
		captureCommand: "tmux capture-pane -p",
		killCommand: "tmux kill-session -t pi-agent-run-x",
		runDir: "/tmp/run",
		resultPath: "/tmp/run/result.json",
		trusted: false,
		status: "running",
		createdAt: 5,
		startedAt: 1_000,
		finishedAt: 5_000,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: 0, turns: 1 },
		...overrides,
	};
}

/** A row built the way index.ts builds one: preformatted parts, no run record. */
function row(overrides: Partial<ListRow> = {}): ListRow {
	return {
		id: "run-a",
		status: "running",
		durationText: "3m 0s",
		usageText: "12k tok · 2 turns",
		createdAt: 1_700_000_000_000,
		detailWorthy: true,
		...overrides,
	};
}

/** `count` live rows, oldest first, which is the order the list view receives. */
function liveRows(count: number): ListRow[] {
	return Array.from({ length: count }, (_unused, index) => row({ id: `run-${index}`, createdAt: 1_700_000_000_000 + index }));
}

/** How many blocks carry the detail marker rather than a one-line row. */
function detailCount(text: string): number {
	return text.split("\n\n").filter((block) => block.startsWith("DETAIL ")).length;
}

/** Blocks are joined by a blank line, so only non-empty lines carry content. */
function contentLines(text: string): number {
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/** A stand-in for runSummary: a header plus a pane, i.e. the expensive shape. */
function detailBlock(run: ListRow): string {
	return [`DETAIL ${run.id}`, "  task: something long", ...Array.from({ length: 18 }, (_unused, index) => `  pane line ${index}`)].join("\n");
}

function renderAll(runs: readonly ListRow[], options: { compact?: boolean; omittedNote?: (omitted: readonly ListRow[]) => string | undefined } = {}): string {
	return renderRunList({ runs, compact: options.compact, omittedNote: options.omittedNote, renderDetail: detailBlock });
}

test("compactRowText is id, status, elapsed and usage", () => {
	assert.equal(compactRowText(row()), "run-a  running · 3m 0s · 12k tok · 2 turns");
});

test("a one-line row carries the note that must not be lost", () => {
	// Everything else the full block has is one subagent_status({ id }) away; the
	// note (a failure reason, the route to a live child) is the exception.
	assert.equal(compactRowText(row({ note: "! boom" })), "run-a  running · 3m 0s · 12k tok · 2 turns — ! boom");
});

test("the headline is shared with the detailed block", () => {
	// runSummary emits this string as its first line. Two copies would be free to
	// drift, and the drift would be invisible until a rendered list disagreed with
	// itself.
	const parts = { id: "run-x", status: "running", durationText: "4s", usageText: "1.5k tok · 1 turn" } as const;
	assert.equal(runSummary(makeRunRecord()).split("\n")[0], runHeadline(parts));
	assert.equal(compactRowText({ ...parts, createdAt: 5, detailWorthy: true }), runHeadline(parts));
});

test("compactRowText omits what the run does not have yet", () => {
	// A queued run has neither an elapsed time nor parsed usage; the row must not
	// carry stray separators for them.
	assert.equal(compactRowText({ id: "run-q", status: "queued", createdAt: 1, detailWorthy: false }), "run-q  queued");
});

test("the compact view is one line per run and renders no detail at all", () => {
	const text = renderAll(liveRows(6), { compact: true });
	assert.equal(detailCount(text), 0, "compact must never call renderDetail");
	assert.equal(contentLines(text), 6, "every run is exactly one line");
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) assert.match(line, /^run-\d  running · 3m 0s · 12k tok · 2 turns$/);
	}
});

test("the detail budget holds across the whole list, not per run", () => {
	// The regression this exists for: PANE_PREVIEW_LINES per live run is what made
	// a poll expensive, so the number of detailed runs must not scale with the
	// number of runs.
	const text = renderAll(liveRows(40));
	assert.equal(detailCount(text), LIST_DETAIL_BUDGET);
	assert.equal(text.split("\n\n").length, 40, "every run is still represented");
});

test("compact is cheaper than the budgeted list for the same runs", () => {
	const runs = liveRows(40);
	const budgeted = renderAll(runs);
	const compact = renderAll(runs, { compact: true });
	// The blocks are ~20 lines each and there are two of them: that is the cost the
	// budget caps, and what compact declines to pay at all.
	assert.equal(contentLines(budgeted), 40 - LIST_DETAIL_BUDGET + LIST_DETAIL_BUDGET * contentLines(detailBlock(runs[0])));
	assert.equal(contentLines(compact), 40);
	assert.ok(compact.length < budgeted.length);
});

test("the budget goes to the newest runs that hold a pane", () => {
	const runs = [
		row({ id: "old-live", createdAt: 1, detailWorthy: true }),
		row({ id: "settled", createdAt: 2, detailWorthy: false }),
		row({ id: "new-live", createdAt: 3, detailWorthy: true }),
		row({ id: "newest-live", createdAt: 4, detailWorthy: true }),
	];
	// Newest first, and a run with no pane never takes a slot while one with a
	// pane can.
	assert.deepEqual(
		selectDetailRuns(runs).map((run) => run.id),
		["newest-live", "new-live"],
	);
	const text = renderAll(runs);
	assert.ok(text.includes("DETAIL newest-live"));
	assert.ok(text.includes("DETAIL new-live"));
	assert.ok(text.includes("settled  running"), "the settled run is still listed, as a one-liner");
});

test("a queued run does not take the budget from the children that are running", () => {
	// Queued runs are always the NEWEST (they were requested last and are waiting
	// for a slot), and they have no child, no pane and no activity. Ranking them
	// alongside running runs hands the whole budget to the rows with nothing to
	// show — the opposite of what a poll needs.
	const runs = [
		row({ id: "run-0", status: "running", createdAt: 1, detailWorthy: true }),
		row({ id: "run-1", status: "running", createdAt: 2, detailWorthy: true }),
		row({ id: "queued-a", status: "queued", createdAt: 3, detailWorthy: false }),
		row({ id: "queued-b", status: "queued", createdAt: 4, detailWorthy: false }),
	];
	assert.deepEqual(
		selectDetailRuns(runs).map((run) => run.id),
		["run-1", "run-0"],
	);
});

test("the budget is keyed on rows, not on ids", () => {
	// Unreachable with uuid ids, but the cap is about rows: keying it on an id
	// would let every row sharing one render in full and blow the budget.
	const duplicated = [row({ id: "same" }), row({ id: "same" }), row({ id: "same" }), row({ id: "same" })];
	assert.equal(detailCount(renderAll(duplicated)), LIST_DETAIL_BUDGET);
});

test("a settled run still earns a block when nothing holds a pane", () => {
	// Otherwise a list of pure one-liners never says WHICH finished run is worth
	// the call that fetches its output.
	const runs = [row({ id: "old", createdAt: 1, detailWorthy: false }), row({ id: "new", createdAt: 2, detailWorthy: false })];
	assert.deepEqual(
		selectDetailRuns(runs).map((run) => run.id),
		["new"],
	);
});

test("a zero or empty selection returns nothing", () => {
	assert.deepEqual(selectDetailRuns(liveRows(3), 0), []);
	assert.deepEqual(selectDetailRuns([], 2), []);
});

test("omittedNote says what the budget left out", () => {
	// A bound that silently withholds an answer is worse than a big one: a model
	// that cannot tell "left out" from "there is none" will not go and ask.
	const runs = liveRows(4);
	const seen: string[][] = [];
	const text = renderAll(runs, {
		omittedNote: (omitted) => {
			seen.push(omitted.map((run) => run.id));
			return `${omitted.length} runs were left out.`;
		},
	});
	assert.deepEqual(seen, [["run-0", "run-1"]]);
	assert.match(text, /\n\n2 runs were left out\.$/);
	assert.ok(text.startsWith("run-0  running"), "the note comes after the list, not instead of it");
});

test("omittedNote is told when the budget withheld nothing", () => {
	// index.ts decides the wording by counting the omitted runs, so the callback
	// has to be handed the truth even when that count is zero.
	let omitted: readonly ListRow[] | undefined;
	renderAll(liveRows(1), {
		omittedNote: (rows) => {
			omitted = rows;
			return rows.length === 0 ? undefined : "left out";
		},
	});
	assert.deepEqual(omitted?.map((run) => run.id), []);
});

test("the caller's row order is preserved", () => {
	// The list is sorted oldest-first by the caller; the budget must not reorder it,
	// or a poll would read as though runs finished in a different order than they did.
	const ids = renderAll(liveRows(4))
		.split("\n\n")
		.filter((block) => block.trim().length > 0)
		.map((block) => (block.startsWith("DETAIL ") ? block.split("\n")[0].slice("DETAIL ".length) : block.slice(0, 5)));
	assert.deepEqual(ids, ["run-0", "run-1", "run-2", "run-3"]);
});

test("listRow projects a run onto the row the list view renders", () => {
	assert.deepEqual(listRow(makeRunRecord()), {
		id: "run-x",
		status: "running",
		durationText: "4s",
		usageText: "1.5k tok · 1 turn",
		createdAt: 5,
		detailWorthy: true,
	});
});

test("a queued run has no elapsed time, no usage and no pane", () => {
	const projected = listRow(makeRunRecord({ status: "queued", startedAt: undefined, finishedAt: undefined, usage: undefined }));
	assert.equal(projected.durationText, undefined);
	assert.equal(projected.usageText, undefined);
	// It holds a QUEUE SLOT, not a child, so it must not compete for the detail
	// budget with the runs that have a pane. showsPane is deliberately narrower
	// than holdsChild; the test pins the difference that matters here.
	assert.equal(projected.detailWorthy, false);
	assert.equal(showsPane("running"), true);
	assert.equal(showsPane("interrupted"), true);
	assert.equal(showsPane("queued"), false);
});

test("the note carries a failure reason and the route to a live child", () => {
	// These are the two things a one-line row cannot send you to get: everything
	// else is one subagent_status({ id }) away.
	assert.equal(listRow(makeRunRecord({ status: "failed", error: "boom\nstack" })).note, "! boom");
	assert.equal(listRow(makeRunRecord({ status: "failed", error: "x".repeat(80) })).note, `! ${"x".repeat(59)}…`);
	assert.equal(listRow(makeRunRecord()).note, undefined, "a healthy run has nothing to add to a headline");

	const interrupted = listRow(makeRunRecord({ status: "interrupted" }));
	assert.equal(interrupted.note, "attach: pi --attach-subagent 'run-x'");
	assert.equal(interrupted.detailWorthy, true, "and it is worth a full block while the budget allows");
});