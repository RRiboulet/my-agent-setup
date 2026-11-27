/**
 * Pi-facing runtime wiring for the Pragmatic Orchestrator delegation workflow.
 *
 * Pure logic and config loading live in `delegation.ts`. This module owns only
 * session lifecycle hooks, in-place `subagent` tool_call patching, guardrail
 * enforcement/warnings, event bus subscriptions, and the `/delegation` command.
 *
 * Completely inert for delegated worker sessions (`isDelegatedWorker === true`).
 */

import type { ExtensionAPI, ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	DELEGATION_MODES,
	DELEGATION_SECTION,
	RECORD_REVIEW_TOOL,
	applySubagentPatches,
	classifyCommitOrPrCommand,
	classifyTurn,
	clearDirtyState,
	createDelegationState,
	evaluateCompletionGate,
	evaluateDiscovery,
	evaluateParentWrite,
	evaluateSubagentCall,
	explainReadOnlyBashBlock,
	extractEditInfo,
	formatDelegationSection,
	formatDelegationStatus,
	formatLiveRunsSettlementMessage,
	isReadOnlyBashAllowed,
	isReviewInspectionBashCommand,
	normalizeFilePath,
	readDelegationConfig,
	recordChildSettled,
	recordFileMutation,
	recordMainModelReview,
	recordPassedCommand,
	recordReviewInspection,
	recordRunStarted,
	recordRunsSnapshot,
	recordSteer,
	resetTurnState,
	resolveSteerRunId,
	type DelegationConfig,
	type DelegationMode,
} from "./delegation.ts";
import { ORCHESTRATION_EVENTS, subscribeOrchestrationEvent, type RunsSnapshotPayload } from "./events.ts";
import { isWorkerRole, ORCHESTRATOR_ROLE } from "./role.ts";
import { resolveWorkspaceToolExposure } from "./workspace-runtime.ts";

export const DELEGATION_GATE_MESSAGE_TYPE = "orchestrator-delegation-gate";
export const DELEGATION_STATUS_MESSAGE_TYPE = "orchestrator-delegation-status";
export const DELEGATION_WRITE_ENTRY = "orchestrator-delegation-write";

export interface DelegationRuntimeOptions {
	/** Delegated workers never enforce parent guardrails or register `/delegation`. */
	isDelegatedWorker?: boolean;
	getProjectVerificationCommand?: () => string | null;
	hasLiveRuns?: () => boolean;
	getLiveRunIds?: () => string[];
	isParked?: () => boolean;
	shouldParkOnLiveRuns?: (ctx: ExtensionContext) => boolean;
	parkForLiveRuns?: () => void;
	consumeOverride?: () => boolean;
	consumeSettleOverride?: () => boolean;
	isWaveActive?: (ctx: ExtensionContext) => boolean;
	isWaveReadyToCommit?: (ctx: ExtensionContext) => boolean;
	waveReadyToCommitAt?: (ctx: ExtensionContext) => number | null;
}

export interface DelegationRuntimeHandle {
	registerSettleGate: () => void;
	isEnforcing: () => boolean;
	hasPendingGate: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
	}
	return "";
}

function extractRunIdFromDetails(details: unknown): string {
	if (!isRecord(details)) return "";
	if (typeof details.runId === "string" && details.runId.trim()) return details.runId.trim();
	if (typeof details.id === "string" && details.id.trim()) return details.id.trim();
	return "";
}

function hasToolNamed(list: unknown, name: string): boolean {
	return Array.isArray(list) && list.some((item) => isRecord(item) && item.name === name);
}

