# 07: analytics-agent's groundedness repeat is converted end to end

**Blocked by:** 01, 03, 05
**Status:** ready

## What to build

The first real conversion, in `analytics-agent`. The groundedness class has three
fixes: `50a8260`, `7f3c5de`, and `2479ab9`. Use the skill to choose the level,
write the check, prove it at the bad revision and the fix, record the row, and
log the correction on the experiment branch.

A test or a type is a valid outcome. The groundedness bug is semantic, and
forcing it into a lint would fail the skill's own rule. If no stable check
exists, record the evidence and stop rather than inventing one.

## Scope

- A branch in `analytics-agent`, the check at the chosen level, a ratchet if
  needed, the vendored checker with its version or hash, the row in
  `analytics-agent/AGENTS.md`, and the project's gate.
- A log entry on `exp/prevent-recurrence`.
- No commit in either repository unless the user asks.

Leaves the `pupkeep` rollout and the four-week review checklist.

## Acceptance criteria

- [ ] The level is chosen with a reason why a higher level did not work.
- [ ] The check fails at the bad revision and passes at the fix, with the
      commands and exit codes recorded.
- [ ] The row passes the vendored checker, and the checker version or hash is
      recorded.
- [ ] The experiment log entry is present.
- [ ] No suppression was added to make the check pass.

## Validation

Exact commands at both revisions, the vendored checker, and the log. Covers R2,
R3, R5, R6, R11, R12, and R15.
