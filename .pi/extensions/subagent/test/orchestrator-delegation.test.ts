import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	classifyCommitOrPrCommand,
	classifyTurn,
	clearDirtyState,
	countChangedLines,
	createDelegationState,
	DEFAULT_DELEGATION_CONFIG,
	DELEGATION_CONFIG_BASENAME,
	DELEGATION_CONFIG_ENV,
	DELEGATION_ENV,
	DELEGATION_MODES,
	DELEGATION_SECTION,
	evaluateCompletionGate,
	evaluateDiscovery,
	evaluateParentWrite,
	evaluateSubagentCall,
	explainReadOnlyBashBlock,
	extractEditInfo,
	formatDelegationSection,
	isCommitOrPrCommand,
	isReadOnlyBashAllowed,
	isReviewFile,
	isReviewInspectionBashCommand,
	isVerifyCommand,
	MAIN_REVIEW_VERDICTS,
	readDelegationConfig,
	RECORD_REVIEW_TOOL,
	recordChildSettled,
	recordFileMutation,
	recordMainModelReview,
	recordPassedCommand,
	recordReviewInspection,
	recordSteer,
	resetTurnState,
	type TurnMode,
} from "../../orchestrator/delegation.ts";
import { ORCHESTRATION_EVENTS } from "../../orchestrator/events.ts";
import { GATE_OVERRIDE_TOOL } from "../../orchestrator/gate.ts";
import orchestratorExtension from "../../orchestrator/index.ts";
import { createFakeHost, type FakeHost } from "./fake-pi.ts";
import { withEnv } from "./helpers.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "orchestrator-delegation-test-"));
	try {
		return await withEnv(
			{
				PI_CODING_AGENT_DIR: path.join(dir, ".test-agent-dir"),
				[DELEGATION_CONFIG_ENV]: undefined,
				[DELEGATION_ENV]: undefined,
			},
			() => fn(dir),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function startOrchestrator(
	cwd: string,
	options: {
		role?: "parent" | "worker";
		trusted?: boolean;
		model?: { provider: string; id: string };
		modelRegistry?: Record<string, unknown>;
		exec?: (command: string, args: string[], opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
		branch?: Record<string, unknown>[];
	} = {},
): Promise<FakeHost> {
	const branch = options.branch ?? [];
	const host = createFakeHost({
		sessionId: "delegation-test",
		cwd,
		trusted: options.trusted ?? true,
		model: options.model ?? { provider: "anthropic", id: "claude-opus-4-6" },
		modelRegistry: options.modelRegistry,
		exec: options.exec as never,
		branch,
	});
	const origAppend = host.pi.appendEntry.bind(host.pi);
	host.pi.appendEntry = (customType: string, data?: unknown) => {
		origAppend(customType, data);
		branch.push({ type: "custom", id: `e-${branch.length}`, customType, data });
	};
	orchestratorExtension(host.pi, { role: options.role ?? "parent" });
	await host.fire("session_start", {});
	return host;
}

async function runPrompt(host: FakeHost, prompt: string, sections: Record<string, string> = {}) {
	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt,
		systemPrompt: "base system prompt",
		systemPromptOptions: { sections },
	};
	const res = await host.fire("before_agent_start", event);
	await host.fire("turn_start", { turnIndex: 0 });
	return { event, res, sections };
}

/**
 * Model `ExtensionRunner.emitBoundary` composition across multiple
 * `agent_before_settle` handlers (`entries` compose, `continue` is last-defined).
 */
async function fireBoundary(
	host: FakeHost,
	baseEvent: Record<string, unknown> = { entries: [], continue: false, outcome: "completed" },
): Promise<{ entries: unknown[]; continue: boolean }> {
	const handlers = host.handlers.get("agent_before_settle") ?? [];
	let entries: unknown[] = Array.isArray(baseEvent.entries) ? [...baseEvent.entries] : [];
	let shouldContinue = Boolean(baseEvent.continue);
	for (const handler of handlers) {
		const res = (await handler({ ...baseEvent, entries, continue: shouldContinue }, host.ctx)) as
			| { entries?: unknown[]; continue?: boolean }
			| undefined;
		if (res?.entries !== undefined) entries = res.entries;
		if (res?.continue !== undefined) shouldContinue = res.continue;
	}
	return { entries, continue: shouldContinue };
}

// --- 1. Config loading & precedence ----------------------------------------

test("readDelegationConfig uses enforce default and merges global, trusted project, and env layers", async () => {
	await withTempDir(async (root) => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(path.join(projectDir, ".pi"), { recursive: true });

		assert.deepEqual(DELEGATION_MODES, ["enforce", "warn", "off"]);

		// Defaults only
		const baseline = readDelegationConfig(projectDir, { trusted: true, agentDir, env: {} });
		assert.equal(baseline.config.mode, "enforce");
		assert.equal(baseline.warnings.length, 0);
		assert.equal(baseline.config.roles.explore?.provider, "opencode-go");
		assert.equal(baseline.config.roles.explore?.model, "deepseek-v4.1-flash");
		assert.equal(baseline.config.roles.explore?.configuredByUser, false);
		assert.equal(baseline.config.roles.reviewer?.inheritModel, true);

		// Global config overrides mode + customizes coder role
		await writeFile(
			path.join(agentDir, DELEGATION_CONFIG_BASENAME),
			JSON.stringify({
				mode: "warn",
				maxEditLines: 30,
				roles: {
					coder: { provider: "openrouter", model: "qwen/qwen3-coder", thinking: "medium" },
				},
			}),
		);
		const withGlobal = readDelegationConfig(projectDir, { trusted: true, agentDir, env: {} });
		assert.equal(withGlobal.config.mode, "warn");
		assert.equal(withGlobal.config.maxEditLines, 30);
		assert.equal(withGlobal.config.roles.coder?.provider, "openrouter");
		assert.equal(withGlobal.config.roles.coder?.model, "qwen/qwen3-coder");
		assert.equal(withGlobal.config.roles.coder?.configuredByUser, true);
		assert.equal(withGlobal.config.roles.coder?.inheritModel, false);
		// Unmodified built-in role remains configuredByUser: false
		assert.equal(withGlobal.config.roles.explore?.configuredByUser, false);

		// Project config ignored when untrusted
		await writeFile(
			path.join(projectDir, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				delegation: {
					mode: "off",
					maxEditLines: 99,
					roles: {
						explore: { inheritModel: true },
					},
				},
			}),
		);
		const untrusted = readDelegationConfig(projectDir, { trusted: false, agentDir, env: {} });
		assert.equal(untrusted.config.mode, "warn");
		assert.equal(untrusted.config.maxEditLines, 30);
		assert.equal(untrusted.config.roles.explore?.inheritModel, false);

		// Project config applied when trusted
		const trusted = readDelegationConfig(projectDir, { trusted: true, agentDir, env: {} });
		assert.equal(trusted.config.mode, "off");
		assert.equal(trusted.config.maxEditLines, 99);
		assert.equal(trusted.config.roles.explore?.inheritModel, true);
		assert.equal(trusted.config.roles.explore?.configuredByUser, true);

		// Env override wins over project & global
		const envOverridden = readDelegationConfig(projectDir, {
			trusted: true,
			agentDir,
			env: { [DELEGATION_ENV]: "enforce" },
		});
		assert.equal(envOverridden.config.mode, "enforce");
	});
});

test("readDelegationConfig supports explicit config path env and survives malformed JSON", async () => {
	await withTempDir(async (root) => {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(root, "project");
		const customPath = path.join(root, "custom-delegation.json");
		await mkdir(agentDir, { recursive: true });
		await mkdir(path.join(projectDir, ".pi"), { recursive: true });

		await writeFile(customPath, "{ broken json");
		await writeFile(path.join(projectDir, ".pi", "orchestrator.json"), "{ also broken");

		const res = readDelegationConfig(projectDir, {
			trusted: true,
			agentDir,
			env: { [DELEGATION_CONFIG_ENV]: customPath },
		});
		assert.equal(res.config.mode, "enforce");
		assert.ok(res.warnings.length >= 2, "collects warnings for both malformed files");
	});
});

// --- 2. Turn classifier ----------------------------------------------------

test("classifyTurn classifies all 6 modes, strips !direct, and detects model mentions", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;

	const sec = classifyTurn("Audit this auth flow for XSS and SQL injection vulnerabilities", cfg);
	assert.equal(sec.turnMode, "security");
	assert.equal(sec.discoveryBudget, 2);
	assert.equal(sec.directBypass, false);

	const rev = classifyTurn("Review the PR diff on this branch", cfg);
	assert.equal(rev.turnMode, "review");
	assert.equal(rev.discoveryBudget, 5);

	const dbg = classifyTurn("Debug why the checkout test fails with a stack trace", cfg);
	assert.equal(dbg.turnMode, "debug");
	assert.equal(dbg.discoveryBudget, 5);

	const qf = classifyTurn("Quick fix: fix typo in the header comment", cfg);
	assert.equal(qf.turnMode, "quick-fix");
	assert.equal(qf.discoveryBudget, 4);

	const qa = classifyTurn("Where is registerWaveRuntime called and how does it work?", cfg);
	assert.equal(qa.turnMode, "qa");
	assert.equal(qa.discoveryBudget, 8);

	const impl = classifyTurn("Implement role-based routing in the orchestrator", cfg);
	assert.equal(impl.turnMode, "implement");
	assert.equal(impl.discoveryBudget, 4);

	// !direct prefix (case-insensitive, trimmed)
	const direct = classifyTurn("   !DIRECT  How does the gate handle retries using opus? ", cfg);
	assert.equal(direct.directBypass, true);
	assert.equal(direct.turnMode, "qa");
	assert.equal(direct.promptHasModelMention, true);

	// "!directly" must NOT trigger bypass
	const notDirect = classifyTurn("!directly implement feature", cfg);
	assert.equal(notDirect.directBypass, false);
});

// --- 3. Discovery budget enforcement ---------------------------------------

