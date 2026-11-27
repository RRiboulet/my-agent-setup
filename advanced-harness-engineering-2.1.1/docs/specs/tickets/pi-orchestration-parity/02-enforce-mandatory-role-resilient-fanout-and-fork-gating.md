---
status: done
blocked-by: []
---

# 02: Enforce mandatory role routing, resilient fan-out patching, and fork gating

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Prevent unrouted `subagent` dispatches from silently inheriting the frontier parent model and ensure parallel fan-out evaluation handles mixed-validity entries cleanly:

1. In `enforce` mode outside `!direct`, block single `subagent` calls and any `tasks[]` fan-out entry that omits `role` (or provides an empty `role`) with an actionable denial listing all valid canonical roles, instead of skipping validation and letting the worker inherit the parent model.
2. In `warn` and `off` modes, evaluate each `tasks[]` fan-out entry independently so that a single unknown role emits a warning for that entry without discarding valid role-routing patches for sibling steps.
3. Gate `handoff: "fork"` in `enforce` mode so fork handoffs are blocked unless `!direct` override is active, preventing accidental full-transcript transplants into cold workers while keeping `standalone` as the default handoff.

## Scope
Delegation evaluation logic for `subagent` dispatches (single calls and `tasks[]` fan-outs), canonical role presence enforcement, per-entry patch resilience in `warn`/`off` modes, `handoff: "fork"` gating, and pure unit tests covering these rules. Leaves worker spawn CLI flags, parent persona injection, and runtime `codemode` hook integration to sibling tickets.

## Acceptance criteria
- [x] In `enforce` mode outside `!direct`, single `subagent` dispatches omitting `role` are blocked with a clear error naming valid canonical roles.
- [x] In `enforce` mode outside `!direct`, `tasks[]` fan-out dispatches where any entry omits `role` are blocked with a clear error naming valid canonical roles.
- [x] In `warn` and `off` modes, an unknown role on one `tasks[]` entry does not prevent valid sibling entries from receiving their role-routing patches.
- [x] `handoff: "fork"` is blocked in `enforce` mode and permitted only when `!direct` override is active, while `standalone` remains the default handoff.

## Validation
Unit tests in the orchestrator delegation test suite cover missing `role` rejection on single and `tasks[]` dispatches in `enforce` mode, `!direct` bypass behavior, independent sibling patching alongside an unknown role in `warn`/`off` modes, and `handoff: "fork"` gating under `enforce` vs `!direct`. Covers `RB-2` and `handoff: "fork"` gating from `RB-3`.
