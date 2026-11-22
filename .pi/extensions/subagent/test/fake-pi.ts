// A fake extension host: enough of `ExtensionAPI` and `ExtensionContext` to
// invoke a factory and observe its wiring, without a tmux server, a child
// process or a model.
//
// Why it exists. The existing lifecycle harness is specialised to the subagent
// extension: it scripts tmux, renders the widget and drives the run state
// machine. That makes it the wrong double for a factory whose behaviour lives in
// event handlers, and the vendored goal extension had no harness at all — its
// pure helpers were covered and its wiring was not. This double covers the
// wiring: what a factory registers, which events it subscribes to, and what it
// sends when one fires.
//
// What it models faithfully:
//   * registrations, in order, with their definitions reachable by name;
//   * event dispatch in registration order over ONE mutable event object, so a
//     later handler sees an earlier handler's in-place mutation (pi documents
//     this for `systemPromptOptions`, `tool_call.input` and headers);
//   * the last non-undefined handler result as the event's result, which is how
//     pi's "last override" and chained-transform events behave;
//   * messages recorded with their delivery options, in order;
//   * session entries appended by the extension, separately from messages,
//     because the two have different context semantics in pi;
//   * the session identity and branch a factory reads to reconstruct state.
//
// What it deliberately does NOT model:
//   * boundary proposals (`turn_end` / `agent_before_settle` entry merging).
//     Those compose a proposal list and rebuild context, not a single return
//     value. A test that needs that must extend this double; pretending to model
//     it here would let a test pass while the real composition differs.
//   * `tool_result` chaining, provider hooks, and anything requiring a live
//     model or an HTTP transport;
//   * interactive UI answers: `confirm` returns false and `select` / `input` /
//     `editor` return undefined. A test that needs a specific answer must add an
//     answers queue here first;
//   * pi's argument validation: the loader rejects a tool without a schema, a
//     command without a handler, or a flag whose default contradicts its type,
//     and `callTool` would validate parameters before `execute`. This double
//     accepts all of them, so a malformed registration or parameter is a test
//     bug here rather than an error.
//
// Anything absent is absent on purpose: calling a method this double does not
// implement fails loudly instead of silently returning a plausible default.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A tool definition as the host received it, kept loose on purpose: the point
 *  is to inspect fields a test cares about, not to re-validate pi's schema. */
export type FakeToolDefinition = Record<string, unknown> & { name: string };
export type FakeCommandDefinition = Record<string, unknown>;
export type FakeShortcutDefinition = Record<string, unknown>;
export type FakeFlagDefinition = { type: "boolean" | "string"; default?: unknown; description?: string };

/** One `pi.sendMessage()` call: the message, and the options it carried. */
export interface FakeMessage {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

/** One `pi.appendEntry()` call: the custom type, and its data. */
export interface FakeAppendedEntry {
	customType: string;
	data: unknown;
}

export interface FakeToolResult {
	content: { type: string; text?: string }[];
	details?: unknown;
}

export interface FakeHostOptions {
	/** Session identity a factory reads to reconstruct state. */
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	/** The active branch, as `sessionManager.getBranch()` returns it. Use it to
	 *  seed state an extension reconstructs from the session log. */
	branch?: readonly Record<string, unknown>[];
	/** Default false, like pi's print and JSON modes: a factory that guards on
	 *  this must be testable in its headless behaviour. */
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	/** Whether a message is already queued, as `ctx.hasPendingMessages()` reports. */
	pendingMessages?: boolean;
	/** Handed to tools and handlers as `ctx.signal`. */
	signal?: AbortSignal;
}

export interface FakeHost {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	handlers: Map<string, ((payload: Record<string, unknown>, ctx: ExtensionContext) => unknown)[]>;
	/** Dispatch one event; see the note on the returned value in `createFakeHost`. */
	fire(event: string, payload?: Record<string, unknown>): Promise<unknown>;
	tools: Map<string, FakeToolDefinition>;
	toolOrder: string[];
	commands: Map<string, FakeCommandDefinition>;
	commandOrder: string[];
	shortcuts: Map<string, FakeShortcutDefinition>;
	shortcutOrder: string[];
	flags: Map<string, FakeFlagDefinition>;
	flagOrder: string[];
	messages: FakeMessage[];
	appended: FakeAppendedEntry[];
	/** Every `pi.events.emit` call, in order. */
	emitted: { channel: string; data: unknown }[];
	notifications: { message: string; type: string | undefined }[];
	statuses: { key: string; text: string | undefined }[];
	widgets: { key: string; content: unknown; options: unknown }[];
	/** Run a registered tool's `execute()` with the host's context. */
	callTool(name: string, params?: Record<string, unknown>): Promise<FakeToolResult>;
	/** Run a registered command's handler, as `/name args` would. */
	runCommand(name: string, args?: string): Promise<void>;
}

type Handler = (payload: Record<string, unknown>, ctx: ExtensionContext) => unknown;

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
	const sessionId = options.sessionId ?? "fake-session";
	const sessionFile = options.sessionFile ?? `/tmp/${sessionId}.jsonl`;
	const cwd = options.cwd ?? process.cwd();
	const branch = options.branch ?? [];
	const pendingMessages = options.pendingMessages ?? false;
	const hasUI = options.hasUI ?? false;

