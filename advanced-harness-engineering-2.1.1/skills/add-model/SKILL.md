---
name: add-model
description: "Add or fix a model in the opencode-go provider. Use when: a model is missing or stale; shows as non-reasoning; or has wrong or missing thinking levels."
---

# Manually adding / fixing a model in the opencode-go provider

> **Harness note:** Specific to the pi harness's `.pi/extensions/opencode-go-provider/` extension; not used on Copilot CLI.

Use this skill when a model in the OpenCode Go provider is missing, shows up as
non-reasoning, or has the wrong/missing thinking levels (e.g. `beam-free`
showing no reasoning where it should support `low/medium/high/xhigh/max`).

The provider lives in `.pi/extensions/opencode-go-provider/`. Its model data
comes from four sources, merged in this order:

1. **Embedded** `models.json` — curated list, works offline.
2. **Live API** `/v1/models` — revalidates in the background; new models
   appear here first.
3. **`custom-models.json`** — user-added models.
4. **`patch.json`** — overrides applied on top of any of the above.

`mergeWithEmbedded()` then merges a curated entry with its live counterpart
**per field**. Curation does not win everything: it owns the static routing and
presentation fields, while the live payload owns the observations only it can
make. The table is the whole rule, and nothing else in this skill should be read
as "a curated entry always beats the live API":

| field | winner |
|---|---|
| `name`, `input`, `compat`, `maxTokens`, `api`, `baseUrl` | curated |
| `cost` — the four flat rates and `tiers` | live, **per field**, when it reports a non-zero number; curated fills the zeros, and curated `tiers` are used only when the live payload reports none |
| `contextWindow` | live → curated → `131072` |
| `reasoning` | curated, **except** an explicit live `capabilities.reasoning.supported: false`, which demotes it to `false` |
| `thinkingLevelMap` | curated if present, else live; dropped entirely on a demotion |

So editing `models.json` is authoritative for the fields curation owns, while a
curated `cost` or `contextWindow` is a fallback: the live payload overwrites it
as soon as the API reports a value. That asymmetry is deliberate — a price is an
observation, and curation is the only thing that can supply one offline.

## Curate only what the live API cannot say

Because curation outranks the payload for routing and presentation, it is a claim
that keeps winning when the model is later re-priced or re-pointed — so it is
right for the things the payload has no field for (`compat`, a display name where
the payload's is unusable, a thinking map for a model whose `effort` list is
ambiguous or missing) and wrong as a copy of data the transform already derives.

The worked example is `claude-haiku-5-5`, which is live-only on purpose. Since
#117 the payload says everything that matters about it — `anthropic-messages` on
`inference/go/anthropic`, 1M context / 128K output, image input, effort
`low…max`, and pricing with a `>100K` tier — and no curated `anthropic-messages`
entry carries `compat`, so an entry would add no field at all while pinning
`maxTokens` and `contextWindow` against later payload corrections. The trade is
that a live-only model is absent offline.

Curate when the payload is wrong or silent about something a request depends on,
when the model is worth having offline, or when its live data has drifted once
already.

## What lives where

Load a reference only when its branch applies — the body is the rule.

| Reference | Load it when |
|---|---|
| [`references/editing.md`](references/editing.md) | you need the long form behind a field: the `baseUrl` reasoning, the level-by-level `thinkingLevelMap` rule, the payload's shape checks, the one-model `curl` dump, alternative edits, the cache and test steps after editing, or the common pitfalls |
| [`references/catalog.md`](references/catalog.md) | the model is priced per context tier, or the API stopped serving its id and you are deprecating it |

## What the user must provide

Ask the user for (or look up from the live API / pi-ai bundled data):

| field | supply |
|---|---|
| `id`, `name` | the id exactly as the API reports it (`beam-free`) and a display name (`Beam Free`) |
| `api` | `openai-completions` (default for opencode-go) or `anthropic-messages` |
| `baseUrl` | the canonical endpoint for the model's `api`, not the URL the payload advertises: `https://opencode.ai/zen/go/v1` for `openai-completions`, `https://opencode.ai/zen/go` for `anthropic-messages` — **without** the trailing `/v1`, which pi's Anthropic client appends itself |
| `reasoning` | `true` / `false` — an omitted `capabilities.reasoning` is an absent fact, not `false`; check the payload before writing `false` |
| `thinkingLevelMap` | each supported level of `off, minimal, low, medium, high, xhigh, max` mapped to itself and the rest to `null`; the API's `"none"` is pi's `"off"`; **omit** the map for a toggle- or budget-only model |
| `input` | `["text"]` and/or `"image"` |
| `cost` | `input/output/cacheRead/cacheWrite` per 1M tokens (0 for free); a model priced per context tier also needs `tiers` |
| `contextWindow`, `maxTokens` | the two limits the API reports |
| `compat` | at minimum `supportsStore: false`, `supportsDeveloperRole: false`, `supportsStrictMode: true`, `maxTokensField: "max_tokens"`; add `thinkingFormat` (e.g. `deepseek`, `qwen`) and `requiresReasoningContentOnAssistantMessages` when the API needs them |

## Manual edit: add to `models.json` (recommended)

Append an entry to `.pi/extensions/opencode-go-provider/models.json`:

```json
{
  "id": "beam-free",
  "name": "Beam Free",
  "api": "openai-completions",
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null,
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "max"
  },
  "input": ["text"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "contextWindow": 1048576,
  "maxTokens": 131072,
  "compat": {
    "supportsStore": false,
    "supportsDeveloperRole": false,
    "supportsStrictMode": true,
    "maxTokensField": "max_tokens"
  }
}
```

Omit `thinkingLevelMap` for toggle/budget-only reasoning models. The cache delete
and the provider tests that make the entry live are in
[`references/editing.md`](references/editing.md) § After editing.
