# 04: A rebuilt container has the catalogue without a manual step

**Blocked by:** 01
**Status:** done - merged in #182 (2026-11-21)

## What to build

A container built from this repo starts with the catalogue already in its agent
dir: on a fresh volume `postCreate.sh` creates `mcp.json` from the catalogue, and
on a volume that already has one it changes nothing. The same applies to the
private volume surviving a rebuild — an entry the operator deleted there stays
deleted.

Covers the container half of R5.

## Scope

Includes the seed call in `postCreate.sh` and a static guard that the call is
present. Leaves the host half to ticket 03; this ticket calls ticket 01's seeding
mode, and must not add a second jq merge.

`postCreate.sh` runs as root inside a devcontainer and cannot be executed by the
suite, so the guard asserts the property that can be checked cheaply: that the one
seeding call exists, names the module, and sits after the agent-dir setup (seeding
before the directory exists would fail the whole of `postCreate` under `set -e`,
the failure mode that script already documents for other steps).

## Acceptance criteria

- [ ] A `postCreate.sh` run against a fresh agent dir creates `mcp.json` with both
      catalogue names, all disabled.
- [ ] A run against an agent dir that already has `mcp.json` leaves it unchanged.
- [ ] The seed call runs after the agent dir is created and before the step that
      enforces the package-free invariant, and a failure to seed does not abort
      the rest of `postCreate` (the script's existing posture for optional
      seeds).
- [ ] The guard fails if the call is deleted or moved before the agent-dir
      creation.

## Validation

A static test in the style of `devcontainer-agent-dir.test.ts` (which reads
`devcontainer.json` rather than hard-coding the value it guards), asserting the
call's presence and ordering in `postCreate.sh`. The two filesystem behaviors are
proven by invoking the seeding mode itself — ticket 01's process tests — since the
container step is that same command with the same flag; the guard is what proves
`postCreate.sh` still reaches it.
