/**
 * opencode-go Provider Extension
 *
 * Registers opencode-go as a custom provider with multi-API support.
 * Models use anthropic-messages or openai-completions as appropriate,
 * with per-model baseUrl/api.
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve stale immediately: disk cache → embedded models.json (zero-latency)
 *   2. Revalidate in background: live API /models → merge with embedded → cache → hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Merge order: [live|cache|embedded] → apply patch.json → merge custom-models.json
 *
 * Usage:
 *   # Set your API key
 *   export OPENCODE_API_KEY=your-api-key
 *
 *   # Run pi with the extension
 *   pi -e /path/to/pi-opencode-go-provider
 *
 * Then use /model to select from available models
 */

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { USAGE_WIDGET_KEY, readUsageConfig, writeUsageConfig, type UsageConfig } from "./config.ts";
import { sanitizeStatusText, truncateToWidth } from "./format.ts";
import { resolveGlyphSet, resolveWidgetGlyphSet, type GlyphSet } from "./glyphs.ts";
import { usageSegments, type UsageSegment, type UsageSeverity } from "./usage.ts";
import { UsageController } from "./usage-controller.ts";
import {
  isMultiproviderService,
  MULTIPROVIDER_SERVICE_EVENT,
  setActiveMultiproviderService,
  type MultiproviderService,
} from "./multiprovider.ts";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import fs from "fs";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

type Api = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface ThinkingLevelMapValue {
  [level: string]: string | null;
}

export interface JsonModel {
  id: string;
  name: string;
  api?: Api;
  baseUrl?: string;
  reasoning: boolean;
  // Set by transformApiModel when the live payload explicitly reports
  // `capabilities.reasoning.supported: false`. A payload that is merely silent
  // leaves it absent, so mergeWithEmbedded can tell "no reasoning" from "no
  // information". Stripped before a model is cached or registered.
  reasoningDenied?: boolean;
  thinkingLevelMap?: ThinkingLevelMapValue;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: CostTier[];
  };
  // null between transformApiModel and mergeWithEmbedded: the live /v1/models
  // API omits context data; null = "API silent, prefer curated/default".
  contextWindow: number | null;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

/**
 * pi's request-wide pricing tier (`model.cost.tiers`): once a request's total
 * input exceeds `inputTokensAbove`, these four rates replace the base ones for
 * the whole request (pi-ai's `calculateCost` takes the highest matching
 * threshold). All four are required, so a rate the payload's override does not
 * list keeps the base price rather than going to zero.
 */
export interface CostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PatchEntry {
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMapValue;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    tiers?: CostTier[];
  };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

type PatchData = Record<string, PatchEntry>;

// ─── Patch Application ────────────────────────────────────────────────────────

function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
  const result = { ...model };

  if (patch.name !== undefined) result.name = patch.name;
  if (patch.api !== undefined) result.api = patch.api;
  if (patch.baseUrl !== undefined) result.baseUrl = patch.baseUrl;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = patch.thinkingLevelMap;
  if (patch.input !== undefined) result.input = patch.input;
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;

  if (patch.cost) {
    // `tiers: []` in a patch clears the model's tiers; an absent key keeps them.
    const tiers = patch.cost.tiers ?? result.cost.tiers;
    result.cost = {
      input: patch.cost.input ?? result.cost.input,
      output: patch.cost.output ?? result.cost.output,
      cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
      cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
      ...(tiers && tiers.length > 0 ? { tiers } : {}),
    };
  }
  if (patch.compat) {
    result.compat = { ...(result.compat || {}), ...patch.compat };
  }

  if (!result.reasoning && result.compat?.thinkingFormat) {
    delete result.compat.thinkingFormat;
  }
  if (result.compat && Object.keys(result.compat).length === 0) {
    delete result.compat;
  }

  return result;
}

