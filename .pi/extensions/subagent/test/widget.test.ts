// Unit tests for the live widget's rendering (local patch 14).
//
// Risk covered: the widget is a fixed-height strip above the editor. A row that
// is too wide pushes the editor around, too many rows crowd out the prompt, and
// a row that says the wrong thing is worse than no widget — the user trusts it
// instead of subagent_status.

import assert from "node:assert/strict";
import { test } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import { createStatusWidget, MAX_TASK_LENGTH, MAX_WIDGET_ROWS, renderStatusRows, type StatusRow } from "../widget.ts";

function row(overrides: Partial<StatusRow> = {}): StatusRow {
	return {
		id: "1a2b3c4d",
		task: "investigate the flaky test",
		kind: "active",
		elapsedText: "2m",
		detail: "active (bash 45s)",
		...overrides,
	};
}

/** A stand-in for pi's Theme: `fg` returns the text unchanged. */
const theme = { fg: (_color: string, text: string) => text } as never;

test("a row reads as icon, id, detail, elapsed time and task", () => {
	assert.deepEqual(renderStatusRows([row()]), ["● 1a2b3c4d  active (bash 45s) · 2m · investigate the flaky test"]);
});

test("every kind gets its own marker, and no glyph means two things", () => {
	// The dashboard is on screen at the same time and already uses ◦ for queued
	// and ● for running. Reusing one of those for a different widget state would
	// make the two surfaces contradict each other.
	const kinds = [
		["queued", "◦"],
		["starting", "◔"],
		["active", "●"],
		["waiting", "◌"],
		["stalled", "⏳"],
		["interrupted", "‖"],
	] as const;
	const seen = new Set<string>();
	for (const [kind, icon] of kinds) {
		const [line] = renderStatusRows([row({ kind, detail: kind })]);
		assert.equal(line?.startsWith(`${icon} `), true, `${kind} must render as ${icon}, got: ${line}`);
		assert.equal(seen.has(icon), false, `${icon} is used for two states`);
		seen.add(icon);
	}
});

test("rows are coloured when a theme is supplied, plain when it is not", () => {
	// renderStatusRows is used both by the component (which has a theme) and by
	// the unit tests (which do not), so the theme is optional rather than faked.
	const marking = { fg: (color: string, text: string) => `<${color}>${text}</>` } as never;
	const coloured = renderStatusRows([row({ kind: "stalled" })], 4, marking);
	assert.equal((coloured[0] as string).startsWith("<error>"), true, `a stalled run is an error: ${coloured[0]}`);
	assert.equal((coloured[0] as string).endsWith("</>"), true);
	// The overflow line is muted, not part of the state.
	assert.equal(renderStatusRows([row(), row({ id: "bbbbbbbb" })], 1, marking)[1], "<muted>  +1 more</>");
	assert.equal(renderStatusRows([row({ kind: "stalled" })])[0], "⏳ 1a2b3c4d  active (bash 45s) · 2m · investigate the flaky test", "no theme, no markup");
});

test("a row without a detail still names its kind", () => {
	// Detail is derived state and can legitimately be empty; the row must not
	// collapse to a bare icon.
	const [line] = renderStatusRows([row({ kind: "interrupted", detail: "" })]);
	assert.equal(line, "‖ 1a2b3c4d  interrupted · 2m · investigate the flaky test");
});

test("rows are capped, with a count of what was hidden", () => {
	const rows = Array.from({ length: MAX_WIDGET_ROWS + 3 }, (_value, index) =>
		row({ id: `0000000${index}`, task: `task ${index}` }),
	);
	const lines = renderStatusRows(rows);
	assert.equal(lines.length, MAX_WIDGET_ROWS + 1, "the overflow line is extra, not a replacement");
	assert.match(lines.at(-1) as string, /\+3 more$/);
	// The rows kept are the FIRST ones: the caller ordered them.
	assert.match(lines[0] as string, /00000000/);
});

test("the cap is configurable and a zero cap still explains itself", () => {
	const rows = [row({ id: "aaaaaaaa" }), row({ id: "bbbbbbbb" })];
	assert.equal(renderStatusRows(rows, 1).length, 2);
	assert.deepEqual(renderStatusRows(rows, 0), ["  +2 more"]);
	assert.deepEqual(renderStatusRows([], 3), []);
});

test("the component honours its own row cap, not just the function's", () => {
	// maxRows is the option the extension does not pass (the default is right for
	// it), so it is the one path that could rot unnoticed.
	const rows = Array.from({ length: 6 }, (_value, index) => row({ id: `0000000${index}`, task: `task ${index}` }));
	const capped = createStatusWidget({ getRows: () => rows, maxRows: 2 })({ requestRender: () => undefined }, theme).render(200);
	assert.equal(capped.length, 3, "two rows plus the overflow line");
	assert.match(capped.at(-1) as string, /\+4 more/);
});

test("a long task is trimmed and collapsed to one line", () => {
	const long = "x".repeat(MAX_TASK_LENGTH + 40);
	const [line] = renderStatusRows([row({ task: long })]);
	assert.equal(line?.includes("…"), true);
	assert.equal(line?.includes("\n"), false, "a multi-line task must never break the widget");
	// Whitespace is collapsed so the row stays one line regardless of the task.
	const [collapsed] = renderStatusRows([row({ task: "a\n\n  b\tc" })]);
	assert.equal(collapsed, "● 1a2b3c4d  active (bash 45s) · 2m · a b c");
	assert.deepEqual(renderStatusRows([row({ task: "   " })]), ["● 1a2b3c4d  active (bash 45s) · 2m"]);
});

test("the component renders through getRows and truncates to width", () => {
	let rows = [row()];
	const renders: number[] = [];
	const component = createStatusWidget({ getRows: () => rows, onCreate: (tui) => renders.push(tui.marker ?? 0) })(
		{ marker: 1 } as never,
		theme,
	);
	// The fake theme renders as identity, so the assertions below stay readable.
	assert.deepEqual(renders, [1], "the TUI is handed over exactly once, at install");

	assert.deepEqual(component.render(200), ["● 1a2b3c4d  active (bash 45s) · 2m · investigate the flaky test"]);
	const wide = component.render(400)[0] as string;
	assert.equal(wide.includes("…"), false, "a wide terminal gets the whole row");

	// Nothing is cached: a later render must reflect later state.
	rows = [row({ kind: "stalled", detail: "stalled 3m" })];
	assert.match(component.render(200)[0] as string, /stalled 3m/);

	const narrow = component.render(12)[0] as string;
	assert.equal(visibleWidth(narrow) <= 12, true, `row must fit the viewport, got ${visibleWidth(narrow)} cells: ${narrow}`);
	// The component interface requires invalidate(); it must be callable and safe.
	component.invalidate();
});