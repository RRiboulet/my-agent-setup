// Tests for turn-level interrupt (local patch 13): the marker file, the child
// branch that writes it, and the parent branch that acts on it.
//
// Risk covered: the feature straddles a process boundary and hinges on two
// predicates that mean opposite things for the same status -- `interrupted` is
// terminal for waiting and alive for anything that would destroy the child.
// Getting either one wrong silently strands a run (the child keeps running
// forever) or throws it away (the transcript is unlinked under a live process).

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { __test__ } from "../index.ts";
import { readActivityFile, getActivityFilePath } from "../activity.ts";
import {
	createInterruptMarkerWriter,
	getInterruptFilePath,
	readInterruptMarker,
	validateInterruptMarker,
	type SubagentInterruptMarker,
} from "../interrupt.ts";
import { withEnv, withTempAgentDir } from "./helpers.ts";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

function marker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		runId: RUN_ID,
		interruptedAt: 1_700_000_000_000,
		interrupts: 1,
		turnIndex: 3,
		stopReason: "aborted",
		...overrides,
	};
}

// --- the marker module ---

test("the marker path sits next to result.json in the run dir", () => {
	assert.equal(getInterruptFilePath("/tmp/run"), path.join("/tmp/run", "interrupt.json"));
});

test("a marker from another run is never attributed to this one", () => {
	// The same reason activity.json checks its child id: a resumed attempt gets
	// a fresh run dir, but a marker left in an ancestor's dir must not be read as
	// this run's.
	assert.deepEqual(validateInterruptMarker(marker(), "someone-else"), { ok: false, reason: "wrong-id" });
});

test("a malformed marker is reported, not thrown", () => {
	for (const value of [
		null,
		[],
		"aborted",
		marker({ version: 2 }),
		marker({ runId: "" }),
		marker({ interruptedAt: "soon" }),
		marker({ interrupts: 0 }),
		marker({ interrupts: 1.5 }),
		marker({ turnIndex: "third" }),
		marker({ stopReason: "aborted\nrm -rf /" }),
	]) {
		const result = validateInterruptMarker(value, RUN_ID);
		assert.equal(result.ok, false, `${JSON.stringify(value)} must be rejected`);
	}
	assert.equal(validateInterruptMarker(marker(), RUN_ID).ok, true);
	assert.equal(validateInterruptMarker(marker({ turnIndex: undefined, stopReason: undefined }), RUN_ID).ok, true);
});

test("readInterruptMarker distinguishes a missing file from a broken one", async () => {
	await withTempAgentDir(async (agentDir) => {
		const filePath = path.join(agentDir, "interrupt.json");
		assert.deepEqual(await readInterruptMarker(filePath, RUN_ID), { ok: false, reason: "missing" });
		await writeFile(filePath, "{not json", "utf8");
		const broken = await readInterruptMarker(filePath, RUN_ID);
		assert.equal(broken.ok, false);
		assert.equal(broken.ok === false && broken.reason, "invalid");
		await writeFile(filePath, JSON.stringify(marker()), "utf8");
		const good = await readInterruptMarker(filePath, RUN_ID);
		assert.equal(good.ok && good.marker.interrupts, 1);
	});
});

test("a marker confirms only when it is newer than the escape baseline", () => {
	// The predicate the confirmation poll now trusts. A marker from the PREVIOUS
	// interrupt is not newer: the marker file is never deleted, so it is read back
	// on every poll and must not confirm a request that just went out.
	const at = (interrupts: number, interruptedAt: number): SubagentInterruptMarker => ({
		version: 1,
		runId: RUN_ID,
		interrupts,
		interruptedAt,
	});
	const baseline = { interrupts: 1, at: 100 };
	assert.equal(__test__.markerIsNewerThan(at(2, 300), baseline), true, "a higher count is newer");
	assert.equal(__test__.markerIsNewerThan(at(1, 200), baseline), true, "a later clock alone is newer");
	assert.equal(__test__.markerIsNewerThan(at(1, 100), baseline), false, "the same marker is not newer");
	assert.equal(__test__.markerIsNewerThan(at(0, 100), baseline), false, "an older count is not newer");
});

