// Behaviour tests for the subagent lifecycle: launch, concurrency queueing,
// result finalisation, failure detection, cancel, wait, status and clean.
//
// The extension talks to tmux exclusively through `pi.exec`, so a fake
// ExtensionAPI that scripts `exec` is enough to drive the whole state machine
// without spawning real tmux sessions or child pi processes.
//
// Risk covered: the watcher and the concurrency queue are fire-and-forget async
// (`void watchTick(run)`, `void drainQueue()`), which is exactly where a race or
// a lost timer silently strands a run. The shutdown test at the bottom pins the
// other half of that race: a tick in flight must not re-arm its timer after
// `session_shutdown` has cleared the timer map.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension, { type RunRecord } from "../index.ts";
import { getActivityFilePath, readActivityFile } from "../activity.ts";
import { getInterruptFilePath } from "../interrupt.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

interface Harness {
	pi: Record<string, unknown>;
	ctx: Record<string, unknown>;
	tools: Map<string, Record<string, unknown>>;
	execCalls: { command: string; args: string[] }[];
	messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[];
	/** Make every tmux call against the run's pane fail as if the session were gone. */
	removeTarget: () => void;
	/** Fail pane calls once with an unclassifiable error, then behave normally. */
	failPaneOnce: () => void;
	/** Fail every pane call with an unclassifiable error (an unreachable socket). */
	failPaneAlways: () => void;
	shutdown: () => Promise<void>;
	call: (tool: string, params: Record<string, unknown>) => Promise<{ text: string; details: Record<string, unknown> }>;
	readRuns: () => Promise<RunRecord[]>;
	writeResult: (run: RunRecord, result: Record<string, unknown>) => Promise<void>;
	writeActivity: (run: RunRecord, activity: Record<string, unknown>) => Promise<void>;
	writeInterrupt: (run: RunRecord, marker?: Record<string, unknown>) => Promise<void>;
}

interface HarnessOptions {
	maxConcurrent?: string;
	paneText?: string;
	paneDead?: boolean;
	/** Grace period subagent_interrupt waits for the child to confirm, in ms. */
	interruptConfirmMs?: string;
	/** Artificial delay (ms) added to every tmux call, so a shutdown can land while a watcher tick is mid-flight. */
	execDelayMs?: number;
	/** Start with the tmux target missing, as if the session had been killed by hand. */
	missingTarget?: boolean;
	/** Overrides ctx.sessionManager, so fork/lineage tests can present a real live branch. */
	sessionManager?: Record<string, unknown>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const execCalls: { command: string; args: string[] }[] = [];
	const messages: { message: Record<string, unknown>; options: Record<string, unknown> | undefined }[] = [];
	// Flipped by removeTarget() to simulate the user killing the tmux session (or
	// the server dying) out from under a run.
	let targetMissing = options.missingTarget === true;
	// Unclassifiable failures, counted down: `once` for a single blip.
	let paneFailures = 0;
	let paneFailureMode = "";

