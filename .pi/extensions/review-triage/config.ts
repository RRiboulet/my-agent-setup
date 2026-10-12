/**
 * Policy for the review-triage extension.
 *
 * Judgment is Jev's; policy is ours. This file holds only the things a human
 * should decide: which judge model to ask, which review models are allowed and
 * how they rank, the probability threshold at which a review is worth spawning,
 * and the fallback chains. No signal weights live here — Jev reads the evidence
 * and decides, and the deterministic table that used to do that is gone.
 *
 * Resolution order, later wins:
 *   1. DEFAULTS
 *   2. ~/.pi/agent/review-triage.json
 *   3. environment (PI_REVIEW_TRIAGE_*)
 *
 * The file is optional and every field degrades to the default, so a machine
 * that never writes one still runs. A malformed file is ignored with one warn
 * rather than throwing into a tool call.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_BASENAME = "review-triage.json";

export type TrackName = "adversarial" | "complexity";
export const TRACKS: readonly TrackName[] = ["adversarial", "complexity"];

/**
 * How much capability a model brings, judged by a human — deliberately NOT
 * price. Two models can share a price and differ in strength (this catalogue's
 * `deepseek-v4.1-flash` and `glm-5.3-flash` both cost 0.15), and a free model
 * can be the strongest one offered (`step-5-preview-free`). Price is therefore
 * useless as a capability signal here; the tier is an explicit judgement.
 * It is the rank the review floor is enforced against: the stronger the review
 * a change deserves, the higher the tier the chosen model must have.
 */
export type CapabilityTier = "low" | "medium" | "high";
export const CAPABILITY_TIERS: readonly CapabilityTier[] = ["low", "medium", "high"];
export const CAPABILITY_RANK: Record<CapabilityTier, number> = { low: 0, medium: 1, high: 2 };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
export const THINKING_RANK: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

/** One model Jev may choose, described in the words Jev actually reads. */
export interface Candidate {
	provider: string;
	model: string;
	/** Capability rank, assigned by a human — see {@link CapabilityTier}. */
	tier: CapabilityTier;
	/** What this model is good at — the Choice question's criteria text. */
	description: string;
	/** What belongs to a neighbour instead, to sharpen the Choice. */
	notFor?: string;
}

/** One rung of a track's strength scale, keyed by the score Jev returns. */
export interface Tier {
	/** Shown in the plan, e.g. "light" / "standard" / "deep". */
	name: string;
	/** Inclusive lower bound on Jev's probability-weighted score (0..3). */
	minScore: number;
	thinking: ThinkingLevel;
	/** The chosen model must sit at or above this rank. */
	minTier: CapabilityTier;
}

export interface TrackConfig {
	/** noul probability at or above which the review is recommended. */
	threshold: number;
	/** Ascending by `minScore`; the last rung whose floor the score clears wins. */
	tiers: Tier[];
	/** "provider/model" keys tried in order when the Choice is unusable. */
	fallbackChain: string[];
}

export interface JudgeConfig {
	provider: string;
	model: string;
	timeoutMs: number;
	/** Below this Choice confidence, the pick is replaced by the fallback chain. */
	minConfidence: number;
}

export interface TriageConfig {
	enabled: boolean;
	judge: JudgeConfig;
	/** Empty means "synthesise from the models this session can actually use". */
	candidates: Candidate[];
	tracks: Record<TrackName, TrackConfig>;
	/** Ask each Choice twice, reversed, to cancel Jev's first-option bias. */
	reverseChoice: boolean;
	/** What to do when Jev is unreachable: review conservatively, or skip. */
	onJudgeError: "conservative" | "skip";
	/** Cap on the evidence JSON sent to Jev, in characters. */
	stateChars: number;
	/** Optional dotenv file loaded for OPENROUTER_API_KEY et al. before judging. */
	envFile: string;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), CONFIG_BASENAME);
}

