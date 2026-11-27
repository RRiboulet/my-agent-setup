// Turn-level interrupt (local patch 13): `subagent_interrupt` and the
// "terminal but still alive" contract of the interrupted status.
//
// Escape stops the child's turn, not its process, so an interrupted run is
// terminal for the run and live for tmux: it keeps its concurrency slot, it is
// resumable only after a cancel, and a later result still finalizes it. The
// races here are real — the watcher folds the same marker the tool is polling
// for — so the harness hooks them into a deterministic order instead of hoping
// two timers land that way.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type RunRecord } from "../index.ts";
import { waitFor } from "./helpers.ts";
import { activitySnapshot, waitForCompletionMessage, withHarness } from "./lifecycle-harness.ts";

test("subagent_interrupt sends Escape to the child's pane and nothing else", async () => {
	await withHarness({ interruptConfirmMs: "300" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1, "one key, one send: a second Enter would submit whatever the child had typed");
		assert.deepEqual(sent[0].args.slice(-3), ["-t", run.tmuxTarget, "Escape"]);
		assert.ok(!sent[0].args.includes("-l"), "Escape is a key, not a literal string");
		assert.ok(!sent[0].args.includes("C-c"), "app.clear quits the child on the second press");
		assert.match(interrupted.text, /did not confirm an interrupt/, "an idle child cannot confirm");
		assert.ok(interrupted.text.includes(run.attachCommand), `unconfirmed message must interpolate attachCommand: ${interrupted.text}`);
		assert.ok(!interrupted.text.includes("${run.attachCommand}"), `unconfirmed message must not leak literal placeholder: ${interrupted.text}`);

		// The record says a request is outstanding, so subagent_status can explain
		// a run whose child never answered.
		const stored = (await h.readRuns())[0];
		assert.ok(stored.interruptRequestedAt);
		assert.equal(stored.status, "running");
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: Escape sent .*not confirmed yet/s);
	});
});

test("subagent_interrupt confirms once the child writes the marker", async () => {
	await withHarness({ interruptConfirmMs: "5000" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		// The child needs a moment to abort its provider stream, so the marker
		// lands after Escape was sent.
		setTimeout(() => {
			void h.writeInterrupt(run).catch(() => undefined);
		}, 300);

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		assert.match(interrupted.text, new RegExp(`Subagent ${run.id} interrupted\\.`));
		assert.match(interrupted.text, /attach/);
		assert.match(interrupted.text, /subagent_cancel/);

		const stored = (await h.readRuns())[0];
		assert.equal(stored.status, "interrupted");
		assert.equal(stored.interrupts, 1);
		assert.ok(stored.interruptedAt);
		assert.equal(stored.interruptRequestedAt, undefined, "a confirmed request is no longer outstanding");
		assert.equal(stored.finishedAt, undefined, "the child is still running, so elapsed time keeps counting");
		assert.equal(h.messages.length, 0, "an interrupted turn is not a completion");

		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: turn aborted/);
		assert.match(status.text, /idle at its prompt/);
	});
});

test("an interrupt the watcher folded first is still reported as confirmed", async () => {
	// Regression: the confirmation poll inferred staleness from `noteInterrupt`'s
	// return value. The watcher folds the SAME marker on its 500ms tick, so when it
	// won the race the tool read a marker that genuinely confirmed the interrupt
	// but reported "no new interrupt was reported" — telling the agent that a stop
	// it had just caused had not happened.
	//
	// `afterEscapeSent` blocks the Escape exec until the watcher has folded the
	// marker, so the race is deterministic: by the time the tool polls, the run is
	// already `interrupted` and `noteInterrupt` has nothing left to change.
	let foldMarker: (() => Promise<void>) | undefined;
	await withHarness(
		{
			interruptConfirmMs: "5000",
			afterEscapeSent: async () => {
				await foldMarker?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "watcher wins the race" })).details as unknown as RunRecord;
			foldMarker = async () => {
				await h.writeInterrupt(run);
				// Let the watcher drain the marker before the tool's poll resumes.
				await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
			};

			const interrupted = await h.call("subagent_interrupt", { id: run.id });
			assert.match(
				interrupted.text,
				new RegExp(`Subagent ${run.id} interrupted\\.`),
				`a marker newer than the baseline confirms even when the watcher folded it first: ${interrupted.text}`,
			);
			assert.doesNotMatch(interrupted.text, /no new interrupt was reported/);
			assert.equal((await h.readRuns())[0].interrupts, 1, "the interrupt is counted exactly once");
		},
	);
});

