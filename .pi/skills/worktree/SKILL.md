---
name: worktree
description: "Create, list, open, review, and remove git worktrees (linked working trees) for independent tasks. Use when: a task needs an isolated working tree or branch without disturbing the current checkout; or parallel tasks need separate checkouts."
---

# Git worktrees for independent tasks

A git worktree is a *linked working tree* attached to the same repository: it
shares the object database and refs, so branches created in one worktree are
visible in all of them, but each has its own HEAD, index and checked-out files.
Use one when a task needs its own branch and files without stashing or
switching the current checkout - for parallel agent tasks, experiments, or
reviewing a branch while keeping your own work in place.

This repository's branches (`dev`, feature branches off `dev`) are unaffected by
worktrees: a worktree is just another checkout of a ref, not a new repository.

Throughout this skill, "worktree" means a *linked* worktree. `AGENTS.md`,
`review-triage` and `goal.ts` also use "worktree" in the plain "working tree"
sense; where that matters, this skill says "linked worktree".

## What lives where

This file carries the convention and the rails; the recipes sit behind three
pointers. Load one only when its branch applies.

| Reference | Load it when |
|---|---|
| [`references/lifecycle.md`](references/lifecycle.md) | you are creating, listing, opening, moving or removing a worktree - the full recipes, including the base-hygiene refusal and the removal sweep |
| [`references/review-repair.md`](references/review-repair.md) | you are inspecting what a worktree changed, running its tests, or re-pointing worktrees after the main checkout moved (`git worktree repair`) |
| [`references/parallel.md`](references/parallel.md) | more than one agent works at once: subagent `cwd` rules, one-branch-per-worktree, and the duplicate-extension failure a child rooted in a worktree can hit |

Every recipe in those files resolves paths the same way and assumes the safety
rules below. None of them carries state between bash calls.

## Location convention

All worktrees for this repo live under `.worktrees/<slug>` at the repository
root, where `<slug>` is the branch name (slashes become nested directories, so
`feature/foo` lands at `.worktrees/feature/foo`). The directory is gitignored,
so its contents are never committed - only the `.gitignore` entry itself is.
Keeping them *inside* the repo matters: project trust in
`~/.pi/agent/trust.json` is keyed on `/workspace` and inherited by
descendants, so a worktree under `/workspace` loads this repo's project
extensions and skills. A worktree outside the repo (e.g. in `/tmp`) is a
different project and may not load them in headless mode.

Before creating the first one, make sure the ignore entry exists (idempotent).
The guard resolves the **main** checkout root first: this section is the first
thing an agent reads, and the guard runs before the create recipe's
main-checkout refusal, so it is routinely run from inside a linked worktree -
where a relative `.gitignore` is that worktree's own ignored copy, not the file
the branch will commit. It fails loudly rather than falling back to the cwd when
the root cannot be resolved (`dirname ""` is `.`, which would silently edit an
unrelated file). The guard uses `-F` because the pattern is a literal path and
`-x` so a longer line does not count as the entry; the newline is added first
because appending to a file without a trailing newline would glue the entry onto
its last line (verified: `node_modules` became `node_modules.worktrees/`):

```bash
GIT_COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" && [ -n "$GIT_COMMON" ] || {
  echo "cannot resolve the main checkout root: git rev-parse --git-common-dir failed (run this inside the repository)" >&2
  exit 1
}
MAIN="$(dirname "$GIT_COMMON")"
[ -s "$MAIN/.gitignore" ] && [ -n "$(tail -c 1 "$MAIN/.gitignore")" ] && printf '\n' >> "$MAIN/.gitignore"
grep -qxF '.worktrees/' "$MAIN/.gitignore" 2>/dev/null || printf '.worktrees/\n' >> "$MAIN/.gitignore"
```

Either `.worktrees` or `.worktrees/` ignores the directory; the slash form is
the convention here.

