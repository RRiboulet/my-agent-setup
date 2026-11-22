// Load guard + behavior tests for the vendored /goal extension.
//
// Part 1 is a load guard: goal.ts must load under a strict ESM linker. pi
// loads extensions through jiti, whose CJS interop resolves missing named
// exports lazily — a module importing a symbol that pi 1.0 removed still
// "loads" through jiti and only fails when the code path runs. Importing the
// module here with `node --test` uses the real ESM linker, so a removed import
// fails at load time and this test goes red.
//
// Part 2 exercises what the todo flags as the risky part — the session-log
// state reconstruction that runs on reload and tree navigation, which is
// LOCAL CHANGE 1's `reconstructGoalFromBranch` — plus the pure helpers the
// extension relies on (status normalization, the 4k objective limit, usage
// accounting, budget limiting, the continuation prompt). These ship untested
// upstream; the __test__ tail is the only reason they are testable at all.
//
// Part 3 drives the factory itself through the fake extension host
// (./fake-pi.ts). The helpers above prove what a goal MEANS; those tests prove
// WHEN the extension acts, which the pure-helper surface cannot: that a
// completed run's settlement boundary proposes exactly one continuation, that
// an inactive or already-queued goal proposes none, and that an aborted run
// pauses rather than continues when no UI is available.
//
// The continuation is asserted on the boundary's RETURNED proposal, not on
// `pi.sendMessage`: `agent_before_settle` has no message channel, so a factory
// that still sent one from `agent_end` would pass a `messages` assertion while
// requesting nothing at the boundary.
//
// Importing the module has no side effects: the factory is only called when
// pi actually loads the extension.

import assert from "node:assert/strict";
import { test } from "node:test";

import goalExtension, { __test__ } from "../../goal.ts";
import { createFakeHost } from "./fake-pi.ts";

const {
	STATE_TYPE,
	CONTINUATION_MESSAGE_TYPE,
	MAX_OBJECTIVE_CHARS,
	reconstructGoalFromBranch,
	hasExhaustedTokenBudget,
	normalizeGoal,
	normalizeStatus,
	validateObjective,
	validateTokenBudget,
	charCount,
	escapeXmlText,
	formatElapsedSeconds,
	formatTokensCompact,
	assistantUsageTokens,
	goalResponse,
	goalSummary,
	continuationPrompt,
	activeGoalSystemPrompt,
	budgetLimitMessage,
	statusAfterObjectiveEdit,
	goalStopStatusForAssistantError,
	lastAssistantMessage,
	wasLastAssistantAborted,
	isUnfinishedGoal,
} = __test__;

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
}

interface Goal {
	id: string;
	objective: string;
	status: string;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

function goalEntry(goal: Goal | null, action = "set"): Entry {
	return { type: "custom", customType: STATE_TYPE, data: { version: 2, action, goal } };
}

function fixtureGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "g1",
		objective: "Ship the vendored goal extension",
		status: "active",
		tokenBudget: 50_000,
		tokensUsed: 12_000,
		timeUsedSeconds: 3_700,
		createdAt: 1_000,
		updatedAt: 2_000,
		...overrides,
	};
}

test("goal.ts loads under strict ESM with a default factory and __test__", async () => {
	const specifier = new URL("../../goal.ts", import.meta.url).href;
	const module = (await import(specifier)) as { default?: unknown; __test__?: unknown };
	assert.equal(typeof module.default, "function", "goal.ts must export a default extension factory");
	assert.ok(module.__test__ !== undefined, "goal.ts must export __test__ (see the file header)");
});

test("reconstructGoalFromBranch: empty and non-goal branches produce no goal", () => {
	assert.equal(reconstructGoalFromBranch([]), null);
	assert.equal(
		reconstructGoalFromBranch([
			{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } },
			{ type: "custom", customType: "some-other-extension", data: { whatever: 1 } },
		]),
		null,
	);
});

