// Unit tests for the panel builders and the panel guards.
//
// Risk covered: `panel.ts` is the pure surface of the click-to-open feature —
// the argv, the nested attach command, the quoting and the tmux-format title —
// and `openSubagentPanel` is the guard ladder that decides whether a click may
// open a popup at all. The tmux popup and the live pane need a terminal, so
// these tests pin the parts that can be checked deterministically: the exact
// argv tmux receives, that the nested command unsets both TMUX variables, that
// a quote in a socket or session cannot escape its shell word, and that every
// guard (missing/queued/terminal run, non-tmux, no attached client, dead
// session, failed bind, non-TUI/shutdown) notifies instead of launching.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";
import { buildAttachCommand, buildEscapeBindArgs, buildPanelLaunch, buildPopupCommand } from "../panel.ts";
import { withEnv } from "./helpers.ts";

const SOCKET = "/home/x/.pi/agent/tmux-subagents.sock";
const RUN_ID = "1a2b3c4d-0000-4000-8000-000000000000";
const SESSION = `pi-agent-${RUN_ID}`;

function launch(overrides: Partial<Parameters<typeof buildPanelLaunch>[0]> = {}) {
	return buildPanelLaunch({
		outerSocket: "/tmp/outer.sock",
		pane: "%3",
		client: "/dev/pts/7",
		socket: SOCKET,
		session: SESSION,
		runId: RUN_ID,
		...overrides,
	});
}

/** The value passed to `-T`, computed once from a single launch. */
function titleOf(runId: string): string {
	const args = launch({ runId }).args;
	return args[args.indexOf("-T") + 1] as string;
}

test("the Escape binding is a root-table bind on the subagent server", () => {
	assert.deepEqual(buildEscapeBindArgs(SOCKET), ["-S", SOCKET, "bind", "-n", "Escape", "detach-client"]);
});

test("the nested attach command unsets TMUX and TMUX_PANE and quotes its targets", () => {
	assert.equal(
		buildAttachCommand(SOCKET, SESSION),
		`env -u TMUX -u TMUX_PANE tmux -S '${SOCKET}' attach -t '${SESSION}'`,
	);
});

test("a socket or session with a space or a quote stays one shell word", () => {
	const command = buildAttachCommand("/tmp/my dir/it's.sock", "pi-agent-x'y");
	assert.equal(
		command,
		`env -u TMUX -u TMUX_PANE tmux -S '/tmp/my dir/it'"'"'s.sock' attach -t 'pi-agent-x'"'"'y'`,
	);
});

test("the popup command attaches, then unbinds Escape so the binding cannot outlive it", () => {
	const command = buildPopupCommand(SOCKET, SESSION);
	assert.ok(command.startsWith(buildAttachCommand(SOCKET, SESSION)), "attach comes first");
	assert.ok(command.endsWith(`tmux -S '${SOCKET}' unbind -n Escape`), "the root binding is removed on exit");
});

test("the popup launch is the exact tmux argv, with the popup command as one element", () => {
	const result = launch();
	assert.equal(result.command, "tmux");
	assert.deepEqual(result.args, [
		"-S",
		"/tmp/outer.sock",
		"display-popup",
		"-E",
		"-c",
		"/dev/pts/7",
		"-t",
		"%3",
		"-w",
		"90%",
		"-h",
		"90%",
		"-T",
		"subagent 1a2b3c4d",
		buildPopupCommand(SOCKET, SESSION),
	]);
});

test("the title is the run id's first 8 characters", () => {
	assert.equal(titleOf(RUN_ID), "subagent 1a2b3c4d");
	assert.equal(titleOf("abcdefgh-rest"), "subagent abcdefgh");
});

test("a run id containing '#' is refused, without echoing the run id", () => {
	for (const runId of ["#abcdefg-rest", "ab#defgh", "#S-0000-#()"]) {
		assert.throws(
			() => titleOf(runId),
			(error: unknown) =>
				error instanceof TypeError && !error.message.includes(runId) && !error.message.includes(runId.slice(0, 8)),
			`runId ${JSON.stringify(runId)} must be refused without echoing it`,
		);
	}
});

test("no '#' can reach the -T format slot", () => {
	for (const runId of [RUN_ID, "abcdefgh-rest", "01234567", "#abcdefg", "ab#defgh", "#######x"]) {
		let title: string;
		try {
			title = titleOf(runId);
		} catch {
			continue; // refused, so nothing reached -T
		}
		assert.ok(!title.includes("#"), `title ${JSON.stringify(title)} must not contain '#'`);
	}
});

// ---- openSubagentPanel guards (local patch 17) ----
//
// Risk covered: each guard prevents a silent or confusing failure (a popup over
// a run that is gone, over a queued run with no pane, with no attached client to
// draw over, or one that flashes open and closes because the session died). The
// tests drive the real `openSubagentPanel` through its dependency seam; the
// popup launcher is always a fake, so no test can start a real one.

