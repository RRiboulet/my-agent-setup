// Bounded rendering for the `subagent_status` LIST view.
//
// There is no blocking wait, so polling `subagent_status` is the only way a model
// collects a result — which makes each poll a cost the model pays every turn.
// The list used to render every live run in full, pane included
// (PANE_PREVIEW_LINES = 18 lines each), so four concurrent runs cost roughly 70
// lines of raw terminal noise per poll: mostly a TUI redrawing itself, which
// says nothing a status line does not.
//
// Three rules, and the split between them matters:
//
//   - a TOTAL detail budget, not a per-run one. At most `LIST_DETAIL_BUDGET`
//     runs get the full block (pane, activity, tmux, attach); every other run is
//     one line — id, status, elapsed, usage — which is what a poll actually
//     needs to decide which run to inspect. With one or two runs in the session
//     nothing changes, so the common case keeps every detail it had.
//   - the budget goes to the runs that HOLD a pane first, newest first. A live
//     child's pane is the only view of that child there is, and the newest is
//     the one a model that just launched something is asking about. `queued` is
//     deliberately NOT a candidate: it has no child and no pane, and queued runs
//     are always the newest, so admitting them would hand the whole budget to
//     the runs that have nothing to show. When nothing holds a pane the newest
//     run still earns a block, because a list of one-liners cannot say which
//     finished run is worth the call that fetches its output.
//   - `compact`, which drops the detail blocks entirely: one line per run, no
//     pane rendered, for a caller that only wants to know whether anything
//     finished. The watcher still captures panes on its own tick, so this saves
//     the MODEL tokens, not a tmux call.
//
// `omittedNote` exists because a bound silently withholds something. When the
// caller asked for more detail than the budget can carry (today: the finished
// runs' output), it gets to say how much was left out — a model that cannot tell
// an omitted answer from a missing one will not go and ask for it.
//
// This module is deliberately structural — it knows id, status and preformatted
// durations/usage, nothing about `RunRecord`. `index.ts` does the formatting and
// the pane capture; keeping the policy here makes it testable without tmux.

/** How many runs, across the whole list, may get the full block. */
export const LIST_DETAIL_BUDGET = 2;

/** What the list view needs from a run to render it. Preformatted on purpose. */
export interface ListRow {
	id: string;
	status: string;
	/** Elapsed time, already formatted. Undefined for a run that never started. */
	durationText?: string;
	/** Token/cost summary, already formatted. Undefined until usage is parsed. */
	usageText?: string;
	/** When the run was requested; the newest such run is the likeliest subject. */
	createdAt: number;
	/** True when this run holds a pane, so a detail block would show something. */
	detailWorthy: boolean;
	/**
	 * The one thing that must survive onto the one-line row: a failure reason, or
	 * the route to a child that is still alive. Everything else the full block
	 * carries (task, model, attach command) is one `subagent_status({ id })` away.
	 */
	note?: string;
}

/**
 * The run's headline: `id  status · elapsed · usage`.
 *
 * Shared with `runSummary`, which emits it as its first line, so a run reads the
 * same whether or not it earned a detail block. Two copies of this string would
 * be free to drift, and the drift would be invisible until a rendered list
 * disagreed with itself.
 */
export function runHeadline(row: Pick<ListRow, "id" | "status" | "durationText" | "usageText">): string {
	return `${row.id}  ${row.status}${row.durationText ? ` · ${row.durationText}` : ""}${row.usageText ? ` · ${row.usageText}` : ""}`;
}

/** The one-line form: the headline plus whatever `note` the caller set. */
export function compactRowText(row: ListRow): string {
	const headline = runHeadline(row);
	return row.note ? `${headline} — ${row.note}` : headline;
}

/**
 * Pick the runs that earn a detail block, honouring the budget across the list.
 *
 * Runs that hold a pane win, newest first; with none of those, the newest run
 * takes the slot. Equal `createdAt` values keep the caller's order, so a
 * timestamp collision is resolved deterministically rather than by sort
 * implementation.
 */
export function selectDetailRuns<T extends ListRow>(runs: readonly T[], budget = LIST_DETAIL_BUDGET): T[] {
	if (budget <= 0 || runs.length === 0) return [];
	const newestFirst = [...runs].sort((a, b) => b.createdAt - a.createdAt);
	const withPane = newestFirst.filter((run) => run.detailWorthy).slice(0, budget);
	return withPane.length > 0 ? withPane : [newestFirst[0]];
}

/**
 * Render the whole list under a budget, in the caller's order.
 *
 * `renderDetail` produces the full block for a run that earned one; every other
 * run gets `compactRowText`. `compact: true` skips the budget entirely — no run
 * is ever detailed, so no pane is rendered. `omittedNote`, when given, is called
 * with the runs that did NOT earn a block so the caller can report what the
 * bound withheld.
 */
export function renderRunList<T extends ListRow>(options: {
	runs: readonly T[];
	renderDetail: (run: T) => string;
	compact?: boolean;
	/** Words for what the budget left out; omitted entirely when nothing was. */
	omittedNote?: (omitted: readonly T[]) => string | undefined;
}): string {
	const detailed = options.compact === true ? [] : selectDetailRuns(options.runs);
	// Identity, not id: the cap is about rows, and keying it on an id would let
	// two rows sharing one render in full and blow the budget.
	const isDetailed = new Set<T>(detailed);
	const text = options.runs
		.map((run) => (isDetailed.has(run) ? options.renderDetail(run) : compactRowText(run)))
		.join("\n\n");
	const omitted = options.runs.filter((run) => !isDetailed.has(run));
	const note = options.omittedNote?.(omitted);
	return note ? `${text}\n\n${note}` : text;
}