test("reconstructGoalFromBranch: a single goal entry is reconstructed", () => {
	const goal = fixtureGoal();
	const branch = [goalEntry(goal)];
	const reconstructed = reconstructGoalFromBranch(branch);
	assert.ok(reconstructed !== null);
	assert.equal(reconstructed.id, "g1");
	assert.equal(reconstructed.objective, "Ship the vendored goal extension");
	assert.equal(reconstructed.status, "active");
	assert.equal(reconstructed.tokenBudget, 50_000);
	assert.equal(reconstructed.tokensUsed, 12_000);
	assert.equal(reconstructed.timeUsedSeconds, 3_700);
	assert.equal(reconstructed.createdAt, 1_000);
	assert.equal(reconstructed.updatedAt, 2_000);
});

test("reconstructGoalFromBranch: the LAST goal entry wins, across reloads and navigation", () => {
	// A session accumulates set / status / edit entries; only the last one matters.
	const branch = [
		goalEntry(fixtureGoal({ objective: "old objective" })),
		goalEntry(fixtureGoal({ status: "paused" }), "status"),
		goalEntry(fixtureGoal({ objective: "edited objective" }), "edit"),
	];
	const reconstructed = reconstructGoalFromBranch(branch);
	assert.ok(reconstructed !== null);
	assert.equal(reconstructed.objective, "edited objective");
	assert.equal(reconstructed.status, "active", "the last entry wins wholesale, not field by field");
});

test("reconstructGoalFromBranch: a clear (null goal) wipes everything before it", () => {
	const branch = [
		goalEntry(fixtureGoal()),
		goalEntry(fixtureGoal({ status: "complete" }), "status"),
		goalEntry(null, "clear"),
		// ...and a later set starts fresh
		goalEntry(fixtureGoal({ id: "g2", objective: "the next goal" })),
	];
	const reconstructed = reconstructGoalFromBranch(branch);
	assert.ok(reconstructed !== null);
	assert.equal(reconstructed.id, "g2");
	assert.equal(reconstructed.objective, "the next goal");
});

test("reconstructGoalFromBranch: navigating back before the goal was set yields none", () => {
	// Tree navigation hands the handler a prefix of the branch: entries that
	// exist later in the session must not leak into an earlier point of view.
	const branch = [goalEntry(fixtureGoal({ id: "g1" }))];
	assert.equal(reconstructGoalFromBranch(branch.slice(0, 0)), null);
	assert.equal(reconstructGoalFromBranch([{ type: "message", id: "m1", message: { role: "user", content: "hi" } }]), null);
});

test("reconstructGoalFromBranch: malformed persisted data yields no goal", () => {
	assert.equal(reconstructGoalFromBranch([goalEntry(fixtureGoal(), "set"), { type: "custom", customType: STATE_TYPE, data: { version: 2, action: "set" } }]), null);
	assert.equal(reconstructGoalFromBranch([goalEntry(fixtureGoal()), goalEntry(fixtureGoal({ objective: "   " }))]), null);
	assert.equal(reconstructGoalFromBranch([{ type: "custom", customType: STATE_TYPE, data: "not an object" }]), null);
});

test("normalizeStatus maps persisted spellings and falls back to active", () => {
	assert.equal(normalizeStatus("active"), "active");
	assert.equal(normalizeStatus("paused"), "paused");
	assert.equal(normalizeStatus("blocked"), "blocked");
	assert.equal(normalizeStatus("complete"), "complete");
	assert.equal(normalizeStatus("usage_limited"), "usageLimited");
	assert.equal(normalizeStatus("usageLimited"), "usageLimited");
	assert.equal(normalizeStatus("budget_limited"), "budgetLimited");
	assert.equal(normalizeStatus("budgetLimited"), "budgetLimited");
	assert.equal(normalizeStatus("garbage"), "active");
	assert.equal(normalizeStatus(undefined), "active");
});

test("normalizeGoal fills defaults and sanitizes fields", () => {
	const g = normalizeGoal({
		id: "",
		objective: "  padded objective  ",
		status: "usage_limited",
		tokenBudget: 105.7,
		tokensUsed: 12.9,
		timeUsedSeconds: -40,
		createdAt: 0,
		updatedAt: 0,
	});
	assert.ok(g !== null);
	assert.ok(g.id.length > 0, "missing id gets a fresh uuid");
	assert.ok(g.id !== "", "not the empty string");
	assert.equal(g.objective, "  padded objective  ", "stored as persisted, only checked for blankness");
	assert.equal(g.status, "usageLimited");
	assert.equal(g.tokenBudget, 105, "positive finite budget is floored");
	assert.equal(g.tokensUsed, 12);
	assert.equal(g.timeUsedSeconds, 0, "negative time clamps to zero, not -40");
	assert.equal(g.createdAt, 0);
	assert.equal(g.updatedAt, 0);
});

