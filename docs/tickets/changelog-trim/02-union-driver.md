---
status: done
blocked-by: []
---

# 02: Auto-merge concurrent changelog appends with a union merge driver

**Blocked by:** None (can start immediately)
**Status:** done
Decisions recorded with the user this session: yes — union. The pain is that
parallel worktrees all append at the same `## Unreleased` anchor, so every
changelog edit collides at merge time.

## What to build

Declare `CHANGELOG.md merge=union` in `.gitattributes` so two branches that
both add entries to the `## Unreleased` section merge without a conflict:
the union driver keeps both sides in order instead of stopping.

Facts the implementation must respect:

- The existing `* text=auto eol=lf` line stays untouched; the new line is a
  path-specific attribute alongside it. Union on eol-normalized text is safe.
- The driver applies to **local merges** — a worktree branch pulling in `dev`
  (or a local merge of two branches) auto-resolves. GitHub's server-side
  squash merge does **not** run custom merge drivers, so a PR view may still
  show a conflict; resolving it is then a local `git merge dev`, which the
  union attribute makes conflict-free. Say exactly this in the test's comment
  so nobody later believes the attribute is broken because the GitHub UI
  still flags it.
- Demonstrate the behavior as part of validation: create a scratch branch that
  appends a bullet to `## Unreleased`, append a different bullet on `dev`'s
  tip, `git merge`, and confirm no conflict and both bullets present. Clean up
  the scratch branch afterwards.

Add a self-contained new test file in the subagent test suite that fails when
the attribute line disappears (assert `.gitattributes` matches a
`CHANGELOG.md merge=union` line). Prove it red by deleting the line, per
`prove-it-works`. This is a guard, so a future `.gitattributes` sweep cannot
silently drop the driver.

## Scope

Owns `.gitattributes` and one new test file under
`.pi/extensions/subagent/test/` (auto-picked-up by the suite glob; no CI or
AGENTS.md list changes needed). No changelog-structure test edits, no skill or
AGENTS.md prose, no CHANGELOG.md content edits (tickets 01/03 own that file).

## Acceptance criteria

- [ ] `.gitattributes` contains the `CHANGELOG.md merge=union` attribute next
      to (not instead of) the existing global `* text=auto eol=lf` line.
- [ ] A two-sided append to `## Unreleased` merges locally with no conflict and
      both bullets survive, in scratch-branch demonstration.
- [ ] The new test passes with the attribute present and goes **red** when the
      line is removed (red run executed and reported, then restored).
- [ ] The full subagent suite stays green
      (`node --test --test-concurrency=8`).

## Validation

Report the scratch-branch merge demonstration output, the red/green test runs,
and the full suite result. Leave the tree clean of scratch branches.
