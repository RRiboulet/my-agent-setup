---
status: done
blocked-by: ["02"]
---

# 05: Add delegation runtime test seam, codemode parity, and steer-unlock validation

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** 02 (Enforce mandatory role routing, resilient fan-out patching, and fork gating)
**Status:** done

## What to build
Establish a dedicated delegation-runtime integration test suite using the fake-Pi host seam, verify full `codemode` nested-call guard parity, validate steer-unlock accounting, and harden live-subagent settlement coordination:

1. Create a dedicated delegation-runtime integration test suite backed by the existing fake-Pi host helper (`createFakeHost`) to exercise live event hooks, tool gating, and session state transitions end-to-end.
2. Verify that nested `codemode` tool calls (with `parentToolCallId` set) pass through every delegation `tool_call` and `tool_result` guard identically to top-level calls: discovery budgeting, `viewedFiles` recording on `read`, write/edit caps, read-only bash allowlist, commit/PR gates, and `subagent` role validation and patching.
3. Update steer-unlock accounting so `subagent_answer` counts alongside `subagent_interrupt` and `subagent_resume` toward the steer-unlock threshold, and only increments when the supplied run ID matches a recognized run.
4. Harden and document live-subagent settlement coordination (`waitForSubagents` and settle parking behavior) so the parent does not settle silently while background workers are still active, without breaking interactive cancellation or wave orchestration.

## Scope
Delegation runtime event-hook parity for nested `codemode` calls, `subagent_answer` and known-run-ID steer-unlock validation, live-subagent settlement coordination hardening and documentation, and the new delegation-runtime integration test suite. Preserves worker inertness (`PI_ORCHESTRATOR_ROLE=worker`) and single event-bus communication. Leaves persona/tool trimming (`06`) and main-model review recording (`07`) to downstream tickets.

## Acceptance criteria
- [x] A dedicated delegation-runtime test suite using the fake-Pi host seam exercises `tool_call`, `tool_result`, and settlement flows.
- [x] Nested `codemode` invocations (`parentToolCallId` set) trigger the exact same delegation `tool_call` and `tool_result` guards as top-level calls across reads (`viewedFiles`), discovery budgets, writes/edits, read-only bash allowlist, commit/PR gates, and `subagent` role validation/patching.
- [x] `subagent_answer` counts alongside `subagent_interrupt` and `subagent_resume` toward steer-unlock only when targeting a recognized run ID; unrecognized run IDs do not increment the counter.
- [x] Live-subagent settlement coordination (`waitForSubagents` / settle parking) is hardened and documented so active background workers are not dropped silently on parent settlement.

## Validation
Run the new delegation-runtime test suite alongside existing orchestrator and wave settlement tests to verify nested `codemode` hook parity, `subagent_answer` / known-run-ID steer-unlock behavior, and live-worker settlement parking without regressions to interactive cancellation or wave orchestration. Covers `RB-7` hook parity and `RB-8`.
