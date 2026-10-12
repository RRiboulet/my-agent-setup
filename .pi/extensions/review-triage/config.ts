/**
 * Policy for the review-triage extension.
 *
 * Judgment is Jev's; policy is ours. This file holds only the things a human
 * should decide: which judge model to ask, which review models are allowed and
 * what they cost, the thinking ladder that turns a capability band into a set
 * of profiles, and the skip threshold. No signal weights live here — Jev reads
 * the evidence and decides, and the deterministic table that used to do that is
 * gone.
 *
 * A **profile** is the unit of routing: a capability band paired with an
 * explicit thinking level, e.g. `medium:max`. The allowed profiles are not
 * hardcoded; {@link generateCatalog} derives them from the configured thinking
 * ladder and prunes any pair the band's model rejects at runtime.
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
 * useless as a capability signal here; the band is an explicit judgement. It is
 * also the key that selects the review model for a profile.
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

/** The "no review" option. It is one choice among the allowed profiles, not a
 * separate yes/no question, so `P(none)` and the profile distribution can never
 * disagree with each other. */
export const PROFILE_NONE = "none";

/**
 * A profile is a capability band plus an explicit thinking level. The key is the
 * string form used everywhere (config, Jev criteria, the plan): `"<band>:<thinking>"`.
 */
export interface Profile {
	key: string;
	band: CapabilityTier;
	thinking: ThinkingLevel;
}

export function profileKey(band: CapabilityTier, thinking: ThinkingLevel): string {
	return `${band}:${thinking}`;
}

/** Parse `"medium:max"` into a {@link Profile}, or `undefined` if malformed. */
export function parseProfile(key: string): Profile | undefined {
	const parts = key.split(":");
	if (parts.length !== 2) return undefined;
	const [band, thinking] = parts as [string, string];
	if (!CAPABILITY_TIERS.includes(band as CapabilityTier)) return undefined;
	if (!THINKING_LEVELS.includes(thinking as ThinkingLevel)) return undefined;
	return { key, band: band as CapabilityTier, thinking: thinking as ThinkingLevel };
}

/** Total order over profiles: band first, then thinking. Used to pick the
 * strongest / weakest entry of a catalog without trusting array order. */
export function profileRank(key: string): number {
	const profile = parseProfile(key);
	if (!profile) return -1;
	return CAPABILITY_RANK[profile.band] * 10 + THINKING_RANK[profile.thinking];
}

/**
 * The configured thinking ladder: for each capability band, the thinking levels
 * worth offering as profiles. It is a preference, not a truth — the runtime
 * `thinkingLevelMap` decides whether a level is actually supported and prunes
 * the pair if it is not. Keeping the ladder here lets the owner say "I never
 * want the cheap band thinking hard" without editing code.
 */
export type ThinkingLadder = Record<CapabilityTier, ThinkingLevel[]>;

/**
 * Defaults chosen from the live catalogue: `glm-5.3` and `glm-5.3-flash`
 * expose `{low, high, max}`, so the medium band's `medium` rung is pruned and
 * the set that survives is the seven allowed pairs plus `none`.
 */
export const DEFAULT_THINKING_LADDER: ThinkingLadder = {
	low: ["low", "medium", "high"],
	medium: ["medium", "high", "max"],
	high: ["high", "max"],
};

/** One model Jev may route a profile to, described in the words Jev reads. */
export interface Candidate {
	provider: string;
	model: string;
	/** Capability rank, assigned by a human — see {@link CapabilityTier}. */
	tier: CapabilityTier;
	/**
	 * Relative cost, as USD per million input tokens (catalogue rate) or an
	 * explicit ordinal. Required because the routing instruction asks Jev to
	 * choose the least costly configuration that suffices, and Jev cannot
	 * minimise a cost it cannot see. `0` means "unstated"; the catalogue rate is
	 * substituted when it is available.
	 */
	cost: number;
	/** What this model is good at — the profile criteria text. */
	description: string;
	/** What belongs to a neighbour instead, to sharpen the Choice. */
	notFor?: string;
}

export interface JudgeConfig {
	provider: string;
	model: string;
	timeoutMs: number;
}

/**
 * The skip gate. `none` is allowed only when `P(none)` is strictly greater than
 * `skipThreshold` AND every other gate in `policy.ts` passes. A high
 * probability never *forces* skip.
 */
export interface PolicyConfig {
	skipThreshold: number;
	/** Conservative profile used when the judge fails or its pick does not resolve. */
	fallbackProfile?: string;
	/** Floor used when no alternative resolves. */
	minimumProfile?: string;
	/** When true, `none` is never allowed: a review is mandatory for both tracks. */
	mandatoryReview?: boolean;
}

