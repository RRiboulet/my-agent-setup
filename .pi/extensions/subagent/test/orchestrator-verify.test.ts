// The verification command (ticket 09, R28): how a command line is invoked, how
// its result is classified, how much output is kept, and what the settlement
// boundary does with each outcome through the fake extension host.
//
// The rule this file protects is fail-open: only a command that ran to
// completion with a non-zero exit is evidence against the change. A timeout, an
// output cap, a shell that will not start or a result of the wrong shape settles
// the run and says so — the gate's own failure must never become the run's trap.
//
// The timeout path is exercised twice: once against the classifier with a
// scripted result, and once against a real process that has to be killed. The
// second is deliberately a real spawn — a test that only scripts `killed: true`
// cannot show that a session survives one.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { ExecResult } from "@earendil-works/pi-coding-agent";

import { gateConfigPath } from "../../orchestrator/config.ts";
import { GATE_ENTRY_TYPE, type GateVerdict } from "../../orchestrator/gate.ts";
import {
	boundVerificationOutput,
	classifyVerification,
	runVerification,
	verificationFailedOpen,
	verificationInvocation,
} from "../../orchestrator/verify.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { createFakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

type Entry = Record<string, unknown>;

function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
	return { stdout: "", stderr: "", code: 0, killed: false, truncated: false, ...overrides };
}

const SPEC = { command: "node --test", timeoutMs: 1_000, maxOutputBytes: 200 };

// --- Invocation and shaping -------------------------------------------------

test("a verification command runs through the platform's non-interactive shell", () => {
	assert.deepEqual(verificationInvocation("npm test", "linux"), { command: "bash", args: ["-lc", "npm test"] });
	assert.deepEqual(verificationInvocation("npm test", "darwin"), { command: "bash", args: ["-lc", "npm test"] });
	const windows = verificationInvocation("npm test", "win32");
	assert.equal(windows.command, "powershell");
	assert.ok(windows.args.includes("-NonInteractive"));
	assert.equal(windows.args.at(-1), "npm test");
});

test("verification output keeps both ends when it exceeds the cap", () => {
	assert.equal(boundVerificationOutput("short", "", 200), "short");
	assert.equal(boundVerificationOutput("", "only stderr", 200), "only stderr");
	assert.equal(boundVerificationOutput("out", "err", 200), "out\n--- stderr ---\nerr");

	const long = `${"A".repeat(600)}${"Z".repeat(600)}`;
	const bounded = boundVerificationOutput(long, "", 200);
	assert.ok(Buffer.byteLength(bounded, "utf8") < 400, "bounded output stays close to the cap");
	assert.match(bounded, /^A/, "the head survives");
	assert.match(bounded, /Z$/, "the tail survives — that is where a failing assertion lives");
	assert.match(bounded, /bytes omitted/);
});

test("classification names the reason a reader can act on", () => {
	assert.deepEqual(classifyVerification(execResult()), { status: "passed", exitCode: 0 });
	assert.deepEqual(classifyVerification(execResult({ code: 1 })), { status: "failed", exitCode: 1 });
	assert.deepEqual(classifyVerification(execResult({ code: 143, killed: true })), { status: "timed-out", exitCode: 143 });
	assert.deepEqual(
		classifyVerification(execResult({ code: 1, killed: true, truncated: true })),
		{ status: "truncated", exitCode: 1 },
		"an output cap is named as one, not as a timeout",
	);
	assert.deepEqual(classifyVerification({ nonsense: true }), { status: "unavailable", exitCode: null });
});

test("every status that says nothing about the change is fail-open", () => {
	assert.equal(verificationFailedOpen(null), false);
	assert.equal(verificationFailedOpen({ status: "passed" } as never), false);
	assert.equal(verificationFailedOpen({ status: "failed" } as never), false);
	for (const status of ["timed-out", "truncated", "unavailable"] as const) {
		assert.equal(verificationFailedOpen({ status } as never), true, status);
	}
});

