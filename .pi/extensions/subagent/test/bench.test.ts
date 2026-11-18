import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { summarizeEvents, parseJsonl, parseJsonlTolerant } from "../../../../tools/bench/lib/events.mjs";
import { loadTasks, selectTasks, renderPrompt } from "../../../../tools/bench/lib/tasks.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

test("summarizeEvents counts tool calls, durations, usage and the final answer", () => {
	const records = [
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hi" } }],
				usage: { totalTokens: 100, cost: { total: 0.001 } },
			},
		},
		{
			type: "message_end",
			message: { role: "toolResult", toolName: "bash", durationMs: 25, isError: false, content: [] },
		},
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				usage: { totalTokens: 10, cost: { total: 0.0001 } },
			},
		},
		{ type: "turn_end", message: { role: "assistant", usage: { totalTokens: 999 } }, toolResults: [] },
		{ type: "agent_settled", aborted: false },
	];

	const summary = summarizeEvents(records);
	assert.equal(summary.toolCallCount, 1);
	assert.equal(summary.toolCallsByName.bash, 1);
	assert.equal(summary.toolResultCount, 1);
	assert.equal(summary.toolTimeMs, 25);
	assert.equal(summary.longestToolMs, 25);
	assert.equal(summary.tokens, 110);
	assert.ok(Math.abs(summary.cost - 0.0011) < 1e-9);
	assert.equal(summary.turns, 1);
	assert.equal(summary.errors, 0);
	assert.equal(summary.aborted, false);
	assert.equal(summary.finalAnswer, "hi");
});

test("summarizeEvents counts an errored tool result and ignores deltas", () => {
	const summary = summarizeEvents([
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" } },
		{ type: "message_end", message: { role: "toolResult", toolName: "read", durationMs: 3, isError: true } },
		{ type: "agent_settled", aborted: true },
	]);
	assert.equal(summary.toolResultCount, 1);
	assert.equal(summary.errors, 1);
	assert.equal(summary.toolDurations.read, 3);
	assert.equal(summary.aborted, true);
	assert.equal(summary.finalAnswer, "");
});

test("parseJsonl names the line it cannot parse", () => {
	assert.deepEqual(parseJsonl('{"type":"agent_start"}\n\n'), [{ type: "agent_start" }]);
	assert.throws(() => parseJsonl('{"type":"ok"}\nnot json\n'), /line 2/);
});

test("parseJsonlTolerant keeps the complete records before a truncated tail", () => {
	const good = '{"type":"agent_start"}\n{"type":"agent_end"}';
	const cut = `${good}\n{"type":"agent_sett`;
	const parsed = parseJsonlTolerant(cut);
	assert.deepEqual(parsed.records, [{ type: "agent_start" }, { type: "agent_end" }]);
	assert.equal(parsed.truncated, true);
	assert.match(parsed.error ?? "", /line 3/);
	assert.equal(parseJsonlTolerant(good).truncated, false);
});

test("every task definition loads and the ids are selectable", () => {
	const tasks = loadTasks(path.join(REPO_ROOT, "tools/bench/tasks"));
	assert.equal(tasks.length, 8);
	const ids = new Set(tasks.map((task) => task.id));
	assert.equal(ids.size, tasks.length);
	for (const task of tasks) {
		assert.ok(task.repo.length > 0, `${task.id} has no repo`);
		assert.ok(task.timeoutMs > 0, `${task.id} has no timeout`);
		assert.ok(task.prompt.length > 0, `${task.id} has no prompt`);
	}
	assert.deepEqual(selectTasks(tasks, "head-hash").map((task) => task.id), ["head-hash"]);
	assert.throws(() => selectTasks(tasks, "nope"), /unknown task id/);
});

test("renderPrompt substitutes known variables and leaves unknown ones alone", () => {
	assert.equal(renderPrompt("{{gitHead}} {{nope}}", { gitHead: "abc" }), "abc {{nope}}");
});

import { skillsInToolCall } from "../../../../tools/bench/skills.mjs";

test("skillsInToolCall reads a path and a bash command, and deduplicates", () => {
	assert.deepEqual(skillsInToolCall({ name: "read", arguments: { path: "/repo/.pi/skills/worktree/SKILL.md" } }), ["worktree"]);
	assert.deepEqual(
		skillsInToolCall({ name: "bash", arguments: { command: "cat .pi/skills/commit/SKILL.md .pi/skills/commit/references/x.md" } }),
		["commit"],
	);
	assert.deepEqual(skillsInToolCall({ name: "read", arguments: { path: "/repo/README.md" } }), []);
	assert.deepEqual(skillsInToolCall({ name: "bash", arguments: { command: "ls .pi/skills" } }), []);
});

import { suiteFromAnswer } from "../../../../tools/bench/lib/suite.mjs";


test("suiteFromAnswer separates a completed task from a green suite", () => {
	assert.deepEqual(suiteFromAnswer("Pass: 1133\nFail: 1"), { passed: 1133, failed: 1, green: false });
	assert.deepEqual(suiteFromAnswer("**Passed:** 1132\n**Failed:** 2"), { passed: 1132, failed: 2, green: false });
	assert.deepEqual(suiteFromAnswer("1134 pass, 0 fail"), { passed: 1134, failed: 0, green: true });
	assert.equal(suiteFromAnswer("0 passed, 1134 failed").green, false);
	assert.equal(suiteFromAnswer("I ran the suite."), null);
});
