---
status: done
blocked-by: []
---

# 01: Unify wave reviewer tier and delegation commit gates

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Align wave orchestration's review tier and commit gating with Pragmatic
Orchestrator's delegation runtime so wave reviews run at frontier capability
and verified wave commits pass cleanly without duplicate blocks:

1. Wave's default `reviewer` configuration inherits the frontier parent model
   with high thinking (`inheritModel: true`, high thinking) rather than pinning
   a lower-tier model, while still honoring explicit local ladder overrides.
2. Wave dispatch plans and kickoff instructions propagate canonical `role`
   tags so launched workers and reviewers emit role-attributed settlement
   events.
3. Wave `ready_to_commit` state and wave `reviewer` subagent settlements
   integrate with delegation's `reviewVerified` tracking and
   `evaluateCompletionGate`, so a verified wave ticket ready to commit is
   recognized by the delegation gate and never double-blocked on commit or
   settlement—while non-wave parent mutations remain gated.

## Scope
Wave ladder configuration, wave dispatch plan and prompt construction, wave
runtime commit gating, and delegation runtime `evaluateCompletionGate` /
`recordChildSettled` coordination. Preserves worker inertness
(`PI_ORCHESTRATOR_ROLE=worker`) across both runtimes and leaves workspace
reservations active for workers. Leaves extension retirements, `/review`
rewiring, bash allowlist expansion, and skill/doc updates to sibling tickets.

## Acceptance criteria
- [x] Wave's default `reviewer` role resolves to frontier model inheritance
      with high thinking unless overridden by local ladder configuration.
- [x] Wave dispatch plans and kickoff instructions carry canonical `role`
      values so worker and reviewer completions record their declared role.
- [x] Completing a wave `reviewer` subagent transitions `reviewVerified` via
      the shared settlement pathway.
- [x] Committing or settling an active wave ticket in `ready_to_commit` passes
      both the wave commit gate and `evaluateCompletionGate` without spurious
      double-blocks, while unverified or non-wave parent edits remain blocked.
- [x] Worker inertness (`PI_ORCHESTRATOR_ROLE=worker`) and worker workspace
      reservations remain intact across delegation and wave runtimes.

## Validation
Unit and integration tests covering wave ladder resolution, role propagation,
wave runtime commit gating, and delegation `evaluateCompletionGate` across
`ready_to_commit`, unverified-edit, and wave `reviewer` settlement states pass,
alongside strict-ESM extension loading. Covers `RB-1`, `RB-2`, and relevant
invariants in `RB-11` of the **Orchestration, Skills, and Extensions Alignment**
spec (`2026-11-26-orchestration-skills-extensions-alignment`).
