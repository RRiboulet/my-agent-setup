// Guards for the coding skill stack adapted from agent-coding-skills.
//
// Risk covered: the coding skills adapted from `agent-coding-skills` are local
// copies now, edited by hand. Three things break silently as they change: a name
// that stops matching its folder (pi tolerates it; other harnesses do not), an
// entry point that loses `disable-model-invocation` and gets started by the
// model unasked, and a script that loses its executable bit. These assertions
// are about shape, not wording, so a reworded skill still passes.

import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SKILLS_ROOT = path.join(REPO_ROOT, ".pi/skills");

// The stack adapted from RRiboulet/agent-coding-skills. Kept as a list so the
// per-stack rules below do not silently apply to this repo's own skills.
const ADAPTED = [
	"benchmark-checklist",
	"blast-radius",
	"diagnosing-bugs",
	"handoff",
	"idempotent-operations",
	"implement",
	"in-your-own-words",
	"prove-it-works",
	"show-me-your-work",
	"tdd",
	"to-spec",
	"to-tickets",
];

// pi honors `disable-model-invocation`; these four are entry points only the
// user starts, and AGENTS.md says so.
const USER_INVOKED = ["handoff", "implement", "to-spec", "to-tickets"];

function skillDirs(): string[] {
	return readdirSync(SKILLS_ROOT)
		.filter((name) => statSync(path.join(SKILLS_ROOT, name)).isDirectory())
		.sort();
}

function frontmatter(dir: string): Record<string, string> {
	const text = readFileSync(path.join(SKILLS_ROOT, dir, "SKILL.md"), "utf8");
	const lines = text.split("\n");
	assert.equal(lines[0].trim(), "---", `${dir}/SKILL.md has no frontmatter`);
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	assert.notEqual(end, -1, `${dir}/SKILL.md has unterminated frontmatter`);
	const meta: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match) meta[match[1]] = match[2].replace(/^"|"$/g, "");
	}
	return meta;
}

test("every skill is classified in this test", () => {
	// A new skill added to the tree without updating this test would otherwise
	// escape the frontmatter assertions below.
	const known = new Set([...ADAPTED, "add-model", "commit", "devcontainer", "github", "librarian", "native-web-search", "tmux", "update-changelog", "worktree"]);
	for (const dir of skillDirs()) {
		assert.ok(known.has(dir), `unclassified skill .pi/skills/${dir}: add it to this test`);
	}
});

test("every adapted skill declares a name equal to its folder", () => {
	for (const dir of ADAPTED) {
		const meta = frontmatter(dir);
		assert.equal(meta.name, dir, `.pi/skills/${dir}/SKILL.md name must equal the folder`);
		assert.ok(meta.description?.trim(), `.pi/skills/${dir}/SKILL.md needs a description`);
		assert.ok(
			(meta.description ?? "").length <= 1024,
			`.pi/skills/${dir}/SKILL.md description exceeds pi's 1024-character limit`,
		);
	}
});

test("skill names are unique across the tree", () => {
	// pi keeps the first skill it finds for a duplicate name and warns; the other
	// one becomes unreachable without saying so.
	const names = skillDirs().map((dir) => frontmatter(dir).name);
	assert.equal(new Set(names).size, names.length, `duplicate skill names: ${names}`);
});

test("the four user-invoked entry points are hidden from model selection", () => {
	for (const dir of USER_INVOKED) {
		assert.equal(
			frontmatter(dir)["disable-model-invocation"],
			"true",
			`.pi/skills/${dir}/SKILL.md must set disable-model-invocation: true`,
		);
	}
	for (const dir of ADAPTED.filter((name) => !USER_INVOKED.includes(name))) {
		assert.equal(
			frontmatter(dir)["disable-model-invocation"],
			undefined,
			`.pi/skills/${dir}/SKILL.md is model-invoked and must not set disable-model-invocation`,
		);
	}
});

test("adapted scripts stay executable", () => {
	// Upstream commits both scripts mode 100644 while requiring +x, so its own
	// gate fails on a clone. A refresh must not bring that back.
	for (const dir of ADAPTED) {
		const scripts = path.join(SKILLS_ROOT, dir, "scripts");
		let entries: string[];
		try {
			entries = readdirSync(scripts);
		} catch {
			continue;
		}
		for (const entry of entries.filter((name) => name.endsWith(".sh"))) {
			assert.doesNotThrow(
				() => accessSync(path.join(scripts, entry), constants.X_OK),
				`.pi/skills/${dir}/scripts/${entry} must be executable`,
			);
		}
	}
});

test("every relative link in an adapted skill resolves", () => {
	// A refresh that moves references/ but leaves a link behind is invisible
	// until an agent tries to read the file.
	for (const dir of ADAPTED) {
		const root = path.join(SKILLS_ROOT, dir);
		const files: string[] = [];
		const walk = (current: string) => {
			for (const entry of readdirSync(current)) {
				const full = path.join(current, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (entry.endsWith(".md")) files.push(full);
			}
		};
		walk(root);
		for (const file of files) {
			const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
			for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
				const resolved = path.resolve(path.dirname(file), target.split("#")[0]);
				assert.ok(
					statSync(resolved, { throwIfNoEntry: false }),
					`${path.relative(REPO_ROOT, file)} links to missing ${target}`,
				);
			}
		}
	}
});
