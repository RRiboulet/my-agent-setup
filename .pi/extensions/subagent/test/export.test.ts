// Guards the `__test__` export block (local patch 9 in index.ts).
//
// The block is not used at runtime, so nothing else would notice if a future
// re-vendor from mitsuhiko/agent-stuff dropped it -- at which point the whole
// unit suite would fail with a confusing import error. Assert it explicitly.

import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__ } from "../index.ts";

const REQUIRED_HELPERS = [
	"abortableDelay",
	"attachFlagValue",
	"findLastAssistant",
	"formatDuration",
	"holdsChild",
	"isSameOrDescendant",
	"isTerminal",
	"readBooleanEnv",
	"readIntEnv",
	"readNonNegativeIntEnv",
	"resolveModel",
	"runDirOwnsLiveTranscript",
	"runSummary",
	"shellQuote",
	"textFromAssistant",
	"tmuxSessionName",
	"tmuxSocketPath",
	"trimPane",
	"truncateToolText",
	"updateTmuxCommands",
	"validateCwd",
	"writeJsonAtomic",
] as const;

test("__test__ exposes every helper the unit suite depends on", () => {
	for (const name of REQUIRED_HELPERS) {
		assert.equal(typeof __test__[name], "function", `__test__.${name} must be exported`);
	}
});

test("the extension default export is still a factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});