test("normalizeGoal: tokenBudget only survives as a positive finite number", () => {
	assert.ok(normalizeGoal(fixtureGoal({ tokenBudget: 10 }))?.tokenBudget === 10);
	assert.equal(normalizeGoal(fixtureGoal({ tokenBudget: 0 }))?.tokenBudget, undefined);
	assert.equal(normalizeGoal(fixtureGoal({ tokenBudget: -10 }))?.tokenBudget, undefined);
	assert.equal(normalizeGoal(fixtureGoal({ tokenBudget: Number.NaN }))?.tokenBudget, undefined);
	assert.equal(normalizeGoal(fixtureGoal({ tokenBudget: Number.POSITIVE_INFINITY }))?.tokenBudget, undefined);
	assert.equal(normalizeGoal(fixtureGoal({ tokenBudget: 5.9 }))?.tokenBudget, 5);
});

test("normalizeGoal: blank or non-object input is null", () => {
	assert.equal(normalizeGoal(undefined), null);
	assert.equal(normalizeGoal(null), null);
	assert.equal(normalizeGoal("string"), null);
	assert.equal(normalizeGoal({ objective: "   " }), null);
	assert.equal(normalizeGoal({ objective: 42 }), null);
});

test("validateObjective trims, rejects empty, and enforces the 4k code-point limit", () => {
	assert.equal(charCount("a\u{1F600}c"), 3, "charCount counts code points, not UTF-16 units");
	assert.equal(validateObjective("  short and sweet  "), "short and sweet");
	assert.throws(() => validateObjective(""), /must not be empty/);
	assert.throws(() => validateObjective("     "), /must not be empty/);
	const atLimit = "x".repeat(MAX_OBJECTIVE_CHARS);
	assert.equal(validateObjective(atLimit), atLimit);
	const overByEmoji = "\u{1F600}".repeat(MAX_OBJECTIVE_CHARS + 1);
	assert.throws(() => validateObjective(overByEmoji), /too long/);
	assert.throws(() => validateObjective("x".repeat(MAX_OBJECTIVE_CHARS + 1)), /Put longer instructions in a file/);
});

test("validateTokenBudget: omitted budgets pass through, non-positive or fractional ones throw", () => {
	assert.equal(validateTokenBudget(undefined), undefined);
	assert.equal(validateTokenBudget(10_000), 10_000);
	assert.throws(() => validateTokenBudget(0), /positive integers/);
	assert.throws(() => validateTokenBudget(-1), /positive integers/);
	assert.throws(() => validateTokenBudget(2.5), /positive integers/);
	assert.throws(() => validateTokenBudget(Number.NaN), /positive integers/);
});

test("formatElapsedSeconds renders units with sensible rounding", () => {
	assert.equal(formatElapsedSeconds(0), "0s");
	assert.equal(formatElapsedSeconds(59), "59s");
	assert.equal(formatElapsedSeconds(125), "2m 5s");
	assert.equal(formatElapsedSeconds(3_700), "1h 1m");
	assert.equal(formatElapsedSeconds(90_000), "1d 1h 0m");
	assert.equal(formatElapsedSeconds(-10), "0s", "negatives clamp to zero, never render negative");
});

test("formatTokensCompact renders K/M suffixes", () => {
	assert.equal(formatTokensCompact(0), "0");
	assert.equal(formatTokensCompact(999), "999");
	assert.equal(formatTokensCompact(1_500), "1.5K");
	assert.equal(formatTokensCompact(1_000), "1K");
	assert.equal(formatTokensCompact(1_500_000), "1.5M");
	assert.equal(formatTokensCompact(1_000_000), "1M");
});

test("assistantUsageTokens measures input-cacheRead+output, falling back to totalTokens", () => {
	const measured = (role: string, usage: object | undefined) => ({ role, usage });
	assert.equal(
		assistantUsageTokens([
			measured("assistant", { input: 100, cacheRead: 40, output: 30, totalTokens: 999 }),
			measured("assistant", { input: 0, cacheRead: 0, output: 0, totalTokens: 77 }),
		]),
		90 + 77,
	);
	assert.equal(
		assistantUsageTokens([
			measured("user", { input: 100, cacheRead: 40, output: 30, totalTokens: 999 }),
			measured("assistant", undefined),
			measured("assistant", {}),
			"not an object",
			null,
		]),
		0,
	);
});

