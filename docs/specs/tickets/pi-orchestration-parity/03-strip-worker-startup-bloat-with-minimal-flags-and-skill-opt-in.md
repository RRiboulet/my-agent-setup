---
status: done
blocked-by: []
---

# 03: Strip worker startup bloat with minimal flags and explicit skill opt-in

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Eliminate cold-cache startup token overhead in spawned subagent worker processes while preserving provider model resolution and targeted skill loading:

1. Build child worker Pi invocation arguments with `--no-extensions`, `--no-skills`, `--no-mcp`, `--no-prompt-templates`, and `--no-themes` enabled by default so workers do not re-discover unrelated extensions, the full skill frontmatter index, MCP servers, prompt templates, or themes.
2. Explicitly load only the child subagent runtime extension via the single default `--extension` flag plus any explicitly configured worker provider extensions, allowing `models.json`-backed providers to run with zero extra extensions while keeping extension-registered providers allowlist-configurable.
3. Add optional per-task `skills` opt-in support to `subagent` dispatches so delegated tasks needing specific skills pass repeatable `--skill` arguments with resolved skill paths.
4. Keep `standalone` as the default handoff mode, preserve the single `--extension` default and `@prompt` as the final argv element, preserve native `models.json` loading in workers, and leave `/btw`'s shared Pi invocation helper untouched.

## Scope
Child worker argument construction, worker provider extension allowlist configuration, optional `skills` opt-in parameter on `subagent` dispatches, and associated unit tests. Leaves `handoff: "fork"` delegation gating (`02`), compact wait/status summaries (`04`), and `/btw` invocation untouched.

## Acceptance criteria
- [x] Spawned worker processes default to `--no-extensions --no-skills --no-mcp --no-prompt-templates --no-themes` while loading only the child subagent extension plus any explicitly configured worker provider extensions.
- [x] `models.json`-backed providers continue loading natively in workers when `--no-extensions` is active.
- [x] Delegated tasks can optionally pass `skills` to attach explicit repeatable `--skill` arguments without re-enabling global skill discovery.
- [x] Default handoff remains `standalone`, single `--extension` default and trailing `@prompt` argument ordering are preserved, and `/btw`'s shared Pi invocation helper is unaffected.

## Validation
Unit tests for worker argument building and role tool configuration verify minimal startup flags, single default `--extension` plus configured worker provider extension entries, repeatable `--skill` flags when `skills` is supplied, and trailing `@prompt` placement; local smoke test spawns an `explore` worker and confirms `models.json` provider resolution works under `--no-extensions`. Covers `RB-3`.
