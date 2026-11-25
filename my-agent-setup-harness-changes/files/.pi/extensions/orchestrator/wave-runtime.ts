/**
 * Pi-facing runtime for wave orchestration (`/orchestrate`, `orchestrator_wave`,
 * and `git commit` gating while a wave is active).
 *
 * Pure transitions live in `wave.ts`, ladder loading in `wave-ladder.mjs`, and
 * ticket graph parsing/write-back in `wave-tickets.mjs`. This module owns only
 * the session interface: command/tool registration, tool exposure, git SHA
 * verification, disk status side effects, and `tool_call` enforcement.
 */

import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isWorkerRole, ORCHESTRATOR_ROLE } from "./role.ts";
import { resolveWorkspaceToolExposure } from "./workspace-runtime.ts";
import { readLadder } from "./wave-ladder.mjs";
import { blockingIssues, readTickets, setTicketStatus } from "./wave-tickets.mjs";
import {
	WAVE_ENTRY_TYPE,
	applyWaveAction,
	canRunGitCommit,
	formatWaveSummary,
	isGitCommitCommand,
	planWaveDispatch,
	reconstructWaveState,
	type WaveAction,
	type WaveDispatchPlan,
	type WaveLadder,
	type WaveModelSpec,
	type WaveState,
	type WaveTicketGraph,
} from "./wave.ts";

export const WAVE_TOOL = "orchestrator_wave";
export const WAVE_COMMAND = "orchestrate";
export const WAVE_KICKOFF_TYPE = "orchestrator-wave-kickoff";
export const WAVE_STATUS_TYPE = "orchestrator-wave-status";

export interface WaveRuntimeOptions {
	/** Delegated workers never register wave controls or block commits. */
	isDelegatedWorker?: boolean;
	now?: () => number;
	/** Invoked when a wave starts in status "active". */
	onWaveActivated?: (ctx: ExtensionContext) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolError(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ok: false, error: text, ...details },
		isError: true as const,
	};
}

function toolOk(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: { ok: true, ...details },
	};
}

function checkSessionModelAgainstLadder(
	model: { provider?: string; id?: string } | undefined,
	ladder: WaveLadder,
): { warned: boolean; message?: string } {
	if (!model || !model.provider || !model.id || ladder.tiers.length === 0) {
		return { warned: false };
	}
	const topTier = ladder.tiers.reduce((best, entry) => (entry.tier > best.tier ? entry : best), ladder.tiers[0]!);
	if (model.provider === topTier.provider && model.id === topTier.model) {
		return { warned: false };
	}
	const matched = ladder.tiers.find((entry) => entry.provider === model.provider && entry.model === model.id);
	const message = matched
		? `Session model ${model.provider}/${model.id} (tier ${matched.tier}) is below the ladder's highest tier ${topTier.tier} (${topTier.provider}/${topTier.model}).`
		: `Session model ${model.provider}/${model.id} differs from the ladder's highest tier ${topTier.tier} (${topTier.provider}/${topTier.model}).`;
	return { warned: true, message };
}

function tierDispatch(ladder: WaveLadder, tier: number | undefined): WaveModelSpec | undefined {
	if (typeof tier !== "number") return undefined;
	const found = ladder.tiers.find((entry) => entry.tier === tier);
	if (!found) return undefined;
	return { provider: found.provider, model: found.model, thinking: found.thinking };
}

function formatSpec(spec: WaveModelSpec): string {
	return spec.thinking ? `${spec.provider}/${spec.model} (thinking: ${spec.thinking})` : `${spec.provider}/${spec.model}`;
}

