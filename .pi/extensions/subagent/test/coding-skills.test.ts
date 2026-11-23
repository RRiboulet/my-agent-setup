// Guards for the coding skill stack adapted from agent-coding-skills, the
// skills ported straight from mattpocock/skills, and this repository's own
// prevent-recurrence skill.
//
// Risk covered: the adapted skills are local copies now, edited by hand. Three
// things break silently as they change: a name that stops matching its folder
// (pi tolerates it; other harnesses do not), an entry point that loses
// `disable-model-invocation` and gets started by the model unasked, and a script
// that loses its executable bit. Those assertions are about shape, not wording,
// so a reworded skill still passes.
//
// The description and split contract tests below come from ticket 05, Move 2:
// every description is on the always-on surface, so it has a byte cap by class,
// a trigger marker on the model-invoked ones, and no routing to another skill; every
// `references/*.md` is reachable from its `SKILL.md` by link; and the two split
// bodies stay in their line budget. They report every offender at once rather
// than the first, because a cap that is over in one skill is usually over in
// ten.

import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SKILLS_ROOT = path.join(REPO_ROOT, ".pi/skills");

// The stack adapted from RRiboulet/agent-coding-skills. Kept as a list so the
// per-stack rules below do not silently apply to this repo's own skills.
const ADAPTED = [
	"architect",
	"benchmark-checklist",
	"blast-radius",
	"diagnosing-bugs",
	"handoff",
	"idempotent-operations",
	"implement",
	"in-your-own-words",
	"prove-it-works",
	"recall",
	"show-me-your-work",
	"tdd",
	"to-spec",
	"to-tickets",
];

// Ported straight from mattpocock/skills rather than through that stack, so they
// are classified separately in licenses/NOTICE.md while getting the same shape
// checks.
const PORTED = ["grilling", "teach", "writing-for-agents"];

// This repository's own skills. They carry no upstream classification, but a
// missing description or a dead reference breaks them the same way.
const OURS = ["prevent-recurrence"];

const ALL = [...ADAPTED, ...PORTED, ...OURS];

// pi honors `disable-model-invocation`; these five are entry points only the
// user starts, and AGENTS.md says so.
const USER_INVOKED = ["handoff", "implement", "recall", "teach", "to-spec", "to-tickets"];

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
	const known = new Set([...ALL, "add-model", "commit", "devcontainer", "github", "librarian", "native-web-search", "prevent-recurrence", "tmux", "update-changelog", "worktree"]);
	for (const dir of skillDirs()) {
		assert.ok(known.has(dir), `unclassified skill .pi/skills/${dir}: add it to this test`);
	}
});

