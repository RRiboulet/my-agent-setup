// Unit tests for tmux target naming, command construction and the
// --attach-subagent flag parser.
//
// Risk covered: these strings are executed in a real shell (capture/attach/kill)
// and gate the interactive attach path, so quoting or parsing mistakes surface
// as broken commands in a live terminal.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__, type RunRecord } from "../index.ts";
import { withTempAgentDir } from "./helpers.ts";

const { attachFlagValue, tmuxSessionName, tmuxSocketPath, updateTmuxCommands } = __test__;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "abcdef01-2345-4678-89ab-cdef01234567",
		task: "task",
		cwd: "/workspace",
		provider: "openrouter",
		model: "model",
		thinking: "off",
		tmuxSession: tmuxSessionName("abcdef01-2345-4678-89ab-cdef01234567"),
		tmuxTarget: `${tmuxSessionName("abcdef01-2345-4678-89ab-cdef01234567")}:0.0`,
		attachCommand: "",
		captureCommand: "",
		runDir: "/tmp/run",
		resultPath: "/tmp/run/result.json",
		trusted: false,
		status: "queued",
		createdAt: 0,
		...overrides,
	};
}

test("tmuxSessionName is derived from the run id", () => {
	assert.equal(tmuxSessionName("abc"), "pi-agent-abc");
	assert.equal(tmuxSessionName("a b'c"), "pi-agent-a b'c");
});

test("tmuxSocketPath lives under the agent directory", async () => {
	await withTempAgentDir(async (agentDir) => {
		assert.equal(tmuxSocketPath(), `${agentDir}/tmux-subagents.sock`);
	});
});

test("updateTmuxCommands builds quoted attach and capture commands", async () => {
	await withTempAgentDir(async (agentDir) => {
		const run = makeRun();
		updateTmuxCommands(run);
		const socket = `${agentDir}/tmux-subagents.sock`;
		assert.equal(run.attachCommand, `pi --attach-subagent 'abcdef01-2345-4678-89ab-cdef01234567'`);
		assert.equal(run.captureCommand, `tmux -S '${socket}' capture-pane -p -J -t 'pi-agent-abcdef01-2345-4678-89ab-cdef01234567:0.0'`);
	});
});

test("updateTmuxCommands re-quotes paths containing spaces", async () => {
	await withTempAgentDir(async (agentDir) => {
		const run = makeRun({ id: "has space" });
		run.tmuxSession = tmuxSessionName(run.id);
		run.tmuxTarget = `${run.tmuxSession}:0.0`;
		updateTmuxCommands(run);
		assert.ok(run.captureCommand.includes(`-t 'pi-agent-has space:0.0'`));
		assert.ok(run.captureCommand.includes(`-S '${agentDir}/tmux-subagents.sock'`));
	});
});

test("attachFlagValue reads --attach-subagent in both spellings", () => {
	assert.equal(attachFlagValue(["node", "pi", "--attach-subagent", "abc"]), "abc");
	assert.equal(attachFlagValue(["node", "pi", "--attach-subagent=abc"]), "abc");
	assert.equal(attachFlagValue(["node", "pi", "--attach-subagent"]), "", "bare flag means empty target");
	assert.equal(attachFlagValue(["node", "pi", "--attach-subagent", "--no-session"]), "", "a following flag is not a value");
});

test("attachFlagValue returns undefined when the flag is absent", () => {
	assert.equal(attachFlagValue(["node", "pi", "--no-session"]), undefined);
	assert.equal(attachFlagValue(["node", "pi"]), undefined);
});

test("attachFlagValue ignores an argument before the script path", () => {
	// Only argv[2] onwards is scanned, so a node exec arg is never mistaken for the flag.
	assert.equal(attachFlagValue(["node", "--attach-subagent", "pi"]), undefined);
	assert.equal(attachFlagValue(["pi", "--attach-subagent", "abc"]), undefined);
});

test("attachFlagValue stops scanning at the -- separator", () => {
	assert.equal(attachFlagValue(["node", "pi", "--", "--attach-subagent", "abc"]), undefined);
});