// Integration tests for `.pi/extensions/orchestrator/wave-runtime.ts` wired into
// `orchestratorExtension` (`orchestrator/index.ts`).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { ORCHESTRATION_EVENTS, ORCHESTRATOR_CUSTOM_TYPES } from "../../orchestrator/events.ts";
import { gateConfigPath } from "../../orchestrator/config.ts";
import { GATE_ENTRY_TYPE, GATE_OVERRIDE_TOOL, type GateVerdict } from "../../orchestrator/gate.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { WAVE_ENTRY_TYPE, canRunGitCommit, reconstructWaveState } from "../../orchestrator/wave.ts";
import {
	WAVE_COMMAND,
	WAVE_KICKOFF_TYPE,
	WAVE_STATUS_TYPE,
	WAVE_TOOL,
} from "../../orchestrator/wave-runtime.ts";
import { createFakeHost, type FakeHostOptions } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

function withIsolatedWaveEnv<T>(t: test.TestContext, fn: () => Promise<T>): Promise<T> {
	const fakeHome = mkdtempSync(path.join(tmpdir(), "orchestrator-wave-home-"));
	t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
	return withEnv({ HOME: fakeHome, PI_ORCHESTRATE_LADDER: undefined, PI_CODING_AGENT_DIR: undefined }, fn);
}

function makeTempGitRepo(t: test.TestContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), "orchestrator-wave-runtime-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.email", "wave@example.test"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["config", "user.name", "Wave Tester"], { cwd: dir, stdio: "pipe" });
	writeFileSync(path.join(dir, "README.md"), "# test\n", "utf8");
	execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
	return dir;
}

function writeTicketFile(
	folder: string,
	filename: string,
	opts: { id: string; title: string; status?: string; blockedBy?: string[]; tierOverride?: number },
): string {
	mkdirSync(folder, { recursive: true });
	const lines = [
		"---",
		`status: ${opts.status ?? "ready"}`,
		`blocked-by: [${(opts.blockedBy ?? []).map((b) => JSON.stringify(b)).join(", ")}]`,
	];
	if (opts.tierOverride !== undefined) lines.push(`tier-override: ${opts.tierOverride}`);
	lines.push(
		"---",
		"",
		`# ${opts.id}: ${opts.title}`,
		"",
		`**Status:** ${opts.status ?? "ready"}`,
		"",
		"## Validation",
		"echo ok",
		"",
	);
	const file = path.join(folder, filename);
	writeFileSync(file, lines.join("\n"), "utf8");
	return file;
}

/**
 * Create a fake host whose `appendEntry` also pushes to the live `branch` array
 * (mirroring pi's SessionManager so `ctx.sessionManager.getBranch()` always
 * reflects entries appended during the session).
 */
function createLiveBranchHost(options: FakeHostOptions = {}) {
	const branch: Record<string, unknown>[] = [...(options.branch ?? [])];
	const host = createFakeHost({ ...options, branch });
	const origAppend = host.pi.appendEntry.bind(host.pi);
	host.pi.appendEntry = (customType: string, data?: unknown) => {
		origAppend(customType, data);
		branch.push({ type: "custom", id: `e-${branch.length}`, customType, data });
	};
	return { host, branch };
}

function emitBus(host: ReturnType<typeof createFakeHost>, channel: string, payload: unknown): void {
	(host.pi.events as unknown as { emit: (ch: string, data: unknown) => void }).emit(channel, payload);
}

function gateVerdictOf(result: unknown): GateVerdict {
	const proposal = (result ?? {}) as { entries?: Array<{ customType?: string; data?: GateVerdict }> };
	const entry = proposal.entries?.find((e) => e.customType === GATE_ENTRY_TYPE);
	assert.ok(entry?.data, "expected orchestrator-gate entry in settlement proposal");
	return entry.data;
}

