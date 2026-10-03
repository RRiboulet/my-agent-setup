// The live subagent widget.
//
// The classifier (status.ts) decides what each run is doing; this module decides
// how that looks. Two layers, deliberately:
//
//   - `renderStatusRows` is a pure function from rows to strings. All the wording
//     and capping lives there, so it can be unit tested without a terminal.
//   - `createStatusWidget` is the pi component. It holds no state: every render
//     asks `getRows()` again, so the extension only has to poke the TUI when
//     something changed.
//
// The widget is display-only. Nothing here can finish, fail or interrupt a run.

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { SubagentStatusKind } from "./status.ts";

/** Most runs shown at once: the widget is a glance, not a listing. */
export const MAX_WIDGET_ROWS = 4;
export const MAX_TASK_LENGTH = 60;

export interface StatusRow {
	/** Short run id — the widget is a glance, so the first four bytes identify the row. */
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
 * Render the rows, capped with an overflow count.
 *
 * The cap is applied first and the task text trimmed per row afterwards: a
 * glance at the widget should never push the editor around, and the rows the
 * caller ordered first are the ones that survive.
 */
export function renderStatusRows(rows: StatusRow[], limit = MAX_WIDGET_ROWS, theme?: Theme): string[] {
	const visible = rows.slice(0, Math.max(0, limit));
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
}

/**
 * Build the component factory to hand to `ctx.ui.setWidget`.
 *
 * The factory is called once, when the widget is installed; from then on the
 * extension calls `requestRender()` on the TUI it is handed here. Nothing is
 * cached, so a stale row cannot outlive the state that produced it.
 */
export function createStatusWidget(options: StatusWidgetOptions): (tui: TUI, theme: Theme) => Component {
	const maxRows = options.maxRows ?? MAX_WIDGET_ROWS;
	return (tui: TUI, theme: Theme): Component => {
		options.onCreate?.(tui);
		return {
			render: (width: number): string[] =>
				renderStatusRows(options.getRows(), maxRows, theme).map((line) => truncateToWidth(line, width)),
			// Nothing is cached, so there is nothing to invalidate.
			invalidate: () => undefined,
		};
	};
}