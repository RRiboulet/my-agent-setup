// The tmux skill and the subagent extension each own a tmux server, and the
// separation is load-bearing: the skill documents `kill-server`, and one shared
// socket would let that reap every running child Pi. Nothing else pins the
// split — tmux.test.ts pins the extension's side (`tmuxSocketPath` ends in
// `tmux-subagents.sock`); this pins the skill's side and the divergence between
// them.
//
// Static on purpose: "these are two different paths" is a property of the
// files, provable without a live tmux server, and the failure that actually
// happens is a future "consolidate the sockets" refactor.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SKILL_DIR = path.join(REPO_ROOT, ".pi/skills/tmux");
const script = readFileSync(path.join(SKILL_DIR, "scripts/find-sessions.sh"), "utf8");
const skill = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const extension = readFileSync(path.join(REPO_ROOT, ".pi/extensions/subagent/index.ts"), "utf8");

test("the skill's sessions live under PI_TMUX_SOCKET_DIR, not the agent dir", () => {
	assert.ok(script.includes("PI_TMUX_SOCKET_DIR"), "the skill socket dir must be env-overridable");
	assert.ok(script.includes("pi-tmux-sockets"), "the skill's default dir must be its own");
	assert.ok(!script.includes("tmux-subagents.sock"), "the skill script must never address the subagent socket");
	assert.ok(!script.includes("getAgentDir"), "the skill script is standalone bash, not extension-aware");
});

test("the extension keeps its own socket and pi-agent-* namespace", () => {
	assert.match(extension, /path\.join\(getAgentDir\(\), "tmux-subagents\.sock"\)/);
});

test("SKILL.md fences the subagent socket off", () => {
	assert.ok(skill.includes("tmux-subagents.sock"), "the off-limits socket must be named");
	assert.ok(skill.includes("pi-agent-"), "the reserved namespace must be named");
	assert.match(
		skill,
		/Do \*\*not\*\* create sessions on the subagent socket/,
		"the skill must say outright not to create sessions there",
	);
});
