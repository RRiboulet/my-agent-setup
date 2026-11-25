// Escalated questions through the real factory (`lifecycle`): a child asks, the
// parent's existing watcher tick surfaces it, a human-confirmed answer comes
// back as the child's tool result, and every path that is not an answer ends
// with the child being told to stop rather than hanging.
//
// Risk covered: this is the one place a CHILD blocks, and it blocks inside the
// parent's concurrency budget. Getting it wrong either answers a decision by
// itself (the failure this feature exists to prevent), or holds a slot until a
// deadline nobody is watching. So the tests drive both processes: the child's
// real `subagent_ask` tool, and the parent's real tick and `subagent_answer`.

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import {
	escalationDir,
	listEscalationRequests,
	replyPath,
	writeEscalationReply,
	writeEscalationRequest,
	type EscalationRequest,
} from "../escalation.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";
import { createHarness, waitForRunStatus, withHarness, type Harness } from "./lifecycle-harness.ts";

/** What the child's tool call returned, as pi would hand it to the child model. */
interface AskResult {
	text: string;
	details: Record<string, unknown>;
}

interface ChildAsker {
	ask: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<AskResult>;
	/** Every tool the child build registered, so "registers nothing without a channel" is observable. */
	toolNames: string[];
}

/**
 * Drive the real child branch far enough to get `subagent_ask`, the way
 * `interrupt.test.ts` drives the reporter. The tool's `execute` is then called
 * against the real channel directory, which is the same one the parent's watcher
 * reads.
 */
async function createChildAsker(options: {
	dir: string;
	resultPath: string;
	graceSeconds?: number;
	timeoutSeconds?: number;
	channel?: boolean;
}): Promise<ChildAsker> {
	const tools = new Map<string, Record<string, unknown>>();
	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: (tool: Record<string, unknown>) => {
			tools.set(tool.name as string, tool);
		},
		registerMessageRenderer: () => undefined,
		on: () => () => undefined,
		getThinkingLevel: () => "medium",
		sendMessage: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	await withEnv(
		{
			PI_TMUX_SUBAGENT_CHILD: "1",
			PI_TMUX_SUBAGENT_RESULT: options.resultPath,
			PI_TMUX_SUBAGENT_INTERRUPT: undefined,
			PI_TMUX_SUBAGENT_ESCALATION: options.channel === false ? undefined : options.dir,
			PI_SUBAGENT_QUESTION_GRACE_SECONDS: options.graceSeconds?.toString(),
			PI_SUBAGENT_QUESTION_TIMEOUT_SECONDS: options.timeoutSeconds?.toString(),
		},
		async () => {
			subagentExtension(pi as never);
		},
	);
	const tool = tools.get("subagent_ask");
	return {
		toolNames: [...tools.keys()],
		ask: async (params, signal) => {
			assert.ok(tool, "the child must register subagent_ask when the parent gave it a channel");
			const execute = tool.execute as (
				id: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
			const result = await execute(`call-${Math.random().toString(16).slice(2)}`, params, signal, undefined, {});
			return { text: result.content[0]?.text ?? "", details: result.details };
		},
	};
}

/** The child for one run of the harness's parent, pointed at that run's channel. */
async function childFor(h: Harness, run: RunRecord, extra: { graceSeconds?: number; timeoutSeconds?: number } = {}) {
	return createChildAsker({ dir: escalationDir(run.runDir), resultPath: run.resultPath, ...extra });
}

function questionMessage(h: Harness, requestId?: string): Record<string, unknown> | undefined {
	return h.messages.find(
		(entry) => entry.message.customType === "subagent-question" && (!requestId || (entry.message.details as { requestId?: string }).requestId === requestId),
	)?.message;
}

function progressMessages(h: Harness, requestId?: string): Record<string, unknown>[] {
	return h.messages
		.filter(
			(entry) =>
				entry.message.customType === "subagent-progress" &&
				(!requestId || (entry.message.details as { requestId?: string }).requestId === requestId),
		)
		.map((entry) => entry.message);
}

async function pendingRequestOf(h: Harness): Promise<RunRecord["pendingRequest"]> {
	const runs = await h.readRuns();
	return runs[0]?.pendingRequest;
}

function request(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
	return {
		version: 1,
		id: `ask-${Math.random().toString(16).slice(2, 18)}`,
		runId: "",
		kind: "question",
		text: "Which database should the new store use?",
		askedAt: Date.now(),
		deadlineAt: Date.now() + 60_000,
		...overrides,
	};
}

// --- the round trip ---------------------------------------------------------

test("a child's question reaches the parent, and the confirmed answer is its tool result", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "needs a decision" })).details as unknown as RunRecord;
		const child = await childFor(h, run);

		const pending = child.ask({ question: "Postgres or SQLite?", options: ["postgres", "sqlite"] });

		// The parent learns about it from its OWN tick: no timer was added for it.
		await waitFor(async () => (await pendingRequestOf(h)) !== undefined);
		const waiting = await pendingRequestOf(h);
		assert.ok(waiting, "the question is recorded on the run");
		assert.equal(waiting.text, "Postgres or SQLite?");
		assert.deepEqual(waiting.options, ["postgres", "sqlite"]);

		// Surfaced to the parent session, and this message is allowed to wake it —
		// a question nobody is woken for is a slot held until the deadline.
		const surfaced = questionMessage(h, waiting.id);
		assert.ok(surfaced, "the question must reach the parent session");
		assert.match(String(surfaced.content), /Postgres or SQLite\?/);
		assert.match(String(surfaced.content), new RegExp(waiting.id));
		const surfacedWithOptions = h.messages.find(
			(entry) => entry.message.customType === "subagent-question" && (entry.message.details as { requestId?: string }).requestId === waiting.id,
		);
		assert.deepEqual(surfacedWithOptions?.options, { triggerTurn: true, deliverAs: "followUp" });

		// Answering asks the human, and the answer they see is the model's proposal.
		const answered = await h.call("subagent_answer", { id: waiting.id, answer: "Postgres" });
		assert.match(answered.text, /delivered to subagent/);
		assert.equal(h.confirmCalls.length, 1, "a decision is confirmed by a human exactly once");
		assert.match(h.confirmCalls[0]?.message ?? "", /Postgres or SQLite\?/);
		assert.match(h.confirmCalls[0]?.message ?? "", /Proposed answer: Postgres/);

		// The answer arrives as the child's tool result, in the same turn.
		const result = await pending;
		assert.match(result.text, /Answer from the parent \(confirmed by a human\): Postgres/);
		assert.equal(result.details.outcome, "answered");
		assert.equal(result.details.id, waiting.id);

		// Handled once: the exchange is consumed, so a replay of these bytes cannot
		// answer the child a second time, and the run no longer reports a question.
		// The parent's heartbeat is not part of the exchange and stays behind.
		await waitFor(async () => (await pendingRequestOf(h)) === undefined);
		const leftovers = (await readdir(escalationDir(run.runDir))).filter((name) => name !== "parent.alive");
		assert.deepEqual(leftovers, []);
	});

	// The parent pays nothing for the child's tool: it is not registered there.
	await withHarness(undefined, async (h) => {
		assert.equal(h.tools.has("subagent_ask"), false, "subagent_ask is a child-only tool");
		assert.equal(h.tools.has("subagent_answer"), true, "the answering tool is a parent tool");
	});
});