test("hasExhaustedTokenBudget: only an active goal at or over its budget", () => {
	const active = fixtureGoal();
	active.status = "active";
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "active", tokenBudget: 100, tokensUsed: 100 })), true);
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "active", tokenBudget: 100, tokensUsed: 101 })), true);
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "active", tokenBudget: 100, tokensUsed: 99 })), false, "under budget keeps going");
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "active", tokenBudget: undefined, tokensUsed: 10 })), false, "no budget never limits");
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "paused", tokenBudget: 1, tokensUsed: 10 })), false, "only active goals can be budget-limited");
	assert.equal(hasExhaustedTokenBudget(fixtureGoal({ status: "complete", tokenBudget: 1, tokensUsed: 10 })), false);
	assert.equal(hasExhaustedTokenBudget(null), false);
});

test("goalResponse returns the wire shape with a clamped remaining budget", () => {
	const response = goalResponse(fixtureGoal(), "session-123");
	const wire = response.goal;
	assert.ok(wire !== null);
	assert.equal(wire.threadId, "session-123");
	assert.equal(wire.objective, "Ship the vendored goal extension");
	assert.equal(wire.status, "active");
	assert.equal(wire.tokenBudget, 50_000);
	assert.equal(response.remainingTokens, 38_000);
	assert.equal(response.completionBudgetReport, null);
	// Over budget: remainingTokens clamps at zero rather than going negative.
	const spent = goalResponse(fixtureGoal({ status: "active", tokensUsed: 60_000 }), "session-123");
	assert.equal(spent.remainingTokens, 0);
});

test("goalResponse completionBudgetReport appears only for a complete goal with figures", () => {
	const complete = fixtureGoal({ status: "complete", tokenBudget: 50_000, tokensUsed: 12_000, timeUsedSeconds: 3_700 });
	const report = goalResponse(complete, "s", true).completionBudgetReport;
	assert.ok(report !== null);
	assert.match(report, /tokens used: 12000 of 50000/);
	assert.match(report, /time used: 1h 1m/);
	assert.equal(goalResponse(complete, "s", false).completionBudgetReport, null, "only when asked");
	assert.equal(
		goalResponse(fixtureGoal({ status: "complete", tokenBudget: undefined, timeUsedSeconds: 0 }), "s", true).completionBudgetReport,
		null,
		"no numbers, no report",
	);
	assert.equal(goalResponse(fixtureGoal({ status: "active" }), "s", true).completionBudgetReport, null, "not complete yet");
});

test("statusAfterObjectiveEdit: editing a finished goal reactivates it", () => {
	assert.equal(statusAfterObjectiveEdit("complete"), "active");
	assert.equal(statusAfterObjectiveEdit("budgetLimited"), "active");
	for (const status of ["active", "paused", "blocked", "usageLimited"]) {
		assert.equal(statusAfterObjectiveEdit(status), status, `${status} keeps its status`);
	}
});

test("goalStopStatusForAssistantError: usage-ish errors limit, everything else blocks", () => {
	assert.equal(goalStopStatusForAssistantError({ errorMessage: "rate limit exceeded" }), "usageLimited");
	assert.equal(goalStopStatusForAssistantError({ errorMessage: "Monthly usage cap reached" }), "usageLimited");
	assert.equal(goalStopStatusForAssistantError({ errorMessage: "quota exhausted" }), "usageLimited");
	assert.equal(goalStopStatusForAssistantError({ errorMessage: "401 unauthorized" }), "blocked");
	assert.equal(goalStopStatusForAssistantError(undefined), "blocked");
});

test("lastAssistantMessage and wasLastAssistantAborted scan backwards for the assistant", () => {
	const aborted = { role: "assistant", stopReason: "aborted" };
	const done = { role: "assistant", stopReason: "end_turn" };
	const user = { role: "user", content: "hi" };
	assert.equal(lastAssistantMessage([user, done, user]), done);
	assert.equal(wasLastAssistantAborted([user, done, aborted, user]), true);
	assert.equal(wasLastAssistantAborted([user, done, user]), false, "no trailing assistant message");
	assert.equal(wasLastAssistantAborted([user, { role: "assistant", stopReason: "error" }]), false, "error is not an abort");
	assert.equal(wasLastAssistantAborted([]), false);
});

