/**
 * Model pipeline tests: transformApiModel → mergeWithEmbedded → loadStaleModels
 * → buildModels.
 *
 * The live payload fixture is a verbatim capture of
 * `GET https://opencode.ai/zen/go/v1/models` from 2026-11-10 (four of the six
 * models it listed), kept in the shape the API returns so the transform is fed
 * exactly what the network feeds it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { JsonModel } from "../index.ts";
import livePayload from "./fixtures/live-models-2026-11-10.json" with { type: "json" };

// index.ts resolves the cache path once, at import time, from pi's agent dir.
// Point it at a temp dir before importing so loadStaleModels never reads the
// real ~/.pi/agent cache.
const agentDir = mkdtempSync(path.join(tmpdir(), "opencode-go-models-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const {
  CACHE_FORMAT_VERSION,
  buildModels,
  cacheModels,
  loadStaleModels,
  mergeWithEmbedded,
  transformApiModel,
  transformApiModels,
} = await import("../index.ts");

const CACHE_DIR = path.join(agentDir, "cache");
const CACHE_PATH = path.join(CACHE_DIR, "opencode-go-models.json");

const liveModels = livePayload.data;
function live(id: string) {
  const found = liveModels.find((m) => m.id === id);
  assert.ok(found, `fixture is missing ${id}`);
  return found;
}

function model(over: Partial<JsonModel> & { id: string }): JsonModel {
  return {
    id: over.id,
    name: over.id,
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/go/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
    ...over,
  };
}

function writeRawCache(value: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(value));
}

/** A cache in the format the provider writes today. */
function writeCache(models: JsonModel[]): void {
  writeRawCache({ format: CACHE_FORMAT_VERSION, models });
}

/** A cache written before the format marker existed: a bare array. */
function writeLegacyCache(models: JsonModel[]): void {
  writeRawCache(models);
}

function clearCache(): void {
  rmSync(CACHE_PATH, { force: true });
}

// ─── transformApiModel ────────────────────────────────────────────────────────

test("maps an advertised effort list onto pi's thinking levels", () => {
  const beam = transformApiModel(live("beam-free"));

  assert.equal(beam.reasoning, true);
  assert.deepEqual(beam.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });
});