	const pi = {
		registerFlag: () => undefined,
		getFlag: () => undefined,
		registerTool: (tool: Record<string, unknown>) => tools.set(tool.name as string, tool),
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		registerEntryRenderer: () => undefined,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		getThinkingLevel: () => "medium",
		sendMessage: (message: Record<string, unknown>, opts?: Record<string, unknown>) => {
			messages.push({ message, options: opts });
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			if (options.execDelayMs) await new Promise((resolve) => setTimeout(resolve, options.execDelayMs));
			const joined = args.join(" ");
			if (joined.includes("-V")) return { code: 0, stdout: "tmux 3.3a", stderr: "" };
			const paneCall = joined.includes("capture-pane") || joined.includes("display-message");
			if (paneCall && targetMissing) {
				return { code: 1, stdout: "", stderr: "can't find pane: pi-agent-gone" };
			}
			if (paneCall && paneFailures > 0) {
				// "always" keeps failing; any finite count is a blip that recovers.
				if (paneFailureMode !== "always") paneFailures -= 1;
				return { code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-subagents.sock (No such file or directory)" };
			}
			if (joined.includes("capture-pane")) {
				return { code: 0, stdout: options.paneText ?? "child working\n", stderr: "" };
			}
			if (joined.includes("display-message")) {
				return { code: 0, stdout: options.paneDead ? "1" : "0", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};

	const ctx = {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: options.sessionManager ?? {
			getSessionId: () => SESSION_ID,
			getSessionFile: () => path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", `${SESSION_ID}.jsonl`),
			getBranch: () => [],
		},
		model: { provider: "openrouter", id: "parent/model" },
		ui: {
			notify: () => undefined,
			custom: async () => undefined,
			setWidget: () => undefined,
		},
		shutdown: () => undefined,
	};

	await withEnv(
		{
			// The factory branches on these to decide whether it is running as a
			// child reporter or as the parent. They must be cleared from the
			// ambient environment: a reviewer subagent, or any pi subagent child,
			// already has them set, and without this the harness would silently
			// exercise the child branch and register no parent tools at all.
			PI_TMUX_SUBAGENT_CHILD: undefined,
			PI_TMUX_SUBAGENT_RESULT: undefined,
			PI_TMUX_SUBAGENT_INTERRUPT: undefined,
			PI_SUBAGENT_MAX_CONCURRENT: options.maxConcurrent ?? "4",
			PI_SUBAGENT_INTERRUPT_CONFIRM_MS: options.interruptConfirmMs,
			PI_SUBAGENT_NOTIFY: "true",
			PI_SUBAGENT_AUTO_REAP: "true",
			PI_SUBAGENT_REAP_DELAY_MS: "0",
			PI_SUBAGENT_GC_DAYS: "7",
		},
		async () => {
			subagentExtension(pi as never);
			await handlers.get("session_start")?.({}, ctx);
		},
	);

	const runsIndex = path.join(process.env.PI_CODING_AGENT_DIR ?? "/tmp", "tmux-subagents", SESSION_ID, "runs.json");

	return {
		pi,
		ctx,
		tools,
		execCalls,
		messages,
		removeTarget: () => {
			targetMissing = true;
		},
		failPaneOnce: () => {
			paneFailureMode = "once";
			paneFailures = 1;
		},
		failPaneAlways: () => {
			paneFailureMode = "always";
			paneFailures = Number.MAX_SAFE_INTEGER;
		},
		shutdown: async () => {
			await handlers.get("session_shutdown")?.({}, ctx);
		},
		call: async (tool, params) => {
			const definition = tools.get(tool);
			assert.ok(definition, `tool ${tool} must be registered`);
			const execute = definition.execute as (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
			const result = await execute(`call-${tool}`, params, undefined, undefined, ctx);
			return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
		},
		readRuns: async () => JSON.parse(await readFile(runsIndex, "utf8")) as RunRecord[],
		writeResult: async (run, result) => {
			await writeFile(run.resultPath, `${JSON.stringify(result)}\n`, "utf8");
		},
		writeActivity: async (run, activity) => {
			await writeFile(getActivityFilePath(run.runDir), `${JSON.stringify(activity)}\n`, "utf8");
		},
		writeInterrupt: async (run, overrides = {}) => {
			await writeFile(
				getInterruptFilePath(run.runDir),
				`${JSON.stringify({
					version: 1,
					runId: run.id,
					interruptedAt: Date.now(),
					interrupts: 1,
					turnIndex: 0,
					stopReason: "aborted",
					...overrides,
				})}\n`,
				"utf8",
			);
		},
	};
}

async function withHarness<T>(
	options: HarnessOptions | undefined,
	fn: (harness: Harness) => Promise<T>,
): Promise<T> {
	return withTempAgentDir(async () => {
		// withTempAgentDir already points PI_CODING_AGENT_DIR at a fresh temp
		// directory and restores the previous value afterwards.
		const harness = await createHarness(options);
		try {
			return await fn(harness);
		} finally {
			await harness.shutdown();
		}
	});
}

test("the harness exercises the parent branch even inside a pi subagent child", async () => {
	// This guards the harness, not the extension: createHarness clears
	// PI_TMUX_SUBAGENT_CHILD, which the extension factory branches on. Without
	// that, every test would silently register the child reporter instead of the
	// parent tools. Re-run the suite with PI_TMUX_SUBAGENT_CHILD=1 in the ambient
	// environment to check this holds.
	await withEnv(
		{ PI_TMUX_SUBAGENT_CHILD: "1", PI_TMUX_SUBAGENT_RESULT: "/tmp/should-not-be-used.jsonl" },
		async () => {
			await withTempAgentDir(async () => {
				const harness = await createHarness();
				try {
					assert.ok(harness.tools.has("subagent"), "parent tools are registered");
					assert.ok(harness.tools.has("subagent_status"), "parent tools are registered");
				} finally {
					await harness.shutdown();
				}
			});
		},
	);
});

test("subagent launches a child in a detached tmux session and returns immediately", async () => {
	await withHarness(undefined, async (h) => {
		const { text, details } = await h.call("subagent", { task: "Do the thing" });
		const run = details as unknown as RunRecord;

		assert.match(text, new RegExp(`Subagent ${run.id} started\\.`));
		assert.ok(text.includes("Model: openrouter/parent/model (medium)"));
		assert.ok(text.includes(`pi --attach-subagent '${run.id}'`));

		const launched = h.execCalls.some((call) => call.command === "tmux" && call.args.includes("new-session"));
		assert.ok(launched, "a tmux session is created");
		const keys = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.ok(keys.length >= 2, "the child command is typed and submitted");
		assert.ok(
			keys.some((call) => call.args.some((arg) => arg.includes("--provider"))),
			"the child invocation carries the provider",
		);

		const runs = await h.readRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].status, "running");
		assert.equal(runs[0].task, "Do the thing");
	});
});

test("subagent rejects an empty task and a missing cwd", async () => {
	await withHarness(undefined, async (h) => {
		await assert.rejects(() => h.call("subagent", { task: "   " }), /must not be empty/);
		await assert.rejects(() => h.call("subagent", { task: "x", cwd: "/definitely/not/here" }), /does not exist/);
	});
});

test("runs beyond the concurrency cap are queued and start when a slot frees", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "first" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "second" })).details as unknown as RunRecord;

		const runs = await h.readRuns();
		assert.equal(runs.find((run) => run.id === first.id)?.status, "running");
		assert.equal(runs.find((run) => run.id === second.id)?.status, "queued");

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

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

		const notification = h.messages.at(-1);
		assert.equal(notification?.message.customType, "subagent-result");
		assert.deepEqual(notification?.options, { deliverAs: "followUp", triggerTurn: true });
		// The notification points at the run rather than inlining its output; the
		// agent collects the text with subagent_status.
		assert.ok(!String(notification?.message.content).includes("the answer is 42"));
		assert.ok(String(notification?.message.content).includes(finalized.id));
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
		assert.ok(String(h.messages.at(-1)?.message.content).includes("provider exploded"));
	});
});

test("a dead pane without a result fails the run with capture guidance", async () => {
	await withHarness({ paneDead: true }, async (h) => {
		const run = (await h.call("subagent", { task: "dies early" })).details as unknown as RunRecord;
		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		const failed = (await h.readRuns())[0];
		assert.match(failed.error ?? "", /exited before reporting a result/);
		assert.match(failed.error ?? "", /capture-pane/);
		assert.equal(failed.id, run.id);
	});
});

test("an unreadable result file does not finalize the run", async () => {
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "corrupt result" });
		const run = (await h.readRuns())[0];
		await writeFile(run.resultPath, "{not json", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		assert.equal((await h.readRuns())[0].status, "running", "a parse failure must not be read as completion");
	});
});

