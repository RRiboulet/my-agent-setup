// Lifecycle tests for /btw panel reaping.
//
// Risk covered: a side panel is a second pi process with a tmux session, a
// an answer file (a Markdown copy of the side answer) and a socket file. Leaving any of
// them behind after a crash is both litter and a small disclosure; killing a
// panel whose owner is still running is worse. These tests pin the reason
// table, the owner-pid guard on both start and shutdown, the cross-session
// sweep, the kill-before-delete order, the failed-kill retry and idempotency.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { destroyBtwPanel, reapBtwPanels } from "../../btw/index.ts";
import { buildBtwPaths, btwRootDir } from "../../btw/launch.ts";
import { withTempAgentDir } from "./helpers.ts";

const SID = "01a14e96-1111-7000-8000-000000000001";
const OTHER = "01a14e96-2222-7000-8000-000000000002";
const THIRD = "01a14e96-3333-7000-8000-000000000003";
const CURRENT = "01a14e96-4444-7000-8000-000000000004";

interface ExecCall {
	command: string;
	args: string[];
}

interface FakeOptions {
	/** Make kill-server fail, leaving the session (and its server) up. */
	killFails?: boolean;
}

function fakeDeps(agentDir: string, isPidAlive: (pid: number) => boolean = () => false, options: FakeOptions = {}) {
	const calls: ExecCall[] = [];
	const notifications: { message: string; type: string }[] = [];
	// A seeded panel stands for a live server; a successful kill takes it down.
	let serverUp = true;
	return {
		calls,
		notifications,
		deps: {
			exec: async (command: string, args: string[]) => {
				calls.push({ command, args });
				if (args.includes("kill-server")) {
					if (options.killFails !== true) serverUp = false;
					return {
						code: options.killFails === true ? 1 : 0,
						stdout: "",
						stderr: options.killFails === true ? "kill failed" : "",
					};
				}
				if (args.includes("has-session")) {
					return serverUp
						? { code: 0, stdout: "", stderr: "" }
						: { code: 1, stdout: "", stderr: "no server" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
			notify: (message: string, type: "info" | "warning" | "error" = "info") => notifications.push({ message, type }),
			launch: () => undefined,
			agentDir,
			isPidAlive,
		},
	};
}

/** Create a panel dir for `sid`, owned by `pid` (omit for a missing owner file). */
async function seedPanel(agentDir: string, sid: string, pid?: number) {
	const paths = buildBtwPaths(agentDir, sid);
	await mkdir(paths.runDir, { recursive: true });
	await writeFile(path.join(paths.runDir, "answer.md"), "# old\n");
	if (pid !== undefined) await writeFile(paths.ownerPid, `${pid}\n`);
	await writeFile(paths.socket, "");
	return paths;
}

test("a live owner keeps its panel", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, 4242);
		const { calls, deps } = fakeDeps(agentDir, (pid) => pid === 4242);
		await reapBtwPanels(deps, "startup", SID);
		assert.deepEqual(calls, [], "no tmux call for a live owner");
		assert.equal(existsSync(paths.runDir), true);
		assert.equal(existsSync(paths.socket), true);
	});
});

test("a dead owner is killed, then its dir and socket are removed", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, 4242);
		const { calls, deps } = fakeDeps(agentDir, () => false);
		const sawRunDir: boolean[] = [];
		deps.exec = async (command, args) => {
			calls.push({ command, args });
			sawRunDir.push(existsSync(paths.runDir));
			if (args.includes("has-session")) return { code: 1, stdout: "", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		await reapBtwPanels(deps, "startup", SID);
		assert.ok(calls.some((call) => call.args.includes("kill-server")));
		assert.equal(sawRunDir[0], true, "the kill runs before the delete");
		assert.equal(existsSync(paths.runDir), false);
		assert.equal(existsSync(paths.socket), false);
	});
});

test("a missing or malformed owner file counts as dead", async () => {
	await withTempAgentDir(async (agentDir) => {
		const missing = await seedPanel(agentDir, SID);
		const malformed = await seedPanel(agentDir, OTHER, 4242);
		await writeFile(malformed.ownerPid, "not-a-pid\n");
		const { deps } = fakeDeps(agentDir, () => true);
		await reapBtwPanels(deps, "startup", SID);
		assert.equal(existsSync(missing.runDir), false);
		await reapBtwPanels(deps, "startup", OTHER);
		assert.equal(existsSync(malformed.runDir), false);
	});
});

