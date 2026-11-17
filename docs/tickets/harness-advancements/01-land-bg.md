# 01: Land the `bg` stack that is already built

**Blocked by:** 00 Phase A (the pre-`bg` baseline)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#1-land-bg-ticket-01`

## What to build

Nothing new. The `bg` tool — `start`/`status`/`logs`/`kill`, completion
notifications, restart repair, the testing rule, and the concurrent test runner —
is already implemented on the `bg-tool-start` branch, with eight sibling branches
(`bg-docs`, `bg-kill`, `bg-logs`, `bg-notify`, `bg-repair`, `bg-replay-baseline`,
`bg-rule-honest`, `bg-wait-action`) merged into it.

This ticket is the review, rebase, and merge: get it onto `dev` **after ticket
00 Phase A records the pre-`bg` baseline and before any other ticket takes its
baseline**, because the sleep-polling and blocking-test costs it removes are two
of the three largest measured categories.

At the tip checked on 2026-11-17 (`a1d48c5`): **1,204 tests pass, 0 fail,
199 s**. The branch has moved twice since (`203ae56`, `a3ebad6`) and is actively
owned by another worktree; re-run the suite at merge time rather than trusting
this number.

## Scope

- Rebase `bg-tool-start` onto current `origin/dev`; resolve `CHANGELOG.md` and
  `AGENTS.md` conflicts in favour of the bg branch's own entries.
- Confirm the extension is registered in `package.json` and that the testing
  rule is in `AGENTS.md`.
- Run the full suite once through `bg` itself, and `node --test --test-concurrency=8`
  once directly.
- Remove the eight sibling worktrees after the merge; `bg-tool-start` is the
  only worktree that needs to survive until then.
- Do not rewrite the tool, rename its actions, or fold the wait action
  (`bg-wait-action`) into this ticket — that is separate work if it is wanted.

## Acceptance criteria

- [ ] `git log --oneline origin/dev..HEAD` on the bg branch lists only bg commits, and `git merge-base --is-ancestor origin/dev HEAD` exits 0.
- [ ] The full suite is green, with the count recorded in the PR body.
- [ ] A full suite run started through `bg` returns immediately, notifies once on settle, and leaves no orphan process after the session ends.
- [ ] `AGENTS.md` states the discipline: touched test files while iterating, the full suite once before commit, through `bg`.
- [ ] `CHANGELOG.md` carries the `bg` entry and the measured motivation, dated.
- [ ] `git worktree list` no longer shows the eight absorbed worktrees.

## Validation

- Start a 180 s full suite through `bg`, do a second small task while it runs,
  then read `logs` and the settle notification.
- `ps -ef | grep -c 'node --test'` is 0 after the session's `session_shutdown`.
