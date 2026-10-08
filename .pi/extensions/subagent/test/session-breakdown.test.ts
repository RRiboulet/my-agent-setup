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
// real `handoff: "fork"` child held 1,473,545 tokens against the 527,566 its
// own turns added, and sessions/ already contained 2,989,693 duplicated tokens
// from pi's own /fork. The numbers below are the fixtures' numbers, chosen so a
// regression cannot hide inside a plausible-looking total.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import { __test__ } from "../../session-breakdown.ts";
import { withEnv } from "./helpers.ts";

const { BreakdownComponent, chooseCwdPaletteFromLast30Days, choosePaletteFromLast30Days, computeBreakdown, defaultSessionRoots, inheritedNote, readEntryIds, readSessionHeader, renderCwdTable, renderDowTable, renderModelTable, renderTodTable, resolveInheritedIds } = __test__;

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
		assert.equal(t.inherited.forkedSessions, 1);
		assert.equal(t.inherited.unknownLineage, 0);
		assert.equal(t.inherited.childSessions, 1);
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

test("LOCAL PATCH 2: an unreadable parent is reported as an incomplete lineage", async () => {
	await withFixtureDir(async (agentDir) => {
		const ghost = path.join(agentDir, "tmux-subagents", "sid", "gone", "session", "fork.jsonl");
		await writeSession(ghost, [
			header("fork", path.join(agentDir, "tmux-subagents", "sid", "deleted-by-clean", "session", "fork.jsonl")),
			MODEL_CHANGE,
			assistant({ totalTokens: 60, cost: 0.06 }),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		assert.equal(t.inherited.unknownLineage, 1, "flagged rather than silently guessed");
		assert.equal(round(t.cost), 0.06, "overcounting is the safe direction, but it is labelled");
		assert.match(inheritedNote(t.inherited)!, /lineage incomplete/);
	});
});

test("LOCAL PATCH 2: a half-walked chain says so, and claims nothing it did not do", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const midFile = await writeSession(path.join(sessions, `${stamp()}_mid.jsonl`), [
			// Its own parent is gone, but the file is readable, so its ids are known.
			header("mid", path.join(sessions, "vanished-grandparent.jsonl")),
			MODEL_CHANGE,
			assistant({ totalTokens: 100, cost: 0.1 }),
		]);
		// The child excludes what it can resolve (mid's entries) and keeps the rest.
		await writeSession(path.join(sessions, `${stamp()}_child.jsonl`), [
			header("child", midFile),
			...(await inheritedPrefix(midFile)),
			assistant({ totalTokens: 10, cost: 0.01 }),
		]);

		const t = await totals([path.join(agentDir, "sessions")]);
		const note = inheritedNote(t.inherited)!;
		assert.equal(t.inherited.unknownLineage, 2, "mid's broken chain and the child that inherited from it");
		assert.equal(t.inherited.forkedSessions, 1);
		assert.equal(round(t.cost), 0.11, "mid 0.1 + child 0.01, with the prefix excluded");
		// "counted in full" would be false here: this child DID exclude entries.
		assert.doesNotMatch(note, /counted in full/);
		assert.match(note, /lineage incomplete/);
	});
});

test("LOCAL PATCH 2: a file whose own header is unreadable is reported, not assumed clean", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const parentFile = await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 100, cost: 0.5 }),
		]);
		// pi's `_rewriteFile` truncates before it writes, and pi tolerates junk
		// before the header, so a scan can catch a fork mid-rewrite: the entries are
		// all there but the header is not the first line. Without the report, this
		// file's inherited prefix is counted a second time, silently.
		const torn = path.join(sessions, `${stamp()}_torn.jsonl`);
		await mkdir(path.dirname(torn), { recursive: true });
		await writeFile(
			torn,
			["{ truncated", ...(await inheritedPrefix(parentFile)), JSON.stringify(assistant({ totalTokens: 10, cost: 0.01 }))].join("\n") + "\n",
			"utf8",
		);

		const t = await totals([path.join(agentDir, "sessions")]);
		assert.equal(t.inherited.unknownLineage, 1);
		assert.equal(t.inherited.forkedSessions, 0, "nothing could be recognised as inherited");
		assert.match(inheritedNote(t.inherited)!, /lineage incomplete/);
	});
});