test("subagent_cancel kills the tmux session and is idempotent once terminal", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel me" })).details as unknown as RunRecord;
		const killed = await h.call("subagent_cancel", { id: run.id });
		assert.match(killed.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"the tmux session is killed",
		);

		const again = await h.call("subagent_cancel", { id: run.id });
		assert.match(again.text, /already cancelled/);
		await assert.rejects(() => h.call("subagent_cancel", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("subagent_status lists runs and inspects one", async () => {
	await withHarness(undefined, async (h) => {
		const empty = await h.call("subagent_status", {});
		assert.match(empty.text, /No subagent runs/);

		const run = (await h.call("subagent", { task: "inspect me" })).details as unknown as RunRecord;
		const listed = await h.call("subagent_status", {});
		assert.ok(listed.text.includes(run.id));
		assert.ok(listed.text.includes("inspect me"));

		const inspected = await h.call("subagent_status", { id: run.id });
		assert.ok(inspected.text.includes(`model: openrouter/parent/model (medium)`));
		await assert.rejects(() => h.call("subagent_status", { id: "nope" }), /Unknown subagent run/);
	});
});

test("subagent_wait blocks until the run finishes and returns its output", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "wait for me" })).details as unknown as RunRecord;
		setTimeout(() => {
			void h.writeResult(run, {
				version: 1,
				status: "completed",
				output: "finished output",
				finishedAt: Date.now(),
			});
		}, 300);

		const waited = await h.call("subagent_wait", { ids: [run.id], timeout_seconds: 10 });
		assert.ok(waited.text.includes("finished output"));
	});
});

test("subagent_wait returns immediately when nothing is outstanding", async () => {
	await withHarness(undefined, async (h) => {
		const waited = await h.call("subagent_wait", {});
		assert.match(waited.text, /No incomplete subagent runs/);
		await assert.rejects(() => h.call("subagent_wait", { ids: ["ghost"] }), /Unknown subagent run/);
	});
});

test("subagent_wait aborts when the tool call is cancelled", async () => {
	await withHarness(undefined, async (h) => {
		await h.call("subagent", { task: "hangs forever" });
		const controller = new AbortController();
		const tool = h.tools.get("subagent_wait");
		const execute = tool?.execute as (...args: unknown[]) => Promise<unknown>;
		const promise = execute("call-1", {}, controller.signal, undefined, h.ctx);
		controller.abort();
		await assert.rejects(() => promise, /aborted/);
	});
});

test("subagent_clean reaps finished runs but leaves active ones alone", async () => {
	await withHarness(undefined, async (h) => {
		const done = (await h.call("subagent", { task: "finishes" })).details as unknown as RunRecord;
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === done.id)?.status === "completed");

		const cleaned = await h.call("subagent_clean", {});
		assert.match(cleaned.text, /Cleaned 1 tmux session\(s\), deleted 0 run dir\(s\), skipped 1/);

		const stillThere = (await h.readRuns()).find((run) => run.id === active.id);
		assert.equal(stillThere?.status, "running");
	});
});

test("session_shutdown stops the watcher from polling tmux again", async () => {
	// Regression test for the post-shutdown timer leak (local patch 10).
	// A run that is still `running` has a live 500ms watcher. Shutting down while
	// a tick is in flight used to leave an orphan timer behind that nothing would
	// ever clear: the parent kept calling `pi.exec` (capture-pane) forever and kept
	// the event loop alive, so the suite needed `--test-force-exit`. The delay makes
	// the race deterministic: shutdown happens while the tick awaits `pi.exec`.
	// Assert on observable behaviour, not on timer internals.
	await withTempAgentDir(async () => {
		const harness = await createHarness({ execDelayMs: 400 });
		try {
			await harness.call("subagent", { task: "watched at shutdown" });
			// A capture-pane call is recorded before the fake applies the delay, so
			// this returns while that tick is still awaiting.
			await waitFor(async () => harness.execCalls.some((call) => call.args.includes("capture-pane")));

			await harness.shutdown();
			// The in-flight tick legitimately finishes its remaining calls after the
			// shutdown flag is set; what must not happen is a *new* poll.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const callsAfterTick = harness.execCalls.length;
			await new Promise((resolve) => setTimeout(resolve, 2_000));

			const after = harness.execCalls.slice(callsAfterTick);
			assert.equal(after.length, 0, `no tmux calls after shutdown, got: ${JSON.stringify(after)}`);
			assert.ok(!after.some((call) => call.args.includes("capture-pane")), "the watcher must not poll the pane again");
		} finally {
			await harness.shutdown();
		}
	});
});

test("the shutdown flag is per extension load, not global", async () => {
	// The fix lives in the factory closure. If it leaked across loads, a session
	// that shut down would leave every later extension instance permanently
	// unable to watch a run. createHarness calls the factory again, so a fresh
	// instance must poll normally after the previous one was shut down.
	await withTempAgentDir(async () => {
		const first = await createHarness();
		try {
			await first.call("subagent", { task: "old instance" });
			await waitFor(async () => first.execCalls.some((call) => call.args.includes("capture-pane")));
			await first.shutdown();
		} finally {
			await first.shutdown();
		}

		const second = await createHarness();
		try {
			await second.call("subagent", { task: "new instance" });
			await waitFor(async () => second.execCalls.some((call) => call.args.includes("capture-pane")));
		} finally {
			await second.shutdown();
		}
	});
});

test("session_shutdown persists state without killing running children by default", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "survives reload" })).details as unknown as RunRecord;
		h.execCalls.length = 0;
		await h.shutdown();
		assert.ok(!h.execCalls.some((call) => call.args.includes("kill-session")), "PI_SUBAGENT_KILL_ON_SHUTDOWN is off by default");
		assert.equal((await h.readRuns()).find((entry) => entry.id === run.id)?.status, "running");
	});
});
// ---------------------------------------------------------------------------
// Liveness (local patch 11): the parent reads the child's activity snapshot.
// ---------------------------------------------------------------------------

function activitySnapshot(run: RunRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		runningChildId: run.id,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		activeSince: Date.now(),
		sequence: 3,
		latestEvent: "tool_execution_start",
		phase: "active",
		agentActive: true,
		providerActive: false,
		toolActive: true,
		activeScope: "tool",
		toolName: "bash",
		...overrides,
	};
}

test("subagent_status surfaces the child's live activity phase", async () => {
	// Constant pane text on purpose: with a changing pane the watcher persists
	// runs.json on every tick, which would let this pass even if the activity
	// branch never persisted anything.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "watch me" })).details as unknown as RunRecord;
		await waitFor(async () => (await h.readRuns())[0].pane !== undefined);
		const before = await h.call("subagent_status", { id: run.id });
		assert.ok(!before.text.includes("activity:"), "no activity line until a snapshot exists");
		assert.equal((await h.readRuns())[0].activity, undefined, "nothing persisted yet");

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");
		const after = await h.call("subagent_status", { id: run.id });
		assert.ok(after.text.includes("activity: active tool (bash)"), after.text);

		const persisted = (await h.readRuns())[0].activity;
		assert.deepEqual(persisted, {
			phase: "active",
			scope: "tool",
			toolName: "bash",
			sequence: 3,
			updatedAt: persisted?.updatedAt,
		});
	});
});

