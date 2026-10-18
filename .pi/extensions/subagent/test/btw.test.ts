// Behaviour tests for the /btw launch and popup.
//
// Risk covered: `/btw` forks the conversation, starts a separate pi process and
// then draws it over pi's client. These tests pin the tmux call order
// (kill -> create -> remain-on-exit -> type -> submit), the scratch files and
// their owner-only modes, the popup's client ladder and argv, the reattach
// path (re-open and re-bind, never re-fork), the dead-pane and non-tmux
// fallbacks, the guard ladder that must not touch tmux at all, and the failure
// path that removes what it wrote.
//
// tmux and pi are injected: `deps.exec` records calls and `deps.launch` records
// popups, so no test spawns anything. The agent directory is a temp dir from
// helpers.ts, never the real one, and every launch test clears TMUX so an
// ambient tmux cannot change the ladder. The expected tmux argv partly reuses
// the builders the code uses; `btw-launch.test.ts` pins those builders against
// literals, so this file is about order, guards and effects.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { __test__, launchBtwPanel, reattachBtwPanel, type BtwContext } from "../../btw/index.ts";
import {
	BTW_SIDE_PROMPT,
	buildBtwChildCommand,
	buildBtwChildPiArgs,
	btwForkPath,
	btwQuestionPath,
	btwRunDir,
	btwSessionName,
	btwSidePromptPath,
	btwSocketPath,
	btwTarget,
} from "../../btw/launch.ts";
import { getPiInvocationParts } from "../handoff.ts";
import { withEnv, withTempAgentDir } from "./helpers.ts";