test("happy-path wave lifecycle through orchestratorExtension, git commit guard, SHA verification, and disk sync", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/feat");
		const ticketFile = writeTicketFile(ticketsDir, "01-task.md", {
			id: "01",
			title: "First task",
		});

		const { host, branch } = createLiveBranchHost({
			cwd: repo,
			model: { provider: "mistral", id: "zai-glm-5-3-flash" },
		});
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		assert.ok(host.commands.has(WAVE_COMMAND));
		assert.ok(host.tools.has(WAVE_TOOL));

		// 1. /orchestrate <folder>
		await host.runCommand(WAVE_COMMAND, "docs/tickets/feat");
		assert.equal(host.notifications.length, 0, "top-tier model emits no warning");
		assert.equal(branch.filter((e) => e.customType === WAVE_ENTRY_TYPE).length, 1);
		const kickoff = host.messages.find((m) => m.message.customType === WAVE_KICKOFF_TYPE);
		assert.ok(kickoff, "kickoff message is sent");
		assert.equal(kickoff.options?.triggerTurn, true);
		const kickoffText = String(kickoff.message.content);
		assert.match(kickoffText, /orchestrator_wave/);
		assert.match(kickoffText, /subagent/);
		assert.match(kickoffText, /orchestrator_workspace/);
		assert.match(kickoffText, /orchestrator_reserve/);

		// /orchestrate status and empty args while active
		await host.runCommand(WAVE_COMMAND, "status");
		await host.runCommand(WAVE_COMMAND, "");
		const statusMsgs = host.messages.filter((m) => m.message.customType === WAVE_STATUS_TYPE);
		assert.equal(statusMsgs.length, 2);
		assert.match(String(statusMsgs[0]!.message.content), /Wave \(docs\/tickets\/feat\): active/);

		// 2. triage -> Tier 1
		const triaged = await host.callTool(WAVE_TOOL, {
			action: "triage",
			ticketId: "01",
			tier: 1,
			reason: "single-seam edit",
		});
		assert.equal((triaged.details as { ticket: { phase: string; tier: number } }).ticket.phase, "triaged");
		assert.equal((triaged.details as { ticket: { tier: number } }).ticket.tier, 1);

		// 3. start_implement -> updates ticket file to in-progress and returns Tier 1 dispatch
		const implStart = await host.callTool(WAVE_TOOL, {
			action: "start_implement",
			ticketId: "01",
			runId: "run-1",
		});
		const implDetails = implStart.details as {
			ticket: { phase: string };
			dispatch: { provider: string; model: string; thinking: string };
		};
		assert.equal(implDetails.ticket.phase, "implementing");
		assert.deepEqual(implDetails.dispatch, {
			provider: "opencode-go",
			model: "hy4-flash-free",
			thinking: "max",
		});
		const onDiskInProgress = readFileSync(ticketFile, "utf8");
		assert.match(onDiskInProgress, /^status: in-progress$/m);
		assert.match(onDiskInProgress, /^\*\*Status:\*\* in-progress$/m);

		// 4. git commit is BLOCKED while implementing; git status is allowed
		const blockedCommit = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'premature'" },
		});
		assert.equal((blockedCommit as { block?: boolean })?.block, true);
		const allowedStatus = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git status" },
		});
		assert.equal(allowedStatus, undefined);

		// 5. implement_result(completed) -> Tier 1 enters reviewing with inherited reviewer pin
		const implDone = await host.callTool(WAVE_TOOL, {
			action: "implement_result",
			ticketId: "01",
			outcome: "completed",
			reason: "implemented task",
		});
		const implDoneDetails = implDone.details as {
			ticket: { phase: string };
			nextPin: { inheritModel?: boolean; thinking?: string };
			nextRole?: string;
		};
		assert.equal(implDoneDetails.ticket.phase, "reviewing");
		assert.deepEqual(implDoneDetails.nextPin, {
			inheritModel: true,
			thinking: "high",
		});
		assert.equal(implDoneDetails.nextRole, "reviewer");

		// 6. record_verify REFUSED before review!
		const entriesBeforeBadVerify = branch.length;
		const skippedReview = (await host.callTool(WAVE_TOOL, {
			action: "record_verify",
			ticketId: "01",
			verdict: "pass",
			evidence: "skipped",
		})) as { isError?: boolean; content: Array<{ text?: string }> };
		assert.equal(skippedReview.isError, true);
		assert.match(skippedReview.content[0]?.text ?? "", /reviewing/);
		assert.equal(branch.length, entriesBeforeBadVerify, "refused action writes no entry");

		// 7. record_review(pass) -> verifying with verifier pin
		const reviewed = await host.callTool(WAVE_TOOL, {
			action: "record_review",
			ticketId: "01",
			verdict: "pass",
		});
		const reviewedDetails = reviewed.details as {
			ticket: { phase: string };
			nextPin: { provider: string; model: string; thinking: string };
		};
		assert.equal(reviewedDetails.ticket.phase, "verifying");
		assert.deepEqual(reviewedDetails.nextPin, {
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			thinking: "high",
		});

		// 8. record_verify(pass) -> ready_to_commit
		const verified = await host.callTool(WAVE_TOOL, {
			action: "record_verify",
			ticketId: "01",
			verdict: "pass",
			evidence: "fail 0",
		});
		assert.equal((verified.details as { ticket: { phase: string } }).ticket.phase, "ready_to_commit");

		// 9. git commit is now ALLOWED
		const allowedCommit = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat: implement 01'" },
		});
		assert.equal(allowedCommit, undefined);

		// record_commit rejects invalid SHA with isError: true
		const badCommit = (await host.callTool(WAVE_TOOL, {
			action: "record_commit",
			ticketId: "01",
			commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		})) as { isError?: boolean };
		assert.equal(badCommit.isError, true);

		// Make a real git commit and record_commit (omitting commitSha resolves HEAD)
		writeFileSync(path.join(repo, "feature.txt"), "done\n", "utf8");
		execFileSync("git", ["add", "feature.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(01): implement task"], { cwd: repo, stdio: "pipe" });
		const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

		const committed = await host.callTool(WAVE_TOOL, {
			action: "record_commit",
			ticketId: "01",
		});
		const committedDetails = committed.details as {
			waveStatus: string;
			active: boolean;
			ticket: { phase: string; commitSha: string };
		};
		assert.equal(committedDetails.ticket.phase, "done");
		assert.equal(committedDetails.ticket.commitSha, headSha);
		assert.equal(committedDetails.waveStatus, "completed");
		assert.equal(committedDetails.active, false);

		const onDiskDone = readFileSync(ticketFile, "utf8");
		assert.match(onDiskDone, /^status: done$/m);
		assert.match(onDiskDone, /^\*\*Status:\*\* done$/m);
	});
});

