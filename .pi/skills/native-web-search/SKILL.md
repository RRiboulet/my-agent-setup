---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

<!-- VENDORED, NOT OURS.
     native-web-search/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/native-web-search/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     LOCAL PATCHES, all provider support beyond upstream's two, since this
     machine authenticates through opencode-go and OpenRouter rather than
     through either upstream provider:
       1. `openrouter` added as a --provider value, invoked through OpenRouter's
          `web` plugin, with `openai/gpt-4o-mini:online` as its default model id.
       2. `opencode-go` added as the preferred --provider value, invoked through
          the Go API's Anthropic-compatible `/messages` endpoint (native
          `web_search_20250305`), with `claude-haiku-5-5` as its default model
          id and the `x-opencode-session`/`x-opencode-client` headers the Go API
          requires (a request without a session header is rejected outright).
       3. `pickProvider` extended: upstream `0865c84` already resolved
          --provider -> `defaultProvider` in settings.json -> auth fallback;
          this adds `PI_WEB_SEARCH_PROVIDER` and the opencode-go/openrouter
          credentials, and rejects an unrecognized explicit provider instead of
          silently falling through to another plan.
       4. Notes that OpenRouter only actually searches with a web-enabled model
          id (`:online` suffix, Perplexity Sonar); any other id silently loses
          web access — a failure that looks like a working call returning nothing.
       5. A direct-invocation guard and a `__test__` export, so the script's
          provider resolution and request shape can be unit-tested without a
          network call.
     Plus one behaviour note that is ours and not a patch: if the `web_search`
     tool is available in the session, prefer it and treat this skill as the
     manual fallback.

     Verified against upstream 0865c84: every function upstream defines is still
     defined here, and the six added are `runOpenRouterSearch`,
     `opencodeGoHeaders`, `defaultModelId`, `defaultBaseUrl`,
     `supportsTemperature` and `buildAnthropicRequest`. `normalizeProvider`,
     `pickProvider`, `buildAnthropicHeaders`, `runAnthropicSearch` and
     `resolveApiKey` are modified rather than added. Nothing upstream was
     dropped. (The body is space-indented where upstream uses tabs, so compare
     with `diff -w`.) -->

# Native Web Search

Use this skill to run a **fast model with native web search enabled** and get a concise research summary with explicit full URLs.

If the `web_search` tool is available in the session, prefer it — this skill is the manual fallback.

## Script

- `search.mjs` (in this skill directory)

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
node search.mjs "rust async runtime status" --provider openrouter --model perplexity/sonar-pro
node search.mjs "rust async runtime status" --provider opencode-go --model claude-haiku-5-5
```

Optional flags:

- `--provider opencode-go|openrouter|openai-codex|anthropic` (defaults to the first provider found in `settings.json`/`auth.json`, preferring `opencode-go`)
- `--model <model-id>` (opencode-go default: `claude-haiku-5-5`; OpenRouter default: `openai/gpt-4o-mini:online`)
- `--timeout <ms>`
- `--json`

## Providers

- `opencode-go` (preferred when credentials exist): native `web_search_20250305`
  through opencode.ai's Go API (`https://opencode.ai/zen/go/v1/messages`),
  billed against the Go plan. Requires a Go API key in `auth.json` under
  `opencode-go` or `OPENCODE_API_KEY` in the environment, and uses a
  web-capable Anthropic-protocol model — `claude-haiku-5-5` by default, the one
  verified to carry the server-side search tool. The Go API rejects a request
  without an `x-opencode-session` header; the script sends one per run.
- `openrouter`: native web search via the OpenRouter `web` plugin; requires a
  web-enabled model id such as `openai/gpt-4o-mini:online` or
  `perplexity/sonar`.
- `openai-codex`: native `web_search` tool through the ChatGPT backend.
- `anthropic`: native `web_search_20250305` tool (OAuth or API key).

## Output expectations

The script instructs the model to:

- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Notes

- No extra npm install is required.
- Provider precedence: `--provider` flag > `PI_WEB_SEARCH_PROVIDER` > `defaultProvider` in `settings.json` > first available credential in `auth.json` (`opencode-go`, then `openrouter`, then `openai-codex`, then `anthropic`). The script reads `PI_WEB_SEARCH_PROVIDER` itself, so a standalone invocation follows the same order; the `web_search` tool omits `--provider` when nothing is set, which is what lets `settings.json` and `auth.json` decide.
- An unrecognized `--provider` (or `PI_WEB_SEARCH_PROVIDER`) is an error, not a fallback: a typo must not quietly spend another plan's budget. An unrecognized `settings.defaultProvider` is ignored instead, because that key may name an unrelated pi provider (a local model server, say).
- `temperature` is omitted for every `opencode-go` request (the endpoint rejected it for the search model) and for `claude-haiku-5-5` on any provider; omitting it is safe because the API default applies.
- OpenRouter only works with web-enabled model ids (`:online` suffix, Perplexity Sonar models); other model ids silently lose web access.
- opencode-go searches with an Anthropic-protocol model; an OpenAI-Completions model id from that provider will not have the tool and the call will fail rather than silently answer from memory.
- If module resolution fails, set `PI_AI_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/index.js` path.
- If OAuth helper resolution fails, set `PI_AI_OAUTH_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/oauth.js` path.
- For OAuth providers, the script can fall back to a still-valid cached `access` token from `~/.pi/agent/auth.json`.