test("discovery budget enforces per-mode caps, respects warn/off/!direct, and resets on next prompt", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);

		// Security mode cap = 2
		await runPrompt(host, "Check for security vulnerabilities in auth");
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "a.ts" } }), undefined);
		assert.equal(await host.fire("tool_call", { toolName: "grep", input: { pattern: "token" } }), undefined);
		const third = (await host.fire("tool_call", { toolName: "find", input: { pattern: "*.ts" } })) as
			| { block?: boolean; reason?: string }
			| undefined;
		assert.equal(third?.block, true);
		assert.match(third?.reason ?? "", /explore/i);

		// New prompt resets discovery counter (QA mode cap = 8)
		await runPrompt(host, "How does auth work in this codebase?");
		for (let i = 0; i < 8; i += 1) {
			assert.equal(await host.fire("tool_call", { toolName: "ls", input: { path: "." } }), undefined);
		}
		const ninth = (await host.fire("tool_call", { toolName: "read", input: { path: "b.ts" } })) as
			| { block?: boolean }
			| undefined;
		assert.equal(ninth?.block, true);

		// !direct bypasses discovery cap
		await runPrompt(host, "!direct Check for security vulnerabilities");
		for (let i = 0; i < 5; i += 1) {
			assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: `f${i}.ts` } }), undefined);
		}

		// warn mode notifies instead of blocking
		await host.runCommand("delegation", "warn");
		await runPrompt(host, "Audit security");
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "1.ts" } }), undefined);
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "2.ts" } }), undefined);
		const warned = await host.fire("tool_call", { toolName: "read", input: { path: "3.ts" } });
		assert.equal(warned, undefined);
		assert.ok(host.notifications.some((n) => n.type === "warning" && /Discovery budget/i.test(n.message)));

		// off mode neither blocks nor warns
		host.notifications.length = 0;
		await host.runCommand("delegation", "off");
		await runPrompt(host, "Audit security");
		for (let i = 0; i < 4; i += 1) {
			assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: `o${i}.ts` } }), undefined);
		}
		assert.equal(host.notifications.length, 0);
	});
});

// --- 4. Parent write caps & steer-to-unlock --------------------------------

test("countChangedLines trims identical leading and trailing context lines", () => {
	const prefix = Array.from({ length: 15 }, (_, i) => `const pre${i} = ${i};`).join("\n");
	const suffix = Array.from({ length: 15 }, (_, i) => `const post${i} = ${i};`).join("\n");
	const oldText = `${prefix}\nconst x = 1;\nconst y = 2;\n${suffix}`;
	const newText = `${prefix}\nconst x = 10;\nconst y = 20;\n${suffix}`;
	assert.equal(countChangedLines(oldText, newText), 2);

	const info = extractEditInfo("edit", { path: "src/a.ts", edits: [{ oldText, newText }] });
	assert.equal(info.changedLines, 2);

	const legacyInfo = extractEditInfo("edit", { path: "src/a.ts", old_str: "a\nb", new_str: "a\nb\nc" });
	assert.equal(legacyInfo.changedLines, 1);
});

test("parent write caps deny write, unread edit, >20 lines, 2nd file in same turn, and unlock on 2 steers", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement a fix");

		// write denied
		const writeRes = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const x = 1;\n" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(writeRes?.block, true);
		assert.match(writeRes?.reason ?? "", /coder/);

		// unread edit denied
		const unreadRes = (await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "a", newText: "b" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(unreadRes?.block, true);
		assert.match(unreadRes?.reason ?? "", /unread/i);

		// Read src/a.ts and src/b.ts
		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "read", input: { path: "src/b.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/b.ts" }, isError: false, content: [] });

		// >20 changed lines denied
		const bigOld = Array.from({ length: 21 }, (_, i) => `old ${i}`).join("\n");
		const bigNew = Array.from({ length: 21 }, (_, i) => `new ${i}`).join("\n");
		const bigEdit = (await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: bigOld, newText: bigNew },
		})) as { block?: boolean } | undefined;
		assert.equal(bigEdit?.block, true);

		// 2-line change inside 30-line context block ALLOWED
		const ctxPre = Array.from({ length: 15 }, (_, i) => `ctx pre ${i}`).join("\n");
		const ctxPost = Array.from({ length: 15 }, (_, i) => `ctx post ${i}`).join("\n");
		const smallEdit = await host.fire("tool_call", {
			toolName: "edit",
			input: {
				path: "src/a.ts",
				edits: [{ oldText: `${ctxPre}\na\nb\n${ctxPost}`, newText: `${ctxPre}\na1\nb1\n${ctxPost}` }],
			},
		});
		assert.equal(smallEdit, undefined);

		// 2nd file in same turn denied (even before tool_result of 1st edit — parallel calls caught!)
		const secondFile = (await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/b.ts", oldText: "x", newText: "y" },
		})) as { block?: boolean } | undefined;
		assert.equal(secondFile?.block, true);

		// 2 steers for same known run id unlock parent editing for rest of turn
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "run-42",
			status: "running",
			at: Date.now(),
		});
		await host.fire("tool_call", { toolName: "subagent_interrupt", input: { id: "run-42" } });
		await host.fire("tool_call", { toolName: "subagent_resume", input: { id: "run-42", task: "try again" } });
		assert.ok(host.notifications.some((n) => /unlocked/i.test(n.message)));

		const unlockedEdit = await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/b.ts", oldText: "x", newText: "y" },
		});
		assert.equal(unlockedEdit, undefined);
		const unlockedWrite = await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const x = 1;\n" },
		});
		assert.equal(unlockedWrite, undefined);
	});
});

// --- 5. Read-only bash allowlist -------------------------------------------

test("isReadOnlyBashAllowed enforces strict shell allowlist", () => {
	const allowed = [
		"ls",
		"ls -la src",
		"wc -l src/index.ts",
		"git status",
		"git status --porcelain",
		"git diff --stat",
		"git log --oneline -n 10 | head -n 5",
		"git log --oneline | head -n 20",
		"git --no-pager -C /tmp/repo show HEAD | tail -n 5",
		"git log --grep='a && b' -n 5 | wc -l",
		"git branch --show-current",
		"git branch -a",
		"git branch -vv",
		"git branch --list 'feat/*'",
		"git branch --color",
		"git branch --color=always",
		"git branch --abbrev=8 -v",
	];
	for (const cmd of allowed) {
		assert.equal(isReadOnlyBashAllowed(cmd), true, `expected allowed: ${cmd}`);
	}

	const denied = [
		"",
		"npm test",
		"pytest",
		"node --test",
		"git diff --output=/tmp/x",
		"git log --output /tmp/x",
		"git show --ext-diff HEAD",
		"git -c core.pager=sh log",
		"git branch --unset-up",
		"git branch --set-up=origin/foo",
		"git branch --edit-desc",
		"git branch -uorigin/bar",
		"git branch -D foo",
		"git branch -d foo",
		"git branch -m old new",
		"git branch new-branch",
		"git branch --color new-branch",
		"git branch --abbrev new-branch",
		"git branch --column new-branch",
		"ls @(npm test)",
		"git status && rm -rf /",
		"git status; echo hi",
		"git status || true",
		"git diff > out.txt",
		"cat < /etc/passwd",
		"echo $(whoami)",
		'git log "$(whoami)"',
		"git log `whoami`",
		"ls <(echo hi)",
		"ls\nrm -rf /",
		"git log | xargs rm",
		"git checkout -b foo",
	];
	for (const cmd of denied) {
		assert.equal(isReadOnlyBashAllowed(cmd), false, `expected denied: ${cmd}`);
	}
});

test("RB-6: isReadOnlyBashAllowed permits documented read-only gh inspection and safe git preflight while blocking mutations", () => {
	const allowed = [
		"gh auth status",
		"gh pr view 55",
		"gh pr view 55 --json title,state,headRefName",
		"gh pr list --state merged --search \"merged:>=2026-01-01\"",
		"gh pr checks 55 --repo owner/repo",
		"gh pr diff 55 | head -n 40",
		"gh pr status",
		"gh run list --repo owner/repo --limit 10",
		"gh run view 12345 --repo owner/repo --log-failed",
		"gh issue list --repo owner/repo --json number,title",
		"gh issue view 42",
		"gh release list --limit 5",
		"gh release view v1.0.0",
		"git merge-base --is-ancestor dev HEAD",
		"git merge-base dev HEAD",
		"git describe --tags --abbrev=0",
		"git describe --always --dirty",
		"git fetch",
		"git fetch origin",
		"git fetch origin dev",
		"git fetch --tags",
		"git fetch --all",
		"git fetch --dry-run origin",
		"git --no-pager -C /repo fetch origin",
	];
	for (const cmd of allowed) {
		assert.equal(isReadOnlyBashAllowed(cmd), true, `expected allowed: ${cmd}`);
	}

	const denied = [
		"gh",
		"gh pr",
		"gh auth login",
		"gh auth logout",
		"gh auth token",
		"gh auth status --show-token",
		"gh auth status -t",
		"gh pr create --fill",
		"gh pr merge 55 --squash --delete-branch",
		"gh pr edit 55 --title new",
		"gh pr comment 55 --body hi",
		"gh pr close 55",
		"gh pr checkout 55",
		"gh pr review 55 --approve",
		"gh issue create --title bug",
		"gh issue edit 42 --title x",
		"gh issue close 42",
		"gh release create v1.0.0",
		"gh release delete v1.0.0",
		"gh release download v1.0.0",
		"gh run rerun 123",
		"gh run cancel 123",
		"gh run watch 123",
		"gh api repos/owner/repo/pulls/55",
		"gh pr view 55 && rm -rf /",
		"gh pr list; echo pwned",
		"gh pr view 55 > pr.txt",
		"gh pr view $(whoami)",
		"gh pr view 55 | xargs rm",
		"git fetch origin dev:dev",
		"git fetch origin +refs/heads/main:refs/heads/main",
		"git fetch origin :branch",
		"git fetch -- origin dev:dev",
		"git fetch --force origin",
		"git fetch -f origin",
		"git fetch --prune",
		"git fetch -p",
		"git fetch --prune-tags",
		"git fetch -P",
		"git fetch -fp origin",
		"git fetch -u origin dev",
		"git fetch --update-head-ok origin dev",
		"git fetch --upload-pack=evil origin",
		"git -c core.sshCommand=evil fetch origin",
		"git checkout dev",
		"git switch dev",
		"git pull --ff-only",
		"git merge --ff-only main",
		"git tag -a v1.0.0 -m v1.0.0",
	];
	for (const cmd of denied) {
		assert.equal(isReadOnlyBashAllowed(cmd), false, `expected denied: ${cmd}`);
	}
});

