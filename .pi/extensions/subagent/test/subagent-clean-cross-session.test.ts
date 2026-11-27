// Cross-session live-transcript safety and foreign runs.json pruning for
// `subagent_clean({ all_sessions: true, delete_files: true })`.
//
// Risk covered: previously `runDirOwnsLiveTranscript` only inspected the current
// session's in-memory `runs` map, so cleaning across sessions could delete a
// run directory whose transcript was still open in another session's live run.
// Additionally, deleting foreign runs left stale entries in foreign sessions'
// `runs.json` files (and re-parsing the current session's `runs.json` skipped
// `runs.delete(run.id)` due to object identity).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";
import { waitFor } from "./helpers.ts";
import { withHarness } from "./lifecycle-harness.ts";

function makeRecord(overrides: Partial<RunRecord> & { id: string; runDir: string }): RunRecord {
	return {
		task: "cross-session task",
		cwd: "/tmp",
		provider: "openrouter",
		model: "openrouter/test",
		thinking: "medium",
		tmuxSession: `pi-agent-${overrides.id.slice(0, 8)}`,
		tmuxTarget: `pi-agent-${overrides.id.slice(0, 8)}:0.0`,
		attachCommand: "pi --attach-subagent test",
		captureCommand: "tmux capture-pane -p",
		resultPath: path.join(overrides.runDir, "result.json"),
		trusted: true,
		status: "completed",
		createdAt: Date.now() - 10_000,
		...overrides,
	};
}

test("runDirOwnsLiveTranscript checks any Iterable<RunRecord> across sessions", () => {
	const ancestor = makeRecord({
		id: "foreign-ancestor",
		runDir: "/tmp/runs/session-a/foreign-ancestor",
		status: "completed",
	});
	const liveForeign = makeRecord({
		id: "foreign-live",
		runDir: "/tmp/runs/session-b/foreign-live",
		status: "running",
		sessionFile: "/tmp/runs/session-a/foreign-ancestor/session/fork.jsonl",
	});

	assert.equal(__test__.runDirOwnsLiveTranscript(ancestor, [ancestor, liveForeign]), true);

	liveForeign.status = "completed";
	assert.equal(__test__.runDirOwnsLiveTranscript(ancestor, [ancestor, liveForeign]), false);
});