/** Jev's strength scale, in the four words the question hands to it. */
const STRENGTH_CRITERIA = [
	"None: no review is warranted",
	"Light: a quick second read for obvious mistakes",
	"Standard: a full correctness and edge-case pass",
	"Deep: hostile, exhaustive, security-focused falsification",
] as const;

export const STRENGTH_SCALE = STRENGTH_CRITERIA;

export const DEFAULT_TRACKS: Record<TrackName, TrackConfig> = {
	adversarial: {
		threshold: 0.5,
		tiers: [
			{ name: "light", minScore: 0, thinking: "low", minTier: "low" },
			{ name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
			{ name: "deep", minScore: 2.5, thinking: "high", minTier: "high" },
		],
		fallbackChain: [],
	},
	complexity: {
		threshold: 0.5,
		tiers: [
			{ name: "light", minScore: 0, thinking: "low", minTier: "low" },
			{ name: "standard", minScore: 1.5, thinking: "medium", minTier: "medium" },
			{ name: "deep", minScore: 2.5, thinking: "high", minTier: "high" },
		],
		fallbackChain: [],
	},
};

export const DEFAULT_CONFIG: TriageConfig = {
	enabled: true,
	judge: {
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		timeoutMs: 8_000,
		minConfidence: 0.35,
	},
	candidates: [],
	tracks: DEFAULT_TRACKS,
	reverseChoice: true,
	onJudgeError: "conservative",
	stateChars: 12_000,
	envFile: "",
};

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCandidate(value: unknown): Candidate | undefined {
	if (!isObject(value)) return undefined;
	const provider = str(value.provider);
	const model = str(value.model);
	const description = str(value.description);
	if (!provider || !model || !description) return undefined;
	const tier = CAPABILITY_TIERS.includes(value.tier as CapabilityTier)
		? (value.tier as CapabilityTier)
		: "medium";
	const notFor = str(value.notFor);
	return { provider, model, tier, description, ...(notFor ? { notFor } : {}) };
}

function parseTier(value: unknown): Tier | undefined {
	if (!isObject(value)) return undefined;
	const name = str(value.name);
	if (!name) return undefined;
	const thinking = THINKING_LEVELS.includes(value.thinking as ThinkingLevel)
		? (value.thinking as ThinkingLevel)
		: "medium";
	const minTier = CAPABILITY_TIERS.includes(value.minTier as CapabilityTier) ? (value.minTier as CapabilityTier) : "low";
	const minScore =
		typeof value.minScore === "number" && Number.isFinite(value.minScore)
			? Math.min(3, Math.max(0, value.minScore))
			: 0;
	return { name, minScore, thinking, minTier };
}

/** A track override may replace any subset of `threshold` / `tiers` / `fallbackChain`. */
function mergeTrack(base: TrackConfig, value: unknown): TrackConfig {
	if (!isObject(value)) return base;
	const merged: TrackConfig = { ...base };
	if (typeof value.threshold === "number") merged.threshold = num(value.threshold, base.threshold, 0, 1);
	if (Array.isArray(value.tiers)) {
		const tiers = value.tiers.map(parseTier).filter((tier): tier is Tier => tier !== undefined);
		if (tiers.length > 0) merged.tiers = tiers.sort((a, b) => a.minScore - b.minScore);
	}
	if (Array.isArray(value.fallbackChain)) {
		const chain = value.fallbackChain.map(str).filter((key): key is string => key !== undefined);
		merged.fallbackChain = chain;
	}
	return merged;
}

/**
 * Read the config file. A missing file is the normal first-run state and stays
 * silent; a file that exists but cannot be parsed is a policy the owner meant
 * to apply and did not, so it warns once rather than vanishing.
 */
export function readConfigFile(path: string, warn?: (message: string) => void): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) {
			warn?.(`review-triage: ignoring ${path}: expected a JSON object`);
			return {};
		}
		return parsed;
	} catch (error) {
		warn?.(`review-triage: ignoring malformed ${path}: ${(error as Error).message}`);
		return {};
	}
}

