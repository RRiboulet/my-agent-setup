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

## What the user must provide

Ask the user for (or look up from the live API / pi-ai bundled data):

- **id** — exact model id as the API reports it (e.g. `beam-free`).
- **name** — display name (e.g. `Beam Free`).
- **api** — `openai-completions` (default for opencode-go) or
  `anthropic-messages`.
- **baseUrl** — usually `https://opencode.ai/zen/go/v1` for go-plan models.
  Free/stealth models from the broader catalog
  (`https://opencode.ai/zen/v1/models`) use
  `https://opencode.ai/inference/go/openai/v1` instead — check the entry's
  `api.chat-completions.base_url`.
- **reasoning** — `true` / `false`.
- **thinking levels / effort** — which of `off, minimal, low, medium, high,
  xhigh, max` the model supports. If the API advertises an `effort` list, map
  each supported level to itself and the rest to `null`. If the model only
  toggles reasoning or uses a budget (no effort list), **omit**
  `thinkingLevelMap` entirely so pi falls back to its default level set.
- **input** — `["text"]` and/or `"image"`.
- **cost** — `input/output/cacheRead/cacheWrite` per 1M tokens (0 for free).
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

## After editing

1. Clear the stale cache so revalidation picks up the new data:
   ```bash
   rm -f ~/.pi/agent/cache/opencode-go-models.json
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