test("an older activity snapshot never overwrites a newer one", async () => {
	// Regression coverage for the monotonicity guard. Without it, a stale file
	// (or one left over from before a reload) could roll the parent backwards.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "monotonic" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { sequence: 10, toolName: "bash" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 10);

		await h.writeActivity(run, activitySnapshot(run, { sequence: 4, toolName: "grep" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const stored = (await h.readRuns())[0].activity;
		assert.equal(stored?.sequence, 10, "the older sequence is ignored");
		assert.equal(stored?.toolName, "bash", "and it does not clobber the newer detail");

		// Equal sequence is ignored too: the contract is strictly "newer only",
		// so a replayed or hand-edited file at the same sequence cannot rewrite
		// what the parent already recorded.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 10, toolName: "grep" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity?.toolName, "bash", "a replayed snapshot is ignored");

		await h.writeActivity(run, activitySnapshot(run, { sequence: 11, toolName: "grep" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 11);
		assert.equal((await h.readRuns())[0].activity?.toolName, "grep", "a genuinely newer snapshot still lands");
	});
});

test("runs.json is only rewritten when the rendered activity changes", async () => {
	// Regression coverage for the signature dedupe: a chatty child must not
	// rewrite the index twice a second.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "dedupe" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { sequence: 5, toolName: "bash" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.sequence === 5);

		// Same rendered value, newer sequence: recorded in memory, not persisted.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 6, toolName: "bash" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity?.sequence, 5, "no rewrite for an unchanged rendering");

		// A visible change must still reach disk.
		await h.writeActivity(run, activitySnapshot(run, { sequence: 7, toolName: "grep" }));
		await waitFor(async () => (await h.readRuns())[0].activity?.toolName === "grep");
		assert.equal((await h.readRuns())[0].activity?.sequence, 7);
	});
});

test("a snapshot for a different child is ignored rather than trusted", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "stale snapshot" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run, { runningChildId: "a-previous-child" }));
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].activity, undefined, "a wrong-id snapshot is not recorded");
		const status = await h.call("subagent_status", { id: run.id });
		assert.ok(!status.text.includes("activity:"));
	});
});

test("a malformed snapshot never breaks the watcher", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "broken snapshot" })).details as unknown as RunRecord;
		await writeFile(getActivityFilePath(run.runDir), "{ not json", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal((await h.readRuns())[0].status, "running", "the run is unaffected");
		assert.equal((await h.readRuns())[0].activity, undefined);
	});
});

test("the child branch writes an activity snapshot and a terminal done phase", async (t) => {
	// Exercises the real child branch: PI_TMUX_SUBAGENT_CHILD makes the factory
	// register only the reporter, with the run id derived from the result path.
	await withTempAgentDir(async () => {
		const runId = "child-run-1";
		const runDir = path.join(process.env.PI_CODING_AGENT_DIR as string, "tmux-subagents", SESSION_ID, runId);
		await mkdir(runDir, { recursive: true });
		const resultPath = path.join(runDir, "result.json");

		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const shutdownCalls: number[] = [];
		const pi = {
			registerFlag: () => undefined,
			getFlag: () => undefined,
			registerTool: () => {
				throw new Error("the child must not register parent tools");
			},
			registerCommand: () => undefined,
			registerMessageRenderer: () => undefined,
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => handlers.delete(event);
			},
			getThinkingLevel: () => "medium",
			sendMessage: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		};
		const ctx = {
			sessionManager: { getSessionFile: () => path.join(runDir, "child.jsonl"), getBranch: () => [] },
			sessionManagerId: SESSION_ID,
			model: { provider: "openrouter", id: "child/model" },
			shutdown: () => shutdownCalls.push(1),
		};

		await withEnv(
			{ PI_TMUX_SUBAGENT_CHILD: "1", PI_TMUX_SUBAGENT_RESULT: resultPath },
			async () => {
				subagentExtension(pi as never);
			},
		);

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("tool_execution_start")?.({ toolName: "bash" }, ctx);
		const midFlight = await readActivityFile(getActivityFilePath(runDir), runId);
		assert.equal(midFlight.ok, true);
		assert.equal(midFlight.ok === true && midFlight.activity.phase, "active");
		assert.equal(midFlight.ok === true && midFlight.activity.toolName, "bash");

		// Prove the ordering rather than assume it: watch the run directory and
		// capture the activity phase at the instant result.json appears. If the
		// result were written before the terminal snapshot, this would read
		// "active" and fail.
		//
		// The watch is bounded on purpose. fs.watch may report filename === null,
		// and inotify may coalesce the two renames, so a missed event must fail
		// loudly rather than hang: node --test has no default per-test timeout.
		let watcher: ReturnType<typeof watch> | undefined;
		t.after(() => watcher?.close());
		const phaseWhenResultAppeared = new Promise<string>((resolve) => {
			watcher = watch(runDir, (_event, filename) => {
				if (filename !== "result.json") return;
				void (async () => {
					const snapshot = await readActivityFile(getActivityFilePath(runDir), runId);
					watcher?.close();
					resolve(snapshot.ok ? snapshot.activity.phase : "unreadable");
				})();
			});
		});
		const withDeadline = Promise.race([
			phaseWhenResultAppeared,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no result.json rename was observed")), 5_000)),
		]);

		await handlers.get("agent_settled")?.({}, {
			...ctx,
			sessionManager: {
				getSessionFile: () => path.join(runDir, "child.jsonl"),
				getBranch: () => [
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "child answer" }], stopReason: "stop" } },
				],
			},
		});

		assert.equal(await withDeadline, "done", "the done phase is durable before result.json appears");
		const done = await readActivityFile(getActivityFilePath(runDir), runId);
		assert.equal(done.ok === true && done.activity.phase, "done");
		const result = JSON.parse(await readFile(resultPath, "utf8")) as { status: string; output: string };
		assert.equal(result.status, "completed");
		assert.equal(result.output, "child answer");
		assert.equal(shutdownCalls.length, 1, "the child exits after reporting");
	});
});

