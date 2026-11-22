// Typed orchestration events (ticket 08, R34–R36): the bus contract, the
// total publisher, and one emitter test per publishing extension.
//
// The pure part uses a local bus so a throwing subscriber can be exercised
// directly; the emitters run the real extension factories. The subagent half
// uses the lifecycle harness, whose `pi.events` records emissions, so a
// completed run and a completed plan are observed through the same settle path
// production uses.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	ORCHESTRATION_EVENTS,
	publishOrchestrationEvent,
	subscribeOrchestrationEvent,
	type OrchestrationEventMap,
	type TodoChangedPayload,
} from "../../orchestrator/events.ts";
import reviewTriageExtension from "../../review-triage/index.ts";
import todosExtension from "../../todos.ts";
import { withHarness, waitForRunStatus } from "./lifecycle-harness.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

function localBus() {
	const handlers = new Map<string, ((data: unknown) => void)[]>();
	return {
		emit(channel: string, data: unknown) {
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const current = handlers.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
	};
}

test("typed payloads round-trip through publish and subscribe", () => {
	const bus = localBus();
	const host = { events: bus } as never;
	const received: TodoChangedPayload[] = [];
	const off = subscribeOrchestrationEvent(host, ORCHESTRATION_EVENTS.todoChanged, (payload) => {
		received.push(payload);
	});

	const result = publishOrchestrationEvent(host, ORCHESTRATION_EVENTS.todoChanged, {
		action: "create",
		id: "aaaaaaaa",
		title: "typed",
		status: "open",
	});
	assert.deepEqual(result, { published: true });
	assert.deepEqual(received, [{ action: "create", id: "aaaaaaaa", title: "typed", status: "open" }]);

	off();
	publishOrchestrationEvent(host, ORCHESTRATION_EVENTS.todoChanged, { action: "update", id: "bbbbbbbb" });
	assert.equal(received.length, 1, "unsubscribe removes the handler");
});

test("publishing is total when the host has no bus or the bus throws", () => {
	assert.equal(publishOrchestrationEvent(undefined, ORCHESTRATION_EVENTS.gateDecided, { verdict: {} as never }).published, false);
	assert.equal(
		publishOrchestrationEvent({} as never, ORCHESTRATION_EVENTS.gateDecided, { verdict: {} as never }).published,
		false,
	);
	const throwing = {
		events: {
			emit: () => {
				throw new Error("subscriber exploded");
			},
			on: () => () => {},
		},
	} as never;
	const result = publishOrchestrationEvent(throwing, ORCHESTRATION_EVENTS.gateDecided, { verdict: {} as never });
	assert.equal(result.published, false);
	assert.match(result.error ?? "", /subscriber exploded/);
});

test("a throwing subscriber cannot affect the operation that published", () => {
	const bus = localBus();
	subscribeOrchestrationEvent({ events: bus } as never, ORCHESTRATION_EVENTS.todoChanged, () => {
		throw new Error("subscriber exploded");
	});

	let continued = false;
	// The emitting operation must keep running; the publisher swallows the
	// synchronous throw a bare bus propagates.
	const result = publishOrchestrationEvent({ events: bus } as never, ORCHESTRATION_EVENTS.todoChanged, {
		action: "create",
		id: "aaaaaaaa",
	});
	continued = true;
	assert.equal(result.published, false);
	assert.equal(continued, true);
});

// --- Emitters ---------------------------------------------------------------

interface FakePi {
	tools: { name?: string; execute?: (...args: unknown[]) => Promise<unknown> }[];
	commands: Map<string, unknown>;
	emitted: { channel: string; data: unknown }[];
	appendEntry: (type: string, data: unknown) => void;
	registerTool: (definition: FakePi["tools"][number]) => void;
	registerCommand: (name: string, definition: unknown) => void;
	events: { emit: (channel: string, data: unknown) => void; on: () => () => void };
	on: () => void;
}

function fakePi(): FakePi {
	const tools: FakePi["tools"] = [];
	const commands = new Map<string, unknown>();
	const emitted: { channel: string; data: unknown }[] = [];
	return {
		tools,
		commands,
		emitted,
		appendEntry: () => {},
		registerTool: (definition) => {
			tools.push(definition);
		},
		registerCommand: (name, definition) => {
			commands.set(name, definition);
		},
		events: {
			emit: (channel, data) => {
				emitted.push({ channel, data });
			},
			on: () => () => {},
		},
		on: () => {},
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-events-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("a successful todo mutation publishes todo-changed, and a read does not", async () => {
	const pi = fakePi();
	todosExtension(pi as never);
	const tool = pi.tools.find((candidate) => candidate.name === "todo");
	assert.ok(tool?.execute);

	await withTempDir(async (dir) => {
		await withEnv({ PI_TODO_PATH: dir }, async () => {
			const ctx = {
				cwd: dir,
				hasUI: false,
				ui: { notify: () => {} },
				sessionManager: {
					getSessionId: () => "session-1",
					getSessionFile: () => path.join(dir, "session.jsonl"),
				},
			};
			const create = (await tool!.execute!(
				"call",
				{ action: "create", title: "eventful" },
				undefined,
				undefined,
				ctx,
			)) as { details: { todo: { id: string } } };
			assert.equal(pi.emitted.length, 1);
			assert.equal(pi.emitted[0]?.channel, ORCHESTRATION_EVENTS.todoChanged);
			const payload = pi.emitted[0]?.data as TodoChangedPayload;
			assert.equal(payload.action, "create");
			assert.equal(payload.title, "eventful");
			assert.equal(payload.id, create.details.todo.id);
			assert.equal(payload.sessionId, "session-1");

			await tool!.execute!("call", { action: "list" }, undefined, undefined, ctx);
			assert.equal(pi.emitted.length, 1, "a list mutates nothing");
		});
	});
});

test("a triage plan publishes triage-planned", async () => {
	await withTempDir(async (dir) => {
		await withTempAgentDir(async () => {
			const pi = fakePi();
			reviewTriageExtension(pi as never);
			const tool = pi.tools.find((candidate) => candidate.name === "triage_change");
			assert.ok(tool?.execute, "the extension registered triage_change");

			await withEnv({ PI_REVIEW_TRIAGE_OFF: "1" }, async () => {
				await tool!.execute!(
					"call",
					{ summary: "event test", target: "none" },
					undefined,
					undefined,
					{ cwd: dir, hasUI: false, signal: undefined, modelRegistry: {} },
				);
			});

			const event = pi.emitted.find((candidate) => candidate.channel === ORCHESTRATION_EVENTS.triagePlanned);
			assert.ok(event, "a triage plan must publish its event");
			const payload = event!.data as OrchestrationEventMap["orchestrator:triage-planned"];
			assert.equal(payload.target, "none");
			assert.equal(typeof payload.verdict, "string");
			assert.equal(typeof payload.status, "string");
		});
	});
});

test("a settled subagent run publishes run-settled", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", { task: "emit a run event" });
		const run = started.details as unknown as { id: string };
		await h.writeResult(run as never, {
			version: 1,
			status: "completed",
			output: "done",
			finishedAt: Date.now(),
		});
		await waitForRunStatus(h, "completed");

		await waitFor(() => h.events.some((event) => event.channel === ORCHESTRATION_EVENTS.runSettled));
		const event = h.events.find((candidate) => candidate.channel === ORCHESTRATION_EVENTS.runSettled);
		const payload = event!.data as OrchestrationEventMap["orchestrator:run-settled"];
		assert.equal(payload.runId, run.id);
		assert.equal(payload.status, "completed");
	});
});

