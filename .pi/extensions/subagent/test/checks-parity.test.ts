// The CI gate in .github/workflows/checks.yml must run every check AGENTS.md's
// `## Tests` block names — no more, no fewer, in the same order.
//
// Risk covered: the Tests block is the list a session actually runs, and CI is
// the list that decides whether a pull request is green. When they drift, the
// suite passes locally and the missing check is discovered by reviewing the
// workflow by eye, which is how `node tools/skills-index.mjs --check` was named
// in AGENTS.md but never run in CI. A comment in the workflow saying "the gate,
// run the way AGENTS.md runs it" did not catch it; this comparison does.
//
// Which steps are GATES and which are ENVIRONMENT PREP is a judgement, made
// explicitly below rather than guessed from the step name:
//
// - A GATE is a check whose exit status is a verdict on the change. It is
//   listed in AGENTS.md's Tests block (all of that block except the setup line)
//   and must appear as a `run:` step in checks.yml, in the same order.
// - PREP makes the gates runnable on a clean runner. It proves nothing about
//   the change, so it is not a gate and is not in AGENTS.md's gate list:
//   checkout and Node setup (`uses:` steps, no command at all), installing pi
//   globally (setup-deps.sh links those packages), fetching origin/dev (the
//   branch-base gate compares against it), and running setup-deps.sh itself.
//   The last one is named in AGENTS.md too, but annotated `once: link pi's
//   packages` — it is prep in both places, which is why it is listed as prep
//   on both sides rather than counted as a gate.
//
// Both directions are asserted. A gate added to AGENTS.md and not to CI fails;
// so does a `run:` step added to CI that AGENTS.md never names, and so does
// reordering the CI gates away from the order a session runs them in.
//
// Node stdlib only: the YAML here is a flat list of `- name:` / `run:` steps,
// so it is read line by line, and the one shape this reader cannot see (a
// `run: |` block scalar) fails loudly instead of being skipped.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const AGENTS = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
const WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "checks.yml"), "utf8");

/**
 * Prep, on the AGENTS.md side. The Tests block opens with the one-time link step
 * and annotates it `once`; it is listed in CI as its own step before any test
 * tree because a clean runner has no globally installed pi to link.
 */
const AGENTS_PREP = new Map([
	[
		"bash .pi/extensions/subagent/test/setup-deps.sh",
		"AGENTS.md annotates it `once: link pi's packages`; CI runs it as its own step before the first test tree.",
	],
]);

/** Prep, on the CI side: runnable setup whose exit status is not a verdict on the change. */
const CI_PREP = new Map([
	[
		"npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@1.6.1",
		"install pi, because setup-deps.sh links the globally installed packages",
	],
	["git fetch origin dev", "the branch-base gate compares against origin/dev"],
	[
		"bash .pi/extensions/subagent/test/setup-deps.sh",
		"link pi's packages into node_modules; the subagent suite imports them",
	],
]);

/**
 * One command, as both files write it differently but mean the same thing:
 * AGENTS.md annotates each line with `# ...`, wraps the provider tree in
 * parentheses to mark a separate tree, and pads with spaces.
 */
