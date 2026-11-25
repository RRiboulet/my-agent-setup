# 01: A rule table can be validated in one command

**Blocked by:** None (can start immediately)
**Status:** done - merged in #172 (2026-11-20)

## What to build

A deterministic checker that reads the "Rules and enforcement" table from an
`AGENTS.md` and reports whether every row is enforceable. It is the only
machine-checkable part of the rule-table contract: required columns, allowed
levels, a non-empty enforcer, a proof reference that exists, no exact duplicate
rules, and no prose row without a `judgment` marker and reason.

The checker runs from the skill's canonical location. It resolves paths from the
repository root, works in a linked worktree, and degrades to snippet proof when
the repository has no git history. It supports `--json`.

## Scope

- Parser and validator; exit 0 on a valid table, 1 on a violation with the row
  number and reason, 2 on a usage error.
- Fixtures: valid table; missing column; unknown level; empty enforcer; missing
  proof path; duplicate rule; prose row without judgment; bad usage; linked
  worktree; no-git snippet proof.
- Tests under `node --test`; no new dependency.
- The table format documented in the skill's reference or `--help`.
- Creates the canonical checker location under the new skill's directory. The
  skill body follows in ticket 03.

Leaves the harness's own table and first rule (02), and the skill body (03).

## Acceptance criteria

- [ ] A valid fixture exits 0; each bad fixture exits 1 with a row-specific
      message; a bad invocation exits 2.
- [ ] `--json` output is stable and documented.
- [ ] The linked-worktree and no-git fixtures pass.
- [ ] The tests run in the harness gate.
- [ ] No new npm or Python dependency.

## Validation

`node --test` over the checker tests, plus one manual run per fixture. Covers R6,
R7, and R12.
