/**
 * The Jev judge.
 *
 * One batched request carries every question this tool asks: two `noul`
 * (yes/no) gates, two `score` strength readings, and four `choice` picks — each
 * model choice asked twice, forward and reversed, because Jev leans toward the
 * first option it is offered and averaging the two orders cancels that lean.
 * Jev returns calibrated probabilities; it never returns a model or a tier,
 * and it never sees the thresholds. This file only turns answers into typed
 * numbers and refuses to guess when an answer is missing.
 *
 * The client itself is pi's, reached through `ctx.modelRegistry.classify()`.
 * That means no second API client, no key handling here, and the call's usage
 * lands in the session cost like any other classifier call. OpenRouter's
 * `typesafe/jev-1.13` is a classifier model in pi's catalogue, so the same
 * credential the user already has is what authenticates the judge.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ClassifierAnswer, ClassifierContext, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";
import type { Candidate, TriageConfig } from "./config.ts";
import { STRENGTH_SCALE } from "./config.ts";
import type { ChangeEvidence } from "./evidence.ts";

export const QUESTION_IDS = {
	adversarialNeeded: "adversarial_needed",
	complexityNeeded: "complexity_needed",
	adversarialStrength: "adversarial_strength",
	complexityStrength: "complexity_strength",
	adversarialModel: "adversarial_model",
	adversarialModelReversed: "adversarial_model_reversed",
	complexityModel: "complexity_model",
	complexityModelReversed: "complexity_model_reversed",
} as const;

export type JudgeFailure = "unavailable" | "timeout" | "error" | "malformed";

export class JudgeError extends Error {
	readonly failure: JudgeFailure;

	constructor(message: string, failure: JudgeFailure) {
		super(message);
		this.name = "JudgeError";
		this.failure = failure;
	}
}

export interface TrackJudgment {
	needed: boolean;
	/** Jev's probability that the review is warranted (0..1). */
	neededProbability: number;
	/** Probability-weighted 0..3 position on the strength scale. */
	strength: number;
	strengthConfidence: number;
	/** Candidate key Jev picked, after forward/reverse averaging. */
	choice: string;
	choiceConfidence: number;
	choiceProbabilities: Record<string, number>;
}

export interface Judgment {
	adversarial: TrackJudgment;
	complexity: TrackJudgment;
	/** Judge model that answered, as `provider/model`. */
	judge: string;
	latencyMs: number;
	usage?: { inputTokens: number; outputTokens: number; cost?: number };
}

/** `provider/model`, the same key shape the config's fallback chains use. */
export function candidateKey(candidate: Pick<Candidate, "provider" | "model">): string {
	return `${candidate.provider}/${candidate.model}`;
}

/**
 * Serialise the evidence for Jev, trimming the diff last because it is the
 * least information-dense part of the state and the most expensive per byte.
 */
export function buildState(evidence: ChangeEvidence, stateChars: number): Record<string, unknown> {
	const change: Record<string, unknown> = {
		summary: evidence.summary,
		target: evidence.target,
		files_changed: evidence.files.length,
		lines_added: evidence.added,
		lines_removed: evidence.removed,
		paths: evidence.files.slice(0, 40),
		new_files: evidence.newFiles.slice(0, 20),
		deleted_files: evidence.deletedFiles.slice(0, 20),
		observed_risk_signals: evidence.signals,
		author_notes: evidence.notes,
		diff_truncated: evidence.truncated,
	};
	if (evidence.base) change.base = evidence.base;
	if (evidence.ref) change.ref = evidence.ref;
	if (evidence.error) change.inspection_error = evidence.error;
	if (evidence.patchExcerpt) change.diff_excerpt = evidence.patchExcerpt;

	const state: Record<string, unknown> = { change };
	const serialized = JSON.stringify(state);
	if (serialized.length <= stateChars) return state;

	// Drop the diff, then shrink the path list, then give up and truncate the
	// summary — in increasing order of how much the judgement needs the field.
	delete change.diff_excerpt;
	change.diff_truncated = true;
	if (JSON.stringify(state).length <= stateChars) return state;

	change.paths = evidence.files.slice(0, 12);
	if (JSON.stringify(state).length <= stateChars) return state;

	const summary = evidence.summary.slice(0, Math.max(200, stateChars - 800));
	change.summary = `${summary}…`;
	return state;
}

function describeCandidate(candidate: Candidate): string {
	return candidate.notFor
		? `${candidate.description} Not for: ${candidate.notFor}.`
		: candidate.description;
}

/**
 * Build the whole question batch. Exported so the prompt text — which is the
 * part that actually changes Jev's answer — is reviewable and snapshot-testable
 * without calling the model.
 */