function formatStatusReport(
	state: WaveState,
	plan: WaveDispatchPlan,
	ladder: WaveLadder,
	ladderSource: string,
	ladderWarnings: readonly string[],
): string {
	const lines = [
		formatWaveSummary(state),
		plan.summary,
		`Ladder (${ladderSource}): ${ladder.tiers.map((t) => `T${t.tier}=${t.provider}/${t.model}(${t.thinking})`).join(", ")}`,
	];
	if (ladderWarnings.length > 0) {
		lines.push(`Ladder warnings: ${ladderWarnings.join("; ")}`);
	}
	if (plan.blockingErrors.length > 0) {
		lines.push("Blocking graph errors:", ...plan.blockingErrors.map((e) => `- ${e.message}`));
	}
	if (plan.warnings.length > 0) {
		lines.push("Graph warnings:", ...plan.warnings.map((w) => `- ${w.message}`));
	}
	if (plan.ready.length > 0) {
		lines.push(
			"Ready:",
			...plan.ready.map((r) => {
				const spec = r.dispatch ? ` -> ${formatSpec(r.dispatch)}` : "";
				return `- ${r.id} (${r.action}${r.tier !== undefined ? `, T${r.tier}` : ""}${spec}): ${r.title}`;
			}),
		);
	}
	if (plan.waiting.length > 0) {
		lines.push("Waiting:", ...plan.waiting.map((w) => `- ${w.id} (${w.phase}): ${w.reasons.join(", ")}`));
	}
	if (plan.nextActions.length > 0) {
		lines.push("Next actions:", ...plan.nextActions.map((a) => `- ${a.ticketId}: ${a.action} — ${a.detail}`));
	}
	return lines.join("\n");
}

function buildKickoffPrompt(
	folder: string,
	state: WaveState,
	plan: WaveDispatchPlan,
	ladderSource: string,
	ladderWarnings: readonly string[],
	modelWarning: string | undefined,
): string {
	const lines = [
		`Started wave for \`${folder}\` (ladder source: ${ladderSource}).`,
		formatWaveSummary(state),
		plan.summary,
	];
	if (modelWarning) {
		lines.push(`Model warning: ${modelWarning}`);
	}
	if (ladderWarnings.length > 0) {
		lines.push(`Ladder warnings: ${ladderWarnings.join("; ")}`);
	}
	if (state.status === "active") {
		lines.push(
			"",
			"Drive the wave to completion:",
			"- Inspect the live frontier and ladder pins with `orchestrator_wave({ action: \"status\" })`.",
			"- Triage `pending` tickets (unless `tier-override` is present) via `orchestrator_wave({ action: \"triage\", ticketId, tier, reason })`, then call `orchestrator_wave({ action: \"start_implement\", ticketId })` before launching `subagent` at the returned `dispatch` model.",
			"- Tell each implementer subagent to call `orchestrator_workspace({ action: \"join\" })` and `orchestrator_reserve` before editing, follow `tdd` and `prove-it-works`, and never commit.",
			"- Record outcomes with `orchestrator_wave`: `implement_result`, `record_review` (when `nextPhase` is `reviewing`), and `record_verify`.",
			"- Commit serially once a ticket reaches `ready_to_commit`, then record it via `orchestrator_wave({ action: \"record_commit\", ticketId, commitSha })`.",
		);
	}
	return lines.join("\n");
}

async function captureHeadSha(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	if (typeof pi.exec !== "function") return undefined;
	try {
		const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
			cwd,
			timeout: 5_000,
		});
		if (result.code === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {
		// Not in a git repo or unborn HEAD
	}
	return undefined;
}