test("the writer counts interrupts and survives a failing write", async () => {
	await withTempAgentDir(async (agentDir) => {
		const filePath = path.join(agentDir, "interrupt.json");
		const written: string[] = [];
		const writer = createInterruptMarkerWriter({
			filePath,
			runId: RUN_ID,
			now: () => 1_700_000_000_000,
			write: async (target, value) => {
				written.push(path.basename(target));
				await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
			},
		});

		await writer.mark({ turnIndex: 1, stopReason: "aborted" });
		await writer.mark({ turnIndex: 4 });
		assert.equal(writer.count(), 2);
		const second = await readInterruptMarker(filePath, RUN_ID);
		assert.equal(second.ok && second.marker.interrupts, 2, "the count is per child, so two interrupts are not collapsed");

		// A failing path disables the writer instead of retrying forever; the run
		// then simply stays "running", which is what a lost Escape would give too.
		let attempts = 0;
		const errors: unknown[] = [];
		const failing = createInterruptMarkerWriter({
			filePath: path.join(agentDir, "nope", "interrupt.json"),
			runId: RUN_ID,
			maxWriteFailures: 3,
			write: async () => {
				attempts += 1;
				throw new Error("read-only file system");
			},
			onError: (error) => errors.push(error),
		});
		await failing.mark();
		await failing.mark();
		await failing.mark();
		await failing.mark();
		assert.equal(attempts, 3, "writes stop after the failure budget");
		assert.equal(errors.length, 3);
		assert.equal(
			failing.count(),
			3,
			"the count stops too: no marker reaches disk, so claiming a fourth would tell the parent more than it can know",
		);
		assert.deepEqual(written, ["interrupt.json", "interrupt.json"]);
	});
});

// --- the child branch ---

interface ChildHarness {
	/** Fire an extension event against a context presenting an assistant message with `stopReason`. */
	fire: (event: string, payload?: Record<string, unknown>, stopReason?: string) => Promise<void>;
	shutdownCalls: number[];
	resultPath: string;
	interruptPath: string;
}

/**
 * Drive the real child branch (`PI_TMUX_SUBAGENT_CHILD`) with a fake
 * ExtensionAPI, so the reporter's abort path is exercised without a child pi.
 */
async function withChildReporter(
	vars: Record<string, string | undefined>,
	fn: (child: ChildHarness) => Promise<void>,
): Promise<void> {
	await withTempAgentDir(async (agentDir) => {
		const runDir = path.join(agentDir, "tmux-subagents", "session", RUN_ID);
		await mkdir(runDir, { recursive: true });
		const resultPath = path.join(runDir, "result.json");
		const interruptPath = getInterruptFilePath(runDir);

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
				getSessionFile: () => path.join(runDir, "session", "standalone.jsonl"),
				getBranch: () =>
					stopReason === undefined
						? []
						: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "the answer" }], stopReason } }],
			},
			model: { provider: "openrouter", id: "child/model" },
			shutdown: () => shutdownCalls.push(1),
		});

		await withEnv(
			{
				PI_TMUX_SUBAGENT_CHILD: "1",
				PI_TMUX_SUBAGENT_RESULT: resultPath,
				PI_TMUX_SUBAGENT_INTERRUPT: interruptPath,
				...vars,
			},
			async () => {
				subagentExtension(pi as never);
			},
		);

		await fn({
			fire: async (event, payload = {}, stopReason) => {
				await handlers.get(event)?.(payload, makeCtx(stopReason));
			},
			shutdownCalls,
			resultPath,
			interruptPath,
		});
	});
}

