/**
 * Orchestrator extension: the settlement gate, the loop breaker, the override,
 * and the typed event bus.
 *
 * Loaded in every session, so load does nothing but register handlers and one
 * command. It starts no timer. The project config and the todo directory are
 * read only when something actually needs them: at `session_start` (once, for
 * the loop breaker and to decide whether the override tool is worth
 * registering), at the settlement boundary (once per run), and cached in
 * between — a `tool_call` handler that read a file on every call would put a
 * syscall in the hot path of every tool the model uses. The override tool is
 * registered only for a project that opted into a check, because a tool's
 * declaration rides on every request.
 *
 * What the gate does at `agent_before_settle`:
 *
 *   1. Recomputes its state from the active branch — attempts, the last
 *      verdicts, and the condition kinds that already blocked. Nothing is
 *      carried optimistically across a dropped proposal: the branch is the
 *      authority, and a boundary proposal that a later handler invalidates is
 *      simply not there next time.
 *   2. Evaluates the conditions: an active goal, open todos, edits with no
 *      verification, a repeated failure signature, the remaining block budget.
 *   3. Runs the project's verification command when — and only when — it could
 *      change the decision.
 *   4. Records one `custom` entry with the verdict and, if it decided to block,
 *      one `custom_message` carrying the reason and the verification output,
 *      then returns `continue: true`. It never returns `continue: false`, and it
 *      always carries forward the entries an earlier handler proposed: `entries`
 *      compose, `continue` is last-writer-wins, and the goal extension owns the
 *      continuation when a goal is active.
 *
 * `orchestrator:gate-decided` is published from the boundary, before the entry
 * is committed — pi offers no post-commit hook there. That is why nothing acts on
 * the event: the action is the return value, and the state was read from the
 * branch rather than advanced when the event fired. A subscriber (the advisor in
 * ticket 10) may therefore see a proposal that a later handler dropped; it may
 * not treat the event as the only record.
 *
 * **Delegated children report and never act.** `PI_TMUX_SUBAGENT_CHILD=1` marks a
 * child session, whose project config is the same file as the parent's. A child
 * that blocked itself would stall a delegation the parent is waiting on, and a
 * parent's policy applied to a child's own work is a decision made with less
 * context than the parent has. So the gate records a verdict with `scope: child`,
 * runs no command, blocks nothing; the same guard stops the loop breaker from
 * blocking a child's tool call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { activeGoalFromBranch } from "../goal.ts";
import { gateConfigCanAct, readGateConfig, type GateConfig, type GateConfigRead } from "./config.ts";
import {
	evaluateGate,
	formatLoopVerdict,
	formatVerdict,
	GATE_ENTRY_TYPE,
	GATE_LOOP_ENTRY_TYPE,
	GATE_OVERRIDE_ENTRY_TYPE,
	GATE_OVERRIDE_TOOL,
	GATE_VERSION,
	reconstructGateState,
	scanEditVerification,
	scanFailures,
	type GateBlockPolicy,
	type GateOverrideUse,
	type GateVerdict,
	type LoopVerdict,
} from "./gate.ts";
import { ORCHESTRATION_EVENTS, publishOrchestrationEvent } from "./events.ts";
import { readOpenTodos } from "./todo-state.ts";
import { runVerification, type VerificationExec, type VerificationOutcome } from "./verify.ts";
import {
	createLoopState,
	evaluateLoop,
	invocationLabel,
	loopBlockReason,
	loopSignature,
	recordCall,
	recordResult,
	resetLoopState,
	resetLoopTurn,
	LOOP_BLOCKS_PER_TURN,
} from "./loop.ts";

const GATE_REPORT_TYPE = "orchestrator-gate-report";
const GATE_CONTINUATION_TYPE = "orchestrator-gate-continuation";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";

/** A delegated child reports and never acts; see the header. */
function inChildSession(): boolean {
	return process.env[CHILD_ENV] === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(" ");
}

