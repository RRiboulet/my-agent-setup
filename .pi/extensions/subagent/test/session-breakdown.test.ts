// Behaviour tests for the vendored /session-breakdown extension.
//
// Upstream ships this file with no tests at all (1.8k lines, one file, no
// suite), which is why it gets ours. Two things are under test:
//
//   1. The aggregation itself, over synthetic fixtures with known
//      sessions/messages/tokens/cost. The dir is injected, so the suite never
//      reads the developer's real ~/.pi/agent tree.
//   2. The three LOCAL PATCH hunks, which are ours and therefore ours to pin:
//      the roots (LOCAL PATCH 1), the inherited-prefix exclusion (LOCAL PATCH 2)
//      and the footer note (LOCAL PATCH 3).
//
// Why patch 2 needs tests at all: summing whole session files double counts the
// prefix a forked file inherits from its parent. Measured on this machine, one
// real `handoff: fork` child reported 1.79x its own cost, and sessions/ already
// contained 2,989,693 duplicated tokens from pi's own /fork. The numbers below
// are the fixtures' numbers, chosen so a regression cannot hide inside a
// plausible-looking total.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { __test__ } from "../../session-breakdown.ts";
import { withEnv } from "./helpers.ts";

const { computeBreakdown, defaultSessionRoots, inheritedNote, readEntryIds, readSessionHeader, resolveInheritedIds } = __test__;

const MODEL_CHANGE = { type: "model_change", id: "mc1", parentId: null, provider: "openrouter", modelId: "test/model" };

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	totalTokens: number;
	cost: number;
}

function usage({ totalTokens, cost, input = 0, output = 0, cacheRead = 0 }: Usage) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

let seq = 0;
function assistant(u: Usage, role = "assistant") {
	seq += 1;
	return {
		type: "message",
		id: `e${seq}`,
		parentId: "mc1",
		timestamp: new Date().toISOString(),
		message: { role, provider: "openrouter", model: "test/model", usage: usage(u) },
	};
}

/** A session header. `parentSession` is the absolute path of the source file. */
function header(id: string, parentSession?: string) {
	const h: Record<string, unknown> = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: "/tmp/fixture",
	};
	if (parentSession) h.parentSession = parentSession;
	return h;
}

async function writeSession(file: string, entries: unknown[]): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	return file;
}

/** A filename the scanner dates from its own regex: `<ISO with dashes>_<id>.jsonl`. */
function stamp(): string {
	return new Date().toISOString().replace(/:/g, "-").replace(/\.(\d{3})Z$/, "-$1Z");
}

/**
 * The entries a forked file starts with: every non-header line of `parentFile`,
 * byte for byte, ids included. That is exactly what pi's `forkFrom`, upstream's
 * `split-fork.ts` and our `handoff.ts` write, so the fixtures inherit real ids
 * instead of hardcoded ones that would drift the moment a helper renumbers.
 */
async function inheritedPrefix(parentFile: string): Promise<unknown[]> {
	const { readFile } = await import("node:fs/promises");
	const lines = (await readFile(parentFile, "utf8")).split("\n").filter((l) => l.trim());
	return lines.slice(1).map((l) => JSON.parse(l));
}

async function withFixtureDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "session-breakdown-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Totals for the 30-day range, which is what the footer and tests care about. */
async function totals(roots: string[]) {
	const data = await computeBreakdown(undefined, undefined, { roots });
	const range = data.ranges.get(30)!;
	return {
		sessions: range.sessions,
		messages: range.totalMessages,
		tokens: range.totalTokens,
		cost: range.totalCost,
		inherited: data.inherited,
	};
}

after(() => {
	// Nothing global to tear down; the hook exists so a future temp-dir helper
	// has an obvious home and the suite fails loudly rather than silently if one
	// is added without cleanup.
});

// --- LOCAL PATCH 1: roots -----------------------------------------------------

test("LOCAL PATCH 1: the roots are the agent dir's session trees, not a hardcoded homedir path", async () => {
	await withFixtureDir(async (dir) => {
		assert.deepEqual(defaultSessionRoots(dir), [
			path.join(dir, "sessions"),
			path.join(dir, "tmux-subagents"),
			path.join(dir, "subagents"),
		]);
	});
});

test("LOCAL PATCH 1: defaultSessionRoots() follows PI_CODING_AGENT_DIR", async () => {
	await withFixtureDir(async (dir) => {
		await withEnv({ PI_CODING_AGENT_DIR: dir }, async () => {
			// Upstream hardcoded `<homedir>/.pi/agent/sessions`, so a relocated agent
			// dir was invisible to it (upstream PR #24 asked for this, unmerged).
			assert.deepEqual(defaultSessionRoots(), [
				path.join(dir, "sessions"),
				path.join(dir, "tmux-subagents"),
				path.join(dir, "subagents"),
			]);
		});
	});
});