test("an aborted turn leaves the child alive with a marker and no result", async () => {
	await withChildReporter({}, async (child) => {
		await child.fire("session_start");
		await child.fire("tool_execution_start", { toolName: "bash" });
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 3, outcome: "aborted", message: { role: "assistant", stopReason: "aborted" } },
			"aborted",
		);
		await child.fire("agent_settled", {}, "aborted");

		const written = await readInterruptMarker(child.interruptPath, RUN_ID);
		assert.equal(written.ok, true, "the interrupt marker must be written");
		assert.equal(written.ok === true && written.marker.interrupts, 1);
		assert.equal(written.ok === true && written.marker.turnIndex, 3);
		assert.equal(written.ok === true && written.marker.stopReason, "aborted");
		assert.equal(existsSync(child.resultPath), false, "an interrupted turn is not a result");
		assert.equal(child.shutdownCalls.length, 0, "the child stays alive at its prompt");

		// The snapshot says "waiting", not "done": the child is idle, not
		// finished, and subagent_status renders that phase for a live run.
		const snapshot = await readActivityFile(getActivityFilePath(path.dirname(child.interruptPath)), RUN_ID);
		assert.equal(snapshot.ok === true && snapshot.activity.phase, "waiting");
	});
});

test("an interrupted child that is driven again finishes normally", async () => {
	// This is what makes an interrupted run resumable rather than wedged: the
	// reporter's one-shot `reported` latch is not consumed by the abort, so the
	// next settle reports and exits as usual.
	await withChildReporter({}, async (child) => {
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, outcome: "aborted", message: { role: "assistant", stopReason: "aborted" } },
			"aborted",
		);
		await child.fire("agent_settled", {}, "aborted");
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 1, outcome: "completed", message: { role: "assistant", stopReason: "stop" } },
			"stop",
		);
		await child.fire("agent_settled", {}, "stop");

		const result = JSON.parse(await readFile(child.resultPath, "utf8")) as { status: string; output: string };
		assert.equal(result.status, "completed");
		assert.equal(result.output, "the answer");
		assert.equal(child.shutdownCalls.length, 1, "the child exits once it really is done");
	});
});

test("an interrupted child that quits for real still reports on shutdown", async () => {
	// Without this the parent would poll a child that is gone forever. The
	// shutdown fallback must therefore still work on the interrupt path.
	await withChildReporter({}, async (child) => {
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, outcome: "aborted", message: { role: "assistant", stopReason: "aborted" } },
			"aborted",
		);
		await child.fire("agent_settled", {}, "aborted");
		await child.fire("session_shutdown");

		const result = JSON.parse(await readFile(child.resultPath, "utf8")) as { status: string };
		assert.equal(result.status, "failed");
	});
});

test("a child launched without the interrupt path keeps the previous behaviour", async () => {
	// Degradation rule: with no marker path the child cannot be steered, so an
	// abort is reported as a failed result and the child shuts down, rather than
	// sitting at a prompt the parent would never hear about again.
	await withChildReporter({ PI_TMUX_SUBAGENT_INTERRUPT: undefined }, async (child) => {
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, outcome: "aborted", message: { role: "assistant", stopReason: "aborted" } },
			"aborted",
		);
		await child.fire("agent_settled", {}, "aborted");

		assert.equal(existsSync(child.interruptPath), false);
		const result = JSON.parse(await readFile(child.resultPath, "utf8")) as { status: string };
		assert.equal(result.status, "failed");
		assert.equal(child.shutdownCalls.length, 1);
	});
});

test("a completed turn_end does not divert the settle", async () => {
	await withChildReporter({}, async (child) => {
		await child.fire(
			"turn_end",
			{ type: "turn_end", turnIndex: 0, outcome: "completed", message: { role: "assistant", stopReason: "stop" } },
			"stop",
		);
		await child.fire("agent_settled", {}, "stop");
		assert.equal(existsSync(child.interruptPath), false, "no marker on a normal settle");
	});
});