type Deps = Parameters<typeof __test__.openSubagentPanel>[0];

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	const id = overrides.id ?? RUN_ID;
	return {
		id,
		task: "task",
		cwd: "/tmp",
		provider: "openrouter",
		model: "m",
		thinking: "medium",
		tmuxSession: `pi-agent-${id}`,
		tmuxTarget: `pi-agent-${id}:0.0`,
		attachCommand: `pi --attach-subagent '${id}'`,
		captureCommand: "tmux capture-pane",
		runDir: "/tmp/run",
		resultPath: "/tmp/run/result.json",
		trusted: true,
		status: "running",
		createdAt: 0,
		...overrides,
	};
}

interface PanelMock {
	deps: Deps;
	notifications: { message: string; type: string }[];
	execCalls: { command: string; args: string[] }[];
	launches: { command: string; args: string[]; options: { detached: boolean; stdio: string }; onError: (message: string) => void }[];
	runs: Map<string, RunRecord>;
}

function panelMock(config: {
	runs?: RunRecord[];
	mode?: string;
	shuttingDown?: boolean;
	/** `null` means list-clients reports nobody; undefined means a real tty. */
	clientTty?: string | null;
	clientFails?: boolean;
	/** The outer pane's window id; defaults to "@1". */
	paneWindow?: string;
	/** The client's current window id; defaults to the pane's window. */
	clientWindow?: string;
	/** Explicit client list for the activity selection test. Overrides clientTty/clientWindow. */
	clients?: { tty: string; window: string; activity: number }[];
	/** Make the pane probe report the pane is gone. */
	paneGone?: boolean;
	sessionAlive?: boolean;
	bindOk?: boolean;
} = {}): PanelMock {
	const notifications: { message: string; type: string }[] = [];
	const execCalls: { command: string; args: string[] }[] = [];
	const launches: PanelMock["launches"] = [];
	const runs = new Map((config.runs ?? [run()]).map((entry) => [entry.id, entry]));
	const ok = { code: 0, stdout: "", stderr: "", killed: false };
	const deps: Deps = {
		ui: {
			mode: config.mode ?? "tui",
			ui: { notify: (message: string, type = "info") => notifications.push({ message, type }) },
		} as never,
		getRun: (id) => runs.get(id),
		isShuttingDown: () => config.shuttingDown === true,
			exec: async (command, args) => {
			execCalls.push({ command, args });
			const joined = args.join(" ");
			if (joined.includes("list-clients")) {
				if (config.clientFails) return { ...ok, code: 1, stderr: "no current client" };
				const list =
					config.clients ??
					(config.clientTty === null
						? []
						: [{ tty: config.clientTty ?? "/dev/pts/7", window: config.clientWindow ?? "@1", activity: 100 }]);
				return { ...ok, stdout: list.map((client) => `${client.tty}\t${client.window}\t${client.activity}\n`).join("") };
			}
			if (joined.includes("display-message")) {
				if (config.paneGone) return { ...ok, code: 1, stderr: "can't find pane" };
				return { ...ok, stdout: `${config.paneWindow ?? "@1"}\n` };
			}
			if (joined.includes("has-session")) return config.sessionAlive === false ? { ...ok, code: 1 } : ok;
			if (joined.includes("detach-client")) return config.bindOk === false ? { ...ok, code: 1 } : ok;
			return ok;
		},
		launch: (command, args, options, onError) => launches.push({ command, args, options, onError }),
	};
	return { deps, notifications, execCalls, launches, runs };
}

test("a click on a running row binds Escape, then launches the popup detached", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		const socket = __test__.tmuxSocketPath();
		assert.deepEqual(
			mock.execCalls.map((call) => call.args.join(" ")),
			[
				"-S /tmp/outer.sock display-message -p -t %1 #{window_id}",
				"-S /tmp/outer.sock list-clients -F #{client_tty}\t#{window_id}\t#{client_activity}",
				`-S ${socket} has-session -t pi-agent-${RUN_ID}`,
				`-S ${socket} bind -n Escape detach-client`,
			],
		);

		assert.equal(mock.launches.length, 1);
		const launch = mock.launches[0] as PanelMock["launches"][number];
		assert.equal(launch.command, "tmux");
		assert.deepEqual(launch.options, { detached: true, stdio: "ignore" });
		assert.deepEqual(
			launch.args,
			buildPanelLaunch({
				outerSocket: "/tmp/outer.sock",
				pane: "%1",
				client: "/dev/pts/7",
				socket,
				session: `pi-agent-${RUN_ID}`,
				runId: RUN_ID,
			}).args,
		);
		assert.deepEqual(mock.notifications, [], "the success path is silent");
	});
});

test("a queued run gets a wait message, not a popup", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run({ status: "queued" })] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.equal(mock.notifications.length, 1);
		assert.match(mock.notifications[0]?.message ?? "", /still queued/);
		assert.deepEqual(mock.execCalls, [], "no tmux work for a run with no pane");
		assert.deepEqual(mock.launches, []);
	});
});

test("a terminal or unknown run is reported as gone", async () => {
	for (const config of [{ runs: [run({ status: "completed" })] }, { runs: [] }]) {
		const mock = panelMock(config);
		await __test__.openSubagentPanel(mock.deps, RUN_ID);
		assert.equal(mock.notifications.length, 1);
		assert.match(mock.notifications[0]?.message ?? "", /no longer running/);
		assert.deepEqual(mock.launches, []);
	}
});