test("a settled run reports its status, not a stale activity phase", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "finish cleanly" })).details as unknown as RunRecord;
		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");

		await h.writeResult(run, { version: 1, status: "completed", output: "done", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");

		const status = await h.call("subagent_status", { id: run.id });
		assert.ok(!status.text.includes("activity:"), "activity is a live signal, not a final result");
		assert.ok(status.text.includes("completed"));
	});
});

// --- Context handoff (subagent `handoff` parameter and subagent_resume) ---
//
// Risk covered: a resumed run keeps its transcript in its ANCESTOR's run dir,
// so the run dir and the transcript have different lifetimes. That mismatch is
// where silent data loss lives, and none of it is reachable from the
// standalone tests above.

/** A parent session manager presenting a live branch whose last-written entry is a different branch. */
function liveBranchSessionManager(agentDir: string) {
	const parentFile = path.join(agentDir, "parent.jsonl");
	const entries = [
		{ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "live question" }] } },
		{ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "live answer" }] } },
		{ type: "message", id: "e3", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "ABANDONED SIBLING" }] } },
	];
	// The live leaf is e2; the file's last line is e3. getLeafId() must be
	// consulted, never "the last entry".
	return {
		getSessionId: () => SESSION_ID,
		getSessionFile: () => parentFile,
		getLeafId: () => "e2",
		getBranch: (leafId?: string) => entries.filter((entry) => entry.id === "e1" || entry.id === (leafId ?? "e2")),
	};
}

test("handoff=fork seeds the child with the parent's LIVE branch", async () => {
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const run = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			assert.equal(run.mode, "fork");

			const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
			assert.equal(JSON.parse(lines[0]).type, "session");
			assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
			const body = lines.slice(1).map((line) => JSON.parse(line));
			assert.deepEqual(
				body.map((entry) => entry.id),
				["e1", "e2"],
				"only the live branch is inherited",
			);
			assert.ok(!lines.join("\n").includes("ABANDONED SIBLING"), "the abandoned sibling must not leak");
			// The live leaf must be the last line, because pi derives the active
			// branch from file order.
			assert.equal(body.at(-1)?.id, "e2");
			assert.equal(run.usageFromLine, 3, "header + two inherited entries");

			// fork mode addresses the child with --session, never --session-id:
			// pi hard-exits on the combination.
			const childCommand = harness.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.find((arg) => arg.includes("--provider"));
			assert.ok(childCommand?.includes("'--session'"), childCommand);
			assert.ok(!childCommand?.includes("--session-id"), childCommand);
		} finally {
			await harness.shutdown();
		}
	});
});

test("handoff=lineage links the child to the parent without sharing context", async () => {
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const run = (await harness.call("subagent", { task: "lineage work", handoff: "lineage" })).details as unknown as RunRecord;
			assert.equal(run.mode, "lineage");
			const lines = (await readFile(run.sessionFile as string, "utf8")).trim().split("\n");
			assert.equal(lines.length, 1, "header only: no inherited conversation");
			assert.equal(JSON.parse(lines[0]).parentSession, path.join(agentDir, "parent.jsonl"));
			assert.equal(run.usageFromLine, 1);
		} finally {
			await harness.shutdown();
		}
	});
});

/** Complete a run the way the child would, so it is eligible for resume. */
async function completeRun(h: Harness, run: RunRecord): Promise<void> {
	await h.writeResult(run, {
		version: 1,
		status: "completed",
		output: "ok",
		finishedAt: Date.now(),
		sessionFile: run.sessionFile,
	});
	await waitFor(async () => (await h.readRuns()).find((candidate) => candidate.id === run.id)?.status === "completed");
}

test("subagent_resume continues the same transcript and counts only its own turns", async () => {
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			await completeRun(harness, first);
			const beforeResume = (await readFile(first.sessionFile as string, "utf8")).trim().split("\n").length;

			const resumed = (await harness.call("subagent_resume", {
				id: first.id,
				message: "carry on",
			})).details as unknown as RunRecord;

			assert.equal(resumed.sessionFile, first.sessionFile, "the same transcript is continued");
			assert.notEqual(resumed.id, first.id);
			assert.equal(resumed.mode, "resume");
			assert.equal(resumed.attempt, 2);
			assert.equal(resumed.usageFromLine, beforeResume, "the baseline is the transcript as it stood");
			assert.notEqual(resumed.runDir, first.runDir, "the attempt gets its own run dir");

			const childCommand = harness.execCalls
				.filter((call) => call.args.includes("send-keys"))
				.flatMap((call) => call.args)
				.filter((arg) => arg.includes("'--session'"))
				.at(-1);
			assert.ok(childCommand?.includes("'--session'"));
			assert.ok(!childCommand?.includes("--session-id"), childCommand);
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_resume refuses a second concurrent resume of the same transcript", async () => {
	// Regression test: a finished run stays terminal forever, so the "is it
	// still running" guard passed for both resumes and two pi processes
	// appended to one JSONL, forking branches and scrambling baselines.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			await completeRun(harness, first);
			const a = (await harness.call("subagent_resume", { id: first.id, message: "one" })).details as unknown as RunRecord;
			await assert.rejects(
				() => harness.call("subagent_resume", { id: first.id, message: "two" }),
				/already using this session file/,
			);
			const runs = await harness.readRuns();
			assert.equal(runs.filter((run) => run.sessionFile === first.sessionFile && run.status !== "cancelled").length >= 1, true);
			assert.equal(a.attempt, 2);
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_resume refuses to resume a run that is still going", async () => {
	await withHarness(undefined, async (h) => {
		const active = (await h.call("subagent", { task: "still going" })).details as unknown as RunRecord;
		const result = await h.call("subagent_resume", { id: active.id, message: "are you there" });
		assert.match(result.text, /still has a live child \(running\)/);
	});
});

