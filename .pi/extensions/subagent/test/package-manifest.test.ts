// The `pi` manifest in package.json is the only thing that makes this repo
// installable somewhere else, and it fails silently: with no manifest pi looks
// for conventional `extensions/` and `skills/` directories at the package root,
// finds none, and `pi install` reports success while loading nothing.
//
// So this asserts the manifest against the filesystem in both directions — every
// listed path exists, and every extension/skill in the tree is listed. Adding an
// extension and forgetting the manifest is the failure that actually happens.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	name?: string;
	private?: boolean;
	pi?: { extensions?: string[]; skills?: string[] };
};

test("package.json declares a pi manifest for this repo", () => {
	assert.equal(manifest.name, "my-agent-setup");
	assert.equal(manifest.private, true, "this repo is not published to npm");
	assert.ok(manifest.pi, "without a pi key the repo installs nothing");
	assert.ok((manifest.pi?.extensions?.length ?? 0) > 0);
	assert.ok((manifest.pi?.skills?.length ?? 0) > 0);
});

test("every path in the pi manifest exists", () => {
	for (const rel of [...(manifest.pi?.extensions ?? []), ...(manifest.pi?.skills ?? [])]) {
		assert.ok(existsSync(path.join(REPO_ROOT, rel)), `package.json lists a missing path: ${rel}`);
	}
});

test("every extension in .pi/extensions is listed in the manifest", () => {
	// Entry points only: a directory contributes its index.ts, and the rest of a
	// multi-file extension's directory is its internals. subagent/test/ is a test
	// suite that installs nothing.
	const entry = path.join(REPO_ROOT, ".pi/extensions");
	const expected: string[] = [];
	for (const name of readdirSync(entry)) {
		const full = path.join(entry, name);
		if (statSync(full).isDirectory()) {
			assert.ok(existsSync(path.join(full, "index.ts")), `${name}/ has no index.ts to install`);
			expected.push(`.pi/extensions/${name}/index.ts`);
		} else if (name.endsWith(".ts")) {
			expected.push(`.pi/extensions/${name}`);
		}
	}
	const listed = [...(manifest.pi?.extensions ?? [])].sort();
	assert.deepEqual(listed, expected.sort());
});

test("every skill in .pi/skills is listed in the manifest", () => {
	const skillsRoot = path.join(REPO_ROOT, ".pi/skills");
	const expected = readdirSync(skillsRoot)
		.filter((name) => statSync(path.join(skillsRoot, name)).isDirectory())
		.map((name) => `.pi/skills/${name}`)
		.sort();
	assert.deepEqual([...(manifest.pi?.skills ?? [])].sort(), expected);
});