test("an interrupt whose run already ended is reported as superseded, not confirmed", async () => {
	// `noteInterrupt` refuses a run that is already terminal, so a newer marker
	// cannot fold. Claiming "interrupted" would assert a stop that is not the run's
	// state, and "stale" would blame the previous interrupt; the tool says what
	// actually happened instead.
	let lateRace: (() => Promise<void>) | undefined;
	await withHarness(
		{
			interruptConfirmMs: "5000",
			afterEscapeSent: async () => {
				await lateRace?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "ends before the abort lands" })).details as unknown as RunRecord;
			lateRace = async () => {
				await h.writeResult(run, { version: 1, status: "completed", output: "already done", finishedAt: Date.now() });
				await waitFor(async () => (await h.readRuns())[0].status === "completed");
				// A marker newer than the baseline, for a run that is already over.
				await h.writeInterrupt(run, { interrupts: 1, interruptedAt: Date.now() });
			};

			const outcome = await h.call("subagent_interrupt", { id: run.id });
			assert.match(outcome.text, /already reached completed/, outcome.text);
			assert.doesNotMatch(outcome.text, /Subagent .* interrupted\./, outcome.text);
			assert.equal((await h.readRuns())[0].status, "completed", "a terminal status is not resurrected by a later marker");
		},
	);
});

test("a stale marker cannot confirm a second interrupt", async () => {
	// Regression: the marker file is never deleted, so a second interrupt used to
	// read the FIRST one back within a millisecond and report "interrupted" while
	// the child kept streaming — the agent would then treat a live run as stopped.
	await withHarness({ interruptConfirmMs: "400" }, async (h) => {
		const run = (await h.call("subagent", { task: "steered twice" })).details as unknown as RunRecord;
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.doesNotMatch(second.text, new RegExp(`Subagent ${run.id} interrupted\\.`), second.text);
		assert.match(second.text, /no new interrupt was reported/, second.text);
		assert.match(second.text, /the previous interrupt/);
		assert.equal((await h.readRuns())[0].interrupts, 1, "the old marker must not be counted again");

		// Only a genuinely newer marker confirms. The double-escape guard blocks a
		// request sent inside pi's 500ms window, so wait it out first. A third
		// interrupt means the child's own counter reaches 3: rewriting the same
		// value is, correctly, still the second interrupt.
		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const lastRequest = (await h.readRuns())[0].interruptRequestedAt ?? 0;
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - lastRequest))));
		await h.writeInterrupt(run, { interrupts: 3, interruptedAt: Date.now() });
		const third = await h.call("subagent_interrupt", { id: run.id });
		assert.match(third.text, new RegExp(`Subagent ${run.id} interrupted\\.`), third.text);
		assert.equal((await h.readRuns())[0].interrupts, 3);
	});
});

