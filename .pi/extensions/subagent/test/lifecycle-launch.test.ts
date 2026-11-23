// Launch, queueing and the parent's management tools: `subagent` itself,
// `subagent_status` (list, one run, the pane budget), `subagent_cancel` and
// `subagent_clean`.
//
// This is the front door of the extension and the only surface a model can
// reach without a live run, so the assertions are about what the tool says and
// what tmux command it produced. The two harness self-checks stay here because
// they guard the fake this whole directory drives: a harness that quietly
// exercised the child branch, or that answered a pane call with a version
// string, would make every other file's green meaningless.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { LIST_DETAIL_BUDGET } from "../listview.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { createHarness, withHarness } from "./lifecycle-harness.ts";

test("the harness exercises the parent branch even inside a pi subagent child", async () => {
	// This guards the harness, not the extension: createHarness clears
	// PI_TMUX_SUBAGENT_CHILD, which the extension factory branches on. Without
	// that, every test would silently register the child reporter instead of the
	// parent tools. Re-run the suite with PI_TMUX_SUBAGENT_CHILD=1 in the ambient
	// environment to check this holds.
	await withEnv(
		{ PI_TMUX_SUBAGENT_CHILD: "1", PI_TMUX_SUBAGENT_RESULT: "/tmp/should-not-be-used.jsonl" },
		async () => {
			await withTempAgentDir(async () => {
				const harness = await createHarness();
				try {
					assert.ok(harness.tools.has("subagent"), "parent tools are registered");
					assert.ok(harness.tools.has("subagent_status"), "parent tools are registered");
				} finally {
					await harness.shutdown();
				}
			});
		},
	);
});

test("the fake tmux does not read a socket path containing '-V' as the version probe", async () => {
	// The lifecycle flake: `mkdtemp` can name the agent dir `subagent-test-Vxxxxx`,
	// so the socket path embedded in every tmux argv contains "-V". The mock used
	// to recognise the version call with `joined.includes("-V")`, which then
	// answered EVERY tmux call with "tmux 3.3a": `pane_dead` never read as "1",
	// the pane-probe hook never fired, and a run whose result arrives in that
	// window ("a result that lands during the pane probe still wins", in
	// lifecycle-result.test.ts) polled forever and timed out at 30s. Recognise the
	// version call on its own argv, never on a substring of a joined line.
	await withTempAgentDir(async () => {
		const harness = await createHarness();
		try {
			const exec = harness.pi.exec as (
				command: string,
				args: string[],
			) => Promise<{ code: number; stdout: string }>;
			const socket = "/tmp/subagent-test-Vabcde/tmux-subagents.sock";

			const pane = await exec("tmux", ["-S", socket, "capture-pane", "-p", "-J", "-t", "pi-agent-x:0.0"]);
			assert.equal(pane.stdout, "child working\n", "a pane call is a pane call, whatever the path spells");

			const dead = await exec("tmux", ["-S", socket, "display-message", "-p", "-t", "pi-agent-x:0.0", "#{pane_dead}"]);
			assert.equal(dead.stdout, "0", "a pane_dead probe answers pane_dead, not a version");

			const version = await exec("tmux", ["-V"]);
			assert.equal(version.stdout, "tmux 3.3a");
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent launches a child in a detached tmux session and returns immediately", async () => {
	await withHarness(undefined, async (h) => {
		const { text, details } = await h.call("subagent", { task: "Do the thing" });
		const run = details as unknown as RunRecord;

		assert.match(text, new RegExp(`Subagent ${run.id} started\\.`));
		assert.ok(text.includes("Model: openrouter/parent/model (medium)"));
		assert.ok(text.includes(`pi --attach-subagent '${run.id}'`));

		const launched = h.execCalls.some((call) => call.command === "tmux" && call.args.includes("new-session"));
		assert.ok(launched, "a tmux session is created");
		const keys = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.ok(keys.length >= 2, "the child command is typed and submitted");
		const childCommand = keys
			.flatMap((call) => call.args)
			.find((arg) => typeof arg === "string" && arg.includes("--provider"));
		assert.ok(childCommand, "the child invocation carries the provider");
		// The role marker is written as a literal, beside the child-mode variables:
		// the orchestrator resolves it once at module load, so a later scrub of
		// PI_TMUX_SUBAGENT_CHILD cannot turn a delegated child back into a parent.
		assert.match(childCommand, /PI_ORCHESTRATOR_ROLE=worker/);

		const runs = await h.readRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].status, "running");
		assert.equal(runs[0].task, "Do the thing");
	});
});

test("subagent rejects an empty task and a missing cwd", async () => {
	await withHarness(undefined, async (h) => {
		await assert.rejects(() => h.call("subagent", { task: "   " }), /must not be empty/);
		await assert.rejects(() => h.call("subagent", { task: "x", cwd: "/definitely/not/here" }), /does not exist/);
	});
});

test("runs beyond the concurrency cap are queued and start when a slot frees", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "first" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "second" })).details as unknown as RunRecord;

		const runs = await h.readRuns();
		assert.equal(runs.find((run) => run.id === first.id)?.status, "running");
		assert.equal(runs.find((run) => run.id === second.id)?.status, "queued");

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