/** Full pipeline: base models → patch → custom → result. Exported for tests. */
export function buildModels(base: JsonModel[], custom: JsonModel[], patch: PatchData): JsonModel[] {
  const modelMap = new Map<string, JsonModel>();

  // Seed with the base list plus grace-period deprecated models so patch.json
  // entries apply to deprecated models exactly as while the model was live
  // (withDeprecated keeps live data on id conflicts).
  for (const model of withDeprecated(base)) {
    modelMap.set(model.id, model);
  }

  for (const [id, patchEntry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) {
      modelMap.set(id, applyPatch(existing, patchEntry));
    }
  }

  for (const model of custom) {
    const existing = modelMap.get(model.id);
    const patchEntry = patch[model.id];
    if (existing && patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else if (existing) {
      modelMap.set(model.id, model);
    } else if (patchEntry) {
      modelMap.set(model.id, applyPatch(model, patchEntry));
    } else {
      modelMap.set(model.id, model);
    }
  }

  return Array.from(modelMap.values());
}

// ─── Stale-While-Revalidate Model Sync ────────────────────────────────────────

const PROVIDER_ID = "opencode-go";
const BASE_URL = "https://opencode.ai/zen/go/v1";
const MODELS_URL = `${BASE_URL}/models`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

/**
 * Shape marker for the on-disk model cache.
 *
 * The cache is a snapshot of one transform's output, and nothing inside it said
 * which transform that was. So after an upgrade the stale path kept serving the
 * older routing until the first *successful* revalidation rewrote the file — a
 * matter of seconds with a healthy API, and indefinitely offline, which is
 * exactly when the stale path is in use. The recorded case: a cache written
 * before #117 held `claude-haiku-5-5` on `openai-completions` / `zen/go/v1`
 * with four zero costs and text-only input.
 *
 * Bump this whenever the pipeline starts writing a field group it did not write
 * before. Bumping costs one cold start per upgrade: the stale path falls back to
 * the curated `models.json`, and live-only models return with the first
 * revalidation. That is the trade, and it is deliberately in this direction —
 * a stale entry that looks current is worse than a missing one.
 *
 * Version 1 was the first versioned format; before it the file was a bare array,
 * which is therefore unrecognised on purpose: it cannot be upgraded in place,
 * because the whole problem is that its contents cannot be attributed. Version 2
 * added `cost.tiers` — a version-1 cache has no tiers to serve, so it is dropped
 * like any other mismatch.
 */
export const CACHE_FORMAT_VERSION = 2;

interface ModelCacheFile {
  format: number;
  models: JsonModel[];
}

/**
 * Resolve the API type and base URL from the live payload's `api` block. Each
 * model advertises exactly one endpoint today — `chat-completions` for the
 * OpenAI-compatible models, `messages` for the Anthropic ones — and
 * `chat-completions` wins if a model ever offers both.
 *
 * The advertised `messages` URL is the base its own Anthropic SDK appends
 * `/v1/messages` to, and pi's client appends the same, so a trailing `/v1` is
 * stripped: keeping it requests `/v1/v1/messages`, which 404s (verified
 * against the live endpoint on 2026-11-10).
 */
function resolveEndpoint(apiBlock: any): { api: Api; baseUrl: string } | undefined {
  // The payload is untrusted input: a non-string or blank base_url must fall
  // back to the default rather than register — and cache — a bogus URL that
  // the SDK then throws on for every request.
  const chatUrl = apiBlock?.["chat-completions"]?.base_url;
  if (typeof chatUrl === "string" && chatUrl.trim()) {
    return { api: "openai-completions", baseUrl: chatUrl.trim() };
  }
  const messagesUrl = apiBlock?.messages?.base_url;
  if (typeof messagesUrl === "string" && messagesUrl.trim()) {
    return { api: "anthropic-messages", baseUrl: messagesUrl.trim().replace(/\/v1\/?$/i, "") };
  }
  return undefined;
}
const DEFAULT_API: { api: Api; baseUrl: string } = { api: "openai-completions", baseUrl: BASE_URL };

/** A finite, non-negative number, or undefined. The payload is untrusted input. */
function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * True only for a `when.context` band that is exactly `{ gt }`.
 *
 * `Object.keys(when)` sees only `context`; it cannot tell an open-ended band
 * from a bounded one, so the shape has to be checked here. A `gte`, an empty
 * block, a non-object or an extra bound such as `lte` all describe a price
 * rule a pi tier cannot express (see costTiers) and must be skipped, not
 * partially mapped.
 */
function isOpenEndedContextBand(context: unknown): context is { gt: unknown } {
  if (typeof context !== "object" || context === null || Array.isArray(context)) return false;
  const keys = Object.keys(context);
  return keys.length === 1 && keys[0] === "gt";
}

/**
 * The payload prices some models per context tier: `cost.text.input.overrides`
 * and `cost.text.output.overrides` are parallel arrays whose entries carry the
 * same `when.context.gt` threshold. pi models the same thing as `cost.tiers`,
 * where the highest matching threshold applies its rates to the whole request, so
 * the two arrays collapse onto one tier per threshold.
 *
 * Two payload semantics are deliberately not mapped. `cost.multipliers` (peak
 * hour pricing) has no pi counterpart at all, and an override conditioned on
 * anything besides `when.context` is skipped rather than partially mapped: a
 * `service_tier`, region or time window would otherwise be promoted into a
 * permanent price, which is the same silent mispricing this function exists to
 * remove. A threshold or price that is not a usable number skips the override
 * too, so a malformed payload cannot cache NaN or a negative rate.
 *
 * Inside a `when.context` the same rule applies one level down: only exactly
 * `{ gt }` is accepted, because a pi tier has no upper bound. A bounded band
 * (`{ gt, lte }`) would otherwise be flattened into "above gt" and charged to
 * every request past the threshold, which is the mispricing above again.
 *
 * `gte` is dropped rather than mapped. pi's `calculateCost` matches a tier with
 * a strict `>`, so `gte: N` would have to become `inputTokensAbove: N - 1` to
 * mean "from N tokens up" — the obvious `N` is one token short, and the todo
 * that recorded this suggested `N + 1`, which narrows the tier instead. No
 * recorded payload uses `gte` at all (the 2026-11-10 fixture is `gt` only), so
 * an unobserved second band shape is not worth that arithmetic: a `gte`-only
 * override keeps the base rate. The user-facing wording lives in
 * `.pi/skills/add-model/`, which the `add-model-skill-rewrite` branch owns; it
 * is not edited here to keep the two changes from colliding, and it states which
 * of the two band shapes is mapped today and which waits for this one.
 *
 * One rate differs from what opencode itself would bill: a tier whose override
 * lists no cache rate inherits the base cache rate here, where their runtime
 * treats an unlisted rate as 0. pi's tier requires all four rates, so the choice
 * is base-inherit or zero, and inheriting does not claim that caching has become
 * free.
 */
function costTiers(text: any, base: Omit<CostTier, "inputTokensAbove">): CostTier[] | undefined {
  const tiers = new Map<number, CostTier>();
  const tierAt = (threshold: number): CostTier => {
    let tier = tiers.get(threshold);
    if (!tier) {
      tier = { inputTokensAbove: threshold, ...base };
      tiers.set(threshold, tier);
    }
    return tier;
  };

  const eachOverride = (block: any, apply: (tier: CostTier, override: any) => void): void => {
    const overrides: unknown[] = Array.isArray(block?.overrides) ? block.overrides : [];
    for (const override of overrides) {
      if (typeof override !== "object" || override === null) continue;
      const when = (override as any).when;
      if (typeof when !== "object" || when === null) continue;
      // Exactly one condition, and it is the context band. Anything else is not
      // expressible as a tier; see the note above.
      if (!Object.keys(when).every((key) => key === "context")) continue;
      // ... and a band is accepted only in the one shape a tier expresses:
      // open-ended at `gt`. A bounded band would become a permanent tier.
      const context: unknown = (when as { context?: unknown }).context;
      if (!isOpenEndedContextBand(context)) continue;
      const threshold = nonNegativeNumber(context.gt);
      if (threshold === undefined) continue;
      apply(tierAt(threshold), override);
    }
  };

  eachOverride(text?.input, (tier, override) => {
    tier.input = nonNegativeNumber(override.price) ?? tier.input;
    tier.cacheRead = nonNegativeNumber(override.cache?.read) ?? tier.cacheRead;
    tier.cacheWrite = nonNegativeNumber(override.cache?.write) ?? tier.cacheWrite;
  });
  eachOverride(text?.output, (tier, override) => {
    tier.output = nonNegativeNumber(override.price) ?? tier.output;
  });

  if (tiers.size === 0) return undefined;
  return [...tiers.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
}

/**
 * Pricing as the payload reports it: flat per-1M rates under `cost.text.*`,
 * optional cache rates that only some models carry, and the context-tiered
 * `overrides` folded into pi's `cost.tiers`. The block is left off entirely when
 * the model has no overrides, so a tierless model keeps exactly the shape it had
 * before it existed.
 */
function transformedCost(text: any): JsonModel["cost"] {
  // The flat rates are guarded the same way the tier rates are, because the
  // cache reader validates what the writer produces: a payload reporting
  // `price: "0.1"` used to be written straight into the cache, which then
  // refused the whole file on every later start while revalidation rewrote the
  // same element — never converging. The guarded zero also keeps a string from
  // reaching `calculateCost` as NaN in the live session.
  const cost: JsonModel["cost"] = {
    input: nonNegativeNumber(text?.input?.price) ?? 0,
    output: nonNegativeNumber(text?.output?.price) ?? 0,
    cacheRead: nonNegativeNumber(text?.input?.cache?.read) ?? 0,
    cacheWrite: nonNegativeNumber(text?.input?.cache?.write) ?? 0,
  };
  const tiers = costTiers(text, cost);
  if (tiers) cost.tiers = tiers;
  return cost;
}

/** Transform a model from the opencode-go /v1/models API. Returns minimal data. */
export function transformApiModel(apiModel: any): JsonModel {
  const advertised = resolveEndpoint(apiModel.api);
  const api = advertised?.api ?? DEFAULT_API.api;
  const baseUrl = advertised?.baseUrl ?? DEFAULT_API.baseUrl;

  // Pi's Model type only knows "text" and "image", while the API lists
  // concrete MIME types ("image/jpeg", "image/png", "application/pdf", ...).
  // Keep any image/* modality, drop the rest, and always offer text.
  const rawInput: unknown = apiModel.modalities?.input;
  const modalities: unknown[] = Array.isArray(rawInput) ? rawInput : [];
  const supportsImage = modalities.some(
    (m) => typeof m === "string" && (m === "image" || m.startsWith("image/")),
  );
  const input: ("text" | "image")[] = supportsImage ? ["text", "image"] : ["text"];

  // Derive reasoning support from the live API's capabilities block (the
  // /v1/models endpoint exposes reasoning under capabilities.reasoning, not
  // as a top-level field). Map advertised effort levels to themselves; leave
  // the map undefined when the model only toggles reasoning or uses a budget,
  // so pi falls back to its default level set instead of an empty one.
  const reasoningCap = apiModel.capabilities?.reasoning;
  const effortLevels = reasoningCap?.effort;
  // An advertised effort list implies reasoning support when the API omits the
  // explicit `supported` flag (some models only carry `effort`).
  const reasoningSupported =
    reasoningCap?.supported ??
    (Array.isArray(effortLevels) && effortLevels.length > 0 ? true : undefined) ??
    apiModel.reasoning ??
    false;
  // Only an explicit denial may beat curation; an absent capabilities block
  // means the API said nothing and must not be read as "no reasoning".
  const reasoningDenied = reasoningCap?.supported === false;
  const thinkingLevelMap =
    reasoningSupported && Array.isArray(effortLevels) && effortLevels.length > 0
      ? {
          off: effortLevels.includes("off")
            ? "off"
            : effortLevels.includes("none")
              ? "none"
              : null,
          minimal: effortLevels.includes("minimal") ? "minimal" : null,
          low: effortLevels.includes("low") ? "low" : null,
          medium: effortLevels.includes("medium") ? "medium" : null,
          high: effortLevels.includes("high") ? "high" : null,
          xhigh: effortLevels.includes("xhigh") ? "xhigh" : null,
          max: effortLevels.includes("max") ? "max" : null,
        }
      : undefined;

  const transformed: JsonModel = {
    id: apiModel.id,
    name: apiModel.name || apiModel.id,
    api,
    baseUrl,
    reasoning: Boolean(reasoningSupported),
    thinkingLevelMap,
    input,
    cost: transformedCost(apiModel.cost?.text),
    // `limit` is present in today's payload, but the null contract stays: a
    // payload without it must not masquerade as a real 131072 and shadow the
    // curated value in mergeWithEmbedded's nullish chain.
    contextWindow: apiModel.limit?.context || apiModel.context_length || null,
    maxTokens: apiModel.limit?.output || 0,
  };
  if (reasoningDenied) transformed.reasoningDenied = true;
  return transformed;
}

export function transformApiModels(apiModels: any[]): JsonModel[] {
  const models: JsonModel[] = [];
  for (const apiModel of apiModels) {
    try {
      models.push(transformApiModel(apiModel));
    } catch {
      // A single malformed entry must not discard the whole refresh; the
      // surrounding try/catch used to turn it into "no live models at all".
    }
  }
  return models;
}

async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<JsonModel[] | null> {
  try {
    const response = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const apiModels = Array.isArray(data) ? data : (data.data || []);
    if (!Array.isArray(apiModels) || apiModels.length === 0) return null;
    const models = transformApiModels(apiModels);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

function isModelCacheFile(data: unknown): data is ModelCacheFile {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const candidate = data as { format?: unknown; models?: unknown };
  return typeof candidate.format === "number" && Array.isArray(candidate.models);
}

/**
 * One cache element: an object with a non-empty string id, a pricing block, the
 * modalities pi's read tool dereferences, and a context window compaction can do
 * arithmetic with.
 *
 * An id alone is not enough. `loadStaleModels` serves a live-only cached model
 * as-is, so an element carrying only an `id` is registered with `cost:
 * undefined`, and pi-ai's `calculateCost` dereferences `model.cost.tiers` on
 * first use; a garbled rate that is still an object silently prices the session
 * NaN; a missing `input` makes pi's read tool throw on
 * `model.input.includes(...)`; and a non-numeric `contextWindow` makes
 * compaction's `contextTokens > contextWindow - reserveTokens` false instead of
 * throwing, which turns compaction off without a signal. All four are the same
 * hand-edited-file class as a `null` element, which used to throw out of
 * extension init.
 *
 * The remaining fields (`name`, `api`, `reasoning`, `maxTokens`, `compat`) are
 * left unchecked on purpose: registration falls back or Pi treats them as
 * display data, so a bad value there is cosmetic rather than fatal.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCachedCostTier(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tier = value as Record<string, unknown>;
  return [tier.inputTokensAbove, tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(isFiniteNumber);
}

function isCachedCost(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const cost = value as Record<string, unknown>;
  if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(isFiniteNumber)) return false;
  if (cost.tiers === undefined) return true;
  return Array.isArray(cost.tiers) && cost.tiers.every(isCachedCostTier);
}

function isCachedInput(value: unknown): value is ("text" | "image")[] {
  return Array.isArray(value) && value.every((m) => m === "text" || m === "image");
}

function isCachedModel(value: unknown): value is JsonModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { id?: unknown; cost?: unknown; input?: unknown; contextWindow?: unknown };
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    isCachedCost(candidate.cost) &&
    isCachedInput(candidate.input) &&
    // `null` is the model's own "window unknown" and registration falls back to
    // 131072 for it; anything else must be a real number for compaction.
    (candidate.contextWindow === null || isFiniteNumber(candidate.contextWindow))
  );
}

function loadCachedModels(): JsonModel[] | null {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
  if (!isModelCacheFile(data)) return null;
  if (data.format !== CACHE_FORMAT_VERSION) return null;
  // The elements are validated too, not just the envelope. The cache is a file
  // anything can rewrite (cacheModels never writes a bad element), and one bad
  // element used to be fatal or invisible rather than harmless: a `null` threw
  // `Cannot read properties of null (reading 'id')` out of extension init, a
  // string was registered with no id or name (its `api` fell back to a default,
  // which is why that field is not the tell), and an object with only an `id`
  // registered `cost: undefined` and threw from pi-ai on first use. A bad element
  // fails the whole read rather than being dropped one at a time, matching what
  // every other unrecognised cache shape already does here — fall back to the
  // curated list for one cold start, and let the next successful revalidation
  // rewrite the file. That also needs no warning sink: pi's TUI never shows
  // console.warn, so a warning here would be invisible exactly when the cache is
  // the only source (offline).
  if (!data.models.every(isCachedModel)) return null;
  return data.models;
}

/** Exported for tests: the writer and the reader are the only two things that
 *  know the file's shape, so a format bump has to move both. */
export function cacheModels(models: JsonModel[]): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file: ModelCacheFile = { format: CACHE_FORMAT_VERSION, models };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(file, null, 2) + "\n");
  } catch {
    // Cache write failure is non-fatal
  }
}

export function mergeWithEmbedded(liveModels: JsonModel[], embeddedModels: JsonModel[]): JsonModel[] {
  const embeddedMap = new Map(embeddedModels.map(m => [m.id, m]));
  const seen = new Set<string>();
  const result: JsonModel[] = [];
  for (const liveModel of liveModels) {
    const embedded = embeddedMap.get(liveModel.id);
    seen.add(liveModel.id);
    if (embedded) {
      // Self-heal: live API pricing is authoritative field-by-field. Prefer the
      // live cost when the API reports it (non-zero); fall back to embedded when
      // the API is silent (0) so curated cacheRead/cacheWrite isn't clobbered and
      // providers whose /models endpoint exposes no pricing keep their curated
      // cost. Curation (input/compat/name) still wins via ...embedded.
      //
      // Reasoning is curated too, with one exception: a payload that explicitly
      // reports `supported: false` demotes the model, because a capability lost
      // upstream must stop offering levels that no longer work. A payload that
      // merely omits the block leaves `reasoningDenied` unset, so silence can
      // never disable a curated model.
      const demoted = liveModel.reasoningDenied === true;
      // Tiers follow the same rule as the four flat rates: the live payload is
      // authoritative when it reports any, and curation fills the gap when it
      // does not.
      const tiers = liveModel.cost.tiers ?? embedded.cost.tiers;
      const merged: JsonModel = {
        ...liveModel,
        ...embedded,
        cost: {
          input: liveModel.cost.input || embedded.cost.input,
          output: liveModel.cost.output || embedded.cost.output,
          cacheRead: liveModel.cost.cacheRead || embedded.cost.cacheRead,
          cacheWrite: liveModel.cost.cacheWrite || embedded.cost.cacheWrite,
          ...(tiers && tiers.length > 0 ? { tiers } : {}),
        },
        // Nullish coalesce: if the live API was silent (liveModel.contextWindow
        // is null), fall through to the curated embedded value. The final
        // `?? 131072` is the safe default for the rare case of a Custom-only
        // model with neither live nor curated data. Using `||` here was the
        // bug — it treated the API's 131072-fallback as authoritative and
        // shadowed curated 1M/262K context windows.
        contextWindow: liveModel.contextWindow ?? embedded.contextWindow ?? 131072,
        reasoning: demoted ? false : embedded.reasoning,
        // Prefer the live-derived thinking-level map only when the curated
        // entry has none, so manual curation still wins for curated models.
        // A demoted model advertises no levels at all.
        thinkingLevelMap: demoted ? undefined : (embedded.thinkingLevelMap ?? liveModel.thinkingLevelMap),
      };
      // transformApiModel's live-only marker must not reach the cache or the
      // registered model.
      delete merged.reasoningDenied;
      result.push(merged);
    } else {
      // API-only model (no curated embedded counterpart). The Live API is silent
      // on contextWindow for all current opencode-go models, so liveModel.contextWindow
      // is null. Apply the safe default here so downstream consumers (e.g. pi core's
      // formatTokenCount → count.toString()) don't crash on null.
      const merged: JsonModel = { ...liveModel, contextWindow: liveModel.contextWindow ?? 131072 };
      delete merged.reasoningDenied;
      result.push(merged);
    }
  }
  // Append any embedded models that the live API didn't return
  for (const em of embeddedModels) {
    if (!seen.has(em.id)) {
      result.push(em);
    }
  }
  return result;
}

// Grace period for delisted models. When the provider API stops listing a
// model, update-models.js moves its last-known definition into
// deprecated-models.json (stamped with deprecatedAt) instead of dropping it.
// For 14 days the model keeps working here so in-flight sessions and saved
// model settings do not break; afterwards it is evicted permanently.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Grace-period deprecated models with deprecation metadata stripped.
function activeDeprecatedModels(): JsonModel[] {
  const now = Date.now();
  const result: JsonModel[] = [];
  for (const entry of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
    if (!entry?.id) continue;
    const removedAt = Date.parse(entry.deprecatedAt ?? "");
    if (Number.isNaN(removedAt) || now - removedAt > DEPRECATED_MODEL_TTL_MS) continue;
    const model = { ...entry } as JsonModel & { deprecatedAt?: string };
    delete model.deprecatedAt;
    result.push(model);
  }
  return result;
}

// Append grace-period deprecated models the list does not already have (live data wins).
function withDeprecated(models: JsonModel[]): JsonModel[] {
  const seen = new Set(models.map((m) => m.id));
  const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
  return extras.length > 0 ? [...models, ...extras] : models;
}

export function loadStaleModels(embeddedModels: JsonModel[]): JsonModel[] {
  const cached = loadCachedModels();
  if (!cached || cached.length === 0) return embeddedModels;

  const cachedMap = new Map(cached.map(m => [m.id, m]));
  for (const em of embeddedModels) {
    const cachedModel = cachedMap.get(em.id);
    // A model the cache predates: serve the curated entry.
    if (!cachedModel) {
      cached.push(em);
      continue;
    }

    // Refresh everything the curated entry owns, with one deliberate divergence
    // from mergeWithEmbedded: an entry that defines no thinkingLevelMap drops the
    // cached one instead of falling back to it. The merge rule is "curated, else
    // live", which offline would keep serving the map a curation edit just
    // removed; #120 chose the strict rule so a level that no longer works stops
    // being offered. `compat` keeps the merge's fallback because the live
    // transform never writes compat, so a cached block on a curated id is always
    // earlier curation and only a removal is affected.
    //
    // Cost and contextWindow stay cached deliberately: they are the two fields
    // mergeWithEmbedded gives to the live payload first, so a cached value that
    // disagrees with models.json is a live observation rather than stale
    // curation, and overwriting it offline would invent a price.
    cachedModel.name = em.name;
    // `??`: a curated entry without an endpoint lets the cached one stand, which
    // is what mergeWithEmbedded's spread does with an absent key.
    cachedModel.api = em.api ?? cachedModel.api;
    cachedModel.baseUrl = em.baseUrl ?? cachedModel.baseUrl;
    cachedModel.input = em.input;
    cachedModel.maxTokens = em.maxTokens;
    cachedModel.reasoning = em.reasoning;
    // Unconditional, unlike compat: curation dropping a map must stop offering
    // levels that no longer work, and the cached map is the stale copy here.
    cachedModel.thinkingLevelMap = em.thinkingLevelMap;
    // `compat` only when curation defines one. The merge falls back to the live
    // block, and a cached block on a curated id is always earlier curation, so
    // keeping it is the same "curated, else cached" rule — at the cost of a
    // removed block lingering until the cache is deleted.
    if (em.compat !== undefined) cachedModel.compat = em.compat;
  }
  return cached;
}

async function revalidateModels(apiKey: string | undefined, embeddedModels: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
  if (!apiKey) return null;
  const liveModels = await fetchLiveModels(apiKey, signal);
  if (!liveModels || liveModels.length === 0) return null;
  const merged = mergeWithEmbedded(liveModels, embeddedModels);
  cacheModels(merged);
  return merged;
}

// ─── API Key Resolution (via ModelRegistry) ────────────────────────────────────

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
  cachedApiKey = await modelRegistry.getApiKeyForProvider("opencode-go") ?? undefined;
}