test("isUnfinishedGoal: only complete means finished", () => {
	assert.equal(isUnfinishedGoal(fixtureGoal({ status: "complete" })), false);
	for (const status of ["active", "paused", "blocked", "usageLimited", "budgetLimited"]) {
		assert.equal(isUnfinishedGoal(fixtureGoal({ status })), true, `${status} is unfinished`);
	}
});

test("goalSummary reports status, usage, and status-appropriate commands", () => {
	const summary = goalSummary(fixtureGoal());
	assert.match(summary, /Goal\nStatus: active/);
	assert.match(summary, /Objective: Ship the vendored goal extension/);
	assert.match(summary, /Time used: 1h 1m/);
	assert.match(summary, /Tokens used: 12K/);
	assert.match(summary, /Token budget: 50K/);
	assert.match(summary, /Commands: \/goal edit, \/goal pause, \/goal clear/);
	const paused = goalSummary(fixtureGoal({ status: "paused" }));
	assert.match(paused, /Commands: \/goal edit, \/goal resume, \/goal clear/);
	const complete = goalSummary(fixtureGoal({ status: "complete", tokenBudget: undefined }));
	assert.ok(!complete.includes("Token budget"), "no budget line without a budget");
	assert.match(complete, /Commands: \/goal edit, \/goal clear/);
});

test("continuationPrompt carries the objective (XML-escaped), budget state and the completion instruction", () => {
	const prompt = continuationPrompt(fixtureGoal({ objective: "follow <docs/A> & <docs/B>" }));
	assert.match(prompt, /<untrusted_objective>\nfollow &lt;docs\/A&gt; &amp; &lt;docs\/B&gt;\n<\/untrusted_objective>/);
	assert.match(prompt, /Tokens used: 12000/);
	assert.match(prompt, /Token budget: 50000/);
	assert.match(prompt, /Tokens remaining: 38000/);
	assert.match(prompt, /call update_goal with status "complete"/);
	assert.match(prompt, /three consecutive goal turns/);
});

test("activeGoalSystemPrompt and budgetLimitMessage reflect state", () => {
	const system = activeGoalSystemPrompt(fixtureGoal());
	assert.match(system, /Active thread goal:/);
	assert.match(system, /Tokens remaining: 38000/);
	assert.match(system, /call update_goal with status "complete"/);

	const limited = budgetLimitMessage(fixtureGoal({ status: "budgetLimited" }));
	assert.match(limited, /Goal limited by budget/);
	assert.match(limited, /Status: limited by budget/);
	assert.match(limited, /No new automatic continuation will be queued/);
	assert.match(limited, /\/goal resume/);
});

test("escapeXmlText escapes the three XML specials", () => {
	assert.equal(escapeXmlText(`a & b < c > d`), `a &amp; b &lt; c &gt; d`);
	assert.equal(escapeXmlText("plain"), "plain");
});

// --- Factory wiring (fake extension host) ------------------------------------

