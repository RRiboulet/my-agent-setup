---
status: done
blocked-by: ["05"]
---

# 07: Add main-model record-review gate and unconditional post-review dirty reset

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** 05 (Add delegation runtime test seam, codemode parity, and steer-unlock validation)
**Status:** done

## What to build
Allow the main frontier model to satisfy the post-edit review gate directly after inspecting post-edit changes—without forcing a duplicate cold-cache frontier spawn—while closing post-review follow-up edit loopholes:

1. Register a lightweight structured `orchestrator_record_review` tool (named `orchestrator_record_review` rather than `record_review` to avoid colliding with wave orchestration's `record_review` action) and ensure it remains reachable via both `codemode` (`codemode.mode = "only"`) and `tool_search` alongside `orchestrator_override`.
2. Require post-edit inspection evidence (`viewedFiles` or diff inspection recorded after `lastReviewEditAt`) before `orchestrator_record_review` can accept a review, and transition `reviewVerified` to `true` only when the recorded verdict is `"pass"` or `"accepted_with_notes"` (leaving `"fail"` unverified).
3. Preserve `/review` and `reviewer` / `security-reviewer` subagent settlements as an equally valid isolated review pathway sharing the same `reviewVerified` state and single review standard, without reintroducing retired `review-triage` or `goal` extensions.
4. Reset `reviewVerified` unconditionally on any subsequent review-eligible edit occurring after verification, regardless of whether that single follow-up edit exceeds the initial multi-file or line-count threshold.

Prototype parameter schema (from the spec prototype, exposed under tool name `orchestrator_record_review`):
```json
{
  "verdict": "pass | accepted_with_notes | fail",
  "scope": "string (non-empty description of inspected diff/files)",
  "summary": "string (findings or confirmation of clean review)",
  "inspectedPaths": ["string (optional paths reviewed)"]
}
```

## Scope
`orchestrator_record_review` tool definition, post-edit inspection precondition checks, `codemode.mode = "only"` and `tool_search` reachability for `orchestrator_record_review` and `orchestrator_override`, unconditional post-review `reviewVerified` invalidation on any subsequent edit, and pure, strict-ESM, `/review`, and runtime integration tests. Preserves existing `/review` and wave review settlement pathways.

## Acceptance criteria
- [x] `orchestrator_record_review` is registered without colliding with wave orchestration's `record_review` action, and both `orchestrator_record_review` and `orchestrator_override` remain callable under `codemode.mode = "only"` and discoverable via `tool_search`.
- [x] `orchestrator_record_review` rejects verification when post-edit inspection evidence (`viewedFiles` or diff read since `lastReviewEditAt`) is absent, and sets `reviewVerified` to `true` only for `"pass"` or `"accepted_with_notes"` verdicts.
- [x] `/review` and `reviewer` / `security-reviewer` subagents continue to satisfy `reviewVerified` via the same shared rubric without reintroducing retired extensions.
- [x] Any review-eligible edit after `reviewVerified` was set resets `reviewVerified` unconditionally, even if the follow-up edit is below the initial file/line threshold.

## Validation
Unit, strict-ESM load, `/review`, and delegation-runtime integration tests verify `orchestrator_record_review` precondition and verdict behavior, `codemode.mode = "only"` reachability for `orchestrator_record_review` and `orchestrator_override`, `/review` subagent parity, and unconditional `reviewVerified` reset on small follow-up edits. Covers `RB-6` and `RB-7` tool reachability.