test("the child registers no asking tool when the parent gave it no channel", async () => {
	await withTempAgentDir(async (agentDir) => {
		const readOnly = await createChildAsker({
			dir: path.join(agentDir, "never-used"),
			resultPath: path.join(agentDir, "result.json"),
			channel: false,
		});
		assert.deepEqual(readOnly.toolNames, [], "an older parent sets no channel, so the child cannot ask");
	});
});

test("a progress update reaches the parent without a human gate and without an answer", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "reports progress" })).details as unknown as RunRecord;
		const child = await childFor(h, run);

		const sent = await child.ask({ question: "Halfway through the migration", kind: "progress" });
		assert.match(sent.text, /Progress update delivered/);
		assert.equal(sent.details.outcome, "delivered");

		await waitFor(() => progressMessages(h).length === 1);
		const delivered = progressMessages(h)[0];
		assert.match(String(delivered?.content), /Halfway through the migration/);
		// No turn is taken for an update (the options are pi's defaults: neither
		// triggerTurn nor deliverAs), and nothing is asked of a human.
		const entry = h.messages.find((candidate) => candidate.message === delivered);
		assert.equal(entry?.options, undefined);
		assert.equal(h.confirmCalls.length, 0);
		assert.equal(await pendingRequestOf(h), undefined, "a progress update is never a pending decision");
		// Consumed on delivery: the child never reads a progress request, so the
		// parent is its only reader and a reload must not deliver it twice.
		const dir = escalationDir(run.runDir);
		await waitFor(async () => (await listEscalationRequests(dir)).length === 0);
	});

	// A second update with the same text is a new request id, and both are delivered
	// once — the dedupe is per request, not per text.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "two updates" })).details as unknown as RunRecord;
		const child = await childFor(h, run);
		await child.ask({ question: "first", kind: "progress" });
		await child.ask({ question: "second", kind: "progress" });
		await waitFor(() => progressMessages(h).length === 2);
	});
});

