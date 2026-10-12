/**
 * review-triage — a Jev-gated review planner.
 *
 * The agent calls `triage_change` after implementing something. Deterministic
 * code gathers the evidence and packages it; Jev judges, per track, one
 * distribution over `none` and the allowed profiles (capability band +
 * thinking level); code applies the skip gate and resolves the chosen profile
 * to a concrete model. The result is a plan, not an action — the agent starts
 * the reviews with the `subagent` tool.
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
import {
	agentDir,
	applyDotEnv,
	generateCatalog,
	loadConfig,
	type Candidate,
	type ProfileCatalog,
	type TriageConfig,
} from "./config.ts";
import { collectEvidence, toEvidenceItems, type TriageTarget } from "./evidence.ts";
import { askJudge, JudgeError, type Judgment } from "./judge.ts";
import {
	composePlan,
	disabledPlan,
	failOpenPlan,
	resolveCandidates,
	type AvailableModel,
	type ReviewPlan,
} from "./compose.ts";
import { buildDossier, RISK_RULES_VERSION } from "./dossier.ts";
import type { PolicyGates } from "./policy.ts";
import { formatPlan } from "./format.ts";
import { join } from "node:path";

const TARGETS = ["uncommitted", "branch", "commit", "task", "none"] as const;
type TargetParam = (typeof TARGETS)[number];

export interface TriageParams {
	summary: string;
	target?: TargetParam;
	base?: string;
	ref?: string;
	/** Baseline ref for the `task` target. */
	baseline?: string;
	notes?: string[];
	cwd?: string;
}

interface TriageRun {
	plan: ReviewPlan;
	judgment?: Judgment;
	catalog: ProfileCatalog;
	/** SHA-256 of the dossier that was judged, so a verdict can be replayed. */
	fingerprint?: string;
	evidence: { target: string; files: string[]; added: number; removed: number; signals: string[]; error?: string };
}

