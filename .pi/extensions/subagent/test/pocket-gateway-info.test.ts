// Unit tests for the token `gatewayInfo` hands to the CLI.
//
// The CLI talks to a daemon whose token comes from one of two places: the
// PI_POCKET_TOKEN environment variable, or the one `serve` mints into
// daemon.token on first run. `gatewayInfo` used to read only the environment, so
// after a first `/pocket serve` — which mints the file token and passes it to
// the daemon — every master command (pair, devices, revoke, new) sent no
// Authorization header and got 401 from the daemon it had just started. These
// pin that the saved token is used when the environment has none, and that an
// explicit one still wins.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { gatewayInfo } from "../../pocket/index.ts";
import { paths, type PocketConfig } from "../../pocket/config.ts";

function configFor(dataRoot: string, token?: string): PocketConfig {
	return {
		agentDir: dataRoot,
		dataRoot,
		host: "127.0.0.1",
		port: 8787,
		token,
		piBin: "pi",
		ntfyTopic: undefined,
		ntfyServer: "https://ntfy.sh",
		journalMax: 2000,
		respawnMax: 3,
		requestTimeoutMs: 30_000,
	};
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pocket-gateway-"));
	try {
		await mkdir(root, { recursive: true });
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("the saved operator token is used when the environment has none", async () => {
	await withRoot(async (root) => {
		await writeFile(paths.tokenFile(root), "saved-token\n", { mode: 0o600 });
		assert.equal(gatewayInfo(configFor(root)).token, "saved-token");
	});
});

test("PI_POCKET_TOKEN still wins over the saved file", async () => {
	await withRoot(async (root) => {
		await writeFile(paths.tokenFile(root), "saved-token\n", { mode: 0o600 });
		assert.equal(gatewayInfo(configFor(root, "env-token")).token, "env-token");
	});
});

test("no token anywhere stays undefined", async () => {
	await withRoot(async (root) => {
		assert.equal(gatewayInfo(configFor(root)).token, undefined);
	});
});

test("an empty or whitespace-only token file is no token", async () => {
	await withRoot(async (root) => {
		await writeFile(paths.tokenFile(root), "   \n", { mode: 0o600 });
		assert.equal(gatewayInfo(configFor(root)).token, undefined);
	});
});

test("the URL is loopback for the default host and literal otherwise", async () => {
	await withRoot(async (root) => {
		assert.equal(gatewayInfo(configFor(root)).url, "http://127.0.0.1:8787");
		assert.equal(gatewayInfo({ ...configFor(root), host: "0.0.0.0" }).url, "http://0.0.0.0:8787");
	});
});
