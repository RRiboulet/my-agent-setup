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

import assert from "node:assert/strict";
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