const SID = "01a14e96-1111-7000-8000-000000000001";
const MAIN_FILE = `/home/x/.pi/agent/sessions/${SID}.jsonl`;
const EXTENSION_DIR = "/repo/.pi/extensions/btw";
const OUTER_SOCKET = "/tmp/outer.sock";
const BRANCH = [
	{
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-10-18T00:00:01.000Z",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	},
	{
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "2026-10-18T00:00:02.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
	},
];

function fakeContext(overrides: Partial<BtwContext> = {}): BtwContext {
	return {
		mode: "tui",
		cwd: "/work/project",
		model: { provider: "opencode-go", id: "glm-5.3-flash" },
		thinkingLevel: "max",
		sessionManager: {
			getSessionId: () => SID,
			getSessionFile: () => MAIN_FILE,
			getLeafId: () => "e2",
			getBranch: () => BRANCH,
		},
		...overrides,
	};
}

interface ExecCall {
	command: string;
	args: string[];
}

interface LaunchCall {
	command: string;
	args: string[];
	options: { detached: boolean; stdio: string };
	onError: (message: string) => void;
}

interface FakeOptions {
	/** Fail the first call whose argv contains this string. */
	failOn?: string;
	/** Throw from the first call whose argv contains this string. */
	throwOn?: string;
	/** Make has-session report a live panel. */
	sessionAlive?: boolean;
	/** Make the pane query report a dead child. */
	paneDead?: boolean;
	/** Make list-clients report nobody. */
	noClient?: boolean;
	/** Make the Escape bind fail. */
	bindFails?: boolean;
	/** Make the outer window-id probe report a missing pane. */
	paneGone?: boolean;
}

function fakeDeps(agentDir: string, options: FakeOptions = {}) {
	const calls: ExecCall[] = [];
	const launches: LaunchCall[] = [];
	const notifications: { message: string; type: string }[] = [];
	return {
		calls,
		launches,
		notifications,
		deps: {
			exec: async (command: string, args: string[]) => {
				calls.push({ command, args });
				if (options.throwOn !== undefined && args.includes(options.throwOn)) {
					throw new Error(`${options.throwOn} threw`);
				}
				if (options.failOn !== undefined && args.includes(options.failOn)) {
					return { code: 1, stdout: "", stderr: `${options.failOn} failed` };
				}
				if (args.includes("list-clients")) {
					return options.noClient
						? { code: 0, stdout: "", stderr: "" }
						: { code: 0, stdout: `/dev/pts/7\t@1\t100\n`, stderr: "" };
				}
				if (args.includes("#{pane_dead}")) {
					return { code: 0, stdout: options.paneDead ? "1\n" : "0\n", stderr: "" };
				}
				if (options.paneGone === true && args.includes("display-message")) {
					return { code: 1, stdout: "", stderr: "can't find pane" };
				}
				if (args.includes("display-message")) {
					return { code: 0, stdout: "@1\n", stderr: "" };
				}
				if (options.bindFails === true && args.includes("bind")) {
					return { code: 1, stdout: "", stderr: "bind failed" };
				}
				if (args.includes("has-session")) {
					return options.sessionAlive
						? { code: 0, stdout: "", stderr: "" }
						: { code: 1, stdout: "", stderr: "no server" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
			notify: (message: string, type: "info" | "warning" | "error" = "info") => notifications.push({ message, type }),
			launch: (command: string, args: string[], launchOptions: { detached: true; stdio: "ignore" }, onError: (message: string) => void) => {
				launches.push({ command, args, options: launchOptions, onError });
			},
			agentDir,
			extensionDir: EXTENSION_DIR,
		},
	};
}

/** Clear TMUX so the popup takes its not-running-inside-tmux branch. */
function withNoTmux<T>(fn: () => Promise<T>): Promise<T> {
	return withEnv({ TMUX: undefined, TMUX_PANE: undefined }, fn);
}

/** Set up an outer tmux client so the popup ladder can resolve one. */
function withOuterTmux<T>(fn: () => Promise<T>): Promise<T> {
	return withEnv({ TMUX: `${OUTER_SOCKET},1,0`, TMUX_PANE: "%1" }, fn);
}

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** Load the factory and capture its command handler over a supplied exec. */
async function loadFactory(
	exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<Handler> {
	let handler: Handler | undefined;
	const factory = (await import("../../btw/index.ts")).default;
	factory({
		registerCommand: (_name: string, spec: { handler: Handler }) => {
			handler = spec.handler;
		},
		exec,
	} as never);
	assert.ok(handler, "the factory must register a command");
	return handler;
}

test("a question forks the branch, writes the scratch files and launches the child in order", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { calls, launches, notifications, deps } = fakeDeps(agentDir);
			await launchBtwPanel(deps, fakeContext(), "why did the test fail?");

			const socket = btwSocketPath(agentDir, SID);
			const session = btwSessionName(SID);
			const target = btwTarget(SID);
			const fork = btwForkPath(agentDir, SID);
			const questionPath = btwQuestionPath(agentDir, SID);
			const sidePromptPath = btwSidePromptPath(agentDir, SID);
			const childArgs = buildBtwChildPiArgs({
				invocation: getPiInvocationParts(),
				provider: "opencode-go",
				model: "glm-5.3-flash",
				thinking: "max",
				sessionFile: fork,
				questionPath,
				sidePromptPath,
				btwDir: EXTENSION_DIR,
				name: session,
			});

			assert.deepEqual(calls.map((call) => call.args.join(" ")), [
				`-S ${socket} kill-session -t ${session}`,
				`-S ${socket} new-session -d -s ${session} -n btw -c /work/project`,
				`-S ${socket} set-window-option -t ${session} remain-on-exit on`,
				`-S ${socket} send-keys -t ${target} -l -- ${buildBtwChildCommand(childArgs)}`,
				`-S ${socket} send-keys -t ${target} Enter`,
			]);
			assert.deepEqual(new Set(calls.map((call) => call.command)), new Set(["tmux"]));
			assert.deepEqual(launches, [], "no popup outside tmux");

			assert.equal(readFileSync(questionPath, "utf8"), "why did the test fail?\n");
			assert.equal(readFileSync(sidePromptPath, "utf8"), `${BTW_SIDE_PROMPT}\n`);
			assert.equal(statSync(questionPath).mode & 0o077, 0, "the question is owner-only");
			assert.equal(statSync(sidePromptPath).mode & 0o077, 0, "the side prompt is owner-only");
			assert.equal(statSync(fork).mode & 0o077, 0, "the fork is owner-only");
			assert.equal(statSync(btwRunDir(agentDir, SID)).mode & 0o077, 0, "the scratch dir is owner-only");

			const lines = readFileSync(fork, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.equal(lines[0].parentSession, MAIN_FILE);
			assert.equal(lines[0].cwd, "/work/project");
			assert.deepEqual(
				lines.slice(1).map((entry) => entry.id),
				["e1", "e2"],
				"ancestors first, live leaf last",
			);
			assert.match(notifications.at(-1)?.message ?? "", /Attach with: .*attach -t/);
		});
	});
});

test("the popup opens over pi's client with the btw title and a fresh Escape bind", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { calls, launches, deps } = fakeDeps(agentDir, { sessionAlive: true });
			await launchBtwPanel(deps, fakeContext(), "why?");

			const socket = btwSocketPath(agentDir, SID);
			const session = btwSessionName(SID);
			assert.deepEqual(calls.slice(5).map((call) => call.args.join(" ")), [
				`-S ${OUTER_SOCKET} display-message -p -t %1 #{window_id}`,
				`-S ${OUTER_SOCKET} list-clients -F #{client_tty}\t#{window_id}\t#{client_activity}`,
				`-S ${socket} has-session -t ${session}`,
				`-S ${socket} bind -n Escape detach-client`,
			]);

			assert.equal(launches.length, 1);
			const launched = launches[0] as LaunchCall;
			assert.equal(launched.command, "tmux");
			assert.deepEqual(launched.options, { detached: true, stdio: "ignore" });
			const titleAt = launched.args.indexOf("-T");
			assert.equal(launched.args[titleAt + 1], "btw 01a14e96", "the popup title names the owner and the short id");
			assert.ok(launched.args.includes("/dev/pts/7"), "the popup is scoped to the client viewing pi");
			assert.ok(
				(launched.args[launched.args.length - 1] ?? "").includes(`tmux -S '${socket}' attach -t '${session}'`),
				"the popup command attaches to the panel session",
			);
		});
	});
});

