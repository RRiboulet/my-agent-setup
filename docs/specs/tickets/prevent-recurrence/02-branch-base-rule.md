# 02: The branch-base rule is enforced by a check, not a reviewer

**Blocked by:** 01
**Status:** done - merged in #172 (2026-11-20)

## What to build

The first real rule in this repository's table: a branch must descend from the
current `origin/dev` and carry only its own commits. The check fails with a
message that names the situation, runs from `prove-it-works`, and runs in a new
minimal CI workflow. Its row is validated by the checker.

`AGENTS.md` already records three real misses of this rule. This ticket makes the
fourth cost a check, not a review.

## Scope

- Check script: fetch `dev`; fail when `origin/dev` is not an ancestor of `HEAD`;
  fail when the oldest commit in `origin/dev..HEAD` does not sit directly on
  `origin/dev`, which catches a branch stacked on another feature branch; pass on
  a correct branch; report a branch behind `dev` separately without treating it
  as a wrong base.
- Fixtures: wrong base from `main`, foreign commits from another feature branch,
  correct branch, and a branch behind `dev`.
- The "Rules and enforcement" heading and the branch-base row; the checker passes
  on this repository's table.
- A `prove-it-works` step that names the command.
- A minimal GitHub Actions workflow: full history, fetch `dev`, set up the
  subagent test dependencies, run the subagent tests, the provider tests, the
  checker tests, and the branch-base check. It runs on pull requests to `dev` and
  pushes to `dev`.
- A changelog bullet.

Leaves other rules; the experiment branch policy belongs to ticket 05.

## Acceptance criteria

- [ ] The check fails on a branch cut from `main` and on foreign commits, passes
      on a correct branch, and reports "behind dev" without a base failure.
- [ ] The rule row passes the checker.
- [ ] `prove-it-works` names the command.
- [ ] The workflow runs on a pull request and fails on a wrong-base test branch.
- [ ] The existing subagent and provider tests still pass.

## Validation

Fixture branches in a scratch repository; one real pull-request run of the
workflow; the checker. Covers R14.