export function buildQuestions(
	config: TriageConfig,
	candidates: readonly Candidate[],
): Record<string, ClassifierQuestion> {
	const criteria: Record<string, string> = {};
	for (const candidate of candidates) criteria[candidateKey(candidate)] = describeCandidate(candidate);
	const reversed = Object.fromEntries(Object.entries(criteria).reverse());

	const modelChoice = (instructions: string, order: Record<string, string>) => ({
		type: "choice" as const,
		instructions,
		criteria: order,
	});

	return {
		[QUESTION_IDS.adversarialNeeded]: {
			type: "bool",
			instructions:
				"Does this change need an independent adversarial review — a reviewer other than the author, " +
				"trying to falsify it by finding correctness bugs, security holes and unhandled edge cases? " +
				"Answer true when the change's blast radius, risk or subtlety makes a hostile second pass worth " +
				"its cost, and false for routine, well-covered work.",
			criteria: {
				true: "Independent adversarial review is warranted",
				false: "Routine, low-risk or well-covered change",
			},
		},
		[QUESTION_IDS.complexityNeeded]: {
			type: "bool",
			instructions:
				"Does this change need a dedicated complexity and design review — asking whether it is " +
				"over-engineered, whether a simpler design exists, and whether the new structure fits the " +
				"codebase? Answer true when the change adds structure, abstractions or indirection that " +
				"someone should argue about, and false when it is a direct, local edit.",
			criteria: {
				true: "Design or complexity scrutiny is warranted",
				false: "Direct, local change with no structural concern",
			},
		},
		[QUESTION_IDS.adversarialStrength]: {
			type: "score",
			instructions:
				"How hard should an adversarial review push on this change? Judge the cost of a missed defect " +
				"against the cost of the review itself.",
			criteria: [...STRENGTH_SCALE],
		},
		[QUESTION_IDS.complexityStrength]: {
			type: "score",
			instructions:
				"How much complexity scrutiny does this change deserve? Judge how much design is on the table, " +
				"not how risky the change is.",
			criteria: [
				"None: no design scrutiny needed",
				"Light: a glance at naming and structure",
				"Standard: review the abstractions and weigh alternatives",
				"Deep: challenge the whole design and propose a simpler one",
			],
		},
		[QUESTION_IDS.adversarialModel]: modelChoice(
			"Which candidate model is appropriate to run the adversarial review? Weigh its reasoning " +
				"strength and cost against the strength this change deserves, and pick the cheapest model " +
				"that would still mount a convincing hostile review.",
			criteria,
		),
		[QUESTION_IDS.adversarialModelReversed]: modelChoice(
			"Which candidate model is appropriate to run the adversarial review? Weigh its reasoning " +
				"strength and cost against the strength this change deserves, and pick the cheapest model " +
				"that would still mount a convincing hostile review.",
			reversed,
		),
		[QUESTION_IDS.complexityModel]: modelChoice(
			"Which candidate model is appropriate to run the complexity and design review? Weigh its " +
				"reasoning strength and cost against how much design judgement this change needs.",
			criteria,
		),
		[QUESTION_IDS.complexityModelReversed]: modelChoice(
			"Which candidate model is appropriate to run the complexity and design review? Weigh its " +
				"reasoning strength and cost against how much design judgement this change needs.",
			reversed,
		),
	};
}

function boolAnswer(answer: ClassifierAnswer | undefined, id: string): number {
	if (!answer || answer.type !== "bool") throw new JudgeError(`judge returned no bool for ${id}`, "malformed");
	return answer.probability;
}

function scoreAnswer(answer: ClassifierAnswer | undefined, id: string): { score: number; confidence: number } {
	if (!answer || answer.type !== "score") throw new JudgeError(`judge returned no score for ${id}`, "malformed");
	return { score: answer.score, confidence: answer.confidence };
}

function choiceAnswer(
	answer: ClassifierAnswer | undefined,
	id: string,
): { probabilities: Record<string, number>; confidence: number } {
	if (!answer || answer.type !== "choice") throw new JudgeError(`judge returned no choice for ${id}`, "malformed");
	return { probabilities: answer.probabilities, confidence: answer.confidence };
}

/**
 * Average the forward and reversed Choice distributions. Reversing the criteria
 * order is the documented fix for Jev's first-option bias, and averaging the two
 * probability vectors keeps every candidate's mass rather than discarding the
 * loser — the caller can still see how close the pick was.
 */
