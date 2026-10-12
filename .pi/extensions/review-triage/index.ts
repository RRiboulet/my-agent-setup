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
import {
	collectArtifacts,
	collectHarnessContext,
	collectValidations,
	type CallerArtifact,
	type ExistingValidationResult,
	type HarnessContextInput,
} from "./collectors.ts";
import { askJudge, JudgeError, type Judgment } from "./judge.ts";
import {
	composePlan,
	disabledPlan,
	failOpenPlan,
	resolveCandidates,
	type AvailableModel,
	type ReviewPlan,
} from "./compose.ts";
import { buildDossier, RISK_RULES_VERSION, type EvidenceItem } from "./dossier.ts";
import type { PolicyGates } from "./policy.ts";
import { formatPlan } from "./format.ts";
import { readFileSync } from "node:fs";
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
	/** Inline JSON context (the tool path): `{ artifacts, validations, harness }`. */
	context?: string;
	/** Path to a JSON context file (the `/triage --context <path>` path). */
	contextPath?: string;
}

/** The collector inputs a context payload resolves to, plus what went wrong. */
interface ResolvedContext {
	artifacts?: CallerArtifact[];
	validations?: ExistingValidationResult[];
	harness?: HarnessContextInput;
	warnings: string[];
}

/**
 * Longest context payload accepted, in characters. Beyond this the cost of
 * shaping, masking and budgeting it outweighs any evidence it could carry.
 */
export const MAX_CONTEXT_CHARS = 64_000;

/**
 * Resolve the optional JSON context the tool (inline) or the command (a file)
 * supplies. The shape is `{ artifacts, validations, harness }`; the collectors
 * do the field-level guarding, so this insists only on an object. A missing,
 * unreadable, oversized or malformed source becomes a warning that travels into
 * the dossier's limitations rather than a thrown error.
 */
