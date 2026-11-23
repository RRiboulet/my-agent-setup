// The orchestrator's process-level role: is this process the parent that owns a
// run, or a delegated worker that must never act on the gate's behalf?
//
// Why this is its own test file. The role used to be read from
// `PI_TMUX_SUBAGENT_CHILD` at every call site, and the subagent factory deletes
// that variable during startup so a `pi` spawned from a child's shell tool
// cannot re-enter child mode. By the first `agent_before_settle` the guard was
// gone, and a child ran the project's verification command and blocked its own
// settlement. The role is therefore resolved ONCE at module load, and the tests
// below pin both halves of that: the pure resolution rule, and the fact that the
// module-load constant cannot be changed afterwards by scrubbing the
// environment.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import subagentExtension from "../index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";
import { ORCHESTRATOR_ROLE, isWorkerRole, resolveOrchestratorRole } from "../../orchestrator/role.ts";

test("a process with no role marker is the parent", () => {
	assert.equal(resolveOrchestratorRole({}), "parent");
	assert.equal(isWorkerRole("parent"), false);
});

test("the documented worker marker makes a process a worker, case and whitespace tolerant", () => {
	assert.equal(resolveOrchestratorRole({ PI_ORCHESTRATOR_ROLE: "worker" }), "worker");
	assert.equal(resolveOrchestratorRole({ PI_ORCHESTRATOR_ROLE: "  Worker \n" }), "worker");
	assert.equal(isWorkerRole("worker"), true);
});

test("anything but the documented worker value leaves the process a parent", () => {
	for (const value of ["", "  ", "parent", "workers", "0", "true", "WORK"]) {
		assert.equal(resolveOrchestratorRole({ PI_ORCHESTRATOR_ROLE: value }), "parent", `"${value}" is not a role`);
	}
});

test("the legacy PI_TMUX_SUBAGENT_CHILD=1 marker still marks a worker", () => {
	// A child launched by a build that predates the role marker must still be
	// recognised, or delegating from an older parent would un-guard the child.
	assert.equal(resolveOrchestratorRole({ PI_TMUX_SUBAGENT_CHILD: "1" }), "worker");
	assert.equal(resolveOrchestratorRole({ PI_TMUX_SUBAGENT_CHILD: "0" }), "parent");
	assert.equal(resolveOrchestratorRole({ PI_TMUX_SUBAGENT_CHILD: "yes" }), "parent");
});

test("the resolution reads the environment it is given, not the process", () => {
	// Pure, so a caller can ask "what would this environment be?" without
	// touching `process.env`. This is what makes the module testable at all.
	assert.equal(resolveOrchestratorRole({ PI_ORCHESTRATOR_ROLE: "worker" }), "worker");
	assert.equal(resolveOrchestratorRole(), resolveOrchestratorRole(process.env));
});

test("the module-load constant survives a later scrub of the environment", () => {
	// The bug this file exists for: the subagent factory deletes
	// `PI_TMUX_SUBAGENT_CHILD` after startup, and an extension that re-read the
	// environment at the settlement boundary then saw a parent.
	const savedRole = process.env.PI_ORCHESTRATOR_ROLE;
	const savedChild = process.env.PI_TMUX_SUBAGENT_CHILD;
	const constantAtLoad = ORCHESTRATOR_ROLE;
	try {
		process.env.PI_ORCHESTRATOR_ROLE = "worker";
		// Resolved once, into a value the caller keeps — the same shape as the
		// module's own constant.
		const resolvedOnce = resolveOrchestratorRole();
		assert.equal(resolvedOnce, "worker");
		assert.equal(isWorkerRole(resolvedOnce), true);

		// The scrub: both markers gone, exactly as the subagent factory leaves the
		// environment.
		delete process.env.PI_ORCHESTRATOR_ROLE;
		delete process.env.PI_TMUX_SUBAGENT_CHILD;

		assert.equal(resolvedOnce, "worker", "a role copied into a value does not follow the environment");
		assert.equal(ORCHESTRATOR_ROLE, constantAtLoad, "the module-load constant is not re-read after load");
	} finally {
		if (savedRole === undefined) delete process.env.PI_ORCHESTRATOR_ROLE;
		else process.env.PI_ORCHESTRATOR_ROLE = savedRole;
		if (savedChild === undefined) delete process.env.PI_TMUX_SUBAGENT_CHILD;
		else process.env.PI_TMUX_SUBAGENT_CHILD = savedChild;
	}
});

test("the legacy marker resolves to the same role as the documented one", () => {
	assert.deepEqual(
		resolveOrchestratorRole({ PI_TMUX_SUBAGENT_CHILD: "1" }),
		resolveOrchestratorRole({ PI_ORCHESTRATOR_ROLE: "worker" }),
	);
});

