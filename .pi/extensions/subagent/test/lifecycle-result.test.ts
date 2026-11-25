// Result finalisation: a child's `result.json` reaching the parent, and the
// usage a run burned being reported when it never reported a result.
//
// The late-result cases live here rather than with the failure paths: they are
// the other half of the same tick (a result that arrives as, or just after, the
// child's pane is gone must win over the failure).

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { getInterruptFilePath } from "../interrupt.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { waitForCompletionMessage, waitForRunStatus, withHarness, writeChildSession } from "./lifecycle-harness.ts";

test("a child result finalizes the run and notifies the main session", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "long task" })).details as unknown as RunRecord;
		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "the answer is 42",
			sessionFile: "/tmp/child.jsonl",
			provider: "openrouter",
			model: "child/model",
			thinking: "low",
			finishedAt: Date.now(),
		});

		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finalized = (await h.readRuns())[0];
		assert.equal(finalized.output, "the answer is 42");
		assert.equal(finalized.model, "child/model");
		assert.ok(finalized.finishedAt);

		const notification = await waitForCompletionMessage(h);
		assert.equal(notification?.message.customType, "subagent-result");
		// No options at all: neither `triggerTurn` nor `deliverAs`, so pi appends the
		// message rather than starting or queueing a turn. See the dedicated test
		// below and the comment in notifyCompletion for why.
		assert.equal(notification?.options, undefined);
		// The notification points at the run rather than inlining its output, and says
		// how to collect it: subagent_status({ id }) is now the only route.
		assert.ok(!String(notification?.message.content).includes("the answer is 42"));
		assert.ok(String(notification?.message.content).includes(`subagent_status({ id: "${finalized.id}" })`));
	});
});

test("a failed child result keeps the error visible", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "will fail" })).details as unknown as RunRecord;
		await h.writeResult(run, {
			version: 1,
			status: "failed",
			output: "",
			error: "provider exploded",
			finishedAt: Date.now(),
		});

		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		assert.match((await h.readRuns())[0].error ?? "", /provider exploded/);
		const notification = await waitForCompletionMessage(h);
		assert.ok(String(notification.message.content).includes("provider exploded"));
	});
});

test("a result caught mid-write is retried, and the finished one still finalizes", async () => {
	// A child from another build may publish result.json non-atomically, so a read
	// can land inside the write. Failing on the first bad read would kill that
	// child and throw away the finished file one tick later; the count is what
	// tells "caught in flight" from "will never parse".
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "partial result" })).details as unknown as RunRecord;
		await writeFile(run.resultPath, '{"version": 1, "status": "completed", "outp', "utf8");
		// Two ticks have already read the partial file and not failed the run.
		await waitFor(() => h.execCalls.filter((call) => call.args.includes("capture-pane")).length >= 2);
		assert.equal((await h.readRuns())[0].status, "running", "an unusable read is retried, not fatal on sight");
		await h.writeResult(run, { version: 1, status: "completed", output: "the answer", finishedAt: Date.now() });
		const completed = await waitForRunStatus(h, "completed", "a complete result still wins after a bad read");
		assert.equal(completed.output, "the answer");
	});
});

test("a complete result from a newer protocol version still finalizes", async () => {
	// The shape is the gate, not the version: rejecting on version equality would
	// throw away an answer this parent can read perfectly well.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "newer protocol" })).details as unknown as RunRecord;
		const raw = JSON.stringify({ version: 2, status: "completed", output: "from a newer build", finishedAt: Date.now() });
		await writeFile(run.resultPath, raw, "utf8");
		const completed = await waitForRunStatus(h, "completed", "a compatible shape from version 2 must still finalize");
		assert.equal(completed.output, "from a newer build");
	});
});

test("a run that finishes no longer wakes the main agent", async () => {
	// The notification used to be { deliverAs: "followUp", triggerTurn: true },
	// which pi turns into a full extra turn with the conversation re-sent. It is
	// now inert: sent, and recorded as a message, but with no options that let pi
	// take the turn.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "quiet finish" })).details as unknown as RunRecord;
		await h.writeResult(run, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		// settleRun persists the status before notifyCompletion sends, so the status
		// being visible does not mean the message has been recorded yet.
		await waitForCompletionMessage(h);

		assert.equal(h.messages.length, 1, "the model still learns of the completion");
		assert.deepEqual(h.messages[0]?.options, undefined, "no deliverAs and no triggerTurn: pi must not start or queue a turn");
		assert.match(String(h.messages[0]?.message.content), new RegExp(`subagent_status\\({ id: "${run.id}" }\\)`), "and it is told how to collect the result");
	});
});