test("subagent_clean all_sessions retains foreign live transcripts and prunes removed foreign runs.json", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (h, agentDir) => {
		const runsRoot = path.join(agentDir, "tmux-subagents");
		const foreignSessionA = "11111111-1111-4111-8111-111111111111";
		const foreignSessionB = "22222222-2222-4222-8222-222222222222";
		const foreignDirA = path.join(runsRoot, foreignSessionA);
		const foreignDirB = path.join(runsRoot, foreignSessionB);

		// Foreign session A has:
		// 1) a completed ancestor whose transcript is still used by a live run in foreign session B
		// 2) an unrelated completed run that should be deleted and pruned from A's runs.json
		const ancestorRunDir = path.join(foreignDirA, "ancestor-a");
		const ancestorTranscript = path.join(ancestorRunDir, "session", "fork.jsonl");
		const staleRunDirA = path.join(foreignDirA, "stale-a");
		const staleTranscriptA = path.join(staleRunDirA, "session", "standalone.jsonl");

		await mkdir(path.dirname(ancestorTranscript), { recursive: true });
		await writeFile(ancestorTranscript, '{"type":"session"}\n', "utf8");
		await mkdir(path.dirname(staleTranscriptA), { recursive: true });
		await writeFile(staleTranscriptA, '{"type":"session"}\n', "utf8");

		const foreignAncestor = makeRecord({
			id: "ancestor-a",
			runDir: ancestorRunDir,
			status: "completed",
			finishedAt: Date.now() - 10_000,
			sessionFile: ancestorTranscript,
		});
		const foreignStaleA = makeRecord({
			id: "stale-a",
			runDir: staleRunDirA,
			status: "completed",
			finishedAt: Date.now() - 10_000,
			sessionFile: staleTranscriptA,
		});
		const foreignIndexA = path.join(foreignDirA, "runs.json");
		await writeFile(foreignIndexA, JSON.stringify([foreignAncestor, foreignStaleA], null, 2), "utf8");

		// Foreign session B has:
		// 1) an interrupted run holding foreignAncestor's transcript open
		// 2) a completed run that should be deleted and pruned (leaving [foreignLiveB])
		const liveRunDirB = path.join(foreignDirB, "live-b");
		const staleRunDirB = path.join(foreignDirB, "stale-b");
		await mkdir(liveRunDirB, { recursive: true });
		await mkdir(staleRunDirB, { recursive: true });

		const foreignLiveB = makeRecord({
			id: "live-b",
			runDir: liveRunDirB,
			status: "interrupted",
			sessionFile: ancestorTranscript,
		});
		const foreignStaleB = makeRecord({
			id: "stale-b",
			runDir: staleRunDirB,
			status: "failed",
			finishedAt: Date.now() - 10_000,
		});
		const foreignIndexB = path.join(foreignDirB, "runs.json");
		await writeFile(foreignIndexB, JSON.stringify([foreignLiveB, foreignStaleB], null, 2), "utf8");

		// Current session also has one completed run and one running run; the completed one must be pruned too.
		const localDone = (await h.call("subagent", { task: "local done" })).details as unknown as RunRecord;
		const localLive = (await h.call("subagent", { task: "local live" })).details as unknown as RunRecord;
		await h.writeResult(localDone, { version: 1, status: "completed", output: "done", finishedAt: Date.now() - 10_000 });
		await waitFor(async () => (await h.readRuns()).find((r) => r.id === localDone.id)?.status === "completed");

		const cleaned = await h.call("subagent_clean", { all_sessions: true, delete_files: true });
		assert.match(cleaned.text, /deleted 3 run dir\(s\)/, cleaned.text);
		assert.match(cleaned.text, /still hold the session file of a live run: ancestor-a/, cleaned.text);

		// Retained ancestor and its transcript survive on disk; stale dirs are deleted.
		assert.ok(existsSync(ancestorRunDir), "foreign ancestor runDir must be retained");
		assert.ok(existsSync(ancestorTranscript), "foreign ancestor transcript must survive");
		assert.ok(existsSync(liveRunDirB), "live foreign runDir must survive");
		assert.equal(existsSync(staleRunDirA), false, "stale foreign A runDir must be deleted");
		assert.equal(existsSync(staleRunDirB), false, "stale foreign B runDir must be deleted");
		assert.equal(existsSync(localDone.runDir), false, "local finished runDir must be deleted");

		// Foreign runs.json files must be pruned cleanly, keeping retained/live records.
		const persistedA = JSON.parse(await readFile(foreignIndexA, "utf8")) as RunRecord[];
		assert.deepEqual(
			persistedA.map((r) => r.id),
			["ancestor-a"],
		);
		const persistedB = JSON.parse(await readFile(foreignIndexB, "utf8")) as RunRecord[];
		assert.deepEqual(
			persistedB.map((r) => r.id),
			["live-b"],
		);

		// Current session's in-memory and persisted runs must also have pruned localDone and kept localLive.
		const localPersisted = await h.readRuns();
		assert.deepEqual(
			localPersisted.map((r) => r.id),
			[localLive.id],
		);
	});
});