test("/orchestrate refuses broken graphs cleanly and warns when session model is below top tier", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const badDir = path.join(repo, "docs/tickets/broken");
		writeTicketFile(badDir, "01-bad.md", {
			id: "01",
			title: "Broken",
			blockedBy: ["99"],
		});

		const { host, branch } = createLiveBranchHost({
			cwd: repo,
			model: { provider: "opencode-go", id: "hy4-flash-free" },
		});
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		// Refuses dangling blocker with error notification and zero entries
		await host.runCommand(WAVE_COMMAND, "docs/tickets/broken");
		assert.equal(branch.length, 0);
		assert.equal(host.messages.length, 0);
		assert.ok(
			host.notifications.some((n) => n.type === "error" && /99/.test(n.message)),
			"notifies error for dangling blocker",
		);

		// Valid folder with lower-tier session model emits warning + notes in kickoff
		const goodDir = path.join(repo, "docs/tickets/good");
		writeTicketFile(goodDir, "01-good.md", { id: "01", title: "Good" });
		await host.runCommand(WAVE_COMMAND, "docs/tickets/good");
		assert.ok(
			host.notifications.some((n) => n.type === "warning" && /tier 1/i.test(n.message)),
			"warns via ctx.ui.notify when session model is below top tier",
		);
		const kickoff = host.messages.find((m) => m.message.customType === WAVE_KICKOFF_TYPE);
		assert.ok(kickoff);
		assert.match(String(kickoff.message.content), /Model warning:.*tier 1/i);
	});
});

test("agent_before_settle blocks premature settle without orchestrator.json, parks while subagent live, and clears on abort or completion", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/settle");
		writeTicketFile(ticketsDir, "01-first.md", { id: "01", title: "First" });

		// No .pi/orchestrator.json in repo
		const { host } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		await host.runCommand(WAVE_COMMAND, "docs/tickets/settle");

		// Premature settle with no live subagent runs -> blocked
		const blockedProposal = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(blockedProposal.continue, true);
		const blockedVerdict = gateVerdictOf(blockedProposal);
		assert.equal(blockedVerdict.decision, "continue");
		assert.deepEqual(blockedVerdict.blockedBy, ["wave"]);
		assert.equal(blockedVerdict.attempts, 1);

		// Live subagent run -> parks (does not spend attempt, does not set continue)
		emitBus(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-sub-1", status: "running", at: 1 });
		const parkedProposal = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(parkedProposal.continue, undefined);
		const parkedVerdict = gateVerdictOf(parkedProposal);
		assert.equal(parkedVerdict.parked, true);
		assert.equal(parkedVerdict.decision, "report");
		assert.deepEqual(parkedVerdict.liveRuns, ["run-sub-1"]);

		// Completing the live subagent wakes the parked parent
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, { runId: "run-sub-1", status: "completed", at: 2 });
		const wake = host.messages.find((m) => m.message.customType === "orchestrator-resume");
		assert.ok(wake);
		assert.equal(wake.options?.triggerTurn, true);

		// /orchestrate abort clears the settlement gate
		await host.runCommand(WAVE_COMMAND, "abort");
		const clearedProposal = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(clearedProposal.continue, undefined);
		const clearedVerdict = gateVerdictOf(clearedProposal);
		assert.equal(clearedVerdict.decision, "report");
		assert.deepEqual(clearedVerdict.blockedBy, []);
	});
});

test("agent_before_settle clears once wave completes", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/complete");
		writeTicketFile(ticketsDir, "01-only.md", { id: "01", title: "Only", tierOverride: 2 });

		const { host } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		await host.runCommand(WAVE_COMMAND, "docs/tickets/complete");

		await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: "01" });
		await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: "01", outcome: "completed" });
		await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: "01", verdict: "pass" });
		writeFileSync(path.join(repo, "done.txt"), "ok\n", "utf8");
		execFileSync("git", ["add", "done.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(01): done"], { cwd: repo, stdio: "pipe" });
		await host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "01" });

		const settled = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(settled.continue, undefined);
		assert.equal(gateVerdictOf(settled).decision, "report");
	});
});

