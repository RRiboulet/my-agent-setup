# 00: A measurement harness the five changes can be judged by

**Blocked by:** None (can start immediately)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#measurement-plan`

## What to build

One command that records a baseline, and the same command after each of the
five top tickets, so every claim in this investigation is checked rather than
argued. The baseline artifact contract, which both this ticket and ticket 01
use:

- **Phase A** records every cell for all five targets **before any ticket
  changes the harness**, including the `bg` cells, in a session where `bg` is
  not loaded.
- **Phase B** re-runs **only the `bg` cells** after ticket 01 lands, and names
  the commit it measured. It does not re-baseline the other targets; their
  Phase B is their own ticket's after-run.

Two kinds of measurement, because one does not fit all five:

1. **Model runs** for the harness-level changes (`bg`, `subagent`, skills): 8
   fixed tasks × 3 models × 2 harness states, one run per cell. Tasks run in a
   clean detached fixture at `origin/dev`, plus `/home/ubuntu` for the `devc`
   tasks. Record tool calls, wall-clock, longest single call (blocking time),
   tokens, errors, user interventions (0 by construction in `-p`), and whether
   the task finished.
2. **Deterministic microbenchmarks** for the two things a model cannot measure:
   `devc` subcommand latency (100 invocations per cached subcommand, 30 for an
   exec, p50/p90) and repo-explorer keystrokes/time for "what changed in this
   branch and what does the diff say" (5 trials at 80×24).

Also in scope: replace `/session-breakdown`'s graph with a compact table, and
keep `tools/measure-session-usage.mjs` as the session-level aggregator. The
graph's hue/brightness encoding has no axis, its palette is pinned to 30 days,
and it overflows 80×24 (audit: `2026-11-rework-repo-explorer-session-breakdown.md`).
A table is what the A/B consumes.

## Scope

Owns (verify or extend these; the harness half already landed in PR #162, so
this ticket is verification plus the two open slices — per-skill loads are now
implemented, the session-breakdown table is not):

- `tools/bench/` — the runner, the task definitions, the JSON schema, and a
  `README.md` stating how to add a task and how to run one model only. Other
  tickets add **scenario data** through the documented entry point; they do not
  edit the runner.
- `tools/bench/tasks/*.json` — the 8 tasks, each with an explicit success check
  the runner or the operator can evaluate, and the repo it runs in. JSON, not
  Markdown: it parses without a YAML dependency.
- `tools/bench/devc-latency.mjs` plus its scenario data file — a standalone
  microbenchmark, no model. Ticket 02 adds scenarios to the data file only.
- `tools/bench/repo-explorer-trials.md` — the manual protocol and a results
  table, not an automated TUI driver.
- `tools/bench/summarize.mjs` and the per-cell results under
  `tools/bench/results/<state>/<model>/<task>.json` — one file per cell, plus a
  `summary.md`/`summary.json` view. Phase A lives in `results/baseline/`.
- the `/session-breakdown` table view and its height budget. **Still open** in
  PR #162; the harness half landed first.
- **Per-skill load recording**: `tools/bench/skills.mjs` scans every session for
  a `SKILL.md` read (path or bash mention), and `run.mjs` records
  `metrics.skillLoads` per cell. Ticket 05 is now decided by this table, not by
  a single total.

Leaves for later: a dashboard, per-token cost accounting, CI integration.

## Acceptance criteria

- [ ] `node tools/bench/run.mjs --tasks all --models deepseek-v4.1-flash,glm-5.3-flash,hy4-flash-free --state baseline` completes and writes one JSON file per cell; a second invocation is idempotent and does not overwrite without `--force`.
- [ ] The runner refuses to run with a dirty working tree unless `--allow-dirty`, because a harness state has to be identifiable.
- [ ] Each task definition names its repo, its prompt, its success check, and the timeout; there are exactly 8.
- [ ] `node tools/bench/devc-latency.mjs` prints p50/p90 per subcommand and writes JSON, with no model and no network beyond the local docker socket.
- [ ] The Phase A results under `tools/bench/results/baseline/` cover all five tickets **before** `bg` lands: `bg` (blocking time and sleep calls, on a session where the tool is not loaded), `devc` (latency), `subagent` (status calls per run), repo-explorer (trial time/keystrokes), skills (per-skill loads and context tokens). One JSON per cell plus `summary.md`.
- [ ] Phase B re-runs the `bg` cells into a named state directory, names the commit it measured, and does not re-baseline the other targets.
- [ ] `node tools/bench/skills.mjs --all --since 2026-10-31` reports per-skill loads, and each cell records `metrics.skillLoads`.
- [ ] `/session-breakdown` at 80×24 shows its table, tabs, and key hints without scrolling; the range note names the selected range; a test renders at `rows: 24`, not only 40.
- [ ] `hy4-flash-free` is added to `enabledModels` in the agent settings, not to the model catalogue; the runner names the exact setting it changed.
- [ ] This ticket owns its own test files; it does not edit the tests of tickets 03, 04, or 05, and they do not edit its runner.

## Validation

- Run the baseline twice; the deterministic numbers must match and the model
  runs must be reported with their variance, never as a single delta.
- Re-render `/session-breakdown` at 80×24, 40×16, and 160×40 in a test.
- `node --test .pi/extensions/subagent/test/session-breakdown.test.ts`.
