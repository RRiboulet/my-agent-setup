/**
 * Orchestrator extension: the settlement gate and the typed event bus.
 *
 * Loaded in every session, so load does nothing but register handlers and a
 * command. In particular it starts no timer and reads no file: the project
 * config and the todo directory are read only when a settlement boundary
 * actually needs them, and the goal state is reconstructed from the session
 * branch on `session_start` / `session_tree` as `goal.ts` does.
 *
 * This ticket is report-only. At `agent_before_settle` the gate:
 *   * evaluates an active goal, open todos, edits without a verification run, a
 *     repeated failure signature and the remaining retry allowance;
 *   * appends one `custom` entry (`orchestrator-gate`) carrying the verdict and
 *     its reasons, so the decision is auditable and a resume or tree navigation
 *     cannot reset the attempt count;
 *   * publishes `orchestrator:gate-decided`; and
 *   * returns `entries` only — never `continue`, and never dropping entries an
 *     earlier boundary handler proposed. `continue` is last-writer-wins, so
 *     leaving the field alone is how the gate yields to a goal continuation.
 *
 * Why a `custom` entry and not `custom_message`: a custom entry is ignored by
 * the model context, so recording a verdict on every settle costs no tokens and
 * does not invalidate the prompt cache. `custom_message` would inject a user-role
 * message on every settlement. The verdict is surfaced on demand by `/gate`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { activeGoalFromBranch } from "../goal.ts";
import { readGateConfig } from "./config.ts";
import {
	evaluateGate,
	formatVerdict,
	reconstructGateState,
	scanEditVerification,
	scanFailures,
	GATE_ENTRY_TYPE,
	type GateVerdict,
} from "./gate.ts";
import { ORCHESTRATION_EVENTS, publishOrchestrationEvent } from "./events.ts";
import { readOpenTodos } from "./todo-state.ts";

const GATE_REPORT_TYPE = "orchestrator-gate-report";

export default function orchestratorExtension(pi: ExtensionAPI) {
	let attempts = 0;
	let lastVerdict: GateVerdict | null = null;

	const reconstructState = (ctx: ExtensionContext): void => {
		const state = reconstructGateState(ctx.sessionManager.getBranch());
		attempts = state.attempts;
		lastVerdict = state.lastVerdict;
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	/**
	 * Record one decision. The entry is returned as a boundary proposal rather
	 * than appended with `pi.appendEntry`, because the boundary already composes
	 * and persists entries and doing both would duplicate the audit trail.
	 */
	const record = (
		verdict: GateVerdict,
		event: { entries?: unknown[] },
	): { entries: unknown[] } => {
		attempts = verdict.attempts;
		lastVerdict = verdict;
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.gateDecided, { verdict });
		const prior = Array.isArray(event.entries) ? event.entries : [];
		return {
			entries: [
				...prior,
				{
					type: "custom" as const,
					customType: GATE_ENTRY_TYPE,
					data: verdict,
				},
			],
		};
	};

	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			const config = readGateConfig(ctx.cwd);
			const todos = await readOpenTodos(ctx.cwd);
			const branch = ctx.sessionManager.getBranch();
			const unevaluated: string[] = [];
			if (config.warning) unevaluated.push(`config: ${config.warning}`);
			if (todos.error) unevaluated.push(`todos: ${todos.error}`);

			const verdict = evaluateGate({
				outcome: String(event.outcome ?? "unknown"),
				attempts,
				retryCap: config.config.retryCap,
				activeGoal: activeGoalFromBranch(branch),
				openTodos: todos.todos,
				edits: scanEditVerification(branch),
				failure: scanFailures(branch),
				unevaluated,
			});
			return record(verdict, event);
		} catch (error) {
			// A gate that cannot evaluate must not trap the session: record what
			// failed, with every other condition reported as unknown rather than
			// guessed, and keep settling.
			const verdict = evaluateGate({
				outcome: String(event.outcome ?? "unknown"),
				attempts,
				retryCap: 0,
				unevaluated: [`gate: ${error instanceof Error ? error.message : String(error)}`],
			});
			return record(verdict, event);
		}
	});

	pi.registerCommand("gate", {
		description: "Show the last orchestration settlement verdict (report-only)",
		handler: async (args, ctx) => {
			if (lastVerdict === null) {
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
			const content = args.trim() === "--json" ? JSON.stringify(lastVerdict, null, 2) : formatVerdict(lastVerdict);
			pi.sendMessage({ customType: GATE_REPORT_TYPE, content, display: true }, { triggerTurn: false });
		},
	});
}