test("record_commit rejects pre-wave HEAD, ancestor commits, and SHAs reused across tickets", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const baseHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
		// Add a second pre-wave commit so baseHeadSha has an older ancestor
		writeFileSync(path.join(repo, "prewave.txt"), "pre\n", "utf8");
		execFileSync("git", ["add", "prewave.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "pre-wave second"], { cwd: repo, stdio: "pipe" });
		const startHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

		const ticketsDir = path.join(repo, "docs/tickets/sha-guard");
		writeTicketFile(ticketsDir, "01-first.md", { id: "01", title: "First", tierOverride: 2 });
		writeTicketFile(ticketsDir, "02-second.md", { id: "02", title: "Second", tierOverride: 2 });

		const { host, branch } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		const started = await host.callTool(WAVE_TOOL, { action: "start", folder: "docs/tickets/sha-guard" });
		assert.equal((started.details as { state: { startHeadSha?: string } }).state.startHeadSha, startHeadSha);

		for (const id of ["01", "02"]) {
			await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: id });
			await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: id, outcome: "completed" });
			await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: id, verdict: "pass" });
		}

		// Pre-wave HEAD rejected (omitting commitSha resolves HEAD === startHeadSha)
		const preWaveHead = (await host.callTool(WAVE_TOOL, {
			action: "record_commit",
			ticketId: "01",
		})) as { isError?: boolean; content: Array<{ text?: string }> };
		assert.equal(preWaveHead.isError, true);
		assert.match(preWaveHead.content[0]?.text ?? "", /predates|baseline|new commit/i);

		// Ancestor of startHeadSha rejected
		const ancestorReject = (await host.callTool(WAVE_TOOL, {
			action: "record_commit",
			ticketId: "01",
			commitSha: baseHeadSha,
		})) as { isError?: boolean; content: Array<{ text?: string }> };
		assert.equal(ancestorReject.isError, true);
		assert.match(ancestorReject.content[0]?.text ?? "", /predates|new commit/i);

		// Make one real post-wave commit and record it on 01
		writeFileSync(path.join(repo, "t1.txt"), "1\n", "utf8");
		execFileSync("git", ["add", "t1.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(01): post-wave"], { cwd: repo, stdio: "pipe" });
		const sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

		const ok1 = await host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "01", commitSha: sha1 });
		assert.equal((ok1.details as { ok: boolean }).ok, true);

		// Reusing sha1 on 02 is rejected
		const reusedReject = (await host.callTool(WAVE_TOOL, {
			action: "record_commit",
			ticketId: "02",
			commitSha: sha1,
		})) as { isError?: boolean; content: Array<{ text?: string }> };
		assert.equal(reusedReject.isError, true);
		assert.match(reusedReject.content[0]?.text ?? "", /01|already recorded|unique/i);
		assert.equal(reconstructWaveState(branch)?.tickets["02"]?.phase, "ready_to_commit");
	});
});

test("concurrent orchestrator_wave Promise.all(record_commit) serializes cleanly without stale state", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/race");
		writeTicketFile(ticketsDir, "01-first.md", { id: "01", title: "First", tierOverride: 2 });
		writeTicketFile(ticketsDir, "02-second.md", { id: "02", title: "Second", tierOverride: 2 });

		const { host, branch } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		assert.equal(host.tools.get(WAVE_TOOL)?.executionMode, "sequential");

		await host.runCommand(WAVE_COMMAND, "docs/tickets/race");

		for (const id of ["01", "02"]) {
			await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: id });
			await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: id, outcome: "completed" });
			await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: id, verdict: "pass" });
		}

		writeFileSync(path.join(repo, "one.txt"), "1\n", "utf8");
		execFileSync("git", ["add", "one.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(01): one"], { cwd: repo, stdio: "pipe" });
		const sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

		writeFileSync(path.join(repo, "two.txt"), "2\n", "utf8");
		execFileSync("git", ["add", "two.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(02): two"], { cwd: repo, stdio: "pipe" });
		const sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

		const [res1, res2] = await Promise.all([
			host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "01", commitSha: sha1 }),
			host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "02", commitSha: sha2 }),
		]);

		assert.equal((res1 as { isError?: boolean }).isError, undefined);
		assert.equal((res2 as { isError?: boolean }).isError, undefined);

		const finalState = reconstructWaveState(branch);
		assert.ok(finalState);
		assert.equal(finalState.tickets["01"]?.phase, "done");
		assert.equal(finalState.tickets["02"]?.phase, "done");
		assert.equal(finalState.status, "completed");
		assert.equal(canRunGitCommit(finalState).allowed, true);
	});
});

test("untrusted project enforces active wave settlement gate and live-subagent parking without running repo verification", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/untrusted-wave");
		writeTicketFile(ticketsDir, "01-task.md", { id: "01", title: "Task" });

		// Untrusted repo attempts to disable wave/waitForSubagents and run a repo verification command
		mkdirSync(path.join(repo, ".pi"), { recursive: true });
		writeFileSync(
			gateConfigPath(repo),
			JSON.stringify({
				version: 1,
				attemptCap: 0,
				block: { openTodos: true, repeatedFailure: true, loops: true, wave: false, waitForSubagents: false },
				verification: { command: "echo SHOULD_NOT_RUN && exit 1" },
			}),
			"utf8",
		);

		const { host } = createLiveBranchHost({ cwd: repo, trusted: false });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		// Simulate an edited file in branch so verification would run if config were honored
		await host.runCommand(WAVE_COMMAND, "docs/tickets/untrusted-wave");
		host.execCalls.length = 0;

		// Premature settle -> MUST block on wave, and MUST NOT execute repo verification command
		const blocked = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(blocked.continue, true);
		const blockedVerdict = gateVerdictOf(blocked);
		assert.equal(blockedVerdict.decision, "continue");
		assert.deepEqual(blockedVerdict.blockedBy, ["wave"]);
		assert.equal(blockedVerdict.verification, null);
		assert.equal(host.execCalls.length, 0, "repo verification command must never run on untrusted project");

		// Live subagent -> MUST park even though repo config set waitForSubagents: false
		emitBus(host, ORCHESTRATION_EVENTS.runStarted, { runId: "run-untrusted-1", status: "running", at: 1 });
		const parked = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(parked.continue, undefined);
		const parkedVerdict = gateVerdictOf(parked);
		assert.equal(parkedVerdict.parked, true);
		assert.equal(parkedVerdict.decision, "report");
		assert.deepEqual(parkedVerdict.liveRuns, ["run-untrusted-1"]);
		assert.equal(host.execCalls.length, 0);
	});
});