test("a live session is reattached without re-forking, and the bind is re-applied", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { calls, launches, deps } = fakeDeps(agentDir, { sessionAlive: true });
			const reused = await reattachBtwPanel(deps, fakeContext());
			assert.equal(reused, true);
			const socket = btwSocketPath(agentDir, SID);
			assert.ok(!calls.some((call) => call.args.includes("new-session")), "nothing is re-created");
			assert.ok(!calls.some((call) => call.args.includes("kill-session")), "nothing is killed");
			assert.ok(
				calls.some((call) => call.args.join(" ") === `-S ${socket} bind -n Escape detach-client`),
				"the bind is re-applied to the panel socket",
			);
			assert.equal(launches.length, 1);
		});
	});
});

test("a dead pane is not reattached and says so", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { calls, launches, notifications, deps } = fakeDeps(agentDir, { sessionAlive: true, paneDead: true });
			const reused = await reattachBtwPanel(deps, fakeContext());
			assert.equal(reused, false);
			assert.equal(launches.length, 0);
			assert.match(notifications[0]?.message ?? "", /no longer running/);
		});
	});
});

test("a missing session is not reattached", async () => {
	await withTempAgentDir(async (agentDir) => {
		const { calls, launches, deps } = fakeDeps(agentDir);
		const reused = await reattachBtwPanel(deps, fakeContext());
		assert.equal(reused, false);
		assert.equal(launches.length, 0);
		assert.ok(calls.some((call) => call.args.includes("has-session")));
	});
});

test("a live session with no attached client falls back to the attach command", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { launches, notifications, deps } = fakeDeps(agentDir, { sessionAlive: true, noClient: true });
			const reused = await reattachBtwPanel(deps, fakeContext());
			assert.equal(reused, true, "a live panel is not replaced just because it cannot be shown");
			assert.equal(launches.length, 0);
			assert.match(notifications[0]?.message ?? "", /Attach with: .*attach -t/);
			assert.equal(notifications[0]?.type, "warning");
			assert.match(notifications.map((item) => item.message).join("\n"), /replaces it with a fresh one/);
		});
	});
});

test("a failed Escape bind falls back to the attach command", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { launches, notifications, deps } = fakeDeps(agentDir, { sessionAlive: true, bindFails: true });
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(launches.length, 0);
			assert.match(notifications.at(-1)?.message ?? "", /Could not set up the panel's Escape binding/);
		});
	});
});

test("a pane that disappears before the popup falls back to the attach command", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { launches, notifications, deps } = fakeDeps(agentDir, { sessionAlive: true, paneGone: true });
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(launches.length, 0);
			assert.match(notifications.at(-1)?.message ?? "", /That tmux pane is gone/);
		});
	});
});

