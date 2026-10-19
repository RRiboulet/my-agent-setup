// Behaviour tests for the /btw panel.
//
// Risk covered: `/btw` resets the panel, starts the `tail -F` viewer, and runs
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

import { __test__, formatBtwUsage, launchBtwPanel, reattachBtwPanel, type BtwContext } from "../../btw/index.ts";
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
	/** The outer pane's `display-message` resolves no window. */
	paneGone?: boolean;
	/** `list-clients` lists nothing. */
	noClient?: boolean;
}

/** A tmux model: kill-server takes the server down, new-session brings it back. */
function tmuxModel(options: TmuxOptions = {}) {
	const calls: ExecCall[] = [];
	let serverUp = options.serverUp === true;
	let sessionExists = options.serverUp === true;
	const exec = async (command: string, args: string[]) => {
		calls.push({ command, args });
		const ok = { code: 0, stdout: "", stderr: "", killed: false };
		if (options.failOn !== undefined && args.includes(options.failOn)) {
			return { code: 1, stdout: "", stderr: `${options.failOn} failed`, killed: false };
		}
		if (args.includes("new-session")) {
			// Real tmux refuses a duplicate name; a dead pane keeps its session.
			if (sessionExists) return { code: 1, stdout: "", stderr: "duplicate session", killed: false };
			serverUp = true;
			sessionExists = true;
			return ok;
		}
		if (args.includes("kill-server")) {
			serverUp = false;
			sessionExists = false;
			return ok;
		}
		if (args.includes("has-session")) {
			return serverUp && sessionExists ? ok : { code: 1, stdout: "", stderr: "no server", killed: false };
		}
		if (args.includes("list-clients")) {
			return options.noClient === true ? { ...ok, stdout: "" } : { ...ok, stdout: "/dev/pts/7\t@1\t100\n" };
		}
		if (args.includes("#{pane_dead}")) return { ...ok, stdout: options.paneDead === true ? "1\n" : "0\n" };
		if (args.includes("display-message")) {
			return options.paneGone === true
				? { code: 1, stdout: "", stderr: "can't find pane", killed: false }
				: { ...ok, stdout: "@1\n" };
		}
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
			blockImages: false,
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
		getSettings: () => ({ images: { blockImages: false } }),
		getThinkingLevel: () => "high",
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
			assert.equal(sent.options["toolChoice"], undefined, "tool_choice would invalidate the message cache");
			assert.equal(sent.options["sessionId"], SID, "session affinity uses the main session id");
			const headers = sent.options["headers"] as Record<string, string>;
			assert.equal(headers["x-opencode-session"], SID, "the request carries the main session id");
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

test("the popup reports a vanished pane, no client and a failed bind", async () => {
	await withTempAgentDir(async (agentDir) => {
		const cases: { label: string; tmux: ReturnType<typeof tmuxModel>; pattern: RegExp }[] = [
			{ label: "pane gone", tmux: tmuxModel({ paneGone: true }), pattern: /pane is gone/ },
			{ label: "no client", tmux: tmuxModel({ noClient: true }), pattern: /No attached tmux client/ },
			{ label: "bind failed", tmux: tmuxModel({ failOn: "bind" }), pattern: /Escape binding/ },
		];
		for (const item of cases) {
			await withOuterTmux(async () => {
				const { notifications, deps } = fakeDeps(agentDir, item.tmux);
				const registry = streamingRegistry("ok");
				const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
				assert.ok(launch, `${item.label}: the request still runs`);
				await launch.completion;
				assert.match(notifications.map((entry) => entry.message).join("\n"), item.pattern, item.label);
			});
		}
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
			const questions = ["q1", "q2"];
			const ctx = {
				...fakeContext(modelRegistry),
				ui: { input: async () => questions.shift() ?? "x", notify: () => undefined },
			};

			await handler("", ctx as never);
			await waitFor(() => streams.length === 1);
			streams[0]?.push({ type: "text_delta", contentIndex: 0, delta: "old-answer", partial: assistant() });
			await handler("", ctx as never);
			await waitFor(() => streams.length === 2);

			assert.equal(streams.length, 2, "the second question starts its own request");
			assert.equal(calls.filter((call) => call.args.includes("new-session")).length, 2, "the viewer is restarted");
			const paths = buildBtwPaths(agentDir, SID);
			assert.match(readFileSync(paths.answer, "utf8"), /^# \/btw\n\n> q2\n\n/);
			assert.ok(
				!readFileSync(paths.answer, "utf8").includes("old-answer"),
				"the aborted request's deltas never land in the new answer file",
			);

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

test("a multi-line question is quoted line by line in the header", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { deps } = fakeDeps(agentDir);
			const registry = streamingRegistry("ok");
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "line one\nline two");
			assert.ok(launch);
			await launch.completion;
			const answer = readFileSync(buildBtwPaths(agentDir, SID).answer, "utf8");
			assert.match(answer, /^# \/btw\n\n> line one\n> line two\n\n/);
		});
	});
});

test("an answer that reads no cache warns instead of failing quietly", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir);
			const registry = streamingRegistry("Hello", {
				...ZERO_USAGE,
				input: 812_345,
				cacheRead: 0,
				output: 3,
				totalTokens: 812_348,
			});
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.ok(launch);
			await launch.completion;
			assert.match(
				notifications.at(-1)?.message ?? "",
				/0 cached tokens read/,
				"a zero cache read is loud in the TUI, not just absent from the footer",
			);
		});
	});
});