test("session_compact snapshot includes the active wave summary", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/snap");
		writeTicketFile(ticketsDir, "01-snap.md", { id: "01", title: "Snapshot ticket" });

		const { host } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		await host.runCommand(WAVE_COMMAND, "docs/tickets/snap");
		await host.callTool(WAVE_TOOL, { action: "triage", ticketId: "01", tier: 1 });

		await host.fire("session_compact", {
			compactionEntry: { type: "compaction", id: "cmp-1", summary: "compact" },
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		});

		const snap = host.messages.find((m) => m.message.customType === ORCHESTRATOR_CUSTOM_TYPES.compactSnapshot);
		assert.ok(snap, "compact snapshot is sent");
		assert.equal(snap.message.display, false);
		assert.equal(snap.options?.triggerTurn, false);
		const content = String(snap.message.content);
		assert.match(content, /Active wave \(docs\/tickets\/snap\): 0\/1 done, 1 active, 0 blocked/);
		assert.match(content, /- 01:triaged\(T1\)/);
	});
});

test("orchestrator_wave uses codemode exposure when codemode or tool_search is active and deactivates direct -> codemode", async (t) => {
	const repo = makeTempGitRepo(t);
	let bound = false;
	let activeTools = ["read", "bash", "edit", "write"];
	const setActiveCalls: string[][] = [];

	const host = createFakeHost({ cwd: repo });
	const piWithActiveTools = Object.assign(host.pi, {
		getActiveTools: () => {
			if (!bound) throw new Error("Extension runtime not initialized.");
			return [...activeTools];
		},
		setActiveTools: (names: string[]) => {
			setActiveCalls.push([...names]);
			activeTools = [...names];
		},
	});

	orchestratorExtension(piWithActiveTools);
	assert.equal(host.tools.has(WAVE_TOOL), false, "unbound runtime defers tool registration until session_start");

	// Bind with direct tools first
	bound = true;
	activeTools = ["read", "bash", WAVE_TOOL];
	await host.fire("session_start", {});
	assert.equal(host.tools.get(WAVE_TOOL)?.exposure, undefined, "starts direct when no discovery tool active");
	assert.equal(setActiveCalls.length, 0);

	// Activate codemode mid-session -> re-registers with exposure: "codemode" and removes from activeTools
	activeTools = ["read", "bash", WAVE_TOOL, "codemode"];
	await host.fire("before_agent_start", {});
	assert.equal(host.tools.get(WAVE_TOOL)?.exposure, "codemode");
	assert.equal(activeTools.includes(WAVE_TOOL), false, "orchestrator_wave deactivated from activeTools");
	assert.ok(setActiveCalls.length >= 1);

	// Fresh host starting directly with tool_search
	const searchHost = createFakeHost({ cwd: repo });
	let searchActive = ["read", "tool_search"];
	Object.assign(searchHost.pi, {
		getActiveTools: () => [...searchActive],
		setActiveTools: (names: string[]) => {
			searchActive = [...names];
		},
	});
	orchestratorExtension(searchHost.pi);
	assert.equal(searchHost.tools.get(WAVE_TOOL)?.exposure, "codemode");
});

test("delegated worker session does NOT register /orchestrate or orchestrator_wave", async (t) => {
	const repo = makeTempGitRepo(t);
	const host = createFakeHost({ cwd: repo });
	orchestratorExtension(host.pi, { role: "worker" });
	await host.fire("session_start", {});

	assert.equal(host.commands.has(WAVE_COMMAND), false);
	assert.equal(host.tools.has(WAVE_TOOL), false);
});

