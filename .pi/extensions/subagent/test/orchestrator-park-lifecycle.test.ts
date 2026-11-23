// Cross-factory lifecycle: the real subagent publisher drives the real
// orchestrator subscriber over one in-process bus.
//
// The factory tests in orchestrator-gate.test.ts hand-emit the run lifecycle
// events; this file proves the ordering the design depends on, with the two
// extensions loaded into one fake host. It is the test that would have caught a
// subscription registered too late, a payload with the wrong run id, or a
// terminal status that never reaches the parked parent.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { gateConfigPath } from "../../orchestrator/config.ts";
import { GATE_ENTRY_TYPE, type GateVerdict } from "../../orchestrator/gate.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import type { RunRecord } from "../index.ts";
import { withHarness } from "./lifecycle-harness.ts";

async function withParkingProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(path.join(tmpdir(), "orchestrator-park-lifecycle-"));
	try {
		await mkdir(path.join(cwd, ".pi", "todos"), { recursive: true });
		await writeFile(
			gateConfigPath(cwd),
			JSON.stringify({ version: 1, block: { openTodos: true, waitForSubagents: true } }),
		);
		await writeFile(
			path.join(cwd, ".pi", "todos", "aaaaaaaa.md"),
			`${JSON.stringify({ id: "aaaaaaaa", title: "finish", status: "open" })}\n`,
		);
		return await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function verdictOf(result: unknown): GateVerdict {
	const proposal = (result ?? {}) as { entries?: unknown[] };
	const entry = (proposal.entries ?? []).find(
		(candidate) => (candidate as { customType?: string }).customType === GATE_ENTRY_TYPE,
	) as { data?: GateVerdict } | undefined;
	assert.ok(entry?.data, "the settlement must record a gate verdict");
	return entry.data;
}

test("a real subagent run parks the orchestrator, and cancelling it wakes the parent", async () => {
	await withParkingProject(async (cwd) => {
		await withHarness({ cwd, maxConcurrent: "4" }, async (h) => {
			// The subagent factory is already loaded and its own session_start has run.
			// Loading the orchestrator now registers its subscriptions; the second
			// session_start lets it reconstruct from the branch the same way a real
			// host would on startup.
			orchestratorExtension(h.pi as never);
			await h.fire("session_start", {});

			const { details } = await h.call("subagent", { task: "work" });
			const run = details as unknown as RunRecord;

			const parked = verdictOf(
				await h.fire("agent_before_settle", {
					entries: [],
					continue: false,
					outcome: "completed",
					context: {},
				}),
			);
			assert.equal(parked.scope, "parent");
			assert.equal(parked.parked, true, "a live run the subagent actually started must park the gate");
			assert.deepEqual(parked.liveRuns, [run.id]);
			assert.equal(parked.attempts, 0);
			assert.equal(h.messages.length, 0, "parking sends nothing");

			await h.call("subagent_cancel", { id: run.id });
			const wake = h.messages.find((message) => message.message.customType === "orchestrator-resume");
			assert.ok(wake, "the cancel must publish a terminal event that wakes the parked parent");
			assert.equal(wake.options?.triggerTurn, true);
			assert.match(String(wake.message.content), new RegExp(run.id));
		});
	});
});
