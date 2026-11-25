// Guard for CHANGELOG.md's local union merge driver.
//
// Parallel worktrees all append to `## Unreleased`, so a plain three-way merge
// treats the edits as a conflict even though both entries are valid. The
// `merge=union` attribute makes a local merge keep both sides, in order, and
// this test stops a future `.gitattributes` sweep from silently dropping it.
//
// Scope caveat: this applies to LOCAL merges only — a worktree branch pulling
// in `dev`, or a local merge of two branches. GitHub's server-side squash merge
// does not run custom merge drivers, so a PR view may still show a conflict;
// resolving it is then a local `git merge dev`, which the union attribute makes
// conflict-free. Do not remove this attribute because the GitHub UI still flags
// it.
//
// The file above is a source, not the verdict: a later, overridden attribute
// rule would still match this text, so the effective attribute is asserted too.
//
// Union is not a conflict resolver with judgement: it keeps both sides of a
// changed hunk verbatim. Near-duplicate bullets — the same entry appended on
// two branches — therefore land twice with no conflict markers to notice, and
// the duplicate has to be caught by reading the merged section.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const GITATTRIBUTES = path.join(REPO_ROOT, ".gitattributes");

test(".gitattributes keeps CHANGELOG.md merge=union beside the global eol rule", () => {
	const attributes = readFileSync(GITATTRIBUTES, "utf8");
	assert.match(
		attributes,
		/^\* text=auto eol=lf[ \t]*$/mu,
		"the global LF/eol rule must remain; the union attribute is path-specific and additive",
	);
	assert.match(
		attributes,
		/^CHANGELOG\.md[ \t]+merge=union[ \t]*$/mu,
		"concurrent local appends to ## Unreleased need the union driver to merge without conflict",
	);
});

test("git resolves CHANGELOG.md's effective merge attribute to union", () => {
	// The text assertion above is satisfied by a matching line that a later rule
	// overrides (`CHANGELOG.md -merge`, or an `ours` driver). Only git can say
	// which rule wins, so ask it rather than re-implementing attribute precedence.
	const effective = execFileSync("git", ["check-attr", "merge", "--", "CHANGELOG.md"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(
		effective.trim(),
		"CHANGELOG.md: merge: union",
		`CHANGELOG.md's effective merge attribute must be union, not whatever a later rule overrides it to: ${effective.trim()}`,
	);
});