test("subagent_clean does not delete a run dir that still owns a live run's transcript", async () => {
	// Regression test: subagent_resume keeps the ANCESTOR's transcript, so
	// deleting the ancestor's run dir pulled the file out from under a run that
	// was still running. pi holds the descriptor open, so the child kept
	// writing to an unlinked inode and lost every entry silently.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			await harness.writeResult(first, {
				version: 1,
				status: "completed",
				output: "ok",
				finishedAt: Date.now(),
				sessionFile: first.sessionFile,
			});
			await waitFor(async () => (await harness.readRuns()).find((run) => run.id === first.id)?.status === "completed");

			// Resume it: the new run points at the old run's transcript and is running.
			const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;

			const cleaned = await harness.call("subagent_clean", { delete_files: true });
			assert.match(cleaned.text, /still hold the session file of a live run/);
			assert.match(cleaned.text, new RegExp(first.id));

			// The ancestor's transcript must still be on disk for the live run.
			assert.ok(existsSync(resumed.sessionFile as string), "live run's transcript survives the clean");
			assert.ok(existsSync(first.runDir), "the owning run dir is retained");
		} finally {
			await harness.shutdown();
		}
	});
});

test("subagent_clean counts only transcripts it actually deletes", async () => {
	// A resumed record's sessionFile lives in its ancestor's run dir, so
	// counting "has a sessionFile" over-reports: here the ancestor is skipped
	// as too recent while the resumed record is deleted, and the resumed
	// record's own dir contains no transcript at all. Deleting it destroys
	// nothing resumable, so the count must stay at 0.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			await completeRun(harness, first);
			const resumed = (await harness.call("subagent_resume", { id: first.id, message: "more" })).details as unknown as RunRecord;
			await harness.writeResult(resumed, {
				version: 1,
				status: "completed",
				output: "ok",
				// Old enough to be cleaned; the ancestor stays recent.
				finishedAt: Date.now() - 7_200_000,
				sessionFile: resumed.sessionFile,
			});
			await waitFor(async () => (await harness.readRuns()).find((run) => run.id === resumed.id)?.status === "completed");

			const cleaned = await harness.call("subagent_clean", { delete_files: true, older_than_hours: 1 });
			assert.match(cleaned.text, /deleted 1 run dir\(s\)/, cleaned.text);
			assert.doesNotMatch(
				cleaned.text,
				/child session transcript/,
				`deleting the resumed run's empty dir must not be reported as a lost transcript: ${cleaned.text}`,
			);
			// The ancestor's transcript is untouched, because it was skipped.
			assert.ok(existsSync(resumed.sessionFile as string));
		} finally {
			await harness.shutdown();
		}
	});
});

// --- Turn-level interrupt (local patch 13): subagent_interrupt and the
// "terminal but still alive" contract of the interrupted status. ---

test("subagent_interrupt sends Escape to the child's pane and nothing else", async () => {
	await withHarness({ interruptConfirmMs: "300" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1, "one key, one send: a second Enter would submit whatever the child had typed");
		assert.deepEqual(sent[0].args.slice(-3), ["-t", run.tmuxTarget, "Escape"]);
		assert.ok(!sent[0].args.includes("-l"), "Escape is a key, not a literal string");
		assert.ok(!sent[0].args.includes("C-c"), "app.clear quits the child on the second press");
		assert.match(interrupted.text, /did not confirm an interrupt/, "an idle child cannot confirm");

		// The record says a request is outstanding, so subagent_status can explain
		// a run whose child never answered.
		const stored = (await h.readRuns())[0];
		assert.ok(stored.interruptRequestedAt);
		assert.equal(stored.status, "running");
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: Escape sent .*not confirmed yet/s);
	});
});

test("subagent_interrupt confirms once the child writes the marker", async () => {
	await withHarness({ interruptConfirmMs: "5000" }, async (h) => {
		const run = (await h.call("subagent", { task: "diverging" })).details as unknown as RunRecord;
		// The child needs a moment to abort its provider stream, so the marker
		// lands after Escape was sent.
		setTimeout(() => {
			void h.writeInterrupt(run).catch(() => undefined);
		}, 300);

		const interrupted = await h.call("subagent_interrupt", { id: run.id });
		assert.match(interrupted.text, new RegExp(`Subagent ${run.id} interrupted\\.`));
		assert.match(interrupted.text, /attach/);
		assert.match(interrupted.text, /subagent_cancel/);

		const stored = (await h.readRuns())[0];
		assert.equal(stored.status, "interrupted");
		assert.equal(stored.interrupts, 1);
		assert.ok(stored.interruptedAt);
		assert.equal(stored.interruptRequestedAt, undefined, "a confirmed request is no longer outstanding");
		assert.equal(stored.finishedAt, undefined, "the child is still running, so elapsed time keeps counting");
		assert.equal(h.messages.length, 0, "an interrupted turn is not a completion");

		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /interrupt: turn aborted/);
		assert.match(status.text, /idle at its prompt/);
	});
});

test("a stale marker cannot confirm a second interrupt", async () => {
	// Regression: the marker file is never deleted, so a second interrupt used to
	// read the FIRST one back within a millisecond and report "interrupted" while
	// the child kept streaming — the agent would then treat a live run as stopped.
	await withHarness({ interruptConfirmMs: "400" }, async (h) => {
		const run = (await h.call("subagent", { task: "steered twice" })).details as unknown as RunRecord;
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.doesNotMatch(second.text, new RegExp(`Subagent ${run.id} interrupted\\.`), second.text);
		assert.match(second.text, /no new interrupt was reported/, second.text);
		assert.match(second.text, /the previous interrupt/);
		assert.equal((await h.readRuns())[0].interrupts, 1, "the old marker must not be counted again");

		// Only a genuinely newer marker confirms. The double-escape guard blocks a
		// request sent inside pi's 500ms window, so wait it out first. A third
		// interrupt means the child's own counter reaches 3: rewriting the same
		// value is, correctly, still the second interrupt.
		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const lastRequest = (await h.readRuns())[0].interruptRequestedAt ?? 0;
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - lastRequest))));
		await h.writeInterrupt(run, { interrupts: 3, interruptedAt: Date.now() });
		const third = await h.call("subagent_interrupt", { id: run.id });
		assert.match(third.text, new RegExp(`Subagent ${run.id} interrupted\\.`), third.text);
		assert.equal((await h.readRuns())[0].interrupts, 3);
	});
});

