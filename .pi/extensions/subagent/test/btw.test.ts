// Behaviour tests for the /btw panel.
//
// Risk covered: `/btw` resets the panel, starts the `less +F` viewer, and runs
// the in-process request into `answer.md`. These tests pin the tmux call order
// (kill-server -> new-session -> remain-on-exit -> type viewer -> Enter), the
// popup ladder and argv, reattach without a new request, the answer file and
// usage footer, the guard ladder that must not touch tmux, and the
// replace-aborts-the-old-request ordering.
//
// tmux, the model registry and the popup launcher are injected, so no test
// spawns anything. The agent directory is a temp dir, and launch tests clear
// TMUX so an ambient tmux cannot change the ladder.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { __test__, launchBtwPanel, reattachBtwPanel, type BtwContext } from "../../btw/index.ts";
import { buildBtwPaths, buildBtwViewerCommand } from "../../btw/launch.ts";
import { buildBtwContext } from "../../btw/request.ts";
import { withEnv, withTempAgentDir, waitFor } from "./helpers.ts";

const SID = "01a14e96-1111-7000-8000-000000000001";
const OUTER_SOCKET = "/tmp/outer.sock";
const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "opencode-go",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as AssistantMessage;
}

const ENTRIES = [
	{
		type: "message",
		id: "s1",
		parentId: null,
		timestamp: "2026-10-18T00:00:00.000Z",
		message: {
			role: "system",
			content: "",
			sections: { preamble: "SYS" },
			toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
			timestamp: 0,
		},
	},
	{
		type: "message",
		id: "u1",
		parentId: "s1",
		timestamp: "2026-10-18T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-10-18T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "opencode-go",
			model: "test-model",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 2,
		},
	},
] as unknown as SessionEntry[];

function fakeContext(modelRegistry: unknown, overrides: Partial<BtwContext> = {}): BtwContext {
	return {
		mode: "tui",
		cwd: "/work/project",
		model: { provider: "opencode-go", id: "test-model" },
		modelRegistry: modelRegistry as never,
		sessionManager: {
			getSessionId: () => SID,
			getEntries: () => ENTRIES,
			getLeafId: () => "a1",
		},
		...overrides,
	};
}

interface ExecCall {
	command: string;
	args: string[];
}

interface TmuxOptions {
	failOn?: string;
	serverUp?: boolean;
	paneDead?: boolean;
}

/** A tmux model: kill-server takes the server down, new-session brings it back. */
function tmuxModel(options: TmuxOptions = {}) {
	const calls: ExecCall[] = [];
	let serverUp = options.serverUp === true;
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		const ok = { code: 0, stdout: "", stderr: "", killed: false };
		if (options.failOn !== undefined && args.includes(options.failOn)) {
			return { code: 1, stdout: "", stderr: `${options.failOn} failed`, killed: false };
		}
		if (args.includes("new-session")) {
			serverUp = true;
			return ok;
		}
		if (args.includes("kill-server")) {
			serverUp = false;
			return ok;
		}
		if (args.includes("has-session")) return serverUp ? ok : { code: 1, stdout: "", stderr: "no server", killed: false };
		if (args.includes("list-clients")) return { ...ok, stdout: "/dev/pts/7\t@1\t100\n" };
		if (args.includes("#{pane_dead}")) return { ...ok, stdout: options.paneDead === true ? "1\n" : "0\n" };
		if (args.includes("display-message")) return { ...ok, stdout: "@1\n" };
		return ok;
	};
	return { calls, exec };
}

function fakeDeps(agentDir: string, tmux = tmuxModel()) {
	const launches: {
		command: string;
		args: string[];
		options: { detached: boolean; stdio: string };
		onError: (message: string) => void;
	}[] = [];
	const notifications: { message: string; type: string }[] = [];
	return {
		calls: tmux.calls,
		launches,
		notifications,
		deps: {
			exec: tmux.exec,
			notify: (message: string, type: "info" | "warning" | "error" = "info") => notifications.push({ message, type }),
			launch: (command: string, args: string[], options: { detached: true; stdio: "ignore" }, onError: (message: string) => void) => {
				launches.push({ command, args, options, onError });
			},
			agentDir,
			isPidAlive: () => true,
		},
	};
}