test("a small cold start does not warn about a zero cache read", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir);
			const registry = streamingRegistry("Hello", {
				...ZERO_USAGE,
				input: 4_000,
				cacheRead: 0,
				output: 3,
				totalTokens: 4_003,
			});
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.ok(launch);
			await launch.completion;
			assert.ok(
				!notifications.some((n) => /0 cached tokens read/.test(n.message)),
				"a short cold start is not warned; the footer's input already shows the size",
			);
		});
	});
});

test("a sibling reset under a streaming answer stops the write instead of interleaving", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { deps } = fakeDeps(agentDir);
			const paths = buildBtwPaths(agentDir, SID);
			let pushSecond: (() => void) | undefined;
			const modelRegistry = {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
				streamSimple: (_model: unknown, _context: Context, options: Record<string, unknown>) => {
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "text_delta", contentIndex: 0, delta: "first-", partial: assistant() });
					pushSecond = () => {
						stream.push({ type: "text_delta", contentIndex: 0, delta: "second-", partial: assistant() });
					};
					(options["signal"] as AbortSignal | undefined)?.addEventListener("abort", () => {
						stream.push({ type: "error", reason: "aborted", error: assistant({ stopReason: "aborted" }) });
					});
					return stream;
				},
			};
			const launch = await launchBtwPanel(deps, fakeContext(modelRegistry), "why?");
			assert.ok(launch);
			await waitFor(() => readFileSync(paths.answer, "utf8").includes("first-"));
			// a second pi on this session id resets the run dir under us
			await writeFile(paths.ownerPid, `${process.pid + 1}\n`);
			pushSecond?.();
			await launch.completion;
			const answer = readFileSync(paths.answer, "utf8");
			assert.ok(answer.includes("first-"), "the delta this process owned is kept");
			assert.ok(!answer.includes("second-"), "the sibling's answer is not interleaved into ours");
		});
	});
});

test("a provider error lands in the answer footer with its usage", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir);
			const modelRegistry = {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
				streamSimple: () => {
					const stream = createAssistantMessageEventStream();
					stream.push({
						type: "error",
						reason: "error",
						error: assistant({
							stopReason: "error",
							errorMessage: "boom",
							usage: { ...ZERO_USAGE, input: 5, cacheRead: 700, output: 1, totalTokens: 706 },
						}),
					});
					return stream;
				},
			};
			const launch = await launchBtwPanel(deps, fakeContext(modelRegistry), "why?");
			assert.ok(launch);
			await launch.completion;
			const answer = readFileSync(buildBtwPaths(agentDir, SID).answer, "utf8");
			assert.match(answer, /error: boom · input 5 · cache read 700 · output 1/);
			assert.match(notifications.at(-1)?.message ?? "", /BTW: boom/);
		});
	});
});

