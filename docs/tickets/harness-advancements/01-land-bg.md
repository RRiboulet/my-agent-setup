# 01: Land the `bg` stack — **cancelled 2026-11-17, on measurement**

**Blocked by:** —
**Status:** **cancelled** (was: ready)

The stack was built, merged, and then measured. It did not earn its surface, and
its branch has been closed and deleted. What follows is the evidence, so nobody
rebuilds it in the belief that it works.

## What was built

`bg` with `start`/`status`/`logs`/`kill`/`wait`, a poll watcher, coalesced
completion notices, session-start repair, the `AGENTS.md` testing rule, and
`--test-concurrency=8` for the suite. Roughly 3 270 lines of code and 2 235 of
tests across 36 files, PR #161.

## Why it was cancelled

Nine measured runs, one session per run, nothing else started while a run was in
flight, `bg` verified reachable or unreachable per session:

| Run | Condition | Wall | What happened |
|---|---|---:|---|
| Acceptance ×6 | `bg` available | — | **1 of 4 criteria met**; `bg` called in **1 of 6** sessions |
| Adoption ×2 | `bg` declared at startup | 308 / 525 s | **1 of 2** used it — identical to deferred |
| Fan-out A | no `bg`, neutral | 732 s | four suite runs in a sequential `for` loop |
| Fan-out B | `bg` declared, neutral | 711 s | `start` a script that ran all four **sequentially**, then `wait` |
| Fan-out C | no `bg`, told to parallelise | 1 732 s | four runs **in parallel**: 291.6 s of suite time, then 1 400 s of flake triage |

Three conclusions, each measured rather than argued:

1. **Availability is not adoption.** Declaring the tool changed usage not at all.
2. **The model does not fan out.** Given a fan-out task and the tool, it wraps a
   sequential batch in one job and waits — blocking relabelled, not removed.
3. **Parallelism works, and `bg` is not what delivers it.** Condition C's four runs
   finished in 291.6 s instead of ~660–960 s, using plain `&`. Its cost was
   flake triage on a 2-core host, which made the session 2.4× slower end to end.

The tool also exposed a real bug before it was retired: `watch.ts` settles a job
from `handle.exitCode()` the moment the pid is gone, so under a starved event loop
it can record `exited` with a null code before the child's `exit` event arrives —
and settlement is one-shot, so `wait` then hands back `settled: true,
exitCode: null` for a job that exited 0. Anyone reviving this code should fix that
first.

## What survived, and where

- **The concurrent test runner** — 184 s to ~119–132 s, plus the two load-sensitive
  bounds it exposed — re-landed alone in **#165** (`test-suite-speed`).
- **The lifecycle split** — the suite's floor from 98.8 s to 24.2 s — stands on its
  own in **#164** (`split-lifecycle-tests`).
- The `bg` code itself is gone: PR #161 closed, branch deleted. The commits remain
  reachable through GitHub's `refs/pull/161/head` if anyone needs the history.

## What replaces this in the ranking

The two categories this ticket claimed — 7 786 s of `sleep`-polling and 7 904 s of
blocking suites — are not recovered by adding a background-job tool. The suite
category is reduced by making the suite faster (#165, #164) and by not running it
548 times; the polling category needs the *caller* to stop polling, which is
ticket 03's subject for subagents. The repeated-command breaker for bash
(candidate 07) was measured and withdrawn — see `07-repeat-breaker.md`.