test("RB-7: classifyCommitOrPrCommand and delegation-runtime gate gh pr merge through evaluateCompletionGate", async () => {
	assert.equal(classifyCommitOrPrCommand("gh pr merge 123 --squash --delete-branch"), "pr-merge");
	assert.equal(classifyCommitOrPrCommand("gh pr merge 123 --merge"), "pr-merge");
	assert.equal(isCommitOrPrCommand("gh pr merge 123 --squash --delete-branch"), true);
	assert.equal(isCommitOrPrCommand("gh pr merge 123 --merge"), true);
	assert.equal(classifyCommitOrPrCommand("gh pr merge 123 && rm -rf /"), null);
	assert.equal(classifyCommitOrPrCommand("gh pr merge 123; echo hi"), null);
	assert.equal(classifyCommitOrPrCommand("gh pr merge $(whoami)"), null);

	// evaluateCompletionGate respects waveReadyToCommit option
	const state = createDelegationState();
	recordFileMutation(state, DEFAULT_DELEGATION_CONFIG, "src/a.ts", 60, 100);
	assert.deepEqual(evaluateCompletionGate(state, DEFAULT_DELEGATION_CONFIG).pending, ["tests", "code-review"]);
	assert.deepEqual(evaluateCompletionGate(state, DEFAULT_DELEGATION_CONFIG, { waveReadyToCommit: true }).pending, []);
	assert.deepEqual(
		evaluateCompletionGate(state, DEFAULT_DELEGATION_CONFIG, { waveReadyToCommit: false }).pending,
		["tests", "code-review"],
	);

	// Runtime integration: gh pr merge blocked when tests/review pending, allowed once verified
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Merge PR after verifying");

		const t0 = Date.now();
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "c1",
			status: "completed",
			role: "coder",
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

		const blockedMerge = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "gh pr merge 42 --squash --delete-branch" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedMerge?.block, true);
		assert.match(blockedMerge?.reason ?? "", /tests/i);
		assert.match(blockedMerge?.reason ?? "", /code-review/i);

		// Verify tests & review
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "c2",
			status: "completed",
			role: "coder",
			startedAt: t0 + 110,
			finishedAt: t0 + 150,
			activitySummary: {
				editedFiles: [],
				passedCommands: [{ command: "node --test", at: t0 + 130 }],
			},
		});
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev1",
			status: "completed",
			role: "reviewer",
			startedAt: t0 + 160,
			finishedAt: t0 + 200,
		});

		const allowedMerge = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "gh pr merge 42 --merge" },
		});
		assert.equal(allowedMerge, undefined);
	});
});

// --- 6. Role->model routing via subagent tool_call -------------------------

test("subagent tool_call resolves roles in-place, guards explicit overrides, handles fallback, and works when mode=off", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				delegation: {
					roles: {
						"custom-coder": { provider: "custom-prov", model: "custom-model", thinking: "low" },
					},
				},
			}),
		);

		const host = await startOrchestrator(cwd, {
			modelRegistry: {
				getProviderAuthStatus: (provider: string) =>
					provider === "opencode-go" ? { configured: true } : { configured: false },
			},
		});
		await runPrompt(host, "Implement the feature");

		// Single-run explore role injects provider/model/thinking/tools
		const exploreInput: Record<string, unknown> = { role: "explore", task: "find routes" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: exploreInput }), undefined);
		assert.equal(exploreInput.provider, "opencode-go");
		assert.equal(exploreInput.model, "deepseek-v4.1-flash");
		assert.equal(exploreInput.thinking, "medium");
		assert.deepEqual(exploreInput.tools, ["read", "grep", "find", "ls"]);

		// Single-run reviewer role inherits parent model (no provider/model set)
		const reviewerInput: Record<string, unknown> = { role: "reviewer", task: "review diff" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: reviewerInput }), undefined);
		assert.equal("provider" in reviewerInput, false);
		assert.equal("model" in reviewerInput, false);
		assert.equal(reviewerInput.thinking, "high");
		assert.deepEqual(reviewerInput.tools, ["read", "grep", "find", "ls", "bash"]);

		// Plan tasks[] resolves roles per step
		const planInput: Record<string, unknown> = {
			tasks: [
				{ id: "s1", role: "research", task: "read docs" },
				{ id: "s2", role: "coder", task: "implement", dependsOn: ["s1"] },
			],
		};
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: planInput }), undefined);
		const tasks = planInput.tasks as Record<string, unknown>[];
		assert.equal(tasks[0]?.provider, "opencode-go");
		assert.equal(tasks[0]?.model, "deepseek-v4.1-flash");
		assert.equal(tasks[0]?.thinking, "low");
		assert.deepEqual(tasks[0]?.tools, ["read", "grep", "find", "ls"]);
		assert.equal(tasks[1]?.provider, "opencode-go");
		assert.equal(tasks[1]?.model, "hy4-flash-free");
		assert.equal(tasks[1]?.thinking, "high");

		// Unknown role rejected cleanly
		const unknownRes = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { role: "wizard", task: "do magic" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(unknownRes?.block, true);
		assert.match(unknownRes?.reason ?? "", /explore/);
		assert.match(unknownRes?.reason ?? "", /reviewer/);

		// Explicit provider/model with role denied when prompt has no model mention
		const overrideRes = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { role: "explore", provider: "anthropic", model: "claude-opus-4-6", task: "search" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(overrideRes?.block, true);
		assert.match(overrideRes?.reason ?? "", /Omit provider\/model/);

		// Allowed when prompt mentions a model
		await runPrompt(host, "Use opus for explore on this search");
		const allowedWithMention: Record<string, unknown> = {
			role: "explore",
			provider: "anthropic",
			model: "claude-opus-4-6",
			task: "search",
		};
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: allowedWithMention }), undefined);
		assert.equal(allowedWithMention.provider, "anthropic");
		assert.equal(allowedWithMention.model, "claude-opus-4-6");

		// Allowed when !direct AND role routing still resolves when provider/model omitted
		await runPrompt(host, "!direct Run a check");
		const directOverride: Record<string, unknown> = {
			role: "explore",
			provider: "anthropic",
			model: "claude-opus-4-6",
			task: "search",
		};
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: directOverride }), undefined);
		const directRouted: Record<string, unknown> = { role: "explore", task: "search" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: directRouted }), undefined);
		assert.equal(directRouted.provider, "opencode-go");
		assert.equal(directRouted.model, "deepseek-v4.1-flash");

		// Role routing still resolves even when mode: "off"
		await host.runCommand("delegation", "off");
		await runPrompt(host, "Normal prompt");
		const offRouted: Record<string, unknown> = { role: "coder", task: "write code" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: offRouted }), undefined);
		assert.equal(offRouted.provider, "opencode-go");
		assert.equal(offRouted.model, "hy4-flash-free");
	});
});

test("built-in default missing auth falls back to inherited model while user-configured role passes through", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				delegation: {
					roles: {
						coder: { provider: "custom-no-auth", model: "custom-coder", thinking: "high" },
					},
				},
			}),
		);

		const host = await startOrchestrator(cwd, {
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: false }),
			},
		});
		await runPrompt(host, "Implement change");

		// Built-in explore falls back cleanly without setting provider/model
		const exploreInput: Record<string, unknown> = { role: "explore", task: "search" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: exploreInput }), undefined);
		assert.equal("provider" in exploreInput, false);
		assert.equal("model" in exploreInput, false);
		assert.equal(exploreInput.thinking, "medium");
		assert.deepEqual(exploreInput.tools, ["read", "grep", "find", "ls"]);
		assert.equal(host.notifications.filter((n) => /falling back/i.test(n.message)).length, 1);

		// Second explore call does not duplicate fallback notification
		const exploreInput2: Record<string, unknown> = { role: "explore", task: "search again" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: exploreInput2 }), undefined);
		assert.equal(host.notifications.filter((n) => /falling back/i.test(n.message)).length, 1);

		// User-configured coder still passes its configured provider/model through
		const coderInput: Record<string, unknown> = { role: "coder", task: "code" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: coderInput }), undefined);
		assert.equal(coderInput.provider, "custom-no-auth");
		assert.equal(coderInput.model, "custom-coder");
	});
});

// --- 7. Post-edit test + thresholded code-review gates --------------------

test("doc-only edit does not arm tests or review gate", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Update docs");
		await host.fire("tool_call", { toolName: "read", input: { path: "README.md" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "README.md" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "README.md", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "README.md", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		const commitCheck = await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'docs'" } });
		assert.equal(commitCheck, undefined);
		const settle = await fireBoundary(host);
		assert.notEqual(settle.continue, true);
	});
});

test("single small .ts edit arms tests gate only, ignores weak/stale test runs, and clears on coder pass", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Fix one bug");
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
		});
		const editAt = Date.now();
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		// git commit blocked for tests (not code-review)
		const commitBlocked = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'fix'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(commitBlocked?.block, true);
		assert.match(commitBlocked?.reason ?? "", /test/i);
		assert.doesNotMatch(commitBlocked?.reason ?? "", /review/i);

		// Weak command / dev server / stale command before edit must NOT clear tests gate
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "r1",
			status: "completed",
			role: "coder",
			startedAt: editAt - 500,
			finishedAt: editAt + 500,
			activitySummary: {
				editedFiles: [],
				passedCommands: [
					{ command: "node --test || true", at: editAt + 100 },
					{ command: "uvicorn app:main", at: editAt + 200 },
					{ command: "node --test", at: editAt - 100 },
				],
			},
		});
		const stillBlocked = await fireBoundary(host);
		assert.equal(stillBlocked.continue, true);
		assert.ok(
			stillBlocked.entries.some(
				(e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate",
			),
		);

		// Valid passing test run after last edit clears tests gate
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "r2",
			status: "completed",
			role: "coder",
			startedAt: editAt + 600,
			finishedAt: editAt + 900,
			activitySummary: {
				editedFiles: [],
				passedCommands: [{ command: "node --test", at: editAt + 800 }],
			},
		});

		const commitAllowed = await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'fix'" },
		});
		assert.equal(commitAllowed, undefined);

		const settleAllowed = await fireBoundary(host);
		assert.notEqual(settleAllowed.continue, true);

		// Successful git commit clears dirty state
		await host.fire("tool_result", {
			toolName: "bash",
			input: { command: "git commit -m 'fix'" },
			isError: false,
			content: [],
		});
	});
});