test("a viewer start that fails after new-session cleans up and reports", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir, tmuxModel({ failOn: "send-keys" }));
			const registry = streamingRegistry("never");
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.equal(launch, null);
			assert.equal(existsSync(buildBtwPaths(agentDir, SID).runDir), false);
			assert.match(notifications.at(-1)?.message ?? "", /Could not start the BTW viewer/);
			assert.equal(registry.calls.length, 0, "the request never starts");
		});
	});
});

test("a replace that cannot close the old server keeps the old answer and reports it", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const paths = buildBtwPaths(agentDir, SID);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			// The server is up and kill-server fails, so the panel may still be live.
			const { notifications, deps } = fakeDeps(agentDir, tmuxModel({ serverUp: true, failOn: "kill-server" }));
			const registry = streamingRegistry("never");
			const launch = await launchBtwPanel(deps, fakeContext(registry.modelRegistry), "why?");
			assert.equal(launch, null, "the replace is refused");
			assert.equal(readFileSync(paths.answer, "utf8"), "# old\n", "the old answer is not unlinked under a live viewer");
			assert.match(notifications.at(-1)?.message ?? "", /still running/);
			assert.equal(registry.calls.length, 0, "the request never starts");
		});
	});
});

test("the blockImages setting reaches the side request", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { deps } = fakeDeps(agentDir);
			deps.blockImages = true;
			const registry = streamingRegistry("ok");
			const imageEntries = [
				...ENTRIES.slice(0, 2),
				{
					type: "message",
					id: "i1",
					parentId: "a1",
					timestamp: "2026-10-18T00:00:03.000Z",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{ type: "image", mimeType: "image/png", data: "AAAA" },
						],
						timestamp: 3,
					},
				},
			] as unknown as SessionEntry[];
			const ctx = fakeContext(registry.modelRegistry, {
				sessionManager: {
					getSessionId: () => SID,
					getEntries: () => imageEntries,
					getLeafId: () => "i1",
				},
			});
			const launch = await launchBtwPanel(deps, ctx, "why?");
			assert.ok(launch);
			await launch.completion;
			const sent = registry.calls[0] as { context: Context };
			assert.ok(
				JSON.stringify(sent.context).includes("Image reading is disabled."),
				"the setting mirrors pi's image filter into the request",
			);
			assert.ok(!JSON.stringify(sent.context).includes('"type":"image"'));
		});
	});
});

test("an unreadable panel state is reported and never replaced", async () => {
	await withTempAgentDir(async (agentDir) => {
		const { launches, notifications, deps } = fakeDeps(agentDir);
		deps.exec = async (_command, args) => {
			if (args.includes("has-session")) throw new Error("probe failed");
			return { code: 0, stdout: "", stderr: "", killed: false };
		};
		const reused = await reattachBtwPanel(deps, fakeContext({}));
		assert.equal(reused, true, "an unreadable panel is not replaced");
		assert.equal(launches.length, 0);
		assert.match(notifications[0]?.message ?? "", /Could not check the BTW panel/);
	});
});

test("a second /btw while one is starting is refused", async () => {
	await withTempAgentDir(async () => {
		await withNoTmux(async () => {
			let reached!: () => void;
			const gateReached = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const calls: { args: string[] }[] = [];
			const exec = async (_command: string, args: string[]) => {
				calls.push({ args });
				if (args.includes("new-session")) {
					reached();
					await gate;
				}
				return { code: 0, stdout: "", stderr: "", killed: false };
			};
			const handler = await loadFactory(exec);
			const notifications: string[] = [];
			const ctx = {
				...fakeContext(streamingRegistry("x").modelRegistry),
				ui: { input: async () => "q", notify: (message: string) => notifications.push(message) },
			};

			const first = handler("", ctx as never);
			await gateReached;
			await handler("", ctx as never);
			assert.equal(
				calls.filter((call) => call.args.includes("new-session")).length,
				1,
				"only one setup proceeds",
			);
			assert.match(notifications.join("\n"), /still starting/);
			release();
			await first;
		});
	});
});