test("LOCAL PATCH 3: a lineage child with no inherited prefix claims nothing", async () => {
	await withFixtureDir(async (agentDir) => {
		// `handoff: lineage` writes a header-only file that still points at its
		// parent. If that parent is later deleted there is nothing to exclude, and
		// the note must not claim that "0 inherited entries" were excluded.
		await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "lineage.jsonl"), [
			header("lineage", path.join(agentDir, "sessions", "gone", "parent.jsonl")),
			MODEL_CHANGE,
			assistant({ totalTokens: 30, cost: 0.03 }),
		]);

		const t = await totals(defaultSessionRoots(agentDir));
		const note = inheritedNote(t.inherited)!;
		assert.equal(t.inherited.unknownLineage, 1);
		assert.doesNotMatch(note, /inherited entr/);
		assert.match(note, /1 child transcript/);
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
		assert.equal(t.inherited.unknownLineage, 2, "both files report a broken chain");
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

test("LOCAL PATCH 2: the two JSONL readers keep their different malformed-line policies", async () => {
	// readSessionHeader and readEntryIds now share one forEachJsonLine, but they
	// disagree about a malformed line: the header reader treats one as an
	// unreadable file, the id reader skips it and keeps reading. Pin both, plus
	// the blank-line skip and the abort short-circuit, because a shared helper is
	// exactly where those two policies could silently collapse into one.
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");

		// A malformed FIRST line: the header reader cannot trust the file; the id
		// reader skips it and still collects ids from later lines.
		const tornFirst = path.join(sessions, `${stamp()}_torn-first.jsonl`);
		await mkdir(path.dirname(tornFirst), { recursive: true });
		await writeFile(tornFirst, `{not json\n${JSON.stringify(header("torn"))}\n`, "utf8");
		assert.equal(await readSessionHeader(tornFirst), null);
		assert.deepEqual(await readEntryIds(tornFirst), new Set(["torn"]));

		// A malformed LATER line: the header is the first line, so it reads fine;
		// the id reader skips the torn line and keeps the ids on both sides.
		const tornLater = path.join(sessions, `${stamp()}_torn-later.jsonl`);
		await writeFile(
			tornLater,
			`${JSON.stringify(header("later"))}\n{not json\n${JSON.stringify({ type: "message", id: "kept" })}\n`,
			"utf8",
		);
		assert.deepEqual(await readSessionHeader(tornLater), { parentSession: null });
		assert.deepEqual(await readEntryIds(tornLater), new Set(["later", "kept"]));

		// Blank lines are skipped, and a valid non-session first line is "no
		// header", not "unreadable".
		const blankThenOther = path.join(sessions, `${stamp()}_blank.jsonl`);
		await writeFile(blankThenOther, `\n\n${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");
		assert.equal(await readSessionHeader(blankThenOther), null);
		assert.deepEqual(await readEntryIds(blankThenOther), new Set(["m1"]));

		// An aborted signal stops both without a result.
		const aborted = new AbortController();
		aborted.abort();
		assert.equal(await readSessionHeader(tornLater, aborted.signal), null);
		assert.equal(await readEntryIds(tornLater, aborted.signal), null);
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
		assert.equal(t.inherited.forkedSessions, 1);
		assert.equal(t.inherited.unknownLineage, 0);
		assert.equal(t.inherited.childSessions, 3);
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
		assert.equal(t.inherited.forkedSessions, 0);
		assert.equal(t.inherited.childSessions, 0);
		assert.equal(inheritedNote(t.inherited), null, "no note when there is nothing to explain");
	});
});

test("LOCAL PATCH 3: the note reaches the screen", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const parentFile = await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			MODEL_CHANGE,
			assistant({ totalTokens: 1000, cost: 0.412 }),
		]);
		await writeSession(path.join(agentDir, "tmux-subagents", "sid", "rid", "session", "fork.jsonl"), [
			header("fork", parentFile),
			...(await inheritedPrefix(parentFile)),
			assistant({ totalTokens: 200, cost: 0.088 }),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: defaultSessionRoots(agentDir) });

		// The interactive view. Reverting the two call sites that render this line
		// left the suite green until this test existed: `inheritedNote` was pinned as
		// a function and nothing pinned that anyone calls it.
		const rendered = new BreakdownComponent(
			data,
			{ terminal: { rows: 40 }, requestRender() {} } as never,
			() => {},
		).render(160);
		assert.ok(
			rendered.some((line) => line.includes("1 child transcript") && line.includes("2 inherited entries excluded")),
			`the footer must reach the rendered view, got:\n${rendered.join("\n")}`,
		);

		// The non-interactive path, which is what a script or an agent reads.
		// `withEnv` points the agent dir at the fixture so this asserts on the
		// fixture's numbers and never on the machine's real usage.
		const sent: Array<{ content: string }> = [];
		let run: Promise<void> | undefined;
		const pi = {
			registerCommand(_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				run = spec.handler("", { hasUI: false });
			},
			sendMessage(message: { content: string }) {
				sent.push(message);
			},
		};
		const mod = await import("../../session-breakdown.ts");
		await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
			(mod.default as (pi: unknown) => void)(pi);
			await run;
		});
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.content, /Session breakdown \(non-interactive\)/);
		assert.match(sent[0]!.content, /2 inherited entries excluded/);
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

test("a session file that vanishes mid-scan costs one file, not the report", async () => {
	await withFixtureDir(async (agentDir) => {
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [header("a"), MODEL_CHANGE, assistant({ totalTokens: 10, cost: 0.01 })]);
		const victim = path.join(sessions, `${stamp()}_victim.jsonl`);
		await writeSession(victim, [header("victim"), MODEL_CHANGE, assistant({ totalTokens: 999, cost: 0.9 })]);

		// Delete it in the gap the real world has: `subagent_clean --delete-files`
		// removes run dirs under the tree being walked, and pi's `_rewriteFile`
		// truncates a file before rewriting it. Upstream's parseSessionFile had no
		// catch, so this threw ENOENT out of computeBreakdown and the interactive
		// view showed "Failed to analyze sessions" for all 90 days.
		let deleted = false;
		const data = await computeBreakdown(undefined, (update) => {
			if (!deleted && update.phase === "parse") {
				deleted = true;
				rmSync(victim, { force: true });
			}
		}, { roots: defaultSessionRoots(agentDir) });

		assert.equal(deleted, true, "the fixture must actually delete mid-scan");
		const range = data.ranges.get(30)!;
		assert.equal(range.sessions, 1, "the surviving session is still reported");
		assert.equal(range.totalTokens, 10);
	});
});

test("the footer counts only what is inside the 90 days it claims", async () => {
	await withFixtureDir(async (agentDir) => {
		// The walk's inclusion test and the aggregation's day test disagree for a
		// file with no timestamp in its NAME: the walk falls back to mtime and lets
		// it in, and the parser then dates it from the header. Give it a header from
		// long ago and a fresh mtime, and it is parsed but attributed outside every
		// window — so it must not appear in a line that says "last 90 days".
		const sessions = path.join(agentDir, "sessions", "--tmp-fixture--");
		const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
		const header200d = { ...header("old"), timestamp: old };
		await writeSession(path.join(sessions, `no-timestamp-in-the-name.jsonl`), [header200d, MODEL_CHANGE, assistant({ totalTokens: 5, cost: 0.005 })]);

		const data = await computeBreakdown(undefined, undefined, { roots: defaultSessionRoots(agentDir) });
		assert.equal(data.inherited.childSessions, 0);
		assert.equal(data.inherited.unknownLineage, 0);
		assert.equal(inheritedNote(data.inherited), null, "nothing outside the window, nothing to report");
	});
});

// --- LOCAL PATCH 3: the note --------------------------------------------------

test("LOCAL PATCH 3: the note names what was excluded and what was uncertain", () => {
	assert.equal(
		inheritedNote({ entries: 120, tokens: 5000, cost: 0.25, forkedSessions: 3, unknownLineage: 0, childSessions: 5 }),
		"last 90 days · 5 child transcripts · 3 forked sessions, 120 inherited entries excluded ($0.250, counted in the parent when it is in range)",
	);
	assert.equal(
		inheritedNote({ entries: 1, tokens: 5, cost: 0, forkedSessions: 1, unknownLineage: 1, childSessions: 1 }),
		// A zero-cost model reports $0.00 for megabytes of context, so the token
		// count is what actually says something.
		"last 90 days · 1 child transcript · 1 forked session, 1 inherited entry excluded (5 tokens, counted in the parent when it is in range) · 1 with unreadable header or parent, lineage incomplete",
	);
	assert.equal(inheritedNote({ entries: 0, tokens: 0, cost: 0, forkedSessions: 0, unknownLineage: 0, childSessions: 0 }), null);
});

test("LOCAL PATCH 4: the test surface is exported and the default export is still a factory", async () => {
	for (const name of ["BreakdownComponent", "computeBreakdown", "defaultSessionRoots", "inheritedNote", "readEntryIds", "readSessionHeader", "resolveInheritedIds"]) {
		assert.equal(typeof (__test__ as Record<string, unknown>)[name], "function", `__test__.${name} must be exported`);
	}
	const mod = await import("../../session-breakdown.ts");
	assert.equal(typeof mod.default, "function");
});

function round(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

// --- upstream 0865c84 / 2ac4480 / ab1e7f3 (vendored 2026-10-05) ---------------
//
// These three are upstream's, not ours, and arrived with no tests: the file
// ships untested upstream. They are pinned here for the same reason as the
// local patches — a regression must fail the suite, not a person's invoice.

/** An assistant line from a faux/test provider, as pi's mock provider emits. */
function fauxAssistant(u: Usage) {
	seq += 1;
	return {
		type: "message",
		id: `e${seq}`,
		parentId: "mc1",
		timestamp: new Date().toISOString(),
		message: { role: "assistant", api: "faux:abc123", provider: "faux", model: "faux-1", usage: usage(u) },
	};
}

/** An assistant line from a named provider/model (the shared helper hardcodes one). */
function assistantAs(provider: string, model: string, u: Usage, parentId = "mc1") {
	seq += 1;
	return {
		type: "message",
		id: `e${seq}`,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "assistant", provider, model, usage: usage(u) },
	};
}

/** A model_change, which declares a model without necessarily using it. */
function modelChange(provider: string, modelId: string, id = `mc${++seq}`) {
	return { type: "model_change", id, parentId: null, provider, modelId };
}

test("a model_change alone does not make a model count as used", async () => {
	// Upstream 0865c84. Sessions routinely start on a default model and switch
	// before sending anything, so the declared model must not enter the table —
	// it inflates per-model session counts and shares for a model that never ran.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_switch.jsonl`), [
			header("switch"),
			modelChange("openrouter", "never/used", "mc-never"),
			modelChange("openrouter", "actually/used", "mc-used"),
			assistantAs("openrouter", "actually/used", { totalTokens: 10, cost: 0.01 }, "mc-used"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;
		assert.deepEqual(
			[...range.modelSessions.keys()].sort(),
			["openrouter/actually/used"],
			"only the model that produced a message is a model this session used",
		);
		assert.equal(range.sessions, 1, "the session still counts once");
	});
});

test("a session where no model ever answered is skipped entirely", async () => {
	// Upstream 0865c84, the other half: "a session happened" is not the same as
	// "a model was used". Before the fix any transcript with a message counted,
	// so an abandoned session inflated both the session count and the totals.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_abandoned.jsonl`), [
			header("abandoned"),
			{ type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } },
		]);
		await writeSession(path.join(sessions, `${stamp()}_answered.jsonl`), [
			header("answered"),
			modelChange("openrouter", "real/model", "mc-real"),
			assistantAs("openrouter", "real/model", { totalTokens: 10, cost: 0.01 }, "mc-real"),
		]);

		const t = await totals([sessions]);
		assert.equal(t.sessions, 1, "only the session that reached a model is reported");
		assert.equal(t.messages, 1);
	});

	// The one exception, and it is ours: a fork that inherited every entry it
	// has has answered nothing itself, yet the user really did start it.
	// LOCAL PATCH 2 keeps those, and this is the seam where upstream's tightened
	// rule and our exception meet — so it is asserted from both sides.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		const parent = await writeSession(path.join(sessions, `${stamp()}_parent.jsonl`), [
			header("parent"),
			modelChange("openrouter", "real/model", "mc-real"),
			assistantAs("openrouter", "real/model", { totalTokens: 10, cost: 0.01 }, "mc-real"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_fork.jsonl`), [
			header("fork", parent),
			...(await inheritedPrefix(parent)),
		]);

		const t = await totals([sessions]);
		assert.equal(t.sessions, 2, "the abandoned fork is still a session the user started");
		assert.equal(t.tokens, 10, "and none of its inherited context is billed to it again");
	});
});

test("a session that only ever spoke to a faux provider is not a session", async () => {
	// Upstream 2ac4480. pi's mock/test provider reports synthetic token
	// estimates; counting them would put invented usage in a real bill summary.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_fauxonly.jsonl`), [
			header("fauxonly"),
			modelChange("faux", "faux-1"),
			fauxAssistant({ totalTokens: 999_999, cost: 42 }),
		]);
		await writeSession(path.join(sessions, `${stamp()}_real.jsonl`), [
			header("real"),
			modelChange("openrouter", "real/model", "mc-real"),
			assistantAs("openrouter", "real/model", { totalTokens: 10, cost: 0.01 }, "mc-real"),
		]);

		const t = await totals([sessions]);
		assert.equal(t.sessions, 1, "the faux-only session is dropped entirely");
		assert.equal(t.tokens, 10, "its synthetic estimate contributes nothing");
		assert.equal(t.cost, 0.01);
	});
});