test("multi-file or large edit arms tests + review gates, requires fresh reviewer completion, and respects override & settleAttemptCap", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement multi-file change");

		const t0 = Date.now();
		// Coder subagent edits 2 files and runs passing tests
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "c1",
			status: "completed",
			role: "coder",
			startedAt: t0,
			finishedAt: t0 + 1000,
			activitySummary: {
				editedFiles: [
					{ path: "src/one.ts", changedLines: 10 },
					{ path: "src/two.ts", changedLines: 10 },
				],
				passedCommands: [{ command: "pytest -q", at: t0 + 900 }],
				lastEditAt: t0 + 500,
			},
		});

		// Tests passed, so only code-review remains pending
		const blocked = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'feat'" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /review/i);

		// Stale reviewer started BEFORE lastReviewEditAt does NOT clear review gate
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev-stale",
			status: "completed",
			role: "reviewer",
			startedAt: t0 + 100,
			finishedAt: t0 + 1100,
		});
		assert.equal(
			((await host.fire("tool_call", { toolName: "bash", input: { command: "git push" } })) as { block?: boolean })
				?.block,
			true,
		);

		// Failed reviewer does NOT clear review gate
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev-fail",
			status: "failed",
			role: "reviewer",
			startedAt: t0 + 1200,
			finishedAt: t0 + 1300,
		});
		assert.equal(
			((await host.fire("tool_call", { toolName: "bash", input: { command: "gh pr create" } })) as { block?: boolean })
				?.block,
			true,
		);

		// orchestrator_override skips one settle block cleanly
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "testing override" });
		const overriddenSettle = await fireBoundary(host);
		assert.notEqual(overriddenSettle.continue, true);

		// Next settles hit settleAttemptCap (2) then fail open
		const b1 = await fireBoundary(host);
		assert.equal(b1.continue, true);
		const b2 = await fireBoundary(host);
		assert.equal(b2.continue, true);
		const capOpen = await fireBoundary(host);
		assert.notEqual(capOpen.continue, true);

		// Fresh completed reviewer clears review gate -> commit succeeds & clears dirty state
		host.pi.events.emit(ORCHESTRATION_EVENTS.runSettled, {
			runId: "rev-ok",
			status: "completed",
			role: "reviewer",
			startedAt: t0 + 1400,
			finishedAt: t0 + 1600,
		});
		assert.equal(
			await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'feat'" } }),
			undefined,
		);
		await host.fire("tool_result", {
			toolName: "bash",
			input: { command: "git commit -m 'feat'" },
			isError: false,
			content: [],
		});

		// Dirty state cleared -> next settle passes
		await runPrompt(host, "Next task");
		const cleanSettle = await fireBoundary(host);
		assert.notEqual(cleanSettle.continue, true);
	});
});

// --- 8. Child worker exemption ---------------------------------------------

test("delegated worker sessions are completely inert to parent delegation guardrails", async () => {
	await withTempDir(async (cwd) => {
		const worker = await startOrchestrator(cwd, { role: "worker" });
		const { sections } = await runPrompt(worker, "Do worker tasks");
		assert.equal(sections[DELEGATION_SECTION], undefined);

		// Worker can read/edit/write/bash freely
		for (let i = 0; i < 10; i += 1) {
			assert.equal(await worker.fire("tool_call", { toolName: "read", input: { path: `f${i}.ts` } }), undefined);
		}
		assert.equal(
			await worker.fire("tool_call", { toolName: "write", input: { path: "src/w.ts", content: "x" } }),
			undefined,
		);
		assert.equal(
			await worker.fire("tool_call", { toolName: "edit", input: { path: "src/x.ts", oldText: "a", newText: "b" } }),
			undefined,
		);
		assert.equal(
			await worker.fire("tool_call", { toolName: "bash", input: { command: "npm test" } }),
			undefined,
		);
		await worker.fire("tool_result", {
			toolName: "write",
			input: { path: "src/w.ts", content: "x" },
			isError: false,
			content: [],
		});

		const settle = await fireBoundary(worker);
		assert.notEqual(settle.continue, true);
		assert.equal(worker.commands.has("delegation"), false);
	});
});

// --- 9. before_agent_start section injection without systemPrompt ----------

test("before_agent_start injects sections.delegation on user prompts without setting systemPrompt", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		const { event, res, sections } = await runPrompt(host, "Implement a new module");
		assert.equal(res, undefined);
		assert.equal(event.systemPrompt, "base system prompt");
		assert.equal(typeof sections[DELEGATION_SECTION], "string");
		assert.match(sections[DELEGATION_SECTION]!, /explore/);
		assert.match(sections[DELEGATION_SECTION]!, /coder/);
		assert.match(sections[DELEGATION_SECTION]!, /reviewer/);
		assert.match(sections[DELEGATION_SECTION]!, /Skill override:.*enforce.*\/orchestrate/);
	});
});

// --- 10. /delegation command -----------------------------------------------

test("/delegation command toggles modes and outputs status and --json", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement task");

		await host.runCommand("delegation");
		const statusText = String(host.messages.at(-1)?.message.content ?? "");
		assert.match(statusText, /enforce/);
		assert.match(statusText, /explore/);

		await host.runCommand("delegation", "warn");
		assert.match(String(host.messages.at(-1)?.message.content ?? ""), /warn/);

		await host.runCommand("delegation", "--json");
		const parsed = JSON.parse(String(host.messages.at(-1)?.message.content ?? "")) as {
			mode: string;
			state: { turnMode: string };
			roles: Record<string, unknown>;
		};
		assert.equal(parsed.mode, "warn");
		assert.equal(parsed.state.turnMode, "implement");
		assert.ok(parsed.roles.explore);
	});
});

// --- Pure helpers smoke tests ----------------------------------------------

test("pure delegation helpers verify commands and gate state accurately", () => {
	const state = createDelegationState();
	const cfg = DEFAULT_DELEGATION_CONFIG;
	resetTurnState(state, classifyTurn("Implement", cfg));

	assert.equal(isCommitOrPrCommand("git commit -m 'x'"), true);
	assert.equal(isCommitOrPrCommand("git --no-pager -C /repo push origin main"), true);
	assert.equal(isCommitOrPrCommand("gh pr create --fill"), true);
	assert.equal(isCommitOrPrCommand("git status"), false);

	assert.equal(isVerifyCommand("node --test foo.test.ts", cfg), true);
	assert.equal(isVerifyCommand("custom-runner --all", cfg, "custom-runner"), true);
	assert.equal(isVerifyCommand("node --test || true", cfg), false);
	assert.equal(isVerifyCommand("uvicorn main:app", cfg), false);

	recordFileMutation(state, cfg, "src/a.ts", 60, 100);
	assert.deepEqual(evaluateCompletionGate(state, cfg).pending, ["tests", "code-review"]);
	assert.equal(recordPassedCommand(state, cfg, "node --test", 90), false);
	assert.equal(recordPassedCommand(state, cfg, "node --test", 110), true);
	assert.deepEqual(evaluateCompletionGate(state, cfg).pending, ["code-review"]);

	recordChildSettled(state, cfg, {
		runId: "r-sec",
		status: "completed",
		role: "security-reviewer",
		startedAt: 100,
		finishedAt: 150,
	});
	assert.deepEqual(evaluateCompletionGate(state, cfg).pending, []);

	recordSteer(state, cfg, "subagent_answer", { id: "r1" });
	assert.equal(state.escalationUnlocked, false);
	clearDirtyState(state);
	assert.equal(state.testsRequired, false);
	assert.equal(state.reviewRequired, false);
});

// --- Regression tests for code-review findings (1-7) ----------------------

test("Fix 1: discovery budget, maxEditedFilesPerTurn, and escalationUnlocked persist across assistant turn_start roundtrips and reset only on next user prompt", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		// Security mode: discoveryBudget = 2
		await runPrompt(host, "Audit auth for security issues");

		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } }), undefined);
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "read", input: { path: "src/b.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/b.ts" }, isError: false, content: [] });

		// Simulate assistant tool-call roundtrip firing turn_start without a new before_agent_start
		await host.fire("turn_start", { turnIndex: 1 });
		await host.fire("turn_start", { turnIndex: 2 });

		// Discovery budget MUST still be exhausted across turn_start iterations
		const thirdRead = (await host.fire("tool_call", { toolName: "read", input: { path: "src/c.ts" } })) as
			| { block?: boolean }
			| undefined;
		assert.equal(thirdRead?.block, true);

		// Edit 1 file, then fire another turn_start; 2nd file edit MUST still be blocked
		assert.equal(
			await host.fire("tool_call", { toolName: "edit", input: { path: "src/a.ts", oldText: "1", newText: "2" } }),
			undefined,
		);
		await host.fire("turn_start", { turnIndex: 3 });
		const secondFileEdit = (await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/b.ts", oldText: "1", newText: "2" },
		})) as { block?: boolean } | undefined;
		assert.equal(secondFileEdit?.block, true);

		// Unlock via 2 steers -> escalationUnlocked must persist across turn_start
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "r-persist",
			status: "running",
			at: Date.now(),
		});
		await host.fire("tool_call", { toolName: "subagent_interrupt", input: { id: "r-persist" } });
		await host.fire("tool_call", { toolName: "subagent_resume", input: { id: "r-persist", task: "retry" } });
		await host.fire("turn_start", { turnIndex: 4 });
		assert.equal(
			await host.fire("tool_call", { toolName: "write", input: { path: "src/c.ts", content: "export const c = 1;\n" } }),
			undefined,
		);

		// Next user prompt (before_agent_start) resets discovery, editedFilesThisTurn, and escalationUnlocked
		await runPrompt(host, "Implement another fix");
		assert.equal(await host.fire("tool_call", { toolName: "read", input: { path: "src/c.ts" } }), undefined);
		const relockedWrite = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/d.ts", content: "export const d = 1;\n" },
		})) as { block?: boolean } | undefined;
		assert.equal(relockedWrite?.block, true);
	});
});

test("Fix 2a: agent_before_settle parks cleanly when waitForSubagents is enabled and a live run exists", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { waitForSubagents: true, openTodos: false, repeatedFailure: false, loops: false },
			}),
		);
		const branch: Record<string, unknown>[] = [];
		const host = await startOrchestrator(cwd, { branch });
		await runPrompt(host, "Implement change");

		// Dirty code edit arms delegation tests gate
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/app.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		// Active live run starts
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "live-1",
			status: "running",
			at: Date.now(),
		});

		const boundary = await fireBoundary(host);
		assert.notEqual(boundary.continue, true);
		assert.equal(
			boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			false,
		);
	});
});

test("Fix 2b: verification.command passing on agent_before_settle satisfies delegation tests gate without contradictory block", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { openTodos: false, repeatedFailure: false, loops: false },
				verification: { command: "node --test" },
			}),
		);
		const branch: Record<string, unknown>[] = [
			{
				type: "message",
				id: "tc1",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/app.ts" } }],
				},
			},
			{
				type: "message",
				id: "tr1",
				message: {
					role: "toolResult",
					toolCallId: "e1",
					toolName: "edit",
					isError: false,
					content: [{ type: "text", text: "ok" }],
				},
			},
		];
		const host = await startOrchestrator(cwd, {
			branch,
			exec: async () => ({ code: 0, stdout: "pass 4", stderr: "", killed: false, truncated: false }),
		});
		await runPrompt(host, "Fix bug");
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/app.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		const boundary = await fireBoundary(host);
		const gateEntry = boundary.entries.find(
			(e) => (e as { customType?: string }).customType === "orchestrator-gate",
		) as { data?: { verification?: { status?: string } } } | undefined;
		assert.equal(gateEntry?.data?.verification?.status, "passed");
		assert.equal(
			boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
			false,
		);
		for (const entry of boundary.entries) {
			branch.push(entry as Record<string, unknown>);
		}
		const secondBoundary = await fireBoundary(host);
		assert.notEqual(secondBoundary.continue, true);
	});
});