export function resolveContext(params: TriageParams): ResolvedContext {
	const label = params.contextPath ? `--context ${params.contextPath}` : "the context argument";
	let raw: string | undefined;
	if (params.contextPath) {
		try {
			raw = readFileSync(params.contextPath, "utf8");
		} catch (error) {
			return { warnings: [`${label} could not be read (${(error as Error).message}); it was ignored`] };
		}
	} else if (params.context) {
		raw = params.context;
	} else {
		return { warnings: [] };
	}
	if (raw.length > MAX_CONTEXT_CHARS) {
		return {
			warnings: [`${label} is ${raw.length} characters, over the ${MAX_CONTEXT_CHARS} limit; it was ignored`],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { warnings: [`${label} is not valid JSON (${(error as Error).message}); it was ignored`] };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { warnings: [`${label} must be a JSON object; it was ignored`] };
	}
	const record = parsed as Record<string, unknown>;
	return {
		...(record.artifacts !== undefined ? { artifacts: record.artifacts as CallerArtifact[] } : {}),
		...(record.validations !== undefined
			? { validations: record.validations as ExistingValidationResult[] }
			: {}),
		...(record.harness !== undefined ? { harness: record.harness as HarnessContextInput } : {}),
		warnings: [],
	};
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
	if (params.target === "task" || params.baseline) {
		// The task scope measures the worktree against the baseline ref, so
		// work that predates the task stays out of the evidence. A supplied
		// baseline always implies this scope, whatever target was also named —
		// including `none`. The caller asked for baseline-scoped evidence and a
		// baseline is never silently ignored. Neither supplied nor configured
		// leaves the scope without a snapshot to measure from, which the
		// collector reports as an error.
		const baseline = params.baseline?.trim() || taskBaselineRef?.trim();
		return { kind: "task", ...(baseline ? { baselineRef: baseline } : {}) };
	}
	if (params.target === "none") return { kind: "none" };
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
			plan: disabledPlan({ files: 0, added: 0, removed: 0, signals: [] }, config.policy),
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

	// The raw collector's summary feeds the dossier, where it is masked.
	const summary = evidence.summary || params.summary;

	// The dossier is the single, fingerprinted document Jev judges. It is built
	// from the collected evidence items plus the caller-supplied context, so the
	// budget and the trim live here rather than in a second state serialization.
	// The fingerprint identifies the exact dossier judged — evidence, task,
	// catalog and budget — so a change re-triaged after a model appears or
	// disappears is honestly a different judgement, not a silently stale one.
	// One snapshot identity is used for both the evidence items and the scope,
	// so the two cannot default differently and hash against different baselines.
	const snapshot = evidence.baseline ?? evidence.ref ?? evidence.base ?? target.kind;
	// The thin collectors measure nothing: they shape what the caller already
	// holds into evidence items. Artifacts cover changes git cannot see,
	// validations consume results a check already produced, and the harness
	// context carries the task identity. None of them runs a check or reads the
	// repository; only a command-supplied context file is read, by the resolver.
	const resolved = resolveContext(params);
	const harness = collectHarnessContext(resolved.harness ?? {});
	const validationItems = collectValidations(resolved.validations ?? [], { now: Date.now() });
	const items: EvidenceItem[] = [
		...toEvidenceItems(evidence, snapshot),
		...collectArtifacts(resolved.artifacts ?? [], { baseline: snapshot }),
		...harness.items,
		...validationItems,
	];
	// Freshness is bucketed against the observation time, so a `ranAt` change
	// inside one bucket does not change the fingerprint; crossing the fresh
	// window does, because that is a real change in what Jev sees. An empty
	// validation section must not read as "everything passed", so say whether
	// results were supplied at all — anything supplied but dropped carries its
	// own collector limitation, so the absence note stays out of the way.
	const suppliedValidations = Array.isArray(resolved.validations) && resolved.validations.length > 0;
	const limitations = [
		...resolved.warnings,
		...(config.redactionNotes ?? []),
		...(suppliedValidations ? [] : ["no validation results were supplied for this run"]),
	];
	const built = buildDossier({
		items,
		task: {
			summary,
			...(harness.task.objective ? { objective: harness.task.objective } : {}),
			...(harness.task.acceptance.length > 0 ? { acceptance: harness.task.acceptance } : {}),
			...(harness.task.identity ? { identity: harness.task.identity } : {}),
		},
		scope: {
			target: target.kind,
			...(target.base ? { base: target.base } : {}),
			...(target.ref ? { ref: target.ref } : {}),
			snapshot,
		},
		catalog: catalog.options.map((option) => option.key),
		supplementary: [...(params.notes ?? []), ...harness.supplementary],
		limitations,
		redaction: config.redaction,
		versions: { riskRules: RISK_RULES_VERSION },
		budgetChars: config.stateChars,
	});

	// The plan and the session entry publish the dossier's view, not the raw
	// collector's: a path or pattern the owner redacted must not reappear in the
	// summary just because the dossier withheld it. Churn counts are aggregates,
	// so they stay the raw totals.
	const planEvidence = {
		files: evidence.files.length,
		added: evidence.added,
		removed: evidence.removed,
		signals: built.dossier.riskSignals.map((risk) => risk.signal),
	};
	// `buildTask` embeds the summary; use the masked one, never the raw text.
	const maskedSummary = built.dossier.task.summary;

	// What the plan publishes about the task and scope it judged. The dossier's
	// exclusions (trims and redactions) are limitations too, so they travel with
	// them rather than staying only inside the hashed document.
	const context = {
		task: built.dossier.task,
		scope: built.dossier.scope,
		limitations: [...new Set([...built.dossier.limitations, ...built.dossier.exclusions])],
		versions: built.dossier.versions,
	};

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
		budgetTrimmed: built.budgetTrimmed,
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
			context,
			config,
			candidates,
			available,
			catalog: catalog.options,
			gates,
			evidence: planEvidence,
			summary: maskedSummary,
		});
	} catch (error) {
		if (!(error instanceof JudgeError)) throw error;
		// An abort is a cancellation, not a judge failure. Fail-open exists for an
		// unreachable judge; composing a plan from a user's Esc and writing it to
		// the session as an audited verdict is the fabrication this tool forbids.
		if (error.failure === "aborted") throw error;
		plan = failOpenPlan({
			fingerprint: built.fingerprint,
			context,
			config,
			candidates,
			available,
			catalog: catalog.options,
			gates,
			evidence: planEvidence,
			summary: maskedSummary,
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
			// The dossier's post-redaction manifest, so a withheld path is not
			// recorded here either.
			files: built.dossier.manifest.entries.map((manifestEntry) => manifestEntry.path).slice(0, 40),
			added: evidence.added,
			removed: evidence.removed,
			signals: planEvidence.signals,
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

/**
 * Parse `/triage [uncommitted|branch <name>|commit <sha>] [--summary "..."]
 * [--note "..."] [--context <path>]`. `--context` names a JSON file
 * (`{ artifacts, validations, harness }`) carrying the thin collectors' inputs.
 */
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
		else if (token === "--context") params.contextPath = unquote(tokens[++i]) ?? "";
		else if (token.startsWith("--context=")) params.contextPath = token.slice("--context=".length);
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

function registerTriageTool(pi: ExtensionAPI) {
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
			context: Type.Optional(
				Type.String({
					description:
						"Optional JSON for evidence git cannot see: { artifacts: [{ path, before?, after?, added?, removed?, status? }], validations: [{ check, outcome?, provenance?, ranAt?, snapshot?, detail? }], harness: { objective?, acceptanceCriteria?, identity?, recordedEdits?, toolResults?, unresolvedIssues? } }. Validation results are consumed, never run; an unrecognised outcome becomes 'unknown', never 'passed'.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Review triage: consulting the judge…" }] });
			// Build from the declared fields only, so an undeclared key (such as a
			// smuggled `contextPath`) cannot reach the pipeline.
			const toolParams: TriageParams = {
				summary: params.summary,
				...(params.target ? { target: params.target } : {}),
				...(params.base ? { base: params.base } : {}),
				...(params.ref ? { ref: params.ref } : {}),
				...(params.baseline ? { baseline: params.baseline } : {}),
				...(params.notes ? { notes: params.notes } : {}),
				...(params.cwd ? { cwd: params.cwd } : {}),
				...(params.context ? { context: params.context } : {}),
			};
			const run = await runTriage(pi, ctx, toolParams, {
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
}

export default function (pi: ExtensionAPI) {
	// The tool is recommendation-only, but its description still rides on every
	// request's prompt, so `tool: false` leaves `/triage` as the only way in and
	// a disabled extension registers nothing that costs prompt weight.
	// Registration is a load-time act, so the config is read once here; the
	// per-call read that drives the run happens in `runTriage`.
	const registration = loadConfig({ warn: () => {} });
	if (registration.enabled && registration.tool) registerTriageTool(pi);

	pi.registerCommand("triage", {
		description:
			"Decide whether the current change needs independent review (/triage [branch <b>|commit <sha>|task <ref>|none] [--summary \"...\"] [--context <file>])",
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
	resolveContext,
	resolveTarget,
};

export type { Candidate, TriageConfig };
