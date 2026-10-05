---
name: update-changelog
description: "Read this skill before updating changelogs"
---

<!-- VENDORED, NOT OURS.
     update-changelog/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/update-changelog/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     One LOCAL ADAPTATION below, marked in place. It covers this repo's section
     headings, its significance filter, and the commit range that matches a
     branch-per-change workflow. -->

Update the repository changelog with changes between the last release and the current version that are not yet incorporated. If `CHANGELOG.md` does not exist, use `CHANGELOG` instead.

## Step-by-Step Process

### 1. Determine baseline version
If no baseline version is provided, use the most recent git tag. You can find it with `git describe --tags --abbrev=0`.

### 2. Find the commits from git

Use the following commands to gather commit information:

```bash
# Get the baseline version (if not provided)
git describe --tags --abbrev=0

# LOCAL ADAPTATION: the range depends on where you are. Upstream's
# `<baseline-version>..HEAD` is only right on `dev` at release time; on a
# feature branch it re-reads every commit already merged since the tag, and
# after a rebase those already-changelogged commits come back under new hashes.
git log <baseline-version>..dev    # at release time, on dev (AGENTS.md step 1)
git log dev..HEAD                  # on a feature branch: this branch's own work
```

`v1.0.0..dev` returns everything merged since the tag — including work already
written up — while `dev..HEAD` on a working branch returns exactly the commits
that branch contributed. Do not put a count in this file: it is stale the moment
the next commit lands.

**But the release-time range is titles, not reasoning.** `AGENTS.md`'s workflow
merges with `gh pr merge --squash`, so the branch's individual commits do not
survive into `dev`. After a squash, `git log <tag>..dev` gives you one line
per PR whose subject is the PR title. The reasoning lives in the PR body and in
the commits that were squashed away, neither of which is reachable from `dev`.
So at release time, read the range for the *list* of changes and then fetch each
one:

```bash
gh pr list --state merged --search "merged:>=<since-date>" \
  --json number,title,body,mergedAt
```

**On a branch stacked on another unmerged branch**, `dev..HEAD` includes the
base branch's commits, which are already written up on that branch's PR. Either
subtract them (`git log dev..feature-a`) or leave the entry to the base branch
and only note the delta.

### 3. Update the changelog
Read the existing changelog file (`CHANGELOG.md`, or `CHANGELOG` if missing) and check if there are changes not yet incorporated, then add them. Always add them to the "Unreleased" section only. If there is none yet, add it at the top in the same style as the existing changelog (for example, `## Unreleased` vs `## [Unreleased]`).

## Ground Rules When Writing Changelogs

### Content Guidelines
* Focus on **notable changes** that affect users (features, fixes, breaking changes)
* Mention pull requests (`#NUMBER`) when available, but not raw commit hashes (never fires here — see "No pull requests to cite")
* Ignore insignificant changes (typo fixes, internal refactoring, minor documentation updates)
* Group related changes together when appropriate
* Order entries by importance: breaking changes first, then features, then fixes

### Style Guidelines
* Use valid markdown syntax
* Start each entry with a past-tense verb or descriptive phrase
* Keep entries concise but descriptive enough to understand the change
* Use bullet points (`*` or `-`) for individual changes
* Format code references with backticks (e.g., `` `foo.cleanup` ``)

### Example Format

```markdown
## 2.13.0

* Added multi-key support to the `|sort` filter.  #827
* Fix `not undefined` with strict undefined behavior.  #838
* Added support for free threading Python.  #841

## 2.12.0

* Item or attribute lookup will no longer swallow all errors in Python.  #814
* Added `|zip` filter.  #818
* Fix `break_on_hyphens` for the `|wordwrap` filter.  #823
* Prefer error message from `unknown_method_callback`.  #824
* Ignore `.jinja` and `.jinja2` as extensions in auto escape.  #832
```

### Good vs. Bad Examples

**Good:**
* `Fixed an issue with the TypeScript SDK which caused an incorrect config for CJS.`
* `Added support for claim timeout extension on checkpoint writes.`
* `Improved error reporting when task claim expires.`

**Bad:**
* `Fixed bug` (too vague)
* `Updated dependencies` (insignificant unless it fixes a security issue)
* `Refactored internal code structure` (internal change, not user-facing)
* `Fixed typo in comment` (insignificant)

## Notes

* If the current changelog already has an "Unreleased" section with content, append to it rather than replacing it
* Preserve the existing changelog style and formatting (headings, bullet style, ordering, and spacing)
* This repo's integration branch is `dev`; `main` takes releases only
* When in doubt about whether a change is significant, err on the side of including it

## LOCAL ADAPTATION: this repo's changelog is not the flat list above

The example above is upstream's (CPython). This repository's changelog is not a
flat bullet list, and copying that shape into it would be wrong. What is
actually here:

- Sections are plain-text headings, never bold: `Added:`, `Fixed:`,
  `Maintenance:`, `Features:`, `Fixes:`, `Pruned for a first iteration,
  deliberately (all removed, not deprecated):`, and prose headings that name
  where the fixes came from (`Fixes to the handoff work, from an adversarial
  review:`, `Fixes found by reviewing that work, before it shipped:`). Reuse one
  that exists before inventing one — an agent given three headings invents a
  fourth.
- Entries explain **why**, at length. A `Fixed:` bullet here routinely runs ten
  lines and names the failure it prevents. That is deliberate: this is a
  personal repo where the reasoning is the point.
- `AGENTS.md` is the release procedure — changelog, commit, tag, push. This
  skill only covers the first of those steps.

- The significance filter above ("ignore internal refactoring, minor
  documentation updates") does **not** apply here, and following it would lose
  most of this changelog. Its entries are largely docs fixes, line-ending
  repairs, test-harness churn and refactors, each recorded with the reasoning —
  this is a personal repo where the reasoning is the deliverable. Write them
  up.

So: read the surrounding entries before writing, and match them.

### Where the `Unreleased` section goes

`CHANGELOG.md` carries `## Unreleased` as a top-level section directly under the
title, above the newest release. Append to it; never start a new one, and never
nest it under a released version.

That was not always true. Until 2026-10-05 it sat as `### Unreleased` *inside*
the `## v1.0.0` heading, after that release's contents — so tagging the next
version would have shipped a section labelled "Unreleased" under the previous
release, with nowhere for the release after it to write. Fixed by promoting it to
a top-level `##` section above the newest release, which also restores the
descending order the rest of the file uses.

At release time, that section becomes the release: retitle `## Unreleased` to
`## vX.Y.Z — <date>`, add a new empty `## Unreleased` above it, and tag the
commit. Nothing else in the file moves.

### Pull requests: cite the PR, not the commit

This repo *does* use pull requests — `AGENTS.md` has a Pull requests section and
merges happen on GitHub via `gh pr merge`. What is true is narrower: no commit
subject here carries a `#N`, and `CHANGELOG.md` is written between releases
rather than per PR. So:

- Cite `#N` from the PR when there is one, which after a squash merge is the
  only place the number survives — `git log` shows `(#N)` in the subject.
- Do not cite the branch. It is deleted after merge (`--delete-branch`), so the
  reference would dangle.