function readHidParentWriteFromBranch(ctx?: ExtensionContext, hasActiveWrite = false): boolean {
	if (hasActiveWrite) return false;
	const getBranch = ctx?.sessionManager?.getBranch;
	if (typeof getBranch !== "function") return false;
	let branch: unknown;
	try {
		branch = getBranch.call(ctx.sessionManager);
	} catch {
		return false;
	}
	if (!Array.isArray(branch)) return false;
	let hidden = false;
	let pendingRestore = false;
	let transcriptHasWrite: boolean | undefined;
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "system") {
			if (transcriptHasWrite === undefined) transcriptHasWrite = false;
			if (hasToolNamed(entry.message.toolsRemoved, "write")) {
				transcriptHasWrite = false;
			}
			if (hasToolNamed(entry.message.toolsAdded, "write")) {
				transcriptHasWrite = true;
			}
			if (pendingRestore && hasToolNamed(entry.message.toolsAdded, "write")) {
				hidden = false;
				pendingRestore = false;
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === DELEGATION_WRITE_ENTRY) {
			if (!isRecord(entry.data)) continue;
			if (entry.data.hidden === true) {
				hidden = true;
				pendingRestore = false;
			} else if (entry.data.hidden === false) {
				if (hidden && transcriptHasWrite === false) {
					pendingRestore = true;
				} else {
					hidden = false;
					pendingRestore = false;
				}
			}
		}
	}
	return hidden;
}

function makeCanUseModel(registry: unknown): ((provider: string, model: string) => boolean) | undefined {
	if (!isRecord(registry)) return undefined;
	return (provider: string, model: string): boolean => {
		let resolvedModel: unknown;
		if (typeof registry.find === "function") {
			resolvedModel = registry.find(provider, model);
			if (!resolvedModel) return false;
		}
		if (resolvedModel !== undefined && typeof registry.hasConfiguredAuth === "function") {
			try {
				return Boolean(registry.hasConfiguredAuth(resolvedModel));
			} catch {
				return true;
			}
		}
		if (typeof registry.getProviderAuthStatus === "function") {
			try {
				const status = registry.getProviderAuthStatus(provider) as { configured?: boolean } | undefined;
				if (status && status.configured === false) return false;
			} catch {
				return true;
			}
		}
		return true;
	};
}