test("Fix 4: recordSteer tracks resumeOf lineage, includes subagent_answer, and rejects unknown run IDs", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement fix");
		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });

		// Unrecognized run IDs must NOT increment or unlock
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "sa-unk",
			input: { id: "unknown-run", answer: "yes" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "sa-unk",
			input: { id: "unknown-run", answer: "yes" },
			isError: false,
			content: [{ type: "text", text: "Answer delivered to subagent unknown-run." }],
			details: { id: "unknown-run" },
		});
		await host.fire("tool_call", { toolName: "subagent_interrupt", input: { id: "unknown-run" } });
		const blockedAfterUnknown = (await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "x" },
		})) as { block?: boolean } | undefined;
		assert.equal(blockedAfterUnknown?.block, true);

		// Register run1, then mix delivered subagent_answer + resumeOf lineage interrupt to unlock
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "run1",
			status: "running",
			at: Date.now(),
		});
		await host.fire("tool_call", {
			toolName: "subagent_answer",
			toolCallId: "sa-1",
			input: { id: "req-run1", answer: "use postgres" },
		});
		await host.fire("tool_result", {
			toolName: "subagent_answer",
			toolCallId: "sa-1",
			input: { id: "req-run1", answer: "use postgres" },
			isError: false,
			content: [{ type: "text", text: "Answer delivered to subagent run1." }],
			details: { id: "run1" },
		});
		host.pi.events.emit(ORCHESTRATION_EVENTS.runStarted, {
			runId: "run2",
			status: "running",
			resumeOf: "run1",
			at: Date.now(),
		});
		await host.fire("tool_call", { toolName: "subagent_interrupt", input: { id: "run2" } });
		assert.ok(host.notifications.some((n) => /unlocked/i.test(n.message)));

		const allowedAfterLineage = await host.fire("tool_call", {
			toolName: "write",
			input: { path: "src/new.ts", content: "export const x = 1;\n" },
		});
		assert.equal(allowedAfterLineage, undefined);
	});
});

test("Fix 5a: trusted project without .pi/orchestrator.json registers orchestrator_override and skips commit or settle block once", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd, { trusted: true });
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), true);

		await runPrompt(host, "Implement fix");
		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/a.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		// Grant override -> skips 1 blocked git commit
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "skip commit gate once" });
		assert.equal(
			await host.fire("tool_call", { toolName: "bash", input: { command: "git commit -m 'wip'" } }),
			undefined,
		);
		// Override is consumed; subsequent commit is blocked again
		const secondCommit = (await host.fire("tool_call", {
			toolName: "bash",
			input: { command: "git commit -m 'wip2'" },
		})) as { block?: boolean } | undefined;
		assert.equal(secondCommit?.block, true);

		// Grant override -> skips 1 blocked agent_before_settle
		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "skip settle gate once" });
		const settled = await fireBoundary(host);
		assert.notEqual(settled.continue, true);
		const nextSettled = await fireBoundary(host);
		assert.equal(nextSettled.continue, true);
	});
});

test("Fix 5b: consuming orchestrator_override on a loop-breaker block does not skip a subsequent delegation settlement gate", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({
				version: 1,
				block: { loops: true, openTodos: false, repeatedFailure: false },
			}),
		);
		const branch: Record<string, unknown>[] = [];
		const host = await startOrchestrator(cwd, { trusted: true, branch });
		await runPrompt(host, "Investigate and fix");

		// Trigger loop-breaker with 2 identical failing read-only git status calls; 3rd call blocks
		for (let i = 0; i < 2; i += 1) {
			const call = { toolName: "bash", toolCallId: `loop-${i}`, input: { command: "git status" } };
			assert.equal(await host.fire("tool_call", call), undefined);
			await host.fire("tool_result", {
				...call,
				isError: true,
				content: [{ type: "text", text: "fatal: not a git repository" }],
			});
		}

		// 3rd call is blocked by loop breaker; grant override and let it run (consuming pendingOverride)
		const loopBlocked = (await host.fire("tool_call", {
			toolName: "bash",
			toolCallId: "loop-2",
			input: { command: "git status" },
		})) as { block?: boolean } | undefined;
		assert.equal(loopBlocked?.block, true);

		await host.callTool(GATE_OVERRIDE_TOOL, { reason: "retry git status once" });
		const loopOverridden = await host.fire("tool_call", {
			toolName: "bash",
			toolCallId: "loop-4",
			input: { command: "git status" },
		});
		assert.equal(loopOverridden, undefined);

		// Now make a dirty code edit -> delegation settlement gate MUST still block
		await host.fire("tool_call", { toolName: "read", input: { path: "src/app.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/app.ts" }, isError: false, content: [] });
		await host.fire("tool_call", { toolName: "edit", input: { path: "src/app.ts", oldText: "a", newText: "b" } });
		await host.fire("tool_result", {
			toolName: "edit",
			input: { path: "src/app.ts", oldText: "a", newText: "b" },
			isError: false,
			content: [],
		});

		const boundary = await fireBoundary(host);
		assert.equal(boundary.continue, true);
		assert.ok(
			boundary.entries.some((e) => (e as { customType?: string }).customType === "orchestrator-delegation-gate"),
		);
	});
});

test("Fix 5c: untrusted project with .pi/orchestrator.json and no wave/pending gate does NOT register orchestrator_override", async () => {
	await withTempDir(async (cwd) => {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(
			path.join(cwd, ".pi", "orchestrator.json"),
			JSON.stringify({ version: 1, block: { openTodos: true, loops: true } }),
		);
		const host = await startOrchestrator(cwd, { trusted: false });
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);
		await runPrompt(host, "Hello");
		assert.equal(host.tools.has(GATE_OVERRIDE_TOOL), false);
	});
});

test("Fix 6: relative read and absolute edit for the same file resolve against cwd and count as 1 file", async () => {
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Fix one file");

		await host.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/a.ts" }, isError: false, content: [] });

		// Editing absolute path of the same file must be ALLOWED
		const absEdit = await host.fire("tool_call", {
			toolName: "edit",
			input: { path: path.join(cwd, "src/a.ts"), oldText: "a", newText: "b" },
		});
		assert.equal(absEdit, undefined);

		// Editing relative path of the same file again counts as the same 1 file
		const relEdit = await host.fire("tool_call", {
			toolName: "edit",
			input: { path: "src/a.ts", oldText: "b", newText: "c" },
		});
		assert.equal(relEdit, undefined);

		// Reading & editing a distinct file in the same turn is still blocked (maxEditedFilesPerTurn = 1)
		await host.fire("tool_call", { toolName: "read", input: { path: "src/b.ts" } });
		await host.fire("tool_result", { toolName: "read", input: { path: "src/b.ts" }, isError: false, content: [] });
		const secondFile = (await host.fire("tool_call", {
			toolName: "edit",
			input: { path: path.join(cwd, "src/b.ts"), oldText: "x", newText: "y" },
		})) as { block?: boolean } | undefined;
		assert.equal(secondFile?.block, true);
	});
});

test("Fix 7: per-file lastEditAt ignores trailing doc edit and queued reviewer uses startedAt >= lastReviewEditAt", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;

	// 7a: code edit at t=100, passing tests at t=200, doc edit at t=300 -> testsVerified stays true
	const s1 = createDelegationState();
	recordChildSettled(s1, cfg, {
		runId: "c1",
		status: "completed",
		role: "coder",
		startedAt: 50,
		finishedAt: 350,
		activitySummary: {
			editedFiles: [
				{ path: "src/app.ts", changedLines: 10, lastEditAt: 100 },
				{ path: "README.md", changedLines: 5, lastEditAt: 300 },
			],
			passedCommands: [{ command: "node --test", at: 200 }],
			lastEditAt: 300,
		},
	});
	assert.equal(s1.testsRequired, true);
	assert.equal(s1.testsVerified, true);

	// 7b: queued reviewer createdAt=50, code edit at t=100, startedAt=150, finishedAt=200 -> reviewVerified becomes true
	const s2 = createDelegationState();
	recordFileMutation(s2, cfg, "src/app.ts", 60, 100);
	assert.equal(s2.reviewRequired, true);
	assert.equal(s2.reviewVerified, false);

	recordChildSettled(s2, cfg, {
		runId: "rev-queued",
		status: "completed",
		role: "reviewer",
		startedAt: 150,
		finishedAt: 200,
	});
	assert.equal(s2.reviewVerified, true);
});

// --- Regression tests for code-review high-confidence fixes (1-4) ---------

test("Fix 1 (review): isSafeGitFetchArgs uses strict allowlist and blocks long-flag prefixes and mutating flags", () => {
	const allowed = [
		"git fetch",
		"git fetch origin",
		"git fetch origin dev",
		"git fetch origin refs/heads/dev",
		"git fetch --tags",
		"git fetch --all",
		"git fetch --dry-run origin",
		"git fetch -q origin dev",
		"git fetch -vt --no-tags origin",
		"git fetch --depth=1 origin dev",
		"git fetch --depth 1 origin dev",
		"git fetch --shallow-since=2026-01-01 origin",
		"git fetch --shallow-exclude v1.0.0 origin",
		"git fetch --deepen=2 origin",
		"git fetch --no-write-fetch-head --no-auto-gc --no-recurse-submodules origin",
		"git fetch --ipv4 --progress origin",
		"git fetch -- origin dev",
	];
	for (const cmd of allowed) {
		assert.equal(isReadOnlyBashAllowed(cmd), true, `expected allowed: ${cmd}`);
	}

	const denied = [
		'git fetch --upload-pac="id"',
		'git fetch --upload-pack="id" origin',
		"git fetch --forc origin",
		"git fetch --force origin",
		"git fetch --refma=refs/heads/*:refs/heads/*",
		"git fetch --refmap=refs/heads/*:refs/heads/*",
		"git fetch --prune-t",
		"git fetch --prune-tags",
		"git fetch --update-head-o origin",
		"git fetch --update-head-ok origin",
		"git fetch --set-upstream origin dev",
		"git fetch --server-option=x origin",
		"git fetch --all=1",
		"git fetch --depth -1",
		"git fetch --depth=a:b",
		"git fetch --depth",
		"git fetch -o foo origin",
		"git fetch -f origin",
		"git fetch -p",
		"git fetch -P",
		"git fetch -u origin dev",
		"git fetch -k origin",
		"git fetch -j 4 origin",
		"git fetch - origin",
		"git fetch origin dev:dev",
		"git fetch origin +refs/heads/*:refs/heads/*",
		"git fetch origin :branch",
		"git fetch -- origin dev:dev",
	];
	for (const cmd of denied) {
		assert.equal(isReadOnlyBashAllowed(cmd), false, `expected denied: ${cmd}`);
	}
});

