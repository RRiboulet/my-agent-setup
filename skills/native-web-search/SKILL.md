---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

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