/**
 * Model pipeline tests: transformApiModel → mergeWithEmbedded → loadStaleModels
 * → buildModels.
 *
 * The live payload fixture is a verbatim capture of
 * `GET https://opencode.ai/zen/go/v1/models` from 2026-11-10 (four of the six
 * models it listed), kept in the shape the API returns so the transform is fed
 * exactly what the network feeds it.
 *
 * Tests named "characterizes TODO-<id>" deliberately pin behavior that is
 * known to be wrong, so the fix for that todo has an explicit test to flip
 * rather than silently rewritten expectations.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { buildModels, loadStaleModels, mergeWithEmbedded, transformApiModel } = await import("../index.ts");

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

function writeCache(models: JsonModel[]): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(models));
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

test("characterizes TODO-4872a666: flat cost reads zero on the live cost shape", () => {
  const haiku = live("claude-haiku-5-5");
  // The payload does report pricing, under cost.text.*:
  assert.equal(haiku.cost.text.input.price, 0.1);
  assert.equal(haiku.cost.text.output.price, 0.5);
  assert.equal(haiku.cost.text.input.cache.read, 0.01);
  assert.equal(haiku.cost.text.input.cache.write, 0.125);

  const transformed = transformApiModel(haiku);
  // ...which the flat reads miss entirely:
  assert.deepEqual(transformed.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("characterizes TODO-4872a666: MIME image modalities collapse to text only", () => {
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
  assert.deepEqual(transformed.input, ["text"]);
});

test("characterizes TODO-4872a666: api and baseUrl ignore the advertised endpoint", () => {
  const haiku = live("claude-haiku-5-5");
  assert.equal(haiku.api.messages.base_url, "https://opencode.ai/inference/go/anthropic/v1");

  const transformed = transformApiModel(haiku);
  assert.equal(transformed.api, "openai-completions");
  assert.equal(transformed.baseUrl, "https://opencode.ai/zen/go/v1");

  // The openai-compatible models advertise inference/go/openai/v1 themselves,
  // but every live model currently lands on the provider default.
  const deepseek = live("deepseek-v4.1-flash");
  assert.equal(deepseek.api["chat-completions"].base_url, "https://opencode.ai/inference/go/openai/v1");
  assert.equal(transformApiModel(deepseek).baseUrl, "https://opencode.ai/zen/go/v1");
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

test("curation wins even when the live API reports no reasoning (policy pending TODO-79c4bd01)", () => {
  const liveModel = model({ id: "m", reasoning: false });
  const curated = model({ id: "m", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });

  const [merged] = mergeWithEmbedded([liveModel], [curated]);

  assert.equal(merged.reasoning, true);
  assert.deepEqual(merged.thinkingLevelMap, { low: "low", high: "high" });
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
  const cached = model({ id: "cached", name: "Cached" });
  writeCache([cached]);
  const curated = [model({ id: "cached", name: "Curated" }), model({ id: "new", name: "New" })];

  const result = loadStaleModels(curated);

  assert.deepEqual(result.map((m) => m.id), ["cached", "new"]);
  assert.equal(result[0].name, "Cached");
});

test("characterizes TODO-00690942: the stale path keeps cached reasoning and cost", () => {
  writeCache([model({ id: "m", reasoning: false, cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } })]);
  const curated = [model({ id: "m", reasoning: true, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })];

  const [stale] = loadStaleModels(curated);

  assert.equal(stale.reasoning, false);
  assert.deepEqual(stale.cost, { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 });
});

// ─── buildModels ──────────────────────────────────────────────────────────────

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

  const [patched] = buildModels([], custom, { c: { name: "Patched" } });

  assert.equal(patched.name, "Patched");
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