export function registerDelegationRuntime(
	pi: ExtensionAPI,
	options: DelegationRuntimeOptions = {},
): DelegationRuntimeHandle {
	const worker = options.isDelegatedWorker ?? isWorkerRole(ORCHESTRATOR_ROLE);
	if (worker) {
		return {
			registerSettleGate: () => {},
			isEnforcing: () => false,
			hasPendingGate: () => false,
		};
	}

	let state = createDelegationState();
	let cachedBaseConfig: DelegationConfig | null = null;
	let sessionModeOverride: DelegationMode | null = null;
	let lastCwd: string | undefined;
	let settleGateRegistered = false;
	let latestSnapshotRuns: RunsSnapshotPayload["runs"] = [];
	const warnedFallbacks = new Set<string>();
	let warnedMissingSections = false;
	let hidParentWrite = false;

	const reloadBaseConfig = (ctx: ExtensionContext): DelegationConfig => {
		lastCwd = ctx.cwd;
		const read = readDelegationConfig(ctx.cwd, { trusted: ctx.isProjectTrusted() });
		cachedBaseConfig = read.config;
		return read.config;
	};

	const effectiveConfig = (ctx?: ExtensionContext): DelegationConfig => {
		const base =
			cachedBaseConfig ?? (ctx ? reloadBaseConfig(ctx) : readDelegationConfig(lastCwd ?? process.cwd()).config);
		return sessionModeOverride !== null ? { ...base, mode: sessionModeOverride } : base;
	};

	const syncParentWriteTool = (ctx?: ExtensionContext): void => {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		let active: string[];
		try {
			active = pi.getActiveTools();
		} catch {
			return;
		}
		if (!Array.isArray(active)) return;

		const config = effectiveConfig(ctx);
		const shouldHide = config.mode === "enforce" && !state.directBypass && !state.escalationUnlocked;
		const hasWrite = active.includes("write");

		if (shouldHide) {
			if (hasWrite) {
				pi.setActiveTools(active.filter((name) => name !== "write"));
				hidParentWrite = true;
				pi.appendEntry?.(DELEGATION_WRITE_ENTRY, { hidden: true });
			}
			return;
		}

		if (hidParentWrite) {
			if (!hasWrite) {
				pi.setActiveTools([...active, "write"]);
			}
			hidParentWrite = false;
			pi.appendEntry?.(DELEGATION_WRITE_ENTRY, { hidden: false });
		}
	};

	const waveCommitGateOptions = (
		ctx: ExtensionContext,
		kind: "commit" | "push" | "pr-create" | "pr-merge" | "settle",
	) => {
		if (kind !== "commit" && kind !== "settle") {
			return { waveReadyToCommit: false, waveReadyToCommitAt: null };
		}
		const readyAt = options.waveReadyToCommitAt?.(ctx);
		if (readyAt !== undefined) {
			return { waveReadyToCommit: readyAt !== null, waveReadyToCommitAt: readyAt };
		}
		return { waveReadyToCommit: options.isWaveReadyToCommit?.(ctx) ?? false };
	};

	const resetSessionState = (ctx: ExtensionContext): void => {
		state = createDelegationState();
		if (latestSnapshotRuns.length > 0) {
			recordRunsSnapshot(state, { runs: latestSnapshotRuns, at: Date.now() });
		}
		sessionModeOverride = null;
		warnedFallbacks.clear();
		warnedMissingSections = false;
		reloadBaseConfig(ctx);
		let hasActiveWrite = false;
		try {
			const active = pi.getActiveTools?.();
			hasActiveWrite = Array.isArray(active) && active.includes("write");
		} catch {
			hasActiveWrite = false;
		}
		hidParentWrite = readHidParentWriteFromBranch(ctx, hasActiveWrite);
		syncParentWriteTool(ctx);
	};

	const recordReviewToolDefinition = {
		name: RECORD_REVIEW_TOOL,
		label: "Record main-model review",
		description:
			"Record a structured code review performed directly by the main model after inspecting post-edit diffs or modified files (`git diff` / `git show` / `read`). Satisfies the post-edit `code-review` gate when verdict is `pass` or `accepted_with_notes`; `fail` leaves the gate armed until fixes are re-reviewed.",
		promptSnippet: "Record a main-model post-edit code review verdict after inspecting the diff",
		promptGuidelines: [
			"Inspect the post-edit diff (`git diff` / `read`) before calling orchestrator_record_review.",
			"Use verdict `pass` or `accepted_with_notes` only when inspected changes are verified; use `fail` if blocking issues remain.",
		],
		parameters: Type.Object({
			verdict: Type.Union(
				[
					Type.Literal("pass"),
					Type.Literal("accepted_with_notes"),
					Type.Literal("fail"),
				],
				{ description: "Review outcome verdict: pass, accepted_with_notes, or fail" },
			),
			scope: Type.String({
				description: "Non-empty description of the inspected diff or files",
			}),
			summary: Type.String({
				description: "Findings summary or confirmation of clean review",
			}),
			inspectedPaths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional list of file paths inspected during the review",
				}),
			),
		}),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			const result = recordMainModelReview(state, params, Date.now());
			if (!result.ok || !result.review) {
				const error = result.error ?? "Failed to record review.";
				return {
					content: [{ type: "text" as const, text: error }],
					details: { ok: false, error },
					isError: true as const,
				};
			}
			const review = result.review;
			const statusText =
				review.verdict === "fail"
					? `Recorded review (verdict=${review.verdict}; code-review gate remains armed until fixes are re-reviewed). Scope: ${review.scope}. Summary: ${review.summary}`
					: `Recorded review (verdict=${review.verdict}; reviewVerified=true). Scope: ${review.scope}. Summary: ${review.summary}`;
			return {
				content: [{ type: "text" as const, text: statusText }],
				details: {
					ok: true,
					review,
					reviewVerified: state.reviewVerified,
				},
			};
		},
	};

	let recordReviewToolRegistered = false;
	let appliedReviewExposure: ToolExposure | undefined;

	const registerRecordReviewTool = (): void => {
		let exposure: ToolExposure | undefined;
		try {
			if (typeof pi.getActiveTools === "function") {
				exposure = resolveWorkspaceToolExposure(pi.getActiveTools());
			}
		} catch (error) {
			console.error(
				`[orchestrator-delegation] could not resolve ${RECORD_REVIEW_TOOL} exposure: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (recordReviewToolRegistered && appliedReviewExposure === exposure) return;
		const wasDirect = recordReviewToolRegistered && appliedReviewExposure === undefined;
		recordReviewToolRegistered = true;
		appliedReviewExposure = exposure;
		pi.registerTool(exposure ? { ...recordReviewToolDefinition, exposure } : recordReviewToolDefinition);
		if (
			wasDirect &&
			exposure === "codemode" &&
			typeof pi.getActiveTools === "function" &&
			typeof pi.setActiveTools === "function"
		) {
			const currentActive = pi.getActiveTools();
			const nextActive = currentActive.filter((name) => name !== RECORD_REVIEW_TOOL);
			if (nextActive.length !== currentActive.length) {
				pi.setActiveTools(nextActive);
			}
		}
	};

	if (typeof pi.getActiveTools !== "function") {
		registerRecordReviewTool();
	} else {
		try {
			pi.getActiveTools();
			registerRecordReviewTool();
		} catch {
			// pi throws during extension load before the runtime binds; defer to `session_start`.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		registerRecordReviewTool();
		resetSessionState(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		registerRecordReviewTool();
		resetSessionState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		registerRecordReviewTool();
		reloadBaseConfig(ctx);
		const config = effectiveConfig(ctx);

		const isPromptStart = typeof event.prompt === "string";
		if (isPromptStart) {
			const classification = classifyTurn(event.prompt, config);
			resetTurnState(state, classification);
		}

		if ((isPromptStart || event.messageType === "custom") && config.mode !== "off") {
			const sections = event.systemPromptOptions?.sections;
			if (isRecord(sections)) {
				sections[DELEGATION_SECTION] = formatDelegationSection(state, config);
			} else if (!warnedMissingSections) {
				warnedMissingSections = true;
				ctx.ui?.notify?.(
					"Pragmatic Orchestrator delegation instructions could not be injected because systemPromptOptions.sections is unavailable.",
					"warning",
				);
			}
		}

		syncParentWriteTool(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		if (!toolName) return;

		const config = effectiveConfig(ctx);

		if (toolName === "subagent") {
			const evalResult = evaluateSubagentCall(state, config, event.input, {
				canUseModel: makeCanUseModel(ctx.modelRegistry),
				allowExplicitModelOverride: options.isWaveActive?.(ctx) ?? false,
			});
			if (!evalResult.allowed && config.mode === "enforce") {
				return { block: true, reason: evalResult.reason };
			}
			if (evalResult.reason && config.mode === "warn") {
				ctx.ui?.notify?.(evalResult.reason, "warning");
			}
			applySubagentPatches(evalResult.patches);
			for (const warning of evalResult.fallbackWarnings) {
				if (!warnedFallbacks.has(warning)) {
					warnedFallbacks.add(warning);
					ctx.ui?.notify?.(warning, "warning");
				}
			}
			return;
		}

		if (config.mode === "off" || state.directBypass) return;

		if (config.discoveryTools.includes(toolName)) {
			const result = evaluateDiscovery(state, config, toolName);
			if (!result.allowed) {
				if (config.mode === "enforce") return { block: true, reason: result.reason };
				if (config.mode === "warn") ctx.ui?.notify?.(result.reason ?? "Discovery budget exceeded.", "warning");
			}
			return;
		}

		if (toolName === "write" || toolName === "edit") {
			const result = evaluateParentWrite(state, config, toolName, event.input, ctx.cwd);
			if (!result.allowed) {
				if (config.mode === "enforce") return { block: true, reason: result.reason };
				if (config.mode === "warn") ctx.ui?.notify?.(result.reason ?? "Parent edit cap exceeded.", "warning");
			}
			return;
		}

		if (toolName === "bash" || toolName === "powershell") {
			const cmd = isRecord(event.input) && typeof event.input.command === "string" ? event.input.command : "";
			const commitOrPrKind = classifyCommitOrPrCommand(cmd);
			if (commitOrPrKind !== null) {
				const gate = evaluateCompletionGate(state, config, waveCommitGateOptions(ctx, commitOrPrKind));
				if (gate.pending.length > 0) {
					if (config.mode === "enforce") {
						if (options.consumeOverride?.()) return;
						return { block: true, reason: gate.reason };
					}
					if (config.mode === "warn") ctx.ui?.notify?.(gate.reason, "warning");
				}
				return;
			}
			if (!isReadOnlyBashAllowed(cmd)) {
				const reason = explainReadOnlyBashBlock(cmd);
				if (config.mode === "enforce") return { block: true, reason };
				if (config.mode === "warn") ctx.ui?.notify?.(reason, "warning");
			}
			return;
		}

		if (toolName === "subagent_interrupt" || toolName === "subagent_resume") {
			const steer = recordSteer(state, config, toolName, event.input);
			if (steer.count > 0 && typeof event.toolCallId === "string" && event.toolCallId) {
				state.countedSteerToolCallIds.add(event.toolCallId);
			}
			if (steer.newlyUnlocked) {
				syncParentWriteTool(ctx);
				ctx.ui?.notify?.(
					`Direct parent editing unlocked for this turn after ${steer.count} steers.`,
					"info",
				);
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError === true) return;
		const toolName = typeof event.toolName === "string" ? event.toolName : "";
		if (!toolName) return;

		const config = effectiveConfig(ctx);
		const input = isRecord(event.input) ? event.input : {};

		if (toolName === "subagent_answer") {
			if (config.mode === "off" || state.directBypass) return;
			const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			if (toolCallId && state.countedSteerToolCallIds.has(toolCallId)) return;
			if (/^\s*Not sent:/i.test(firstTextContent(event.content))) return;
			const detailsRunId = extractRunIdFromDetails(event.details);
			const steer = detailsRunId
				? recordSteer(state, config, toolName, { runId: detailsRunId })
				: recordSteer(state, config, toolName, input);
			if (steer.count > 0 && toolCallId) {
				state.countedSteerToolCallIds.add(toolCallId);
			}
			if (steer.newlyUnlocked) {
				syncParentWriteTool(ctx);
				ctx.ui?.notify?.(
					`Direct parent editing unlocked for this turn after ${steer.count} steers.`,
					"info",
				);
			}
			return;
		}

		if (toolName === "read") {
			const rawPath =
				typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : "";
			const norm = normalizeFilePath(rawPath, ctx.cwd);
			if (norm) {
				state.viewedFiles.add(norm);
				recordReviewInspection(state, Date.now());
			}
			return;
		}

		if (toolName === "edit" || toolName === "write") {
			const info = extractEditInfo(toolName, input, ctx.cwd);
			if (info.path) {
				recordFileMutation(state, config, info.path, info.changedLines, Date.now(), ctx.cwd);
			}
			return;
		}

		if (toolName === "bash" || toolName === "powershell") {
			const cmd = typeof input.command === "string" ? input.command : "";
			if (classifyCommitOrPrCommand(cmd) === "commit") {
				clearDirtyState(state);
			} else {
				const now = Date.now();
				recordPassedCommand(state, config, cmd, now, options.getProjectVerificationCommand?.() ?? null);
				if (isReviewInspectionBashCommand(cmd)) {
					recordReviewInspection(state, now);
				}
			}
			return;
		}
	});

	const registerSettleGate = (): void => {
		if (settleGateRegistered) return;
		settleGateRegistered = true;
		pi.on("agent_before_settle", async (event, ctx) => {
			if (event.outcome !== undefined && event.outcome !== "completed") return;
			const config = effectiveConfig(ctx);
			if (config.mode === "off") return;

			const liveIds = options.getLiveRunIds?.() ?? [];
			const liveActive = liveIds.length > 0 || (options.hasLiveRuns?.() ?? false);
			const gate = evaluateCompletionGate(state, config, waveCommitGateOptions(ctx, "settle"));

			if (liveActive) {
				if (options.isParked?.()) {
					return;
				}

				const liveMessage = formatLiveRunsSettlementMessage(
					liveIds,
					gate.pending.length > 0 ? gate.reason : undefined,
				);
				if (state.directBypass || config.mode === "warn") {
					ctx.ui?.notify?.(liveMessage, "warning");
					return;
				}
				if (state.settleBlocksThisTurn >= config.settleAttemptCap) {
					ctx.ui?.notify?.(liveMessage, "warning");
					return;
				}
				if ((options.consumeSettleOverride ?? options.consumeOverride)?.()) {
					return;
				}

				if (options.shouldParkOnLiveRuns?.(ctx)) {
					options.parkForLiveRuns?.();
					return;
				}

				state.settleBlocksThisTurn += 1;
				ctx.ui?.notify?.(liveMessage, "warning");
				const prior = Array.isArray(event.entries) ? event.entries : [];
				return {
					continue: true,
					entries: [
						...prior,
						{
							type: "custom_message" as const,
							customType: DELEGATION_GATE_MESSAGE_TYPE,
							content: liveMessage,
							display: true,
						},
					],
				};
			}

			if (gate.pending.length === 0) return;

			if (state.directBypass || config.mode === "warn") {
				ctx.ui?.notify?.(gate.reason, "warning");
				return;
			}

			if (state.settleBlocksThisTurn >= config.settleAttemptCap) {
				return;
			}

			if ((options.consumeSettleOverride ?? options.consumeOverride)?.()) {
				return;
			}

			state.settleBlocksThisTurn += 1;
			const prior = Array.isArray(event.entries) ? event.entries : [];
			return {
				continue: true,
				entries: [
					...prior,
					{
						type: "custom_message" as const,
						customType: DELEGATION_GATE_MESSAGE_TYPE,
						content: gate.reason,
						display: true,
					},
				],
			};
		});
	};

	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runStarted, (payload) => {
		recordRunStarted(state, payload);
	});

	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runsSnapshot, (payload) => {
		latestSnapshotRuns = Array.isArray(payload.runs) ? payload.runs.map((r) => ({ ...r })) : [];
		recordRunsSnapshot(state, payload);
	});

	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runSettled, (payload) => {
		const config = effectiveConfig();
		recordChildSettled(state, config, payload, options.getProjectVerificationCommand?.() ?? null, lastCwd);
	});

	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, (payload) => {
		if (payload.action === "settle" && payload.verdict.verification?.status === "passed") {
			state.testsVerified = true;
		}
	});

	pi.registerCommand("delegation", {
		description: "Inspect or toggle Pragmatic Orchestrator delegation mode (enforce | warn | off | --json)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const lower = trimmed.toLowerCase();

			if (trimmed === "--json") {
				const config = effectiveConfig(ctx);
				const gate = evaluateCompletionGate(state, config, waveCommitGateOptions(ctx, "settle"));
				const snapshot = {
					mode: config.mode,
					sessionModeOverride,
					state: {
						turnMode: state.turnMode,
						discoveryBudget: state.discoveryBudget,
						discoveryCount: state.discoveryCount,
						directBypass: state.directBypass,
						promptHasModelMention: state.promptHasModelMention,
						editedFilesThisTurn: [...state.editedFilesThisTurn],
						escalationUnlocked: state.escalationUnlocked,
						settleBlocksThisTurn: state.settleBlocksThisTurn,
						viewedFilesCount: state.viewedFiles.size,
						testsRequired: state.testsRequired,
						testsVerified: state.testsVerified,
						reviewRequired: state.reviewRequired,
						reviewVerified: state.reviewVerified,
						dirtyReviewFiles: [...state.dirtyReviewFiles],
						dirtyReviewLines: state.dirtyReviewLines,
						lastReviewInspectionAt: state.lastReviewInspectionAt,
						lastMainReview: state.lastMainReview,
						pendingGates: gate.pending,
					},
					roles: config.roles,
				};
				pi.sendMessage(
					{
						customType: DELEGATION_STATUS_MESSAGE_TYPE,
						content: JSON.stringify(snapshot, null, 2),
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			if ((DELEGATION_MODES as readonly string[]).includes(lower)) {
				sessionModeOverride = lower as DelegationMode;
				syncParentWriteTool(ctx);
				const config = effectiveConfig(ctx);
				pi.sendMessage(
					{
						customType: DELEGATION_STATUS_MESSAGE_TYPE,
						content: `Delegation mode set to "${config.mode}" for this session.`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			if (trimmed === "") {
				const config = effectiveConfig(ctx);
				pi.sendMessage(
					{
						customType: DELEGATION_STATUS_MESSAGE_TYPE,
						content: formatDelegationStatus(state, config, waveCommitGateOptions(ctx, "settle")),
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			pi.sendMessage(
				{
					customType: DELEGATION_STATUS_MESSAGE_TYPE,
					content: "Usage: /delegation [enforce | warn | off | --json]",
					display: true,
				},
				{ triggerTurn: false },
			);
		},
	});

	return {
		registerSettleGate,
		isEnforcing: () => effectiveConfig().mode === "enforce",
		hasPendingGate: () => {
			const config = effectiveConfig();
			return config.mode === "enforce" && !state.directBypass && evaluateCompletionGate(state, config).pending.length > 0;
		},
	};
}