export interface TriageConfig {
	enabled: boolean;
	judge: JudgeConfig;
	/** Empty means "synthesise from the models this session can actually use". */
	candidates: Candidate[];
	/** Which thinking levels each band may offer, before the runtime prune. */
	thinkingLadder: ThinkingLadder;
	policy: PolicyConfig;
	/** Ask each Choice twice, reversed, to cancel Jev's first-option bias. */
	reverseChoice: boolean;
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

export const DEFAULT_CONFIG: TriageConfig = {
	enabled: true,
	judge: {
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		timeoutMs: 8_000,
	},
	candidates: [],
	thinkingLadder: DEFAULT_THINKING_LADDER,
	policy: { skipThreshold: 0.9 },
	reverseChoice: true,
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

function parseCandidate(value: unknown, warn?: (message: string) => void): Candidate | undefined {
	if (!isObject(value)) return undefined;
	const provider = str(value.provider);
	const model = str(value.model);
	const description = str(value.description);
	if (!provider || !model || !description) return undefined;
	const tier = CAPABILITY_TIERS.includes(value.tier as CapabilityTier)
		? (value.tier as CapabilityTier)
		: "medium";
	if (value.tier !== undefined && !CAPABILITY_TIERS.includes(value.tier as CapabilityTier)) {
		warn?.(`review-triage: ${provider}/${model} has an unknown tier ${JSON.stringify(value.tier)}; using "medium"`);
	}
	// `cost` is required on the type; an unstated one is `0` ("resolve from the
	// catalogue"), so an older hand-written config keeps working rather than
	// silently losing every candidate.
	const cost =
		typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : 0;
	const notFor = str(value.notFor);
	return { provider, model, tier, cost, description, ...(notFor ? { notFor } : {}) };
}

function parseLadder(value: unknown): ThinkingLadder | undefined {
	if (!isObject(value)) return undefined;
	const ladder: ThinkingLadder = {
		low: [...DEFAULT_THINKING_LADDER.low],
		medium: [...DEFAULT_THINKING_LADDER.medium],
		high: [...DEFAULT_THINKING_LADDER.high],
	};
	let any = false;
	for (const band of CAPABILITY_TIERS) {
		if (!Array.isArray(value[band])) continue;
		const levels = value[band].filter((level): level is ThinkingLevel =>
			THINKING_LEVELS.includes(level as ThinkingLevel),
		);
		// An explicit empty array is honoured: it means "never offer this band".
		ladder[band] = [...new Set(levels)];
		any = true;
	}
	return any ? ladder : undefined;
}

function parsePolicy(value: unknown, base: PolicyConfig): PolicyConfig {
	if (!isObject(value)) return base;
	const merged: PolicyConfig = { ...base };
	if (typeof value.skipThreshold === "number") {
		merged.skipThreshold = num(value.skipThreshold, base.skipThreshold, 0, 1);
	}
	const fallback = str(value.fallbackProfile);
	if (fallback) merged.fallbackProfile = fallback;
	const minimum = str(value.minimumProfile);
	if (minimum) merged.minimumProfile = minimum;
	if (typeof value.mandatoryReview === "boolean") merged.mandatoryReview = value.mandatoryReview;
	return merged;
}

/**
 * A model shape the catalog needs: the runtime thinking map is authoritative
 * for which levels a model actually supports.
 */
export interface CatalogModel {
	provider: string;
	id: string;
	thinkingLevelMap?: Record<string, string | null> | null | undefined;
	cost?: { input: number } | undefined;
}

/** One allowed profile, with the words Jev reads and the band model it maps to. */
export interface ProfileOption extends Profile {
	/** Capability blurb plus thinking level and cost — the Choice criteria text. */
	description: string;
	/** The band's representative model, when one is available. */
	model?: { provider: string; model: string };
	/** Effective cost: the candidate's stated cost, else the catalogue's. */
	cost?: number;
}

export interface ProfileCatalog {
	/** Allowed profiles, weakest first. `none` is implied and never listed here. */
	options: ProfileOption[];
	/** Pairs dropped because the band's model rejects the thinking level. */
	pruned: { key: string; note: string }[];
	/** Audit notes: unverifiable maps, empty bands. */
	notes: string[];
}

type Support = "supported" | "unsupported" | "unknown";

/**
 * Is `thinking` supported by the band's model? A `thinkingLevelMap` is
 * authoritative: a `null` (or missing) entry means the level is unsupported. A
 * model with no map cannot be checked, so the level is kept rather than guessed
 * away.
 */
function levelSupport(thinking: ThinkingLevel, model: CatalogModel | undefined): Support {
	if (!model) return "unknown";
	const map = model.thinkingLevelMap;
	if (!map || typeof map !== "object") return "unknown";
	return map[thinking] !== null && map[thinking] !== undefined ? "supported" : "unsupported";
}

function describeProfile(
	band: CapabilityTier,
	thinking: ThinkingLevel,
	candidate: Candidate | undefined,
	cost: number | undefined,
): string {
	const base = candidate?.description ?? `${band} capability band.`;
	const notFor = candidate?.notFor ? ` Not for: ${candidate.notFor}.` : "";
	const costText =
		cost === undefined
			? " Cost not stated."
			: cost > 0
				? ` Cost ${cost} per million input tokens.`
				: " No cost (free).";
	return `${base}${notFor} Thinking level: ${thinking}.${costText}`;
}

/**
 * Generate the allowed profiles: for each band, every level in the configured
 * ladder, minus any level the band's model marks unsupported at runtime. The
 * prune is recorded, never silent — a dropped rung changes what Jev may choose.
 *
 * When `available` is supplied, bands with no available model are left out
 * entirely, so the catalog only offers profiles this session can actually run.
 */
export function generateCatalog(args: {
	candidates: readonly Candidate[];
	ladder?: ThinkingLadder;
	available?: readonly CatalogModel[];
}): ProfileCatalog {
	const ladder = args.ladder ?? DEFAULT_THINKING_LADDER;
	const available = args.available ?? [];
	const filtering = args.available !== undefined;
	const options: ProfileOption[] = [];
	const pruned: { key: string; note: string }[] = [];
	const notes: string[] = [];

	for (const band of CAPABILITY_TIERS) {
		const bandCandidates = args.candidates.filter((candidate) => candidate.tier === band);
		const modelFor = (candidate: Candidate): CatalogModel | undefined =>
			available.find((model) => model.provider === candidate.provider && model.id === candidate.model);
		// The representative is the candidate this band will actually resolve to:
		// the first available one when availability is being filtered, else the
		// first configured. Pruning against the same model compose resolves keeps
		// an offered profile from being one the chosen model cannot run.
		const representative = filtering
			? bandCandidates.find((candidate) => modelFor(candidate) !== undefined)
			: bandCandidates[0];
		const representativeModel = representative ? modelFor(representative) : undefined;

		if (filtering && !representative) {
			if (bandCandidates.length > 0) {
				notes.push(`no available ${band}-band model; its profiles are not offered`);
			}
			continue;
		}

		for (const thinking of ladder[band] ?? []) {
			const key = profileKey(band, thinking);
			const support = levelSupport(thinking, representativeModel);
			if (support === "unsupported") {
				pruned.push({ key, note: `${band} band marks thinking "${thinking}" unsupported (null in its thinkingLevelMap)` });
				continue;
			}
			if (support === "unknown" && representativeModel) {
				notes.push(`${key}: the ${band}-band model has no runtime thinking map; kept unverified`);
			}
			const cost =
				representative && representative.cost > 0 ? representative.cost : representativeModel?.cost?.input;
			options.push({
				key,
				band,
				thinking,
				description: describeProfile(band, thinking, representative, cost),
				...(representative
					? { model: { provider: representative.provider, model: representative.model } }
					: {}),
				...(typeof cost === "number" ? { cost } : {}),
			});
		}
	}

	// Canonical, weakest-first order so the criteria Jev reads and the plan
	// render are deterministic. Policy ranks profiles itself rather than trusting
	// this order, so a hand-built catalog is still handled correctly.
	options.sort((a, b) => profileRank(a.key) - profileRank(b.key));
	return { options, pruned, notes };
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
		thinkingLadder: {
			low: [...DEFAULT_THINKING_LADDER.low],
			medium: [...DEFAULT_THINKING_LADDER.medium],
			high: [...DEFAULT_THINKING_LADDER.high],
		},
		policy: { ...DEFAULT_CONFIG.policy },
		candidates: [],
		envFile: DEFAULT_CONFIG.envFile,
	};

	if (Object.keys(file).length > 0) {
		if ("enabled" in file) config.enabled = bool(file.enabled, config.enabled);

		if (isObject(file.judge)) {
			config.judge.provider = str(file.judge.provider) ?? config.judge.provider;
			config.judge.model = str(file.judge.model) ?? config.judge.model;
			config.judge.timeoutMs = Math.round(num(file.judge.timeoutMs, config.judge.timeoutMs, 500, 60_000));
		}

		if (Array.isArray(file.candidates)) {
			config.candidates = file.candidates
				.map((candidate) => parseCandidate(candidate, warn))
				.filter((candidate): candidate is Candidate => candidate !== undefined);
		}

		const ladder = parseLadder(file.thinkingLadder);
		if (ladder) config.thinkingLadder = ladder;

		config.policy = parsePolicy(file.policy, config.policy);

		if ("reverseChoice" in file) config.reverseChoice = bool(file.reverseChoice, config.reverseChoice);
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
