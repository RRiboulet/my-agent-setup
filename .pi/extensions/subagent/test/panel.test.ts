// Unit tests for the panel builders (plan §3.3).
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

import { buildAttachCommand, buildEscapeBindArgs, buildPanelLaunch, buildPanelTitle } from "../panel.ts";

const SOCKET = "/home/x/.pi/agent/tmux-subagents.sock";
const RUN_ID = "1a2b3c4d-0000-4000-8000-000000000000";
const SESSION = `pi-agent-${RUN_ID}`;

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
	const launch = buildPanelLaunch({
		outerSocket: "/tmp/outer.sock",
		pane: "%3",
		socket: SOCKET,
		session: SESSION,
		title: "subagent 1a2b3c4d",
	});
	assert.equal(launch.command, "tmux");
	assert.deepEqual(launch.args, [
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

test("the title is the short id, never task text", () => {
	assert.equal(buildPanelTitle(RUN_ID), "subagent 1a2b3c4d");
	assert.equal(buildPanelTitle("abcdefgh-rest"), "subagent abcdefgh");
});

test("a title with format metacharacters is refused, not expanded by tmux", () => {
	for (const title of ["subagent #(touch /tmp/pwned)", "100% done", "#S"]) {
		assert.throws(
			() =>
				buildPanelLaunch({ outerSocket: "/tmp/outer.sock", pane: "%3", socket: SOCKET, session: SESSION, title }),
			TypeError,
			`title ${JSON.stringify(title)} must be refused`,
		);
	}
});