If `.gitignore` changed, commit that change on a feature branch off `dev`
(never on `dev` directly - see `commit/SKILL.md`), through the normal pull
request workflow.

Every recipe in this skill resolves the **main** checkout root with
`git rev-parse --path-format=absolute --git-common-dir` before touching a path,
then appends `.worktrees/<slug>`; the ignore guard above resolves that same
root, but appends the directory pattern rather than a slug. That works from
anywhere, including from inside a linked worktree - where `--show-toplevel`
would return the worktree you are standing in and silently nest the path. The
one thing that still must not happen is a `git worktree remove` issued from
inside the tree being removed.

## Safety rules (read first)

- Never remove or overwrite the **main worktree** (the original checkout). Only
  ever `remove` linked worktrees.
- A worktree with uncommitted changes cannot be removed without `-f`. Review it
  first (`git status`, `git diff`) and, if you are sure, pass `-f` explicitly.
  Do not use `-f` to skip a review you have not done.
- A branch can be checked out in **at most one** worktree. `git worktree add`
  fails with "already used by worktree at ..." if you try. Detached worktrees
  (`-d`) are the exception - they share a commit, not a branch.
  `git branch --list` alone does **not** tell you whether a branch is already
  checked out somewhere; use `git worktree list`.
- Deleting the branch (`git branch -d/-D`) is a separate, deliberate step. A
  worktree's branch may still be unmerged; only delete it when the user asks or
  it is merged.
- Never run `git worktree remove` from *inside* the worktree being removed.
  Git itself allows it (verified), but the directory holding your shell's cwd
  disappears, so every later command in that shell fails. `cd` out first, or
  use `git -C <main-root>`.
- Locked worktrees (portable/unmounted storage) must be `unlock`ed before
  removal; `remove -f -f` also overrides a lock, but prefer unlocking.
- Worktrees share refs: creating or deleting a branch in one is visible
  everywhere. Check `git worktree list` before assuming a name is free.
- `.worktrees/` is ignored, and `git clean -xdf` in the main checkout **skips**
  each linked worktree: its `.git` entry makes git treat it as a nested
  repository (`Skipping repository .worktrees/x`), leaving the files in place
  while `git worktree list` keeps reporting the tree. `git clean -xdff` does
  delete them. Never pass two `-f`s without checking `git worktree list` first.
- Each bash tool call starts fresh: variables and cwd do not persist. Every
  recipe in this skill and its references is self-contained and uses absolute
  paths. Never rely on a variable set in an earlier call.

## Choosing between worktree and branch

- Same checkout, just a new branch: `git checkout -b` / `git switch -c`.
- Need the files of two branches present at once, or a clean tree for a
  parallel task without disturbing in-flight work: use a linked worktree.
- Need a totally separate repository copy (different remotes, no shared refs):
  clone instead.
- For a simple one-off command on another branch, `git -C` is not needed;
  `git show <branch>:path` or `git diff <branch>` reads without checking out.

## When NOT to use a worktree

- Do not create a worktree inside a worktree's own `.git` directory or reuse a
  path that is already a worktree.
- Do not nest worktrees so deeply that a tool's recursive scan (or `git
  status`) walks into them; the `.worktrees/` ignore entry prevents this for
  the main tree, but a worktree's own ignored set is independent - keep
  `.worktrees/` ignored in each branch that might create one.
- Do not run `git clean -xdff` without checking for linked worktrees first.

## Cross-references

- `librarian/SKILL.md` ("If edits are needed") suggests a worktree or a copy
  for editing a cached checkout. That worktree would be of the *cache*, which
  lives under the agent dir, outside this repo - so the `.worktrees/`
  convention here does not apply to it.
- `repo-explorer` (`/explore`) reads another branch's files without any
  checkout - prefer it for read-only review.
- `/review` folder mode and `triage_change` (which accepts `cwd`) already cover
  reviewing a worktree directory.
