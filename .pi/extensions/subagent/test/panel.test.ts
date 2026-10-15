// Unit tests for the panel builders.
//
// Risk covered: these builders are the entire pure surface of the
// click-to-open-panel feature. Everything else — the tmux popup, the nested
// attach client, the Escape binding — needs a live terminal, so this file is
// what proves the argv is exactly what tmux expects, that the nested command
// unsets both TMUX variables (otherwise the nested client refuses to start),
// and that a socket or session containing a quote cannot break out of the
// shell word it is placed in.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAttachCommand, buildEscapeBindArgs, buildPanelLaunch } from "../panel.ts";

const SOCKET = "/home/x/.pi/agent/tmux-subagents.sock";
const RUN_ID = "1a2b3c4d-0000-4000-8000-000000000000";
const SESSION = `pi-agent-${RUN_ID}`;

function launch(overrides: Partial<Parameters<typeof buildPanelLaunch>[0]> = {}) {
	return buildPanelLaunch({
		outerSocket: "/tmp/outer.sock",
		pane: "%3",
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

test("the popup launch is the exact tmux argv, with the attach command as one element", () => {
	const result = launch();
	assert.equal(result.command, "tmux");
	assert.deepEqual(result.args, [
		"-S",
		"/tmp/outer.sock",
		"display-popup",
		"-E",
		"-t",
		"%3",
		"-w",
		"90%",
		"-h",
		"90%",
		"-T",
		"subagent 1a2b3c4d",
		`env -u TMUX -u TMUX_PANE tmux -S '${SOCKET}' attach -t '${SESSION}'`,
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