test("a result written as the session disappears still wins", async () => {
	// The late-result re-read must run on the missing-target path too, or a child
	// that reported and exited in the same instant would be recorded as failed.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "reports as it exits" })).details as unknown as RunRecord;
		h.removeTarget();
		await h.writeResult(run, { version: 1, status: "completed", output: "got out in time", finishedAt: Date.now() });

		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		assert.equal((await h.readRuns())[0].output, "got out in time");
	});
});

test("a result that lands during the pane probe still wins", async () => {
	// The re-read in finalizeMissingChild covers the window between the watcher's
	// FIRST result read and its pane probe. A test that writes the result before
	// the first tick (the one above) never enters that window — which is why
	// deleting the re-read left the whole suite green. `afterPaneDeadProbe` writes
	// into the window directly: the result exists only after the probe has run.
	let writeLate: (() => Promise<void>) | undefined;
	await withHarness(
		{
			paneDead: true,
			afterPaneDeadProbe: async () => {
				await writeLate?.();
			},
		},
		async (h) => {
			const run = (await h.call("subagent", { task: "reports during the pane probe" })).details as unknown as RunRecord;
			writeLate = async () => {
				await h.writeResult(run, {
					version: 1,
					status: "completed",
					output: "landed in the window",
					finishedAt: Date.now(),
				});
			};

			await waitFor(async () => (await h.readRuns())[0].status === "completed");
			assert.equal((await h.readRuns())[0].output, "landed in the window");
		},
	);
});

test("a cancelled run reports the usage it burned before it was stopped", async () => {
	// A cancelled run is very often one that had already spent real tokens, so
	// reporting none understates what the session cost. The child never reported a
	// result, so the session file has to be discovered from the run dir.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "burns tokens, then cancelled" })).details as unknown as RunRecord;
		const sessionFile = await writeChildSession(run, [
			{ input: 300, output: 100, cost: 0.02 },
			{ input: 200, output: 50, cost: 0.03 },
		]);

		await h.call("subagent_cancel", { id: run.id });
		await waitFor(async () => (await h.readRuns())[0].status === "cancelled");
		const cancelled = (await h.readRuns())[0];
		assert.equal(cancelled.usage?.totalTokens, 650, "cancel must not discard what the child already spent");
		assert.equal(cancelled.usage?.turns, 2);
		assert.equal(cancelled.sessionFile, sessionFile, "the discovered session file is recorded, so status and clean can see it");
	});
});

test("a run failed at the tmux layer still reports its usage", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "socket dies after spending" })).details as unknown as RunRecord;
		await writeChildSession(run, [{ input: 400, output: 100 }]);

		h.failPaneAlways();
		await waitForRunStatus(h, "failed");
		const failed = (await h.readRuns())[0];
		assert.equal(failed.usage?.totalTokens, 500, "a tmux-level failure is not evidence of zero tokens");
	});
});

// --- the child branch: who may write result.json ---
//
// The v1.15.1 review found a run whose result.json held a nested pi's
// one-word answer: the child's bash tool inherits the child-mode variables, so
// a `pi` it spawned registered itself as a second reporter on the SAME file and
// overwrote the run's status, output, session and model. Two defences follow;
// these tests pin both.

interface ChildReporter {
	/** Fire an extension event with a context presenting `stopReason` and the answer text. */
	fire: (event: string, payload?: Record<string, unknown>, stopReason?: string) => Promise<void>;
	shutdownCalls: number[];
}

/**
 * Register the real child branch on `resultPath` with a fake ExtensionAPI, as
 * interrupt.test.ts does for the abort paths; here it is the result-writing
 * contract: whose session owns the record.
 */
async function childReporter(
	resultPath: string,
	sessionFile: string,
	vars: Record<string, string | undefined> = {},
	afterRegister?: () => void,
): Promise<ChildReporter> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const shutdownCalls: number[] = [];
	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: () => {
			throw new Error("the child must not register parent tools");
		},
		registerMessageRenderer: () => undefined,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		getThinkingLevel: () => "medium",
		sendMessage: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const makeCtx = (stopReason?: string) => ({
		sessionManager: {
			getSessionFile: () => sessionFile,
			getBranch: () =>
				stopReason === undefined
					? []
					: [
							{
								type: "message",
								message: { role: "assistant", content: [{ type: "text", text: "the real answer" }], stopReason },
							},
						],
		},
		model: { provider: "openrouter", id: "child/model" },
		shutdown: () => shutdownCalls.push(1),
	});

	await withEnv(
		{
			PI_TMUX_SUBAGENT_CHILD: "1",
			PI_TMUX_SUBAGENT_RESULT: resultPath,
			PI_TMUX_SUBAGENT_INTERRUPT: getInterruptFilePath(resultPath.replace("/result.json", "")),
			...vars,
		},
		async () => {
			subagentExtension(pi as never);
			afterRegister?.();
		},
	);

	return {
		fire: async (event, payload = {}, stopReason) => {
			await handlers.get(event)?.(payload, makeCtx(stopReason));
		},
		shutdownCalls,
	};
}