test("faux usage inside a real session is skipped, and does not blank the model", async () => {
	// The mixed case the two fixes above have to agree on: skipping faux entries
	// must not fall back to the previous model and bill them to it.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_mixed.jsonl`), [
			header("mixed"),
			modelChange("openrouter", "real/model", "mc-real"),
			assistantAs("openrouter", "real/model", { totalTokens: 10, cost: 0.01 }, "mc-real"),
			fauxAssistant({ totalTokens: 500_000, cost: 7 }),
			assistantAs("openrouter", "real/model", { totalTokens: 5, cost: 0.02 }, "mc-real"),
		]);

		const t = await totals([sessions]);
		assert.equal(t.tokens, 15, "the faux estimate is dropped, the two real turns kept");
		assert.equal(round(t.cost), 0.03);
	});
});

test("cost/session column and provider grouping come from the aggregation", async () => {
	// Upstream ab1e7f3. The model table grew a cost/session column and a
	// provider-grouped view; both read the per-model maps this adds, and the
	// grouped maps are keyed by model name alone, so two providers running the
	// same model share one row.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [
			header("a"),
			modelChange("openrouter", "vendor/foo", "mc-openrouter"),
			assistantAs("openrouter", "vendor/foo", { totalTokens: 100, cost: 0.1 }, "mc-openrouter"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_b.jsonl`), [
			header("b"),
			modelChange("anthropic", "vendor/foo", "mc-anthropic"),
			assistantAs("anthropic", "vendor/foo", { totalTokens: 300, cost: 0.3 }, "mc-anthropic"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;

		// Split: one row per provider-qualified model.
		assert.equal(range.modelSessions.get("openrouter/vendor/foo"), 1);
		assert.equal(range.modelSessions.get("anthropic/vendor/foo"), 1);

		// Grouped: one row for `vendor/foo`, across both providers.
		assert.equal(range.groupedModelSessions.get("vendor/foo"), 2, "the grouped map is provider-agnostic");
		assert.equal(range.groupedModelCost.get("vendor/foo"), round(0.4), "cost rolls up the same way");

		// And the column the table actually renders: cost/session for the group.
		const rendered = new BreakdownComponent(
			data,
			{ terminal: { rows: 40 }, requestRender() {} } as never,
			() => {},
		).render(160);
		assert.ok(rendered.length > 0);
		assert.match(rendered.join("\n"), /vendor\/foo/, "the grouped model reaches the rendered table");
	});
});

// --- the metric tables and palettes (dedup, 2026-10-08) ----------------------
//
// The four tables used to be four near-identical renderers and the two palettes
// two near-identical choosers. They now share `renderMetricTable`/`choosePalette`,
// and these assertions are the pre-refactor output, written out by hand so the
// collapse is provably byte-identical. The headers were not asserted anywhere
// before, which is exactly the gap that let the column widths drift unnoticed.

test("the model and directory tables keep their exact layout", async () => {
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [
			header("a"),
			modelChange("openrouter", "vendor/foo", "a-mc"),
			assistantAs("openrouter", "vendor/foo", { totalTokens: 100, cost: 0.1 }, "a-mc"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_b.jsonl`), [
			{ ...header("b"), cwd: "/home/user/work/alpha-project" },
			modelChange("anthropic", "vendor/bar", "b-mc"),
			assistantAs("anthropic", "vendor/bar", { totalTokens: 300, cost: 0.3 }, "b-mc"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;

		// Tokens mode: value width 10, label width from the longest model key.
		assert.deepEqual(renderModelTable(range, "tokens"), [
			"model                      tokens        cost    cost/s   share",
			"---------------------  ----------  ----------  --------  ------",
			"anthropic/vendor/bar          300      $0.300    $0.300     75%",
			"openrouter/vendor/foo         100      $0.100    $0.100     25%",
		]);
		// Sessions mode: value width 8, and a tie at 1 session keeps insertion order.
		assert.deepEqual(renderModelTable(range, "sessions"), [
			"model                  sessions        cost    cost/s   share",
			"---------------------  --------  ----------  --------  ------",
			"openrouter/vendor/foo         1      $0.100    $0.100     50%",
			"anthropic/vendor/bar          1      $0.300    $0.300     50%",
		]);
		// The directory label is the abbreviated path, and the width follows it.
		assert.deepEqual(renderCwdTable(range, "tokens"), [
			"directory                          tokens        cost    cost/s   share",
			"-----------------------------  ----------  ----------  --------  ------",
			"/home/user/work/alpha-project         300      $0.300    $0.300     75%",
			"/tmp/fixture                          100      $0.100    $0.100     25%",
		]);
		assert.deepEqual(renderCwdTable(range, "sessions"), [
			"directory                      sessions        cost    cost/s   share",
			"-----------------------------  --------  ----------  --------  ------",
			"/tmp/fixture                          1      $0.100    $0.100     50%",
			"/home/user/work/alpha-project         1      $0.300    $0.300     50%",
		]);
	});
});