test("LOCAL PATCH 1: a child session outside sessions/ is now counted", async () => {
	await withFixtureDir(async (agentDir) => {
		const roots = defaultSessionRoots(agentDir);
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const runDir = path.join(agentDir, "tmux-subagents", "parent-session-id", "run-id", "session");

		await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 100, cost: 0.1 }),
		]);
		// A standalone child: its own file, no inherited context, under a run dir.
		await writeSession(path.join(runDir, `${stamp()}_child.jsonl`), [
			header("child"),
			MODEL_CHANGE,
			assistant({ totalTokens: 50, cost: 0.05 }),
		]);

		const all = await totals(roots);
		const sessionsOnly = await totals([path.join(agentDir, "sessions")]);

		assert.equal(all.sessions, 2);
		assert.equal(all.tokens, 150);
		assert.equal(sessionsOnly.sessions, 1, "the stock scanner sees only the parent");
		assert.equal(sessionsOnly.tokens, 100);
	});
});

test("a root that does not exist is skipped, not fatal", async () => {
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions", "--tmp-fixture--");
		await writeSession(path.join(sessions, `${stamp()}_only.jsonl`), [header("only"), MODEL_CHANGE, assistant({ totalTokens: 7, cost: 0.01 })]);
		// tmux-subagents/ and subagents/ deliberately absent.
		const t = await totals(defaultSessionRoots(dir));
		assert.equal(t.sessions, 1);
		assert.equal(t.tokens, 7);
	});
});

// --- LOCAL PATCH 2: inherited prefix ------------------------------------------

test("LOCAL PATCH 2: a fork contributes only its own turns", async () => {
	await withFixtureDir(async (agentDir) => {
		const parentFile = await writeSession(path.join(agentDir, "sessions", "--tmp-fixture--", `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 400, cost: 0.412, cacheRead: 380 }),
		]);

		const forkFile = await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "fork.jsonl"), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
			assistant({ totalTokens: 88, cost: 0.088, cacheRead: 4000 }),
		]);

		const lineage = await resolveInheritedIds(forkFile, new Map(), new Map());
		assert.equal(lineage.broken, false);
		const parentIds = await readEntryIds(parentFile);
		assert.deepEqual([...lineage.ids].sort(), [...parentIds!].sort(), "the child's prefix is exactly the parent's ids");

		const t = await totals(defaultSessionRoots(agentDir));
		// The whole point: 0.412 from the parent + 0.088 from the child, not 0.412
		// twice. Before the patch this was 0.912.
		assert.equal(round(t.cost), 0.5);
		assert.equal(t.tokens, 488);
		assert.equal(t.messages, 2, "the inherited copy is not a message this session had");
		assert.equal(t.sessions, 2, "the child still counts as a session");
		assert.equal(round(t.inherited.cost), 0.412, "and the excluded amount is reported");
		assert.equal(t.inherited.entries, 2);
		assert.equal(t.inherited.sessions, 1);
		assert.equal(t.inherited.unknownParents, 0);
	});
});

test("LOCAL PATCH 2: the child keeps the parent's model attribution", async () => {
	await withFixtureDir(async (agentDir) => {
		// The inherited prefix carries the model_change the child never re-emits,
		// so skipping inherited entries must not blind the parser to the model.
		const parentFile = await writeSession(path.join(agentDir, "sessions", "--tmp-fixture--", `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 10, cost: 0.01 }),
		]);
		await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "fork.jsonl"), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
			// No model_change and no explicit provider here: the model can only come
			// from replaying the inherited prefix.
			{ type: "message", id: "own1", parentId: "e1", message: { role: "assistant", usage: usage({ totalTokens: 20, cost: 0.02 }) } },
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: defaultSessionRoots(agentDir) });
		const range = data.ranges.get(30)!;
		assert.equal(round(range.modelCost.get("openrouter/test/model")!), 0.03, "both sessions' cost lands on one model");
		assert.equal(range.modelSessions.get("openrouter/test/model"), 2);
	});
});