test("child mode removes the child-mode variables from the environment after registering", async () => {
	// Fix A: the values are read and passed to registerChildReporter, then
	// deleted. Every bash-tool subprocess inherits process.env, so a surviving
	// variable makes any `pi` the child runs re-enter child mode on the same
	// result.json — the recorded hijack. Nothing may read them after this point.
	await withTempAgentDir(async (agentDir) => {
		const runDir = path.join(agentDir, "tmux-subagents", "session", "env-scrub");
		await mkdir(runDir, { recursive: true });
		await withEnv(
			{
				PI_TMUX_SUBAGENT_CHILD: "1",
				PI_TMUX_SUBAGENT_RESULT: path.join(runDir, "result.json"),
				PI_TMUX_SUBAGENT_INTERRUPT: getInterruptFilePath(runDir),
			},
			async () => {
				// Registered inside the env scope on purpose: withEnv restores the
				// variables when its callback returns, so the assertion must run
				// between the factory call and that restore.
				await childReporter(
					path.join(runDir, "result.json"),
					path.join(runDir, "own.jsonl"),
					{},
					() => {
						assert.equal(process.env.PI_TMUX_SUBAGENT_CHILD, undefined, "a tool subprocess must not inherit child mode");
						assert.equal(process.env.PI_TMUX_SUBAGENT_RESULT, undefined);
						assert.equal(process.env.PI_TMUX_SUBAGENT_INTERRUPT, undefined);
					},
				);
			},
		);
	});
});

test("the run's own child reports, and a nested reporter with a different session cannot replace the record", async () => {
	// Fix B: result.json belongs to the run's own child. The impostor here is
	// exactly what the bash tool of a real child would spawn under the old
	// behaviour: a second child-mode registration on the same result path, with
	// its own session file.
	await withTempAgentDir(async (agentDir) => {
		const runDir = path.join(agentDir, "tmux-subagents", "session", "owned-result");
		await mkdir(runDir, { recursive: true });
		const resultPath = path.join(runDir, "result.json");
		const ownSession = path.join(runDir, "session", "own.jsonl");

		const own = await childReporter(resultPath, ownSession);
		await own.fire("agent_settled", {}, "stop");
		const landed = JSON.parse(await readFile(resultPath, "utf8")) as { status: string; output: string; sessionFile?: string };
		assert.equal(landed.status, "completed", "the real reporter's own write still lands");
		assert.equal(landed.output, "the real answer");
		assert.equal(landed.sessionFile, ownSession);

		const impostor = await childReporter(resultPath, "/tmp/impostor-session.jsonl");
		await impostor.fire("agent_settled", {}, "stop");
		const after = JSON.parse(await readFile(resultPath, "utf8")) as { output: string; sessionFile?: string };
		assert.equal(after.output, "the real answer", "a second writer must not replace a finished record");
		assert.equal(after.sessionFile, ownSession);
	});
});

test("a record from a different session is refused whichever writer came first", async () => {
	// The file protocol cannot tell an impostor's record from the owner's once
	// it is on disk — it only carries the writer's sessionFile — so a writer
	// whose session does not match the record refuses in both orders. The env
	// scrub is what keeps an impostor from registering at all; this pins the
	// protocol as a documented decision, not an accident.
	await withTempAgentDir(async (agentDir) => {
		const runDir = path.join(agentDir, "tmux-subagents", "session", "impostor-first");
		await mkdir(runDir, { recursive: true });
		const resultPath = path.join(runDir, "result.json");
		const ownSession = path.join(runDir, "session", "own.jsonl");

		const impostor = await childReporter(resultPath, "/tmp/impostor-session.jsonl");
		await impostor.fire("agent_settled", {}, "stop");
		const before = JSON.parse(await readFile(resultPath, "utf8")) as { sessionFile?: string };
		assert.equal(before.sessionFile, "/tmp/impostor-session.jsonl");

		const own = await childReporter(resultPath, ownSession);
		await own.fire("agent_settled", {}, "stop");
		const after = JSON.parse(await readFile(resultPath, "utf8")) as { sessionFile?: string };
		assert.equal(after.sessionFile, "/tmp/impostor-session.jsonl", "the owner does not replace a record naming another session either");
	});
});