test("an empty range keeps the no-data line and the dow/tod fixed order", async () => {
	await withFixtureDir(async (dir) => {
		const empty = await computeBreakdown(undefined, undefined, { roots: [path.join(dir, "sessions")] });
		const range = empty.ranges.get(30)!;
		const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;

		assert.deepEqual(renderModelTable(range, "sessions"), [
			"model  sessions        cost    cost/s   share",
			"-----  --------  ----------  --------  ------",
			dim("(no model data found)"),
		]);
		assert.deepEqual(renderCwdTable(range, "sessions"), [
			"directory  sessions        cost    cost/s   share",
			"---------  --------  ----------  --------  ------",
			dim("(no directory data found)"),
		]);
		// dow and tod are never sorted and never empty: every key gets a row.
		assert.deepEqual(renderDowTable(range, "sessions"), [
			"day    sessions        cost    cost/s   share",
			"-----  --------  ----------  --------  ------",
			"Mon           0     $0.0000         -      0%",
			"Tue           0     $0.0000         -      0%",
			"Wed           0     $0.0000         -      0%",
			"Thu           0     $0.0000         -      0%",
			"Fri           0     $0.0000         -      0%",
			"Sat           0     $0.0000         -      0%",
			"Sun           0     $0.0000         -      0%",
		]);
		assert.deepEqual(renderTodTable(range, "sessions"), [
			"time of day             sessions        cost    cost/s   share",
			"----------------------  --------  ----------  --------  ------",
			"After midnight (0–5)           0     $0.0000         -      0%",
			"Morning (6–11)                 0     $0.0000         -      0%",
			"Afternoon (12–16)              0     $0.0000         -      0%",
			"Evening (17–21)                0     $0.0000         -      0%",
			"Night (22–23)                  0     $0.0000         -      0%",
		]);
	});
});