test("runVerification maps passed, failed, killed, truncated, throwing and malformed results", async () => {
	const pass = await runVerification(SPEC, { exec: async () => execResult({ stdout: "ok" }) });
	assert.equal(pass.status, "passed");
	assert.equal(pass.exitCode, 0);
	assert.equal(pass.output, "ok");
	assert.equal(typeof pass.durationMs, "number");

	const fail = await runVerification(SPEC, {
		exec: async () => execResult({ stdout: "1 failing", stderr: "AssertionError: boom", code: 1 }),
	});
	assert.equal(fail.status, "failed");
	assert.equal(fail.exitCode, 1);
	assert.match(fail.output, /AssertionError: boom/);
	assert.match(fail.summary, /exit code 1/);

	const timeout = await runVerification(SPEC, { exec: async () => execResult({ code: 143, killed: true }) });
	assert.equal(timeout.status, "timed-out");
	assert.equal(timeout.killed, true);
	assert.match(timeout.summary, /terminated/);

	const truncated = await runVerification(SPEC, {
		exec: async () => execResult({ code: 1, killed: true, truncated: true, stdout: "x".repeat(500) }),
	});
	assert.equal(truncated.status, "truncated");
	assert.ok(Buffer.byteLength(truncated.output, "utf8") < 400);

	const threw = await runVerification(SPEC, {
		exec: async () => {
			throw new Error("spawn bash ENOENT");
		},
	});
	assert.equal(threw.status, "unavailable");
	assert.match(threw.summary, /ENOENT/);

	const malformed = await runVerification(SPEC, { exec: async () => ({}) as never });
	assert.equal(malformed.status, "unavailable");
});

test("runVerification passes the timeout, the output cap and the abort signal to the host", async () => {
	const seen: Record<string, unknown>[] = [];
	const controller = new AbortController();
	await runVerification(SPEC, {
		cwd: "/tmp/project",
		signal: controller.signal,
		exec: async (command, args, options) => {
			seen.push({ command, args, ...options });
			return execResult();
		},
	});
	assert.equal(seen[0]?.command, "bash");
	assert.deepEqual(seen[0]?.args, ["-lc", "node --test"]);
	assert.equal(seen[0]?.cwd, "/tmp/project");
	assert.equal(seen[0]?.timeout, 1_000);
	assert.equal(seen[0]?.maxBuffer, 200);
	assert.equal(seen[0]?.signal, controller.signal);
});

test("a real command that outlives its timeout is killed and reported, not passed", async () => {
	const startedAt = Date.now();
	const outcome = await runVerification(
		{ command: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 150, maxOutputBytes: 4_000 },
		{ exec: (command, args, options) => import("node:child_process").then(async ({ execFile }) => await new Promise<ExecResult>((resolve) => {
			execFile(command, args, { timeout: options?.timeout, maxBuffer: options?.maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
				const signal = (error as { signal?: string } | null)?.signal;
				const code = error ? (signal === "SIGKILL" ? 137 : 143) : 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code, killed: Boolean(error), truncated: false });
			});
		})) },
	);
	const elapsed = Date.now() - startedAt;
	assert.equal(outcome.status, "timed-out");
	assert.equal(outcome.killed, true);
	assert.ok(elapsed < 4_000, `the timeout must end the process, not wait it out (took ${elapsed} ms)`);
});

// --- The settlement boundary ------------------------------------------------

