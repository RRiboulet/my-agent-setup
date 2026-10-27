// Direct tests for the shared popup machinery in `popup.ts`.
//
// Risk covered: the window/client probe is the one part of the click-to-open
// feature that both the subagent extension and `/btw` depend on, and it is the
// part that decides which terminal the popup lands on. `panel.test.ts` drives it
// only through `openSubagentPanel`'s guard ladder; these tests pin the function
// itself: the exact tmux argv (so nothing is shell-parsed), the window filter
// that grouped sessions make necessary, the activity tie-break and its
// stability, the two failure kinds the callers word differently, the optional
// per-probe timeout `/btw` passes, and the `TMUX` socket helper.

import assert from "node:assert/strict";
import { test } from "node:test";

import { currentTmuxSocket, defaultPanelLauncher, resolvePaneClient } from "../popup.ts";
import { withEnv } from "./helpers.ts";

const OUTER_SOCKET = "/tmp/outer.sock";
const OUTER_PANE = "%1";

interface ExecCall {
	command: string;
	args: string[];
	options: unknown;
}

/** A tmux model for the two probes: the pane's window, then the client list. */
function probeModel(config: { window?: string; windowCode?: number; clients?: string; clientsCode?: number } = {}) {
	const calls: ExecCall[] = [];
	const ok = { code: 0, stdout: "", stderr: "", killed: false };
	const exec = async (command: string, args: string[], options?: unknown) => {
		calls.push({ command, args, options });
		if (args.includes("display-message")) {
			return { ...ok, code: config.windowCode ?? 0, stdout: config.window ?? "@1\n" };
		}
		return { ...ok, code: config.clientsCode ?? 0, stdout: config.clients ?? "" };
	};
	return { calls, exec };
}

/** One `client_tty<TAB>window_id<TAB>client_activity` line, as tmux prints it. */
function clientLine(tty: string, window: string, activity: number): string {
	return `${tty}\t${window}\t${activity}\n`;
}

test("the probe runs exactly the two tmux argv strings, shell-free", async () => {
	const { calls, exec } = probeModel();
	await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE);

	assert.deepEqual(
		calls.map((call) => ({ command: call.command, args: call.args })),
		[
			{
				command: "tmux",
				args: ["-S", OUTER_SOCKET, "display-message", "-p", "-t", OUTER_PANE, "#{window_id}"],
			},
			{
				command: "tmux",
				args: ["-S", OUTER_SOCKET, "list-clients", "-F", "#{client_tty}\t#{window_id}\t#{client_activity}"],
			},
		],
	);
});

test("only a client on the pane's window is a candidate", async () => {
	// The grouped-session case: a client can be attached to the same window while
	// showing something else, and its activity must not win the tie-break.
	const { exec } = probeModel({
		window: "@1\n",
		clients: clientLine("/dev/pts/1", "@1", 100) + clientLine("/dev/pts/2", "@2", 999),
	});
	const resolved = await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE);
	assert.deepEqual(resolved, { kind: "client", client: "/dev/pts/1" });
});

test("among candidates, the most recently active client wins", async () => {
	const { exec } = probeModel({
		clients: clientLine("/dev/pts/1", "@1", 100) + clientLine("/dev/pts/2", "@1", 200),
	});
	assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "client", client: "/dev/pts/2" });
});

test("a same-second tie keeps tmux's own client order", async () => {
	// `client_activity` is whole seconds, so equal values are common. The sort is
	// stable, which means the first client tmux listed is the one used.
	const { exec } = probeModel({
		clients: clientLine("/dev/pts/1", "@1", 100) + clientLine("/dev/pts/2", "@1", 100),
	});
	assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "client", client: "/dev/pts/1" });
});

test("a line with no tty, or a non-numeric activity, is tolerated", async () => {
	const { exec } = probeModel({
		clients: clientLine("", "@1", 100) + "/dev/pts/3\t@1\tnot-a-number\n" + "\n" + "/dev/pts/4\t@1\n",
	});
	assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "client", client: "/dev/pts/3" });
});

test("no client on the pane's window is reported as no-client", async () => {
	for (const clients of ["", clientLine("/dev/pts/1", "@2", 100)]) {
		const { exec } = probeModel({ clients });
		assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "no-client" });
	}
});

test("a failed list-clients is no-client even when it printed a line", async () => {
	// tmux can print a partial list and still exit non-zero; a client line that
	// came with a failure is not a client to draw over.
	const { exec } = probeModel({ clientsCode: 1, clients: clientLine("/dev/pts/1", "@1", 100) });
	assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "no-client" });
});

test("a pane that no longer resolves stops after the first probe", async () => {
	for (const config of [{ windowCode: 1 }, { window: "" }, { window: "  \n" }]) {
		const { calls, exec } = probeModel(config);
		assert.deepEqual(await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE), { kind: "pane-gone" });
		assert.equal(calls.length, 1, "the client list is not asked for a pane that is gone");
	}
});

test("a caller's timeout bounds both probes", async () => {
	const { calls, exec } = probeModel();
	await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE, { timeoutMs: 5_000 });
	assert.deepEqual(
		calls.map((call) => call.options),
		[{ timeout: 5_000 }, { timeout: 5_000 }],
	);
});

test("with no timeout, the probes hand over no options at all", async () => {
	// The subagent ladder has never bounded these two calls; a timeout it did not
	// ask for would be a behaviour change hiding in a refactor.
	const { calls, exec } = probeModel();
	await resolvePaneClient(exec, OUTER_SOCKET, OUTER_PANE);
	assert.deepEqual(
		calls.map((call) => call.options),
		[undefined, undefined],
	);
});

test("the socket helper reads the TMUX socket component", async () => {
	await withEnv({ TMUX: "/tmp/outer.sock,1,0" }, async () => {
		assert.equal(currentTmuxSocket(), "/tmp/outer.sock");
	});
	await withEnv({ TMUX: " /tmp/padded.sock ,9,0" }, async () => {
		assert.equal(currentTmuxSocket(), "/tmp/padded.sock");
	});
	for (const value of [undefined, "", "   "]) {
		await withEnv({ TMUX: value }, async () => {
			assert.equal(currentTmuxSocket(), undefined, `TMUX=${JSON.stringify(value)} is not a socket`);
		});
	}
});

test("the default launcher reports a spawn failure through the callback", async () => {
	const message = await new Promise<string>((resolve) => {
		defaultPanelLauncher("pi-test-command-that-does-not-exist", [], { detached: true, stdio: "ignore" }, resolve);
	});
	assert.match(message, /ENOENT/);
});