const ASSISTANT_DONE = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] };
const ASSISTANT_ABORTED = { role: "assistant", stopReason: "aborted", content: [] };
const ASSISTANT_ERROR = { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded", content: [] };

/** A session branch that reconstructs into a goal in `status`. */
function branchWithGoal(status: string): Record<string, unknown>[] {
	return [
		{
			type: "custom",
			customType: STATE_TYPE,
			data: {
				version: 2,
				action: "set",
				goal: {
					id: "goal-under-test",
					objective: "Ship the factory harness",
					status,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
			},
		},
	];
}

async function startGoalHost(status: string, hasUI = false) {
	const host = createFakeHost({ sessionId: "goal-session", branch: branchWithGoal(status), hasUI });
	goalExtension(host.pi);
	await host.fire("session_start", { reason: "startup" });
	return host;
}

/** `get_goal` returns `{ goal, remainingTokens, completionBudgetReport }`. */
function goalStatus(result: Awaited<ReturnType<Awaited<ReturnType<typeof startGoalHost>>["callTool"]>>): string | undefined {
	return (result.details as { goal?: { status?: string } } | undefined)?.goal?.status;
}

/** Continuations that went out as a sent message. After the move to the
 *  settlement boundary no run should use this channel; `/goal` still does. */
function continuations(host: Awaited<ReturnType<typeof startGoalHost>>) {
	return host.messages.filter((entry) => entry.message.customType === CONTINUATION_MESSAGE_TYPE);
}

/** The payload pi hands `agent_before_settle`: the drafts proposed so far, the
 *  decision so far, and the context preview rebuilt from them. */
function boundaryEvent(entries: Record<string, unknown>[] = [], pendingMessages: unknown[] = []) {
	return { entries, continue: false, context: { pendingMessages }, outcome: "completed" };
}

interface BoundaryProposal {
	entries?: { type?: string; customType?: string; content?: unknown; display?: unknown; details?: { goalId?: string } }[];
	continue?: boolean;
}

/** The continuation drafts in a boundary result, whoever proposed them. */
function boundaryContinuations(result: unknown): NonNullable<BoundaryProposal["entries"]> {
	return ((result ?? {}) as BoundaryProposal).entries?.filter((entry) => entry.customType === CONTINUATION_MESSAGE_TYPE) ?? [];
}

test("a completed run's settlement boundary proposes exactly one continuation", async () => {
	const host = await startGoalHost("active");

	const before = await host.callTool("get_goal", {});
	assert.equal(goalStatus(before), "active", "session_start must reconstruct the goal from the branch");

	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_DONE] });

	// An earlier handler's proposal, which this handler must not drop.
	const sentinel = { type: "custom", customType: "another-extension", data: { note: "proposed first" } };
	const boundary = (await host.fire("agent_before_settle", boundaryEvent([sentinel]))) as BoundaryProposal;

	assert.equal(boundary.continue, true, "the boundary is where the next provider request is requested");
	assert.ok(boundary.entries?.includes(sentinel), "an earlier handler's draft is carried forward, not replaced");

	const drafted = boundaryContinuations(boundary);
	assert.equal(drafted.length, 1);
	const [continuation] = drafted;
	assert.equal(continuation?.type, "custom_message");
	assert.match(String(continuation?.content), /Continue working toward the active thread goal/);
	assert.equal(continuation?.display, false, "the transcript shows the goal status, not the prompt");
	// The `context` hook keys on this pair to drop a consumed continuation.
	assert.equal(continuation?.details?.goalId, "goal-under-test");
	assert.equal(continuations(host).length, 0, "a continuation is a boundary draft now, not a sent message");

});

test("a goal that is not active proposes no continuation at the boundary", async () => {
	for (const status of ["paused", "blocked", "usageLimited", "budgetLimited", "complete"]) {
		const host = await startGoalHost(status);
		await host.fire("agent_start", {});
		await host.fire("agent_end", { messages: [ASSISTANT_DONE] });

		const sentinel = { type: "custom", customType: "another-extension", data: null };
		const boundary = (await host.fire("agent_before_settle", boundaryEvent([sentinel]))) as BoundaryProposal | undefined;

		assert.equal(boundaryContinuations(boundary).length, 0, `${status} must not continue`);
		assert.notEqual(boundary?.continue, true, `${status} must not force a provider request`);
		assert.equal(continuations(host).length, 0, `${status} must not fall back to a sent message`);
	}
});

test("each low-level run gets its own continuation", async () => {
	// The per-run flag is cleared by `agent_start`. Without that clear a goal would
	// continue once and then stall for the rest of the session, which no other test
	// here would catch: every other case fires a single run.
	const host = await startGoalHost("active");

	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_DONE] });
	const first = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal | undefined;
	assert.equal(boundaryContinuations(first).length, 1);

	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_DONE] });
	const second = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal | undefined;
	assert.equal(boundaryContinuations(second).length, 1, "the next run must be able to continue too");
});