test("the factory refuses arguments and asks for the question instead", async () => {
	await withTempAgentDir(async () => {
		await withNoTmux(async () => {
			let prompted = false;
			const { calls, exec } = tmuxModel();
			const handler = await loadFactory(exec);
			const notifications: string[] = [];
			const ctx = {
				...fakeContext({}),
				ui: {
					input: async () => {
						prompted = true;
						return "why?";
					},
					notify: (message: string) => notifications.push(message),
				},
			};
			await handler("why did the test fail?", ctx as never);
			assert.equal(prompted, false, "arguments are not accepted as a question");
			assert.deepEqual(calls, [], "nothing is started");
			assert.match(notifications[0] ?? "", /takes no arguments/);
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
			getSettings: () => ({ images: { blockImages: false } }),
			getThinkingLevel: () => "high",
			on: (name: string, handler: unknown) => {
				events.set(name, handler);
			},
		} as never);
		assert.equal(typeof events.get("session_start"), "function");
		assert.equal(typeof events.get("session_shutdown"), "function");
	});
});

test("the factory reopens the panel when the question is submitted empty", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { exec } = tmuxModel({ serverUp: true });
			const paths = buildBtwPaths(agentDir, SID);
			await mkdir(paths.runDir, { recursive: true });
			await writeFile(paths.answer, "# old\n");
			const handler = await loadFactory(exec);
			let submitted = false;
			let title = "";
			const launches: string[][] = [];
			__test__.setPanelLauncher((_command, args) => {
				launches.push(args);
			});
			try {
				const ctx = {
					...fakeContext({}),
					ui: {
						input: async (prompt: string) => {
							submitted = true;
							title = prompt;
							return "";
						},
						notify: () => undefined,
					},
				};
				await handler("", ctx as never);
				assert.equal(submitted, true, "the panel always asks for a question first");
				assert.match(title, /reopen/, "the empty-submit contract is visible in the prompt itself");
				assert.equal(launches.length, 1, "empty input reopens the live panel");
			} finally {
				__test__.setPanelLauncher(undefined);
			}
		});
	});
});

test("the factory says so when an empty submission has nothing to reopen", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { calls, exec } = tmuxModel();
			const handler = await loadFactory(exec);
			const notifications: string[] = [];
			const ctx = {
				...fakeContext({}),
				ui: { input: async () => "", notify: (message: string) => notifications.push(message) },
			};
			await handler("", ctx as never);
			assert.ok(calls.some((call) => call.args.includes("has-session")), "the panel state is probed");
			assert.match(notifications.join("\n"), /No BTW panel is running/);
		});
	});
});

test("the factory does nothing when the question prompt is cancelled", async () => {
	await withTempAgentDir(async () => {
		await withNoTmux(async () => {
			const { calls, exec } = tmuxModel();
			const handler = await loadFactory(exec);
			const notifications: string[] = [];
			const ctx = {
				...fakeContext({}),
				ui: { input: async () => undefined, notify: (message: string) => notifications.push(message) },
			};
			await handler("", ctx as never);
			assert.deepEqual(calls, [], "nothing is started");
			assert.deepEqual(notifications, [], "a cancel is silent");
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

test("the usage footer names the cache read and the cache write", () => {
	const text = formatBtwUsage({
		input: 1354,
		output: 510,
		cacheRead: 591232,
		cacheWrite: 4096,
		totalTokens: 597192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	assert.match(text, /input 1,354/);
	assert.match(text, /cache read 591,232/);
	assert.match(text, /cache write 4,096/);
	assert.match(text, /output 510/);
	assert.equal(formatBtwUsage(undefined), "");
	assert.equal(formatBtwUsage({ ...ZERO_USAGE }), "input 0 · output 0", "a zero usage stays terse");
});
