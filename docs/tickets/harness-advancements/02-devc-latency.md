# 02: `devc` latency on the read-only and exec paths

**Blocked by:** 00 (the benchmark entry point exists)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#2-devc-latency-ticket-02`

## What to build

`devc` is 252 real invocations / 6,389 s across 6 projects — 22% of all bash
time, and the only tool every project goes through. Counted precisely
(`bin/devc:626-672`), the cost is:

- plain `<project> -- <cmd>` exec — 166 calls, 3,236 s, **~19.5 s each**
  (`exec_in`, `bin/devc:406`)
- `ls` — 30 calls, 253 s, ~8.4 s each (`cmd_ls`, `bin/devc:453`)
- `doctor` — 13 calls, 115 s, ~8.8 s each (`doctor`, `bin/devc:500`)
- `rebuild` — 16 calls, 2,068 s; `up` — 17 calls, 703 s
  (`cmd_rebuild`, `ensure_up`)

The ticket's scope is the first three (3,604 s). `rebuild`/`up` (2,771 s) are
touched only through the opt-in `--if-stale` below. Every existing subcommand,
flag, and output line stays; `--no-cache` already exists for `rebuild` and is
extended to the new cached paths.

## Scope

Owns (`bin/devc`, `bin/devc`'s existing stub harness
`.pi/extensions/subagent/test/devc.test.ts`, and the scenario data file that
ticket 00 defines):

- **Cache the discovery, not the answer.** `cmd_ls`/`doctor` re-resolve project
  roots, compose files and container state on every call. Cache the resolved
  project list and config hashes, keyed on the config file set + mtimes and
  the docker daemon identity; re-derive container state from one `docker ps`
  and the container ID. `ls` output must be byte-identical to today's, so do
  not TTL the container rows — a rebuilt container changes its ID and therefore
  the key. `--no-cache` bypasses the cache for one invocation.
- **A faster exec path.** `exec_in` runs `ensure_up` (uid guard, staleness
  probe) then `devcontainer exec --remote-env ...`. Cache the `ensure_up`
  result per (config hash, container ID) and keep the exact `devcontainer exec`
  argv, including both `--remote-env` pairs; do **not** replace it with a raw
  `docker exec`, which drops the remote env and the uid check. Fall back to the
  full path when the container is missing, restarting, or the generation
  changed.
- **Opt-in `devc rebuild <name> --if-stale`.** Skip the rebuild only when the
  config hash is unchanged and the recorded container is running and current;
  print why it skipped. Default behaviour is unchanged — a bare `devc rebuild`
  still rebuilds.
- `devc timings --last` (or equivalent), gated and quiet by default, reporting
  where the last invocation spent its time.
- Scenarios added to ticket 00's `tools/bench/devc-latency.mjs` data file:
  `ls`, `doctor`, exec, `rebuild --if-stale`, cold and warm.

Does **not** own: the devcontainer CLI, image contents, compose semantics, the
rebuild strategy itself, or any change to `devc`'s user-visible contract. No
new subcommand other than `timings`; no new flag other than `--if-stale` and
`--no-cache` on the cached paths.

## Acceptance criteria

- [ ] `node tools/bench/devc-latency.mjs` reports p50/p90 per scenario, cold and warm, before and after, with the same project and config.
- [ ] Warm `ls` and `doctor` are at least 50% faster at p50, with **identical** stdout, stderr, and exit code to the baseline for the same repository state.
- [ ] A plain exec (`devc pupkeep -- true`) is at least 30% faster at p50, with identical stdout/stderr/exit code, and `--remote-env PI_TRUE_COLOR` still reaches the command.
- [ ] Editing `devcontainer.json`, rebuilding the container, or restarting the daemon invalidates the cache; a test simulates each and asserts the command is re-derived from the real state.
- [ ] `devc rebuild <name> --if-stale` skips a current container and prints why, rebuilds a stale one, and a bare `devc rebuild` is unchanged.
- [ ] The uid-mismatch guard still fires: a container running as a different uid than the host is reported, not silently exec'd into.
- [ ] `.pi/extensions/subagent/test/devc.test.ts` covers the cache invalidation and the `--if-stale` decision table; no new test file is created.

## Validation

- Run the benchmark twice; deterministic latency numbers must match within noise.
- Diff old vs new stdout for `ls`, `doctor`, and one exec, byte for byte.
- Prove the cache cannot serve a stale project: edit a compose file, call
  `devc ls`, and assert the new project appears without `--no-cache`.
