/**
 * review-triage — a Jev-gated review planner.
 *
 * The agent calls `triage_change` after implementing something. Deterministic
 * code gathers the evidence and packages it; Jev judges whether the change
 * needs adversarial and/or complexity review, how hard each should push, and
 * which of the allowed models should run it; code applies the thresholds, the
 * cost floor, the fallback chains and the thinking level. The result is a plan,
 * not an action — the agent starts the reviews with the `subagent` tool.
 *
 * The whole decision is appended to the session as a `review-triage` entry, so
 * "we skipped review here" is auditable after the fact rather than invisible.
 *
 * Config: ~/.pi/agent/review-triage.json (all fields optional).
 * Judge:  a pi classifier model, `openrouter` / `typesafe/jev-1.13` by default.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { agentDir, applyDotEnv, loadConfig, type Candidate, type TriageConfig } from "./config.ts";
import { collectEvidence, type TriageTarget } from "./evidence.ts";
import { askJudge, buildState, JudgeError, type Judgment } from "./judge.ts";
import {
	composePlan,
	costBucket,
	failOpenPlan,
	resolveCandidates,
	type AvailableModel,
	type ModelRef,
	type ReviewPlan,
} from "./compose.ts";
import { formatPlan } from "./format.ts";
import { join } from "node:path";

const TARGETS = ["uncommitted", "branch", "commit", "none"] as const;
type TargetParam = (typeof TARGETS)[number];

export interface TriageParams {
	summary: string;
	target?: TargetParam;
	base?: string;
	ref?: string;
	notes?: string[];
	cwd?: string;
}

interface TriageRun {
	plan: ReviewPlan;
	judgment?: Judgment;
	evidence: { target: string; files: string[]; added: number; removed: number; signals: string[]; error?: string };
}

export function resolveTarget(params: TriageParams): TriageTarget {
	if (params.target === "none") return { kind: "none" };
	if (params.target === "commit" || (!params.target && params.ref)) {
		return { kind: "commit", ...(params.ref ? { ref: params.ref } : {}) };
	}
	if (params.target === "branch" || (!params.target && params.base)) {
		return { kind: "branch", base: params.base?.trim() || "dev" };
	}
	return { kind: "uncommitted" };
}

function currentModel(ctx: ExtensionContext): ModelRef | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return { provider: model.provider, model: model.id, cost: costBucket(model.cost?.input) };
}

function availableModels(ctx: ExtensionContext): AvailableModel[] {
	return ctx.modelRegistry.getAvailable().map((model) => ({
		provider: model.provider,
		id: model.id,
		reasoning: model.reasoning,
		cost: model.cost
			? {
					input: model.cost.input,
					output: model.cost.output,
					cacheRead: model.cost.cacheRead,
					cacheWrite: model.cost.cacheWrite,
				}
			: undefined,
		thinkingLevelMap: model.thinkingLevelMap ?? null,
	}));
}

/**
 * The whole pipeline, shared by the tool and the `/triage` command. Config is
 * re-read on every call so an edit takes effect without reloading pi.
 */
async function runTriage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: TriageParams,
	options: { signal?: AbortSignal; onProgress?: (text: string) => void } = {},
): Promise<TriageRun> {
	const config = loadConfig();
	applyDotEnv(process.env, config.envFile || join(agentDir(), ".env"));

	const signal = options.signal ?? ctx.signal;
	const onProgress = options.onProgress;
	const available = availableModels(ctx);
	const candidates = resolveCandidates(config, available);
	const target = resolveTarget(params);

	onProgress?.("gathering change evidence");
	const evidence = await collectEvidence((command, args, execOptions) => pi.exec(command, args, execOptions), {
		summary: params.summary,
		notes: params.notes,
		target,
		cwd: params.cwd ?? ctx.cwd,
		signal,
	});

	const summary = evidence.summary || params.summary;
	const planEvidence = {
		files: evidence.files.length,
		added: evidence.added,
		removed: evidence.removed,
		signals: evidence.signals,
	};

	onProgress?.(`asking ${config.judge.provider}/${config.judge.model}`);
	let judgment: Judgment | undefined;
	let plan: ReviewPlan;
	try {
		judgment = await askJudge(
			ctx.modelRegistry,
			config,
			buildState(evidence, config.stateChars),
			candidates,
			signal,
		);
		plan = composePlan({
			judgment,
			config,
			candidates,
			available,
			current: currentModel(ctx),
			evidence: planEvidence,
			summary,
		});
	} catch (error) {
		if (!(error instanceof JudgeError)) throw error;
		plan = failOpenPlan({
			config,
			candidates,
			available,
			current: currentModel(ctx),
			evidence: planEvidence,
			summary,
			reason: error.message,
		});
	}

	const entry: TriageRun = {
		plan,
		...(judgment ? { judgment } : {}),
		evidence: {
			target: evidence.target,
			files: evidence.files,
			added: evidence.added,
			removed: evidence.removed,
			signals: evidence.signals,
			...(evidence.error ? { error: evidence.error } : {}),
		},
	};
	try {
		pi.appendEntry("review-triage", entry);
	} catch {
		// Durable entries are a convenience; never let one break the tool call.
	}
	return entry;
}