test("two Escapes are never sent inside pi's double-escape window", async () => {
	// On an idle child pi reads two Escapes within 500ms as its double-escape
	// action and opens the tree selector, which blocks the prompt without
	// touching the turn. The second request must be refused instead of sent.
	await withHarness({ interruptConfirmMs: "0" }, async (h) => {
		const run = (await h.call("subagent", { task: "double escape" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1);
		assert.match(sent[0].args.at(-1) as string, /Escape/);

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.equal(h.execCalls.filter((call) => call.args.includes("send-keys")).length, 1, "no second Escape");
		assert.match(second.text, /double escape/);
	});
});

test("two interrupts reported by the child are both recorded", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "twice interrupted" })).details as unknown as RunRecord;
		const firstAt = Date.now();
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 1);

		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: firstAt + 5_000 });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /2 so far/);

		// A marker that goes backwards must not rewind the count or the timestamp.
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const stored = (await h.readRuns())[0];
		assert.equal(stored.interrupts, 2);
		assert.equal(stored.interruptedAt, firstAt + 5_000);
	});
});

test("a working child stops being described as idle", async () => {
	// The status stays interrupted, but the child can be driven again afterwards,
	// so the summary must not keep claiming it is sitting at the prompt.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "driven again" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
		assert.match((await h.call("subagent_status", { id: run.id })).text, /idle at its prompt/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");
		const after = await h.call("subagent_status", { id: run.id });
		assert.match(after.text, /has been driven again and is working/, after.text);
		assert.doesNotMatch(after.text, /idle at its prompt/);
	});
});

test("an unconfirmed Escape is forgotten once the child is seen working again", async () => {
	// Otherwise subagent_status keeps advertising "not confirmed yet" for an Escape
	// from minutes ago, and the field feeds the double-escape guard.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "ignores escape" })).details as unknown as RunRecord;
		await h.call("subagent_interrupt", { id: run.id });
		assert.ok((await h.readRuns())[0].interruptRequestedAt);
		assert.match((await h.call("subagent_status", { id: run.id })).text, /not confirmed yet/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].interruptRequestedAt === undefined);
		const status = await h.call("subagent_status", { id: run.id });
		assert.doesNotMatch(status.text, /not confirmed yet/);
	});
});

test("subagent_interrupt refuses a queued run and a finished one", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		await h.call("subagent", { task: "occupies the only slot" });
		const queued = (await h.call("subagent", { task: "never starts" })).details as unknown as RunRecord;
		await assert.rejects(() => h.call("subagent_interrupt", { id: queued.id }), /has not started yet/);

		const done = (await h.readRuns())[0];
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finished = await h.call("subagent_interrupt", { id: done.id });
		assert.match(finished.text, /already completed/);
		await assert.rejects(() => h.call("subagent_interrupt", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("a later result still finalizes an interrupted run", async () => {
	// The watcher must survive the status change: an interrupted child that is
	// steered onwards reports normally, and the run completes exactly as an
	// uninterrupted one would.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "corrected answer",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		// The completion message is a separate observable from the persisted status
		// (settleRun persists, then notifies), so wait for it instead of assuming it
		// landed on the same tick. See waitForCompletionMessage.
		await waitForCompletionMessage(h);
		const finalized = (await h.readRuns())[0];
		assert.equal(finalized.output, "corrected answer");
		assert.ok(finalized.finishedAt);
		assert.equal(finalized.interrupts, 1, "the interrupt history survives into the result");
		assert.equal(h.messages.length, 1, "and the run reports its completion normally");
	});
});

test("an interrupted run keeps its concurrency slot until it is cancelled", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "interrupted" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "queued behind it" })).details as unknown as RunRecord;
		await h.writeInterrupt(first);
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === first.id)?.status === "interrupted");

		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(
			(await h.readRuns()).find((run) => run.id === second.id)?.status,
			"queued",
			"the interrupted child still holds a process, so it still holds its slot",
		);

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

test("subagent_cancel releases an interrupted child", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel an interrupted run" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const cancelled = await h.call("subagent_cancel", { id: run.id });
		assert.match(cancelled.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"cancelling an interrupted run must kill the child that is still alive",
		);
		// And it is now genuinely finished, so a second cancel is a no-op.
		assert.match((await h.call("subagent_cancel", { id: run.id })).text, /already cancelled/);
	});
});
