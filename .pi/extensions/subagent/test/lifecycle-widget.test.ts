// Live widget (local patch 14): install, refresh, clear, ordering and click.
//
// The widget is the only surface that updates between turns, and it is driven
// by a state it does not own: the run index, the activity snapshot, and tmux.
// So the assertions are about what a user reads at a glance — the row follows
// the child, an interrupted run never reads as active, elapsed time is measured
// from the start and not the queue wait, and the strip disappears when the last
// run finishes. The pane/stall cases live in `lifecycle-activity.test.ts`.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { activitySnapshot, createHarness, withHarness } from "./lifecycle-harness.ts";

test("the widget is installed above the editor, only while a run is live, and only in TUI mode", async () => {
	await withHarness(undefined, async (h) => {
		assert.deepEqual(h.widgetCalls, [], "an idle session never touches the widget");

		await h.call("subagent", { task: "show a row" });
		assert.deepEqual(
			h.widgetCalls.at(-1),
			{ key: "subagent-status", hasContent: true, placement: "aboveEditor" },
			"installed lazily, when the first run goes live",
		);
		// A component factory, not a frozen string array: RPC ignores factories, so
		// the guard on ctx.mode is what keeps a dead widget out of RPC sessions.
		assert.equal(typeof h.renderWidget(), "object");
	});

	// RPC reports hasUI but forwards only string arrays, so a factory would be
	// dropped and the widget would never update.
	await withTempAgentDir(async () => {
		const harness = await createHarness({ mode: "rpc" });
		try {
			await harness.call("subagent", { task: "no widget here" });
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			assert.deepEqual(harness.widgetCalls, [], "no widget in a mode that cannot render one");
		} finally {
			await harness.shutdown();
		}
	});
});

test("a live run shows a row, and it follows the child's activity", async () => {
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		await h.call("subagent", { task: "investigate the flaky test" });
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		const [first] = h.renderWidget() as string[];
		assert.match(first, /starting · /, first);
		assert.match(first, /investigate the flaky test/, "the task tells the user which run this is");

		await h.writeActivity((await h.readRuns())[0], activitySnapshot((await h.readRuns())[0]));
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("active "));
		assert.match((h.renderWidget() as string[])[0], /active \d+s \(bash\) · /, h.renderWidget()?.join("\n"));
	});
});

test("confirming an interrupt updates the widget within one watcher tick", async () => {
	// noteInterrupt is the only writer of the interrupted status, so it is the
	// only thing that can refresh the widget at that moment. Asserted inside a
	// single 500ms watcher window: waiting longer would let the 1s ticker paper
	// over the omission.
	await withHarness({ interruptConfirmMs: "5000" }, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		h.renderWidget();
		setTimeout(() => {
			void h.writeInterrupt(run).catch(() => undefined);
		}, 50);

		await h.call("subagent_interrupt", { id: run.id });
		const row = (h.renderWidget() as string[])[0] as string;
		assert.match(row, /interrupted/, `the widget must not keep claiming the run is active: ${row}`);
	});
});

test("an interrupted run reads as interrupted even while the child works again", async () => {
	// The authoritative state beats the inference. If the widget said "active"
	// here, the user would see a contradiction with subagent_status, and the agent
	// reading it could believe the run is progressing when it is not.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(() => (h.renderWidget() ?? [])[0]?.includes("interrupted"));
		assert.match((h.renderWidget() as string[])[0], /‖ .*interrupted · /);

		// Even a fresh, actively-working snapshot must not flip the row.
		await h.writeActivity(run, activitySnapshot(run));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.match((h.renderWidget() as string[])[0], /interrupted/);
	});
});

test("the ticker keeps the widget alive when the watcher cannot", async () => {
	// The 500ms watcher is not a reliable ticker: each of its tmux calls can take
	// seconds when tmux is slow, so between passes nothing would move the elapsed
	// times or notice a stall. execDelayMs makes every watcher pass slow enough
	// that the 1s ticker is the only thing that can refresh within the window
	// asserted here — the previous version of this test passed with the ticker
	// removed, because the watcher was refreshing anyway.
	await withHarness({ execDelayMs: 2_000 }, async (h) => {
		await h.call("subagent", { task: "slow tmux, live widget" });
		await waitFor(() => (h.renderWidget() ?? []).length === 1);
		h.renderWidget(); // install the component so requestRender is observable
		const before = h.renderRequests();

		// A watcher pass takes 4s+ here, so three refreshes inside 2.5s can only
		// have come from the ticker.
		await waitFor(() => h.renderRequests() >= before + 3, 2_500);
	});
});

test("the widget is cleared when the last run finishes", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "finish and clear" })).details as unknown as RunRecord;
		await h.writeResult(run, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		// Wait for the CLEAR, not for a simultaneity with the status: `settleRun`
		// persists first and refreshes the widget afterwards, so a read of the index
		// that lands between the two is a correct status with the strip still up.
		await waitFor(() => h.widgetCalls.at(-1)?.hasContent === false);
		assert.deepEqual(
			h.widgetCalls.at(-1),
			{ key: "subagent-status", hasContent: false, placement: undefined },
			"a finished run must not leave a row behind the editor",
		);
		assert.equal(h.renderWidget(), undefined, "nothing left to render");
	});
});

