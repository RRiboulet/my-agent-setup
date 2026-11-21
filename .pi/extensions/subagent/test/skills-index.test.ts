// The README's skill inventory is generated from each `SKILL.md`'s frontmatter,
// so the only thing that can go wrong is somebody editing one without the other.
// These assertions are that guard: render the block from the skills on disk and
// compare it with the README, then check the facts the section claims.
//
// Risk covered: a new skill that never appears in the README (that is how
// `add-model` went missing for weeks), a description rewritten only in the
// frontmatter, a skill that silently changes invocation class by gaining or
// losing `disable-model-invocation`, and a table that lists a skill twice.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { BEGIN, END, readSkills, renderBlock, renderReadme } from "../../../../tools/skills-index.mjs";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const README = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const SKILLS = readSkills();

test("the README's skill index matches the skills on disk", () => {
	const expected = renderBlock();
	assert.ok(README.includes(expected), "README.md is stale — run: node tools/skills-index.mjs --write");
});

test("the index has both markers, in order, once each", () => {
	assert.equal(README.split(BEGIN).length - 1, 1, "one begin marker");
	assert.equal(README.split(END).length - 1, 1, "one end marker");
	assert.ok(README.indexOf(BEGIN) < README.indexOf(END), "begin before end");
});

test("every skill on disk is listed exactly once", () => {
	const block = renderBlock();
	for (const skill of SKILLS) {
		const link = `[\`${skill.name}\`](.pi/skills/${skill.dir}/SKILL.md)`;
		const count = block.split(link).length - 1;
		assert.equal(count, 1, `${skill.name} must appear once, found ${count}`);
	}
});

test("the two invocation classes match the frontmatter, and the five are pinned", () => {
	const userInvoked = SKILLS.filter((skill) => skill.userInvoked).map((skill) => skill.name);
	assert.deepEqual(userInvoked, ["handoff", "implement", "teach", "to-spec", "to-tickets"]);
	const block = renderBlock();
	assert.ok(
		block.includes(`### User-invoked — ${userInvoked.length}:`),
		"the user-invoked heading carries the count",
	);
	assert.ok(
		block.includes(`### Model-invoked — ${SKILLS.length - userInvoked.length}:`),
		"the model-invoked heading carries the count",
	);
});

test("every user-invoked description carries the entry-point shape the README shows", () => {
	for (const skill of SKILLS.filter((s) => s.userInvoked)) {
		assert.ok(
			skill.description.startsWith(`User-invoked /skill:${skill.name}: `),
			`${skill.name}: ${skill.description.slice(0, 40)}`,
		);
	}
});

test("re-rendering the README changes nothing, and a missing marker pair is appended once", () => {
	assert.equal(renderReadme(README), README, "renderReadme must be idempotent on a current README");
	const bare = "# Title\n\nSome prose.\n";
	const once = renderReadme(bare);
	assert.ok(once.includes(BEGIN) && once.includes(END));
	assert.equal(renderReadme(once), once, "a second render is a no-op");
});