test("every adapted, ported or local skill declares a name equal to its folder", () => {
	for (const dir of ALL) {
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

test("the user-invoked entry points are hidden from model selection", () => {
	for (const dir of USER_INVOKED) {
		assert.equal(
			frontmatter(dir)["disable-model-invocation"],
			"true",
			`.pi/skills/${dir}/SKILL.md must set disable-model-invocation: true`,
		);
	}
	for (const dir of ALL.filter((name) => !USER_INVOKED.includes(name))) {
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
	for (const dir of ALL) {
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

test("every relative link in an adapted, ported or local skill resolves", () => {
	// A refresh that moves references/ but leaves a link behind is invisible
	// until an agent tries to read the file. `teach` depends on it most: its four
	// *-FORMAT.md files are reached by link, not by name.
	for (const dir of ALL) {
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

// --- The description and split contract (ticket 05, Move 2) ---------------
//
// Every description is always-on surface: it is on the request whether or not
// the skill loads, so its cost is paid 100% of the time. The caps are small on
// purpose and the saving is small too (~2 KB of a 6.5 KB surface); the point is
// that a description stays a trigger line instead of growing into an abstract.

const MODEL_INVOKED_CAP = 250;
const USER_INVOKED_CAP = 150;

// How many lines a body that was split for size may keep. `worktree` was 630
// lines / 32 KB before its split; `add-model` is the second, deferred one.
const BODY_BUDGET: Record<string, number> = { "add-model": 150, worktree: 150 };

function descriptionOf(dir: string): string {
	return rawDescriptionLine(dir)
		.replace(/^description:\s*/, "")
		.replace(/^"|"$/g, "")
		// `\"` is one quote in the value the model sees; counting the two bytes
		// of its escape would push a 250-byte description over the cap.
		.replace(/\\"/g, '"');
}

// The raw frontmatter line, not the parsed value: frontmatter() reads one line
// only, so a wrapped YAML value would be truncated and slip under the byte cap
// without failing. The cap test below holds the description to the
// single-double-quoted-line form Move 2 fixes, which is what makes the byte
// count the whole value.
function rawDescriptionLine(dir: string): string {
	const lines = readFileSync(path.join(SKILLS_ROOT, dir, "SKILL.md"), "utf8").split("\n");
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	return lines.slice(1, end).find((line) => line.startsWith("description:")) ?? "";
}

// A `description: "…"` line followed by an indented line keeps its YAML
// meaning and hides the rest of the value from every one-line reader, so the
// cap would measure a fragment. Reject the shape, not just the fragment.
function hasContinuationLine(dir: string): boolean {
	const lines = readFileSync(path.join(SKILLS_ROOT, dir, "SKILL.md"), "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith("description:"));
	if (start === -1) return false;
	const next = lines[start + 1] ?? "";
	return /^\s+\S/.test(next) && next.trim() !== "---";
}

// Whole-file lines, frontmatter included: the budget is the spec's hard ceiling
// on what a split body may keep (`docs/tickets/harness-advancements/05-skills-prune.md`),
// and counting the file keeps a frontmatter-grown skill from dodging it.
function skillFileLines(dir: string): number {
	const text = readFileSync(path.join(SKILLS_ROOT, dir, "SKILL.md"), "utf8");
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// JSON rather than a bare join, so a violation list reads as a list in the
// failure output instead of one long line.
function report(violations: string[]): string {
	return `\n${JSON.stringify(violations, null, 2)}`;
}

test("every description fits the byte cap of its class", () => {
	// Bytes, not characters: the descriptions use em dashes, and the cap is a
	// budget of what the request carries. A description authored to 250
	// characters with three em dashes is 256 B.
	const violations: string[] = [];
	for (const dir of skillDirs()) {
		const cap = USER_INVOKED.includes(dir) ? USER_INVOKED_CAP : MODEL_INVOKED_CAP;
		const raw = rawDescriptionLine(dir);
		if (!/^description: ".*"$/.test(raw) || hasContinuationLine(dir)) {
			violations.push(`.pi/skills/${dir}: description is not one double-quoted line`);
			continue;
		}
		const bytes = Buffer.byteLength(descriptionOf(dir), "utf8");
		if (bytes > cap) violations.push(`.pi/skills/${dir}: ${bytes} B > ${cap} B`);
	}
	assert.deepEqual(violations, [], `descriptions that are over the cap or not one double-quoted line:${report(violations)}`);
});

test("every model-invoked description says when to use it", () => {
	// `Use when:` is the marker the routing surfaces key off, and the shape AGENTS.md
	// documents: the broadest true trigger first, then narrower ones. A
	// description without it reads as a summary, which is not what the model
	// selects on.
	const missing: string[] = [];
	for (const dir of skillDirs()) {
		if (USER_INVOKED.includes(dir)) continue;
		if (!descriptionOf(dir).includes("Use when:")) missing.push(`.pi/skills/${dir}`);
	}
	assert.deepEqual(missing, [], `model-invoked descriptions with no "Use when:":${report(missing)}`);
});

// One-word skill names that are also ordinary English or program names here, so a
// token match on them flags prose that routes nowhere ("never commit, push",
// "devc ... tmux"). Every other name is checked as a token, one word or not;
// `tdd` is the reason this list exists rather than a blanket exemption.
const HOMOGRAPHS = new Set([
	"commit",
	"devcontainer",
	"github",
	"grilling",
	"handoff",
	"implement",
	"librarian",
	"teach",
	"tmux",
	"worktree",
]);

test("no description names another skill", () => {
	// A description that routes to another skill competes with it: two skills
	// then load, or the wrong one does, and neither surface says why.
	const violations: string[] = [];
	const dirs = skillDirs();
	for (const dir of dirs) {
		const text = descriptionOf(dir);
		for (const other of dirs) {
			if (other === dir) continue;
			const homograph = !other.includes("-") && HOMOGRAPHS.has(other);
			const named = homograph
				? text.includes(`\`${other}\``) || text.includes(`/skill:${other}`)
				: new RegExp(`(^|[^a-z0-9-])${other}([^a-z0-9-]|$)`, "i").test(text);
			if (named) violations.push(`.pi/skills/${dir} names ${other}`);
		}
	}
	assert.deepEqual(violations, [], `descriptions naming another skill:${report(violations)}`);
});

test("every user-invoked description has the entry-point shape", () => {
	// These five are hidden from model selection, so their description is read by
	// the human as a menu line. The shape is what makes the menu consistent, and
	// without an assertion a rewrite can leave one as a bare label.
	const wrong: string[] = [];
	for (const dir of USER_INVOKED) {
		if (!descriptionOf(dir).startsWith(`User-invoked /skill:${dir}: `)) wrong.push(`.pi/skills/${dir}`);
	}
	assert.deepEqual(wrong, [], `user-invoked descriptions not in "User-invoked /skill:<name>: ..." form:${report(wrong)}`);
});

// Relative to `dir`, so a reference in a subdirectory is reported and matched by
// the same path the link would use.
function markdownFilesUnder(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) return markdownFilesUnder(path.join(dir, entry.name), rel);
		return entry.name.endsWith(".md") ? [rel] : [];
	});
}

test("every references/*.md is reachable from its SKILL.md", () => {
	// The link walk above catches a link to nowhere. This catches the opposite,
	// which is silent: a reference file nobody links, so no agent ever finds it.
	// `teach` shipped an orphaned `GLOSSARY-FORMAT.md` that way.
	const orphans: string[] = [];
	for (const dir of skillDirs()) {
		const skillRoot = path.join(SKILLS_ROOT, dir);
		const refRoot = path.join(skillRoot, "references");
		if (!statSync(refRoot, { throwIfNoEntry: false })) continue;
		// Reachable, not merely linked: SKILL.md may point at one reference that
		// points at the next, and the file is still one an agent can find. Walk the
		// closure, fenced code stripped, from SKILL.md through every markdown file.
		const seen = new Set<string>();
		const queue = ["SKILL.md"];
		while (queue.length > 0) {
			const rel = queue.shift() as string;
			if (seen.has(rel)) continue;
			seen.add(rel);
			const file = path.join(skillRoot, rel);
			if (!statSync(file, { throwIfNoEntry: false })) continue;
			const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
			for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
				const clean = target.split("#")[0].replace(/^\.\//, "");
				if (clean.endsWith(".md") && !clean.includes("://")) queue.push(path.posix.normalize(path.posix.join(path.dirname(rel), clean)));
			}
		}
		for (const entry of markdownFilesUnder(refRoot)) {
			if (!seen.has(`references/${entry}`)) orphans.push(`.pi/skills/${dir}/references/${entry}`);
		}
	}
	assert.deepEqual(orphans, [], `reference files no SKILL.md links to:${report(orphans)}`);
});

test("the split skill bodies stay within their line budget", () => {
	// The budget is the point of the split: a body that grows back to its old size
	// has not been split, and the always-on cost of loading it returns with it.
	const over: string[] = [];
	for (const [dir, budget] of Object.entries(BODY_BUDGET)) {
		if (!statSync(path.join(SKILLS_ROOT, dir), { throwIfNoEntry: false })) {
			over.push(`.pi/skills/${dir}: in the budget map but no longer exists`);
			continue;
		}
		const lines = skillFileLines(dir);
		if (lines > budget) over.push(`.pi/skills/${dir}/SKILL.md: ${lines} lines > ${budget}`);
	}
	assert.deepEqual(over, [], `split bodies over budget:${report(over)}`);
});

// --- The implementation loop, and the size of the skill that owns it --------
//
// The loop lives in two files on purpose. `tdd` owns it, and `implement` is
// always in context while a unit is built, so putting the loop there means the
// agent has it without loading anything. Two copies drift, so they are compared
// here byte for byte - markers included, which also catches one copy being
// edited without the other.

const LOOP_BEGIN = "<!-- tdd-loop:begin";
const LOOP_END = "<!-- tdd-loop:end -->";

function loopBlock(dir: string): string {
	const text = readFileSync(path.join(SKILLS_ROOT, dir, "SKILL.md"), "utf8");
	const start = text.indexOf(LOOP_BEGIN);
	const end = text.indexOf(LOOP_END);
	assert.notEqual(start, -1, `${dir}/SKILL.md has no tdd-loop block`);
	assert.notEqual(end, -1, `${dir}/SKILL.md has an unterminated tdd-loop block`);
	assert.equal(text.split(LOOP_BEGIN).length - 1, 1, `${dir}/SKILL.md has one loop block`);
	return text.slice(start, end + LOOP_END.length);
}

test("the implementation loop is identical in tdd and implement", () => {
	const inTdd = loopBlock("tdd");
	const inImplement = loopBlock("implement");
	assert.equal(inImplement, inTdd, "edit both copies: .pi/skills/tdd/SKILL.md and .pi/skills/implement/SKILL.md");
	// A block that lost its steps would still be "identical".
	for (const step of ["**Red.**", "**Watch it fail for the right reason.**", "**Green.**", "**Widen.**", "**Tidy.**"]) {
		assert.ok(inTdd.includes(step), `the loop must keep its ${step} step`);
	}
});

test("tdd's own body stays small enough to load on a whim", () => {
	// Measured 2026-11-21: 4,607 B before the split, 2,864 after moving the seams
	// and anti-pattern detail into references. The cap keeps a future edit from
	// growing it back - loading a method is only worth it while it is cheap.
	const bytes = readFileSync(path.join(SKILLS_ROOT, "tdd", "SKILL.md")).length;
	assert.ok(bytes <= 3000, `.pi/skills/tdd/SKILL.md is ${bytes} B; the cap is 3000 - move detail to references/`);
});
