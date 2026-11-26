import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const REPO_ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const SCRIPT = path.join(REPO_ROOT, ".devcontainer/ensure-local-pi-stores.sh");
const POST_CREATE = path.join(REPO_ROOT, ".devcontainer/postCreate.sh");
const STORES = ["auth.json", "models-store.json"] as const;

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-local-stores-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function ensure(agentDir: string): void {
	const result = spawnSync("bash", [SCRIPT, agentDir], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
}

test("a fresh agent dir gets valid, private auth and model-store files", (t) => {
	const root = tempDir(t);
	const agentDir = path.join(root, "agent");

	ensure(agentDir);

	for (const name of STORES) {
		const file = path.join(agentDir, name);
		assert.equal(readFileSync(file, "utf8"), "{}\n");
		assert.equal(lstatSync(file).mode & 0o777, 0o600);
	}
	assert.equal(existsSync(path.join(agentDir, "models.json")), false, "models.json is an optional override, not a store to seed");
});

test("dangling links to the retired shared-state mount are replaced locally", (t) => {
	const agentDir = tempDir(t);
	for (const name of [...STORES, "models.json"]) {
		const target = name === "models-store.json" ? `/shared-pi-state/./${name}` : `/shared-pi-state/${name}`;
		symlinkSync(target, path.join(agentDir, name));
	}
	const unrelated = path.join(agentDir, "custom.json");
	symlinkSync("/somewhere/else/missing.json", unrelated);

	ensure(agentDir);

	for (const name of STORES) {
		const file = path.join(agentDir, name);
		assert.equal(lstatSync(file).isFile(), true, `${name} must become a local file`);
		assert.equal(readFileSync(file, "utf8"), "{}\n");
		assert.equal(lstatSync(file).mode & 0o777, 0o600);
	}
	assert.equal(existsSync(path.join(agentDir, "models.json")), false, "the retired optional override link must be removed");
	assert.equal(lstatSync(unrelated).isSymbolicLink(), true, "an unrelated link is not ours to delete");
	assert.equal(readlinkSync(unrelated), "/somewhere/else/missing.json");
});

test("existing credentials and catalogs survive repeated setup unchanged", (t) => {
	const agentDir = tempDir(t);
	const auth = path.join(agentDir, "auth.json");
	const modelsStore = path.join(agentDir, "models-store.json");
	const models = path.join(agentDir, "models.json");
	const authContent = '{"openrouter":{"type":"api_key","key":"test-only"}}\n';
	const storeContent = '{"openrouter":{"models":[{"id":"test-model"}]}}\n';
	const modelsContent = '{"providers":{"test":{"models":[]}}}\n';
	writeFileSync(auth, authContent);
	writeFileSync(modelsStore, storeContent);
	writeFileSync(models, modelsContent);
	chmodSync(auth, 0o644);

	ensure(agentDir);
	ensure(agentDir);

	assert.equal(readFileSync(auth, "utf8"), authContent);
	assert.equal(readFileSync(modelsStore, "utf8"), storeContent);
	assert.equal(readFileSync(models, "utf8"), modelsContent);
	assert.equal(lstatSync(auth).mode & 0o777, 0o600, "the credential store must be private");
});

test("a live store symlink is preserved without aborting setup", (t) => {
	const root = tempDir(t);
	const agentDir = path.join(root, "agent");
	const target = path.join(root, "external-auth.json");
	const content = '{"test":{"type":"api_key","key":"test-only"}}\n';
	mkdirSync(agentDir);
	writeFileSync(target, content);
	chmodSync(target, 0o644);
	const auth = path.join(agentDir, "auth.json");
	symlinkSync(target, auth);

	ensure(agentDir);

	assert.equal(lstatSync(auth).isSymbolicLink(), true);
	assert.equal(readlinkSync(auth), target);
	assert.equal(readFileSync(target, "utf8"), content);
	assert.equal(lstatSync(target).mode & 0o777, 0o644, "setup must not chmod through a user-managed symlink");
	assert.equal(readFileSync(path.join(agentDir, "models-store.json"), "utf8"), "{}\n");
});

test("an unrelated dangling store symlink fails visibly instead of being deleted", (t) => {
	const agentDir = tempDir(t);
	const auth = path.join(agentDir, "auth.json");
	symlinkSync("/somewhere/else/auth.json", auth);

	const result = spawnSync("bash", [SCRIPT, agentDir], { encoding: "utf8" });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /unexpected symlink/u);
	assert.equal(lstatSync(auth).isSymbolicLink(), true);
	assert.equal(readlinkSync(auth), "/somewhere/else/auth.json");
});

test("a non-regular store fails visibly instead of being replaced", (t) => {
	const agentDir = tempDir(t);
	mkdirSync(path.join(agentDir, "auth.json"));

	const result = spawnSync("bash", [SCRIPT, agentDir], { encoding: "utf8" });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /not a regular file/u);
	assert.equal(lstatSync(path.join(agentDir, "auth.json")).isDirectory(), true);
});

test("postCreate migrates local stores after ownership is fixed and before pi runs", () => {
	const lines = readFileSync(POST_CREATE, "utf8").split("\n");
	const call = /^\s*bash "\$\{?REPO\}?\/\.devcontainer\/ensure-local-pi-stores\.sh" "\$PROJECT_AGENT_DIR"$/u;
	const calls = lines.flatMap((line, index) => (call.test(line) ? [index] : []));
	assert.equal(calls.length, 1, "postCreate must run the local-store migration exactly once");

	const ownership = lines.findIndex((line) => /^\s*sudo chown -R\b/u.test(line));
	const mkdir = lines.findIndex((line) => line === 'mkdir -p "$PROJECT_AGENT_DIR"');
	const pi = lines.findIndex((line) => line.includes("pi update --models"));
	assert.ok(ownership >= 0 && mkdir >= 0 && pi >= 0, "postCreate must retain its ownership, mkdir and pi-update steps");
	assert.ok(ownership < (calls[0] as number), "the private volume must be writable before migration");
	assert.ok(mkdir < (calls[0] as number), "the agent dir must exist before migration");
	assert.ok((calls[0] as number) < pi, "pi must see the local stores before model catalogs are refreshed");
});