test("a boundary dispatch with a continuation already queued proposes nothing", async () => {
	// This stands in for the flag's one real case: a `/goal` command landing after
	// pi's post-run check has decided nothing is queued and before the boundary
	// runs, so its follow-up is flushed only afterwards. The double does not model
	// pi's run loop, so the state is constructed directly rather than timed: a
	// command that lands mid-run is drained by a fresh run, whose `agent_start`
	// clears the flag before any boundary.
	const host = await startGoalHost("paused");
	await host.fire("agent_start", {});
	await host.runCommand("goal", "resume");
	assert.equal(goalStatus(await host.callTool("get_goal", {})), "active");

	const queued = continuations(host);
	assert.equal(queued.length, 1, "the command queues its continuation as a message");

	const boundary = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal | undefined;
	assert.equal(boundaryContinuations(boundary).length, 0);
	assert.notEqual(boundary?.continue, true);
});

test("a completed run records its usage against the goal", async () => {
	const host = await startGoalHost("active");

	await host.fire("agent_start", {});
	await host.fire("agent_end", {
		messages: [{ ...ASSISTANT_DONE, usage: { input: 400, output: 100 } }],
	});

	// 400 input minus 0 cache reads, plus 100 output.
	const after = await host.callTool("get_goal", {});
	assert.equal((after.details as { goal?: { tokensUsed?: number } }).goal?.tokensUsed, 500);
	const actions = host.appended
		.filter((entry) => entry.customType === STATE_TYPE)
		.map((entry) => (entry.data as { action?: string } | undefined)?.action);
	assert.ok(actions.includes("account"), "accounting is persisted");
});

test("declining the abort pause leaves the goal active and this run uncontinued", async () => {
	// The prompt offers a pause; declining it is not a request to continue. pi
	// skips the boundary for an aborted run, so the goal waits for the user.
	const host = await startGoalHost("active", true);

	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_ABORTED] });

	assert.equal(goalStatus(await host.callTool("get_goal", {})), "active");
	assert.equal(continuations(host).length, 0);
});

test("a run that ends in an error requests no continuation and keeps its status", async () => {
	const stopped = await startGoalHost("active");
	await stopped.fire("agent_start", {});
	await stopped.fire("agent_end", { messages: [ASSISTANT_ERROR] });
	assert.equal(goalStatus(await stopped.callTool("get_goal", {})), "usageLimited", "error-stop reporting is unchanged");
	const afterEnd = (await stopped.fire("agent_before_settle", { ...boundaryEvent(), outcome: "error" })) as BoundaryProposal | undefined;
	assert.equal(boundaryContinuations(afterEnd).length, 0);

	// And on its own: the outcome is what stops continuation, so a failed run is
	// not continued even when `agent_end` left the goal active.
	const stillActive = await startGoalHost("active");
	await stillActive.fire("agent_start", {});
	const byOutcome = (await stillActive.fire("agent_before_settle", { ...boundaryEvent(), outcome: "error" })) as BoundaryProposal | undefined;
	assert.equal(boundaryContinuations(byOutcome).length, 0);
	assert.notEqual(byOutcome?.continue, true);
});

test("an aborted run pauses an active goal instead of continuing it when no UI is available", async () => {
	const host = await startGoalHost("active", false);

	// pi skips `agent_before_settle` for an aborted run, so this never fires the
	// boundary: the abort path in `agent_end` is the only one that can act.
	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_ABORTED] });

	assert.equal(continuations(host).length, 0);
	const goal = await host.callTool("get_goal", {});
	assert.equal(goalStatus(goal), "paused");
	const lastState = host.appended.filter((entry) => entry.customType === STATE_TYPE).at(-1);
	assert.equal((lastState?.data as { action?: string } | undefined)?.action, "status");
});

test("a pending notice does not stop the boundary from continuing the goal", async () => {
	// A message an extension sent without `triggerTurn` — a subagent completion
	// notice is exactly that — is appended to the transcript but does not start a
	// run. Guarding on the boundary's pending-message preview would therefore stall
	// an active goal for something that was never going to speak, which is the
	// regression this test exists to prevent.
	const host = await startGoalHost("active");
	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [ASSISTANT_DONE] });

	const boundary = (await host.fire(
		"agent_before_settle",
		boundaryEvent([], [{ role: "user", customType: "subagent-result", content: "a child finished" }]),
	)) as BoundaryProposal | undefined;

	assert.equal(boundaryContinuations(boundary).length, 1, "the goal still continues");
	assert.equal(boundary?.continue, true);
});
