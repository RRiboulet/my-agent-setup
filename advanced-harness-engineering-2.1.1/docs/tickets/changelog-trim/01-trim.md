---
status: done
blocked-by: []
---

# 01: Trim CHANGELOG.md to the newest major release

**Blocked by:** None (can start immediately)
**Status:** done
Decisions recorded with the user this session: the file keeps `## Unreleased`
and every release of the **newest major** (all of v1.17.x); no archive file —
everything older is read from git history via `git show vX.Y.Z:CHANGELOG.md`
at the tag. Do not invent a different cut.

## What to build

CHANGELOG.md today carries `## Unreleased` plus 22 release sections (v1.0.0
through v1.17.1, ~4,400 lines). Delete every release section older than the
newest major: after this ticket the file contains exactly `## Unreleased`,
`## v1.17.1`, and `## v1.17.0`.

Under the title (beside "Versions are git tags. This repository is not
published to npm.") add one short line saying that releases older than those
shown are read from the tag — `git show vX.Y.Z:CHANGELOG.md` — and are not
kept in this file.

Delete whole sections only. Do not reword, reflow, or reorder anything that
stays; the `## Unreleased` section must be byte-identical afterwards. Do not
touch `## v1.17.0`/`## v1.17.1` contents beyond leaving them in place.

## Scope

Owns `CHANGELOG.md` and its title-note only. No test, skill, or AGENTS.md
edits (ticket 03 owns the policy layer). No new files.

## Acceptance criteria

- [ ] `grep -c '^## ' CHANGELOG.md` reports 3: `Unreleased`, `v1.17.1`, `v1.17.0`.
- [ ] The file is roughly 250–300 lines (down from 4,405).
- [ ] The `## Unreleased` section is byte-identical to before (`git diff` shows
      only deletions below it and the added title note).
- [ ] A removed version stays reachable: `git show v1.16.0:CHANGELOG.md`
      prints its full entry (tag exists and is old content is in history — no
      data is lost by this ticket).
- [ ] `node --test --test-concurrency=8 .pi/extensions/subagent/test/changelog-structure.test.ts`
      passes unchanged (the structural guards are shape-only; trimming must
      not trip "descending order" or label checks).

## Validation

Run the structure test file alone, then the full subagent suite
(`node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts`),
and report the counts. Include `wc -l CHANGELOG.md` before and after in the
report.