/** The text the model receives when the gate blocks a settlement. */
function continuationText(verdict: GateVerdict): string {
	const lines = ["The orchestration gate did not settle this run.", "", verdict.reason, ""];
	if (verdict.verification) {
		lines.push(`Verification (\`${verdict.verification.command}\`, ${verdict.verification.status}):`, "```");
		lines.push(verdict.verification.output || verdict.verification.summary);
		lines.push("```", "");
	}
	lines.push(
		`Gate blocks used on this branch: ${verdict.attempts} of ${verdict.attemptCap}. The condition that blocked now reports only and will not block again on this branch; call \`${GATE_OVERRIDE_TOOL}\` with a reason if you need to settle without addressing it.`,
	);
	return lines.join("\n");
}

export default function orchestratorExtension(pi: ExtensionAPI) {
	/** The loop breaker's config cache. One read per session, not per call. */
	let cachedConfig: { cwd: string; read: GateConfigRead } | null = null;
	/** A granted override, waiting for the next block. In-memory and one-shot: a
	 *  resume deliberately does not inherit it. */
	let pendingOverride: GateOverrideUse | null = null;
	let lastVerdict: GateVerdict | null = null;
	let lastLoopVerdict: LoopVerdict | null = null;
	/**
	 * Gate blocks recorded on this branch. Authoritative at the settlement
	 * boundary, which re-derives it from the branch; the copy here exists so the
	 * loop breaker does not walk the session log on every tool call.
	 */
	let attempts = 0;
	const loop = createLoopState();

	/**
	 * Register the override tool on demand.
	 *
	 * A registered tool's declaration rides on every request, so a report-only
	 * project should not pay for the escape hatch from a block it cannot get. The
	 * registration happens at `session_start` for a config that opts into action,
	 * and again at a settlement boundary — pi allows `registerTool` after startup
	 * and refreshes the tool list immediately, which covers a config added
	 * mid-session. Idempotent, so the second path is free.
	 */
	let overrideToolRegistered = false;
	const registerOverrideTool = (trusted: boolean): void => {
		if (!trusted) return; // never offer an escape hatch in a project the gate will not act in
		if (overrideToolRegistered) return;
		overrideToolRegistered = true;
		pi.registerTool({
			name: GATE_OVERRIDE_TOOL,
			label: "Orchestration override",
			description:
				"Grant a one-shot override for the orchestration gate: it lets this run settle, or lets a loop-blocked tool call run, despite a block. Every block reason names this tool. Use it only when you are deliberately iterating and the block is wrong — the reason is recorded in the session, so say what you are doing. The override is consumed by the next block and is not inherited by a resumed session.",
			promptSnippet: "Override the next orchestration gate block (settlement check or loop break)",
			promptGuidelines: [
				"Call orchestrator_override only when a gate block is wrong for what you are doing, and give the real reason: it is recorded in the session.",
			],
			parameters: Type.Object({
				reason: Type.String({
					description: "Why the block is wrong and what you are doing instead. Recorded in the session; it may not be empty.",
				}),
			}),
			async execute(_toolCallId, params) {
				const reason = String(params.reason ?? "").trim();
				if (!reason) {
					throw new Error("orchestrator_override needs a non-empty reason; it is recorded so an override is auditable");
				}
				const at = Date.now();
				pendingOverride = { reason, at };
				pi.appendEntry(GATE_OVERRIDE_ENTRY_TYPE, { version: GATE_VERSION, action: "grant", reason, at });
				return {
					content: [
						{
							type: "text",
							text: `Override granted for the next orchestration gate block: ${reason}. It is consumed by that block and applies to this session only.`,
						},
					],
					details: { reason, at },
				};
			},
		});
	};

	const cachedConfigAt = (cwd: string): GateConfig => {
		if (cachedConfig?.cwd !== cwd) cachedConfig = { cwd, read: readGateConfig(cwd) };
		return cachedConfig.read.config;
	};

	const reconstructState = (ctx: ExtensionContext): void => {
		const state = reconstructGateState(ctx.sessionManager.getBranch());
		lastVerdict = state.lastVerdict;
		lastLoopVerdict = state.lastLoopVerdict;
		attempts = state.attempts;
		// One config read per session boundary: the loop breaker and the override
		// tool both need to know, before the first tool call, whether this project
		// opted into anything.
		cachedConfig = { cwd: ctx.cwd, read: readGateConfig(ctx.cwd) };
		if (gateConfigCanAct(cachedConfig.read.config)) registerOverrideTool(ctx.isProjectTrusted());
		pendingOverride = null;
		resetLoopState(loop);
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	// The per-turn cap is a turn concept; pi fires `turn_start` before any tool
	// call of the turn, and `agent_start` as a second, idempotent reset.
	pi.on("turn_start", async () => resetLoopTurn(loop));
	pi.on("agent_start", async () => resetLoopTurn(loop));

	// --- The settlement boundary -------------------------------------------

	const settle = async (
		event: { entries?: unknown[]; outcome?: unknown; context?: unknown },
		ctx: ExtensionContext,
	): Promise<{ entries: unknown[]; continue?: boolean }> => {
		// Fresh per boundary, not cached: a run may last minutes and a project may
		// correct its config mid-session. One read per run is not a cost.
		const configRead = readGateConfig(ctx.cwd);
		cachedConfig = { cwd: ctx.cwd, read: configRead };
		const config: GateConfig = configRead.config;
		if (gateConfigCanAct(config)) registerOverrideTool(ctx.isProjectTrusted());
		const branch = ctx.sessionManager.getBranch();
		const state = reconstructGateState(branch);
		attempts = state.attempts;
		lastVerdict = state.lastVerdict ?? lastVerdict;
		lastLoopVerdict = state.lastLoopVerdict ?? lastLoopVerdict;

		const child = inChildSession();
		const outcome = String(event.outcome ?? "unknown");
		const unevaluated: string[] = [];
		if (configRead.warning) unevaluated.push(`config: ${configRead.warning}`);

		const todos = await readOpenTodos(ctx.cwd);
		if (todos.error) unevaluated.push(`todos: ${todos.error}`);

		/**
		 * Why blocking is not even attempted. An unevaluable condition fails open
		 * (reported as unknown); these three are certainties, and each is said out
		 * loud so a reader of the verdict can tell "nothing was open" from "the gate
		 * could not act here".
		 */
		let suppressed: string | null = null;
		if (child) {
			suppressed =
				"this is a delegated child session (PI_TMUX_SUBAGENT_CHILD=1): the gate reports and never blocks, because the parent owns the decision";
		} else if (!ctx.isProjectTrusted()) {
			// The verification command comes from a committed project file. This
			// extension ships as a user-level package, so it also loads in a checkout
			// pi has never trusted; running that checkout's command at settlement
			// would be arbitrary code execution from a cloned repository.
			suppressed =
				"this project is not trusted, so the gate neither runs the command in its config nor blocks the run";
		} else if (outcome !== "completed") {
			suppressed = `the run ended as "${outcome}"; pi suppresses continuations after an error or abort, so the gate reports only`;
		} else if (isRecord(event.context) && event.context.canContinue === false) {
			suppressed = "pi reported that this boundary cannot continue the run, so the gate reports only";
		}

		const policy: GateBlockPolicy = {
			kinds: [],
			alreadyBlocked: state.blockedConditions,
			alreadyBlockedEvidence: state.blockedEvidence,
		};
		if (!suppressed) {
			if (config.block.openTodos) policy.kinds.push("todos");
			if (config.block.repeatedFailure) policy.kinds.push("failure");
			if (config.verification) policy.kinds.push("verification");
		}

		const edits = scanEditVerification(branch, { verificationCommand: config.verification?.command ?? null });
		const failure = scanFailures(branch);

		const spec = config.verification;
		const shouldVerify =
			spec !== null &&
			policy.kinds.includes("verification") &&
			edits.editedFiles.length > 0 &&
			!state.blockedConditions.includes("verification") &&
			state.attempts < config.attemptCap &&
			pendingOverride === null;
		let verification: VerificationOutcome | null = null;
		if (spec && shouldVerify) {
			const exec: VerificationExec | null =
				typeof pi.exec === "function" ? (command, args, options) => pi.exec(command, args, options) : null;
			verification = await runVerification(spec, {
				cwd: ctx.cwd,
				signal: ctx.signal,
				exec: exec ?? (async () => Promise.reject(new Error("this host does not provide pi.exec"))),
			});
		}

		const verdict = evaluateGate({
			outcome,
			attempts: state.attempts,
			attemptCap: config.attemptCap,
			scope: child ? "child" : "parent",
			activeGoal: activeGoalFromBranch(branch),
			openTodos: todos.todos,
			edits,
			failure,
			verification,
			verificationCommand: spec?.command ?? null,
			override: pendingOverride,
			policy,
			suppressed,
			unevaluated,
		});
		if (verdict.override) pendingOverride = null;
		attempts = verdict.attempts;
		lastVerdict = verdict;

		const prior = Array.isArray(event.entries) ? event.entries : [];
		const entries: unknown[] = [
			...prior,
			{ type: "custom" as const, customType: GATE_ENTRY_TYPE, data: verdict },
		];
		if (verdict.decision === "continue") {
			entries.push({
				type: "custom_message" as const,
				customType: GATE_CONTINUATION_TYPE,
				content: continuationText(verdict),
				display: true,
				details: {
					attempts: verdict.attempts,
					attemptCap: verdict.attemptCap,
					blockedBy: verdict.blockedBy,
					overrideTool: GATE_OVERRIDE_TOOL,
				},
			});
		}
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, { action: "settle", verdict });
		// `continue` is returned only when the gate blocked: yielding means leaving
		// the field alone, so a goal continuation that was already requested stands.
		return verdict.decision === "continue" ? { entries, continue: true } : { entries };
	};

	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			return await settle(event, ctx);
		} catch (error) {
			// A gate that cannot evaluate must not trap the session: record what
			// failed, with every condition reported as unknown rather than guessed,
			// and keep settling (R33).
			const verdict = evaluateGate({
				outcome: String(event.outcome ?? "unknown"),
				attempts,
				attemptCap: 0,
				scope: inChildSession() ? "child" : "parent",
				suppressed: "the gate failed before it could act; this settlement is not blocked",
				unevaluated: [`gate: ${error instanceof Error ? error.message : String(error)}`],
			});
			lastVerdict = verdict;
			publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, { action: "settle", verdict });
			const prior = Array.isArray(event.entries) ? event.entries : [];
			return {
				entries: [...prior, { type: "custom" as const, customType: GATE_ENTRY_TYPE, data: verdict }],
			};
		}
	});

	// --- The loop breaker --------------------------------------------------

	const loopCallOf = (tool: string, input: unknown) => ({
		tool,
		signature: loopSignature(tool, input),
		invocation: invocationLabel(tool, input),
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		if (!tool || tool === GATE_OVERRIDE_TOOL) return;
		if (inChildSession()) return;
		// Same boundary as the settlement: a project pi does not trust supplies the
		// config, so its policy is not honoured here either.
		if (!ctx.isProjectTrusted()) return;
		let config: GateConfig;
		try {
			// Cached: one file read for the session, not one per tool call.
			config = cachedConfigAt(ctx.cwd);
		} catch {
			return; // A gate that cannot read its config must never block a tool.
		}
		if (!config.block.loops) return;

		const call = loopCallOf(tool, isRecord(event.input) ? event.input : {});
		const evidence = evaluateLoop(loop, call);
		if (!evidence) {
			recordCall(loop, call);
			return;
		}

		const at = Date.now();
		const consumeOverride = (): undefined => {
			const reason = `an override (\`${pendingOverride?.reason ?? "granted"}\`) let this repeated call run`;
			pendingOverride = null;
			recordCall(loop, call);
			const record: LoopVerdict = {
				version: GATE_VERSION,
				action: "override",
				at,
				tool,
				invocation: call.invocation,
				kind: evidence.kind,
				count: evidence.count,
				detail: evidence.detail,
				reason,
				attempts,
				attemptCap: config.attemptCap,
				remainingAttempts: Math.max(0, config.attemptCap - attempts),
				blocksTheTurn: loop.blocksTheTurn,
			};
			lastLoopVerdict = record;
			pi.appendEntry(GATE_LOOP_ENTRY_TYPE, record);
			publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, { action: "loop-block", loop: record });
			return undefined;
		};

		if (pendingOverride) return consumeOverride();
		// Bounded twice, on purpose: per turn (the cap) and per branch (the same
		// budget the settlement blocks draw on). Both failures are silent by
		// design — an exhausted budget must let the call run, never trap it.
		if (loop.blocksTheTurn >= LOOP_BLOCKS_PER_TURN || attempts >= config.attemptCap) {
			recordCall(loop, call);
			return;
		}

		// A blocked call is deliberately NOT recorded: nothing ran, so there is no
		// result, and leaving it out lets the next settlement's evidence stay
		// readable instead of being poisoned by a call that never happened.
		loop.blocksTheTurn += 1;
		attempts += 1;
		const reason = loopBlockReason(evidence, GATE_OVERRIDE_TOOL);
		const record: LoopVerdict = {
			version: GATE_VERSION,
			action: "block",
			at,
			tool,
			invocation: call.invocation,
			kind: evidence.kind,
			count: evidence.count,
			detail: evidence.detail,
			reason,
			attempts,
			attemptCap: config.attemptCap,
			remainingAttempts: Math.max(0, config.attemptCap - attempts),
			blocksTheTurn: loop.blocksTheTurn,
		};
		lastLoopVerdict = record;
		pi.appendEntry(GATE_LOOP_ENTRY_TYPE, record);
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, { action: "loop-block", loop: record });
		return { block: true, reason };
	});

	pi.on("tool_result", async (event) => {
		// Nothing to record unless the loop breaker is armed, and reading the
		// cache (never the file) keeps that check free.
		if (!cachedConfig?.read.config.block.loops) return;
		if (inChildSession()) return;
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		if (!tool) return;
		const call = loopCallOf(tool, isRecord(event.input) ? event.input : {});
		recordResult(loop, call, { isError: event.isError === true, text: toolResultText(event.content) });
	});

	// --- The override ------------------------------------------------------

	// --- /gate -------------------------------------------------------------

	pi.registerCommand("gate", {
		description: "Show the last orchestration settlement verdict and loop block",
		handler: async (args, ctx) => {
			const json = args.trim() === "--json";
			if (lastVerdict === null && lastLoopVerdict === null) {
				pi.sendMessage(
					{
						customType: GATE_REPORT_TYPE,
						content: "No settlement gate decision has been recorded in this session yet.",
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}
			let content: string;
			if (json) {
				content = JSON.stringify({ verdict: lastVerdict, loop: lastLoopVerdict }, null, 2);
			} else {
				const parts: string[] = [];
				if (lastVerdict) parts.push(formatVerdict(lastVerdict));
				if (lastLoopVerdict) parts.push(formatLoopVerdict(lastLoopVerdict));
				content = parts.join("\n\n");
			}
			pi.sendMessage({ customType: GATE_REPORT_TYPE, content, display: true }, { triggerTurn: false });
		},
	});
}