/** A registry that answers immediately with one delta and a final usage. */
function streamingRegistry(text: string, usage: Usage = ZERO_USAGE) {
	const calls: { context: Context; options: Record<string, unknown> }[] = [];
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		streamSimple: (_model: unknown, context: Context, options: Record<string, unknown>) => {
			calls.push({ context, options });
			const stream = createAssistantMessageEventStream();
			if (text.length > 0) {
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: assistant() });
			}
			stream.push({
				type: "done",
				reason: "stop",
				message: assistant({ content: text ? [{ type: "text", text }] : [], usage }),
			});
			return stream;
		},
	};
	return { calls, modelRegistry };
}

/** A registry whose streams stay open until aborted, for replace tests. */
function controllableRegistry() {
	const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
	const calls: { context: Context; options: Record<string, unknown> }[] = [];
	const modelRegistry = {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
		streamSimple: (_model: unknown, context: Context, options: Record<string, unknown>) => {
			calls.push({ context, options });
			const stream = createAssistantMessageEventStream();
			streams.push(stream);
			(options["signal"] as AbortSignal | undefined)?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: assistant({ stopReason: "aborted" }) });
			});
			return stream;
		},
	};
	return { calls, streams, modelRegistry };
}

function withNoTmux<T>(fn: () => Promise<T>): Promise<T> {
	return withEnv({ TMUX: undefined, TMUX_PANE: undefined }, fn);
}

function withOuterTmux<T>(fn: () => Promise<T>): Promise<T> {
	return withEnv({ TMUX: `${OUTER_SOCKET},1,0`, TMUX_PANE: "%1" }, fn);
}

type Handler = (args: string, ctx: unknown) => Promise<void>;

async function loadFactory(exec: (command: string, args: string[]) => Promise<unknown>, on?: (name: string, handler: unknown) => void) {
	let handler: Handler | undefined;
	const factory = (await import("../../btw/index.ts")).default;
	factory({
		registerCommand: (_name: string, spec: { handler: Handler }) => {
			handler = spec.handler;
		},
		on: on ?? (() => undefined),
		exec,
	} as never);
	assert.ok(handler, "the factory must register a command");
	return handler;
}

test("a question resets the panel, starts the viewer and streams the answer", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { calls, launches, notifications, deps } = fakeDeps(agentDir);
			const registry = streamingRegistry("Hello", { ...ZERO_USAGE, input: 10, cacheRead: 500, output: 3, totalTokens: 513 });
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.ok(launch, "the panel starts");
			await launch.completion;

			const paths = buildBtwPaths(agentDir, SID);
			assert.equal(readFileSync(paths.answer, "utf8"), "# /btw\n\n> why?\n\nHello\n\n---\ninput 10 · cache read 500 · output 3\n");
			assert.equal(readFileSync(paths.ownerPid, "utf8"), `${process.pid}\n`);
			assert.equal(statSync(paths.answer).mode & 0o077, 0, "the answer is owner-only");
			assert.equal(statSync(paths.runDir).mode & 0o077, 0, "the scratch dir is owner-only");

			assert.deepEqual(
				calls.slice(0, 5).map((call) => call.args.join(" ")),
				[
					`-S ${paths.socket} kill-server`,
					`-S ${paths.socket} new-session -d -s ${paths.session} -n btw -c /work/project`,
					`-S ${paths.socket} set-window-option -t ${paths.session} remain-on-exit on`,
					`-S ${paths.socket} send-keys -t ${paths.target} -l -- ${buildBtwViewerCommand(paths.answer)}`,
					`-S ${paths.socket} send-keys -t ${paths.target} Enter`,
				],
			);
			assert.equal(launches.length, 0, "no popup outside tmux");
			assert.match(notifications.at(-1)?.message ?? "", /Attach with: .*attach -t/);

			assert.equal(registry.calls.length, 1);
			const sent = registry.calls[0] as { context: Context; options: Record<string, unknown> };
			assert.equal(sent.options["toolChoice"], "none");
			assert.deepEqual(
				sent.context.messages.slice(0, -1),
				buildBtwContext(ENTRIES, "a1", "why?").messages.slice(0, -1),
				"the prefix is the converted projection",
			);
			assert.ok(JSON.stringify(sent.context.messages.at(-1)).includes("why?"));
		});
	});
});

