---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

<!-- VENDORED, NOT OURS.
     native-web-search/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/native-web-search/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     LOCAL PATCHES, all provider support beyond upstream's two: the native
     chain's default is OpenRouter, not either upstream provider.
       1. `openrouter` added as a --provider value, invoked through OpenRouter's
          `web` plugin, with `openai/gpt-4o-mini:online` as its default model id.
       2. `pickProvider` extended: upstream `0865c84` already resolved
          --provider -> `defaultProvider` in settings.json -> auth fallback;
          this adds `PI_WEB_SEARCH_PROVIDER` and the openrouter credential, and
          rejects an unrecognized explicit provider instead of silently falling
          through to another plan.
       3. Notes that OpenRouter only actually searches with a web-enabled model
          id (`:online` suffix, Perplexity Sonar); any other id silently loses
          web access — a failure that looks like a working call returning nothing.
       4. A direct-invocation guard and a `__test__` export, so the script's
          provider resolution and request shape can be unit-tested without a
          network call.
       5. 2026-11: `brave` added as a provider value and made the first choice
          whenever a key resolves (`BRAVE_API_KEY`, else the `brave`/
          `brave-search` entry in auth.json), through Brave's Web Search API
          (`/res/v1/web/search`, `X-Subscription-Token`, five results). Any
          Brave failure — missing key, 429, 422, network, zero results — falls
          through to the chain above when a native credential is configured,
          and prefixes the result with one line saying why; with none, the run
          fails with both the Brave reason and the missing credential.
          `pickNativeProvider` was split out so that fallback still
          resolves a provider when Brave was requested explicitly. No local
          quota, counter, lock file or audit log: the account's own limit is
          the only one, and a 429 is just another failure. Each rendered field
          is newline-collapsed, so a hostile title cannot forge a sibling
          result block.
       6. 2026-11: `opencode-go` removed. The Go plan's Anthropic models accept
          the `web_search` tool definition but silently answer from memory; a
          live probe returns "I can't run a live web search", and an explicit
          `tool_choice` is rejected with "the web_search hosted tool isn't
          available on OpenCode's models". OpenRouter is the native default
          again.
     Plus one behaviour note that is ours and not a patch: if the `web_search`
     tool is available in the session, prefer it and treat this skill as the
     manual fallback.

     Verified against upstream 0865c84: every function upstream defines is still
     defined here, and the thirteen added are `runOpenRouterSearch`,
     `defaultModelId`, `defaultBaseUrl`, `supportsTemperature`,
     `buildAnthropicRequest`, `pickNativeProvider`, `runNativeProvider`,
     `resolveBraveApiKey`, `runBraveSearch`, `renderBraveResults`,
     `sanitizeField`, `describeBraveFailure` and `runSearch`.
     `normalizeProvider`, `pickProvider`, `buildAnthropicHeaders`,
     `runAnthropicSearch` and `resolveApiKey` are modified rather than added.
     Nothing upstream was dropped. (The body is space-indented where upstream
     uses tabs, so compare with `diff -w`.) -->

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
node search.mjs "rust async runtime status" --provider brave
```

Optional flags:

- `--provider brave|openrouter|openai-codex|anthropic` (unset uses Brave when a key is configured, else the first provider found in `settings.json`/`auth.json`, preferring `openrouter`)
- `--model <model-id>` (OpenRouter default: `openai/gpt-4o-mini:online`; Anthropic default: `claude-haiku-5-5`)
- `--timeout <ms>`
- `--json`

## Providers

- `brave` (first choice when a key is configured): Brave's Web Search API,
  `https://api.search.brave.com/res/v1/web/search`, five results per query. The
  key comes from `BRAVE_API_KEY`, else the `brave`/`brave-search` entry in
  `auth.json`. There is no local quota or accounting: the account's own limit is
  the only one, and a usage/rate-limit answer (HTTP 429) is just another failure
  that falls back to the native chain below when a native credential is
  configured, with one line at the top of the result saying why. With no native
  credential it fails instead, naming both the Brave failure and the missing
  credential. No usage block is printed.
- `openrouter` (the native default when credentials exist): native web search via
  the OpenRouter `web` plugin; requires a web-enabled model id such as
  `openai/gpt-4o-mini:online` or `perplexity/sonar`.
- `openai-codex`: native `web_search` tool through the ChatGPT backend.
- `anthropic`: native `web_search_20260318` tool (OAuth or API key).

## Output expectations

The script instructs the model to:

- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Notes

- No extra npm install is required.
- Provider precedence: `--provider` flag > `PI_WEB_SEARCH_PROVIDER` > Brave (when a key is configured) > `defaultProvider` in `settings.json` > first available credential in `auth.json` (`openrouter`, then `openai-codex`, then `anthropic`). The script reads `PI_WEB_SEARCH_PROVIDER` itself, so a standalone invocation follows the same order; the `web_search` tool omits `--provider` when nothing is set, which is what lets Brave, `settings.json` and `auth.json` decide. A Brave failure falls back to the native chain even when `--provider brave` was explicit, provided a native credential is configured; the result's first line names the reason and never contains a response body or stack trace. Without one, the error names both the Brave failure and the credential that is missing from `auth.json`, because a Brave-only machine cannot reach the fallback.
- An unrecognized `--provider` (or `PI_WEB_SEARCH_PROVIDER`) is an error, and an unknown explicit provider is rejected rather than resolved, so a typo cannot quietly spend another plan's budget. An unrecognized `settings.defaultProvider` is ignored instead, because that key may name an unrelated pi provider (a local model server, say).
- `temperature` is omitted for `claude-haiku-5-5` on any provider; omitting it is safe because the API default applies.
- OpenRouter only works with web-enabled model ids (`:online` suffix, Perplexity Sonar models); other model ids silently lose web access.
- `opencode-go` was removed as a provider: the Go plan's Anthropic models accept the `web_search` tool definition but silently answer from memory. A live probe against `https://opencode.ai/zen/go/v1/messages` and `https://opencode.ai/inference/go/anthropic/v1/messages` returned "I can't run a live web search", and an explicit `tool_choice` was rejected with "the web_search hosted tool isn't available on OpenCode's models". The Go plan remains available as a pi model provider; it is simply not a web-search provider.
- If module resolution fails, set `PI_AI_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/index.js` path.
- If OAuth helper resolution fails, set `PI_AI_OAUTH_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/oauth.js` path.
- For OAuth providers, the script can fall back to a still-valid cached `access` token from `~/.pi/agent/auth.json`.
