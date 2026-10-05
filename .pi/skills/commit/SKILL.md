---
name: commit
description: "Read this skill before making git commits"
---

<!-- VENDORED, NOT OURS.
     commit/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/commit/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     Two LOCAL ADAPTATIONS below, each marked in place:
       A. the summary length rule (this repo's history is deliberately verbose)
       B. the branch rule (this repo does not commit to `main`, except releases) -->

Create a git commit for the current changes using a concise Conventional Commits-style subject.

## Format

`<type>(<scope>): <summary>`

- `type` REQUIRED. Use `feat` for new features, `fix` for bug fixes. Other common types: `docs`, `refactor`, `chore`, `test`, `perf`.
- `scope` OPTIONAL. Short noun in parentheses for the affected area (e.g., `api`, `parser`, `ui`).
- `summary` REQUIRED. Short, imperative, no trailing period.

<!-- LOCAL ADAPTATION A: the length rule. Upstream says "<= 72 chars", but 8
     subjects on `main` exceed that, the longest 102 — the convention
     here is a full sentence carrying the actual claim, with the detail in the
     body. Telling an agent to obey 72 would shorten subjects this repo has
     deliberately written long. (Counted on `main` at `d4fcca9`: 8 subjects over
     72 characters, the longest 102. Do not restate the total in prose anywhere —
     it goes stale with every commit; count it when you need it.) Upstream's "do NOT add sign-offs" IS correct here
     and is kept verbatim: zero Signed-off-by trailers in the whole history. -->

## Notes

- Body is OPTIONAL. If needed, add a blank line after the subject and write short paragraphs.
- Do NOT include breaking-change markers or footers.
- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance. Common patterns:
  - Freeform instructions should influence scope, summary, and body.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## LOCAL ADAPTATION B: this repo does not commit to `main` — except for releases

Upstream's skill is repo-agnostic and would commit anywhere. Here `AGENTS.md`
requires a branch per change, and `main` moves only by a merged PR or a release
tag. The rule branches on *why* you are standing on `main*, not on `main` itself.

**Step zero, before any of it: is an operation already in progress?** A rebase,
merge, cherry-pick or bisect leaves HEAD detached, so the branch probe below
returns an empty string and reads as "no branch" — which sends you down the
"branch first" path. That path *succeeds* mid-rebase, and strands the operation:
the branch is created, the rebase is left pending, and the conflict resolution
you just committed belongs to neither the branch you meant to update nor the one
you are on. This repo sanctions rebases, and the likeliest conflict during one
is `CHANGELOG.md`, so it is not a corner case.

```bash
git status --porcelain=v2 --branch | head -1   # branch.head is "(detached)" mid-operation
ls .git/rebase-merge .git/rebase-apply 2>/dev/null   # rebase
git rev-parse -q --verify CHERRY_PICK_HEAD     # cherry-pick
git rev-parse -q --verify MERGE_HEAD           # merge
git rev-parse -q --verify REBASE_HEAD          # rebase (older git)
```

If any of those indicate work in progress: **finish that operation** —
`git rebase --continue`, `--skip`, or `--abort`; `git cherry-pick --continue`;
`git merge --continue`. Do not create a branch, and do not apply the rule below.
A resolution commit made mid-rebase needs `git rebase --continue` afterwards or
the rebase is not finished.

**Then, the branch rule:**

1. Check `git branch --show-current` — only meaningful once nothing is in
   progress, because step zero has ruled out the empty-string case.
   - **On a feature branch:** commit here. Nothing else to do.
   - **On `main` while making a change:** stop and branch first
     (`git checkout -b <change-name>`), then commit there. `main` is updated by
     merging a PR on GitHub (`gh pr merge`), never by committing on it or by
     fast-forwarding locally. A revert is an ordinary change and belongs on a
     branch — unless it undoes an already-tagged release, in which case the tag
     has to move too, so raise that rather than quietly re-tagging.
   - **On `main` during the release procedure in `AGENTS.md`:** commit here.
     That is the one place `main` is meant to move. This skill only commits; the
     tag and push are `AGENTS.md` Releases step 3.

Recorded exception, also deliberate: the `AGENTS.md` branch rule itself was
committed straight to `main` (`d4fcca9`) — a rule about `main` is only useful to
the next session if it is already there.

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` to understand the current changes (limit to argument-specified files if provided).
3. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
4. If there are ambiguous extra files, ask the user for clarification before committing.
5. Stage only the intended files (all changes if no files specified).
6. Run `git commit -m "<subject>"` (and `-m "<body>"` if needed).