test("the model and directory palettes pick the same top keys and colours", async () => {
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [
			header("a"),
			modelChange("openrouter", "vendor/foo", "a-mc"),
			assistantAs("openrouter", "vendor/foo", { totalTokens: 100, cost: 0.1 }, "a-mc"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_b.jsonl`), [
			{ ...header("b"), cwd: "/home/user/work/alpha-project" },
			modelChange("anthropic", "vendor/bar", "b-mc"),
			assistantAs("anthropic", "vendor/bar", { totalTokens: 300, cost: 0.3 }, "b-mc"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;
		const model = choosePaletteFromLast30Days(range);
		const cwd = chooseCwdPaletteFromLast30Days(range);
		const other = { r: 160, g: 160, b: 160 };

		assert.deepEqual(model.orderedModels, ["anthropic/vendor/bar", "openrouter/vendor/foo"]);
		assert.deepEqual([...model.modelColors.entries()], [
			["anthropic/vendor/bar", { r: 64, g: 196, b: 99 }],
			["openrouter/vendor/foo", { r: 47, g: 129, b: 247 }],
		]);
		assert.deepEqual(model.otherColor, other);

		assert.deepEqual(cwd.orderedCwds, ["/home/user/work/alpha-project", "/tmp/fixture"]);
		assert.deepEqual([...cwd.cwdColors.entries()], [
			["/home/user/work/alpha-project", { r: 64, g: 196, b: 99 }],
			["/tmp/fixture", { r: 47, g: 129, b: 247 }],
		]);
		assert.deepEqual(cwd.otherColor, other);
	});
});


test("long directory labels, maxRows and the palette fallback keep their shape", async () => {
	// Closes the gaps the 2026-10-08 review found: no fixture label exceeded the
	// width cap, no fixture path was shortened by abbreviatePath, nothing passed
	// maxRows, and every palette fixture had cost > 0 — so the truncation, the
	// empty-slice case and the tokens tier of the fallback were all unpinned.
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [
			{ ...header("a"), cwd: "/home/user/work/alpha-project-with-a-very-long-name" },
			modelChange("openrouter", "vendor/foo", "a-mc"),
			assistantAs("openrouter", "vendor/foo", { totalTokens: 100, cost: 0 }, "a-mc"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_b.jsonl`), [
			{ ...header("b"), cwd: "/tmp/b" },
			modelChange("anthropic", "vendor/bar", "b-mc"),
			assistantAs("anthropic", "vendor/bar", { totalTokens: 300, cost: 0 }, "b-mc"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;

		// The path is abbreviated to `home/…/…`, and the column is exactly 42 wide.
		assert.deepEqual(renderCwdTable(range, "tokens"), [
			"directory                                       tokens        cost    cost/s   share",
			"------------------------------------------  ----------  ----------  --------  ------",
			"/tmp/b                                             300     $0.0000   $0.0000     75%",
			"home/…/alpha-project-with-a-very-long-name         100     $0.0000   $0.0000     25%",
		]);

		// maxRows bounds the body. Widths come from the ROWS, so a zero-row table
		// falls back to the header's own width, exactly as before the dedup.
		assert.deepEqual(renderModelTable(range, "tokens", 1), [
			"model                     tokens        cost    cost/s   share",
			"--------------------  ----------  ----------  --------  ------",
			"anthropic/vendor/bar         300     $0.0000   $0.0000     75%",
		]);
		// A range WITH data asked for zero rows must NOT print the no-data line:
		// the condition is the full map's emptiness, not the sliced rows'.
		assert.deepEqual(renderModelTable(range, "tokens", 0), [
			"model      tokens        cost    cost/s   share",
			"-----  ----------  ----------  --------  ------",
		]);

		// cost is 0 everywhere, so the fallback must rank by tokens, not cost.
		assert.deepEqual(choosePaletteFromLast30Days(range).orderedModels, ["anthropic/vendor/bar", "openrouter/vendor/foo"]);
	});
});

test("the palette fallback ranks by messages when nothing cost or used tokens", async () => {
	await withFixtureDir(async (dir) => {
		const sessions = path.join(dir, "sessions");
		await writeSession(path.join(sessions, `${stamp()}_a.jsonl`), [
			header("a"),
			modelChange("openrouter", "vendor/foo", "a-mc"),
			assistantAs("openrouter", "vendor/foo", { totalTokens: 0, cost: 0 }, "a-mc"),
		]);
		await writeSession(path.join(sessions, `${stamp()}_b.jsonl`), [
			header("b"),
			modelChange("anthropic", "vendor/bar", "b-mc"),
			assistantAs("anthropic", "vendor/bar", { totalTokens: 0, cost: 0 }, "b-mc"),
			assistantAs("anthropic", "vendor/bar", { totalTokens: 0, cost: 0 }, "b-mc"),
		]);

		const data = await computeBreakdown(undefined, undefined, { roots: [sessions] });
		const range = data.ranges.get(30)!;
		assert.equal(range.totalTokens, 0);
		assert.ok(range.totalMessages > 0, "the messages tier is reachable");
		// Two messages for `bar`, one for `foo`.
		assert.deepEqual(choosePaletteFromLast30Days(range).orderedModels, ["anthropic/vendor/bar", "openrouter/vendor/foo"]);
	});
});
