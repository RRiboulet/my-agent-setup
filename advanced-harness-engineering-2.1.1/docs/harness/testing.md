# Testing Benchmarks, Host Load, and Typechecking

## `--test-concurrency=8` benchmark

Node's `node --test` defaults file concurrency to `availableParallelism() - 1`, which is `1` on this 2-core host. Measured 2026-11-16 on the subagent suite:
- Default (concurrency 1): 184 s wall clock for 67 s CPU (36% utilization — wait-bound).
- `--test-concurrency=8`: 119–132 s wall clock.
- `--test-concurrency=16`: 132 s (no further gain).

`--test-concurrency=8` is fixed in `AGENTS.md` rather than derived from `nproc`. Two timing-sensitive tests exposed under concurrency were widened to assert behavior rather than machine speed: the `btw` viewer render wait (8 s -> 30 s) and the widget ticker window (120 ms -> 500 ms), matching `helpers.ts`'s poll-bound rule.

## Host-load rule

Before timing anything, check `cat /proc/loadavg` and `ps`, and record the load average beside any benchmark number. This host has 2 vCPUs shared across concurrent agent sessions; a parallel suite, benchmark grid, or `devc` run can push load from 0.4 to 33.

- Never compare two timings taken at different load averages; re-run the pair or treat them as non-comparable.
- When a suite fails under contention, re-run the failing file alone before diagnosing a product bug: past load-induced failures were wall-clock bounds rather than logic defects.

## Deliberate absence of typechecking

There is no `tsconfig.json` and no `tsc` step in this repository (decision recorded 2026-10-05, `TODO-914d99f8`). Node 24 executes `.ts` directly via type stripping without adding an npm compiler dependency (this repository consumes no npm packages).

- Historical note: `todos.ts` previously used TypeScript parameter properties rejected by Node's strip-only loader (accepted by pi's jiti loader), which blocked adding it to `extension-load.test.ts`; those parameter properties were later removed and `todos.ts` is now covered by strict-ESM loading.
- Bare-identifier and config-wiring bugs caught during P1/P2 audits are pinned by the unit and load tests.