test("the start reasons reap except reload", async () => {
	for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
		await withTempAgentDir(async (agentDir) => {
			const paths = await seedPanel(agentDir, SID, 4242);
			const { calls, deps } = fakeDeps(agentDir, () => false);
			await reapBtwPanels(deps, reason, SID);
			if (reason === "reload") {
				assert.deepEqual(calls, [], "reload keeps the panel");
				assert.equal(existsSync(paths.runDir), true);
			} else {
				assert.equal(existsSync(paths.runDir), false, reason);
			}
		});
	}
});

test("the shutdown reasons destroy our panel except reload", async () => {
	for (const reason of ["quit", "new", "resume", "fork", "reload"]) {
		await withTempAgentDir(async (agentDir) => {
			const paths = await seedPanel(agentDir, SID, process.pid);
			const { calls, deps } = fakeDeps(agentDir, () => true);
			await destroyBtwPanel(deps, reason, SID);
			if (reason === "reload") {
				assert.deepEqual(calls, [], "reload keeps the panel");
				assert.equal(existsSync(paths.runDir), true);
			} else {
				assert.ok(calls.some((call) => call.args.includes("kill-server")), reason);
				assert.equal(existsSync(paths.runDir), false, reason);
				assert.equal(existsSync(paths.socket), false, reason);
			}
		});
	}
});

test("shutdown leaves a live panel owned by another process alone", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, 4242);
		const { calls, deps } = fakeDeps(agentDir, (pid) => pid === 4242);
		await destroyBtwPanel(deps, "quit", SID);
		assert.deepEqual(calls, [], "another process's panel is not ours to close");
		assert.equal(existsSync(paths.runDir), true);
		assert.equal(existsSync(paths.socket), true);
	});
});

test("shutdown destroys a dead owner's panel", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, 4242);
		const { deps } = fakeDeps(agentDir, () => false);
		await destroyBtwPanel(deps, "quit", SID);
		assert.equal(existsSync(paths.runDir), false);
		assert.equal(existsSync(paths.socket), false);
	});
});

test("a failed kill keeps the dir and socket for a later retry", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, process.pid);
		const { calls, deps } = fakeDeps(agentDir, () => true, { killFails: true });
		await destroyBtwPanel(deps, "quit", SID);
		assert.ok(calls.some((call) => call.args.includes("kill-server")));
		assert.equal(existsSync(paths.runDir), true, "the answer outlives a failed kill");
		assert.equal(existsSync(paths.socket), true, "the socket is the only handle to retry");
	});
});

test("the sweep reaps dead orphans from other sessions and keeps live ones", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dead = await seedPanel(agentDir, OTHER, 1111);
		const live = await seedPanel(agentDir, THIRD, 2222);
		const { deps } = fakeDeps(agentDir, (pid) => pid === 2222);
		await reapBtwPanels(deps, "startup", CURRENT);
		assert.equal(existsSync(dead.runDir), false, "the dead orphan is reaped");
		assert.equal(existsSync(dead.socket), false);
		assert.equal(existsSync(live.runDir), true, "the live sibling survives");
		assert.equal(existsSync(live.socket), true);
	});
});

test("non-directory entries in the root are ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		const stray = path.join(btwRootDir(agentDir), "stray.txt");
		await mkdir(btwRootDir(agentDir), { recursive: true });
		await writeFile(stray, "not a panel\n");
		const { calls, deps } = fakeDeps(agentDir, () => true);
		await reapBtwPanels(deps, "startup", CURRENT);
		assert.deepEqual(calls, [], "a stray file is not a panel");
		assert.equal(existsSync(stray), true);
	});
});

test("a socket without a scratch dir is removed on shutdown", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = buildBtwPaths(agentDir, SID);
		await writeFile(paths.socket, "");
		const { deps } = fakeDeps(agentDir, () => true);
		await destroyBtwPanel(deps, "quit", SID);
		assert.equal(existsSync(paths.socket), false);
	});
});

test("shutdown is idempotent", async () => {
	await withTempAgentDir(async (agentDir) => {
		const paths = await seedPanel(agentDir, SID, process.pid);
		const { deps } = fakeDeps(agentDir, () => true);
		await destroyBtwPanel(deps, "quit", SID);
		await destroyBtwPanel(deps, "quit", SID);
		assert.equal(existsSync(paths.runDir), false);
		assert.equal(existsSync(paths.socket), false);
	});
});