test("two Escapes are never sent inside pi's double-escape window", async () => {
	// On an idle child pi reads two Escapes within 500ms as its double-escape
	// action and opens the tree selector, which blocks the prompt without
	// touching the turn. The second request must be refused instead of sent.
	await withHarness({ interruptConfirmMs: "0" }, async (h) => {
		const run = (await h.call("subagent", { task: "double escape" })).details as unknown as RunRecord;
		h.execCalls.length = 0;

		await h.call("subagent_interrupt", { id: run.id });
		const sent = h.execCalls.filter((call) => call.args.includes("send-keys"));
		assert.equal(sent.length, 1);
		assert.match(sent[0].args.at(-1) as string, /Escape/);

		const second = await h.call("subagent_interrupt", { id: run.id });
		assert.equal(h.execCalls.filter((call) => call.args.includes("send-keys")).length, 1, "no second Escape");
		assert.match(second.text, /double escape/);
	});
});

test("two interrupts reported by the child are both recorded", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "twice interrupted" })).details as unknown as RunRecord;
		const firstAt = Date.now();
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 1);

		await h.writeInterrupt(run, { interrupts: 2, interruptedAt: firstAt + 5_000 });
		await waitFor(async () => (await h.readRuns())[0].interrupts === 2);
		const status = await h.call("subagent_status", { id: run.id });
		assert.match(status.text, /2 so far/);

		// A marker that goes backwards must not rewind the count or the timestamp.
		await h.writeInterrupt(run, { interrupts: 1, interruptedAt: firstAt });
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const stored = (await h.readRuns())[0];
		assert.equal(stored.interrupts, 2);
		assert.equal(stored.interruptedAt, firstAt + 5_000);
	});
});

test("a working child stops being described as idle", async () => {
	// The status stays interrupted, but the child can be driven again afterwards,
	// so the summary must not keep claiming it is sitting at the prompt.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "driven again" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
		assert.match((await h.call("subagent_status", { id: run.id })).text, /idle at its prompt/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].activity?.phase === "active");
		const after = await h.call("subagent_status", { id: run.id });
		assert.match(after.text, /has been driven again and is working/, after.text);
		assert.doesNotMatch(after.text, /idle at its prompt/);
	});
});

test("a later result still finalizes an interrupted run", async () => {
	// The watcher must survive the status change: an interrupted child that is
	// steered onwards reports normally, and the run completes exactly as an
	// uninterrupted one would.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "steer me" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		await h.writeResult(run, {
			version: 1,
			status: "completed",
			output: "corrected answer",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finalized = (await h.readRuns())[0];
		assert.equal(finalized.output, "corrected answer");
		assert.ok(finalized.finishedAt);
		assert.equal(finalized.interrupts, 1, "the interrupt history survives into the result");
		assert.equal(h.messages.length, 1, "and the run reports its completion normally");
	});
});

test("an interrupted run survives a reload and still finalizes", async () => {
	// loadPersistedRuns re-arms watchers for interrupted runs. Without that, a
	// result.json written after a reload would never be noticed and the run would
	// be stranded in `interrupted` forever.
	await withTempAgentDir(async () => {
		const firstHarness = await createHarness();
		let run!: RunRecord;
		try {
			run = (await firstHarness.call("subagent", { task: "outlives a reload" })).details as unknown as RunRecord;
			await firstHarness.writeInterrupt(run);
			await waitFor(async () => (await firstHarness.readRuns())[0].status === "interrupted");
		} finally {
			await firstHarness.shutdown();
		}

		// A fresh extension load over the same agent dir: loadPersistedRuns must
		// restore the interrupted run AND re-arm its watcher.
		const second = await createHarness();
		try {
			await waitFor(async () => second.execCalls.some((call) => call.args.includes("capture-pane")));
			assert.equal((await second.readRuns())[0].status, "interrupted", "the status is restored from disk");

			await second.writeResult(run, {
				version: 1,
				status: "completed",
				output: "finished after the reload",
				finishedAt: Date.now(),
			});
			await waitFor(async () => (await second.readRuns())[0].status === "completed");
			assert.equal((await second.readRuns())[0].output, "finished after the reload");
		} finally {
			await second.shutdown();
		}
	});
});

test("an interrupted run keeps its concurrency slot until it is cancelled", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		const first = (await h.call("subagent", { task: "interrupted" })).details as unknown as RunRecord;
		const second = (await h.call("subagent", { task: "queued behind it" })).details as unknown as RunRecord;
		await h.writeInterrupt(first);
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === first.id)?.status === "interrupted");

		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(
			(await h.readRuns()).find((run) => run.id === second.id)?.status,
			"queued",
			"the interrupted child still holds a process, so it still holds its slot",
		);

		await h.call("subagent_cancel", { id: first.id });
		await waitFor(async () => (await h.readRuns()).find((run) => run.id === second.id)?.status === "running");
	});
});

test("an interrupted run is not cleaned away, and its transcript survives shutdown", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "keep my session" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");
		h.execCalls.length = 0;

		// subagent_clean must leave it alone while this session is live: the tmux
		// session is the only handle on a resumable transcript.
		const cleaned = await h.call("subagent_clean", { delete_files: true });
		assert.match(cleaned.text, /skipped 1/);
		assert.ok(
			!h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"cleaning must not kill the interrupted child",
		);
		assert.ok(existsSync(run.runDir), "its run dir survives");

		// Shutdown DOES release the child, because nothing could reach it afterwards
		// and it is idle. Killing the tmux session keeps the transcript, so the run
		// stays resumable — the same bargain auto-reap makes for a finished run.
		await h.shutdown();
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"shutdown releases the interrupted child instead of orphaning it",
		);
		assert.equal((await h.readRuns())[0].status, "interrupted");
		assert.ok(existsSync(run.runDir), "the transcript is still there for subagent_resume");
	});
});

test("subagent_cancel releases an interrupted child", async () => {
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "cancel an interrupted run" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		const cancelled = await h.call("subagent_cancel", { id: run.id });
		assert.match(cancelled.text, new RegExp(`Subagent ${run.id} cancelled`));
		assert.ok(
			h.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)),
			"cancelling an interrupted run must kill the child that is still alive",
		);
		// And it is now genuinely finished, so a second cancel is a no-op.
		assert.match((await h.call("subagent_cancel", { id: run.id })).text, /already cancelled/);
	});
});