test("a plan publishes plan-settled when it becomes terminal", async () => {
	await withHarness({}, async (h) => {
		const started = await h.call("subagent", { tasks: [{ id: "only", task: "emit a plan event" }] });
		const plan = started.details.plan as unknown as { id: string };
		const runs = started.details.runs as unknown as { id: string }[];
		await h.writeResult(runs[0] as never, {
			version: 1,
			status: "completed",
			output: "done",
			finishedAt: Date.now(),
		});
		await waitFor(async () => (await h.readPlans())[0]?.status === "completed");
		await waitFor(() => h.events.some((event) => event.channel === ORCHESTRATION_EVENTS.planSettled));

		// One announcement for the terminal transition. The `announcedPlans` guard that
		// suppresses a second one is per process and is not driven here: a late
		// reduction of an already-terminal plan is hard to reach through the public
		// surface, and the guard's failure mode is a duplicate event inside a process
		// whose subscribers are the only listeners.
		const events = h.events.filter((candidate) => candidate.channel === ORCHESTRATION_EVENTS.planSettled);
		assert.equal(events.length, 1);
		const payload = events[0]!.data as OrchestrationEventMap["orchestrator:plan-settled"];
		assert.equal(payload.planId, plan.id);
		assert.equal(payload.status, "completed");
	});
});