test("subagent_clean all_sessions protects current session ancestor used by foreign live run and empties pruned foreign runs.json", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (h, agentDir) => {
		const runsRoot = path.join(agentDir, "tmux-subagents");
		const foreignSessionC = "33333333-3333-4333-8333-333333333333";
		const foreignSessionD = "44444444-4444-4444-8444-444444444444";
		const foreignDirC = path.join(runsRoot, foreignSessionC);
		const foreignDirD = path.join(runsRoot, foreignSessionD);

		// Current session completed forked run.
		const localAncestor = (await h.call("subagent", { task: "local ancestor", handoff: "fork" }))
			.details as unknown as RunRecord;
		await h.writeResult(localAncestor, {
			version: 1,
			status: "completed",
			output: "ok",
			finishedAt: Date.now() - 10_000,
			sessionFile: localAncestor.sessionFile,
		});
		await waitFor(async () => (await h.readRuns()).find((r) => r.id === localAncestor.id)?.status === "completed");

		// Foreign session C has a running run whose transcript is inside localAncestor.runDir.
		const foreignLiveC = makeRecord({
			id: "foreign-live-c",
			runDir: path.join(foreignDirC, "foreign-live-c"),
			status: "running",
			sessionFile: localAncestor.sessionFile,
		});
		await mkdir(foreignLiveC.runDir, { recursive: true });
		const foreignIndexC = path.join(foreignDirC, "runs.json");
		await writeFile(foreignIndexC, JSON.stringify([foreignLiveC], null, 2), "utf8");

		// Foreign session D has only one completed run; cleaning it leaves runs.json as [].
		const foreignDoneD = makeRecord({
			id: "foreign-done-d",
			runDir: path.join(foreignDirD, "foreign-done-d"),
			status: "completed",
			finishedAt: Date.now() - 10_000,
		});
		await mkdir(foreignDoneD.runDir, { recursive: true });
		const foreignIndexD = path.join(foreignDirD, "runs.json");
		await writeFile(foreignIndexD, JSON.stringify([foreignDoneD], null, 2), "utf8");

		const cleaned = await h.call("subagent_clean", { all_sessions: true, delete_files: true });
		assert.match(cleaned.text, /deleted 1 run dir\(s\)/, cleaned.text);
		assert.match(cleaned.text, new RegExp(`still hold the session file of a live run: ${localAncestor.id}`), cleaned.text);

		assert.ok(existsSync(localAncestor.runDir), "local ancestor runDir must survive when foreign run holds its transcript");
		assert.ok(existsSync(localAncestor.sessionFile as string));
		assert.equal(existsSync(foreignDoneD.runDir), false, "foreign D finished runDir must be deleted");

		// Foreign C was untouched; foreign D's runs.json was pruned to [].
		const persistedC = JSON.parse(await readFile(foreignIndexC, "utf8")) as RunRecord[];
		assert.deepEqual(
			persistedC.map((r) => r.id),
			["foreign-live-c"],
		);
		const persistedD = JSON.parse(await readFile(foreignIndexD, "utf8")) as RunRecord[];
		assert.deepEqual(persistedD, []);

		// Local ancestor stays in current session runs.
		assert.deepEqual(
			(await h.readRuns()).map((r) => r.id),
			[localAncestor.id],
		);
	});
});

test("subagent_clean all_sessions preserves foreign runs appended concurrently while cleanup is in flight", async () => {
	await withHarness({ sessionManager: "liveBranch" }, async (h, agentDir) => {
		const runsRoot = path.join(agentDir, "tmux-subagents");
		const foreignSession = "55555555-5555-4555-8555-555555555555";
		const foreignDir = path.join(runsRoot, foreignSession);
		const staleRunDir = path.join(foreignDir, "stale-e");
		const concurrentRunDir = path.join(foreignDir, "concurrent-e");
		await mkdir(staleRunDir, { recursive: true });
		await mkdir(concurrentRunDir, { recursive: true });

		const staleRun = makeRecord({
			id: "stale-e",
			runDir: staleRunDir,
			status: "completed",
			finishedAt: Date.now() - 10_000,
		});
		const concurrentRun = makeRecord({
			id: "concurrent-e",
			runDir: concurrentRunDir,
			status: "running",
			createdAt: Date.now(),
		});
		const foreignIndex = path.join(foreignDir, "runs.json");
		await writeFile(foreignIndex, JSON.stringify([staleRun], null, 2), "utf8");

		const originalExec = h.pi.exec as (
			command: string,
			args: string[],
			options?: Record<string, unknown>,
		) => Promise<unknown>;
		let injected = false;
		h.pi.exec = async (command: string, args: string[], options?: Record<string, unknown>) => {
			if (!injected && args.includes("kill-session") && args.includes(staleRun.tmuxSession)) {
				injected = true;
				await writeFile(foreignIndex, JSON.stringify([staleRun, concurrentRun], null, 2), "utf8");
			}
			return originalExec(command, args, options);
		};

		const cleaned = await h.call("subagent_clean", { all_sessions: true, delete_files: true });
		assert.equal(injected, true, "test must inject concurrent foreign run during killTmuxSession");
		assert.match(cleaned.text, /deleted 1 run dir\(s\)/, cleaned.text);
		assert.equal(existsSync(staleRunDir), false, "stale foreign runDir must be deleted");
		assert.ok(existsSync(concurrentRunDir), "concurrently launched foreign runDir must survive");

		const persisted = JSON.parse(await readFile(foreignIndex, "utf8")) as RunRecord[];
		assert.deepEqual(
			persisted.map((r) => r.id),
			["concurrent-e"],
		);
	});
});
