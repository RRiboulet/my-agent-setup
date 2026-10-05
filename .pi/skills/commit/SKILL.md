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

<!-- LOCAL ADAPTATION A: the length rule. Upstream says "<= 72 chars", but 8 of
     the 30 commits in this repo exceed that, the longest at 102 — the convention
     here is a full sentence carrying the actual claim, with the detail in the
     body. Telling an agent to obey 72 would shorten subjects this repo has
     deliberately written long. Upstream's "do NOT add sign-offs" IS correct here
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
requires a branch per change, and `main` moves only to take a release. So the
rule branches on *why* you are standing on `main`, not on `main` itself:

1. Check `git branch --show-current`.
   - **On a feature branch:** commit here. Nothing else to do.
   - **On `main` while making a change:** stop and branch first
     (`git checkout -b <change-name>`), then commit there. `main` moves by
     fast-forwarding a reviewed branch, not by committing on it. Reverts and
     merge-conflict resolutions are ordinary changes and belong on a branch —
     and note that you cannot branch mid-merge anyway, so finish or abort the
     merge first.
   - **On `main` during the release procedure in `AGENTS.md`:** commit here.
     That is the one place `main` is supposed to move, and the release commit
     belongs to it. This skill only commits; the fast-forward and the tag are
     separate steps of that procedure.

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