	const tools = new Map<string, FakeToolDefinition>();
	const toolOrder: string[] = [];
	const commands = new Map<string, FakeCommandDefinition>();
	const commandOrder: string[] = [];
	const shortcuts = new Map<string, FakeShortcutDefinition>();
	const shortcutOrder: string[] = [];
	const flags = new Map<string, FakeFlagDefinition>();
	const flagOrder: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const messages: FakeMessage[] = [];
	const appended: FakeAppendedEntry[] = [];
	const emitted: { channel: string; data: unknown }[] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	const widgets: { key: string; content: unknown; options: unknown }[] = [];

	// Whether a low-level agent run is in progress, as pi's internal flag would be.
	let runActive = false;

	const sessionManager = {
		getSessionId: () => sessionId,
		getSessionFile: () => sessionFile,
		getCwd: () => cwd,
		// A deep copy each call: a factory that mutates an entry cannot change the
		// branch the next assertion or the next dispatch reads.
		getBranch: () => structuredClone(branch) as Record<string, unknown>[],
	};

	const ctx = {
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			setWidget: (key: string, content: unknown, widgetOptions?: unknown) => {
				widgets.push({ key, content, options: widgetOptions });
			},
			setTitle: () => undefined,
			setEditorText: () => undefined,
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
			editor: async () => undefined,
			custom: async () => undefined,
		},
		// pi pairs a UI with `tui` and no UI with print/json, so the default
		// follows `hasUI` rather than producing a combination pi never shows.
		mode: options.mode ?? (hasUI ? "tui" : "print"),
		hasUI,
		cwd,
		sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		// `agent_end` fires while the run is still active (pi clears the flag in the
		// run driver's `finally`, after the handlers), so a factory that asks
		// `isIdle()` there must see false. `fire()` toggles this around those two
		// events; other run events are not modelled.
		isIdle: () => !runActive,
		hasPendingMessages: () => pendingMessages,
		signal: options.signal,
	} as unknown as ExtensionContext;

	const pi = {
		// The orchestration event bus, recorded. Tests that need subscriber
		// behaviour drive a local EventBus instead; this double is enough to see
		// that an emitter published.
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
			},
			on: (_channel: string, _handler: (data: unknown) => void) => () => {},
		},
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			// Mirrors pi: the returned function removes only this registration.
			return () => {
				const current = handlers.get(event);
				if (!current) return;
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
		sendMessage: (message: Record<string, unknown>, messageOptions?: Record<string, unknown>) => {
			messages.push({ message, options: messageOptions });
		},
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
		registerFlag: (name: string, flagOptions: FakeFlagDefinition) => {
			flags.set(name, flagOptions);
			flagOrder.push(name);
		},
		registerTool: (tool: FakeToolDefinition) => {
			tools.set(tool.name, tool);
			toolOrder.push(tool.name);
		},
		registerCommand: (name: string, commandOptions: FakeCommandDefinition) => {
			commands.set(name, commandOptions);
			commandOrder.push(name);
		},
		registerShortcut: (shortcut: string, shortcutOptions: FakeShortcutDefinition) => {
			shortcuts.set(shortcut, shortcutOptions);
			shortcutOrder.push(shortcut);
		},
	};

	/**
	 * Dispatch one event. Every handler receives the same event object, so an
	 * in-place mutation is visible to the next handler; the last non-undefined
	 * result is returned, which is pi's "last override" semantics.
	 *
	 * The event object is built per dispatch from `payload`, so two runs never
	 * share mutations.
	 */
	const fire = async (event: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
		const body: Record<string, unknown> = { type: event, ...payload };
		if (event === "agent_start") runActive = true;
		let result: unknown;
		// A snapshot, because pi documents that adding or removing a handler does
		// not affect a dispatch already in progress.
		for (const handler of [...(handlers.get(event) ?? [])]) {
			const value = await handler(body, ctx);
			if (value !== undefined) result = value;
		}
		// The run is still active inside `agent_end`; pi clears its flag afterwards.
		if (event === "agent_end") runActive = false;
		return result;
	};

	const toolContext = {
		...ctx,
		tools: [],
		executeTool: async () => {
			throw new Error("fake host: executeTool is not modelled");
		},
	};

	const callTool = async (name: string, params: Record<string, unknown> = {}): Promise<FakeToolResult> => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`fake host: no tool registered as "${name}"`);
		const execute = tool.execute;
		if (typeof execute !== "function") throw new Error(`fake host: tool "${name}" has no execute()`);
		return (await (execute as (
			toolCallId: string,
			toolParams: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<FakeToolResult>)("fake-call", params, options.signal, undefined, toolContext));
	};

	const runCommand = async (name: string, args = ""): Promise<void> => {
		const command = commands.get(name);
		if (!command) throw new Error(`fake host: no command registered as "${name}"`);
		const handler = command.handler;
		if (typeof handler !== "function") throw new Error(`fake host: command "${name}" has no handler()`);
		await (handler as (commandArgs: string, commandCtx: unknown) => Promise<void>)(args, ctx);
	};

	return {
		pi: pi as unknown as ExtensionAPI,
		ctx,
		handlers,
		fire,
		tools,
		toolOrder,
		commands,
		commandOrder,
		shortcuts,
		shortcutOrder,
		flags,
		flagOrder,
		messages,
		appended,
		emitted,
		notifications,
		statuses,
		widgets,
		callTool,
		runCommand,
	};
}
