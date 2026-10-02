// Unit tests for child-session usage accounting.
//
// Risk covered: token and cost figures are shown to the agent and the user to
// decide whether a run is worth its spend, so a parsing bug here is a wrong
// number, not a crash.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { formatUsage, readSessionUsage } from "../usage.ts";

async function writeSession(t: { after: (fn: () => unknown) => void }, lines: string[]): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "subagent-usage-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "session.jsonl");
	await writeFile(file, `${lines.join("\n")}\n`, "utf8");
	return file;
}

function usageLine(role: string, usage: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id: `e${Math.random().toString(16).slice(2)}`, message: { role, usage } });
}

test("readSessionUsage returns undefined without a session file", async () => {
	assert.equal(await readSessionUsage(undefined), undefined);
	assert.equal(await readSessionUsage("/nonexistent/session.jsonl"), undefined);
});

test("readSessionUsage sums assistant and nested toolResult usage", async (t) => {
	const file = await writeSession(t, [
		JSON.stringify({ type: "session", version: 3, id: "s" }),
		usageLine("assistant", { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, totalTokens: 16, cost: { total: 0.1 } }),
		usageLine("toolResult", { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.02 } }),
		usageLine("assistant", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.005 } }),
	]);
	const usage = await readSessionUsage(file);
	assert.ok(usage);
	assert.equal(usage.input, 14);
	assert.equal(usage.output, 6);
	assert.equal(usage.cacheRead, 1);
	assert.equal(usage.cacheWrite, 2);
	assert.equal(usage.totalTokens, 21);
	assert.ok(Math.abs(usage.cost - 0.125) < 1e-9);
	assert.equal(usage.turns, 2, "only assistant messages count as turns");
});

test("readSessionUsage skips malformed lines and non-usage entries", async (t) => {
	const file = await writeSession(t, [
		"{not json",
		"",
		JSON.stringify({ type: "session", version: 3, id: "s" }),
		JSON.stringify({ type: "message", message: { role: "user" } }),
		JSON.stringify({ type: "usage", kind: "cache_warm", usage: { totalTokens: 999 } }),
		usageLine("assistant", { input: "nonsense", totalTokens: 4 }),
	]);
	const usage = await readSessionUsage(file);
	assert.ok(usage);
	assert.equal(usage.totalTokens, 4, "garbage values become 0, non-numeric input is dropped");
	assert.equal(usage.input, 0);
	assert.equal(usage.turns, 1);
});

test("readSessionUsage returns undefined when the session recorded nothing", async (t) => {
	const file = await writeSession(t, [JSON.stringify({ type: "session", version: 3, id: "s" })]);
	assert.equal(await readSessionUsage(file), undefined);
});

test("formatUsage abbreviates token counts at each magnitude", () => {
	const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
	assert.equal(formatUsage(undefined), undefined);
	assert.equal(formatUsage({ ...base, totalTokens: 999 }), "999 tok · 1 turn");
	assert.equal(formatUsage({ ...base, totalTokens: 1_500 }), "1.5k tok · 1 turn");
	assert.equal(formatUsage({ ...base, totalTokens: 12_345 }), "12k tok · 1 turn");
});

test("formatUsage pluralizes turns and suppresses a zero cost", () => {
	const base = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: 0 };
	assert.equal(formatUsage({ ...base, turns: 1 }), "10 tok · 1 turn");
	assert.equal(formatUsage({ ...base, turns: 3 }), "10 tok · 3 turns");
	assert.equal(formatUsage({ ...base, turns: 2, cost: 0.123456 }), "10 tok · 2 turns · $0.123456");
});