test("interrupted rows sort last, so they cannot push a live run out of view", async () => {
	// Interrupted runs are long-lived by design (one holds its slot until it is
	// cancelled), so ordering purely by age lets four of them fill every row and
	// hide a run the user just started.
	await withHarness({ maxConcurrent: "4" }, async (h) => {
		const kept = [];
		for (const name of ["first", "second", "third", "fourth"]) {
			const run = (await h.call("subagent", { task: `${name} interrupted run` })).details as unknown as RunRecord;
			await h.writeInterrupt(run);
			await waitFor(async () => (await h.readRuns()).find((entry) => entry.id === run.id)?.status === "interrupted");
			kept.push(run.id);
		}
		assert.equal((await h.readRuns()).filter((run) => run.status === "interrupted").length, 4);

		const started = (await h.call("subagent", { task: "the run I just launched" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).length === 5, 8_000);
		const rows = h.renderWidget() as string[];
		assert.equal(rows.length, 5, "four rows plus the overflow line");
		assert.match(rows[0] as string, new RegExp(started.id.slice(0, 8)), `the newest live run must be visible: ${rows.join(" | ")}`);
		assert.match(rows[1] as string, new RegExp(kept[0]?.slice(0, 8) as string), `interrupted runs are shown, just after the live one: ${rows.join(" | ")}`);
	});
});

test("a run's elapsed time starts when it starts, not when it was queued", async () => {
	// subagent_status and /subagents both measure from run.startedAt. If the
	// widget measured from createdAt it would count the queue wait forever, and two
	// surfaces on screen would disagree about one number.
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "holds the slot" })).details as unknown as RunRecord;
		const queued = (await h.call("subagent", { task: "waits in the queue" })).details as unknown as RunRecord;
		await waitFor(() => (h.renderWidget() ?? []).some((line) => line.includes(queued.id.slice(0, 8)) && /queued for a slot/.test(line)));

		// Hold the queue long enough that "counts the queue wait" and "counts only
		// the run" differ by more than the rounding noise a loaded box adds: with a
		// ~2.5 s queue, a widget measuring from `createdAt` reports 2s or more, while
		// one measuring from `startedAt` reports 0s or 1s.
		await new Promise((resolve) => setTimeout(resolve, 2_500));

		// Free the slot so the queued run actually starts, then wait for the WIDGET to
		// say so: the run record flips first and the widget refreshes on its own
		// ticker, so asserting on a row read too early measures the refresh lag rather
		// than what the widget reports about a started run (it said "queued for a slot
		// · 3s" under load, which is correct for a queued row).
		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === queued.id)?.status === "running");
		await waitFor(() => {
			const line = (h.renderWidget() ?? []).find((rendered) => rendered.includes(queued.id.slice(0, 8)));
			return Boolean(line && !/queued for a slot/.test(line));
		});

		const row = (h.renderWidget() as string[]).find((line) => line.includes(queued.id.slice(0, 8))) as string;
		const elapsed = row?.match(/· (\d+s|[0-9]+m[^·]*) · /)?.[1];
		const elapsedSeconds = Number(/(\d+)s/.exec(elapsed ?? "")?.[1]);
		assert.ok(
			Number.isFinite(elapsedSeconds) && elapsedSeconds <= 1,
			`a run that just started must not report its ~2.5 s queue wait as elapsed time: ${row}`,
		);

		// And the widget agrees with subagent_status, which measures the same thing.
		const status = await h.call("subagent_status", { id: queued.id });
		assert.match(status.text, new RegExp(`${queued.id}\\s+running · \\d+s`), status.text);
	});
});

test("clicking a live widget row binds Escape and launches the panel detached", async () => {
	// The wiring test: installWidget must pass onRowClick, and the click must
	// reach openSubagentPanel. The guards themselves are covered in panel.test.ts;
	// this proves the seam between the widget and the extension exists at all, and
	// that the binding happens before the popup is launched.
	const launches: { command: string; args: string[]; options: unknown; execCallsAtLaunch: number }[] = [];
	try {
		await withHarness(undefined, async (h) => {
			__test__.setPanelLauncher((command, args, options) =>
				launches.push({ command, args, options, execCallsAtLaunch: h.execCalls.length }),
			);
			await h.call("subagent", { task: "long task" });
			await waitFor(() => h.renderWidget() !== undefined, 10_000);

			await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
				h.clickWidgetRow(0);
				await waitFor(() => launches.length > 0);
			});

			assert.equal(launches.length, 1);
			const launch = launches[0] as (typeof launches)[number];
			assert.equal(launch.command, "tmux");
			assert.deepEqual(launch.options, { detached: true, stdio: "ignore" });
			assert.ok(
				h.execCalls.slice(0, launch.execCallsAtLaunch).some((call) => call.args.includes("detach-client")),
				"Escape is bound on the subagent server before the popup launches",
			);
			assert.deepEqual(h.notifications, [], "a click on a live row is silent");
		});
	} finally {
		__test__.setPanelLauncher();
	}
});