test("subagent_cancel kills the tmux session and is idempotent once terminal", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel me" })).details as unknown as RunRecord;
		const killed = await h.call("subagent_cancel", { id: run.id });
		assert.match(killed.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"the tmux session is killed",
		);

		const again = await h.call("subagent_cancel", { id: run.id });
		assert.match(again.text, /already cancelled/);
		await assert.rejects(() => h.call("subagent_cancel", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("subagent_status lists runs and inspects one", async () => {
	await withHarness(undefined, async (h) => {
		const empty = await h.call("subagent_status", {});
		assert.match(empty.text, /No subagent runs/);

		const run = (await h.call("subagent", { task: "inspect me" })).details as unknown as RunRecord;
		const listed = await h.call("subagent_status", {});
		assert.ok(listed.text.includes(run.id));
		assert.ok(listed.text.includes("inspect me"));

		const inspected = await h.call("subagent_status", { id: run.id });
		assert.ok(inspected.text.includes(`model: openrouter/parent/model (medium)`));
		await assert.rejects(() => h.call("subagent_status", { id: "nope" }), /Unknown subagent run/);
	});
});

test("the list view caps its pane output across the whole list", async () => {
	// Local patch 16. Polling this tool is the only way to collect a result, so the
	// list is a per-turn cost. It used to carry PANE_PREVIEW_LINES for EVERY live
	// run; now the pane budget is on the LIST, and the runs outside it get one line.
	await withHarness({ paneText: "CHILD-PANE" }, async (h) => {
		const ids: string[] = [];
		for (let index = 0; index < 4; index += 1) {
			const run = (await h.call("subagent", { task: `bounded ${index}` })).details as unknown as RunRecord;
			ids.push(run.id);
		}
		// Wait for the CONTENT of every pane: the watcher can record an empty capture
		// on an early tick, and a `pane !== undefined` check would let this race
		// ahead of the assertions below (a flake seen before it was tightened).
		await waitFor(async () => (await h.readRuns()).filter((run) => run.pane?.includes("CHILD-PANE")).length === 4);

		const listed = await h.call("subagent_status", {});
		for (const id of ids) assert.ok(listed.text.includes(id), `every run is listed: ${id}`);
		assert.equal(
			listed.text.split("CHILD-PANE").length - 1,
			2,
			`pane output is capped for the list as a whole, not per run (budget ${LIST_DETAIL_BUDGET}): ${listed.text}`,
		);
		assert.equal(listed.text.split("task: bounded").length - 1, 2);

		const compact = await h.call("subagent_status", { compact: true });
		assert.ok(!compact.text.includes("CHILD-PANE"), `compact carries no pane: ${compact.text}`);
		assert.ok(!compact.text.includes("task: bounded"), `compact carries no detail block: ${compact.text}`);
		assert.equal(
			compact.text.split("\n").filter((line) => line.trim().length > 0).length,
			4,
			`compact is one line per run, so every run appears exactly once: ${compact.text}`,
		);
		// A run that did not earn a block is still legible: id, status, then usage.
		assert.match(compact.text, new RegExp(`${ids[0]}  running`));
	});
});

test("include_output says which finished outputs the budget left out", async () => {
	// The list's budget caps the detail blocks, and the output lives inside one. A
	// bound that withholds an answer silently is worse than an expensive list: a
	// model that cannot tell "left out" from "there is none" will not go and ask.
	await withHarness(undefined, async (h) => {
		const ids: string[] = [];
		for (let index = 0; index < 3; index += 1) {
			const run = (await h.call("subagent", { task: `answer ${index}` })).details as unknown as RunRecord;
			ids.push(run.id);
			await h.writeResult(run, { version: 1, status: "completed", output: `ANSWER-${index}`, finishedAt: Date.now() });
		}
		await waitFor(async () => (await h.readRuns()).every((run) => run.status === "completed"));

		const listed = await h.call("subagent_status", { include_output: true });
		assert.equal(listed.text.split("ANSWER-").length - 1, 1, `one answer fits the budget: ${listed.text}`);
		assert.match(listed.text, /2 finished run\(s\) have output that this list's detail budget left out/);
		assert.match(listed.text, /subagent_status\(\{ id \}\)/, "and it says how to get the rest");

		// Each one is still reachable by id, which is the point of the note.
		for (const [index, id] of ids.entries()) {
			const inspected = await h.call("subagent_status", { id });
			assert.ok(inspected.text.includes(`ANSWER-${index}`), `${id} still has its answer`);
		}
	});
});

test("subagent_clean reaps finished runs but leaves active ones alone", async () => {
	await withHarness(undefined, async (h) => {
		const done = (await h.call("subagent", { task: "finishes" })).details as unknown as RunRecord;
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === done.id)?.status === "completed");

		const cleaned = await h.call("subagent_clean", {});
		assert.match(cleaned.text, /Cleaned 1 tmux session\(s\), deleted 0 run dir\(s\), skipped 1/);

		const stillThere = (await h.readRuns()).find((run) => run.id === active.id);
		assert.equal(stillThere?.status, "running");
	});
});

test("the single-run status path always returns the output, finished or not", async () => {
	// `subagent_wait` is the blocking path now; `subagent_status({ id })` still has
	// to be the right call for collecting a single finished run, with
	// include_output reserved for the list view where many answers would otherwise
	// arrive at once. `compact` is a list-view control for the same reason.
	await withHarness({ paneText: "LIVE-PANE-CONTENT" }, async (h) => {
		const live = (await h.call("subagent", { task: "collect me" })).details as unknown as RunRecord;
		// Wait for the CONTENT, not merely for a pane field: the watcher can record
		// an empty capture on an early tick, and `pane !== undefined` would then let
		// the test race ahead of the assertions below (a flake seen on main).
		await waitFor(async () => (await h.readRuns())[0].pane?.includes("LIVE-PANE-CONTENT") === true);
		for (const flag of [undefined, false, true]) {
			const inspected = await h.call("subagent_status", { id: live.id, ...(flag === undefined ? {} : { include_output: flag }) });
			assert.ok(inspected.text.includes("LIVE-PANE-CONTENT"), `a live run's pane is the only view of it (include_output: ${flag}): ${inspected.text}`);
		}

		await h.writeResult(live, {
			version: 1,
			status: "completed",
			output: "THE-ACTUAL-OUTPUT",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readRuns())[0].status === "completed");

		const withoutOutput = await h.call("subagent_status", { id: live.id, include_output: false });
		assert.ok(withoutOutput.text.includes("THE-ACTUAL-OUTPUT"), `the default call must return the answer: ${withoutOutput.text}`);
		assert.match(withoutOutput.text, /completed/);

		// A list-view flag must never reach the collection path.
		const compactInspect = await h.call("subagent_status", { id: live.id, compact: true });
		assert.ok(compactInspect.text.includes("THE-ACTUAL-OUTPUT"), `compact does not apply to an id: ${compactInspect.text}`);
	});
});
