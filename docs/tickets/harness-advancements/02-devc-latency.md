# 02: `devc` latency on the read-only and exec paths

**Blocked by:** 00 (baseline benchmark exists)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#2-devc-latency-ticket-02`

## What to build

`devc` is 389 real invocations and 9,089 s across 25 sessions and 6 projects —
34% of all bash time, more than every file tool combined. The cost is not one
slow rebuild; it is a long tail of small, repeated resolutions:

- `devc ls` — 35 calls, 260 s, ~7 s each.
- `devc doctor` — 15 calls, 119 s, ~8 s each.
- `devc pupkeep -- <cmd>` — 54 calls, 1,497 s, **~28 s each** for a plain exec.
- `devc rebuild` — 30 calls, 3,976 s; `devc up` — 24 calls, 1,184 s.

Make the repeated work cheap without changing what `devc` means. Every existing
subcommand, flag, and output line stays; the changes are additive and opt-out.

## Scope

Owns (`bin/devc` and a new test file; no other ticket edits them):

- A cached, TTL'd index for the read-only queries (`ls`, `doctor`, `hashes`),
  keyed on the resolved compose/config file set, its mtimes/hashes, and the
  docker daemon identity. A stale entry must be detectably stale, not silently
  wrong; `--no-cache` bypasses it and forces a refresh.
- A persistent exec path for `<project> -- <cmd>`: resolve the container and
  environment once per project generation, then `docker exec` directly instead
  of re-deriving compose state on every call. Fall back to the current path when
  the container is missing, restarting, or the generation changed.
- One `devc timings --last` (or equivalent) surface that reports where the last
  invocation spent its time, gated so it is not in the normal output.
- `devc-latency.mjs` scenarios wired into ticket 00's benchmark.

Does **not** own: rebuild strategy, the devcontainer CLI, image contents,
compose semantics, or any change to `devc`'s user-visible contract.

## Acceptance criteria

- [ ] `node tools/bench/devc-latency.mjs` reports p50/p90 per subcommand, cold and warm, before and after, with the same command set and the same project.
- [ ] Warm `devc ls` and `devc doctor` are at least 50% faster at p50, and no slower at p90 than the baseline.
- [ ] A plain exec (`devc pupkeep -- true`) is at least 30% faster at p50; correctness is proven by running the same command through the old and new paths and diffing stdout, stderr, and exit code.
- [ ] A changed `devcontainer.json`, a rebuilt container, or a stopped daemon invalidates the cache; a test simulates each and asserts the query is re-derived.
- [ ] `--no-cache` changes nothing except bypassing the cache, and an environment variable can disable the cache for one shell.
- [ ] No existing subcommand, flag, exit code, or output line changes; the help text gains only the new flag and the timings command.

## Validation

- Run the benchmark twice; deterministic latency numbers must match within noise.
- Prove the cache cannot serve a stale project: edit a compose file, call
  `devc ls`, and assert the new project appears without `--no-cache`.