export function averageChoice(
	reversed: boolean,
	forward: { probabilities: Record<string, number>; confidence: number },
	reverse: { probabilities: Record<string, number>; confidence: number } | undefined,
): { choice: string; confidence: number; probabilities: Record<string, number> } {
	const keys = new Set([...Object.keys(forward.probabilities), ...Object.keys(reverse?.probabilities ?? {})]);
	const probabilities: Record<string, number> = {};
	let total = 0;
	for (const key of keys) {
		const value = reverse
			? ((forward.probabilities[key] ?? 0) + (reverse.probabilities[key] ?? 0)) / 2
			: (forward.probabilities[key] ?? 0);
		probabilities[key] = value;
		total += value;
	}
	if (total > 0) for (const key of keys) probabilities[key] = (probabilities[key] ?? 0) / total;

	let choice = "";
	let best = -1;
	for (const [key, value] of Object.entries(probabilities)) {
		if (value > best) {
			best = value;
			choice = key;
		}
	}
	// The averaged argmax IS the confidence: if the two orders disagree, the
	// winners share mass and the number falls, which is exactly the signal the
	// caller needs to prefer its fallback chain.
	return { choice, confidence: best < 0 ? 0 : best, probabilities };
}

function parseTrack(
	answers: Record<string, ClassifierAnswer>,
	config: TriageConfig,
	track: "adversarial" | "complexity",
	neededId: string,
	strengthId: string,
	modelId: string,
	modelReversedId: string,
): TrackJudgment {
	const neededProbability = boolAnswer(answers[neededId], neededId);
	const strength = scoreAnswer(answers[strengthId], strengthId);
	const forward = choiceAnswer(answers[modelId], modelId);
	const reverse = config.reverseChoice
		? choiceAnswer(answers[modelReversedId], modelReversedId)
		: undefined;
	const choice = averageChoice(config.reverseChoice, forward, reverse);
	return {
		needed: neededProbability >= config.tracks[track].threshold,
		neededProbability,
		strength: strength.score,
		strengthConfidence: strength.confidence,
		choice: choice.choice,
		choiceConfidence: choice.confidence,
		choiceProbabilities: choice.probabilities,
	};
}

/** Turn a classifier result into the typed numbers the composer consumes. */
export function parseJudgment(
	result: ClassifierResult,
	config: TriageConfig,
	latencyMs: number,
): Judgment {
	const answers = result.answers as Record<string, ClassifierAnswer>;
	return {
		adversarial: parseTrack(
			answers,
			config,
			"adversarial",
			QUESTION_IDS.adversarialNeeded,
			QUESTION_IDS.adversarialStrength,
			QUESTION_IDS.adversarialModel,
			QUESTION_IDS.adversarialModelReversed,
		),
		complexity: parseTrack(
			answers,
			config,
			"complexity",
			QUESTION_IDS.complexityNeeded,
			QUESTION_IDS.complexityStrength,
			QUESTION_IDS.complexityModel,
			QUESTION_IDS.complexityModelReversed,
		),
		judge: `${result.provider}/${result.model}`,
		latencyMs,
		...(result.usage
			? {
					usage: {
						inputTokens: result.usage.inputTokens ?? 0,
						outputTokens: result.usage.outputTokens ?? 0,
						...(result.usage.cost ? { cost: result.usage.cost.total } : {}),
					},
				}
			: {}),
	};
}

/**
 * Ask Jev. A missing classifier model or an errored result becomes a
 * `JudgeError`, never a silent zero — the caller decides whether to fail open,
 * and a fabricated judgement is the one outcome a review gate must not have.
 */
export async function askJudge(
	registry: Pick<ModelRegistry, "findOfType" | "classify">,
	config: TriageConfig,
	state: Record<string, unknown>,
	candidates: readonly Candidate[],
	signal?: AbortSignal,
): Promise<Judgment> {
	const model = registry.findOfType("classifier", config.judge.provider, config.judge.model);
	if (!model) {
		throw new JudgeError(
			`classifier model ${config.judge.provider}/${config.judge.model} is not in pi's catalogue`,
			"unavailable",
		);
	}

	const questions = buildQuestions(config, candidates);
	const context: ClassifierContext = { state, questions };
	const started = Date.now();
	const result = await registry.classify(model, context, { signal, timeoutMs: config.judge.timeoutMs });
	const latencyMs = Date.now() - started;

	if (result.stopReason === "aborted" || signal?.aborted) {
		throw new JudgeError("judge request aborted", "timeout");
	}
	if (result.stopReason !== "stop") {
		throw new JudgeError(result.errorMessage ?? `judge stopped with ${result.stopReason}`, "error");
	}
	return parseJudgment(result, config, latencyMs);
}

export const __test__ = {
	boolAnswer,
	scoreAnswer,
	choiceAnswer,
	parseTrack,
};