test("kill-on-shutdown cancels an interrupted run", async () => {
	await withTempAgentDir(async () => {
		await withEnv({ PI_SUBAGENT_KILL_ON_SHUTDOWN: "true" }, async () => {
			const harness = await createHarness();
			try {
				const run = (await harness.call("subagent", { task: "kill on exit" })).details as unknown as RunRecord;
				await harness.writeInterrupt(run);
				await waitFor(async () => (await harness.readRuns())[0].status === "interrupted");
				await harness.shutdown();
				assert.equal((await harness.readRuns())[0].status, "cancelled");
				assert.ok(harness.execCalls.some((call) => call.args.includes("kill-session") && call.args.includes(run.tmuxSession)));
			} finally {
				await harness.shutdown();
			}
		});
	});
});

test("subagent_interrupt refuses a queued run and a finished one", async () => {
	await withHarness({ maxConcurrent: "1" }, async (h) => {
		await h.call("subagent", { task: "occupies the only slot" });
		const queued = (await h.call("subagent", { task: "never starts" })).details as unknown as RunRecord;
		await assert.rejects(() => h.call("subagent_interrupt", { id: queued.id }), /has not started yet/);

		const done = (await h.readRuns())[0];
		await h.writeResult(done, { version: 1, status: "completed", output: "ok", finishedAt: Date.now() });
		await waitFor(async () => (await h.readRuns())[0].status === "completed");
		const finished = await h.call("subagent_interrupt", { id: done.id });
		assert.match(finished.text, /already completed/);
		await assert.rejects(() => h.call("subagent_interrupt", { id: "no-such-run" }), /Unknown subagent run/);
	});
});

test("an interrupted run is refused a resume while its child is alive", async () => {
	// Regression: resume opens a SECOND pi process on the transcript, and an
	// interrupted child's pi is still holding that file open. Two appenders
	// interleave branches and scramble usage baselines — the corruption the
	// "already using this session file" guard exists to prevent. So the tool's own
	// suggested next step (attach, or cancel first) must not include resuming.
	await withTempAgentDir(async (agentDir) => {
		const harness = await createHarness({ sessionManager: liveBranchSessionManager(agentDir) as never });
		try {
			const first = (await harness.call("subagent", { task: "forked work", handoff: "fork" })).details as unknown as RunRecord;
			await harness.writeInterrupt(first);
			await waitFor(async () => (await harness.readRuns())[0].status === "interrupted");

			const refused = await harness.call("subagent_resume", { id: first.id, message: "different plan" });
			assert.match(refused.text, /still has a live child \(interrupted\)/);
			assert.match(refused.text, /subagent_cancel/);
			assert.equal((await harness.readRuns()).length, 1, "no second attempt was started");

			// Cancelling releases the child (the transcript stays on disk), and then
			// resume works exactly as it does for any finished run.
			await harness.call("subagent_cancel", { id: first.id });
			const resumed = (await harness.call("subagent_resume", { id: first.id, message: "different plan" }))
				.details as unknown as RunRecord;
			assert.equal(resumed.sessionFile, first.sessionFile);
			assert.equal(resumed.attempt, 2);
			assert.equal(resumed.interrupts, undefined, "the new attempt does not inherit the interrupt history");
		} finally {
			await harness.shutdown();
		}
	});
});

test("an interrupted run fails when its tmux session disappears", async () => {
	// Regression: `pane_dead` cannot report a missing target — it needs a live
	// pane to ask. Without treating tmux's "can't find pane" as death, a run whose
	// session was killed by hand polled a target that cannot exist every 500ms for
	// the rest of the session while claiming its child was idle at its prompt.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "session killed by hand" })).details as unknown as RunRecord;
		await h.writeInterrupt(run);
		await waitFor(async () => (await h.readRuns())[0].status === "interrupted");

		h.removeTarget();
		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		const failed = (await h.readRuns())[0];
		assert.match(failed.error ?? "", /exited before reporting a result/);
		assert.ok(failed.finishedAt);

		// And the watcher stops, rather than polling a dead target forever.
		h.execCalls.length = 0;
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		assert.equal(
			h.execCalls.filter((call) => call.args.includes("capture-pane")).length,
			0,
			`no further polls, got: ${JSON.stringify(h.execCalls.map((call) => call.args.join(" ")))}`,
		);
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

test("an unclassifiable tmux failure fails the run only after a run of them", async () => {
	// A single hiccup must not fail a healthy child, but a persistently
	// unreachable socket must not leave the watcher polling forever either. The
	// failure is reported as "cannot be reached", not as "the child exited": the
	// two claims need different evidence.
	await withHarness(undefined, async (h) => {
		const run = (await h.call("subagent", { task: "socket blips" })).details as unknown as RunRecord;
		h.failPaneOnce();
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.equal((await h.readRuns())[0].status, "running", "one failure is tolerated");

		h.failPaneAlways();
		await waitFor(async () => (await h.readRuns())[0].status === "failed");
		assert.match((await h.readRuns())[0].error ?? "", /could not be reached over tmux/);
		assert.doesNotMatch((await h.readRuns())[0].error ?? "", /exited before reporting/);
	});
});

test("an unconfirmed Escape is forgotten once the child is seen working again", async () => {
	// Otherwise subagent_status keeps advertising "not confirmed yet" for an Escape
	// from minutes ago, and the field feeds the double-escape guard.
	await withHarness({ paneText: "unchanging child output" }, async (h) => {
		const run = (await h.call("subagent", { task: "ignores escape" })).details as unknown as RunRecord;
		await h.call("subagent_interrupt", { id: run.id });
		assert.ok((await h.readRuns())[0].interruptRequestedAt);
		assert.match((await h.call("subagent_status", { id: run.id })).text, /not confirmed yet/);

		await h.writeActivity(run, activitySnapshot(run));
		await waitFor(async () => (await h.readRuns())[0].interruptRequestedAt === undefined);
		const status = await h.call("subagent_status", { id: run.id });
		assert.doesNotMatch(status.text, /not confirmed yet/);
	});
});