test("untrusted project registers orchestrator_override only when a wave is active and keeps it unregistered otherwise", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/untrusted-override");
		writeTicketFile(ticketsDir, "01-task.md", { id: "01", title: "Task" });

		// Even with an enabling repo config, an untrusted project with no active wave must NOT register orchestrator_override.
		mkdirSync(path.join(repo, ".pi"), { recursive: true });
		writeFileSync(
			gateConfigPath(repo),
			JSON.stringify({
				version: 1,
				block: { openTodos: true, repeatedFailure: true, loops: true, wave: true },
				verification: { command: "echo ok" },
			}),
			"utf8",
		);

		const { host, branch } = createLiveBranchHost({ cwd: repo, trusted: false });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		await host.fire("before_agent_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		// Activating a wave via /orchestrate on an untrusted project registers orchestrator_override and makes it callable.
		await host.runCommand(WAVE_COMMAND, "docs/tickets/untrusted-override");
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), true);

		await host.fire("before_agent_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), true);

		const overrideRes = await host.callTool(GATE_OVERRIDE_TOOL, { reason: "pausing untrusted wave" });
		assert.equal((overrideRes.details as { reason?: string }).reason, "pausing untrusted wave");

		const settled = (await host.fire("agent_before_settle", {
			entries: [],
			continue: false,
			outcome: "completed",
			context: {},
		})) as { continue?: boolean };
		assert.equal(settled.continue, undefined);
		const verdict = gateVerdictOf(settled);
		assert.equal(verdict.decision, "report");
		assert.equal(verdict.override?.reason, "pausing untrusted wave");

		// Fresh untrusted session resuming an existing active wave branch registers orchestrator_override on session_start.
		const resumedHost = createFakeHost({ cwd: repo, trusted: false, branch: [...branch] });
		orchestratorExtension(resumedHost.pi);
		await resumedHost.fire("session_start", {});
		assert.equal(resumedHost.tools.has(GATE_OVERRIDE_TOOL), true);

		// Fresh untrusted session starting a wave via orchestrator_wave({ action: "start" }) registers orchestrator_override.
		const toolStartHost = createLiveBranchHost({ cwd: repo, trusted: false });
		orchestratorExtension(toolStartHost.host.pi);
		await toolStartHost.host.fire("session_start", {});
		assert.equal(toolStartHost.host.tools.has(GATE_OVERRIDE_TOOL), false);
		await toolStartHost.host.callTool(WAVE_TOOL, { action: "start", folder: "docs/tickets/untrusted-override" });
		assert.equal(toolStartHost.host.tools.has(GATE_OVERRIDE_TOOL), true);
	});
});

test("trusted project with all blocking gates disabled does NOT register orchestrator_override when starting a wave", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/no-gates");
		writeTicketFile(ticketsDir, "01-task.md", { id: "01", title: "Task" });

		mkdirSync(path.join(repo, ".pi"), { recursive: true });
		writeFileSync(
			gateConfigPath(repo),
			JSON.stringify({
				version: 1,
				block: { openTodos: false, repeatedFailure: false, loops: false, waitForSubagents: false, wave: false },
				verification: null,
				delegation: { mode: "off" },
			}),
			"utf8",
		);

		const { host } = createLiveBranchHost({ cwd: repo, trusted: true });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		await host.runCommand(WAVE_COMMAND, "docs/tickets/no-gates");
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		await host.fire("before_agent_start", {});
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);

		// Also verify starting via orchestrator_wave({ action: "start" }) in a fresh session
		const toolStartHost = createLiveBranchHost({ cwd: repo, trusted: true });
		orchestratorExtension(toolStartHost.host.pi);
		await toolStartHost.host.fire("session_start", {});
		assert.equal(toolStartHost.host.tools.has(GATE_OVERRIDE_TOOL), false);
		await toolStartHost.host.callTool(WAVE_TOOL, { action: "start", folder: "docs/tickets/no-gates" });
		assert.equal(toolStartHost.host.tools.has(GATE_OVERRIDE_TOOL), false);
	});
});

test("kickoff prompt and status output propagate canonical subagent roles and omit provider/model for inheritModel", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/roles-kickoff");
		writeTicketFile(ticketsDir, "01-triage.md", { id: "01", title: "Needs triage" });
		writeTicketFile(ticketsDir, "02-override.md", { id: "02", title: "Has override", tierOverride: 1 });

		const { host } = createLiveBranchHost({ cwd: repo });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		await host.runCommand(WAVE_COMMAND, "docs/tickets/roles-kickoff");

		const kickoff = host.messages.find((m) => m.message.customType === WAVE_KICKOFF_TYPE);
		assert.ok(kickoff);
		const kickoffText = String(kickoff.message.content);
		assert.match(kickoffText, /role:\s*"?explore"?/);
		assert.match(kickoffText, /role:\s*"?coder"?/);
		assert.match(kickoffText, /role:\s*"?reviewer"?/);
		assert.match(kickoffText, /inheritModel|omit\s+`?provider`?\/`?model`?/i);

		await host.runCommand(WAVE_COMMAND, "status");
		const statusMsg = host.messages.filter((m) => m.message.customType === WAVE_STATUS_TYPE).at(-1);
		assert.ok(statusMsg);
		const statusText = String(statusMsg.message.content);
		assert.match(statusText, /role:\s*explore/);
		assert.match(statusText, /role:\s*coder/);
	});
});