function normalize(command: string): string {
	let text = command.replace(/\s+#.*$/, "").trim();
	const grouped = /^\((.*)\)$/.exec(text);
	if (grouped) text = grouped[1].trim();
	return text.replace(/\s+/g, " ");
}

/** The commands in AGENTS.md's `## Tests` fenced block(s), in the order a session runs them. */
function agentsCommands(agents: string): string[] {
	const lines = agents.split("\n");
	const heading = lines.findIndex((line) => /^## Tests\s*$/.test(line));
	assert.notEqual(heading, -1, "AGENTS.md has no `## Tests` heading");
	const end = lines.findIndex((line, index) => index > heading && /^## /.test(line));
	const section = lines.slice(heading + 1, end === -1 ? undefined : end);

	const commands: string[] = [];
	let inFence = false;
	for (const line of section) {
		if (line.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) continue;
		if (!line.trim() || line.trim().startsWith("#")) continue;
		commands.push(normalize(line));
	}
	assert.ok(commands.length > 0, "AGENTS.md's `## Tests` block has no commands");
	return commands;
}

interface CiStep {
	name: string;
	command?: string;
}

/** Every step in checks.yml, with its `run:` command when it has one. */
function ciSteps(workflow: string): CiStep[] {
	const steps: CiStep[] = [];
	let inSteps = false;
	let itemIndent: number | undefined;
	let current: CiStep | undefined;

	for (const [index, raw] of workflow.split("\n").entries()) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;

		if (!inSteps) {
			if (/^\s*steps:\s*$/.test(line)) inSteps = true;
			continue;
		}
		// A non-blank line at the job's own indent closes the step list.
		if (indent <= 4) {
			inSteps = false;
			continue;
		}

		const item = /^(\s*)-\s+(.*)$/.exec(line);
		if (item) {
			if (itemIndent === undefined) itemIndent = item[1].length;
			if (item[1].length !== itemIndent) continue; // a nested list inside a step
			if (current) steps.push(current);
			current = { name: "" };
			readKey(current, item[2], index + 1);
			continue;
		}

		assert.ok(current, `checks.yml line ${index + 1} is not inside a step: ${line.trim()}`);
		readKey(current, line.trim(), index + 1);
	}
	if (current) steps.push(current);
	assert.ok(steps.length > 0, "no steps parsed out of checks.yml");

	function readKey(step: CiStep, text: string, lineNumber: number): void {
		const match = /^(name|run|uses):\s*(.*)$/.exec(text);
		if (!match) return; // `with:`, `env:`, their children, `if:`, `id:` ...
		const [, key, value] = match;
		if (key === "name") step.name = value.trim();
		if (key === "uses") step.name = step.name || value.trim();
		if (key === "run") {
			assert.ok(
				!/^[|>]/.test(value.trim()),
				`checks.yml line ${lineNumber}: this reader only understands single-line \`run:\` scalars; teach it block scalars before adding one`,
			);
			assert.equal(step.command, undefined, `checks.yml line ${lineNumber}: two run: keys in one step`);
			step.command = normalize(value);
		}
	}

	return steps;
}

const AGENTS_COMMANDS = agentsCommands(AGENTS);
const STEPS = ciSteps(WORKFLOW);
const CI_COMMANDS = STEPS.flatMap((step) => (step.command === undefined ? [] : [step.command]));

/** AGENTS.md's gates: its Tests commands minus the prep line. */
const EXPECTED = AGENTS_COMMANDS.filter((command) => !AGENTS_PREP.has(command));
/** checks.yml's gates: its `run:` commands minus documented prep. */
const ACTUAL = CI_COMMANDS.filter((command) => !CI_PREP.has(command));

test("every gate AGENTS.md names runs in CI, in the same order", () => {
	assert.deepEqual(
		ACTUAL,
		EXPECTED,
		"checks.yml's gate list must be AGENTS.md's `## Tests` list (setup-deps.sh is prep); add the missing step where AGENTS.md orders it",
	);
});

test("a `run:` step in checks.yml that AGENTS.md never names is not a gate", () => {
	const named = new Set(EXPECTED);
	for (const command of ACTUAL) {
		assert.ok(named.has(command), `checks.yml runs \`${command}\`, which AGENTS.md's \`## Tests\` block does not name`);
	}
});

test("the documented prep steps still exist, exactly once each", () => {
	for (const command of AGENTS_PREP.keys()) {
		assert.equal(
			AGENTS_COMMANDS.filter((entry) => entry === command).length,
			1,
			`AGENTS.md's Tests block no longer names the prep step \`${command}\``,
		);
	}
	for (const command of CI_PREP.keys()) {
		assert.equal(
			CI_COMMANDS.filter((entry) => entry === command).length,
			1,
			`checks.yml no longer has the prep step \`${command}\`; if it moved, update CI_PREP and this test`,
		);
	}
});

test("every gate step is named, and its name is not confusable with prep", () => {
	for (const step of STEPS) {
		if (step.command === undefined || CI_PREP.has(step.command)) continue;
		assert.ok(step.name.length > 0, `checks.yml runs \`${step.command}\` in an unnamed step`);
	}
});