async function withTempProject<T>(config: unknown, fn: (cwd: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-verify-test-"));
	try {
		await mkdir(path.join(dir, ".pi"), { recursive: true });
		await writeFile(gateConfigPath(dir), JSON.stringify(config, null, 2));
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assistantCall(id: string, name: string, args: Record<string, unknown>): Entry {
	return {
		type: "message",
		id: `msg-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	};
}

function toolResult(id: string, toolName: string, options: { text?: string; isError?: boolean } = {}): Entry {
	return {
		type: "message",
		id: `result-${id}`,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: [{ type: "text", text: options.text ?? "ok" }],
			isError: options.isError ?? false,
		},
	};
}

function editedBranch(): Entry[] {
	return [assistantCall("e1", "edit", { path: "src/a.ts" }), toolResult("e1", "edit")];
}

function boundaryEvent(entries: Entry[] = []) {
	return { entries, continue: false, context: { pendingMessages: [] }, outcome: "completed" };
}

interface BoundaryProposal {
	entries?: ({ type?: string; customType?: string; data?: GateVerdict } & Entry)[];
	continue?: boolean;
}

function verdictOf(result: unknown): GateVerdict {
	const proposal = (result ?? {}) as BoundaryProposal;
	const entry = proposal.entries?.find((candidate) => candidate.customType === GATE_ENTRY_TYPE);
	assert.ok(entry?.data, "the boundary must record a verdict");
	return entry.data;
}

function continuationOf(result: unknown): string {
	const proposal = (result ?? {}) as BoundaryProposal;
	const entry = proposal.entries?.find((candidate) => candidate.type === "custom_message");
	return String(entry?.content ?? "");
}

function newHost(cwd: string, branch: Entry[] = [], exec?: (command: string, args: string[], options: Record<string, unknown>) => Promise<ExecResult>) {
	const host = createFakeHost({ sessionId: "orchestrator-verify-test", cwd, branch, exec: exec as never });
	orchestratorExtension(host.pi);
	return host;
}

test("with no configuration no command runs and nothing blocks", async () => {
	await withTempProject({ version: 1 }, async (cwd) => {
		const host = newHost(cwd, editedBranch());
		const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
		const verdict = verdictOf(result);
		assert.equal(verdict.decision, "report");
		assert.equal(verdict.verification, null);
		assert.equal(result.continue, undefined);
		assert.equal(host.execCalls.length, 0, "no command is configured, so nothing runs");
		// The report still names the unverified edits: ticket 08's proxy is kept
		// for the report, and there was no successful shell call.
		assert.ok(verdict.reasons.some((reason) => reason.code === "edits-without-verification"));
	});
});

test("a configured verification command that passes continues once with its result, then settles", async () => {
	await withTempProject(
		{ version: 1, verification: { command: "node -e 'process.exit(0)'", timeoutMs: 30_000 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch());
			const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const verdict = verdictOf(result);

			assert.equal(verdict.decision, "continue");
			assert.deepEqual(verdict.blockedBy, ["verification"]);
			assert.equal(verdict.verification?.status, "passed");
			assert.equal(verdict.attempts, 1);
			assert.equal(result.continue, true);
			assert.equal(host.execCalls.length, 1, "the gate ran the command once");
			assert.equal(host.execCalls[0]?.args[0], "-lc");
			assert.equal(host.execCalls[0]?.args[1], "node -e 'process.exit(0)'");

			const message = continuationOf(result);
			assert.match(message, /did not settle/);
			assert.match(message, /orchestrator_override/);
			assert.match(message, /passed/);

			// The next boundary sees the committed verdict: the passing run cleared
			// the edits, so it settles normally without running the command again.
			const settled = newHost(cwd, result.entries as Entry[]);
			const next = (await settled.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const nextVerdict = verdictOf(next);
			assert.equal(nextVerdict.decision, "report");
			assert.deepEqual(nextVerdict.blockedConditions, ["verification"]);
			assert.equal(settled.execCalls.length, 0, "a verified run is not asked twice");
		},
	);
});

test("a failed verification blocks again until overridden, and the override is consumed", async () => {
	await withTempProject(
		{ version: 1, verification: { command: "node -e \"process.stderr.write('boom'); process.exit(1)\"", timeoutMs: 30_000 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch());
			const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const verdict = verdictOf(result);
			assert.equal(verdict.decision, "continue");
			assert.equal(verdict.verification?.status, "failed");
			assert.equal(verdict.verification?.exitCode, 1);
			assert.match(continuationOf(result), /boom/);

			// Unchanged evidence blocks again and spends another attempt; the command
			// is not re-run for evidence it already checked.
			const same = [...editedBranch(), ...(result.entries as Entry[])];
			const settled = newHost(cwd, same);
			const next = (await settled.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const nextVerdict = verdictOf(next);
			assert.equal(nextVerdict.decision, "continue");
			assert.equal(nextVerdict.attempts, 2);
			assert.equal(nextVerdict.verification?.status, "failed", "the last outcome is carried into the repeated block");
			assert.equal(settled.execCalls.length, 0, "the same evidence is not re-verified");

			// An override settles it without spending another attempt.
			const overridden = newHost(cwd, [...same, ...(next.entries as Entry[])]);
			await overridden.fire("session_start", {});
			await overridden.callTool("orchestrator_override", { reason: "ship the failure" });
			const done = (await overridden.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(done.continue, undefined);
			assert.equal(verdictOf(done).decision, "report");
			assert.equal(verdictOf(done).attempts, 2);
			assert.equal(verdictOf(done).override?.reason, "ship the failure");
		},
	);
});

test("fixing the same file re-runs verification instead of trusting the path set", async () => {
	// A path set alone cannot distinguish "failed on src/a.ts" from "edited
	// src/a.ts again after that failure"; the edit count in the evidence does.
	let runs = 0;
	const exec = async () => {
		runs++;
		return runs === 1
			? { code: 1, killed: false, truncated: false, stdout: "", stderr: "fail" }
			: { code: 0, killed: false, truncated: false, stdout: "ok", stderr: "" };
	};
	await withTempProject(
		{ version: 1, verification: { command: "node --test", timeoutMs: 30_000 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch(), exec);
			const first = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(verdictOf(first).verification?.status, "failed");
			assert.equal(runs, 1);

			const fixedEdit = [assistantCall("e2", "edit", { path: "src/a.ts" }), toolResult("e2", "edit")];
			const fixed = newHost(cwd, [...editedBranch(), ...(first.entries as Entry[]), ...fixedEdit], exec);
			const second = (await fixed.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(runs, 2, "the same file edited again is a new verification state");
			assert.equal(verdictOf(second).verification?.status, "passed");
			assert.equal(verdictOf(second).attempts, 2);
		},
	);
});

test("an exhausted block budget does not switch verification off", async () => {
	const exec = async () => ({ code: 0, killed: false, truncated: false, stdout: "ok", stderr: "" });
	await withTempProject(
		{ version: 1, attemptCap: 1, verification: { command: "node --test", timeoutMs: 30_000 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch(), exec);
			const first = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(verdictOf(first).attempts, 1);
			assert.equal(host.execCalls.length, 1);

			const newEdit = [assistantCall("e2", "edit", { path: "src/b.ts" }), toolResult("e2", "edit")];
			const afterCap = newHost(cwd, [...editedBranch(), ...(first.entries as Entry[]), ...newEdit], exec);
			const report = (await afterCap.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(verdictOf(report).decision, "report", "the cap settles the run");
			assert.equal(afterCap.execCalls.length, 1, "but a new verification state is still checked");
		},
	);
});

test("a verification command that exceeds its timeout is reported as failed-open and the run settles", async () => {
	await withTempProject(
		{ version: 1, verification: { command: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 150 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch());
			const startedAt = Date.now();
			const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const elapsed = Date.now() - startedAt;
			const verdict = verdictOf(result);

			assert.equal(verdict.decision, "report", "a timeout must settle, not block");
			assert.equal(result.continue, undefined);
			assert.equal(verdict.verification?.status, "timed-out");
			assert.equal(verdict.verification?.killed, true);
			assert.ok(verdict.reasons.some((reason) => reason.code === "verification-fail-open"));
			assert.ok(
				verdict.conditions.some((condition) => condition.kind === "verification" && condition.status === "unknown"),
				"the timeout is visible in the verdict",
			);
			assert.equal(verdict.attempts, 0, "a fail-open settlement spends no attempt");
			assert.ok(elapsed < 4_000, `the session must not wait for the command (took ${elapsed} ms)`);

			// The session is still usable: the next boundary evaluates again, `/gate`
			// answers, and a tool call is not blocked by anything left behind.
			await host.fire("turn_start", { turnIndex: 1 });
			assert.equal(await host.fire("tool_call", { toolName: "bash", input: { command: "ls" } }), undefined);
			const again = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(verdictOf(again).decision, "report");
			await host.runCommand("gate");
			assert.match(String(host.messages.at(-1)?.message.content ?? ""), /timed-out|terminated/);
		},
	);
});

test("a verification command the host cannot run is reported as unavailable and settles", async () => {
	await withTempProject(
		{ version: 1, verification: { command: "npm test", timeoutMs: 5_000 } },
		async (cwd) => {
			const host = newHost(cwd, editedBranch(), async () => {
				throw new Error("spawn bash ENOENT");
			});
			const result = (await host.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			const verdict = verdictOf(result);
			assert.equal(verdict.decision, "report");
			assert.equal(verdict.verification?.status, "unavailable");
			assert.match(verdict.verification?.summary ?? "", /ENOENT/);
		},
	);
});

test("the command is not run when the run made no edits, and not in a child session", async () => {
	await withTempProject(
		{ version: 1, verification: { command: "node -e 'process.exit(0)'", timeoutMs: 30_000 } },
		async (cwd) => {
			const clean = newHost(cwd, []);
			const cleanResult = (await clean.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
			assert.equal(verdictOf(cleanResult).decision, "report");
			assert.equal(clean.execCalls.length, 0, "no edits, nothing to verify");

			await withEnv({ PI_TMUX_SUBAGENT_CHILD: "1" }, async () => {
				const child = newHost(cwd, editedBranch());
				const childResult = (await child.fire("agent_before_settle", boundaryEvent())) as BoundaryProposal;
				const verdict = verdictOf(childResult);
				assert.equal(verdict.scope, "child");
				assert.equal(verdict.decision, "report");
				assert.equal(child.execCalls.length, 0, "a child runs no command and blocks nothing");
				assert.ok(verdict.reasons.some((reason) => reason.code === "blocking-suppressed"));
			});
		},
	);
});