export function registerWaveRuntime(pi: ExtensionAPI, options: WaveRuntimeOptions = {}): void {
	const worker = options.isDelegatedWorker ?? isWorkerRole(ORCHESTRATOR_ROLE);
	if (worker) return;

	const now = options.now ?? Date.now;
	let mutationQueue: Promise<void> = Promise.resolve();
	const serializeMutation = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = mutationQueue.then(fn, fn);
		mutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	// --- Tool registration with direct -> codemode exposure tracking -------

	const waveToolDefinition = {
		name: WAVE_TOOL,
		label: "Orchestrator wave",
		executionMode: "sequential" as const,
		description:
			"Drive an active ticket wave through triaged subagent dispatch, reviewer/verifier gates, and serial verified commits. Actions: status, start, triage, start_implement, implement_result, record_review, record_verify, record_commit, abort. State is reconstructed from the session branch and synced to ticket frontmatter.",
		promptSnippet: "Inspect and advance the active tiered ticket wave",
		promptGuidelines: [
			"Call orchestrator_wave({ action: \"status\" }) to inspect the wave frontier and dispatch targets before dispatching.",
			"Always advance tickets through orchestrator_wave (triage -> start_implement -> implement_result -> record_review -> record_verify -> record_commit); git commit is blocked until a ticket is ready_to_commit.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("start"),
					Type.Literal("status"),
					Type.Literal("triage"),
					Type.Literal("start_implement"),
					Type.Literal("implement_result"),
					Type.Literal("record_review"),
					Type.Literal("record_verify"),
					Type.Literal("record_commit"),
					Type.Literal("abort"),
				],
				{ description: "Wave orchestration action to perform" },
			),
			folder: Type.Optional(Type.String({ description: "Ticket folder path (required for action: start)" })),
			ticketId: Type.Optional(Type.String({ description: "Ticket id, e.g. \"01\"" })),
			tier: Type.Optional(Type.Number({ description: "Complexity tier 1..N (for action: triage)" })),
			reason: Type.Optional(Type.String({ description: "Justification, error, escalation, or abort reason" })),
			runId: Type.Optional(Type.String({ description: "Subagent run id (for start_implement / implement_result)" })),
			outcome: Type.Optional(
				Type.Union([Type.Literal("completed"), Type.Literal("crashed")], {
					description: "Implementer run outcome (for action: implement_result)",
				}),
			),
			verdict: Type.Optional(
				Type.Union([Type.Literal("pass"), Type.Literal("escalate"), Type.Literal("fail")], {
					description: "Reviewer verdict (pass | escalate) or verifier verdict (pass | fail)",
				}),
			),
			evidence: Type.Optional(Type.String({ description: "Verification output summary (for action: record_verify)" })),
			commitSha: Type.Optional(
				Type.String({ description: "Git commit SHA (for action: record_commit; resolves HEAD if omitted)" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const action = typeof params.action === "string" ? params.action : "";
			const { ladder: rawLadder, warnings: ladderWarnings, source: ladderSource } = readLadder();
			const ladder = rawLadder as unknown as WaveLadder;

			if (action === "status") {
				const state = reconstructWaveState(ctx.sessionManager.getBranch());
				if (!state) {
					return {
						content: [{ type: "text" as const, text: "No wave is active or recorded on this branch." }],
						details: { active: false },
					};
				}
				const graph = readTickets(path.resolve(ctx.cwd, state.folder)) as unknown as WaveTicketGraph;
				const plan = planWaveDispatch(state, graph, ladder);
				return toolOk(formatStatusReport(state, plan, ladder, ladderSource, ladderWarnings), {
					action: "status",
					active: state.status === "active",
					waveStatus: state.status,
					summary: formatWaveSummary(state),
					state,
					plan,
					ladderSource,
					ladderWarnings,
					ladder: { tiers: ladder.tiers, pins: ladder.pins, gates: ladder.gates },
				});
			}

			return serializeMutation(async () => {
				let state = reconstructWaveState(ctx.sessionManager.getBranch());

				if (action === "start") {
					const folder = typeof params.folder === "string" ? params.folder.trim() : "";
					if (!folder) {
						return toolError('Action "start" requires a non-empty folder path.');
					}
					const graph = readTickets(path.resolve(ctx.cwd, folder)) as unknown as WaveTicketGraph;
					const modelCheck = checkSessionModelAgainstLadder(ctx.model, ladder);
					const startHeadSha = await captureHeadSha(pi, ctx.cwd);
					state = reconstructWaveState(ctx.sessionManager.getBranch());
					const res = applyWaveAction(
						state,
						{
							type: "start",
							folder,
							ladderSource,
							...(startHeadSha ? { startHeadSha } : {}),
							sessionModelWarned: modelCheck.warned,
						},
						{ graph, ladderSource, ...(startHeadSha ? { startHeadSha } : {}), sessionModelWarned: modelCheck.warned },
						ladder,
						now(),
					);
					if (!res.ok || !res.entry || !res.state) {
						return toolError(res.error ?? "Could not start wave.");
					}
					pi.appendEntry(WAVE_ENTRY_TYPE, res.entry);
					if (res.state.status === "active") {
						options.onWaveActivated?.(ctx);
					}
					const plan = planWaveDispatch(res.state, graph, ladder);
					const text = [
						formatStatusReport(res.state, plan, ladder, ladderSource, ladderWarnings),
						...(modelCheck.warned && modelCheck.message ? [`Model warning: ${modelCheck.message}`] : []),
					].join("\n");
					return toolOk(text, {
						action: "start",
						active: res.state.status === "active",
						waveStatus: res.state.status,
						state: res.state,
						plan,
						ladderSource,
						ladderWarnings,
						sessionModelWarned: modelCheck.warned,
					});
				}

				if (action === "abort") {
					const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
					const res = applyWaveAction(state, { type: "abort", ...(reason ? { reason } : {}) }, {}, ladder, now());
					if (!res.ok || !res.entry || !res.state) {
						return toolError(res.error ?? "Could not abort wave.");
					}
					pi.appendEntry(WAVE_ENTRY_TYPE, res.entry);
					return toolOk(formatWaveSummary(res.state), {
						action: "abort",
						active: false,
						waveStatus: res.state.status,
						state: res.state,
					});
				}

				const ticketId = typeof params.ticketId === "string" ? params.ticketId.trim() : "";
				if (!ticketId) {
					return toolError(`Action "${action}" requires a non-empty ticketId.`);
				}

				const graph = state?.folder
					? (readTickets(path.resolve(ctx.cwd, state.folder)) as unknown as WaveTicketGraph)
					: null;

				let waveAction: WaveAction;
				if (action === "triage") {
					const tier = typeof params.tier === "number" ? params.tier : undefined;
					const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
					waveAction = {
						type: "triage",
						ticketId,
						...(tier !== undefined ? { tier } : {}),
						...(reason ? { reason } : {}),
					};
				} else if (action === "start_implement") {
					const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : undefined;
					waveAction = {
						type: "start_implement",
						ticketId,
						...(runId ? { runId } : {}),
					};
				} else if (action === "implement_result") {
					const outcome = params.outcome;
					if (outcome !== "completed" && outcome !== "crashed") {
						return toolError('Action "implement_result" requires outcome "completed" or "crashed".');
					}
					const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
					const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : undefined;
					waveAction = {
						type: "implement_result",
						ticketId,
						outcome,
						...(outcome === "crashed" && reason ? { error: reason } : {}),
						...(outcome === "completed" && reason ? { summary: reason } : {}),
						...(runId ? { runId } : {}),
					};
				} else if (action === "record_review") {
					const verdict = params.verdict;
					if (verdict !== "pass" && verdict !== "escalate") {
						return toolError('Action "record_review" requires verdict "pass" or "escalate".');
					}
					const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
					waveAction = {
						type: "record_review",
						ticketId,
						verdict,
						...(reason ? { reason } : {}),
					};
				} else if (action === "record_verify") {
					const verdict = params.verdict;
					if (verdict !== "pass" && verdict !== "fail") {
						return toolError('Action "record_verify" requires verdict "pass" or "fail".');
					}
					const evidence = typeof params.evidence === "string" ? params.evidence : undefined;
					const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : undefined;
					waveAction = {
						type: "record_verify",
						ticketId,
						verdict,
						...(evidence !== undefined ? { evidence } : {}),
						...(reason ? { reason } : {}),
					};
				} else if (action === "record_commit") {
					if (!state || state.status !== "active") {
						return toolError('Action "record_commit" requires an active wave.');
					}
					const existingTicket = state.tickets[ticketId];
					if (!existingTicket) {
						return toolError(`Unknown ticket "${ticketId}" in wave "${state.folder}".`);
					}
					if (existingTicket.phase !== "ready_to_commit") {
						return toolError(
							`Ticket "${ticketId}" is in phase "${existingTicket.phase}", expected "ready_to_commit".`,
						);
					}
					const rawSha = typeof params.commitSha === "string" ? params.commitSha.trim() : "";
					const candidateSha = rawSha || "HEAD";
					if (typeof pi.exec !== "function") {
						return toolError("Cannot verify git commit SHA: host does not provide pi.exec.");
					}
					let verifiedSha = "";
					try {
						const gitResult = await pi.exec("git", ["rev-parse", "--verify", `${candidateSha}^{commit}`], {
							cwd: ctx.cwd,
							timeout: 5_000,
						});
						if (gitResult.code !== 0 || !gitResult.stdout.trim()) {
							const detail = gitResult.stderr.trim() || `exit ${gitResult.code}`;
							return toolError(`Cannot record_commit: "${candidateSha}" is not a valid commit (${detail}).`);
						}
						verifiedSha = gitResult.stdout.trim();
					} catch (error) {
						return toolError(
							`Cannot record_commit: failed to verify "${candidateSha}" (${error instanceof Error ? error.message : String(error)}).`,
						);
					}
					state = reconstructWaveState(ctx.sessionManager.getBranch());
					if (state?.startHeadSha) {
						if (verifiedSha === state.startHeadSha) {
							return toolError(
								`Cannot record_commit: commit "${verifiedSha}" matches the pre-wave baseline (${state.startHeadSha}); make a new commit for this ticket.`,
							);
						}
						try {
							const ancestorResult = await pi.exec(
								"git",
								["merge-base", "--is-ancestor", verifiedSha, state.startHeadSha],
								{ cwd: ctx.cwd, timeout: 5_000 },
							);
							if (ancestorResult.code === 0) {
								return toolError(
									`Cannot record_commit: commit "${verifiedSha}" predates the pre-wave baseline (${state.startHeadSha}); make a new commit for this ticket.`,
								);
							}
						} catch {
							// If merge-base errors (e.g. non-git or missing baseline), pure state guard still applies.
						}
						state = reconstructWaveState(ctx.sessionManager.getBranch());
					}
					waveAction = { type: "record_commit", ticketId, commitSha: verifiedSha };
				} else {
					return toolError(`Unknown orchestrator_wave action "${action}".`);
				}

				const res = applyWaveAction(state, waveAction, { graph }, ladder, now());
				if (!res.ok || !res.entry || !res.state) {
					return toolError(res.error ?? `Action "${action}" failed.`);
				}

				for (const effect of res.sideEffects) {
					if (effect.kind === "set-ticket-status") {
						const writeResult = setTicketStatus(effect.file, effect.status, { reason: effect.reason });
						if (!writeResult.ok) {
							return toolError(
								`Failed to update ticket file ${effect.file}: ${writeResult.issues.map((i) => i.message).join("; ")}`,
							);
						}
					}
				}

				pi.appendEntry(WAVE_ENTRY_TYPE, res.entry);

				const ticketState = res.state.tickets[ticketId]!;
				const dispatch =
					res.dispatch ?? (ticketState.phase === "triaged" ? tierDispatch(ladder, ticketState.tier) : undefined);

				const lines = [
					`Ticket ${ticketState.id}: ${ticketState.phase}${ticketState.tier !== undefined ? ` (T${ticketState.tier})` : ""}`,
					formatWaveSummary(res.state),
				];
				if (dispatch) lines.push(`Dispatch: ${formatSpec(dispatch)}`);
				if (res.nextPin) lines.push(`Next pin: ${formatSpec(res.nextPin)}`);
				if (ticketState.commitSha) lines.push(`Commit: ${ticketState.commitSha}`);
				if (ticketState.blockedReason) lines.push(`Blocked reason: ${ticketState.blockedReason}`);
				if (res.warnings && res.warnings.length > 0) lines.push(`Warnings: ${res.warnings.join("; ")}`);

				return toolOk(lines.join("\n"), {
					action,
					active: res.state.status === "active",
					waveStatus: res.state.status,
					ticket: ticketState,
					...(dispatch ? { dispatch } : {}),
					...(res.nextPin ? { nextPin: res.nextPin } : {}),
					...(res.warnings && res.warnings.length > 0 ? { warnings: res.warnings } : {}),
					state: res.state,
				});
			});
		},
	};

	let waveToolRegistered = false;
	let appliedWaveExposure: ToolExposure | undefined;

	const registerWaveTool = (): void => {
		let exposure: ToolExposure | undefined;
		try {
			if (typeof pi.getActiveTools === "function") {
				exposure = resolveWorkspaceToolExposure(pi.getActiveTools());
			}
		} catch (error) {
			console.error(
				`[orchestrator-wave] could not resolve tool exposure: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (waveToolRegistered && appliedWaveExposure === exposure) return;
		const wasDirect = waveToolRegistered && appliedWaveExposure === undefined;
		waveToolRegistered = true;
		appliedWaveExposure = exposure;
		pi.registerTool(exposure ? { ...waveToolDefinition, exposure } : waveToolDefinition);
		if (
			wasDirect &&
			exposure === "codemode" &&
			typeof pi.getActiveTools === "function" &&
			typeof pi.setActiveTools === "function"
		) {
			const retargetedNames = new Set([WAVE_TOOL]);
			const currentActive = pi.getActiveTools();
			const nextActive = currentActive.filter((name) => !retargetedNames.has(name));
			if (nextActive.length !== currentActive.length) {
				pi.setActiveTools(nextActive);
			}
		}
	};

	if (typeof pi.getActiveTools !== "function") {
		registerWaveTool();
	} else {
		try {
			pi.getActiveTools();
			registerWaveTool();
		} catch {
			// pi throws during extension load before the runtime binds; defer to
			// `session_start` so `exposure: "codemode"` is not pre-activated as direct.
		}
	}

	pi.on("session_start", async () => {
		registerWaveTool();
	});
	pi.on("session_tree", async () => {
		registerWaveTool();
	});
	pi.on("before_agent_start", async () => {
		registerWaveTool();
	});

	// --- /orchestrate slash command ----------------------------------------

	pi.registerCommand(WAVE_COMMAND, {
		description: "Run a numbered ticket folder in tiered subagent waves, check status, or abort",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const state = reconstructWaveState(ctx.sessionManager.getBranch());

			if (trimmed === "status" || (trimmed === "" && state?.status === "active")) {
				if (!state) {
					pi.sendMessage(
						{
							customType: WAVE_STATUS_TYPE,
							content: "No wave is active or recorded on this branch. Usage: `/orchestrate <folder>`.",
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
				const { ladder: rawLadder, warnings: ladderWarnings, source: ladderSource } = readLadder();
				const ladder = rawLadder as unknown as WaveLadder;
				const graph = readTickets(path.resolve(ctx.cwd, state.folder)) as unknown as WaveTicketGraph;
				const plan = planWaveDispatch(state, graph, ladder);
				pi.sendMessage(
					{
						customType: WAVE_STATUS_TYPE,
						content: formatStatusReport(state, plan, ladder, ladderSource, ladderWarnings),
						display: true,
						details: { active: state.status === "active", state, plan, ladderSource },
					},
					{ triggerTurn: false },
				);
				return;
			}

			if (trimmed === "abort") {
				return serializeMutation(async () => {
					const latestState = reconstructWaveState(ctx.sessionManager.getBranch());
					if (!latestState || latestState.status !== "active") {
						ctx.ui?.notify?.("No active wave to abort.", "warning");
						return;
					}
					const { ladder: rawLadder } = readLadder();
					const res = applyWaveAction(
						latestState,
						{ type: "abort", reason: "aborted via /orchestrate abort" },
						{},
						rawLadder as unknown as WaveLadder,
						now(),
					);
					if (!res.ok || !res.entry || !res.state) {
						ctx.ui?.notify?.(res.error ?? "Failed to abort wave.", "error");
						return;
					}
					pi.appendEntry(WAVE_ENTRY_TYPE, res.entry);
					ctx.ui?.notify?.(`Aborted wave for ${latestState.folder}.`, "info");
					pi.sendMessage(
						{
							customType: WAVE_STATUS_TYPE,
							content: formatWaveSummary(res.state),
							display: true,
							details: { active: false, state: res.state },
						},
						{ triggerTurn: false },
					);
				});
			}

			if (!trimmed) {
				ctx.ui?.notify?.("Usage: /orchestrate <folder> | /orchestrate status | /orchestrate abort", "info");
				return;
			}

			return serializeMutation(async () => {
				const latestBeforeExec = reconstructWaveState(ctx.sessionManager.getBranch());
				if (latestBeforeExec?.status === "active") {
					ctx.ui?.notify?.(
						`An active wave already exists for "${latestBeforeExec.folder}". Abort or complete it first.`,
						"error",
					);
					return;
				}

				const resolvedFolder = path.resolve(ctx.cwd, trimmed);
				const { ladder: rawLadder, warnings: ladderWarnings, source: ladderSource } = readLadder();
				const ladder = rawLadder as unknown as WaveLadder;
				const graph = readTickets(resolvedFolder) as unknown as WaveTicketGraph;
				const errors = blockingIssues(graph as never);
				if (errors.length > 0) {
					ctx.ui?.notify?.(
						`Cannot start wave in "${trimmed}": ${errors.map((e) => e.message).join("; ")}`,
						"error",
					);
					return;
				}

				if (ladderWarnings.length > 0) {
					ctx.ui?.notify?.(`Wave ladder warnings (${ladderSource}): ${ladderWarnings.join("; ")}`, "warning");
				}

				const modelCheck = checkSessionModelAgainstLadder(ctx.model, ladder);
				if (modelCheck.warned && modelCheck.message) {
					ctx.ui?.notify?.(modelCheck.message, "warning");
				}

				const startHeadSha = await captureHeadSha(pi, ctx.cwd);
				const latestState = reconstructWaveState(ctx.sessionManager.getBranch());
				const res = applyWaveAction(
					latestState,
					{
						type: "start",
						folder: trimmed,
						ladderSource,
						...(startHeadSha ? { startHeadSha } : {}),
						sessionModelWarned: modelCheck.warned,
					},
					{ graph, ladderSource, ...(startHeadSha ? { startHeadSha } : {}), sessionModelWarned: modelCheck.warned },
					ladder,
					now(),
				);
				if (!res.ok || !res.entry || !res.state) {
					ctx.ui?.notify?.(res.error ?? `Cannot start wave in "${trimmed}".`, "error");
					return;
				}

				pi.appendEntry(WAVE_ENTRY_TYPE, res.entry);
				if (res.state.status === "active") {
					options.onWaveActivated?.(ctx);
				}

				const plan = planWaveDispatch(res.state, graph, ladder);
				const kickoff = buildKickoffPrompt(
					trimmed,
					res.state,
					plan,
					ladderSource,
					ladderWarnings,
					modelCheck.message,
				);
				pi.sendMessage(
					{
						customType: WAVE_KICKOFF_TYPE,
						content: kickoff,
						display: true,
						details: {
							folder: trimmed,
							ladderSource,
							state: res.state,
							plan,
							sessionModelWarned: modelCheck.warned,
						},
					},
					{
						triggerTurn: res.state.status === "active",
						...(res.state.status === "active" && typeof ctx.isIdle === "function" && !ctx.isIdle()
							? { deliverAs: "followUp" as const }
							: {}),
					},
				);
			});
		},
	});

	// --- git commit guard while a wave is active ---------------------------

	pi.on("tool_call", async (event, ctx) => {
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		if (tool !== "bash" && tool !== "powershell") return;
		const input = isRecord(event.input) ? event.input : {};
		const command = typeof input.command === "string" ? input.command : "";
		if (!isGitCommitCommand(command)) return;
		const state = reconstructWaveState(ctx.sessionManager.getBranch());
		if (!state || state.status !== "active") return;
		const check = canRunGitCommit(state);
		if (!check.allowed) {
			return { block: true, reason: check.reason };
		}
	});
}
