# 05: The four-week experiment branch exists with its own policy and log

**Blocked by:** 03
**Status:** done - the branch is `exp/prevent-recurrence`; the window opened 2026-11-21 and closes 2026-12-19

## What to build

A feature branch off `dev` that carries the experiment's policy and log, leaving
`dev` unchanged. The branch tests one thesis: for a repeated mistake, a check
beats another review.

## Scope

- Create `exp/prevent-recurrence` off `dev`.
- Branch-only `prove-it-works` rule: a change that claims to fix a repeat must add
  or update a table row, and the checker must run.
- Branch-only `REVIEW_GUIDELINES.md` question: does this fix a repeat, and where
  is the row and the proof?
- The experiment log beside the spec. Columns: date, correction, evidence, repeat
  count, level, rule, proof command and exit codes, review rounds, notes. The
  repeat definition is the same class twice in 30 days.
- Confirm `dev` is unchanged.

Leaves the first conversion (07). The four-week review is a checklist in the
spec, not a ticket.

## Acceptance criteria

- [ ] The branch is off `dev`, and `git log dev..HEAD` lists only branch commits.
- [ ] The branch-only policy files differ, and `dev` is unchanged.
- [ ] The log template and the class-level repeat definition are present.
- [ ] The checker passes the harness table on the branch.

## Validation

Git checks, a diff against `dev`, and the checker. Covers R10 for the branch-only
review question, and R11.