test("the popup opens over pi's client with the btw title and a fresh bind", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { calls, launches, deps } = fakeDeps(agentDir);
			const registry = streamingRegistry("ok");
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.ok(launch);
			await launch.completion;

			const paths = buildBtwPaths(agentDir, SID);
			assert.deepEqual(
				calls.slice(5).map((call) => call.args.join(" ")),
				[
					`-S ${OUTER_SOCKET} display-message -p -t %1 #{window_id}`,
					`-S ${OUTER_SOCKET} list-clients -F #{client_tty}\t#{window_id}\t#{client_activity}`,
					`-S ${paths.socket} has-session -t ${paths.session}`,
					`-S ${paths.socket} bind -n Escape detach-client`,
				],
			);
			assert.equal(launches.length, 1);
			const launched = launches[0] as (typeof launches)[number];
			const titleAt = launched.args.indexOf("-T");
			assert.equal(launched.args[titleAt + 1], "btw 01a14e96");
			assert.ok(launched.args.includes("/dev/pts/7"));
			assert.deepEqual(launched.options, { detached: true, stdio: "ignore" });
		});
	});
});

test("the guards notify without touching tmux or the disk", async () => {
	await withTempAgentDir(async (agentDir) => {
		const cases: { label: string; ctx: BtwContext; question: string; pattern: RegExp }[] = [
			{ label: "non-TUI", ctx: fakeContext({}, { mode: "rpc" }), question: "why?", pattern: /TUI/ },
			{ label: "no model", ctx: fakeContext({}, { model: undefined }), question: "why?", pattern: /selected model/ },
			{ label: "empty question", ctx: fakeContext({}), question: "   ", pattern: /cannot be empty/ },
		];
		for (const item of cases) {
			const { calls, notifications, deps } = fakeDeps(agentDir);
			const launch = await launchBtwPanel(deps, item.ctx, item.question);
			assert.equal(launch, null, item.label);
			assert.deepEqual(calls, [], `${item.label}: no tmux call`);
			assert.match(notifications[0]?.message ?? "", item.pattern, item.label);
		}
		assert.equal(existsSync(buildBtwPaths(agentDir, SID).runDir), false, "no scratch dir was created");
	});
});

test("a failed viewer start removes the scratch dir and reports the reason", async () => {
	await withTempAgentDir(async (agentDir) => {
		const { notifications, deps } = fakeDeps(agentDir, tmuxModel({ failOn: "new-session" }));
		const registry = streamingRegistry("never");
		const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
		assert.equal(launch, null);
		assert.equal(existsSync(buildBtwPaths(agentDir, SID).runDir), false);
		assert.match(notifications.at(-1)?.message ?? "", /Could not create the BTW tmux session: new-session failed/);
		assert.equal(registry.calls.length, 0, "the request never starts");
	});
});

test("a live panel is reattached without a new request; the bind is re-applied", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const paths = buildBtwPaths(agentDir, SID);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			const { calls, launches, deps } = fakeDeps(agentDir, tmuxModel({ serverUp: true }));
			const reused = await reattachBtwPanel(deps, fakeContext({}));
			assert.equal(reused, true);
			assert.ok(!calls.some((call) => call.args.includes("new-session")), "nothing is re-created");
			assert.ok(
				calls.some((call) => call.args.join(" ") === `-S ${paths.socket} bind -n Escape detach-client`),
				"the bind targets the panel socket",
			);
			assert.equal(launches.length, 1);
		});
	});
});

test("a dead viewer is restarted on the existing answer file", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const paths = buildBtwPaths(agentDir, SID);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			const { calls, launches, deps } = fakeDeps(agentDir, tmuxModel({ serverUp: true, paneDead: true }));
			const reused = await reattachBtwPanel(deps, fakeContext({}));
			assert.equal(reused, true);
			assert.ok(calls.some((call) => call.args.includes("new-session")), "the viewer is restarted");
			assert.equal(launches.length, 1);
			assert.deepEqual(calls.filter((call) => call.args.includes("send-keys"))[1]?.args.join(" "), `-S ${paths.socket} send-keys -t ${paths.target} Enter`);
		});
	});
});