test("an interrupted run still opens its pane", async () => {
	// `isTerminal` includes `interrupted`, but that run is sitting at a prompt with
	// a live pane and is rendered clickable in the widget, so the guard must go
	// through `showsPane`, not `isTerminal`.
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run({ status: "interrupted" })] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.deepEqual(mock.notifications, []);
		assert.equal(mock.launches.length, 1);
	});
});

test("outside tmux the click falls back to the attach command", async () => {
	await withEnv({ TMUX: undefined, TMUX_PANE: undefined }, async () => {
		const mock = panelMock({ runs: [run()] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.equal(mock.notifications.length, 1);
		assert.ok((mock.notifications[0]?.message ?? "").includes(run().attachCommand));
		assert.deepEqual(mock.execCalls, []);
		assert.deepEqual(mock.launches, []);
	});
});

test("with no attached client the panel is not attempted", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		for (const config of [{ clientTty: null }, { clientFails: true }]) {
			const mock = panelMock(config);
			await __test__.openSubagentPanel(mock.deps, RUN_ID);
			assert.match(mock.notifications[0]?.message ?? "", /No attached tmux client/);
			assert.equal(mock.execCalls.length, 2, "session then clients, then stop");
			assert.deepEqual(mock.launches, []);
		}
	});
});

test("a pane that no longer resolves is reported before anything else", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()], paneGone: true });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.match(mock.notifications[0]?.message ?? "", /pane is gone/);
		assert.equal(mock.execCalls.length, 1);
		assert.deepEqual(mock.launches, []);
	});
});

test("a client attached to the session but showing another window is not used", async () => {
	// The whole point of the session+window probe: piping into a client that is
	// not looking at pi would draw the popup over an unrelated screen.
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()], paneWindow: "@1", clientWindow: "@2" });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.match(mock.notifications[0]?.message ?? "", /viewing this pane/);
		assert.deepEqual(mock.launches, []);
	});
});

test("among clients on the pane's window, the most recently active one is targeted", async () => {
	// Two terminals on the same session and window both show the pane; the first
	// listed is not necessarily the one the person is using.
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({
			runs: [run()],
			clients: [
				{ tty: "/dev/pts/1", window: "@1", activity: 100 },
				{ tty: "/dev/pts/2", window: "@1", activity: 200 },
			],
		});
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		const launch = mock.launches[0] as PanelMock["launches"][number];
		const clientIndex = launch.args.indexOf("-c") + 1;
		assert.equal(launch.args[clientIndex], "/dev/pts/2");
	});
});

test("a client on another window loses even when its activity is higher", async () => {
	// The window filter scopes the choice first; activity only breaks ties inside
	// it. This is what makes a grouped session linked to the same window work.
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({
			runs: [run()],
			clients: [
				{ tty: "/dev/pts/1", window: "@1", activity: 100 },
				{ tty: "/dev/pts/2", window: "@2", activity: 999 },
			],
		});
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		const launch = mock.launches[0] as PanelMock["launches"][number];
		const clientIndex = launch.args.indexOf("-c") + 1;
		assert.equal(launch.args[clientIndex], "/dev/pts/1");
	});
});

test("from inside a subagent pane the panel is refused, not bound", async () => {
	// pi's own tmux server IS the subagent server in that configuration, so the
	// global Escape binding would swallow Escape in pi's TUI.
	const socket = __test__.tmuxSocketPath();
	await withEnv({ TMUX: `${socket},1,0`, TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.match(mock.notifications[0]?.message ?? "", /inside a subagent pane/);
		assert.deepEqual(mock.execCalls, []);
		assert.deepEqual(mock.launches, []);
	});
});

test("a dead subagent session stops before the binding", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()], sessionAlive: false });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.match(mock.notifications[0]?.message ?? "", /no live tmux session/);
		assert.equal(mock.execCalls.some((call) => call.args.includes("detach-client")), false, "Escape is not bound on a dead server");
		assert.deepEqual(mock.launches, []);
	});
});

test("a failed binding is reported and no popup opens", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()], bindOk: false });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		assert.equal(mock.notifications[0]?.type, "warning");
		assert.deepEqual(mock.launches, []);
	});
});

test("the guards keep a non-TUI or shutting-down session silent", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		for (const config of [{ mode: "rpc" }, { shuttingDown: true }]) {
			const mock = panelMock(config);
			await __test__.openSubagentPanel(mock.deps, RUN_ID);
			assert.deepEqual(mock.notifications, []);
			assert.deepEqual(mock.execCalls, []);
			assert.deepEqual(mock.launches, []);
		}
	});
});

test("a spawn error is reported through the notify callback", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0", TMUX_PANE: "%1" }, async () => {
		const mock = panelMock({ runs: [run()] });
		await __test__.openSubagentPanel(mock.deps, RUN_ID);

		(mock.launches[0] as PanelMock["launches"][number]).onError("tmux not found");
		assert.deepEqual(mock.notifications, [{ message: "Could not open panel: tmux not found", type: "error" }]);
	});
});
