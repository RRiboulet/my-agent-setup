---
status: done
blocked-by: []
---

# 04: Retire goal extension and decouple orchestrator

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Retire the standalone `goal` extension cleanly and remove its coupling from
orchestrator and worktree tests:

1. Remove the `goal` extension, its package manifest entry, `README.md` and
   harness doc references, strict-ESM extension-load entry, and `goal` tests.
2. Decouple orchestrator settlement and context assembly from
   `activeGoalFromBranch` so only the orchestrator completion gate governs
   parent settlement without competing `agent_before_settle` hooks.
3. Update the worktree duplicate-tool conflict reference and the matching
   `worktree-skill` test assertion to cite a live built-in tool (such as `todo`
   or `subagent`) instead of the retired `get_goal` tool.

## Scope
`goal` extension removal, orchestrator context/settlement decoupling,
manifest/README/load-test cleanup, and synchronized update of the worktree
duplicate-tool conflict example and its test assertion. Leaves wave/delegation
gating, `review-triage` retirement, and broader skill/doc alignment to sibling
tickets.

## Acceptance criteria
- [x] The `goal` extension implementation, its package manifest entry, `README.md`
      listing, and `goal`-specific tests are removed.
- [x] Orchestrator settlement and context assembly have zero dependency on
      `activeGoalFromBranch` or the `goal` extension.
- [x] Worktree conflict documentation and the `worktree-skill` test assertion
      cite a live tool instead of `get_goal`, while keeping `worktree` skill
      line-count budgets within limits.
- [x] Strict-ESM extension loading, manifest parity, and `worktree-skill` tests
      pass cleanly.

## Validation
`worktree-skill` tests, strict-ESM extension loading, and manifest/index parity
checks pass with `goal` absent and `activeGoalFromBranch` decoupled. Covers
`RB-5` and relevant invariants in `RB-11` of the **Orchestration, Skills, and
Extensions Alignment** spec
(`2026-11-26-orchestration-skills-extensions-alignment`).