test("a missing session with an answer restarts the viewer; without one it reports nothing to reuse", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const paths = buildBtwPaths(agentDir, SID);
			const withoutAnswer = await reattachBtwPanel(fakeDeps(agentDir, tmuxModel()).deps, fakeContext({}));
			assert.equal(withoutAnswer, false);
			assert.equal(existsSync(paths.runDir), false);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			const { calls, launches, deps } = fakeDeps(agentDir, tmuxModel());
			const reused = await reattachBtwPanel(deps, fakeContext({}));
			assert.equal(reused, true);
			assert.ok(calls.some((call) => call.args.includes("new-session")));
			assert.equal(launches.length, 1);
		});
	});
});

test("a second /btw aborts the running request before resetting the answer", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { streams, modelRegistry } = controllableRegistry();
			const { calls, exec } = tmuxModel();
			const handler = await loadFactory(exec);
			const ctx = {
				...fakeContext(modelRegistry),
				ui: { input: async () => "x", notify: () => undefined },
			};

			await handler("q1", ctx as never);
			await waitFor(() => streams.length === 1);
			await handler("q2", ctx as never);
			await waitFor(() => streams.length === 2);

			assert.equal(streams.length, 2, "the second question starts its own request");
			assert.equal(calls.filter((call) => call.args.includes("new-session")).length, 2, "the viewer is restarted");
			const paths = buildBtwPaths(agentDir, SID);
			assert.match(readFileSync(paths.answer, "utf8"), /^# \/btw\n\n> q2\n\n/);

			// Finish the second request so the test leaves nothing pending.
			streams[1]?.push({ type: "text_delta", contentIndex: 0, delta: "a2", partial: assistant() });
			streams[1]?.push({
				type: "done",
				reason: "stop",
				message: assistant({ content: [{ type: "text", text: "a2" }], usage: ZERO_USAGE }),
			});
			await waitFor(() => readFileSync(paths.answer, "utf8").includes("a2"));
		});
	});
});

test("the factory registers the session lifecycle handlers", async () => {
	await withTempAgentDir(async () => {
		const events = new Map<string, unknown>();
		const factory = (await import("../../btw/index.ts")).default;
		factory({
			registerCommand: () => undefined,
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			on: (name: string, handler: unknown) => {
				events.set(name, handler);
			},
		} as never);
		assert.equal(typeof events.get("session_start"), "function");
		assert.equal(typeof events.get("session_shutdown"), "function");
	});
});

test("the factory reattaches on an empty argument list instead of prompting", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { exec } = tmuxModel({ serverUp: true });
			const paths = buildBtwPaths(agentDir, SID);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			const handler = await loadFactory(exec);
			let prompted = false;
			const launches: string[][] = [];
			__test__.setPanelLauncher((_command, args) => {
				launches.push(args);
			});
			try {
				const ctx = {
					...fakeContext({}),
					ui: {
						input: async () => {
							prompted = true;
							return "why?";
						},
						notify: () => undefined,
					},
				};
				await handler("", ctx as never);
				assert.equal(prompted, false, "a live panel needs no question");
				assert.equal(launches.length, 1);
			} finally {
				__test__.setPanelLauncher(undefined);
			}
		});
	});
});

test("the factory refuses non-TUI before prompting or executing", async () => {
	await withTempAgentDir(async () => {
		await withNoTmux(async () => {
			let prompted = false;
			const { calls, exec } = tmuxModel();
			const handler = await loadFactory(exec);
			const notifications: string[] = [];
			const ctx = {
				...fakeContext({}, { mode: "rpc" }),
				ui: {
					input: async () => {
						prompted = true;
						return "why?";
					},
					notify: (message: string) => notifications.push(message),
				},
			};
			await handler("why?", ctx as never);
			assert.equal(prompted, false);
			assert.deepEqual(calls, []);
			assert.match(notifications[0] ?? "", /TUI/);
		});
	});
});
