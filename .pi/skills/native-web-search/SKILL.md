---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

<!-- VENDORED, NOT OURS.
     native-web-search/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/native-web-search/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     Three LOCAL PATCH hunks, all of them OpenRouter support, since this machine
     authenticates through OpenRouter and not through either upstream provider:
       1. `openrouter` added as a third --provider value, invoked through
          OpenRouter's `web` plugin, with `openai/gpt-4o-mini:online` as its
          default model id.
       2. A provider-precedence resolver: the --provider flag, then
          `defaultProvider` in settings.json, then the first credential present
          in auth.json (openrouter, openai-codex, anthropic). Upstream required
          an explicit provider.
       3. Notes that OpenRouter only actually searches with a web-enabled model
          id (`:online` suffix, Perplexity Sonar); any other id silently loses
          web access — a failure that looks like a working call returning nothing.
     Plus one behaviour note that is ours and not a patch: if the `web_search`
     tool is available in the session, prefer it and treat this skill as the
     manual fallback.

     Verified against upstream 0865c84 on 2026-10-05: every function upstream
     defines is still defined here, and the three added are `runOpenRouterSearch`,
     `defaultModelId` and `defaultBaseUrl`. Nothing upstream was dropped. -->

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
node search.mjs "rust async runtime status" --provider perplexity/sonar --model perplexity/sonar-pro
```

Optional flags:

- `--provider openrouter|openai-codex|anthropic` (defaults to the first provider found in `settings.json`/`auth.json`, preferring `openrouter`)
- `--model <model-id>` (OpenRouter default: `openai/gpt-4o-mini:online`)
- `--timeout <ms>`
- `--json`

## Providers

- `openrouter` (default when credentials exist): native web search via the OpenRouter `web` plugin; requires a web-enabled model id such as `openai/gpt-4o-mini:online` or `perplexity/sonar`.
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
- Provider precedence: `--provider` flag > `defaultProvider` in `settings.json` > first available credential in `auth.json` (`openrouter`, then `openai-codex`, then `anthropic`).
- OpenRouter only works with web-enabled model ids (`:online` suffix, Perplexity Sonar models); other model ids silently lose web access.
- If module resolution fails, set `PI_AI_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/index.js` path.
- If OAuth helper resolution fails, set `PI_AI_OAUTH_MODULE_PATH` to `@earendil-works/pi-ai`'s `dist/oauth.js` path.
- For OAuth providers, the script can fall back to a still-valid cached `access` token from `~/.pi/agent/auth.json`.
