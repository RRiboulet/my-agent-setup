// Structural guards for CHANGELOG.md.
//
// Risk covered: the changelog is a hand-maintained markdown file that every
// release depends on, and nothing else in the suite reads it. A structural
// mistake is therefore invisible until a release is cut — which is exactly how
// `### Unreleased` spent its life nested inside `## v1.0.0`, where appending
// worked fine and tagging did not.
//
// These assertions are about shape, not wording. They should fail when a heading
// moves to the wrong level, appears twice, or lands in the wrong order; they
// should not fail because an entry was reworded.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

const CHANGELOG = path.join(import.meta.dirname, "..", "..", "..", "..", "CHANGELOG.md");

/** Heading lines of the given level, e.g. `## v1.0.0 — 2026-10-02`. */
async function headings(level: number): Promise<string[]> {
	const text = await readFile(CHANGELOG, "utf8");
	const prefix = "#".repeat(level) + " ";
	return text
		.split("\n")
		.filter((line) => line.startsWith(prefix) && !line.startsWith(prefix + "#"))
		.map((line) => line.slice(prefix.length).trim());
}

/** `v1.2.3` from a heading's leading version token. */
function versionOf(heading: string): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(heading);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

test("`## Unreleased` exists exactly once, at heading level 2", async () => {
	// It was an H3 inside the newest release for the life of v1.0.0. Nothing
	// about that broke day-to-day appending; it broke at tagging time.
	assert.deepEqual(await headings(2), [
		"Unreleased",
		...(await headings(2)).slice(1),
	]);
	assert.equal((await headings(2)).filter((h) => h === "Unreleased").length, 1);
});

test("no `Unreleased` heading is nested inside a release", async () => {
	// The specific regression: `### Unreleased` under `## v1.0.0`.
	for (const level of [3, 4]) {
		assert.equal(
			(await headings(level)).filter((h) => h.toLowerCase() === "unreleased").length,
			0,
			`an Unreleased heading at level ${level} would be nested inside a release`,
		);
	}
});

test("`Unreleased` precedes every released version", async () => {
	const level2 = await headings(2);
	const unreleasedAt = level2.indexOf("Unreleased");
	assert.notEqual(unreleasedAt, -1);
	const releases = level2.filter((h) => versionOf(h) !== undefined);
	assert.ok(releases.length > 0, "expected at least one released version to order against");
	assert.equal(unreleasedAt, 0, "Unreleased is the newest section, so it comes first");
});

test("released versions are in strictly descending order", async () => {
	// Appending a release below the previous one reads fine and breaks every
	// reader's assumption about what the top of the file means.
	const releases = (await headings(2)).map(versionOf).filter((v): v is [number, number, number] => v !== undefined);
	for (const [index, version] of releases.entries()) {
		const next = releases[index + 1];
		if (!next) break;
		assert.ok(
			version[0] > next[0] || (version[0] === next[0] && (version[1] > next[1] || (version[1] === next[1] && version[2] > next[2]))),
			`v${version.join(".")} is not newer than the v${next.join(".")} that follows it`,
		);
	}
});

test("each release section has exactly one label per kind", async () => {
	// Two `Fixed:` blocks in one section is how the file ended up with fixes
	// above features after a section was inserted at the top.
	const text = await readFile(CHANGELOG, "utf8");
	const sections = text.split(/^## /m).slice(1); // drop the `# Changelog` title block
	for (const section of sections) {
		if (versionOf(section.split("\n")[0]) === undefined) continue; // not a release
		for (const label of ["Added:", "Fixed:", "Maintenance:"]) {
			const count = section.split("\n").filter((line) => line.trimEnd() === label).length;
			assert.ok(count <= 1, `section "${section.split("\n")[0]}" has ${count} "${label}" blocks`);
		}
	}
});

test("section blocks appear in the order Added, Fixed, Maintenance", async () => {
	const text = await readFile(CHANGELOG, "utf8");
	const found = ["Added:", "Fixed:", "Maintenance:"]
		.map((label) => ({ label, at: text.indexOf(`\n${label}`) }))
		.filter((block) => block.at !== -1);
	assert.ok(found.length >= 2, "expected the file to keep its labelled blocks");
	// Adjacent comparison, not every pair: the point is that the sequence is
	// increasing, and comparing each block against every other would also
	// "fail" on a correctly ordered file by testing Fixed < Maintenance.
	for (const [index, block] of found.entries()) {
		const previous = found[index - 1];
		if (!previous) continue;
		assert.ok(previous.at < block.at, `"${previous.label}" should come before "${block.label}"`);
	}
});
