# 00: A measurement harness the five changes can be judged by

**Blocked by:** None (can start immediately)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#measurement-plan`

## What to build

One command that records a baseline, and the same command after each of the
five top tickets, so every claim in this investigation is checked rather than
argued. There is an ordering constraint with ticket 01: the `bg` cells must be
recorded **before** `bg` lands (Phase A, on a session without the tool), then
re-recorded after it lands (Phase B). Otherwise the A/B credits `bg` with a
baseline it already changed. Two kinds of measurement, because one does not fit
all five:

1. **Model runs** for the harness-level changes (`bg`, `subagent`, skills): 8
   fixed tasks × 3 models × 2 harness states, one run per cell. Repos:
   `my-agent-setup` and `pupkeep`. Record tool calls, wall-clock, longest single
   call (blocking time), tokens, errors, user interventions, and whether the
   task finished.
2. **Deterministic microbenchmarks** for the two things a model cannot measure:
   `devc` subcommand latency (100 invocations per subcommand, cold and warm,
   p50/p90) and repo-explorer keystrokes/time for "what changed in this branch
   and what does the diff say" (5 trials at 80×24).

Also in scope: replace `/session-breakdown`'s graph with a compact table, and
keep `tools/measure-session-usage.mjs` as the session-level aggregator. The
graph's hue/brightness encoding has no axis, its palette is pinned to 30 days,
and it overflows 80×24 (audit: `2026-11-rework-repo-explorer-session-breakdown.md`).
A table is what the A/B consumes.

## Scope

Owns (create these; no other ticket edits them):

- `tools/bench/` — the runner, the task definitions, the JSON schema, and a
  `README.md` stating how to add a task and how to run one model only. Other
  tickets add **scenario data** through the documented entry point; they do not
  edit the runner.
- `tools/bench/tasks/*.md` — the 8 tasks, each with an explicit success check
  the runner or the operator can evaluate, and the repo it runs in.
- `tools/bench/devc-latency.mjs` plus its scenario data file — a standalone
  microbenchmark, no model. Ticket 02 adds scenarios to the data file only.
- `tools/bench/repo-explorer-trials.md` — the manual protocol and a results
  table, not an automated TUI driver.
- `tools/bench/results/2026-11-17-baseline-a.json` — Phase A, before `bg` lands.
- `tools/bench/results/2026-11-17-baseline-b.json` — Phase B, after ticket 01.
- the `/session-breakdown` table view and its height budget.
- **Per-skill load recording**: which SKILL.md was read in each session, so
  ticket 05's prune is decided by data rather than by the 33-load aggregate.

Leaves for later: a dashboard, per-token cost accounting, CI integration.

## Acceptance criteria

- [ ] `node tools/bench/run.mjs --tasks all --models deepseek-v4.1-flash,glm-5.3-flash,hy4-flash-free --state baseline` completes and writes one JSON file per cell; a second invocation is idempotent and does not overwrite without `--force`.
- [ ] The runner refuses to run with a dirty working tree unless `--allow-dirty`, because a harness state has to be identifiable.
- [ ] Each task definition names its repo, its prompt, its success check, and the timeout; there are exactly 8.
- [ ] `node tools/bench/devc-latency.mjs` prints p50/p90 per subcommand and writes JSON, with no model and no network beyond the local docker socket.
- [ ] The Phase A baseline file covers all five tickets **before** `bg` lands: `bg` (blocking time and sleep calls, on a session where the tool is not loaded), `devc` (latency), `subagent` (status calls per run), repo-explorer (trial time/keystrokes), skills (per-skill loads and context tokens).
- [ ] The Phase B file re-runs the `bg` cells after ticket 01 and names the commit it measured.
- [ ] The runner records which SKILL.md files a session reads, per session, keyed by skill directory.
- [ ] `/session-breakdown` at 80×24 shows its table, tabs, and key hints without scrolling; the range note names the selected range; a test renders at `rows: 24`, not only 40.
- [ ] `hy4-flash-free` is added to `enabledModels` in the agent settings, not to the model catalogue; the runner names the exact setting it changed.
- [ ] This ticket owns its own test files; it does not edit the tests of tickets 03, 04, or 05, and they do not edit its runner.

## Validation

- Run the baseline twice; the deterministic numbers must match and the model
  runs must be reported with their variance, never as a single delta.
- Re-render `/session-breakdown` at 80×24, 40×16, and 160×40 in a test.
- `node --test .pi/extensions/subagent/test/session-breakdown.test.ts`.