// --- the human gate ---------------------------------------------------------

test("a declined confirmation sends nothing and leaves the question pending", async () => {
	await withTempAgentDir(async () => {
		const h = await createHarness({ confirmAnswer: false });
		try {
			const run = (await h.call("subagent", { task: "decides nothing" })).details as unknown as RunRecord;
			const child = await childFor(h, run);
			const pending = child.ask({ question: "Delete the old table?" });
			await waitFor(async () => (await pendingRequestOf(h)) !== undefined);
			const waiting = await pendingRequestOf(h);
			assert.ok(waiting);

			const declined = await h.call("subagent_answer", { id: waiting.id, answer: "yes" });
			assert.match(declined.text, /Not sent: the human declined/);
			assert.equal(h.confirmCalls.length, 1);
			assert.equal((await pendingRequestOf(h))?.id, waiting.id, "a declined answer does not consume the question");

			// Nothing was written for the child to collect, so it keeps waiting (and
			// would time out) rather than being answered behind the human's back.
			const outcome = await pendingControl(pending);
			assert.equal(outcome, "still-waiting");
		} finally {
			await h.shutdown();
		}
	});
});

/** Wait briefly and report whether a pending child call is still waiting. */
async function pendingControl(pending: Promise<unknown>): Promise<"still-waiting" | "resolved"> {
	const marker = Symbol("pending");
	const raced = await Promise.race([pending.then(() => "resolved" as const), new Promise((resolve) => setTimeout(() => resolve(marker), 300))]);
	return raced === marker ? "still-waiting" : "resolved";
}

test("answering a decision without a UI is refused and says why, and the child times out", async () => {
	await withTempAgentDir(async () => {
		const h = await createHarness({ hasUI: false, mode: "print" });
		try {
			const run = (await h.call("subagent", { task: "no human here" })).details as unknown as RunRecord;
			// One second of deadline, so the child's own timeout is observable.
			const child = await childFor(h, run, { timeoutSeconds: 1, graceSeconds: 60 });
			const pending = child.ask({ question: "Postgres or SQLite?" });
			await waitFor(async () => (await pendingRequestOf(h)) !== undefined);
			const waiting = await pendingRequestOf(h);
			assert.ok(waiting);

			await assert.rejects(h.call("subagent_answer", { id: waiting.id, answer: "Postgres" }), (error: Error) => {
				assert.match(error.message, /needs a human to confirm a decision/);
				assert.match(error.message, /no UI/);
				assert.match(error.message, /NOT sent/);
				assert.match(error.message, /reports the blocker/);
				return true;
			});
			assert.equal(h.confirmCalls.length, 0, "with no UI there is nobody to ask, so nothing is asked");

			// The child is not answered: it reaches its own deadline, is told it
			// failed, and is pointed at the blocker instruction.
			const result = await pending;
			assert.match(result.text, /No answer arrived within 1s/);
			assert.match(result.text, /subagent-report/);
			assert.match(result.text, /blocked/);
			assert.equal(result.details.outcome, "expired");
			// An expired question is no longer "waiting": the record keeps it (the child
			// has not reported its blocker yet, so the run has not settled), but status
			// stops claiming a human is being waited on.
			const after = await h.call("subagent_status", { id: run.id });
			assert.doesNotMatch(after.text, /waiting on a human-confirmed answer/);
		} finally {
			await h.shutdown();
		}
	});
});

// --- expiry and replay ------------------------------------------------------

test("a request past its deadline is not delivered and not answered", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "asks too late" })).details as unknown as RunRecord;
		const expired = request({ runId: run.id, askedAt: Date.now() - 10_000, deadlineAt: Date.now() - 5_000 });
		await writeEscalationRequest(escalationDir(run.runDir), expired);

		// Several ticks: the request is read, refused, and never surfaced.
		await waitFor(async () => h.execCalls.filter((call) => call.args.includes("capture-pane")).length >= 2);
		assert.equal(questionMessage(h, expired.id), undefined, "an expired request is never delivered");
		assert.equal(await pendingRequestOf(h), undefined);

		// Nor can it be answered after the fact: the request is not pending, and the
		// tool says so rather than writing a reply the child has already abandoned.
		await assert.rejects(h.call("subagent_answer", { id: expired.id, answer: "late" }), /No subagent question/);
	});
});

