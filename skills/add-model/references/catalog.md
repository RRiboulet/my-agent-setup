# Cost tiers and deprecation

Part of the [`add-model`](../SKILL.md) skill. Load it when the model is priced
per context tier, or when the API stops serving an id.

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
in `models.json` needs the cache deleted (see [`editing.md`](editing.md)
§ After editing) before it shows up offline.

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
