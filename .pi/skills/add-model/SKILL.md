---
name: add-model
description: "Read this skill before manually adding or fixing a model in the opencode-go provider (thinking levels, reasoning, metadata)"
---

# Manually adding / fixing a model in the opencode-go provider

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

## What the user must provide

Ask the user for (or look up from the live API / pi-ai bundled data):

- **id** — exact model id as the API reports it (e.g. `beam-free`).
- **name** — display name (e.g. `Beam Free`).
- **api** — `openai-completions` (default for opencode-go) or
  `anthropic-messages`.
- **baseUrl** — the canonical endpoint for the model's `api`, not the URL the
  payload advertises:
  - `openai-completions`: `https://opencode.ai/zen/go/v1`, the provider's
    `BASE_URL` in `index.ts`.
  - `anthropic-messages`: `https://opencode.ai/zen/go` — **without** the
    trailing `/v1`, because pi's Anthropic client appends `/v1/messages`
    itself. Keeping the `/v1` requests `/v1/v1/messages`, which 404s (verified
    against the live endpoint on 2026-11-10).

  The payload advertises `inference/go/openai/v1` for chat and
  `inference/go/anthropic/v1` for messages. Those are **aliases**, not the
  manual default: both gateways answered 200 for the ids tested (`beam-free`,
  `claude-haiku-5-5`), so this is not a matter of one working and one not.
  `api`/`baseUrl` are curated-wins fields, so a hand entry pins its URL and
  never inherits the payload's. `transformApiModel` reads the advertised
  `base_url` (stripping a trailing `/v1` from the messages one) for live-only
  models, which is why those may sit on the alias. There is one deliberate
  curated exception in `models.json`: `longcat-2.5-free` is pinned to
  `https://opencode.ai/inference/go/openai/v1` because that is the endpoint it
  was curated against (#138). Leave it there, and do not "fix" a curated alias
  unless you can show the model answers on the canonical URL — a curated
  `baseUrl` keeps winning over whatever the payload advertises.
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

### The payload is untrusted

`transformApiModel` checks shapes rather than trusting the response, so a value
is only evidence once it is well-formed:

- a `base_url` that is not a non-blank string is ignored and the provider
  default is used, instead of registering — and caching — a URL the SDK then
  throws on for every request;
- a `modalities.input` that is not an array means text-only, and a `limit` that
  is absent leaves `contextWindow` at `null` rather than inventing `131072`;
- a rate that is not a finite, non-negative number never reaches the model: in a
  tier override the override is skipped, and in the four flat rates the value
  falls back to 0 (`nonNegativeNumber`). A string or negative `price` therefore
  cannot cache as `NaN`, cannot win over the curated rate through the truthiness
  rule the merge uses, and cannot produce an element the cache reader refuses on
  the next start;
- `transformApiModels` wraps each entry, so one malformed model no longer
  discards the whole refresh.

So do not copy a field out of the payload without looking at its shape first,
and do not read "the API omitted it" as "the API denied it" — see the
`reasoning` row of the table above.

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
  shouldn't be curated. `buildModels` merges them in, and they win over a base
  entry with the same id.
- **`patch.json`** — overrides keyed by model id. A patch cannot *create* a
  model, but it refines either list: a patch whose id is in `models.json` (or in
  the grace-period `deprecated-models.json`) patches that entry, and a patch
  whose id is in `custom-models.json` patches the custom entry, so a user-local
  addition can be corrected without editing it. A patch id in **neither** list
  is silently dropped — no warning, nothing registered.
- **Live derivation** — `transformApiModel` derives `reasoning` +
  `thinkingLevelMap` from `capabilities.reasoning` automatically when an
  `effort` list is present. No manual edit needed if the API advertises it;
  the only gap is offline/cached stale data.

## Cost tiers

Some models are priced per context tier: one rate for requests up to 100K input
tokens and a higher one above. pi does not blend the two. `calculateCost` picks
the **highest** tier whose `inputTokensAbove` the request's total input exceeds
and reprices the **whole request** at that tier, so a 150K-token request pays the
higher rate on all 150K, not the lower rate on the first 100K:

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
`cost.text.output.overrides`) is mapped onto one tier per threshold by
`transformApiModel` — normally nothing to curate by hand. Only an open-ended band
keyed on exactly `{ "gt": N }` is mapped:

- a `gte` threshold is dropped, not translated. pi matches a tier with a strict
  `>`, so `gte: N` would have to become `inputTokensAbove: N - 1`; the obvious
  `N` is one token short, and `N + 1` narrows the tier from the other side. No
  recorded `when.context` band uses `gte`, so that arithmetic is not worth
  carrying for a shape the API has never sent;
- a bounded band (`{ "gt": N, "lte": M }`) is not a pi tier at all — pi tiers
  have no upper bound — and is skipped, because flattening it to "above N" would
  charge every request beyond the threshold at that rate.

A skipped override is silent: the model keeps the flat rate. A rate an override
does not list keeps the base price, where opencode's own runtime would treat it
as 0.

Two things are ignored on purpose: `cost.multipliers` (peak-hour pricing) has no
pi counterpart at all, and an override conditioned on anything outside the
`when.context` band — a `service_tier`, a region, a time window — is skipped
rather than partly mapped, because promoting it into a permanent rate would
misprice silently.

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
directly separates the three ways an id can vanish from the list. Probe the
model's own advertised `base_url` when the live payload gives one — some models
advertise `inference/go/openai/v1` rather than the curated default, and the two
gateways need not answer alike:

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
   The cache is stamped with a `format` version and a file whose marker is
   missing or older is ignored rather than served, so an upgrade costs one cold
   start instead of replaying the previous transform's routing.
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
- Use the canonical `baseUrl` for the model's `api` — `…/zen/go/v1` for
  `openai-completions`, `…/zen/go` (no `/v1`) for `anthropic-messages` — not the
  `inference/go/...` URL the payload advertises, which is the alias the live
  transform uses for API-only models. The one curated alias in `models.json`,
  `longcat-2.5-free`, is deliberate (#138);
