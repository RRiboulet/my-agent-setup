// The live subagent widget.
//
// The classifier (status.ts) decides what each run is doing; this module decides
// how that looks. Two layers, deliberately:
//
//   - `renderStatusRows` is a pure function from rows to strings. All the wording
//     and capping lives there, so it can be unit tested without a terminal.
//   - `createStatusWidget` is the pi component. Rendering holds no state: every
//     render asks `getRows()` again, so the extension only has to poke the TUI
//     when something changed. The one state it does keep is the in-flight press
//     of a click, bounded by the next press or click.
//
// The widget is display/input-only. It cannot finish, fail or interrupt a run.
// The one input it acts on is a left click on a row — only when the caller
// supplies `onRowClick` — and all it does is report that row. A handled press is
// consumed, so pi's text selection does not start on the strip.

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { MouseRegion, truncateToWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

import type { SubagentStatusKind } from "./status.ts";

/** Most runs shown at once: the widget is a glance, not a listing. */
export const MAX_WIDGET_ROWS = 4;
export const MAX_TASK_LENGTH = 60;

export interface StatusRow {
	/**
	 * Full run id. The click handler reports this so the caller can open that run;
	 * `id` is only the display form of the same value, so the two must agree.
	 */
	runId: string;
	/** Short run id — the first 8 characters of `runId`. The widget's glance form. */
	id: string;
	/** First line of the task, already truncated by the caller or trimmed here. */
	task: string;
	kind: SubagentStatusKind;
	/** Total run time, e.g. "2m". */
	elapsedText: string;
	/** Kind-specific qualifier, e.g. "active (bash 45s)". Empty when there is none. */
	detail: string;
}

// Every kind gets its own glyph. The `queued` and `starting` pair is the reason:
// they are different states that both read as "not really going yet", and one
// glyph for both would make a run waiting for a concurrency slot look like a
// child that has booted but not begun work. Colour carries the same distinction
// the way the rest of pi's chrome does.
const ICONS: Record<SubagentStatusKind, { icon: string; color: ThemeColor }> = {
	queued: { icon: "◦", color: "warning" },
	starting: { icon: "◔", color: "warning" },
	active: { icon: "●", color: "warning" },
	waiting: { icon: "◌", color: "muted" },
	stalled: { icon: "⏳", color: "error" },
	interrupted: { icon: "‖", color: "warning" },
};

function truncateTask(task: string): string {
	const collapsed = task.replace(/\s+/g, " ").trim();
	return collapsed.length <= MAX_TASK_LENGTH ? collapsed : `${collapsed.slice(0, MAX_TASK_LENGTH - 1)}…`;
}

/**
 * The rows that survive the cap. `slice` truncates a fractional cap, so this is
 * the single place that decides how many rows are visible — the renderer and the
 * click handler both use it, and a cap of 1.9 must not make `y=1` (the overflow
 * line) clickable.
 */
function cappedRows(rows: StatusRow[], limit: number): StatusRow[] {
	return rows.slice(0, Math.max(0, Math.trunc(limit)));
}

/**
 * Render the rows, capped with an overflow count.
 *
 * The cap is applied first and the task text trimmed per row afterwards: a
 * glance at the widget should never push the editor around, and the rows the
 * caller ordered first are the ones that survive.
 */
export function renderStatusRows(rows: StatusRow[], limit = MAX_WIDGET_ROWS, theme?: Theme): string[] {
	const visible = cappedRows(rows, limit);
	const lines = visible.map((row) => {
		const parts = [row.detail || row.kind, row.elapsedText, truncateTask(row.task)].filter(Boolean);
		const { icon, color } = ICONS[row.kind];
		const line = `${icon} ${row.id}  ${parts.join(" · ")}`;
		return theme ? theme.fg(color, line) : line;
	});
	if (rows.length > visible.length) {
		lines.push(theme ? theme.fg("muted", `  +${rows.length - visible.length} more`) : `  +${rows.length - visible.length} more`);
	}
	return lines;
}

export interface StatusWidgetOptions {
	/** Called on every render. Must be cheap and must not mutate anything. */
	getRows: () => StatusRow[];
	maxRows?: number;
	/** Called once, when the widget is installed, with the TUI that drives it. */
	onCreate?: (tui: TUI) => void;
	/**
	 * Called with the row under a left click. When omitted the widget is not
	 * wrapped in a MouseRegion at all: there is no handler and no per-install
	 * gesture state, so pi's text selection is untouched.
	 */
	onRowClick?: (row: StatusRow) => void;
}

/**
 * Build the component factory to hand to `ctx.ui.setWidget`.
 *
 * The factory is called once, when the widget is installed; from then on the
 * extension calls `requestRender()` on the TUI it is handed here. Rendering
 * caches nothing, so a stale row cannot outlive the state that produced it; the
 * click handler keeps only the in-flight press.
 */
export function createStatusWidget(options: StatusWidgetOptions): (tui: TUI, theme: Theme) => Component {
	const maxRows = options.maxRows ?? MAX_WIDGET_ROWS;
	return (tui: TUI, theme: Theme): Component => {
		options.onCreate?.(tui);
		const inner: Component = {
			render: (width: number): string[] =>
				renderStatusRows(options.getRows(), maxRows, theme).map((line) => truncateToWidth(line, width)),
			// Rendering caches nothing, so there is nothing to invalidate.
			invalidate: () => undefined,
		};
		const onRowClick = options.onRowClick;
		if (!onRowClick) return inner;

		// The last handled press: the row itself (not its index, so a reorder while
		// the child works cannot open a different run) and the local y it was
		// captured at, which the click must match. This is deliberately NOT cleared
		// on release: pi dispatches release to the press target and only then
		// synthesises the click, so clearing there would drop every click. Any press
		// clears it first, so a click with no press of ours behind it — pi's
		// text-selection path synthesises one after an unhandled press — finds
		// nothing to fire.
		let pressed: { row: StatusRow; y: number } | undefined;
		return new MouseRegion(inner, (event: TuiMouseEvent) => {
			if (event.type === "press") {
				pressed = undefined;
				if (event.button !== "left") return undefined;
				const visible = cappedRows(options.getRows(), maxRows);
				const row = event.y >= 0 ? visible[event.y] : undefined;
				if (row) {
					pressed = { row, y: event.y };
					return { handled: true };
				}
				return undefined;
			}
			if (event.type === "click" && event.button === "left") {
				const press = pressed;
				pressed = undefined;
				if (press && event.y === press.y) {
					onRowClick(press.row);
					return { handled: true };
				}
			}
			// release, move, drag, wheel and non-left buttons: not ours.
			return undefined;
		});
	};
}