test("RB-2: wave reviewer settlement marks reviewVerified and ready_to_commit avoids delegation double-blocks while unverified edits stay blocked", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/rb2");
		writeTicketFile(ticketsDir, "01-tier1.md", { id: "01", title: "Tier 1 ticket", tierOverride: 1 });
		writeTicketFile(ticketsDir, "02-tier2.md", { id: "02", title: "Tier 2 ticket", tierOverride: 2 });

		const { host } = createLiveBranchHost({ cwd: repo, trusted: true });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		await host.fire("before_agent_start", { prompt: "Run wave", systemPrompt: "", systemPromptOptions: { sections: {} } });

		await host.runCommand(WAVE_COMMAND, "docs/tickets/rb2");

		// Ticket 01 (Tier 1): coder edits 2 files without matching verifyCommandPattern
		await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: "01", runId: "c-01" });
		const t0 = Date.now() - 1000;
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "c-01",
			status: "completed",
			role: "coder",
			cwd: repo,
			startedAt: t0,
			finishedAt: t0 + 100,
			activitySummary: {
				editedFiles: [
					{ path: "src/a.ts", changedLines: 30, lastEditAt: t0 + 50 },
					{ path: "src/b.ts", changedLines: 30, lastEditAt: t0 + 60 },
				],
				passedCommands: [],
				lastEditAt: t0 + 60,
			},
		});
		await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: "01", outcome: "completed" });

		// Before reviewer settles & before verify passes, git commit is blocked
		const blockedDuringReview = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'premature'" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedDuringReview?.block, true);

		// Wave reviewer settles -> marks reviewVerified via shared runSettled pathway
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev-01",
			status: "completed",
			role: "reviewer",
			cwd: repo,
			startedAt: t0 + 150,
			finishedAt: t0 + 250,
		});
		await host.callTool(WAVE_TOOL, { action: "record_review", ticketId: "01", verdict: "pass" });

		// While still in verifying (not ready_to_commit), git commit is still blocked
		const blockedDuringVerify = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'still verifying'" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedDuringVerify?.block, true);

		// record_verify(pass) -> ready_to_commit: git commit MUST NOT be double-blocked by delegation
		await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: "01", verdict: "pass", evidence: "ok" });
		const allowedCommit01 = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat(01): done'" },
		});
		assert.equal(allowedCommit01, undefined, "ready_to_commit ticket 01 must not be blocked by delegation gate");

		// Simulate actual git commit + record_commit for 01
		writeFileSync(path.join(repo, "f1.txt"), "1\n", "utf8");
		execFileSync("git", ["add", "f1.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(01): done"], { cwd: repo, stdio: "pipe" });
		await host.fire("tool_result", {
			toolName: "bash",
			input: { command: "git commit -m 'feat(01): done'" },
			isError: false,
			content: [],
		});
		await host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "01" });

		// Ticket 02 (Tier 2 > throughTier 1): coder edits 2 files (arms reviewRequired in delegation),
		// skips wave review per throughTier=1, passes verify -> ready_to_commit.
		await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: "02", runId: "c-02" });
		const t1 = Date.now() - 500;
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "c-02",
			status: "completed",
			role: "coder",
			cwd: repo,
			startedAt: t1,
			finishedAt: t1 + 100,
			activitySummary: {
				editedFiles: [
					{ path: "src/c.ts", changedLines: 30, lastEditAt: t1 + 50 },
					{ path: "src/d.ts", changedLines: 30, lastEditAt: t1 + 60 },
				],
				passedCommands: [],
				lastEditAt: t1 + 60,
			},
		});
		await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: "02", outcome: "completed" });
		await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: "02", verdict: "pass", evidence: "ok" });

		// Commit and settle must NOT be double-blocked by delegation gate!
		const allowedCommit02 = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat(02): done'" },
		});
		assert.equal(allowedCommit02, undefined, "ready_to_commit Tier 2 ticket must not be double-blocked");

		const handlers = host.handlers.get("agent_before_settle") ?? [];
		let entries: unknown[] = [];
		for (const h of handlers) {
			const res = (await h({ entries, continue: false, outcome: "completed", context: {} }, host.ctx)) as
				| { entries?: unknown[] }
				| undefined;
			if (res?.entries) entries = res.entries;
		}
		assert.equal(
			entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			false,
			"delegation settle gate must not double-block while wave ticket is ready_to_commit",
		);

		// Complete ticket 02 -> wave completed -> new unverified edit outside ready_to_commit IS blocked
		writeFileSync(path.join(repo, "f2.txt"), "2\n", "utf8");
		execFileSync("git", ["add", "f2.txt"], { cwd: repo, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "feat(02): done"], { cwd: repo, stdio: "pipe" });
		await host.fire("tool_result", {
			toolName: "bash",
			input: { command: "git commit -m 'feat(02): done'" },
			isError: false,
			content: [],
		});
		await host.callTool(WAVE_TOOL, { action: "record_commit", ticketId: "02" });

		await host.fire("tool_call", { toolName: "read", input: { path: "src/extra.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/extra.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/extra.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/extra.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});
		const blockedNonWaveCommit = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'unverified'" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedNonWaveCommit?.block, true, "non-wave unverified edits remain blocked");
	});
});

