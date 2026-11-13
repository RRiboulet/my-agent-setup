---
name: add-model
description: "Read this skill before manually adding or fixing a model in the opencode-go provider (thinking levels, reasoning, metadata)"
---

# Manually adding / fixing a model in the opencode-go provider

Use this skill when a model in the OpenCode Go provider is missing, shows up as
non-reasoning, or has the wrong/missing thinking levels (e.g. `beam-free`
showing no reasoning where it should support `low/medium/high/xhigh/max`).

The provider lives in `.pi/extensions/opencode-go-provider/`. Its model data
comes from three sources, merged in this order:

1. **Embedded** `models.json` — curated list, works offline.
2. **Live API** `/v1/models` — revalidates in the background; new models
   appear here first.
3. **`custom-models.json`** — user-added models.
4. **`patch.json`** — overrides applied on top of any of the above.

`mergeWithEmbedded()` lets the embedded entry win for `reasoning`,
`thinkingLevelMap`, `input`, `compat`, etc., so a curated entry always beats
the live API. That is why editing `models.json` is the most reliable fix.

## Curate only what the live API cannot say

Because a curated entry outranks the payload, it is a claim that keeps winning
when the model is later re-priced or re-pointed — so it is right for the things
the payload has no field for (`compat`, a display name where the payload's is
unusable, a thinking map for a model whose
`effort` list is ambiguous or missing) and wrong as a copy of data the transform
already derives.

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

## What the user must provide

Ask the user for (or look up from the live API / pi-ai bundled data):

- **id** — exact model id as the API reports it (e.g. `beam-free`).
- **name** — display name (e.g. `Beam Free`).
- **api** — `openai-completions` (default for opencode-go) or
  `anthropic-messages`.
- **baseUrl** — usually `https://opencode.ai/zen/go/v1` for go-plan models.
  Free/stealth models from the broader catalog
  (`https://opencode.ai/zen/v1/models`) use
  `https://opencode.ai/inference/openai/v1` instead, while go-plan models
  from the go catalog (`https://opencode.ai/zen/go/v1/models`) use
  `https://opencode.ai/inference/go/openai/v1` — check the entry's
  `api.chat-completions.base_url`.
- **reasoning** — `true` / `false`.
- **thinking levels / effort** — which of `off, minimal, low, medium, high,
  xhigh, max` the model supports. If the API advertises an `effort` list, map
  each supported level to itself and the rest to `null`. Treat the API's
  `"none"` effort level as pi's `"off"` level (i.e. `"off": "none"`), since
  pi has no `"none"` level. If the model only
  toggles reasoning or uses a budget (no effort list), **omit**
  `thinkingLevelMap` entirely so pi falls back to its default level set.
- **input** — `["text"]` and/or `"image"`.
- **cost** — `input/output/cacheRead/cacheWrite` per 1M tokens (0 for free).
  A model the API prices per context tier needs `tiers` as well; see "Cost
  tiers" below.
- **contextWindow** and **maxTokens**.
- **compat** — at minimum `supportsStore: false`,
  `supportsDeveloperRole: false`, `supportsStrictMode: true`,
  `maxTokensField: "max_tokens"`. Add `thinkingFormat` (e.g. `deepseek`,
  `qwen`) and `requiresReasoningContentOnAssistantMessages` when the API needs
  them.

Tip: the live API already exposes all of this:

```bash
curl -s -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/go/v1/models | python3 -c "
import json,sys
d=json.load(sys.stdin); models=d if isinstance(d,list) else d.get('data',[])
for m in models:
    if m['id']=='<MODEL_ID>':
        print(json.dumps(m, indent=2))
"
```

Look at `capabilities.reasoning` for supported/effort.

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

Omit `thinkingLevelMap` for toggle/budget-only reasoning models.

## Alternative edits

- **`custom-models.json`** — same schema; use for user-local additions that
  shouldn't be curated. `buildModels` merges them in.
- **`patch.json`** — overrides for a model that already exists in the base
  list (e.g. to fix `thinkingLevelMap` or `compat`). Cannot create a new model.
- **Live derivation** — `transformApiModel` derives `reasoning` +
  `thinkingLevelMap` from `capabilities.reasoning` automatically when an
  `effort` list is present. No manual edit needed if the API advertises it;
  the only gap is offline/cached stale data.

## Cost tiers

Some models are priced per context tier: the first 100K tokens of a request cost
one rate and everything past it another. pi models this as
`cost.tiers`, and `calculateCost` applies the **highest** tier whose
`inputTokensAbove` the request's total input exceeds, to the whole request:

```json
"cost": {
  "input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125,
  "tiers": [
    { "inputTokensAbove": 100000, "input": 0.5, "output": 2.5,
      "cacheRead": 0.05, "cacheWrite": 0.625 }
  ]
}
```

All four rates are required in a tier, because all four apply once it matches.
Tiers are shared across input and output, so a payload that lists its tiers as
two parallel arrays (`cost.text.input.overrides` and
`cost.text.output.overrides`, each keyed by `when.context.gt`) is mapped onto one
tier per threshold by `transformApiModel` — normally nothing to curate by hand.
A rate an override does not list keeps the base price.

Two things are ignored on purpose: `cost.multipliers` (peak-hour pricing) has no
pi counterpart at all, and an override conditioned on anything other than
`when.context.gt` cannot be expressed as a tier.

`cost` is one of the fields the stale path serves from the cache, so a tier edit
in `models.json` needs the cache deleted (see "After editing") before it shows
up offline.

## Deprecating a model

When the API stops serving a model id, do not delete the entry: move it from
`models.json` to `deprecated-models.json`, keyed by id and stamped with
`deprecatedAt` (UTC ISO 8601). `activeDeprecatedModels()` keeps serving it for
`DEPRECATED_MODEL_TTL_MS` (14 days), so a saved model setting or an in-flight
session is not yanked mid-run, then evicts it; an entry whose date does not parse
is evicted immediately instead.

`scripts/update-models.js` is what normally performs the move, and it is not
vendored into this tree, so here it is hand work. A half-finished move is silent:
`withDeprecated` keeps the curated entry on an id conflict, so the model still
appears exactly once and the deprecation never happens. `tests/models.test.ts`
pins both that and the date.

Establish that the id is dead before deprecating it. Asking the endpoint
directly separates the three ways an id can vanish from the list:

```bash
curl -sS -H "Authorization: Bearer $OPENCODE_API_KEY" -H 'User-Agent: pi/1.0' \
  -H 'Content-Type: application/json' -H "x-opencode-session: probe-$$" \
  -H 'x-opencode-client: pi' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"Say ok"}],"max_tokens":8}' \
  https://opencode.ai/zen/go/v1/chat/completions
```

- `400 "Upstream request failed: Model is unavailable."` — the id no longer
  resolves. Deprecate it.
- `410 "ModelDeprecated: Model <id> has been deprecated. Use <successor> instead."`
  — deprecated upstream, and it names the replacement. Deprecate it and look at
  the successor rather than guessing one.
- `403 "Model access is disabled."` — the model exists and this account has it
  switched off in the console. Leave the entry alone.
- `400 MissingSessionID` — the probe is missing `x-opencode-session`, which the
  provider sends on every request.

Absence from `/zen/go/v1/models` proves nothing on its own: what that endpoint
returns depends on the credential (6 ids for this account, a wider catalogue
unauthenticated, so do not quote a count), and models can be switched off per
model in the console, so most of `models.json` is legitimately missing from both.

## After editing

1. Clear the stale cache if you changed a field it serves. `api`, `baseUrl`,
   `input`, `name`, `maxTokens`, `reasoning` and `thinkingLevelMap` are refreshed
   from `models.json` on the stale (offline) path, plus `compat` when the entry
   defines one, so those edits need no delete — but *removing* `compat`, `api` or
   `baseUrl` from an entry does, because the cached copy stays. `cost` and
   `contextWindow` are served from the cache, so either of those needs it too:
   ```bash
   rm -f "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cache/opencode-go-models.json"
   ```
2. Run the provider tests:
   ```bash
   cd .pi/extensions/opencode-go-provider && node --test
   ```
3. Verify the JSON parses:
   ```bash
   python3 -c "import json; json.load(open('models.json')); print('ok')"
   ```
4. Restart pi / start a new session; the model should now show the configured
   reasoning levels in the `/model` picker.

## Common pitfalls

- Do **not** map `off`/`minimal` to themselves unless the API truly supports
  them; otherwise the user cannot disable reasoning.
- For xhigh/max, the map entry must be present (not `undefined`); pi treats
  a missing key as "not supported" for those two levels.
- If a model advertises no `effort` list, omitting `thinkingLevelMap` is
  correct — do not synthesize an all-`null` map.
- Keep `baseUrl` consistent with the provider's `BASE_URL` (`zen/go/v1`)
  unless the model genuinely needs the `inference/go/openai/v1` endpoint.
