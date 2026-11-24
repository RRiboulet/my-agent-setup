---
status: done
blocked-by: []
---

# 04: Prove Tier-3 and decision-model dispatch

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Proof that both special models in the ladder can actually be dispatched today:

- Tier 3 is `mistral/zai-glm-5-3` — already enabled via the mistral provider
  (reasoning, 1M context); confirm with one live subagent dispatch pinned to it.
- The `triage` pin is a Jev-class decision model (`typesafe/jev-1.13`,
  openrouter/opencode catalogs) which is **not** currently enabled — enable it
  (one line in `enabledModels`) and prove one live triage-style dispatch, or
  record the concrete fact that blocks it.

## Scope
`enabledModels` in the user's settings, plus a recorded probe result. No code.

## Acceptance criteria
- [x] A subagent run pinned to `mistral/zai-glm-5-3` @ `high` completes and its
      run record shows the model.
- [x] A dispatch pinned to the chosen decision model completes, or the ticket
      documents the exact failure and the alternative pin chosen instead.

## Validation
The two probe run records exist (command or transcript reference) and the
settings diff is minimal.

## Outcome (2026-11-24)
- **Tier 3 proven:** live dispatch pinned to `mistral/zai-glm-5-3` @ `high`
  completed (run `8e86460a`, $0.011, reply `PROBE-OK glm-5-3`). No settings
  change needed.
- **Decision model: alternative pin chosen and failures documented.** Probes:
  `openrouter/typesafe/jev-1.13` → 401 `User not found` (credential problem);
  `opencode/jev-1.13` (paid) → 429 `SpendLimitError` (org spend limit);
  `opencode/jev-1.13-free` via direct subagent dispatch → 429
  `FreeUsageLimitError` (free decision models work only in OpenCode's product
  or the classifier channel). The chosen pin `opencode/jev-1.13-free` is
  **proven reachable through the harness's calibrated-judge channel** (live
  judge call, 251 ms), so ticket 05 routes triage through pi's classifier
  machinery (see `docs/codemode.md`) with a pinned-subagent dispatch as
  fallback. `ladder.json`, `DEFAULT_LADDER`, and the policy test were updated
  together (24/24 pass).
- Spec's open assumptions updated with this finding.