test("LOCAL PATCH 2: a fork of a fork excludes the whole ancestor chain, once", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const grandFile = await writeSession(path.join(sessions, `${stamp()}_grand.jsonl`), [
			header("grand"),
			MODEL_CHANGE,
			assistant({ totalTokens: 100, cost: 0.1 }),
		]);
		const parentFile = await writeSession(path.join(sessions, `${stamp()}_mid.jsonl`), [
			header("mid", grandFile),
			...(await inheritedPrefix(grandFile)),
			assistant({ totalTokens: 20, cost: 0.02 }),
		]);
		await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "fork.jsonl"), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
			assistant({ totalTokens: 5, cost: 0.005 }),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		// 0.1 grand + 0.02 mid + 0.005 fork. The prefix must not be charged twice
		// (once by the mid file, once by the fork file).
		assert.equal(round(t.cost), 0.125);
		assert.equal(t.tokens, 125);
		assert.equal(t.sessions, 3);
	});
});

test("LOCAL PATCH 2: a fork that inherited everything still counts as a session", async () => {
	await withFixtureDir(async (agentDir) => {
		const parentFile = await writeSession(path.join(agentDir, "sessions", "--tmp-fixture--", `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 100, cost: 0.1 }),
		]);
		// A child seeded with the parent's branch and then abandoned: every entry
		// is inherited. Upstream's "dead session" filter drops such a file, which
		// would silently lose a session the user really started.
		await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "fork.jsonl"), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		assert.equal(t.sessions, 2);
		assert.equal(round(t.cost), 0.1, "the parent's cost, counted once");
		assert.equal(t.tokens, 100);
	});
});

test("LOCAL PATCH 2: an unreadable parent is counted in full and reported", async () => {
	await withFixtureDir(async (agentDir) => {
		const ghost = path.join(agentDir, "tmux-subagents", "sid", "gone", "session", "fork.jsonl");
		await writeSession(ghost, [
			header("fork", path.join(agentDir, "tmux-subagents", "sid", "deleted-by-clean", "session", "fork.jsonl")),
			MODEL_CHANGE,
			assistant({ totalTokens: 60, cost: 0.06 }),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		assert.equal(t.inherited.unknownParents, 1, "flagged rather than silently guessed");
		assert.equal(t.inherited.sessions, 1);
		assert.equal(round(t.cost), 0.06, "overcounting is the safe direction, but it is labelled");
		assert.match(inheritedNote(t.inherited)!, /unreadable parent/);
	});
});

test("LOCAL PATCH 2: a parent cycle terminates instead of hanging", async () => {
	await withFixtureDir(async (agentDir) => {
		const dir = path.join(agentDir, "sessions", "--tmp-fixture--");
		const a = path.join(dir, `${stamp()}_a.jsonl`);
		const b = path.join(dir, `${stamp()}_b.jsonl`);
		await writeSession(a, [header("a", b), MODEL_CHANGE, assistant({ totalTokens: 10, cost: 0.01 })]);
		await writeSession(b, [header("b", a), MODEL_CHANGE, assistant({ totalTokens: 10, cost: 0.01 })]);

		const t = await totals([path.join(agentDir, "sessions")]);
		assert.equal(t.inherited.unknownParents, 2, "both files report a broken chain");
		// Each file still contributes its own entries: ids are excluded only where
		// the other file is a known ancestor, and a cycle is not a lineage.
		assert.equal(round(t.cost), 0.02);
	});
});

test("LOCAL PATCH 2: the header reader tells 'no parent' from 'unreadable'", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const plain = await writeSession(path.join(sessions, `${stamp()}_plain.jsonl`), [header("plain"), MODEL_CHANGE]);
		assert.deepEqual(await readSessionHeader(plain), { parentSession: null });

		const child = await writeSession(path.join(sessions, `${stamp()}_child.jsonl`), [header("child", plain), MODEL_CHANGE]);
		assert.deepEqual(await readSessionHeader(child), { parentSession: plain });

		assert.equal(await readSessionHeader(path.join(sessions, "does-not-exist.jsonl")), null);
	});
});

test("LOCAL PATCH 2: a malformed line does not abort the scan", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const file = path.join(sessions, `${stamp()}_broken.jsonl`);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(
			file,
			[
				JSON.stringify(header("broken")),
				JSON.stringify(MODEL_CHANGE),
				"{not json",
				JSON.stringify(assistant({ totalTokens: 9, cost: 0.009 })),
				"",
			].join("\n"),
			"utf8",
		);
		const t = await totals([path.join(agentDir, "sessions")]);
		assert.equal(t.tokens, 9);
	});
});

// --- the whole composite scenario --------------------------------------------

test("the composite day: parent, fork, standalone and a resumed child", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const runs = path.join(agentDir, "tmux-subagents", "sid");

		const parentFile = await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 1000, cost: 0.412 }),
		]);

		// fork: parent's prefix copied verbatim, then its own turn.
		await writeSession(path.join(runs, "runA", "session", "fork.jsonl"), [
			header("forkA", parentFile),
			...(await inheritedPrefix(parentFile)),
			assistant({ totalTokens: 200, cost: 0.088 }),
		]);

		// standalone: a fresh file of its own.
		await writeSession(path.join(runs, "runB", "session", `${stamp()}_runB.jsonl`), [
			header("standaloneB"),
			MODEL_CHANGE,
			assistant({ totalTokens: 120, cost: 0.05 }),
		]);

		// resume: one physical file, two attempts appended to it. Per-attempt
		// baselines make this two runs for subagent_status; for money it is one
		// file and both requests were really billed, so it counts once, in full.
		await writeSession(path.join(runs, "runC", "session", "resume.jsonl"), [
			header("resumeC"),
			MODEL_CHANGE,
			assistant({ totalTokens: 80, cost: 0.03 }),
			assistant({ totalTokens: 60, cost: 0.02 }),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		assert.equal(round(t.cost), 0.6, "0.412 + 0.088 + 0.05 + 0.03 + 0.02");
		assert.equal(t.sessions, 4);
		assert.equal(t.tokens, 1000 + 200 + 120 + 80 + 60);
		assert.equal(round(t.inherited.cost), 0.412);
		assert.equal(t.inherited.sessions, 1);
		assert.equal(t.inherited.unknownParents, 0);
	});
});

test("with no child sessions at all the numbers are the stock scanner's", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		await writeSession(path.join(sessions, `${stamp()}_one.jsonl`), [header("one"), MODEL_CHANGE, assistant({ totalTokens: 300, cost: 0.3 })]);
		await writeSession(path.join(sessions, `${stamp()}_two.jsonl`), [header("two"), MODEL_CHANGE, assistant({ totalTokens: 700, cost: 0.7 })]);

		const t = await totals(defaultSessionRoots(agentDir));
		assert.deepEqual(
			{ sessions: t.sessions, messages: t.messages, tokens: t.tokens, cost: round(t.cost) },
			{ sessions: 2, messages: 2, tokens: 1000, cost: 1 },
		);
		assert.equal(t.inherited.sessions, 0);
		assert.equal(inheritedNote(t.inherited), null, "no note when there is nothing to explain");
	});
});

test("a pi-native fork inside sessions/ stops double counting", async () => {
	await withFixtureDir(async (agentDir) => {
		// pi's own /fork and --fork copy the parent's entries into the session dir.
		// Nothing about this involves the subagent extension, and the duplication
		// is real: 2,989,693 tokens of it on this machine before the patch.
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const parentFile = await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 500, cost: 0.5 }),
		]);
		await writeSession(path.join(sessions, `${stamp()}_fork.jsonl`), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
			assistant({ totalTokens: 20, cost: 0.02 }),
		]);

		const t = await totals([path.join(agentDir, "sessions")]);
		assert.equal(round(t.cost), 0.52, "0.5 from the parent, 0.02 from the fork");
		assert.equal(t.sessions, 2);
	});
});

// --- LOCAL PATCH 3: the note --------------------------------------------------

test("LOCAL PATCH 3: the note names what was excluded and what was uncertain", () => {
	assert.equal(
		inheritedNote({ sessions: 3, entries: 120, messages: 100, tokens: 5000, cost: 0.25, unknownParents: 0 }),
		"incl. child sessions · 3 forked/child sessions · 120 inherited entries excluded ($0.250 counted once, in the parent)",
	);
	assert.equal(
		inheritedNote({ sessions: 1, entries: 1, messages: 1, tokens: 5, cost: 0.01, unknownParents: 1 }),
		"incl. child sessions · 1 forked/child session · 1 inherited entry excluded ($0.0100 counted once, in the parent) · 1 with unreadable parent, counted in full",	);
	assert.equal(inheritedNote({ sessions: 0, entries: 0, messages: 0, tokens: 0, cost: 0, unknownParents: 0 }), null);
});

test("LOCAL PATCH 4: the test surface is exported and the default export is still a factory", async () => {
	for (const name of ["computeBreakdown", "defaultSessionRoots", "inheritedNote", "parseSessionFile", "readEntryIds", "readSessionHeader", "resolveInheritedIds"]) {
		assert.equal(typeof (__test__ as Record<string, unknown>)[name], "function", `__test__.${name} must be exported`);
	}
	const mod = await import("../../session-breakdown.ts");
	assert.equal(typeof mod.default, "function");
});

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}