/**
 * Evaluate the module in a fresh Node process, as the launcher does for a child.
 *
 * The tests above resolve a role from an object in *this* process, whose module
 * was already loaded as a parent. That cannot prove the load-time rule, because
 * the constant is fixed once per module instance. A spawned process gets its own
 * instance and its own environment, which is the only faithful model of a
 * delegated child — and the only way to show that a scrub *after* import leaves
 * the role alone.
 */
function roleInFreshProcess(env: NodeJS.ProcessEnv, afterImport = ""): string {
	const href = new URL("../../orchestrator/role.ts", import.meta.url).href;
	const script = [
		`const m = await import(${JSON.stringify(href)});`,
		afterImport,
		"process.stdout.write(m.ORCHESTRATOR_ROLE);",
	].join("\n");
	return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env,
		encoding: "utf8",
	});
}

function withoutRoleMarkers(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_ORCHESTRATOR_ROLE;
	delete env.PI_TMUX_SUBAGENT_CHILD;
	return env;
}

test("a fresh process launched with the worker marker evaluates as a worker", () => {
	assert.equal(
		roleInFreshProcess({ ...withoutRoleMarkers(), PI_ORCHESTRATOR_ROLE: "worker" }),
		"worker",
	);
});

test("scrubbing the marker after import does not change the role a process loaded", () => {
	// The subagent factory deletes its child-mode variables during startup. The
	// role must already be fixed by then, or the gate is unguarded at the boundary.
	assert.equal(
		roleInFreshProcess(
			{ ...withoutRoleMarkers(), PI_ORCHESTRATOR_ROLE: "worker" },
			"delete process.env.PI_ORCHESTRATOR_ROLE; delete process.env.PI_TMUX_SUBAGENT_CHILD;",
		),
		"worker",
	);
});

test("a fresh process with no markers evaluates as the parent", () => {
	assert.equal(roleInFreshProcess(withoutRoleMarkers()), "parent");
});

/**
 * Drive the real factory in a fresh process, so the role under test is the one
 * its module-load default resolved from the launcher's environment.
 *
 * The factory tests inject `{ role }` to reach the worker path; that seam is
 * useful but it cannot fail if the default wiring regresses to "parent". This
 * spawns a process with the marker set and reads the verdict the factory
 * actually produced, which is the path a delegated child takes.
 */
function factoryVerdictInFreshProcess(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
	const fakeHref = new URL("./fake-pi.ts", import.meta.url).href;
	const indexHref = new URL("../../orchestrator/index.ts", import.meta.url).href;
	const script = [
		`const { createFakeHost } = await import(${JSON.stringify(fakeHref)});`,
		`const { default: orchestratorExtension } = await import(${JSON.stringify(indexHref)});`,
		'const host = createFakeHost({ sessionId: "role-default", cwd: process.cwd(), trusted: true });',
		"orchestratorExtension(host.pi);",
		'const result = await host.fire("agent_before_settle", { entries: [], continue: false, outcome: "completed", context: {} });',
		'const entry = (result?.entries ?? []).find((item) => item.customType === "orchestrator-gate");',
		'process.stdout.write(JSON.stringify(entry?.data ?? null));',
	].join("\n");
	const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env,
		encoding: "utf8",
	});
	return JSON.parse(out) as Record<string, unknown> | null;
}

test("the factory's default role comes from the launcher's environment", () => {
	const worker = factoryVerdictInFreshProcess({
		...withoutRoleMarkers(),
		PI_ORCHESTRATOR_ROLE: "worker",
	});
	assert.equal(worker?.scope, "child", "the env marker must reach the factory, not only role.ts");
	assert.equal(worker?.decision, "report");

	const parent = factoryVerdictInFreshProcess(withoutRoleMarkers());
	assert.equal(parent?.scope, "parent");
});

test("a child scrubs the worker marker at session_start, after every factory has read it", async () => {
	// The marker must survive the child factory (the orchestrator may load after
	// it) and be gone before any tool could spawn a nested pi. Scrubbing at
	// session_start is the point that satisfies both.
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-role-scrub-"));
	const resultPath = path.join(dir, "run", "result.json");
	await mkdir(path.dirname(resultPath), { recursive: true });
	try {
		await withEnv(
		{
			PI_TMUX_SUBAGENT_CHILD: "1",
			PI_TMUX_SUBAGENT_RESULT: resultPath,
			PI_ORCHESTRATOR_ROLE: "worker",
		},
		async () => {
			const host = createFakeHost({ sessionId: "child-role-scrub" });
			subagentExtension(host.pi);
			assert.equal(
				process.env.PI_ORCHESTRATOR_ROLE,
				"worker",
				"the factory must not scrub a marker the orchestrator may not have read yet",
			);
			await host.fire("session_start", {});
			assert.equal(
				process.env.PI_ORCHESTRATOR_ROLE,
				undefined,
				"a nested pi launched from this worker's shell must not inherit the worker role",
			);
		},
	);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
