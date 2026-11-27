# Editing an opencode-go model entry

Part of the [`add-model`](../SKILL.md) skill. Read `../SKILL.md` first for the
merge rule, the field list and the `models.json` skeleton; this file is the long
form behind them.

## Base URL

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

## Thinking levels

- **thinking levels / effort** — which of `off, minimal, low, medium, high,
  xhigh, max` the model supports. If the API advertises an `effort` list, map
  each supported level to itself and the rest to `null`. Treat the API's
  `"none"` effort level as pi's `"off"` level (i.e. `"off": "none"`), since
  pi has no `"none"` level. If the model only
  toggles reasoning or uses a budget (no effort list), **omit**
  `thinkingLevelMap` entirely so pi falls back to its default level set.

## Reading the payload

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
`reasoning` row of the `mergeWithEmbedded()` table in [`../SKILL.md`](../SKILL.md).

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
- Do not synthesize an all-`null` `thinkingLevelMap`; **Base URL** and
  **Thinking levels** above own those two rules, and `../SKILL.md` owns the
  summary — this file is the long form, not a second copy.
