// Guards the testing rule in AGENTS.md that sends the full suite through `bg`.
//
// Risk covered: waiting for `bg`'s completion notice only works while the pi
// process that started the job stays alive. The rule's first version promised
// that a waiting session "does not have to poll at all", which holds in an
// interactive session and not in a child session, a `pi -p` run or a JSON/RPC
// run: the run ends, the watcher dies with it, the job keeps running as an
// orphan, the work is never committed — and the run still reports "completed".
// The document is the only thing steering an agent away from that, so its shape
// is pinned here: deferred discovery, the suite-once discipline, the condition
// that makes waiting safe, the wait-before-poll ordering, and the failure to
// recognise.
//
// These assertions are about shape, not wording, so a reworded rule still
// passes; a deleted caveat does not.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const AGENTS = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

const HEADING = "One test file while iterating";

/** The `#### One test file while iterating ...` section: its heading through the next one. */
function ruleSection(text: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith("#") && line.includes(HEADING));
	assert.notEqual(start, -1, `AGENTS.md must keep the "${HEADING}" section`);
	const end = lines.findIndex((line, index) => index > start && /^#{1,6} /.test(line));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const RULE = ruleSection(AGENTS);

test("bg rule: discovery goes through tool_search, with bash as the stated fallback", () => {
	// `bg` is registered deferred, so an agent that never asks for it cannot call
	// it; the fallback is what keeps the rule actionable where it does not exist.
	const discovery = RULE.indexOf("tool_search");
	const start = RULE.indexOf('bg({ action: "start"');
	assert.notEqual(discovery, -1, "the rule must say how `bg` is reached");
	assert.notEqual(start, -1, "the rule must still show the start call");
	assert.ok(discovery < start, "discovery must come before the start call, because `bg` is not declared");
	assert.match(RULE, /bash/i, "the rule must keep the fallback for when tool_search finds nothing");
});

test("bg rule: the full suite still runs exactly once, started through bg", () => {
	assert.match(RULE.split("\n")[0], /suite once/i, "the heading must still say the suite runs once");
	assert.match(RULE, /exactly once/i, "the body must still say the full suite runs once, before the commit");
	assert.ok(RULE.includes('bg({ action: "start"'), "the full run must still be started through `bg`");
	assert.ok(
		RULE.includes("--test-concurrency=8"),
		"the rule must carry the suite command as this repo documents it",
	);
});

test("bg rule: waiting is conditioned on a session that outlives the job", () => {
	// The clause that makes the promise true. Without it the rule reads as an
	// unconditional "you will be woken", which is false wherever the run ends
	// first.
	assert.match(RULE, /child session/i, "the rule must name the child-session case");
	assert.match(RULE, /pi -p/, "the rule must name a non-interactive run");
	assert.match(
		RULE,
		/stays open|keep(?:s|ing)? the session alive/i,
		"the rule must state what waiting actually requires of the session",
	);
	assert.ok(RULE.includes('bg({ action: "status" })'), "the rule must send a reader to status polling");
	assert.ok(RULE.includes('bg({ action: "logs", id })'), "the rule must send a reader to the job's logs");
	// The tool grew a bounded wait after the rule was first written: a scripted
	// run that has nothing else to do should block inside the call, not poll.
	assert.ok(
		RULE.includes('bg({ action: "wait", id })'),
		"the rule must offer wait before falling back to polling",
	);
	assert.match(RULE, /started by another session/i, "the rule must say how to recognise a child session");
	assert.doesNotMatch(
		RULE,
		/do not have to poll/i,
		"an unconditional no-poll promise is the bug this rule exists to close",
	);
});

test("bg rule: names the failure, so an abandoned run is recognised as one", () => {
	// The visible signature of the broken case: a job still running, work never
	// committed, and a "completed" status that proves nothing.
	assert.match(RULE, /orphan/i, "the rule must say the job is left running");
	assert.match(RULE, /never committed|uncommitted/i, "the rule must say the work is not committed");
	assert.match(RULE, /completed/i, "the rule must name the status that looks like success");
	assert.match(RULE, /proves nothing/i, "the rule must say that status is not evidence");
});
