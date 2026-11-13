// The per-container pi agent dir is defined in exactly one place.
//
// It was briefly repeated in four files — `devcontainer.json` (the definition),
// `postCreate.sh` (a measured error transcript), `restore-post-rebuild.sh` (a
// comment) and `voice-container.md` (a setup step) — alongside the mechanism
// prose in five. Copies of a path are only correct until one of them is edited,
// so `devcontainer.json` owns the value, the README section "One copy of the
// extensions, never two" owns the explanation, and everything else reads
// `$PI_CODING_AGENT_DIR`.
//
// The value is read out of `devcontainer.json` rather than hard-coded here: a
// hard-coded needle would make this guard vacuous the moment the directory is
// renamed, and would fail with a message about the wrong thing. `git ls-files`
// rather than a hand-written list, so a *new* doc that repeats the path is
// caught too. `CHANGELOG.md` is exempt because a changelog records what a value
// was; so are the measured-error transcripts, which quote an error verbatim,
// with the path elided.
//
// The one case the guard cannot see is this repository's own history: the
// literal is in earlier commits' diffs, and that is not a second definition.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

const OWNER = ".devcontainer/devcontainer.json";
/** Files allowed to name the path: the owner, history, and this guard itself. */
const EXEMPT = new Set([OWNER, "CHANGELOG.md", ".pi/extensions/subagent/test/devcontainer-agent-dir.test.ts"]);

/** The value `devcontainer.json` declares, which is the one that must be unique. */
function declaredAgentDir(): string {
	const match = /"PI_CODING_AGENT_DIR"\s*:\s*"([^"]+)"/u.exec(read(OWNER));
	assert.ok(match?.[1], `${OWNER} must declare PI_CODING_AGENT_DIR`);
	return match[1] as string;
}

function trackedFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
}

test("the per-container agent dir is spelled out in devcontainer.json only", () => {
	const declared = declaredAgentDir();
	const needle = path.basename(declared);
	assert.ok(needle.length > 3, `unexpectedly short value to search for: ${declared}`);

	const offenders = trackedFiles()
		.filter((file) => !EXEMPT.has(file))
		.filter((file) => {
			const text = read(file);
			// A binary file cannot carry a path in a form a reader would copy.
			return !text.includes("\0") && text.includes(needle);
		});

	assert.deepEqual(
		offenders,
		[],
		`these tracked files repeat ${declared}: refer to PI_CODING_AGENT_DIR instead (canonical value: ${OWNER}, rationale: README)`,
	);
});

test("the files that describe the split point at the README instead of restating it", () => {
	const flat = (text: string) => text.replace(/\s+/gu, " ");
	assert.match(
		flat(read("README.md")),
		/One copy of the extensions, never two/u,
		"the README section is the canonical explanation",
	);
	// The two files whose comments used to carry the whole rationale now name that
	// section by title, so a reader lands on the explanation that is kept up to
	// date. Compared with whitespace flattened, because both wrap it.
	for (const file of [".devcontainer/postCreate.sh", OWNER]) {
		assert.match(
			flat(read(file)),
			/One copy of the extensions, never two/u,
			`${file} must point at the README section rather than restating the mechanism`,
		);
	}
});