test("a thrown reattach probe is reported and does not replace the panel", async () => {
	await withTempAgentDir(async (agentDir) => {
		const { launches, notifications, deps } = fakeDeps(agentDir, { throwOn: "has-session" });
		const reused = await reattachBtwPanel(deps, fakeContext());
		assert.equal(reused, true, "an unreadable panel is not replaced");
		assert.equal(launches.length, 0);
		assert.match(notifications[0]?.message ?? "", /Could not check the BTW panel: has-session threw/);
	});
});

test("the default launcher maps a spawn error to a message", async () => {
	const message = await new Promise<string>((resolve) => {
		__test__.defaultPanelLauncher("definitely-not-a-btw-binary", [], { detached: true, stdio: "ignore" }, resolve);
	});
	assert.match(message, /ENOENT|not found/i);
});

test("a popup spawn error is reported with the manual attach command", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withOuterTmux(async () => {
			const { launches, notifications, deps } = fakeDeps(agentDir, { sessionAlive: true });
			await launchBtwPanel(deps, fakeContext(), "why?");
			(launches[0] as LaunchCall).onError("tmux not found");
			assert.match(notifications.at(-1)?.message ?? "", /Could not open the panel: tmux not found/);
		});
	});
});

test("the guards notify without touching tmux or the disk", async () => {
	await withTempAgentDir(async (agentDir) => {
		const cases: { label: string; ctx: BtwContext; question: string; pattern: RegExp }[] = [
			{ label: "non-TUI", ctx: fakeContext({ mode: "rpc" }), question: "why?", pattern: /TUI/ },
			{ label: "no model", ctx: fakeContext({ model: undefined }), question: "why?", pattern: /selected model/ },
			{
				label: "no session file",
				ctx: fakeContext({
					sessionManager: { ...fakeContext().sessionManager, getSessionFile: () => undefined },
				}),
				question: "why?",
				pattern: /saved session/,
			},
			{ label: "empty question", ctx: fakeContext(), question: "   ", pattern: /cannot be empty/ },
		];
		for (const item of cases) {
			const { calls, notifications, deps } = fakeDeps(agentDir);
			await launchBtwPanel(deps, item.ctx, item.question);
			assert.deepEqual(calls, [], `${item.label}: no tmux call`);
			assert.match(notifications[0]?.message ?? "", item.pattern, item.label);
		}
		assert.equal(existsSync(btwRunDir(agentDir, SID)), false, "no scratch dir was created");
	});
});

test("an empty session still launches, with a warning that there is no context", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { calls, notifications, deps } = fakeDeps(agentDir);
			const empty = fakeContext({
				sessionManager: { ...fakeContext().sessionManager, getLeafId: () => null, getBranch: () => [] },
			});
			await launchBtwPanel(deps, empty, "why?");
			assert.ok(
				notifications.some((item) => /no messages yet/.test(item.message)),
				"the empty fork is announced",
			);
			assert.ok(
				calls.some((call) => call.args.includes("new-session")),
				"the panel still starts",
			);
			const lines = readFileSync(btwForkPath(agentDir, SID), "utf8").trim().split("\n");
			assert.equal(lines.length, 1, "the fork is header-only");
		});
	});
});

test("a second question kills the old session and removes its transcript", async () => {
	await withTempAgentDir(async (agentDir) => {
		const runDir = btwRunDir(agentDir, SID);
		await mkdir(runDir, { recursive: true });
		await writeFile(path.join(runDir, "stale.txt"), "stale");
		await withNoTmux(async () => {
			const { calls, deps } = fakeDeps(agentDir);
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(existsSync(path.join(runDir, "stale.txt")), false);
			assert.ok(calls[0]?.args.join(" ").includes("kill-session"), "the reset kills before creating");
		});
	});
});

test("a failed tmux launch removes the scratch dir and reports the reason", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir, { failOn: "new-session" });
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(existsSync(btwRunDir(agentDir, SID)), false);
			assert.match(
				notifications.at(-1)?.message ?? "",
				/Could not start the BTW panel .*: Could not create the BTW tmux session: new-session failed/,
			);
		});
	});
});