/** Parse `/triage [uncommitted|branch <name>|commit <sha>] [--summary "..."] [--note "..."]`. */
export function parseTriageArgs(raw: string): TriageParams {
	const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const unquote = (value: string | undefined) => value?.replace(/^["']|["']$/g, "");
	const params: TriageParams = { summary: "" };
	const notes: string[] = [];
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = unquote(tokens[i]) ?? "";
		if (token === "--summary") params.summary = unquote(tokens[++i]) ?? "";
		else if (token.startsWith("--summary=")) params.summary = token.slice("--summary=".length);
		else if (token === "--note") {
			const note = unquote(tokens[++i]);
			if (note) notes.push(note);
		} else if (token.startsWith("--note=")) notes.push(token.slice("--note=".length));
		else if (token === "--base") params.base = unquote(tokens[++i]);
		else if (token.startsWith("--base=")) params.base = token.slice("--base=".length);
		else if (token === "--ref") params.ref = unquote(tokens[++i]);
		else if (token.startsWith("--ref=")) params.ref = token.slice("--ref=".length);
		else positional.push(token);
	}

	const mode = positional[0];
	if (mode === "branch") {
		params.target = "branch";
		if (positional[1]) params.base = positional[1];
	} else if (mode === "commit") {
		params.target = "commit";
		if (positional[1]) params.ref = positional[1];
	} else if (mode === "none") {
		params.target = "none";
	} else if (mode === "uncommitted") {
		params.target = "uncommitted";
	} else if (mode) {
		// A bare unknown word is most usefully read as part of the summary.
		params.summary = [mode, ...positional.slice(1)].join(" ");
	}

	if (notes.length > 0) params.notes = notes;
	if (!params.summary) params.summary = "the current uncommitted changes";
	return params;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "triage_change",
		label: "Review Triage",
		description:
			"Decide whether a just-finished change needs an independent adversarial review, a complexity/design " +
			"review, or neither — and with which model and thinking level. Gathers the git diff as evidence and " +
			"asks a calibrated decision model (Jev) for the judgement; code applies the thresholds and the cost " +
			"floor. Returns a plan; it does not launch anything. Use it before committing or opening a PR when " +
			"you are unsure how much independent review the change warrants.",
		promptSnippet: "Gate a finished change: does it need adversarial or complexity review, and how strong?",
		promptGuidelines: [
			"Use triage_change after implementing a change and before committing or opening a PR, when its risk is not obvious.",
			"triage_change recommends; it does not launch. When it says a review is needed, start the model it names (with the thinking level it names) using the subagent tool and the task it returns.",
			"Do not call triage_change for every trivial edit: it spends one classifier request per call.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "One line describing what was implemented and why" }),
			target: Type.Optional(
				StringEnum(TARGETS, {
					description:
						"What to inspect: 'uncommitted' (default), 'branch' (needs base), 'commit' (needs ref), or 'none' to judge from the summary alone",
				}),
			),
			base: Type.Optional(Type.String({ description: "Base branch for target='branch' (default 'dev')" })),
			ref: Type.Optional(Type.String({ description: "Commit sha for target='commit'" })),
			notes: Type.Optional(
				Type.Array(Type.String(), {
					description: "Risk the diff cannot show, e.g. 'this changes an on-disk format'",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Repository to inspect; defaults to the session cwd" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Review triage: consulting the judge…" }] });
			const run = await runTriage(pi, ctx, params as TriageParams, {
				signal,
				onProgress: (text) =>
					onUpdate?.({ content: [{ type: "text", text: `Review triage: ${text}…` }] }),
			});
			return {
				content: [{ type: "text", text: formatPlan(run.plan) }],
				details: run,
			};
		},
	});

	pi.registerCommand("triage", {
		description: "Decide whether the current change needs independent review (/triage [branch <b>|commit <sha>] [--summary \"...\"])",
		handler: async (args, ctx) => {
			const params = parseTriageArgs(args ?? "");
			try {
				const run = await runTriage(pi, ctx, params);
				pi.sendUserMessage(`Review triage plan:\n\n${formatPlan(run.plan)}`);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`triage failed: ${(error as Error).message}`, "error");
			}
		},
	});
}

export const __test__ = {
	parseTriageArgs,
	resolveTarget,
};

export type { Candidate, TriageConfig };