export function resolveTarget(params: TriageParams, taskBaselineRef?: string): TriageTarget {
	if (params.target === "none") return { kind: "none" };
	if (params.target === "task" || params.baseline) {
		// The task scope measures the worktree against the baseline ref, so
		// work that predates the task stays out of the evidence. A supplied
		// baseline always implies this scope, whatever target was also named —
		// the caller asked for baseline-scoped evidence and a baseline is
		// never silently ignored. Neither supplied nor configured leaves the
		// scope without a snapshot to measure from, which the collector
		// reports as an error.
		const baseline = params.baseline?.trim() || taskBaselineRef?.trim();
		return { kind: "task", ...(baseline ? { baselineRef: baseline } : {}) };
	}
	if (params.target === "commit" || (!params.target && params.ref)) {
		return { kind: "commit", ...(params.ref ? { ref: params.ref } : {}) };
	}
	if (params.target === "branch" || (!params.target && params.base)) {
		return { kind: "branch", base: params.base?.trim() || "dev" };
	}
	return { kind: "uncommitted" };
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

	if (!config.enabled) {
		const entry: TriageRun = {
			plan: disabledPlan({ files: 0, added: 0, removed: 0, signals: [] }),
			catalog: { options: [], pruned: [], notes: [] },
			evidence: { target: "none", files: [], added: 0, removed: 0, signals: [] },
		};
		try {
			pi.appendEntry("review-triage", entry);
		} catch {
			// Durable entries are a convenience; never let one break the tool call.
		}
		return entry;
	}

	const available = availableModels(ctx);
	const candidates = resolveCandidates(config, available);
	const catalog = generateCatalog({
		candidates,
		ladder: config.thinkingLadder,
		available,
	});
	const target = resolveTarget(params, config.taskBaselineRef);

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

	// The dossier is the single, fingerprinted document Jev judges. It is built
	// from the collected evidence items plus the caller-supplied context, so the
	// budget and the trim live here rather than in a second state serialization.
	// The fingerprint identifies the exact dossier judged — evidence, task,
	// catalog and budget — so a change re-triaged after a model appears or
	// disappears is honestly a different judgement, not a silently stale one.
	// One snapshot identity is used for both the evidence items and the scope,
	// so the two cannot default differently and hash against different baselines.
	const snapshot = evidence.baseline ?? evidence.ref ?? evidence.base ?? target.kind;
	const built = buildDossier({
		items: toEvidenceItems(evidence, snapshot),
		task: { summary },
		scope: {
			target: target.kind,
			...(target.base ? { base: target.base } : {}),
			...(target.ref ? { ref: target.ref } : {}),
			snapshot,
		},
		catalog: catalog.options.map((option) => option.key),
		supplementary: params.notes,
		// The thin collectors (validation, harness context, caller artifacts) are
		// not wired into the pipeline yet, so say so rather than let an empty
		// `validation` section read as "no checks were run".
		limitations: ["validation results and task requirements were not collected for this run"],
		versions: { riskRules: RISK_RULES_VERSION },
		budgetChars: config.stateChars,
	});

	// Every gate reads from a real signal: `stable` comes from the probe around
	// collection (§6), conflicts from the collector's per-file flags, a skip-
	// blocking limitation keeps the review, and a dossier that could not be made
	// complete (manifest or budget overflow) is never evidence of a small change.
	const gates: PolicyGates = {
		stable: !evidence.unstable,
		conflicts: Object.values(evidence.indicators).some((flags) => flags.conflict),
		evidenceComplete:
			!evidence.error &&
			!built.manifestOverflow &&
			!evidence.limitations.some((limitation) => limitation.blocksSkip),
		mandatoryReview: config.policy.mandatoryReview ?? false,
	};

	onProgress?.(`asking ${config.judge.provider}/${config.judge.model}`);
	let judgment: Judgment | undefined;
	let plan: ReviewPlan;
	try {
		judgment = await askJudge(ctx.modelRegistry, config, built, catalog.options, signal);
		plan = composePlan({
			judgment,
			fingerprint: built.fingerprint,
			config,
			candidates,
			available,
			catalog: catalog.options,
			gates,
			evidence: planEvidence,
			summary,
		});
	} catch (error) {
		if (!(error instanceof JudgeError)) throw error;
		// An abort is a cancellation, not a judge failure. Fail-open exists for an
		// unreachable judge; composing a plan from a user's Esc and writing it to
		// the session as an audited verdict is the fabrication this tool forbids.
		if (error.failure === "aborted") throw error;
		plan = failOpenPlan({
			fingerprint: built.fingerprint,
			config,
			candidates,
			available,
			catalog: catalog.options,
			gates,
			evidence: planEvidence,
			summary,
			reason: error.message,
		});
	}

	const entry: TriageRun = {
		plan,
		...(judgment ? { judgment } : {}),
		...(built.fingerprint ? { fingerprint: built.fingerprint } : {}),
		catalog,
		evidence: {
			target: evidence.target,
			files: evidence.files.slice(0, 40),
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
		else if (token === "--baseline") params.baseline = unquote(tokens[++i]);
		else if (token.startsWith("--baseline=")) params.baseline = token.slice("--baseline=".length);
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
	} else if (mode === "task") {
		params.target = "task";
		// An explicit --baseline flag outranks the positional ref.
		if (positional[1] && params.baseline === undefined) params.baseline = positional[1];
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
			"review, or neither — and with which profile (capability band + thinking level). Gathers the git diff " +
			"as evidence and asks a calibrated decision model (Jev) for the judgement; code applies the skip gate " +
			"and resolves the profile to a model. Returns a plan; it does not launch anything. Use it before " +
			"committing or opening a PR when you are unsure how much independent review the change warrants.",
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
						"What to inspect: 'uncommitted' (default), 'branch' (needs base), 'commit' (needs ref), 'task' (needs a baseline ref — diffs against it, so pre-existing dirty work is not attributed to the task), or 'none' to judge from the summary alone. Supplying a baseline implies the task scope",
				}),
			),
			base: Type.Optional(Type.String({ description: "Base branch for target='branch' (default 'dev')" })),
			ref: Type.Optional(Type.String({ description: "Commit sha for target='commit'" })),
			baseline: Type.Optional(
				Type.String({
					description:
						"Baseline ref for target='task': the ref captured (or configured) before the task began; falls back to the configured taskBaselineRef. Supplying it implies the task scope",
				}),
			),
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