test("Fix 3 (review): active wave allows subagent calls with canonical role + ladder provider/model on non-model-mention turns", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/fix3");
		writeTicketFile(ticketsDir, "01-task.md", { id: "01", title: "Task", tierOverride: 1 });

		const { host } = createLiveBranchHost({ cwd: repo, trusted: true });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});

		// Normal turn without model mention: explicit provider/model with role is BLOCKED before wave starts
		await host.fire("before_agent_start", {
			prompt: "Collect the result and continue the work",
			systemPrompt: "",
			systemPromptOptions: { sections: {} },
		});
		const blockedBeforeWave = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { role: "coder", provider: "opencode-go", model: "hy4-flash-free", task: "do work" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedBeforeWave?.block, true);

		// Start wave -> active wave allows canonical role + ladder provider/model even on turns with no model mention
		await host.runCommand(WAVE_COMMAND, "docs/tickets/fix3");
		await host.fire("before_agent_start", {
			prompt: "The last live delegated run finished; continue the work.",
			systemPrompt: "",
			systemPromptOptions: { sections: {} },
		});
		const waveSubagentInput: Record<string, unknown> = {
			role: "coder",
			provider: "opencode-go",
			model: "hy4-flash-free",
			task: "implement ticket 01",
		};
		const allowedDuringWave = await host.fire("tool_call", {
			toolName: "subagent",
			input: waveSubagentInput,
		});
		assert.equal(allowedDuringWave, undefined);
		assert.equal(waveSubagentInput.provider, "opencode-go");
		assert.equal(waveSubagentInput.model, "hy4-flash-free");
		assert.equal(waveSubagentInput.thinking, "high");

		// Once wave is aborted, explicit override without prompt model mention is blocked again
		await host.runCommand(WAVE_COMMAND, "abort");
		const blockedAfterAbort = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { role: "coder", provider: "opencode-go", model: "hy4-flash-free", task: "do work" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedAfterAbort?.block, true);
	});
});

test("Fix 4 (review): ready_to_commit allows git commit only, keeps push/pr gates enforced, and re-arms on later edits", async (t) => {
	await withIsolatedWaveEnv(t, async () => {
		const repo = makeTempGitRepo(t);
		const ticketsDir = path.join(repo, "docs/tickets/fix4");
		writeTicketFile(ticketsDir, "01-task.md", { id: "01", title: "Task", tierOverride: 2 });

		const { host, branch } = createLiveBranchHost({ cwd: repo, trusted: true });
		orchestratorExtension(host.pi);
		await host.fire("session_start", {});
		await host.fire("before_agent_start", { prompt: "Run wave", systemPrompt: "", systemPromptOptions: { sections: {} } });
		await host.runCommand(WAVE_COMMAND, "docs/tickets/fix4");

		await host.callTool(WAVE_TOOL, { action: "start_implement", ticketId: "01", runId: "c-01" });
		const pastBase = Date.now() - 10_000;
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "c-01",
			status: "completed",
			role: "coder",
			cwd: repo,
			startedAt: pastBase,
			finishedAt: pastBase + 100,
			activitySummary: {
				editedFiles: [
					{ path: "src/a.ts", changedLines: 30, lastEditAt: pastBase + 50 },
					{ path: "src/b.ts", changedLines: 30, lastEditAt: pastBase + 60 },
				],
				passedCommands: [],
				lastEditAt: pastBase + 60,
			},
		});
		await host.callTool(WAVE_TOOL, { action: "implement_result", ticketId: "01", outcome: "completed" });
		await host.callTool(WAVE_TOOL, { action: "record_verify", ticketId: "01", verdict: "pass", evidence: "ok" });

		const stateReady = reconstructWaveState(branch);
		assert.equal(stateReady?.tickets["01"]?.phase, "ready_to_commit");
		const readyAt = stateReady?.tickets["01"]?.readyToCommitAt;
		assert.equal(typeof readyAt, "number");
		assert.ok((readyAt as number) > pastBase + 60);

		// 1. git commit is allowed
		const allowedCommit = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat(01): ready'" },
		});
		assert.equal(allowedCommit, undefined);

		// 2. git push, gh pr create, and gh pr merge are STILL blocked by evaluateCompletionGate
		for (const cmd of ["git push origin dev", "gh pr create --fill", "gh pr merge 10 --squash"]) {
			const blocked = (await host.fire("tool_call", {
				toolName: "bash",
				input: { command: cmd },
			})) as { block?: boolean; reason?: string } | undefined;
			assert.equal(blocked?.block, true, `expected ${cmd} to remain blocked by delegation gate`);
		}

		// 3. Subsequent edit AFTER readyToCommitAt re-arms BOTH git commit and agent_before_settle
		const laterAt = (readyAt as number) + 5000;
		emitBus(host, ORCHESTRATION_EVENTS.runSettled, {
			runId: "c-later",
			status: "completed",
			role: "coder",
			cwd: repo,
			startedAt: laterAt - 10,
			finishedAt: laterAt,
			activitySummary: {
				editedFiles: [{ path: "src/c.ts", changedLines: 10, lastEditAt: laterAt }],
				passedCommands: [],
				lastEditAt: laterAt,
			},
		});

		const blockedLaterCommit = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'unverified later edit'" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedLaterCommit?.block, true, "later edit after ready_to_commit must block git commit");

		const handlers = host.handlers.get("agent_before_settle") ?? [];
		let entries: unknown[] = [];
		for (const h of handlers) {
			const res = (await h({ entries, continue: false, outcome: "completed", context: {} }, host.ctx)) as
				| { entries?: unknown[] }
				| undefined;
			if (res?.entries) entries = res.entries;
		}
		assert.equal(
			entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			true,
			"later edit after ready_to_commit must trigger delegation settle gate",
		);
	});
});

