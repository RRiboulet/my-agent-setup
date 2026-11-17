# 08: Acceptance run

**Blocked by:** 03, 04, 05, 06, 07, 02
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` — the **revised**
criteria (2026-11-16), not the four the spec first carried.

## What to build

The same three replay tasks as ticket 02, run twice each against the merged
`bg` tool, with the numbers written into the changelog beside the baselines.
This closes the loop: the change is accepted on evidence, not on argument.

Two corrections come with it, both established before this ticket starts:

1. **The first baseline is partly stale.** Ticket 02 measured the feature task
   when this repo's suite cost 184 s serial. `--test-concurrency=8` has since
   made it ~121 s, so a feature-task baseline taken then would credit `bg` with a
   speedup the test runner produced. The infra task (a `pupkeep` container
   rebuild) and the bug task (`analytics-agent`'s pytest) never run this suite,
   so their baselines stand as measured.
2. **Two of the four original thresholds were unreachable or miscounted** — the
   rebuild's critical path is 65–72 % of the infra baseline before any polling is
   removed, and "≤ 1 suite run" never counted the run inside the rebuild's
   postCreate. The spec now carries the revised criteria; do not evaluate against
   the old ones, and do not rewrite the criteria again to make the run pass.

## Scope

Baseline recapture, first and on the merged base:

- Recapture **only the feature task**, two runs, with `bg` unavailable in the
  session doing the work (a session whose tool set excludes it, or a worktree
  without the extension — say which you used and why it is equivalent). Same
  model and thinking level as ticket 02, same method and script.
- Leave the infra and bug baselines alone, and say in the write-up that they were
  reused and why.

Then the acceptance runs:

- Three tasks × two runs with the branch's own extension loaded — the worktree's
  copy of `bg`, not the main checkout's.
- Record per run: task wall-clock, blocking bash seconds, calls over 60 s,
  explicit full-suite runs, and — on the feature task — the seconds of the suite
  run that overlapped other tool work.
- Write the numbers into the changelog entry ticket 07 created, replacing its
  placeholder. Do not restructure the entry.

Same constraint as ticket 02: **never rebuild the my-agent-setup devcontainer.**

## Acceptance criteria

Revised criteria — evaluated and stated as met or not met, with numbers:

- [ ] **Infra: zero calls over 60 s.** Baseline was 4 per run, all polling.
- [ ] **Blocking bash time per session ≤ 50 % of baseline** on all three tasks.
- [ ] **Explicit full-suite runs ≤ 1 per task**, with the rebuild's internal run
      named and excluded rather than silently uncounted.
- [ ] **Feature: at least 30 s of the suite run overlaps other tool work.**
      Baseline was 0 — the run was blocking by definition.
- [ ] **Wall-clock is reported, not thresholded**, with one sentence saying why:
      the infra rebuild's sequential work dominates its critical path, so no
      amount of backgrounding moves it 40 %.

Reporting rules:

- [ ] Two runs per task, judged on the mean; a difference under 10–15 % is called
      noise, not a result (the feature task varied 31 % between identical runs in
      the baseline).
- [ ] Any missed criterion is reported as missed, with the reason. No softening,
      no redefinition, no averaging away a failure.
- [ ] The baseline recapture and the reuse of the two older baselines are both
      stated in the write-up, not just the wins.

## Validation

The instrumented runs themselves, plus the final full suite started through `bg`
with the documented concurrency, so the new path is exercised on its own
acceptance run.
