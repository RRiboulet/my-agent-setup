// Tests for the fake extension host (./fake-pi.ts).
//
// The host exists because a factory's *wiring* — which tools it registers, which
// events it subscribes to, what it sends when an event fires — is invisible to
// the existing suites unless the extension happens to ship its own harness. The
// vendored goal extension is the motivating case: its pure helpers are covered,
// its event wiring is not.
//
// These tests pin the host itself. A harness that silently mis-models pi would
// make every later test lie, so each capability is asserted directly here.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createFakeHost } from "./fake-pi.ts";

test("records flags, tools, commands and shortcuts in registration order", () => {
	const host = createFakeHost();

	function fixture(pi: ExtensionAPI) {
		pi.registerFlag("fixture-flag", { description: "a flag", type: "boolean", default: false });
		pi.registerTool({
			name: "fixture_alpha",
			label: "Alpha",
			description: "the first tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		});
		pi.registerCommand("fixture", { description: "a command", handler: async () => {} });
		pi.registerShortcut("ctrl+x", { description: "a shortcut", handler: async () => {} });
		pi.registerTool({
			name: "fixture_beta",
			label: "Beta",
			description: "the second tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [], details: {} };
			},
		});
	}

	fixture(host.pi);

	assert.deepEqual(host.flagOrder, ["fixture-flag"]);
	assert.deepEqual(host.toolOrder, ["fixture_alpha", "fixture_beta"]);
	assert.deepEqual(host.commandOrder, ["fixture"]);
	assert.deepEqual(host.shortcutOrder, ["ctrl+x"]);

	// The definitions themselves are reachable, not just their names: a test must
	// be able to read a description or a parameter schema.
	assert.equal(host.tools.get("fixture_beta")?.description, "the second tool");
	assert.equal(host.commands.get("fixture")?.description, "a command");
	assert.equal(host.flags.get("fixture-flag")?.type, "boolean");
});

/**
 * Register a handler with the payload shape a test actually fires.
 *
 * `ExtensionAPI.on` is typed for pi's real events, and this double deliberately
 * fires minimal ones. The cast is the seam, confined to the tests that need it,
 * rather than loosening the host's own types.
 */
function on<T>(pi: ExtensionAPI, event: string, handler: (payload: T) => unknown): void {
	(pi.on as unknown as (name: string, fn: (payload: T) => unknown) => () => void)(event, handler);
}

interface ChainEvent {
	systemPrompt: string;
	systemPromptOptions: { sections: Record<string, string> };
}

test("dispatches handlers in registration order over one mutable event object", async () => {
	const host = createFakeHost();
	const seen: string[] = [];

	function fixture(pi: ExtensionAPI) {
		on<ChainEvent>(pi, "before_agent_start", (event) => {
			event.systemPromptOptions.sections.first = "set by the first handler";
			seen.push("first");
		});
		on<ChainEvent>(pi, "before_agent_start", (event) => {
			seen.push(`second saw ${event.systemPromptOptions.sections.first}`);
			return { systemPrompt: `${event.systemPrompt} + second` };
		});
	}

	fixture(host.pi);

	const result = await host.fire("before_agent_start", {
		systemPrompt: "base",
		systemPromptOptions: { sections: {} },
	});

	assert.deepEqual(seen, ["first", "second saw set by the first handler"]);
	// The last non-undefined result is what `fire` returns. pi does more for
	// chained-transform events (it feeds the value into the next handler); this
	// double does not model that, as its header says.
	assert.deepEqual(result, { systemPrompt: "base + second" });
});

test("each dispatch starts from the payload it was given", async () => {
	const host = createFakeHost();
	const observed: string[] = [];
	on<ChainEvent>(host.pi, "before_agent_start", (event) => {
		observed.push(event.systemPromptOptions.sections.leak ?? "clean");
		event.systemPromptOptions.sections.leak = "mutated";
	});

	await host.fire("before_agent_start", { systemPrompt: "a", systemPromptOptions: { sections: {} } });
	await host.fire("before_agent_start", { systemPrompt: "b", systemPromptOptions: { sections: {} } });

	// A host that kept one event object across dispatches would leak the first
	// handler's mutation into the second run — the failure mode this guards.
	assert.deepEqual(observed, ["clean", "clean"]);
});

test("records sent messages, with delivery options, in order", () => {
	const host = createFakeHost();

	host.pi.sendMessage(
		{ customType: "fixture-first", content: "one", display: false },
		{ triggerTurn: true },
	);
	host.pi.sendMessage({ customType: "fixture-second", content: "two", display: true });

	assert.deepEqual(
		host.messages.map((entry) => entry.message.customType),
		["fixture-first", "fixture-second"],
	);
	assert.deepEqual(host.messages[0]?.options, { triggerTurn: true });
	assert.equal(host.messages[1]?.options, undefined);
});

test("drives session start and shutdown, and exposes what the start established", async () => {
	const host = createFakeHost();
	let established = "nothing yet";

	function fixture(pi: ExtensionAPI) {
		pi.on("session_start", async (event) => {
			established = `started:${String(event.reason)}`;
			return { resumed: true };
		});
		pi.on("session_shutdown", async () => {
			established = "gone";
		});
	}

	fixture(host.pi);

	assert.deepEqual(await host.fire("session_start", { reason: "startup" }), { resumed: true });
	assert.equal(established, "started:startup");

	await host.fire("session_shutdown", { reason: "quit" });
	assert.equal(established, "gone");
});

test("callTool runs a registered tool with the host context and its parameters", async () => {
	const host = createFakeHost({ sessionId: "session-under-test" });
	host.pi.registerTool({
		name: "fixture_echo",
		label: "Echo",
		description: "echo the session and the parameter",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: ctx.sessionManager.getSessionId() }],
				details: { value: params.value },
			};
		},
	});

	const result = await host.callTool("fixture_echo", { value: 7 });

	assert.equal(result.content[0]?.text, "session-under-test");
	assert.deepEqual(result.details, { value: 7 });
});

test("callTool names the missing tool instead of returning a placeholder", async () => {
	const host = createFakeHost();
	await assert.rejects(host.callTool("not_registered", {}), /not_registered/);
});

test("a handler removed during a dispatch still runs in that dispatch", async () => {
	const host = createFakeHost();
	const seen: string[] = [];
	const register = host.pi.on as unknown as (event: string, handler: () => void) => () => void;

	let disposeSecond = () => {};
	register("turn_start", () => {
		seen.push("first");
		// pi snapshots the handler list, so this must not cancel the second
		// handler's turn in the dispatch already running.
		disposeSecond();
	});
	disposeSecond = register("turn_start", () => {
		seen.push("second");
	});

	await host.fire("turn_start", {});

	assert.deepEqual(seen, ["first", "second"]);
});

test("isIdle is false inside agent_end, as it is during a real run", async () => {
	const host = createFakeHost();
	const observed: boolean[] = [];
	on<Record<string, unknown>>(host.pi, "agent_start", () => {
		observed.push(host.ctx.isIdle());
	});
	on<Record<string, unknown>>(host.pi, "agent_end", () => {
		observed.push(host.ctx.isIdle());
	});

	assert.equal(host.ctx.isIdle(), true, "an idle session is idle before a run starts");
	await host.fire("agent_start", {});
	await host.fire("agent_end", { messages: [] });

	// agent_end fires while the run is still active, so a factory asking here
	// takes its streaming branch — the fact the goal continuation test depends on.
	assert.deepEqual(observed, [false, false]);
	assert.equal(host.ctx.isIdle(), true, "the run is over once agent_end handlers have run");
});