test("maps only the advertised effort levels and leaves the rest null", () => {
  const deepseek = transformApiModel(live("deepseek-v4.1-flash"));

  assert.deepEqual(deepseek.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("translates the API's none effort to pi's off level", () => {
  const synthetic = transformApiModel({
    id: "synthetic-none",
    capabilities: { reasoning: { supported: true, effort: ["none", "low"] } },
  });

  assert.equal(synthetic.reasoning, true);
  assert.deepEqual(synthetic.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  });
});

test("keeps an advertised off effort as off", () => {
  const synthetic = transformApiModel({
    id: "synthetic-off",
    capabilities: { reasoning: { supported: true, effort: ["off", "high"] } },
  });

  assert.equal(synthetic.thinkingLevelMap?.off, "off");
});

test("omits the map for a toggle-only reasoning model", () => {
  const longcat = transformApiModel(live("longcat-2.5-free"));

  assert.equal(longcat.reasoning, true);
  assert.equal(longcat.thinkingLevelMap, undefined);
});

test("infers reasoning support from an effort list when the supported flag is absent", () => {
  const synthetic = transformApiModel({
    id: "synthetic-effort-only",
    capabilities: { reasoning: { effort: ["high"] } },
  });

  assert.equal(synthetic.reasoning, true);
  assert.equal(synthetic.thinkingLevelMap?.high, "high");
});

test("marks an explicit live denial, and only an explicit one", () => {
  assert.equal(
    transformApiModel({ id: "denied", capabilities: { reasoning: { supported: false } } }).reasoningDenied,
    true,
  );
  assert.equal(transformApiModel({ id: "silent" }).reasoningDenied, undefined);
  assert.equal(
    transformApiModel({ id: "granted", capabilities: { reasoning: { supported: true } } }).reasoningDenied,
    undefined,
  );
});

test("does not infer reasoning support when the API says supported: false", () => {
  const synthetic = transformApiModel({
    id: "synthetic-unsupported",
    capabilities: { reasoning: { supported: false, effort: ["high"] } },
  });

  assert.equal(synthetic.reasoning, false);
  assert.equal(synthetic.thinkingLevelMap, undefined);
});

test("reads the context window and output limit from the limit block", () => {
  const beam = transformApiModel(live("beam-free"));

  assert.equal(beam.contextWindow, 1048576);
  assert.equal(beam.maxTokens, 131072);
});

test("leaves the context window null when the API is silent", () => {
  const synthetic = transformApiModel({ id: "synthetic-bare" });

  assert.equal(synthetic.contextWindow, null);
  assert.equal(synthetic.maxTokens, 0);
});

test("always offers text input and falls back to the id for the name", () => {
  const synthetic = transformApiModel({ id: "synthetic-bare" });

  assert.deepEqual(synthetic.input, ["text"]);
  assert.equal(synthetic.name, "synthetic-bare");
  assert.equal(transformApiModel(live("beam-free")).name, "Beam Free");
});

test("reads pricing from the payload's cost.text block", () => {
  const haiku = live("claude-haiku-5-5");
  assert.equal(haiku.cost.text.input.price, 0.1);
  assert.equal(haiku.cost.text.output.price, 0.5);
  assert.equal(haiku.cost.text.input.cache.read, 0.01);
  assert.equal(haiku.cost.text.input.cache.write, 0.125);

  const transformed = transformApiModel(haiku);
  assert.deepEqual(transformed.cost, {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
  });
});

test("maps the payload's context-tiered overrides onto pi's cost tiers", () => {
  // Both override arrays are keyed by the same `when.context.gt`, so they are one
  // tier: pi's ModelCostTier carries all four rates, and only the highest matching
  // threshold applies to the whole request.
  const tiers = transformApiModel(live("claude-haiku-5-5")).cost.tiers;

  assert.deepEqual(tiers, [
    { inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  ]);
});

test("omits tiers entirely when the payload has no overrides", () => {
  const deepseek = transformApiModel(live("deepseek-v4.1-flash"));

  assert.equal(deepseek.cost.tiers, undefined);
  assert.equal("tiers" in deepseek.cost, false);
});

test("fills a rate a tier does not list from the base price", () => {
  const synthetic = transformApiModel({
    id: "synthetic-input-only-tier",
    cost: {
      text: {
        input: { price: 1, cache: { read: 0.1, write: 1.25 }, overrides: [{ when: { context: { gt: 50000 } }, price: 2 }] },
        output: { price: 3 },
      },
    },
  });

  assert.deepEqual(synthetic.cost.tiers, [
    { inputTokensAbove: 50000, input: 2, output: 3, cacheRead: 0.1, cacheWrite: 1.25 },
  ]);
});

test("keeps thresholds from both override arrays as separate tiers, ascending", () => {
  const synthetic = transformApiModel({
    id: "synthetic-two-tiers",
    cost: {
      text: {
        input: { price: 1, overrides: [{ when: { context: { gt: 200000 } }, price: 4 }] },
        output: { price: 3, overrides: [{ when: { context: { gt: 100000 } }, price: 6 }] },
      },
    },
  });

  assert.deepEqual(synthetic.cost.tiers, [
    { inputTokensAbove: 100000, input: 1, output: 6, cacheRead: 0, cacheWrite: 0 },
    { inputTokensAbove: 200000, input: 4, output: 3, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test("ignores an override whose threshold is not a number", () => {
  for (const when of [undefined, {}, { context: {} }, { context: { gt: "100000" } }, { tokens: { gt: 1 } }]) {
    const synthetic = transformApiModel({
      id: "x",
      cost: { text: { input: { price: 1, overrides: [{ when, price: 2 }] }, output: { price: 3 } } },
    });

    assert.equal(synthetic.cost.tiers, undefined, JSON.stringify(when));
  }
});

test("skips an override conditioned on anything besides the context band", () => {
  // Mapping the context half of a conditional price would promote it to a
  // permanent price: the payload may also condition on a service tier, a region
  // or a time window, none of which pi's tier can express.
  const overrides = [
    { when: { context: { gt: 100000 } }, price: 9 },
    { when: { context: { gt: 100000 }, service_tier: "priority" }, price: 2 },
    { when: { region: { in: ["eu"] } }, price: 2 },
  ];

  for (const override of overrides.slice(1)) {
    const synthetic = transformApiModel({
      id: "x",
      cost: { text: { input: { price: 1, overrides: [override] }, output: { price: 3 } } },
    });

    assert.equal(synthetic.cost.tiers, undefined, JSON.stringify(override.when));
  }

  const mapped = transformApiModel({
    id: "x",
    cost: { text: { input: { price: 1, overrides: [overrides[0]] }, output: { price: 3 } } },
  });
  assert.equal(mapped.cost.tiers?.[0]?.input, 9);
});

test("maps a gte threshold like gt", () => {
  const synthetic = transformApiModel({
    id: "x",
    cost: {
      text: {
        input: { price: 1, overrides: [{ when: { context: { gte: 50000 } }, price: 2 }] },
        output: { price: 3 },
      },
    },
  });

  assert.equal(synthetic.cost.tiers?.[0]?.inputTokensAbove, 50000);
  assert.equal(synthetic.cost.tiers?.[0]?.input, 2);
});

test("keeps the base rate for an override whose price is not a number", () => {
  const synthetic = transformApiModel({
    id: "x",
    cost: {
      text: {
        input: { price: 1, overrides: [{ when: { context: { gt: 1000 } }, price: "cheap", cache: { read: -1 } }] },
        output: { price: 3 },
      },
    },
  });

  assert.deepEqual(synthetic.cost.tiers, [
    { inputTokensAbove: 1000, input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
  ]);
});

test("treats a non-array overrides block as no tiers", () => {
  const synthetic = transformApiModel({
    id: "x",
    cost: { text: { input: { price: 1, overrides: { gt: 1 } }, output: { price: 3, overrides: "nope" } } },
  });

  assert.equal(synthetic.cost.tiers, undefined);
});

test("accepts MIME image modalities as image input and drops non-image ones", () => {
  const haiku = live("claude-haiku-5-5");
  assert.deepEqual(haiku.modalities.input, [
    "text",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
  ]);

  const transformed = transformApiModel(haiku);
  assert.deepEqual(transformed.input, ["text", "image"]);
});

test("derives api and baseUrl from the advertised endpoint", () => {
  const haiku = live("claude-haiku-5-5");
  assert.equal(haiku.api.messages.base_url, "https://opencode.ai/inference/go/anthropic/v1");

  const anthropic = transformApiModel(haiku);
  assert.equal(anthropic.api, "anthropic-messages");
  // pi's Anthropic client appends /v1/messages itself, so the advertised /v1
  // is stripped; keeping it requests /v1/v1/messages, which 404s.
  assert.equal(anthropic.baseUrl, "https://opencode.ai/inference/go/anthropic");

  const deepseek = live("deepseek-v4.1-flash");
  assert.equal(deepseek.api["chat-completions"].base_url, "https://opencode.ai/inference/go/openai/v1");

  const openai = transformApiModel(deepseek);
  assert.equal(openai.api, "openai-completions");
  assert.equal(openai.baseUrl, "https://opencode.ai/inference/go/openai/v1");
});

test("strips a trailing /v1/ from the Anthropic endpoint too", () => {
  const synthetic = transformApiModel({
    id: "synthetic-anthropic",
    api: { messages: { base_url: "https://example.test/anthropic/v1/" } },
  });

  assert.equal(synthetic.api, "anthropic-messages");
  assert.equal(synthetic.baseUrl, "https://example.test/anthropic");
});

test("falls back to the default endpoint when a base_url is not a usable string", () => {
  for (const baseUrl of [123, null, "", "   ", true]) {
    const chat = transformApiModel({ id: "x", api: { "chat-completions": { base_url: baseUrl } } });
    const messages = transformApiModel({ id: "x", api: { messages: { base_url: baseUrl } } });

    assert.equal(chat.baseUrl, "https://opencode.ai/zen/go/v1", `chat base_url ${JSON.stringify(baseUrl)}`);
    assert.equal(messages.baseUrl, "https://opencode.ai/zen/go/v1", `messages base_url ${JSON.stringify(baseUrl)}`);
  }
});

test("trims a base_url and strips an uppercase /V1", () => {
  const synthetic = transformApiModel({
    id: "x",
    api: { messages: { base_url: "  https://example.test/anthropic/V1  " } },
  });

  assert.equal(synthetic.baseUrl, "https://example.test/anthropic");
});

test("treats a non-array modalities block as text-only", () => {
  const synthetic = transformApiModel({ id: "x", modalities: { input: "text" } });

  assert.deepEqual(synthetic.input, ["text"]);
});

test("keeps the other models when one entry is malformed", () => {
  const malformed = {
    get id(): string {
      throw new Error("boom");
    },
  };

  const models = transformApiModels([{ id: "ok" }, malformed, { id: "also-ok" }]);

  assert.deepEqual(models.map((m) => m.id), ["ok", "also-ok"]);
});

test("falls back to the provider default endpoint when the payload advertises none", () => {
  const synthetic = transformApiModel({ id: "synthetic-bare" });

  assert.equal(synthetic.api, "openai-completions");
  assert.equal(synthetic.baseUrl, "https://opencode.ai/zen/go/v1");
});

test("prefers chat-completions when a payload advertises both endpoints", () => {
  const synthetic = transformApiModel({
    id: "synthetic-both",
    api: {
      messages: { base_url: "https://example.test/anthropic/v1" },
      "chat-completions": { base_url: "https://example.test/openai/v1" },
    },
  });

  assert.equal(synthetic.api, "openai-completions");
  assert.equal(synthetic.baseUrl, "https://example.test/openai/v1");
});

// ─── mergeWithEmbedded ────────────────────────────────────────────────────────

test("curation wins for reasoning, input, compat, name and maxTokens", () => {
  const liveModel = model({
    id: "m",
    name: "Live Name",
    reasoning: false,
    input: ["text"],
    maxTokens: 8192,
  });
  const curated = model({
    id: "m",
    name: "Curated Name",
    reasoning: true,
    input: ["text", "image"],
    maxTokens: 4096,
    compat: { supportsStore: false },
  });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.equal(merged.name, "Curated Name");
  assert.equal(merged.reasoning, true);
  assert.deepEqual(merged.input, ["text", "image"]);
  assert.equal(merged.maxTokens, 4096);
  assert.deepEqual(merged.compat, { supportsStore: false });
});

test("curation keeps its reasoning when the live payload is silent", () => {
  // A payload with no capabilities block is information-free, not a denial.
  const liveModel = model({ id: "m", reasoning: false });
  const curated = model({ id: "m", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.equal(merged.reasoning, true);
  assert.deepEqual(merged.thinkingLevelMap, { low: "low", high: "high" });
});

test("lets an explicit live denial turn curated reasoning off", () => {
  const liveModel = model({ id: "m", reasoning: false, reasoningDenied: true });
  const curated = model({ id: "m", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.equal(merged.reasoning, false);
  assert.equal(merged.thinkingLevelMap, undefined);
});

test("strips the live denial marker from merged models", () => {
  const curated = mergeWithEmbedded([model({ id: "m", reasoningDenied: true })], [model({ id: "m" })])[0];
  const apiOnly = mergeWithEmbedded([model({ id: "api-only", reasoningDenied: true })], [])[0];

  assert.equal("reasoningDenied" in curated, false);
  assert.equal("reasoningDenied" in apiOnly, false);
});

test("keeps the live compat block when curation has none", () => {
  const liveModel = model({ id: "m", compat: { maxTokensField: "max_tokens" } });
  const curated = model({ id: "m" });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.deepEqual(merged.compat, { maxTokensField: "max_tokens" });
});

test("lets live cost win per field only when the API reports it", () => {
  const liveModel = model({
    id: "m",
    cost: { input: 0, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  });
  const curated = model({
    id: "m",
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.125 },
  });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.deepEqual(merged.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0.125 });
});

test("prefers live tiers, and falls back to curated ones when the API reports none", () => {
  const tier = (input: number) => [
    { inputTokensAbove: 100000, input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 },
  ];
  const liveTiered = mergeWithEmbedded(
    [model({ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: tier(2) } })],
    [model({ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: tier(9) } })],
  )[0];
  const curatedOnly = mergeWithEmbedded(
    [model({ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })],
    [model({ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: tier(9) } })],
  )[0];

  assert.equal(liveTiered.cost.tiers?.[0]?.input, 2);
  assert.equal(curatedOnly.cost.tiers?.[0]?.input, 9);
});

test("prefers the live context window, then curation, then the 131072 default", () => {
  const bothKnown = mergeWithEmbedded(
    [model({ id: "m", contextWindow: 200000 })],
    [model({ id: "m", contextWindow: 1000000 })],
  )[0];
  const liveSilent = mergeWithEmbedded(
    [model({ id: "m", contextWindow: null })],
    [model({ id: "m", contextWindow: 1000000 })],
  )[0];
  const nothingKnown = mergeWithEmbedded(
    [model({ id: "m", contextWindow: null })],
    [model({ id: "m", contextWindow: null })],
  )[0];

  assert.equal(bothKnown.contextWindow, 200000);
  assert.equal(liveSilent.contextWindow, 1000000);
  assert.equal(nothingKnown.contextWindow, 131072);
});

test("prefers the curated thinking-level map but keeps the live one when curation has none", () => {
  const curatedMap = { off: null, low: "low" };
  const liveMap = { low: "low", high: "high" };

  const curatedWins = mergeWithEmbedded(
    [model({ id: "m", thinkingLevelMap: liveMap })],
    [model({ id: "m", thinkingLevelMap: curatedMap })],
  )[0];
  const liveFills = mergeWithEmbedded(
    [model({ id: "m", thinkingLevelMap: liveMap })],
    [model({ id: "m" })],
  )[0];

  assert.deepEqual(curatedWins.thinkingLevelMap, curatedMap);
  assert.deepEqual(liveFills.thinkingLevelMap, liveMap);
});

test("gives an API-only model the context default and appends curated models the API omitted", () => {
  const apiOnly = model({ id: "api-only", contextWindow: null, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
  const curatedOnly = model({ id: "curated-only" });

  const merged = mergeWithEmbedded([apiOnly], [curatedOnly]);

  assert.deepEqual(merged.map((m) => m.id), ["api-only", "curated-only"]);
  assert.equal(merged[0].contextWindow, 131072);
  assert.deepEqual(merged[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

// ─── loadStaleModels ──────────────────────────────────────────────────────────

test("returns the curated list when there is no cache", () => {
  clearCache();
  const curated = [model({ id: "curated" })];

  assert.deepEqual(loadStaleModels(curated), curated);
});

test("appends curated models missing from the cache", () => {
  const cached = model({ id: "cached", cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } });
  writeCache([cached]);
  const curated = [model({ id: "cached", name: "Curated" }), model({ id: "new", name: "New" })];

  const result = loadStaleModels(curated);

  assert.deepEqual(result.map((m) => m.id), ["cached", "new"]);
  // The cached entry is served rather than replaced, and its cost is the proof:
  // cost is the one field the stale path never refreshes from curation.
  assert.deepEqual(result[0].cost, { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
});

test("refreshes cached reasoning and thinking levels from the curated entry", () => {
  writeCache([model({ id: "m", reasoning: false, thinkingLevelMap: { low: "low" } })]);
  const curated = [model({ id: "m", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } })];

  const [stale] = loadStaleModels(curated);

  assert.equal(stale.reasoning, true);
  assert.deepEqual(stale.thinkingLevelMap, { low: "low", high: "high" });
});

test("drops a cached thinking-level map the curated entry no longer has", () => {
  writeCache([model({ id: "m", reasoning: true, thinkingLevelMap: { low: "low" } })]);
  const curated = [model({ id: "m", reasoning: true })];

  const [stale] = loadStaleModels(curated);

  assert.equal(stale.thinkingLevelMap, undefined);
});

test("ignores a cache written before the format marker existed", () => {
  // The recorded case: a cache from the pre-#117 transform holds a live-only
  // model on the old endpoint with four zero costs. Nothing in a bare array says
  // which transform wrote it, so it cannot be served as if it were current.
  writeLegacyCache([
    model({
      id: "live-only",
      name: "Live Only",
      api: "openai-completions",
      baseUrl: "https://stale.test/v1",
      input: ["text"],
    }),
  ]);

  const result = loadStaleModels([model({ id: "curated" })]);

  assert.deepEqual(result.map((m) => m.id), ["curated"]);
});

test("reads a cache written in the current format", () => {
  writeCache([model({ id: "cached", name: "Cached" })]);
  const curated = [model({ id: "cached", name: "Curated" }), model({ id: "new" })];

  assert.deepEqual(loadStaleModels(curated).map((m) => m.id), ["cached", "new"]);
});

test("ignores a cache written in another format", () => {
  writeRawCache({ format: CACHE_FORMAT_VERSION + 1, models: [model({ id: "cached" })] });

  const result = loadStaleModels([model({ id: "curated" })]);

  assert.deepEqual(result.map((m) => m.id), ["curated"]);
});

test("ignores a cache that is JSON but not a cache file", () => {
  for (const junk of [null, 42, "models", [], { models: [] }, { format: "1", models: [] }]) {
    writeRawCache(junk);

    const result = loadStaleModels([model({ id: "curated" })]);

    assert.deepEqual(result.map((m) => m.id), ["curated"], JSON.stringify(junk));
  }
});

test("writes a cache its own stale path can read", () => {
  // The writer and the reader are the only two things that know the file's
  // shape, and a format bump that changes one but not the other would freeze
  // the model list at the curated entries forever. Reading the file back, not
  // just round-tripping through the module, is what catches the subtler version:
  // renaming the envelope on both sides without bumping the format, which leaves
  // every cache written by the previous release unloadable while the marker
  // claims it is current.
  const models = [model({ id: "cached" })];
  cacheModels(models);

  assert.deepEqual(JSON.parse(readFileSync(CACHE_PATH, "utf8")), {
    format: CACHE_FORMAT_VERSION,
    models,
  });
  assert.deepEqual(loadStaleModels([]).map((m) => m.id), ["cached"]);
});

test("refreshes the curated endpoint, name, modalities and limits on the stale path", () => {
  writeCache([
    model({
      id: "m",
      name: "Cached Name",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
      input: ["text"],
      maxTokens: 0,
      compat: { maxTokensField: "max_completion_tokens" },
    }),
  ]);
  const curated = [
    model({
      id: "m",
      name: "Curated Name",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/inference/go/anthropic",
      input: ["text", "image"],
      maxTokens: 128000,
      compat: { maxTokensField: "max_tokens" },
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      contextWindow: 1000000,
    }),
  ];

  const [stale] = loadStaleModels(curated);

  assert.equal(stale.name, "Curated Name");
  assert.equal(stale.api, "anthropic-messages");
  assert.equal(stale.baseUrl, "https://opencode.ai/inference/go/anthropic");
  assert.deepEqual(stale.input, ["text", "image"]);
  assert.equal(stale.maxTokens, 128000);
  assert.deepEqual(stale.compat, { maxTokensField: "max_tokens" });
  // Cost and contextWindow stay cached deliberately: they are the two fields
  // mergeWithEmbedded gives to the live payload first, so a cache that disagrees
  // with models.json there is holding a live observation, not stale curation.
  assert.deepEqual(stale.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(stale.contextWindow, 131072);
});

test("keeps a cached compat block when curation has none", () => {
  // Not "live-derived": the live transform never writes compat, so on a curated
  // id a cached block can only have come from an earlier models.json — which is
  // exactly why dropping it is not propagated here, and why removing compat from
  // models.json needs the cache deleted (add-model says so).
  writeCache([model({ id: "m", compat: { maxTokensField: "max_tokens" } })]);

  const [stale] = loadStaleModels([model({ id: "m" })]);

  assert.deepEqual(stale.compat, { maxTokensField: "max_tokens" });
});

test("leaves a live-only cached entry alone, since curation has nothing to correct it with", () => {
  writeCache([
    model({ id: "live-only", api: "openai-completions", baseUrl: "https://stale.test/v1", input: ["text"] }),
  ]);

  const [stale] = loadStaleModels([]);

  assert.equal(stale.api, "openai-completions");
  assert.equal(stale.baseUrl, "https://stale.test/v1");
  assert.deepEqual(stale.input, ["text"]);
});

test("keeps cached cost and context window when the curated entry differs", () => {
  writeCache([
    model({ id: "m", contextWindow: 500000, cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }),
  ]);
  const curated = [
    model({ id: "m", contextWindow: 1000000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }),
  ];

  const [stale] = loadStaleModels(curated);

  assert.equal(stale.contextWindow, 500000);
  assert.deepEqual(stale.cost, { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
});

test("no model is both curated and deprecated", async () => {
  // A half-finished move — the entry added to deprecated-models.json but not
  // removed from models.json — is otherwise silent: withDeprecated keeps the base
  // entry on an id conflict, so the model still appears exactly once and the
  // deprecation simply never happens.
  const curated = JSON.parse(
    await readFile(new URL("../models.json", import.meta.url), "utf8"),
  ) as { id: string }[];
  const deprecated = JSON.parse(
    await readFile(new URL("../deprecated-models.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const curatedIds = new Set(curated.map((m) => m.id));

  assert.deepEqual(
    Object.keys(deprecated).filter((id) => curatedIds.has(id)),
    [],
  );
});

test("every deprecated model carries a parseable deprecation date", async () => {
  // `activeDeprecatedModels` skips an entry whose `deprecatedAt` does not parse,
  // so a missing or typo'd date silently removes the model today instead of after
  // the 14-day grace it was meant to get.
  const deprecated = JSON.parse(
    await readFile(new URL("../deprecated-models.json", import.meta.url), "utf8"),
  ) as Record<string, { deprecatedAt?: unknown }>;

  const unparseable = Object.entries(deprecated)
    .filter(([, entry]) => typeof entry.deprecatedAt !== "string" || Number.isNaN(Date.parse(entry.deprecatedAt)))
    .map(([id]) => id);

  assert.deepEqual(unparseable, []);
});

// ─── buildModels ──────────────────────────────────────────────────────────────

test("keeps tiers through a cost patch, and lets the patch replace them", () => {
  const tiers = [{ inputTokensAbove: 100000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }];
  const replacement = [{ inputTokensAbove: 250000, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }];
  const base = [model({ id: "m", cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, tiers } })];

  const [patched] = buildModels(base, [], { m: { cost: { output: 6 } } });
  const [replaced] = buildModels(base, [], { m: { cost: { tiers: replacement } } });

  assert.equal(patched.cost.output, 6);
  assert.deepEqual(patched.cost.tiers, tiers);
  assert.deepEqual(replaced.cost.tiers, replacement);
});

test("applies a patch to a base model, merging cost and compat and dropping a stale thinking format", () => {
  const base = [
    model({
      id: "m",
      reasoning: true,
      cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0.2 },
      compat: { supportsStore: false, thinkingFormat: "deepseek" },
    }),
  ];

  const [patched] = buildModels(base, [], {
    m: { reasoning: false, cost: { output: 2 }, compat: { maxTokensField: "max_tokens" } },
  });

  assert.equal(patched.reasoning, false);
  assert.deepEqual(patched.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
  assert.deepEqual(patched.compat, { supportsStore: false, maxTokensField: "max_tokens" });
});

test("lets a custom model replace the base entry with the same id", () => {
  const base = [model({ id: "m", name: "Base", cost: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 } })];
  const custom = [model({ id: "m", name: "Custom", cost: { input: 7, output: 7, cacheRead: 7, cacheWrite: 7 } })];

  const [merged] = buildModels(base, custom, {});

  assert.equal(merged.name, "Custom");
  assert.equal(merged.cost.input, 7);
});

test("applies a patch to a custom model", () => {
  const custom = [model({ id: "c", name: "Custom" })];

  // By id, not [0]: buildModels also appends the grace-period deprecated models,
  // so with an empty base the first entry is whichever deprecation happens to be
  // inside its 14-day window — a result that depends on today's date.
  const patched = buildModels([], custom, { c: { name: "Patched" } }).find((m) => m.id === "c");

  assert.equal(patched?.name, "Patched");
});

test("applies a patch to a custom model that also has a curated entry", () => {
  const base = [model({ id: "m", name: "Base" })];
  const custom = [model({ id: "m", name: "Custom" })];

  const [patched] = buildModels(base, custom, { m: { name: "Patched" } });

  assert.equal(patched.name, "Patched");
});

test("drops a patch whose id is in neither the base nor the custom list", () => {
  const result = buildModels([model({ id: "base" })], [], { ghost: { name: "Ghost" } });

  assert.equal(result.find((m) => m.id === "ghost"), undefined);
});
