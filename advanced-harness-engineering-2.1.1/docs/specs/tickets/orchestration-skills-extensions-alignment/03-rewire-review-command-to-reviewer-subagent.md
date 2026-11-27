---
status: done
blocked-by: []
---

# 03: Rewire /review command to reviewer subagent

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Rewire the `/review` command extension from injecting prompts into the parent
conversation to dispatching an isolated `reviewer` subagent:

1. Preserve the `/review` command registration, interactive target-selection
   picker, `REVIEW_GUIDELINES.md` lookup, and review rubric prompt assembly.
2. Replace inline parent `sendUserMessage` injection with dispatching an
   isolated `subagent` tagged with canonical `role: "reviewer"` (frontier
   inherited model, read-only tools), avoiding parent context bloat and any
   inline parent code-fixing loop.
3. Route completion through normal `orchestrator:run-settled` settlement events
   so delegation's `reviewVerified` state updates automatically without direct
   coupling to internal delegation state.

## Scope
The `review` command extension and its tests. Preserves existing target
selection and guideline/rubric construction while changing execution to an
isolated `reviewer` subagent. Leaves wave reviewer alignment, `review-triage`
retirement, and harness review docs to sibling tickets.

## Acceptance criteria
- [x] `/review` retains target-selection picking, `REVIEW_GUIDELINES.md`
      loading, and review rubric prompt assembly.
- [x] Executing `/review` dispatches an isolated `subagent` with
      `role: "reviewer"` and read-only tools at the frontier inherited model
      rather than calling `sendUserMessage` on the parent session.
- [x] No inline parent mutation or code-fixing loop runs from `/review`.
- [x] Settling the dispatched review subagent emits `orchestrator:run-settled`
      and marks `reviewVerified` automatically.

## Validation
Extension tests verify `/review` target selection and rubric assembly dispatch
a `subagent` with `role: "reviewer"`, never invoke `sendUserMessage`, and mark
`reviewVerified` via settlement events; strict-ESM extension loading passes.
Covers `RB-4` and relevant invariants in `RB-11` of the **Orchestration,
Skills, and Extensions Alignment** spec
(`2026-11-26-orchestration-skills-extensions-alignment`).
