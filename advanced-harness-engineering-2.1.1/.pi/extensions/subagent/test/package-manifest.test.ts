// The `pi` manifest in package.json is the only thing that makes this repo
// installable somewhere else, and it fails silently: with no manifest pi looks
// for conventional `extensions/` and `skills/` directories at the package root,
// finds none, and `pi install` reports success while loading nothing.
//
// So this asserts the manifest against the filesystem in both directions — every
// listed path exists, and every extension/skill in the tree is listed. Adding an
// extension and forgetting the manifest is the failure that actually happens.

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
	name?: string;
	private?: boolean;
	pi?: { extensions?: string[]; skills?: string[] };
};

test("package.json declares a pi manifest for this repo", () => {
	assert.equal(manifest.name, "advanced-harness-engineering");
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

test("every skill in skills/ is listed in the manifest", () => {
	const skillsRoot = path.join(REPO_ROOT, "skills");
	const expected = readdirSync(skillsRoot)
		.filter((name) => statSync(path.join(skillsRoot, name)).isDirectory())
		.map((name) => `skills/${name}`)
		.sort();
	assert.deepEqual([...(manifest.pi?.skills ?? [])].sort(), expected);
});

test("DefaultResourceLoader discovers all 32 skills in package-free mode with no collisions", async (t) => {
	const tmpRoot = mkdtempSync(path.join(tmpdir(), "pi-package-free-skills-"));
	const agentDir = path.join(tmpRoot, "agent");
	const homeDir = path.join(tmpRoot, "home");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(homeDir, { recursive: true });

	const prevHome = process.env.HOME;
	const prevUserProfile = process.env.USERPROFILE;
	const restoreEnv = () => {
		if (prevHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = prevHome;
		}
		if (prevUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = prevUserProfile;
		}
	};
	t.after(() => {
		restoreEnv();
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;

	try {
		const loader = new DefaultResourceLoader({
			cwd: REPO_ROOT,
			agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();

		const { skills, diagnostics } = loader.getSkills();
		const collisions = diagnostics.filter((d) => d.type === "collision");
		assert.deepEqual(collisions, []);

		const expectedNames = (manifest.pi?.skills ?? []).map((rel) => path.basename(rel)).sort();
		assert.equal(expectedNames.length, 32);
		assert.equal(skills.length, 32);
		assert.deepEqual(
			skills.map((skill) => skill.name).sort(),
			expectedNames,
		);
	} finally {
		restoreEnv();
	}
});
