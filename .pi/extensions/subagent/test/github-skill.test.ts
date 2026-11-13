// Guards for the github skill's local adaptation B (the pull-request workflow).
//
// Static on purpose: the property is a property of two documents agreeing, and
// the failure that actually happened is an agent following the skill instead of
// AGENTS.md during a release. `gh pr merge --merge --delete-branch` on a
// `dev`→`main` pull request deletes `dev` — the integration branch every feature
// branch is cut from — on the remote, and gh attempts the local delete too.
// Nothing about that failure is observable in a test without a live remote, so
// the documents are what get pinned.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SKILL = readFileSync(path.join(REPO_ROOT, ".pi/skills/github/SKILL.md"), "utf8");
const AGENTS = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

/** The `<!-- LOCAL ADAPTATION B: ... -->` block: the whole PR-workflow section. */
function adaptationB(text: string): string {
	const start = text.indexOf("<!-- LOCAL ADAPTATION B");
	assert.notEqual(start, -1, "local adaptation B must exist");
	const end = text.indexOf("-->", start);
	assert.notEqual(end, -1, "the adaptation B comment must be closed");
	return text.slice(start, end);
}

test("github skill: the release merge never pairs --merge with --delete-branch", () => {
	// The command form, not the flag's name: the block legitimately mentions
	// `--delete-branch` for feature branches and in a refusal sentence, so the
	// assertion is that the two flags are never adjacent (`[^\w\n]*` allows only
	// quotes, spaces and punctuation between them - not the word "with" or
	// "do not pass").
	assert.ok(
		!SKILL.match(/--merge[^\w\n]*--delete-branch/),
		"a dev→main merge must not be told to pass --delete-branch; it deletes dev",
	);
	assert.ok(
		!adaptationB(SKILL).match(/re-create it locally/),
		"the workaround only exists because the flag was wrongly passed; drop it",
	);
});

test("github skill: the release merge says why the head branch must survive", () => {
	// A reader who is told "no --delete-branch" without the reason optimises it
	// away again the next time someone tidies the workflow.
	assert.ok(
		adaptationB(SKILL).includes("gh pr merge <n> --merge` with NO `--delete-branch`"),
		"the release command must be stated outright, with the flag refused",
	);
	assert.ok(
		/head\s+of\s+that\s+pull\s*\n?\s*request\s+is\s+`dev`|head of that pull/.test(adaptationB(SKILL)),
		"the reason must name dev as the head branch",
	);
});

test("github skill: the feature-branch merge keeps --squash --delete-branch", () => {
	// The asymmetry is the whole point: deleting a merged feature branch is the
	// normal flow, and a tidy-up that removes the flag everywhere would leave
	// every squash-merged branch behind as "not fully merged".
	assert.ok(
		adaptationB(SKILL).includes("gh pr merge <n> --squash --delete-branch"),
		"feature branches into dev still use --squash --delete-branch",
	);
});

test("github skill and AGENTS.md agree on the release merge", () => {
	// The skill says "the workflow is AGENTS.md's, not discretionary", so a
	// disagreement is the bug, not either document alone.
	assert.ok(
		AGENTS.includes("gh pr merge <n> --merge`"),
		"AGENTS.md's release step must still name the merge command",
	);
	assert.ok(
		!AGENTS.match(/--merge[^\w\n]*--delete-branch/),
		"AGENTS.md must not instruct passing --delete-branch on the release merge",
	);
	assert.match(AGENTS, /do not pass `--delete-branch`/, "AGENTS.md states the refusal in words");
});
