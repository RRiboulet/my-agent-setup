---
status: done
blocked-by: []
---

# 01: Configure local DBX models, codemode defaults, and repository templates

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Wire the local Pi agent environment to the local DBX loopback gateway with `codemode`-first defaults and tiered subagent routing, while adding sanitized, provider-agnostic example templates and setup documentation to `advanced-harness-engineering`:

1. Configure the local Pi models file (`models.json`) to register all 7 DBX gateway models across the three local providers (`dbx` chat completions, `dbx-responses` responses API, and `dbx-claude` Anthropic messages) with accurate context window, max token, and reasoning metadata and zero embedded secrets.
2. Configure the local Pi settings file (`settings.json`) to set `dbx` as the default provider, `model_service.models.1adp-gemini-4-neon` as the default model, `medium` as the default thinking level, `tool_search` and `codemode` enabled in default tools, and `codemode` set to `"only"` mode, while preserving existing package entries.
3. Configure the local orchestrator delegation file (`orchestrator-delegation.json`) to map `explore`, `research`, `coder`, `reviewer`, and `security-reviewer` to Copilot CLI's corresponding DBX model tiers, thinking efforts, and tool sets.
4. Install `AGENTS.md` into the local Pi agent directory using the existing instructions installer in instructions-only mode.
5. Add sanitized, provider-agnostic example configuration templates and setup documentation to `advanced-harness-engineering` illustrating the same layout with placeholder endpoints and zero hardcoded loopback URLs, personal routing, or credentials.

## Scope
Local Pi agent directory configuration (`models.json`, `settings.json`, `orchestrator-delegation.json`, and installed `AGENTS.md`) plus generic example configuration templates and setup documentation in `advanced-harness-engineering`. Excludes committing machine-local loopback addresses, personal auth tokens, or personal orchestrator overrides into version control, and leaves runtime extension changes to sibling tickets.

## Acceptance criteria
- [x] Local `models.json` registers all 7 models across `dbx`, `dbx-responses`, and `dbx-claude` with accurate context window, max token, and reasoning metadata and zero secrets.
- [x] Local `settings.json` sets `defaultProvider` to `dbx`, `defaultModel` to `model_service.models.1adp-gemini-4-neon`, `defaultThinkingLevel` to `medium`, enables `tool_search` and `codemode` in `defaultTools`, sets `codemode` mode to `"only"`, and preserves `packages`.
- [x] Local `orchestrator-delegation.json` maps `explore`, `research`, `coder`, `reviewer`, and `security-reviewer` to Copilot CLI's DBX model tiers, thinking levels, and role tool sets.
- [x] Local `AGENTS.md` is installed into the Pi agent directory via the existing instructions installer.
- [x] Generic, provider-agnostic example templates and documentation are added to `advanced-harness-engineering` with zero hardcoded loopback URLs or credentials in tracked files.

## Validation
Run `pi --list-models` to verify all 7 models across `dbx`, `dbx-responses`, and `dbx-claude` are available; start an interactive `pi` session to confirm `dbx` default provider, `model_service.models.1adp-gemini-4-neon` default model, `codemode` `"only"` mode, and `enforce` delegation mode are active; verify repository validation checks pass with no secrets or loopback URLs in tracked files. Covers `RB-1`.