test("a question that expires while the parent is deciding is refused, not answered", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "expires mid-decision" })).details as unknown as RunRecord;
		const soon = request({ runId: run.id, deadlineAt: Date.now() + 2_000 });
		await writeEscalationRequest(escalationDir(run.runDir), soon);
		await waitFor(async () => (await pendingRequestOf(h))?.id === soon.id);
		// The child's clock ends the wait at the deadline; the answer arrives after.
		await new Promise((resolve) => setTimeout(resolve, 2_200));

		await assert.rejects(h.call("subagent_answer", { id: soon.id, answer: "too late" }), /passed its deadline/);
		// The refusal clears the record, and no reply was ever written: the child's
		// deadline already ended its wait, so a late answer has nowhere to land.
		await waitFor(async () => (await pendingRequestOf(h)) === undefined, 5_000);
		await assert.rejects(readFileReply(h, run, soon.id), /ENOENT/);
	});
});

test("a replayed request is handled exactly once", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "asks twice" })).details as unknown as RunRecord;
		const update = request({ runId: run.id, kind: "progress", text: "still working" });
		await writeEscalationRequest(escalationDir(run.runDir), update);

		await waitFor(() => progressMessages(h, update.id).length === 1);
		// The file is still on disk (the child deletes it only for a decision it
		// received an answer to), so several more ticks read the same bytes.
		await waitFor(async () => h.execCalls.filter((call) => call.args.includes("capture-pane")).length >= 4);
		assert.equal(progressMessages(h, update.id).length, 1, "a replayed request is delivered once, not once per tick");
	});
});

test("a question answered before a reload is not surfaced again", async () => {
	// The request file stays on disk until the child collects its answer, so a
	// fresh extension load re-reads it with no memory of having handled it. The
	// reply beside it is what says "already answered"; re-surfacing would ask a
	// human to decide something that was decided.
	await withTempAgentDir(async () => {
		const first = await createHarness();
		let run!: RunRecord;
		let asked!: string;
		try {
			run = (await first.call("subagent", { task: "answers across a reload" })).details as unknown as RunRecord;
			const question = request({ runId: run.id });
			asked = question.id;
			await writeEscalationRequest(escalationDir(run.runDir), question);
			await waitFor(async () => (await first.readRuns())[0].pendingRequest?.id === asked);
			await first.call("subagent_answer", { id: asked, answer: "decided" });
			assert.equal((await first.readRuns())[0].pendingRequest, undefined);
		} finally {
			await first.shutdown();
		}

		const second = await createHarness();
		try {
			// Several ticks over the same run dir, with the answered request still there.
			await waitFor(async () => second.execCalls.filter((call) => call.args.includes("capture-pane")).length >= 2);
			assert.equal(second.messages.filter((entry) => entry.message.customType === "subagent-question").length, 0);
			assert.equal((await second.readRuns())[0]?.pendingRequest, undefined);
			assert.equal((await second.readRuns())[0]?.id, run.id, "the run is the one restored from disk");
		} finally {
			await second.shutdown();
		}
	});
});

// --- no parent --------------------------------------------------------------

test("with no parent to answer, the child fails fast instead of waiting out its deadline", async () => {
	await withTempAgentDir(async () => {
		const h = await createHarness();
		const run = (await h.call("subagent", { task: "parent goes away" })).details as unknown as RunRecord;
		// The parent's watcher stops here, exactly as it does when the session ends.
		await h.shutdown();

		// A long deadline: only the missing heartbeat can end this quickly.
		const child = await childFor(h, run, { graceSeconds: 1, timeoutSeconds: 300 });
		const startedAt = Date.now();
		const result = await child.ask({ question: "Anybody there?" });
		const elapsed = Date.now() - startedAt;

		assert.match(result.text, /No parent session is there to answer/);
		assert.match(result.text, /[Rr]eport the blocker/);
		assert.equal(result.details.outcome, "no-parent");
		assert.ok(elapsed < 30_000, `the child must not wait for the deadline (took ${elapsed}ms)`);
	});
});

test("a parent shutting down with a question pending is what the blocked child sees", async () => {
	await withTempAgentDir(async () => {
		const h = await createHarness();
		const run = (await h.call("subagent", { task: "shutdown mid-question" })).details as unknown as RunRecord;
		const child = await childFor(h, run, { graceSeconds: 1, timeoutSeconds: 300 });
		const pending = child.ask({ question: "Do I continue?" });
		await waitFor(async () => (await pendingRequestOf(h)) !== undefined);

		await h.shutdown();
		const result = await pending;
		assert.match(result.text, /No parent session is there to answer/);
		assert.equal(result.details.outcome, "no-parent");
	});
});

