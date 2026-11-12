// The per-container pi agent dir is defined in exactly one place.
//
// It was briefly repeated in three: `devcontainer.json` (the definition),
// `restore-post-rebuild.sh` (a comment naming the path) and `voice-container.md`
// (a setup step naming it), alongside the mechanism prose in five files. Copies
// of a path are only correct until one of them is edited: the README section is
// the canonical explanation, `devcontainer.json` the canonical value, and
// everything else reads `$PI_CODING_AGENT_DIR` — which is also what the scripts
// already use, so a comment naming a literal is a second source of truth for no
// benefit. The changelog is exempt: it records what the path was, once.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const read = (...parts: string[]) => readFileSync(path.join(REPO_ROOT, ...parts), "utf8");

const LITERAL = "agent-my-agent-setup";
const OWNER = ".devcontainer/devcontainer.json";
const OTHER_FILES = [
	".devcontainer/postCreate.sh",
	".devcontainer/restore-post-rebuild.sh",
	".devcontainer/voice-container.md",
	"README.md",
	"AGENTS.md",
];

test("the per-container agent dir is spelled out in devcontainer.json only", () => {
	assert.match(read(OWNER), new RegExp(`"PI_CODING_AGENT_DIR":\\s*"[^"]*${LITERAL}"`), `${
		OWNER} must define the path`
	);

	for (const file of OTHER_FILES) {
		assert.ok(
			!read(file).includes(LITERAL),
			`${file} repeats the agent dir path; refer to PI_CODING_AGENT_DIR instead (canonical value: ${OWNER}, rationale: README)`,
		);
	}
});

test("the files that describe the split point at the README instead of restating it", () => {
	const flat = (text: string) => text.replace(/\s+/g, " ");
	assert.match(flat(read("README.md")), /One copy of the extensions, never two/, "the README section is the canonical explanation");
	// The two files whose comments used to carry the whole 8-line rationale now
	// name that section by title, so a reader lands on the explanation that is
	// kept up to date. Compared with whitespace flattened, because both wrap it.
	for (const file of [".devcontainer/postCreate.sh", ".devcontainer/devcontainer.json"]) {
		assert.match(
			flat(read(file)),
			/One copy of the extensions, never two/,
			`${file} must point at the README section rather than restating the mechanism`,
		);
	}
});