test("Fix 2 (review): gh auth status blocks --show-token=..., prefixes, and short-flag clusters containing t", () => {
	const allowed = [
		"gh auth status",
		"gh auth status -a",
		"gh auth status --active",
		"gh auth status -h github.com",
		"gh auth status --hostname github.com",
		"gh auth status --hostname=github.com",
		"gh auth status -hhostWithT",
		"gh auth status -- --show-token",
	];
	for (const cmd of allowed) {
		assert.equal(isReadOnlyBashAllowed(cmd), true, `expected allowed: ${cmd}`);
	}

	const denied = [
		"gh auth status --show-token=true",
		"gh auth status --show-token=1",
		"gh auth status --show-token=false",
		"gh auth status --show-t",
		"gh auth status --show-token",
		"gh auth status -t",
		"gh auth status -at",
		"gh auth status -ta",
		"gh auth status -ath",
	];
	for (const cmd of denied) {
		assert.equal(isReadOnlyBashAllowed(cmd), false, `expected denied: ${cmd}`);
	}
});

test("Fix 3 (review): evaluateSubagentCall allows role + explicit provider/model only when allowExplicitModelOverride is true", () => {
	const state = createDelegationState();
	const cfg = DEFAULT_DELEGATION_CONFIG;
	resetTurnState(state, classifyTurn("Continue the task after wake", cfg));
	assert.equal(state.promptHasModelMention, false);

	const coderInput: Record<string, unknown> = {
		role: "coder",
		provider: "opencode-go",
		model: "hy4-flash-free",
		task: "implement ticket",
	};

	const blockedDefault = evaluateSubagentCall(state, cfg, { ...coderInput });
	assert.equal(blockedDefault.allowed, false);
	assert.equal(blockedDefault.kind, "explicit-override");

	const blockedFalse = evaluateSubagentCall(state, cfg, { ...coderInput }, { allowExplicitModelOverride: false });
	assert.equal(blockedFalse.allowed, false);
	assert.equal(blockedFalse.kind, "explicit-override");

	const allowedWave = evaluateSubagentCall(state, cfg, coderInput, { allowExplicitModelOverride: true });
	assert.equal(allowedWave.allowed, true);
	assert.equal(allowedWave.patches.length, 1);
	assert.equal(allowedWave.patches[0]?.thinking, "high");
	assert.equal(allowedWave.patches[0]?.provider, undefined);
	assert.equal(allowedWave.patches[0]?.model, undefined);

	// Role with tools default still patches missing tools while preserving explicit provider/model
	const exploreInput: Record<string, unknown> = {
		role: "explore",
		provider: "mistral",
		model: "zai-glm-5-3-flash",
		task: "triage",
	};
	const allowedExplore = evaluateSubagentCall(state, cfg, exploreInput, { allowExplicitModelOverride: true });
	assert.equal(allowedExplore.allowed, true);
	assert.deepEqual(allowedExplore.patches[0]?.tools, ["read", "grep", "find", "ls"]);
	assert.equal(allowedExplore.patches[0]?.thinking, "medium");
});

test("Fix 4 (review): evaluateCompletionGate validates waveReadyToCommitAt against later code and review edits", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;
	const state = createDelegationState();
	recordFileMutation(state, cfg, "src/a.ts", 60, 100);
	assert.equal(state.lastCodeEditAt, 100);
	assert.equal(state.lastReviewEditAt, 100);

	// Verified at t=200 >= 100 -> gate bypassed
	assert.deepEqual(
		evaluateCompletionGate(state, cfg, { waveReadyToCommit: true, waveReadyToCommitAt: 200 }).pending,
		[],
	);

	// Null ready timestamp -> cannot bypass
	assert.deepEqual(
		evaluateCompletionGate(state, cfg, { waveReadyToCommit: true, waveReadyToCommitAt: null }).pending,
		["tests", "code-review"],
	);

	// Subsequent code edit at t=250 > 200 -> tests & review gates re-armed
	recordFileMutation(state, cfg, "src/b.ts", 5, 250);
	assert.deepEqual(
		evaluateCompletionGate(state, cfg, { waveReadyToCommit: true, waveReadyToCommitAt: 200 }).pending,
		["tests", "code-review"],
	);

	// Subsequent review-only edit (e.g. .json) at t=300 > 250 -> still blocks when testsVerified was true
	state.testsVerified = true;
	recordFileMutation(state, cfg, "package.json", 5, 300);
	assert.deepEqual(
		evaluateCompletionGate(state, cfg, { waveReadyToCommit: true, waveReadyToCommitAt: 250 }).pending,
		["code-review"],
	);
});

// --- Ticket #02: Mandatory role, resilient fan-out patching, fork gating ---

test("Ticket 02 (RB-2): enforce mode denies single and tasks[] subagent calls omitting role, while !direct, warn, and off allow them", async () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;
	const expectedRoles = Object.keys(cfg.roles).sort();

	// Pure unit checks in enforce mode (outside !direct)
	const enforceState = createDelegationState();
	resetTurnState(enforceState, classifyTurn("Implement feature", cfg));

	const singleMissing = evaluateSubagentCall(enforceState, cfg, { task: "find files" });
	assert.equal(singleMissing.allowed, false);
	assert.equal(singleMissing.patches.length, 0);
	for (const role of expectedRoles) {
		assert.match(singleMissing.reason ?? "", new RegExp(role), `reason must list valid role ${role}`);
	}

	const singleEmptyRole = evaluateSubagentCall(enforceState, cfg, { role: "   ", task: "find files" });
	assert.equal(singleEmptyRole.allowed, false);
	assert.equal(singleEmptyRole.patches.length, 0);
	for (const role of expectedRoles) {
		assert.match(singleEmptyRole.reason ?? "", new RegExp(role));
	}

	const fanoutInput: Record<string, unknown> = {
		tasks: [
			{ id: "s1", task: "a", role: "explore" },
			{ id: "s2", task: "b" },
		],
	};
	const fanoutMissing = evaluateSubagentCall(enforceState, cfg, fanoutInput);
	assert.equal(fanoutMissing.allowed, false);
	assert.equal(fanoutMissing.patches.length, 0);
	for (const role of expectedRoles) {
		assert.match(fanoutMissing.reason ?? "", new RegExp(role));
	}

	// !direct allows omitting role on both single and fan-out calls
	const directState = createDelegationState();
	resetTurnState(directState, classifyTurn("!direct Run subagents directly", cfg));
	assert.equal(evaluateSubagentCall(directState, cfg, { task: "find files" }).allowed, true);
	const directMixed = evaluateSubagentCall(directState, cfg, {
		tasks: [{ task: "a", role: "explore" }, { task: "b" }],
	});
	assert.equal(directMixed.allowed, true);
	assert.equal(directMixed.patches.length, 1);
	assert.equal(directMixed.patches[0]?.role, "explore");

	// warn and off modes allow omitting role (not blocked)
	for (const mode of ["warn", "off"] as const) {
		const modeCfg = { ...cfg, mode };
		const modeState = createDelegationState();
		resetTurnState(modeState, classifyTurn("Implement feature", modeCfg));
		assert.equal(evaluateSubagentCall(modeState, modeCfg, { task: "find files" }).allowed, true);
		const modeMixed = evaluateSubagentCall(modeState, modeCfg, {
			tasks: [{ task: "a", role: "explore" }, { task: "b" }],
		});
		assert.equal(modeMixed.allowed, true);
		assert.equal(modeMixed.patches.length, 1);
		assert.equal(modeMixed.patches[0]?.role, "explore");
	}

	// Runtime integration check via orchestrator tool_call hook
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement feature");

		const blockedSingle = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { task: "search code" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedSingle?.block, true);
		assert.match(blockedSingle?.reason ?? "", /explore/);

		const runtimeFanout: Record<string, unknown> = {
			tasks: [{ task: "a", role: "explore" }, { task: "b" }],
		};
		const blockedFanout = (await host.fire("tool_call", {
			toolName: "subagent",
			input: runtimeFanout,
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blockedFanout?.block, true);
		assert.match(blockedFanout?.reason ?? "", /coder/);
		// Blocked call must not mutate valid sibling entries
		const step0 = (runtimeFanout.tasks as Record<string, unknown>[])[0]!;
		assert.equal("provider" in step0, false);

		// Under !direct, runtime allows omitting role
		await runPrompt(host, "!direct search code");
		assert.equal(
			await host.fire("tool_call", { toolName: "subagent", input: { task: "search code" } }),
			undefined,
		);

		// Under warn and off modes, runtime allows omitting role
		await host.runCommand("delegation", "warn");
		await runPrompt(host, "Implement feature");
		assert.equal(
			await host.fire("tool_call", { toolName: "subagent", input: { task: "search code" } }),
			undefined,
		);

		await host.runCommand("delegation", "off");
		await runPrompt(host, "Implement feature");
		assert.equal(
			await host.fire("tool_call", { toolName: "subagent", input: { task: "search code" } }),
			undefined,
		);
	});
});