// --- timers and status ------------------------------------------------------

test("handling a question adds no timer, and shutdown leaves none armed", async () => {
	await withTempAgentDir(async () => {
		const timers = (): number => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
		const baseline = timers();
		const h = await createHarness();
		try {
			const run = (await h.call("subagent", { task: "timer check" })).details as unknown as RunRecord;
			await writeEscalationRequest(escalationDir(run.runDir), request({ runId: run.id }));
			// The question is delivered by the watcher tick that was already running:
			// one timer (the watcher), which the baseline comparison below accounts for.
			await waitFor(async () => (await pendingRequestOf(h)) !== undefined);
			assert.equal(questionMessage(h) !== undefined, true);

			await h.shutdown();
			// One tick may have been in flight at shutdown; give it longer than the
			// 500 ms cadence to finish and re-arm nothing.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			assert.equal(timers(), baseline, "shutdown must leave no escalation timer armed");
		} finally {
			await h.shutdown();
		}
	});
});

test("status identifies a run blocked on a question, distinctly from stalled or interrupted", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "blocked on a decision" })).details as unknown as RunRecord;
		await writeEscalationRequest(
			escalationDir(run.runDir),
			request({ runId: run.id, text: "Should I drop the legacy table?" }),
		);
		await waitFor(async () => (await pendingRequestOf(h)) !== undefined);

		// The single-run view: the question, the request id subagent_answer needs,
		// and the deadline — not an "active" line that looks like work.
		const detail = await h.call("subagent_status", { id: run.id });
		assert.match(detail.text, /question: Should I drop the legacy table\?/);
		assert.match(detail.text, /waiting on: a human-confirmed answer/);
		assert.match(detail.text, new RegExp((await pendingRequestOf(h))?.id ?? "missing"));
		assert.match(detail.text, /deadline/);

		// The list's one-line row carries it too: that note is the only thing a
		// caller sees when the budget gives the block to another run.
		const list = await h.call("subagent_status", { compact: true });
		assert.match(list.text, /\? waiting on a question: Should I drop the legacy table\?/);

		// The widget gets its own kind, not "active" and not the stall hourglass.
		const rows = h.renderWidget() ?? [];
		assert.ok(rows.some((row) => row.includes("?") && row.includes("waiting on a question")), `widget rows: ${JSON.stringify(rows)}`);

		// Distinct from the other two states: a settled or interrupted run never
		// carries a question line, and the list does not call this one stalled.
		const snapshot = await h.call("subagent_status", { id: run.id, compact: true });
		assert.doesNotMatch(snapshot.text, /stalled/);
	});
});

// --- the run record ---------------------------------------------------------

async function readFileReply(h: Harness, run: RunRecord, id: string): Promise<string> {
	return (await import("node:fs/promises")).readFile(replyPath(escalationDir(run.runDir), id), "utf8");
}

test("the answer lands in the run's channel and the child can always read it back", async () => {
	// A narrow protocol-level check of the pair the two processes share: the parent
	// writes only through subagent_answer, and what it writes is what the child's
	// reader accepts.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "writes a reply" })).details as unknown as RunRecord;
		const ask = request({ runId: run.id });
		await writeEscalationRequest(escalationDir(run.runDir), ask);
		await waitFor(async () => (await pendingRequestOf(h))?.id === ask.id);
		await h.call("subagent_answer", { id: ask.id, answer: "go ahead" });
		const raw = JSON.parse(await readFileReply(h, run, ask.id)) as Record<string, unknown>;
		assert.equal(raw.answer, "go ahead");
		assert.equal(raw.runId, run.id);
		assert.equal(raw.version, 1);

		// And a replayed answer for the same request is refused by id: the pending
		// question is gone, so there is nothing to attach a second reply to.
		await assert.rejects(h.call("subagent_answer", { id: ask.id, answer: "again" }), /No subagent question/);
		// A pre-written reply is not inferred as an answer by the parent either.
		await writeEscalationReply(escalationDir(run.runDir), {
			version: 1,
			id: "ask-00000000000000ff",
			runId: run.id,
			answer: "forged",
			answeredAt: Date.now(),
		});
		// A reply with no request behind it is inert: the parent surfaces requests, never
		// replies, so two ticks later the run is still running and nothing was pending.
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0]?.status, "running", "a forged reply must not settle the run");
		assert.equal(await pendingRequestOf(h), undefined, "and must not create a pending question");
	});
});
