---
status: done
blocked-by: ["05"]
---

# 06: Inject full orchestrator persona, mode directives, and hide parent write tool

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** 05 (Add delegation runtime test seam, codemode parity, and steer-unlock validation)
**Status:** done

## What to build
Align Pi's parent prompt persona and active tool surface with Copilot CLI's Pragmatic Orchestrator across all turn modes:

1. Upgrade `before_agent_start` delegation injection so it injects the complete Pragmatic Orchestrator role-split persona alongside per-mode directives covering all 6 turn classes into `systemPromptOptions.sections`, replacing the terse cap-only summary.
2. Emit a one-time warning when mutable `systemPromptOptions.sections` is unavailable rather than degrading silently.
3. Hide or remove `write` from parent active tools while in `enforce` mode and restore it cleanly under `!direct` or `/delegation off`, coordinating with `codemode` exposure transitions (`codemode.mode = "only"`) without breaking active-tool expectations or nested `codemode` tool lookup.

## Scope
`before_agent_start` persona and per-mode directive formatting/injection, one-time missing-sections warning, parent `write` tool hide/restore lifecycle across delegation mode transitions and `codemode` exposure, and corresponding pure plus runtime integration tests. Leaves `orchestrator_record_review` to ticket `07`.

## Acceptance criteria
- [x] `before_agent_start` injects the full Pragmatic Orchestrator role-split persona and the active mode's directive across all 6 turn classes via `systemPromptOptions.sections`.
- [x] If mutable `systemPromptOptions.sections` is unavailable, a warning is emitted once rather than repeating every turn or failing silently.
- [x] Parent `write` is hidden/removed from active tools in `enforce` mode and cleanly restored when switching into `!direct` or `/delegation off`.
- [x] Parent `write` hiding and restoration coordinate cleanly with `codemode.mode = "only"` transitions without breaking active-tool expectations or `codemode` dispatch.

## Validation
Pure delegation tests validate persona and per-mode directive formatting for all 6 turn classes; delegation-runtime integration tests verify `before_agent_start` section injection, one-time missing-sections warning, and parent `write` removal/restoration across `enforce`, `!direct`, `/delegation off`, and `codemode.mode = "only"` transitions. Covers `RB-4` and `RB-7` tool-exposure coordination.