test("Ticket 02 (RB-2): warn and off modes preserve valid sibling patches in tasks[] alongside an unknown role, while enforce denies", async () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;

	// enforce mode still denies unknown role in tasks[]
	const enforceState = createDelegationState();
	resetTurnState(enforceState, classifyTurn("Implement feature", cfg));
	const enforceRes = evaluateSubagentCall(enforceState, cfg, {
		tasks: [
			{ task: "a", role: "explore" },
			{ task: "b", role: "wizard" },
		],
	});
	assert.equal(enforceRes.allowed, false);
	assert.equal(enforceRes.kind, "unknown-role");
	assert.equal(enforceRes.patches.length, 0);

	// warn and off modes allow and preserve valid sibling patches regardless of order
	for (const mode of ["warn", "off"] as const) {
		const modeCfg = { ...cfg, mode };
		const state = createDelegationState();
		resetTurnState(state, classifyTurn("Implement feature", modeCfg));

		// Unknown role BEFORE valid role
		const unknownFirst = evaluateSubagentCall(state, modeCfg, {
			tasks: [
				{ id: "s1", task: "magic", role: "wizard" },
				{ id: "s2", task: "search", role: "explore" },
			],
		});
		assert.equal(unknownFirst.allowed, true);
		assert.equal(unknownFirst.patches.length, 1);
		assert.equal(unknownFirst.patches[0]?.role, "explore");
		assert.equal(unknownFirst.patches[0]?.provider, "opencode-go");
		assert.equal(unknownFirst.patches[0]?.model, "deepseek-v4.1-flash");
		assert.match(unknownFirst.reason ?? "", /wizard/);

		// Valid role BEFORE unknown role
		const validFirst = evaluateSubagentCall(state, modeCfg, {
			tasks: [
				{ id: "s1", task: "search", role: "explore" },
				{ id: "s2", task: "magic", role: "wizard" },
			],
		});
		assert.equal(validFirst.allowed, true);
		assert.equal(validFirst.patches.length, 1);
		assert.equal(validFirst.patches[0]?.role, "explore");
		assert.match(validFirst.reason ?? "", /wizard/);
	}

	// Runtime integration: warn mode surfaces warning AND patches valid sibling; off mode patches valid sibling
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await host.runCommand("delegation", "warn");
		await runPrompt(host, "Implement feature");
		host.notifications.length = 0;

		const warnInput: Record<string, unknown> = {
			tasks: [
				{ id: "s1", task: "magic", role: "wizard" },
				{ id: "s2", task: "search", role: "explore" },
			],
		};
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: warnInput }), undefined);
		const warnTasks = warnInput.tasks as Record<string, unknown>[];
		assert.equal(warnTasks[1]?.provider, "opencode-go");
		assert.equal(warnTasks[1]?.model, "deepseek-v4.1-flash");
		assert.equal(warnTasks[1]?.thinking, "medium");
		assert.deepEqual(warnTasks[1]?.tools, ["read", "grep", "find", "ls"]);
		assert.ok(host.notifications.some((n) => n.type === "warning" && /wizard/.test(n.message)));

		await host.runCommand("delegation", "off");
		await runPrompt(host, "Implement feature");
		const offInput: Record<string, unknown> = {
			tasks: [
				{ id: "s1", task: "search", role: "explore" },
				{ id: "s2", task: "magic", role: "wizard" },
			],
		};
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: offInput }), undefined);
		const offTasks = offInput.tasks as Record<string, unknown>[];
		assert.equal(offTasks[0]?.provider, "opencode-go");
		assert.equal(offTasks[0]?.model, "deepseek-v4.1-flash");
	});
});

test("Ticket 02 (RB-3): handoff: 'fork' is gated in enforce mode unless !direct or warn/off, while standalone and lineage remain allowed", async () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;
	const enforceState = createDelegationState();
	resetTurnState(enforceState, classifyTurn("Implement feature", cfg));

	// Single call with handoff: "fork" denied in enforce mode
	const singleFork = evaluateSubagentCall(enforceState, cfg, {
		role: "explore",
		task: "find files",
		handoff: "fork",
	});
	assert.equal(singleFork.allowed, false);
	assert.equal(singleFork.patches.length, 0);
	assert.match(singleFork.reason ?? "", /cold-cache|transcript/i);
	assert.match(singleFork.reason ?? "", /standalone/i);
	assert.match(singleFork.reason ?? "", /lineage/i);
	assert.match(singleFork.reason ?? "", /!direct/);

	// tasks[] entry with handoff: "fork" denied in enforce mode
	const fanoutFork = evaluateSubagentCall(enforceState, cfg, {
		tasks: [
			{ role: "explore", task: "search", handoff: "standalone" },
			{ role: "coder", task: "edit", handoff: "fork" },
		],
	});
	assert.equal(fanoutFork.allowed, false);
	assert.equal(fanoutFork.patches.length, 0);
	assert.match(fanoutFork.reason ?? "", /standalone/i);
	assert.match(fanoutFork.reason ?? "", /!direct/);

	// standalone, lineage, and omitted handoff remain allowed in enforce mode
	for (const handoff of [undefined, "standalone", "lineage"] as const) {
		const res = evaluateSubagentCall(enforceState, cfg, {
			role: "explore",
			task: "search",
			...(handoff !== undefined ? { handoff } : {}),
		});
		assert.equal(res.allowed, true, `expected handoff=${String(handoff)} to be allowed in enforce mode`);
		assert.equal(res.patches.length, 1);
	}

	// !direct allows handoff: "fork"
	const directState = createDelegationState();
	resetTurnState(directState, classifyTurn("!direct fork a worker", cfg));
	const directFork = evaluateSubagentCall(directState, cfg, {
		role: "explore",
		task: "search",
		handoff: "fork",
	});
	assert.equal(directFork.allowed, true);
	assert.equal(directFork.patches.length, 1);

	// warn and off modes allow handoff: "fork"
	for (const mode of ["warn", "off"] as const) {
		const modeCfg = { ...cfg, mode };
		const modeState = createDelegationState();
		resetTurnState(modeState, classifyTurn("Implement feature", modeCfg));
		const modeFork = evaluateSubagentCall(modeState, modeCfg, {
			role: "explore",
			task: "search",
			handoff: "fork",
		});
		assert.equal(modeFork.allowed, true);
		assert.equal(modeFork.patches.length, 1);
	}

	// Runtime integration check
	await withTempDir(async (cwd) => {
		const host = await startOrchestrator(cwd);
		await runPrompt(host, "Implement feature");

		const blocked = (await host.fire("tool_call", {
			toolName: "subagent",
			input: { role: "explore", task: "search", handoff: "fork" },
		})) as { block?: boolean; reason?: string } | undefined;
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /standalone/i);

		const allowedLineage: Record<string, unknown> = { role: "explore", task: "search", handoff: "lineage" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: allowedLineage }), undefined);
		assert.equal(allowedLineage.provider, "opencode-go");

		await runPrompt(host, "!direct fork worker");
		const allowedDirect: Record<string, unknown> = { role: "explore", task: "search", handoff: "fork" };
		assert.equal(await host.fire("tool_call", { toolName: "subagent", input: allowedDirect }), undefined);
		assert.equal(allowedDirect.provider, "opencode-go");
	});
});

test("Ticket 06 (RB-4): formatDelegationSection renders full Pragmatic Orchestrator persona, role-split, delegation rules, and distinct per-mode directives across all 6 turn modes", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;
	const modePrompts: Record<TurnMode, string> = {
		security: "Audit auth flow for XSS and SQL injection vulnerabilities",
		review: "Review the PR diff on this branch",
		debug: "Debug why the checkout test fails with a stack trace",
		implement: "Implement role-based routing in the orchestrator",
		"quick-fix": "Quick fix: fix typo in the header comment",
		qa: "How does registerWaveRuntime work?",
	};

	const modeDirectives = new Set<string>();

	for (const [expectedMode, prompt] of Object.entries(modePrompts) as [TurnMode, string][]) {
		const state = createDelegationState();
		resetTurnState(state, classifyTurn(prompt, cfg));
		assert.equal(state.turnMode, expectedMode);

		const section = formatDelegationSection(state, cfg);

		// Full Pragmatic Orchestrator persona & role split
		assert.match(section, /Pragmatic Orchestrator/i);
		assert.match(section, /Understand intent/i);
		assert.match(section, /Handle directly/i);
		assert.match(section, /Delegate by default/i);
		assert.match(section, /explore/i);
		assert.match(section, /research/i);
		assert.match(section, /coder/i);
		assert.match(section, /reviewer/i);
		assert.match(section, /security-reviewer/i);

		// Delegation rules
		assert.match(section, /Always pass `role`/i);
		assert.match(section, /self-contained briefs/i);
		assert.match(section, /Parallelize/i);
		assert.match(section, /Steer/i);
		assert.match(section, /Verify before claiming done/i);
		assert.match(section, /Skill override:.*enforce.*\/orchestrate/);

		// Per-mode directive header + unique directive line
		const expectedBudget = cfg.discoveryBudgets[expectedMode];
		const directiveLine = section
			.split("\n")
			.find((line) => line.startsWith(`Mode: ${expectedMode} (direct discovery budget: ${expectedBudget}).`));
		assert.ok(directiveLine, `expected per-mode directive line for mode "${expectedMode}"`);
		modeDirectives.add(directiveLine);

		if (expectedMode === "security") {
			assert.match(directiveLine, /security-reviewer/);
		} else if (expectedMode === "review") {
			assert.match(directiveLine, /reviewer/);
			assert.match(directiveLine, /explore/);
		} else if (expectedMode === "debug") {
			assert.match(directiveLine, /explore/);
			assert.match(directiveLine, /coder/);
		} else if (expectedMode === "implement") {
			assert.match(directiveLine, /explore/);
			assert.match(directiveLine, /coder/);
		} else if (expectedMode === "quick-fix") {
			assert.match(directiveLine, /surgical/i);
			assert.match(directiveLine, /coder/);
		} else if (expectedMode === "qa") {
			assert.match(directiveLine, /small lookups/i);
			assert.match(directiveLine, /explore/);
		}
	}

	assert.equal(modeDirectives.size, 6, "all 6 turn modes must render distinct directive sentences");
});

// --- Ticket #07: main-model recordMainModelReview & unconditional post-review dirty reset ---

