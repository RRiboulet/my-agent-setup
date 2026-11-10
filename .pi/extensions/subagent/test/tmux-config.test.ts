// The tmux config's truecolor comment made a claim a review then falsified: it
// said `terminal-features` is what tmux hands to inner programs and what flips
// pi's colour detection. Measured on tmux 3.3a, the environment inside a pane is
// byte-for-byte the same with and without that pair (`setenv -g` is the flip),
// and a long-lived server never re-reads the file after startup. Both facts cost
// a server restart and a `/proc/<pid>/environ` comparison to establish, and
// neither is visible from the config, so pin the sentences that carry them —
// and the absence of the sentence that was wrong.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

const CONF = read(".devcontainer/shell/tmux.conf");
const DEVC_SKILL = read(".pi/skills/devcontainer/SKILL.md");
const TMUX_SKILL = read(".pi/skills/tmux/SKILL.md");

test("tmux config: the falsified terminal-features claim does not come back", () => {
	// The old paragraph: "`terminal-features` is what tmux actually hands to
	// inner programs (via TERM/terminfo)". It was backwards — the lines change
	// nothing an inner program sees.
	assert.doesNotMatch(CONF, /terminal-features` is what tmux actually hands/);
	// The replacement states the measurement that refuted it, and the trade.
	assert.match(CONF, /`tput colors` stays 256 with or/);
	assert.match(CONF, /without these two lines/);
	assert.match(CONF, /Accepted trade/);
	assert.match(CONF, /be measured from inside this container/);
});

test("tmux config: the setenv pair is named as what flips pi, and its reach is stated", () => {
	// What actually flips pi's detection, so a future edit does not move the
	// credit back to the terminal-features pair.
	assert.match(CONF, /These\*? two, not the lines above/);
	assert.match(CONF, /`setenv -g` reaches only panes created afterwards/);
});

test("tmux docs: a config edit needs a server restart, and the remedy says what it kills", () => {
	// The symptom is "colours did not change after editing ~/.tmux.conf"; the
	// only remedy is kill-server, which is usually forbidden on these sockets.
	assert.match(TMUX_SKILL, /never read it/);
	assert.match(TMUX_SKILL, /kills\n\s+every running child Pi/);
	assert.match(TMUX_SKILL, /kills the `devc` sessions/);
	assert.match(DEVC_SKILL, /does \*\*not\*\* re-read it/);
	// The troubleshooting row must not send the reader back to terminal-features.
	assert.doesNotMatch(DEVC_SKILL, /make sure `~\/\.tmux\.conf` has `set -as terminal-features/);
	assert.match(DEVC_SKILL, /is not the fix for this/);
});
