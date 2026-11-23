/**
 * Orchestrator extension: the settlement gate, the loop breaker, the override,
 * the advisor, and the typed event bus.
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
 * is committed — pi offers no post-commit hook there. It is therefore an
 * announcement, not the record: the advisor (ticket 10) reads the committed
 * verdicts and loop decisions from the branch instead of subscribing, because a
 * subscriber may see a proposal that a later handler dropped.
 *
 * **The advisor.** When a project configures `advisor`, a run that starts while
 * the branch holds an unanswered trigger — a repeated settlement failure, or a
 * broken loop — asks one configured stronger model for a second opinion and
 * injects its verdict as an extra prompt section at `before_agent_start`. It
 * never replaces the system prompt and never changes the session model, so the
 * main loop's cached prefix survives; see `advisor.ts` for the trigger, the
 * budget, the digest and the credential rule. The advisor runs in the same
 * trusted project the gate acts in, and only there.
 *
 * **Delegated workers report and never act.** The process role comes from
 * `role.ts`, resolved once at module load: a process launched with
 * `PI_ORCHESTRATOR_ROLE=worker` (or, from an older launcher, the legacy
 * `PI_TMUX_SUBAGENT_CHILD=1`) is a worker whose project config is the same file
 * as the parent's. A worker that blocked itself would stall the delegation its
 * parent is waiting on, and a parent's policy applied to a worker's own work is
 * a decision made with less context than the parent has. So the gate records a
 * verdict with `scope: child`, runs no command, blocks nothing, registers no
 * override tool; the same guard stops the loop breaker from blocking a worker's
 * tool call, and the advisor from consulting. Resolving the role at load time is
 * the fix for a real bug: the old guard re-read `PI_TMUX_SUBAGENT_CHILD` at every
 * boundary, and the subagent factory had already deleted it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { activeGoalFromBranch } from "../goal.ts";
import {
	ADVISOR_ENTRY_TYPE,
	ADVISOR_SECTION,
	ADVISOR_VERSION,
	advisorSkipReason,
	buildAdvisorDigest,
	consultAdvisor,
	detectAdvisorTrigger,
	formatAdvisorRecord,
	formatAdvisorSection,
	readAdvisorState,
	toPiUsage,
	type AdvisorRecord,
} from "./advisor.ts";
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
import { ORCHESTRATION_EVENTS, ORCHESTRATOR_CUSTOM_TYPES, publishOrchestrationEvent, subscribeOrchestrationEvent, type LiveRunStatus } from "./events.ts";
import { buildCompactSnapshot } from "./compact-snapshot.ts";
import { isWorkerRole, ORCHESTRATOR_ROLE, type OrchestratorRole } from "./role.ts";
import { registerWorkspace } from "./workspace-runtime.ts";
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
const ADVISOR_NOTICE_TYPE = "orchestrator-advisor-notice";

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
		`Gate blocks used on this branch: ${verdict.attempts} of ${verdict.attemptCap}.`,
	);
	return lines.join("\n");
}

export default function orchestratorExtension(
	pi: ExtensionAPI,
	// A test seam, and nothing else: the role is a process-level fact, so the only
	// caller that overrides it is a test that needs the worker path without
	// mutating this process's environment after the module was loaded.
	deps: { role?: OrchestratorRole } = {},
) {
	/** A delegated worker reports and never acts; see the header. */
	const worker = isWorkerRole(deps.role ?? ORCHESTRATOR_ROLE);

	// Registered first on purpose: pi stops at the first `tool_call` handler
	// that blocks, so a reserved path must refuse the call before the loop
	// breaker starts counting it.
	registerWorkspace(pi);

	/** The loop breaker's config cache. One read per session, not per call. */
	let cachedConfig: { cwd: string; read: GateConfigRead } | null = null;
	/** A granted override, waiting for the next block. In-memory and one-shot: a
	 *  resume deliberately does not inherit it. */
	let pendingOverride: GateOverrideUse | null = null;
	let lastVerdict: GateVerdict | null = null;
	let lastLoopVerdict: LoopVerdict | null = null;
	/** The last consultation recorded on this branch, for `/gate`. */
	let lastAdvisor: AdvisorRecord | null = null;
	/**
	 * Gate blocks recorded on this branch. Authoritative at the settlement
	 * boundary, which re-derives it from the branch; the copy here exists so the
	 * loop breaker does not walk the session log on every tool call.
	 */
	let attempts = 0;
	const loop = createLoopState();

	/**
	 * The delegated runs this parent believes are live, with the status each
	 * reported. Rebuilt before the first settlement after a reload by
	 * `orchestrator:runs-snapshot`, then maintained from the run lifecycle events.
	 * A non-empty map is what makes an opted-in settlement PARK instead of
	 * spending an attempt on a turn that has nothing new to act on. The status is
	 * carried for the post-compaction snapshot, which names what is in flight;
	 * parking only asks whether the map is empty.
	 */
	const liveRuns = new Map<string, LiveRunStatus>();
	/** True from a parked settlement until the wake it earns. In-memory only: a
	 *  reload rebuilds the live set, not the fact that a particular turn parked, so
	 *  a child that finished during the reload produces no wake. The next
	 *  settlement sees the empty set and blocks normally rather than waking late. */
	let parked = false;
	/** Runs that reached a terminal state after the park, named in the wake. */
	const finishedWhileParked = new Set<string>();

	/**
	 * Wake a parked parent exactly once, after its last live run settles. This is
	 * the only place `triggerTurn` is used by this extension: a normal completion
	 * notice must stay non-waking, but a parent that parked has no turn of its own
	 * left to receive it otherwise.
	 */
	const wakeParkedParent = (finished: string[]): void => {
		parked = false;
		const named = finished.length > 0 ? finished.join(", ") : "the delegated run";
		pi.sendMessage(
			{
				customType: "orchestrator-resume",
				content: `The last live delegated run finished (${named}); no delegated runs remain. You parked this settlement while it was still running, so collect the result with subagent_status and continue the work.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	};

	// Registered at factory load, before any session event: the subagent factory's
	// reload snapshot is published from its `session_start`, and every factory is
	// evaluated before those handlers run. The initial set is therefore rebuilt
	// before this parent's first settlement, whatever the discovery order.
	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runStarted, (payload) => {
		liveRuns.set(payload.runId, payload.status);
	});
	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runSettled, (payload) => {
		liveRuns.delete(payload.runId);
		if (parked) finishedWhileParked.add(payload.runId);
		if (!parked || liveRuns.size > 0) return;
		const finished = [...finishedWhileParked];
		finishedWhileParked.clear();
		wakeParkedParent(finished);
	});
	subscribeOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runsSnapshot, (payload) => {
		liveRuns.clear();
		for (const run of payload.runs) liveRuns.set(run.runId, run.status);
	});
	// An aborted run never reaches `agent_before_settle`, so a park from an earlier
	// settlement can outlive the turn it was protecting. Clearing it on abort means
	// a child that finishes later does not pull the user back into a run they chose
	// to stop.
	pi.on("agent_settled", (event) => {
		if (!event.aborted) return;
		parked = false;
		finishedWhileParked.clear();
	});

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
		// A worker never acts, so it must never get the escape hatch from a block.
		if (worker) return;
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
		// Read from the branch, not remembered: a resume must see the consultations
		// this branch already paid for, and the budget and cooldown are derived
		// from them.
		lastAdvisor = readAdvisorState(ctx.sessionManager.getBranch()).last;
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

	// --- The post-compaction snapshot --------------------------------------

	/**
	 * Re-surface the orchestrator's state to the model after a *successful*
	 * compaction.
	 *
	 * Compaction itself stays pi's: this extension registers no
	 * `session_before_compact` handler and returns no compaction result, so it can
	 * neither cancel nor replace what pi wrote. The gate's and the advisor's state
	 * is branch-derived, and `getBranch()` at `session_compact` still holds the
	 * pre-compaction ancestors, so nothing has to be stashed: the readers below are
	 * called exactly as `/gate` and the next settlement call them. Only the model's
	 * context lost the state, and one `custom_message` repairs it.
	 *
	 * `display: false` is deliberate. A `custom_message` enters the model's context
	 * either way; this is bookkeeping the human did not write, not a transcript
	 * message. `triggerTurn: false` because a compaction must not start a turn of
	 * its own. A failure is a different event (`session_compact_failed`), which
	 * this extension does not handle at all: a failed or cancelled compaction sends
	 * nothing.
	 */
	pi.on("session_compact", async (_event, ctx) => {
		try {
			const branch = ctx.sessionManager.getBranch();
			const gate = reconstructGateState(branch);
			const advisorState = readAdvisorState(branch);
			const goal = activeGoalFromBranch(branch);
			const todos = await readOpenTodos(ctx.cwd);

			// The config supplies the advisor budget and, when the branch holds no
			// verdict yet, the attempt cap. An unreadable config is not an error here:
			// the snapshot is context repair, so the branch-derived sections are still
			// worth sending without it.
			let config: GateConfig | null = null;
			try {
				config = cachedConfigAt(ctx.cwd);
			} catch {
				config = null;
			}
			// An untrusted project's advisor key is ignored entirely (see `advise`), so
			// reporting a budget the advisor would never spend would be misleading.
			const advisorConfig = ctx.isProjectTrusted() ? config?.advisor ?? null : null;

			const snapshot = buildCompactSnapshot({
				goal: goal ? { objective: goal.objective } : null,
				openTodos: todos.todos,
				gate: {
					attempts: gate.attempts,
					attemptCap: gate.lastVerdict?.attemptCap ?? gate.lastLoopVerdict?.attemptCap ?? config?.attemptCap ?? 0,
					blocked: gate.blockedConditions.map((kind) => ({
						kind,
						evidence: gate.blockedEvidence[kind] ?? null,
					})),
					lastReason: gate.lastVerdict?.reason ?? null,
				},
				liveRuns: [...liveRuns].map(([runId, status]) => ({ runId, status })),
				advisor: advisorConfig
					? {
							budget: advisorConfig.budget,
							attempts: advisorState.attempts,
							consumedKeys: advisorState.consumedKeys,
						}
					: null,
			});
			// Nothing to report: no empty message, which would only spend context on a
			// sentence saying there is nothing to say.
			if (snapshot.empty) return;
			pi.sendMessage(
				{
					customType: ORCHESTRATOR_CUSTOM_TYPES.compactSnapshot,
					content: snapshot.text,
					display: false,
				},
				{ triggerTurn: false },
			);
		} catch (error) {
			// Compaction already succeeded; a snapshot that cannot be built must not
			// turn that into a failure. The next settlement still reads the branch.
			ctx.ui.notify(
				`orchestrator snapshot: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	// --- The advisor -------------------------------------------------------

	/**
	 * Record the consultation's usage against the session, so `/session` totals
	 * include what the second opinion cost (R37: it is a model call like any
	 * other, not a hidden one). `appendUsage` exists on the SessionManager pi
	 * hands a context — the cache warmer uses it — but the extension-facing type
	 * narrows that object to `ReadonlySessionManager`, so it is called
	 * structurally and skipped when absent. The advisor's own session entry
	 * always carries the same numbers.
	 */
	const recordAdvisorUsage = (ctx: ExtensionContext, record: AdvisorRecord): void => {
		if (!record.called || !record.usage) return;
		const manager = ctx.sessionManager as unknown as {
			appendUsage?: (kind: string, provider: string, model: string, usage: unknown, note?: string) => unknown;
		};
		if (typeof manager.appendUsage !== "function") return;
		try {
			manager.appendUsage(
				"advisor",
				record.model.provider,
				record.model.model,
				toPiUsage(record.usage),
				"orchestrator advisor consultation",
			);
		} catch {
			// Usage accounting must never be the reason a run fails to start.
		}
	};

	/**
	 * One consultation at run start, when the branch holds an unanswered trigger.
	 *
	 * `before_agent_start` is the only seam at which a prompt section can still
	 * change the request: pi applies prompt options once per prompt, and a
	 * settlement-boundary continuation reuses them. The trigger is read from the
	 * branch because that is what was committed — the `gate-decided` event fires
	 * before commit and may describe a dropped proposal.
	 */
	const advise = async (
		event: { systemPromptOptions?: { sections?: Record<string, string> } },
		ctx: ExtensionContext,
	): Promise<void> => {
		// A delegated worker reports and never acts, exactly like the gate: the
		// parent owns the run's decisions, and its spend.
		if (worker) return;
		// The advisor is a model call configured by a committed file. In a project
		// pi has never trusted that file came from whoever wrote the repository, so
		// its advisor key is ignored entirely: no call, no entry, no section.
		if (!ctx.isProjectTrusted()) return;

		let config: GateConfig;
		try {
			// Cached: one config read per session, not per prompt.
			config = cachedConfigAt(ctx.cwd);
		} catch {
			return;
		}
		const advisor = config.advisor;
		if (!advisor) return;

		const branch = ctx.sessionManager.getBranch();
		const state = readAdvisorState(branch);
		const match = detectAdvisorTrigger({ branch, config: advisor, consumedKeys: state.consumedKeys });
		if (!match) return;
		if (advisorSkipReason({ state, config: advisor, now: Date.now() }) !== null) return;

		const todos = await readOpenTodos(ctx.cwd);
		const digest = buildAdvisorDigest({
			trigger: match.trigger,
			gate: match.gate,
			loop: match.loop,
			goal: activeGoalFromBranch(branch),
			openTodos: todos.todos,
			edits: scanEditVerification(branch, {
				verificationCommand: config.verification?.command ?? null,
				successPattern: config.verification?.successPattern ?? null,
			}),
			redact: advisor.redact,
		});
		const call = await consultAdvisor({
			registry: ctx.modelRegistry,
			config: advisor,
			digest,
			signal: ctx.signal,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		const record: AdvisorRecord = {
			version: ADVISOR_VERSION,
			at: Date.now(),
			trigger: match.trigger,
			// The model that answered, and the primary a fallback replaced: one record
			// is one attempt, so the budget counts the consultation, not the calls.
			model: call.model,
			fallbackFrom: call.fallbackFrom,
			called: call.called,
			status: call.status,
			reason: call.reason,
			verdict: call.verdict,
			usage: call.usage,
			digest,
			latencyMs: call.latencyMs,
		};
		lastAdvisor = record;
		pi.appendEntry(ADVISOR_ENTRY_TYPE, record);
		recordAdvisorUsage(ctx, record);

		if (record.status === "ok" && record.verdict) {
			const sections = event.systemPromptOptions?.sections;
			if (sections && typeof sections === "object" && !Array.isArray(sections)) {
				// Additive only: no `systemPrompt` return, no model change. pi diffs the
				// sections and appends one patch message, so the cached prefix survives.
				sections[ADVISOR_SECTION] = formatAdvisorSection(record);
				return;
			}
			// The section is the only delivery channel this extension uses. A host that
			// offered no mutable sections gets a notice that the verdict was recorded
			// but not attached, rather than a second, quieter channel invented for it.
			pi.sendMessage(
				{
					customType: ADVISOR_NOTICE_TYPE,
					content: `The orchestration advisor returned a verdict, but this host offered no prompt sections to attach it to; it is recorded in the session and /gate shows it.`,
					display: true,
				},
				{ triggerTurn: false },
			);
			return;
		}

		// A refusal or a failed call is surfaced, never a silent skip: the reason
		// names the provider or the error, and the entry above keeps it auditable.
		pi.sendMessage(
			{
				customType: ADVISOR_NOTICE_TYPE,
				content: `The orchestration advisor made no consultation: ${record.reason}`,
				display: true,
			},
			{ triggerTurn: false },
		);
	};

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			await advise(event, ctx);
		} catch (error) {
			// A second opinion is a convenience. A failure to prepare one must never
			// stop the run that is about to start.
			ctx.ui.notify(
				`orchestrator advisor: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	// --- The settlement boundary -------------------------------------------

	const settle = async (
		event: { entries?: unknown[]; outcome?: unknown },
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

		const child = worker;
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
				"this is a delegated worker session (PI_ORCHESTRATOR_ROLE=worker, or the legacy PI_TMUX_SUBAGENT_CHILD=1): the gate reports and never blocks, because the parent owns the decision";
		} else if (!ctx.isProjectTrusted()) {
			// The verification command comes from a committed project file. This
			// extension ships as a user-level package, so it also loads in a checkout
			// pi has never trusted; running that checkout's command at settlement
			// would be arbitrary code execution from a cloned repository.
			suppressed =
				"this project is not trusted, so the gate neither runs the command in its config nor blocks the run";
		} else if (outcome !== "completed") {
			suppressed = `the run ended as "${outcome}"; pi suppresses continuations after an error or abort, so the gate reports only`;
		}
		// Do NOT consult `event.context.canContinue` here. pi builds that snapshot
		// from the drafts proposed BEFORE this handler runs, and on a normal
		// completed run it is false because the last message is the assistant's.
		// The gate's own `custom_message` draft is what makes the next request
		// continuable; treating the pre-draft snapshot as final suppressed every
		// real block. pi validates the post-commit proposal itself and reports an
		// invalid continuation instead of trapping the run.

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

		const edits = scanEditVerification(branch, {
			verificationCommand: config.verification?.command ?? null,
			successPattern: config.verification?.successPattern ?? null,
		});
		const failure = scanFailures(branch);

		const spec = config.verification;
		// Re-run when the files under verification changed: the same evidence that
		// already ran does not need a second command, but a new edit does, or the
		// gate would keep blocking on an unverified state it never rechecked.
		const verificationEvidence = `${[...edits.editedFiles].sort().join(",")}#${edits.editResults ?? 0}`;
		const verificationAlreadyBlockedForEvidence =
			state.blockedConditions.includes("verification") && state.blockedEvidence.verification === verificationEvidence;
		// A repeated block on the same evidence did not re-run the command, but the
		// reader still needs its last outcome: "verification failed (exit 1)" is
		// evidence, "edits without verification" is a weaker rewrite of the same
		// state after the second block.
		const carriedVerification = verificationAlreadyBlockedForEvidence ? state.lastVerdict?.verification ?? null : null;
		// A live delegated run means the work is not finished, so a block would ask
		// the model to act on information it does not have yet. Its outcome would be
		// discarded by the park, so the command is not run: the next settlement,
		// after the run settles, runs it once and acts on the result.
		const parkingWhileLive = config.block.waitForSubagents === true && liveRuns.size > 0;
		const shouldVerify =
			spec !== null &&
			policy.kinds.includes("verification") &&
			edits.editedFiles.length > 0 &&
			!verificationAlreadyBlockedForEvidence &&
			!parkingWhileLive &&
			pendingOverride === null;
		let verification: VerificationOutcome | null = null;
		if (spec && shouldVerify) {
			const exec: VerificationExec | null =
				typeof pi.exec === "function" ? (command, args, options) => pi.exec(command, args, options) : null;
			verification = await runVerification(
				{ ...spec, successPattern: spec.successPattern ?? null },
				{
					cwd: ctx.cwd,
					signal: ctx.signal,
					exec: exec ?? (async () => Promise.reject(new Error("this host does not provide pi.exec"))),
				},
			);
		}

		// Read immediately BEFORE the evaluation, after the awaits above: a run
		// that settled while verification was running is no longer live, and one
		// admitted during it is.
		const liveRunIds = [...liveRuns.keys()];
		const verdict = evaluateGate({
			outcome,
			attempts: state.attempts,
			attemptCap: config.attemptCap,
			scope: child ? "child" : "parent",
			activeGoal: activeGoalFromBranch(branch),
			openTodos: todos.todos,
			edits,
			failure,
			verification: verification ?? carriedVerification,
			verificationCommand: spec?.command ?? null,
			override: pendingOverride,
			policy,
			suppressed,
			unevaluated,
			liveRuns: liveRunIds,
			waitForSubagents: config.block.waitForSubagents,
		});
		if (verdict.override) pendingOverride = null;
		// A parked settlement earns one wake, sent when the live set empties. A
		// worker never reaches here with `parked` true: `suppressed` empties its
		// candidate set, so parking needs no special case.
		if (verdict.parked) parked = true;
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
				scope: worker ? "child" : "parent",
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
		if (worker) return;
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
		if (worker) return;
		const tool = typeof event.toolName === "string" ? event.toolName : "";
		if (!tool) return;
		const call = loopCallOf(tool, isRecord(event.input) ? event.input : {});
		recordResult(loop, call, { isError: event.isError === true, text: toolResultText(event.content) });
	});

	// --- The override ------------------------------------------------------

	// --- /gate -------------------------------------------------------------

	pi.registerCommand("gate", {
		description: "Show the last orchestration settlement verdict, loop block and advisor consultation",
		handler: async (args, ctx) => {
			const json = args.trim() === "--json";
			if (lastVerdict === null && lastLoopVerdict === null && lastAdvisor === null) {
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
				content = JSON.stringify({ verdict: lastVerdict, loop: lastLoopVerdict, advisor: lastAdvisor }, null, 2);
			} else {
				const parts: string[] = [];
				if (lastVerdict) parts.push(formatVerdict(lastVerdict));
				if (lastLoopVerdict) parts.push(formatLoopVerdict(lastLoopVerdict));
				if (lastAdvisor) parts.push(formatAdvisorRecord(lastAdvisor));
				content = parts.join("\n\n");
			}
			pi.sendMessage({ customType: GATE_REPORT_TYPE, content, display: true }, { triggerTurn: false });
		},
	});
}