// OpenCode Go prompt-cache routing headers.
// Pi core already injects these in mergeProviderAttributionHeaders for
// provider "opencode-go" / host opencode.ai (see #4847). This hook is a
// backstop: it fills them only when missing, so older pi builds and any
// request path that skipped transformHeaders still pin the session.
// Per-request via before_provider_headers — not registerProvider.headers —
// because provider-wide headers leak to raw helper streams
// (getApiKeyAndHeaders) that must not inherit the main session's cache
// lineage. No custom streamSimple is needed; headers are applied before
// provider dispatch.
const OPENCODE_SESSION_HEADER = "x-opencode-session";
const OPENCODE_CLIENT_HEADER = "x-opencode-client";
const OPENCODE_CLIENT = "pi";

function headerLookup(headers: Record<string, string | null | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value ?? undefined;
  }
  return undefined;
}

export function applyOpenCodeSessionHeaders(
  headers: Record<string, string | null>,
  sessionId: string | undefined,
): Record<string, string | null> {
  if (sessionId && !headerLookup(headers, OPENCODE_SESSION_HEADER)) {
    headers[OPENCODE_SESSION_HEADER] = sessionId;
  }
  if (!headerLookup(headers, OPENCODE_CLIENT_HEADER)) {
    headers[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT;
  }
  return headers;
}

export default function (pi: ExtensionAPI) {
  const embeddedModels = modelsData as JsonModel[];
  const customModels = customModelsData as JsonModel[];
  const patches = patchData as PatchData;

  const staleBase = loadStaleModels(embeddedModels);
  const staleModels = buildModels(staleBase, customModels, patches);

  pi.registerProvider("opencode-go", {
    name: "OpenCode Go",
    baseUrl: BASE_URL,
    apiKey: "$OPENCODE_API_KEY",
    api: "openai-completions",
    models: staleModels.map(m => ({
      id: m.id,
      name: m.name,
      api: m.api || "openai-completions",
      baseUrl: m.baseUrl,
      reasoning: m.reasoning,
      thinkingLevelMap: m.thinkingLevelMap,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow ?? 131072,
      maxTokens: m.maxTokens,
      compat: m.compat,
    })),
  });

  // Usage widget (5h / 7d / 30d).
  // opencode-go meters the Go plan with a rolling 5h window, a weekly window and
  // a monthly window. GET /zen/go/v1/usage publishes all three. The widget below
  // the editor mirrors pi-better-openai's usage widget; the footer status line is
  // the fallback when no terminal UI is attached.

  let usageConfig = readUsageConfig();
  let usageWidgetInstalled = false;
  let usageClampNotified = false;
  const usageController = new UsageController(() => usageConfig, updateUsageWidget);
  let usageContext: ExtensionContext | undefined;

  // Follow pi-multiprovider's active pooled account. Usage is per-account, so a
  // switch — and a resume, which replays the account the session last switched
  // to — must repaint the widget instead of waiting for the next poll. Without
  // pi-multiprovider nothing here activates and resolution stays unchanged.
  let multiproviderService: MultiproviderService | undefined;
  let unsubscribeMultiprovider: (() => void) | undefined;
  const refreshUsageForActiveAccount = (ctx: ExtensionContext | undefined): void => {
    if (ctx === undefined) return;
    void usageController.refresh(ctx, { force: true });
  };
  if (typeof pi.events?.on === "function") {
    pi.events.on(MULTIPROVIDER_SERVICE_EVENT, (value: unknown) => {
      if (!isMultiproviderService(value)) return;
      if (value !== multiproviderService) {
        unsubscribeMultiprovider?.();
        multiproviderService = value;
        setActiveMultiproviderService(value);
        unsubscribeMultiprovider = value.onActiveAccountChanged(PROVIDER_ID, (event) => {
          refreshUsageForActiveAccount(usageContext ?? event.ctx);
        });
      }
      // The event re-fires at every session start with the same stable object,
      // so this also catches a service that appeared mid-session.
      refreshUsageForActiveAccount(usageContext);
    });
  }

  const USAGE_SEVERITY_COLORS: Record<UsageSeverity, ThemeColor> = {
    ok: "success",
    warning: "warning",
    critical: "error",
    muted: "dim",
  };

  function usageSegmentsFor(ctx: ExtensionContext, glyphs: GlyphSet): UsageSegment[] | undefined {
    const snapshot = usageController.snapshot;
    if (!snapshot || !usageConfig.enabled || !usageController.isEligible(ctx)) return undefined;
    const segments = usageSegments(snapshot, { showResetTimes: usageConfig.showResetTimes, glyphs });
    if (usageController.isStale()) segments.push({ text: ` ${glyphs.sep} stale`, severity: "warning" });
    return segments;
  }

  function updateUsageWidget(ctx: ExtensionContext): void {
    try {
      // Legacy terminals measure the footer glyphs with their own tables; widget
      // content clamps to ASCII there, the status fallback keeps the choice.
      const glyphs = resolveGlyphSet(usageConfig.glyphs);
      const widgetGlyphs = resolveWidgetGlyphSet(usageConfig.glyphs);
      if (widgetGlyphs !== glyphs && !usageClampNotified) {
        usageClampNotified = true;
        ctx.ui.notify("OpenCode Go: widget glyphs stay ASCII on this terminal — unicode glyphs overflow legacy mintty/Cygwin cell widths. The status line is unaffected.", "info");
      }
      const segments = usageSegmentsFor(ctx, widgetGlyphs);
      if (!segments) {
        if (usageWidgetInstalled) {
          ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined);
          ctx.ui.setStatus(USAGE_WIDGET_KEY, undefined);
          usageWidgetInstalled = false;
        }
        return;
      }
      if (ctx.mode === "tui") {
        ctx.ui.setStatus(USAGE_WIDGET_KEY, undefined);
        ctx.ui.setWidget(
          USAGE_WIDGET_KEY,
          (_tui, theme) => ({
            invalidate() {},
            render(width: number): string[] {
              // Segments are captured per install, keeping render() free of the
              // extension context so a stale ctx can never be touched mid-draw.
              const line = segments
                .map((segment) => theme.fg(USAGE_SEVERITY_COLORS[segment.severity], segment.text))
                .join("");
              // Budget width - 1: never paint the terminal’s last column (a
              // pending wrap there desyncs pi’s renderer on legacy terminals).
              const w = Math.max(1, width - 1);
              return [truncateToWidth(line, w, theme.fg("dim", widgetGlyphs.ellipsis))];
            },
          }),
          { placement: usageConfig.placement },
        );
      } else {
        ctx.ui.setWidget(USAGE_WIDGET_KEY, undefined);
        const barSegments = usageSegmentsFor(ctx, glyphs) ?? segments;
        ctx.ui.setStatus(USAGE_WIDGET_KEY, sanitizeStatusText(barSegments.map((s) => s.text).join("")));
      }
      usageWidgetInstalled = true;
    } catch {
      // A stale extension context can surface here; the next session re-installs.
    }
  }

  pi.registerCommand("opencode-go-usage", {
    description: "Show, refresh, or toggle the OpenCode Go 5h / 7d / 30d usage widget",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "glyphs auto" || action === "glyphs unicode" || action === "glyphs ascii") {
        const glyphs = action.slice("glyphs ".length) as UsageConfig["glyphs"];
        usageConfig = { ...usageConfig, glyphs };
        const persisted = writeUsageConfig({ glyphs });
        updateUsageWidget(ctx);
        const suffix = persisted ? "" : " for this session (could not write the config file)";
        ctx.ui.notify(`OpenCode Go footer glyphs: ${glyphs}${suffix}.`, "info");
        return;
      }
      if (action === "on" || action === "off") {
        const enabled = action === "on";
        usageConfig = { ...usageConfig, enabled };
        const persisted = writeUsageConfig({ enabled });
        const suffix = persisted ? "" : " for this session (could not write the config file)";
        if (enabled) {
          usageController.start(ctx);
          ctx.ui.notify(`OpenCode Go usage widget enabled${suffix}.`, "info");
        } else {
          usageController.stop();
          usageController.clear();
          updateUsageWidget(ctx);
          ctx.ui.notify(`OpenCode Go usage widget disabled${suffix}.`, "info");
        }
        return;
      }
      if (action === "debug") {
        ctx.ui.notify(usageController.formatDebug(ctx), "info");
        return;
      }
      // No argument (and "refresh") always re-reads the API and reports the breakdown.
      await usageController.refresh(ctx, { notify: true, force: true });
    },
  });

  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    applyOpenCodeSessionHeaders(event.headers, ctx.sessionManager.getSessionId());
  });

  pi.on("session_start", async (_event, ctx) => {
    usageContext = ctx;
    usageController.start(ctx);
    revalidateAbort?.abort();
    revalidateAbort = new AbortController();
    const signal = revalidateAbort.signal;
    resolveApiKey(ctx.modelRegistry).then(() => {
      revalidateModels(cachedApiKey, embeddedModels, signal).then((freshBase) => {
        if (freshBase && !signal.aborted) {
          pi.registerProvider("opencode-go", {
            name: "OpenCode Go",
            baseUrl: BASE_URL,
            apiKey: "$OPENCODE_API_KEY",
            api: "openai-completions",
            models: buildModels(freshBase, customModels, patches).map(m => ({
              id: m.id,
              name: m.name,
              api: m.api || "openai-completions",
              baseUrl: m.baseUrl,
              reasoning: m.reasoning,
              thinkingLevelMap: m.thinkingLevelMap,
              input: m.input,
              cost: m.cost,
              contextWindow: m.contextWindow ?? 131072,
              maxTokens: m.maxTokens,
              compat: m.compat,
            })),
          });
        }
      });
    });
  });

  pi.on("turn_end", (_event, ctx) => {
    void usageController.refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    void usageController.refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    revalidateAbort?.abort();
    usageContext = undefined;
    unsubscribeMultiprovider?.();
    unsubscribeMultiprovider = undefined;
    multiproviderService = undefined;
    setActiveMultiproviderService(undefined);
    usageController.shutdown();
  });
}