export interface LoadConfigOptions {
	env?: NodeJS.ProcessEnv;
	path?: string;
	/** Injected by tests so the loader itself is covered without touching $HOME. */
	warn?: (message: string) => void;
}

export function loadConfig(options: LoadConfigOptions = {}): TriageConfig {
	const env = options.env ?? process.env;
	const path = options.path ?? configPath(env);
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const file = readConfigFile(path, warn);

	const config: TriageConfig = {
		...DEFAULT_CONFIG,
		judge: { ...DEFAULT_CONFIG.judge },
		tracks: {
			adversarial: { ...DEFAULT_TRACKS.adversarial, tiers: [...DEFAULT_TRACKS.adversarial.tiers] },
			complexity: { ...DEFAULT_TRACKS.complexity, tiers: [...DEFAULT_TRACKS.complexity.tiers] },
		},
		candidates: [],
		envFile: DEFAULT_CONFIG.envFile,
	};

	if (Object.keys(file).length > 0) {
		if ("enabled" in file) config.enabled = bool(file.enabled, config.enabled);

		if (isObject(file.judge)) {
			config.judge.provider = str(file.judge.provider) ?? config.judge.provider;
			config.judge.model = str(file.judge.model) ?? config.judge.model;
			config.judge.timeoutMs = Math.round(num(file.judge.timeoutMs, config.judge.timeoutMs, 500, 60_000));
			config.judge.minConfidence = num(file.judge.minConfidence, config.judge.minConfidence, 0, 1);
		}

		if (Array.isArray(file.candidates)) {
			config.candidates = file.candidates
				.map(parseCandidate)
				.filter((candidate): candidate is Candidate => candidate !== undefined);
		}

		if (isObject(file.tracks)) {
			config.tracks.adversarial = mergeTrack(config.tracks.adversarial, file.tracks.adversarial);
			config.tracks.complexity = mergeTrack(config.tracks.complexity, file.tracks.complexity);
		}

		if ("reverseChoice" in file) config.reverseChoice = bool(file.reverseChoice, config.reverseChoice);
		if (file.onJudgeError === "skip" || file.onJudgeError === "conservative") {
			config.onJudgeError = file.onJudgeError;
		}
		config.stateChars = Math.round(num(file.stateChars, config.stateChars, 1_000, 60_000));
		config.envFile = str(file.envFile) ?? config.envFile;
	}

	// Environment wins so a one-off run can be redirected without editing files.
	const envProvider = str(env.PI_REVIEW_TRIAGE_JUDGE_PROVIDER);
	const envModel = str(env.PI_REVIEW_TRIAGE_JUDGE_MODEL);
	if (envProvider) config.judge.provider = envProvider;
	if (envModel) config.judge.model = envModel;
	if (str(env.PI_REVIEW_TRIAGE_OFF)) config.enabled = false;
	if (str(env.PI_REVIEW_TRIAGE_ENABLED)) config.enabled = true;
	if (str(env.PI_REVIEW_TRIAGE_ON_JUDGE_ERROR) === "skip") config.onJudgeError = "skip";

	// mergeTrack already refuses an empty tier list and sorts what it accepts;
	// this re-sort keeps a hand-built config object (a test, a caller) honest.
	for (const track of TRACKS) {
		config.tracks[track].tiers.sort((a, b) => a.minScore - b.minScore);
	}

	return config;
}

/**
 * Load `KEY=value` pairs from a dotenv file into the environment, without
 * overwriting anything already set. This is how an OpenRouter key that lives in
 * a `.env` rather than `auth.json` reaches the classifier path.
 */
export function applyDotEnv(env: NodeJS.ProcessEnv, path: string): void {
	if (!path) return;
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return;
	}
	for (const raw of text.split(/\r?\n/u)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (!(key in env)) env[key] = value;
	}
}
