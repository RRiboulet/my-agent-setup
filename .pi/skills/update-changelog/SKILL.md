---
name: update-changelog
description: "Read this skill before updating changelogs"
---

<!-- Vendored from https://github.com/mitsuhiko/agent-stuff (skills/update-changelog/SKILL.md)
     Upstream commit 0865c84. LOCAL ADAPTATION, marked below. -->

Update the repository changelog with changes between the last release and the current version that are not yet incorporated. If `CHANGELOG.md` does not exist, use `CHANGELOG` instead.

## Step-by-Step Process

### 1. Determine baseline version
If no baseline version is provided, use the most recent git tag. You can find it with `git describe --tags --abbrev=0`.

### 2. Find the commits from git

Use the following commands to gather commit information:

```bash
# Get the baseline version (if not provided)
git describe --tags --abbrev=0

# Get all commits since the baseline version
git log <baseline-version>..HEAD
```

### 3. Update the changelog
Read the existing changelog file (`CHANGELOG.md`, or `CHANGELOG` if missing) and check if there are changes not yet incorporated, then add them. Always add them to the "Unreleased" section only. If there is none yet, add it at the top in the same style as the existing changelog (for example, `## Unreleased` vs `## [Unreleased]`).

## Ground Rules When Writing Changelogs

### Content Guidelines
* Focus on **notable changes** that affect users (features, fixes, breaking changes)
* Mention pull requests (`#NUMBER`) when available, but not raw commit hashes
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
* If the repo uses a different default branch name, treat that as the "current version" instead of `main`
* When in doubt about whether a change is significant, err on the side of including it

## LOCAL ADAPTATION: this repo's changelog is not the flat list above

The example above is upstream's (CPython). This repository's changelog is not a
flat bullet list, and copying that shape into it would be wrong. What is
actually here:

- Sections are `Added:` / `Fixed:` / `Maintenance:` (and one-off headings like
  `Pruned for a first iteration, deliberately`), each a bolded lead-in.
- Entries explain **why**, at length. A `Fixed:` bullet here routinely runs ten
  lines and names the failure it prevents. That is deliberate: this is a
  personal repo where the reasoning is the point.
- `AGENTS.md` is the release procedure — changelog, commit, tag, push. This
  skill only covers the first of those steps.

So: read the surrounding entries before writing, and match them.

### Known wart: the `Unreleased` heading is nested, not top-level

`CHANGELOG.md` currently carries `### Unreleased` *inside* the newest release
heading, after that release's contents:

```
## v1.0.0 — 2026-10-02
Initial tagged release, tracking pi 1.0.0. Contents:
- ...
### Unreleased          <-- an H3 under a released version
Added:
```

Appending to it is still correct and this skill does not change that. But at
release time it needs promoting to its own `##` section above the version it
was nested under — otherwise the tag for the next version ships a section
labelled "Unreleased" *inside the previous release*, and the next release has
nowhere to write. Raise it with the user rather than restructuring the release
document silently.

### No pull requests to cite

This repository is pushed by one person and uses no PRs, so the
"mention pull requests when available" rule above never fires here. Cite the
branch or nothing.