test("a send-keys failure also removes the scratch dir", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir, { failOn: "send-keys" });
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(existsSync(btwRunDir(agentDir, SID)), false);
			assert.match(notifications.at(-1)?.message ?? "", /Could not type the BTW command/);
		});
	});
});

test("a thrown exec is reported and cleaned up", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withNoTmux(async () => {
			const { notifications, deps } = fakeDeps(agentDir, { throwOn: "new-session" });
			await launchBtwPanel(deps, fakeContext(), "why?");
			assert.equal(existsSync(btwRunDir(agentDir, SID)), false);
			assert.match(notifications.at(-1)?.message ?? "", /new-session threw/);
		});
	});
});

test("the factory registers /btw and asks for a question when none is typed", async () => {
	await withTempAgentDir(async () => {
		await withNoTmux(async () => {
			const execCalls: string[][] = [];
			const handler = await loadFactory(async (_command, args) => {
				execCalls.push(args);
				// No panel exists yet: the reattach probe must miss so the prompt runs.
				if (args.includes("has-session")) return { code: 1, stdout: "", stderr: "no server" };
				return { code: 0, stdout: "", stderr: "" };
			});

			const notifications: string[] = [];
			const ctx = {
				...fakeContext(),
				ui: {
					input: async () => "what is this?",
					notify: (message: string) => notifications.push(message),
				},
			};
			await handler("", ctx as never);
			assert.ok(
				execCalls.some((args) => args.includes("new-session")),
				"the prompted question launches a panel",
			);

			const cancelCtx = { ...ctx, ui: { ...ctx.ui, input: async () => undefined } };
			await handler("", cancelCtx as never);
			assert.equal(
				execCalls.filter((args) => args.includes("new-session")).length,
				1,
				"a cancelled input launches nothing",
			);
		});
	});
});

test("the factory reattaches on an empty argument list instead of prompting", async () => {
	await withTempAgentDir(async () => {
		await withOuterTmux(async () => {
			const execCalls: string[][] = [];
			const handler = await loadFactory(async (_command, args) => {
				execCalls.push(args);
				if (args.includes("list-clients")) return { code: 0, stdout: "/dev/pts/7\t@1\t100\n", stderr: "" };
				if (args.includes("#{pane_dead}")) return { code: 0, stdout: "0\n", stderr: "" };
				return { code: 0, stdout: "@1\n", stderr: "" };
			});
			let prompted = false;
			const launches: string[][] = [];
			__test__.setPanelLauncher((_command, args) => {
				launches.push(args);
			});
			try {
				const ctx = {
					...fakeContext(),
					ui: {
						input: async () => {
							prompted = true;
							return "why?";
						},
						notify: () => {},
					},
				};
				await handler("", ctx as never);
				assert.equal(prompted, false, "a live panel needs no question");
				assert.equal(launches.length, 1);
				assert.ok(!execCalls.some((args) => args.includes("new-session")), "the panel is not re-created");
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
			const execCalls: string[][] = [];
			const handler = await loadFactory(async (_command, args) => {
				execCalls.push(args);
				return { code: 0, stdout: "", stderr: "" };
			});
			const notifications: string[] = [];
			const ctx = {
				...fakeContext({ mode: "rpc" }),
				ui: {
					input: async () => {
						prompted = true;
						return "why?";
					},
					notify: (message: string) => notifications.push(message),
				},
			};
			await handler("why?", ctx as never);
			assert.equal(prompted, false, "no prompt outside the TUI");
			assert.equal(execCalls.length, 0);
			assert.match(notifications[0] ?? "", /TUI/);
		});
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
			const execCalls: string[][] = [];
			const handler = await loadFactory(async (_command, args) => {
				execCalls.push(args);
				if (args.includes("new-session")) {
					reached();
					await gate;
				}
				return { code: 0, stdout: "", stderr: "" };
			});
			const notifications: string[] = [];
			const ctx = {
				...fakeContext(),
				ui: { input: async () => "why?", notify: (message: string) => notifications.push(message) },
			};

			const first = handler("why?", ctx as never);
			await gateReached;
			await handler("why?", ctx as never);
			assert.equal(
				execCalls.filter((args) => args.includes("new-session")).length,
				1,
				"only one launch proceeds",
			);
			assert.match(notifications.join("\n"), /still starting/);
			release();
			await first;
		});
	});
});