test("Ticket 07 (RB-6): recordMainModelReview validates inputs, enforces inspection precondition, and applies verdict rules", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;
	assert.equal(RECORD_REVIEW_TOOL, "orchestrator_record_review");
	assert.deepEqual(MAIN_REVIEW_VERDICTS, ["pass", "accepted_with_notes", "fail"]);

	const state = createDelegationState();
	recordFileMutation(state, cfg, "src/a.ts", 30, 100);
	recordFileMutation(state, cfg, "src/b.ts", 25, 110);
	assert.equal(state.reviewRequired, true);
	assert.equal(state.reviewVerified, false);

	// Validation errors
	assert.equal(recordMainModelReview(state, null, 120).ok, false);
	assert.equal(recordMainModelReview(state, { verdict: "unknown", scope: "a", summary: "b" }, 120).ok, false);
	assert.equal(recordMainModelReview(state, { verdict: "pass", scope: "   ", summary: "clean" }, 120).ok, false);
	assert.equal(recordMainModelReview(state, { verdict: "pass", scope: "src/", summary: "  " }, 120).ok, false);
	assert.equal(
		recordMainModelReview(state, { verdict: "pass", scope: "src/", summary: "clean", inspectedPaths: [""] }, 120).ok,
		false,
	);

	// Missing inspection (lastReviewInspectionAt === 0) rejected
	const noInspect = recordMainModelReview(state, { verdict: "pass", scope: "src/a.ts", summary: "clean" }, 120);
	assert.equal(noInspect.ok, false);
	assert.match(noInspect.error ?? "", /inspect|git diff|read/i);
	assert.equal(state.reviewVerified, false);

	// Stale inspection (lastReviewInspectionAt < lastReviewEditAt) rejected
	recordReviewInspection(state, 105);
	const staleInspect = recordMainModelReview(state, { verdict: "pass", scope: "src/a.ts", summary: "clean" }, 120);
	assert.equal(staleInspect.ok, false);
	assert.equal(state.reviewVerified, false);

	// Fresh inspection + "fail" leaves reviewVerified = false and records lastMainReview
	recordReviewInspection(state, 115);
	const failRes = recordMainModelReview(
		state,
		{ verdict: "fail", scope: "src/a.ts, src/b.ts", summary: "Bug in b.ts", inspectedPaths: ["src/a.ts"] },
		125,
	);
	assert.equal(failRes.ok, true);
	assert.equal(state.reviewVerified, false);
	assert.equal(state.lastMainReview?.verdict, "fail");
	assert.equal(state.lastMainReview?.recordedAt, 125);

	// Fresh inspection + "pass" sets reviewVerified = true
	const passRes = recordMainModelReview(
		state,
		{ verdict: "pass", scope: "src/a.ts, src/b.ts", summary: "Clean", inspectedPaths: ["src/a.ts", "src/b.ts"] },
		130,
	);
	assert.equal(passRes.ok, true);
	assert.equal(state.reviewVerified, true);
	assert.equal(state.lastMainReview?.verdict, "pass");
	assert.deepEqual(state.lastMainReview?.inspectedPaths, ["src/a.ts", "src/b.ts"]);

	// "accepted_with_notes" also sets reviewVerified = true
	state.reviewVerified = false;
	const notesRes = recordMainModelReview(
		state,
		{ verdict: "accepted_with_notes", scope: "src/", summary: "Accepted with minor nit" },
		135,
	);
	assert.equal(notesRes.ok, true);
	assert.equal(state.reviewVerified, true);
	assert.equal(state.lastMainReview?.verdict, "accepted_with_notes");
});

test("Ticket 07 (RB-6): unconditional post-review dirty reset clears reviewVerified on tiny review-eligible edits while ignoring .md edits", () => {
	const cfg = DEFAULT_DELEGATION_CONFIG;

	assert.equal(isReviewFile("src/a.ts", cfg), true);
	assert.equal(isReviewFile("package.json", cfg), true);
	assert.equal(isReviewFile("README.md", cfg), false);

	// Small single edit when reviewRequired was false must NOT arm reviewRequired
	const smallState = createDelegationState();
	recordFileMutation(smallState, cfg, "src/small.ts", 1, 100);
	assert.equal(smallState.reviewRequired, false);
	assert.equal(smallState.reviewVerified, false);
	assert.equal(smallState.lastReviewEditAt, 100);

	// After reviewRequired = true & reviewVerified = true, a 1-file 1-line edit resets reviewVerified
	const state = createDelegationState();
	recordFileMutation(state, cfg, "src/a.ts", 30, 100);
	recordFileMutation(state, cfg, "src/b.ts", 30, 110);
	recordReviewInspection(state, 120);
	assert.equal(recordMainModelReview(state, { verdict: "pass", scope: "a+b", summary: "ok" }, 125).ok, true);
	assert.equal(state.reviewRequired, true);
	assert.equal(state.reviewVerified, true);

	// Doc-only .md edit does NOT clear reviewVerified
	recordFileMutation(state, cfg, "README.md", 5, 130);
	assert.equal(state.reviewVerified, true);
	assert.equal(state.lastReviewEditAt, 110);

	// 1-file, 1-line edit to a review-eligible file clears reviewVerified unconditionally & keeps reviewRequired = true
	recordFileMutation(state, cfg, "src/c.ts", 1, 140);
	assert.equal(state.reviewRequired, true);
	assert.equal(state.reviewVerified, false);
	assert.equal(state.lastReviewEditAt, 140);
	assert.deepEqual(evaluateCompletionGate(state, cfg).pending, ["tests", "code-review"]);

	// Even when dirty counters are below threshold while reviewRequired was already true,
	// a 1-file, 1-line review-eligible edit unconditionally clears reviewVerified.
	const belowThresholdState = createDelegationState();
	belowThresholdState.reviewRequired = true;
	belowThresholdState.reviewVerified = true;
	belowThresholdState.lastReviewEditAt = 100;
	recordFileMutation(belowThresholdState, cfg, "src/tiny.ts", 1, 200);
	assert.equal(belowThresholdState.reviewRequired, true);
	assert.equal(belowThresholdState.reviewVerified, false);
	assert.equal(belowThresholdState.lastReviewEditAt, 200);
});

test("Ticket 07 (RB-6): isReviewInspectionBashCommand accepts diff/file git inspection and rejects non-inspection commands", () => {
	for (const cmd of [
		"git diff",
		"git diff --stat",
		"git --no-pager -C /repo show HEAD",
		"git status --porcelain",
		"git log -p -n 2 | head -n 40",
		"gh pr diff 12",
	]) {
		assert.equal(isReviewInspectionBashCommand(cmd), true, `expected inspection command: ${cmd}`);
	}

	for (const cmd of [
		"ls -la",
		"wc -l src/a.ts",
		"git branch -a",
		"git rev-parse HEAD",
		"git fetch origin",
		"node --test",
		"git diff && rm -rf /",
		"git diff --output=/tmp/x",
	]) {
		assert.equal(isReviewInspectionBashCommand(cmd), false, `expected non-inspection command: ${cmd}`);
	}
});

// --- Read-only bash block explanation & prompt guidance --------------------

test("explainReadOnlyBashBlock names compound/subshell/redirect constructs and routes read-only commands to explore/split", () => {
	const compound = explainReadOnlyBashBlock("ls -la && (ls -la docs 2>/dev/null || true)");
	assert.match(compound, /&&/);
	assert.match(compound, /subshell/i);
	assert.match(compound, /redirect/i);
	assert.match(compound, /\|\|/);
	assert.match(compound, /split/i);
	assert.match(compound, /explore/);
	assert.doesNotMatch(compound, /role:\s*'coder'/);

	const semi = explainReadOnlyBashBlock("git status; wc -l README.md");
	assert.match(semi, /;/);
	assert.match(semi, /split/i);
	assert.match(semi, /explore/);

	const redirect = explainReadOnlyBashBlock("git diff > /tmp/diff.patch");
	assert.match(redirect, /redirect/i);
	assert.match(redirect, />/);
	assert.match(redirect, /explore/);

	const cmdSubst = explainReadOnlyBashBlock('git log "$(whoami)"');
	assert.match(cmdSubst, /\$\(\.\.\.\)/);
	assert.match(cmdSubst, /explore/);

	const backtick = explainReadOnlyBashBlock("ls `pwd`");
	assert.match(backtick, /backtick/i);
	assert.match(backtick, /explore/);

	const newline = explainReadOnlyBashBlock("ls -la\nwc -l a.ts");
	assert.match(newline, /newline/i);
	assert.match(newline, /explore/);

	const ghCompound = explainReadOnlyBashBlock("gh pr view 55 && gh pr diff 55");
	assert.match(ghCompound, /&&/);
	assert.match(ghCompound, /explore/);
});

test("explainReadOnlyBashBlock names unsupported pipe sinks and suggests filtering/explore rather than coder", () => {
	const gitLsFilesPipe = explainReadOnlyBashBlock("git ls-files | grep -iE 'pe[-_]?hc'");
	assert.match(gitLsFilesPipe, /\| grep/);
	assert.match(gitLsFilesPipe, /head.*tail.*wc.*cat/i);
	assert.match(gitLsFilesPipe, /codemode|filter/i);
	assert.match(gitLsFilesPipe, /explore/);
	assert.doesNotMatch(gitLsFilesPipe, /role:\s*'coder'/);

	const gitLogPipe = explainReadOnlyBashBlock("git log -n 10 | grep foo");
	assert.match(gitLogPipe, /\| grep/);
	assert.match(gitLogPipe, /head.*tail.*wc.*cat/i);
	assert.match(gitLogPipe, /without the pipe|filter|split/i);
	assert.match(gitLogPipe, /explore/);
	assert.doesNotMatch(gitLogPipe, /role:\s*'coder'/);

	const multiBadPipe = explainReadOnlyBashBlock("ls -la | sort | awk '{print $1}'");
	assert.match(multiBadPipe, /\| sort/);
	assert.match(multiBadPipe, /\| awk/);
	assert.match(multiBadPipe, /explore/);
});

test("explainReadOnlyBashBlock routes read-only search/inspection commands to direct tools/explore and mutating/test commands to coder", () => {
	for (const cmd of [
		"git ls-files",
		"git --no-pager -C /repo ls-files '*.ts'",
		"git ls-files | head -n 20",
		"grep -rn foo src/",
		"rg -n foo src/",
		"find . -name '*.ts'",
		"cat package.json",
		"head -n 20 package.json",
		"tail -n 20 package.json",
	]) {
		const msg = explainReadOnlyBashBlock(cmd);
		assert.match(msg, /read|grep|find|ls/i, `expected tool hint for "${cmd}"`);
		assert.match(msg, /explore/, `expected explore suggestion for "${cmd}"`);
		assert.doesNotMatch(msg, /role:\s*'coder'/, `must not misroute "${cmd}" to coder`);
	}

	for (const cmd of [
		"npm test",
		"pytest",
		"git push",
		"git push origin dev",
		"rm -rf /tmp/scratch",
		"node --test",
		"git branch -D feature",
		"git diff --output=/tmp/out.diff",
		"find . -name '*.tmp' -delete",
		"cat a.txt > b.txt",
	]) {
		const msg = explainReadOnlyBashBlock(cmd);
		assert.match(msg, /coder/, `expected coder routing for "${cmd}"`);
	}
});

test("formatDelegationSection states the single-command, no-chaining, and pipe-sink restriction concisely", () => {
	const state = createDelegationState();
	resetTurnState(state, classifyTurn("Investigate codebase", DEFAULT_DELEGATION_CONFIG));
	const section = formatDelegationSection(state, DEFAULT_DELEGATION_CONFIG);
	assert.match(section, /single simple commands only/i);
	assert.match(section, /&&/);
	assert.match(section, /\|\|/);
	assert.match(section, /subshells/i);
	assert.match(section, /redirects/i);
	assert.match(section, /\| head\|tail\|wc\|cat/);
	assert.match(section, /explore/);
});



