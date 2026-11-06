---
name: worktree
description: "Create, list, open, review, and remove git worktrees (linked working trees) for independent tasks. Use when a task needs an isolated working tree/branch without disturbing the current checkout, or when parallel tasks need separate checkouts."
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
The guard uses `-F` because the pattern is a literal path and `-x` so a longer
line does not count as the entry; the newline is added first because appending
to a file without a trailing newline would glue the entry onto its last line
(verified: `node_modules` became `node_modules.worktrees/`):

```bash
[ -s .gitignore ] && [ -n "$(tail -c 1 .gitignore)" ] && printf '\n' >> .gitignore
grep -qxF '.worktrees/' .gitignore 2>/dev/null || printf '.worktrees/\n' >> .gitignore
```

Either `.worktrees` or `.worktrees/` ignores the directory; the slash form is
the convention here.

If `.gitignore` changed, commit that change on a feature branch off `dev`
(never on `dev` directly - see `commit/SKILL.md`), through the normal pull
request workflow.

Every recipe below resolves the **main** checkout root with
`git rev-parse --path-format=absolute --git-common-dir`, then appends
`.worktrees/<slug>`. That works from anywhere, including from inside a linked
worktree - where `--show-toplevel` would return the worktree you are standing
in and silently nest the path. The one thing that still must not happen is a
`git worktree remove` issued from inside the tree being removed.

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
  recipe below is self-contained and uses absolute paths. Never rely on a
  variable set in an earlier call.

## Create

Self-contained creation. Pick a slug (branch name) and a base. Slashes in the
slug are fine and become nested directories.

```bash
R="$(git rev-parse --show-toplevel)" || exit 1
SLUG="task-name"; : "${SLUG:?SLUG must be set}"
BASE="${BASE:-origin/dev}"

# Main checkout only: inside a linked worktree this R is that worktree, and the
# new tree would be nested inside it.
MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
[ "$R" = "$MAIN" ] || { echo "run this from the main checkout ($MAIN), not a linked worktree" >&2; exit 1; }

# Base hygiene (AGENTS.md: check your base before you commit). The new branch is
# cut from BASE, not from this checkout's HEAD - which may legitimately be `main`,
# behind `dev` - so measure BASE. A stale local `dev` is the mistake this catches;
# an unmerged feature branch as BASE fails on purpose (see AGENTS.md).
git fetch origin
# Accept a local ref or the remote shorthand (`BASE=dev` when only origin/dev
# exists), and fail loudly when there is nothing to compare against.
git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null || {
  if git rev-parse --verify --quiet "origin/$BASE^{commit}" >/dev/null; then
    BASE="origin/$BASE"
  else
    echo "unknown base: $BASE" >&2; exit 1
  fi
}
git rev-parse --verify --quiet "origin/dev^{commit}" >/dev/null || {
  echo "no origin/dev to compare against (run 'git fetch origin')" >&2; exit 1; }
git merge-base --is-ancestor origin/dev "$BASE" || {
  echo "$BASE does not descend from origin/dev; rebase it or base on origin/dev" >&2; exit 1; }

WT="$R/.worktrees/$SLUG"
mkdir -p "$(dirname "$WT")"

# Refuse to clobber an existing path or worktree.
if [ -e "$WT" ]; then echo "path already exists: $WT" >&2; exit 1; fi

# Branch handling: local branch, remote-tracking branch, or brand-new branch.
if git show-ref --verify --quiet "refs/heads/$SLUG"; then
  # Local branch exists: fails if it is already checked out elsewhere.
  git worktree add "$WT" "$SLUG"
elif git show-ref --verify --quiet "refs/remotes/origin/$SLUG"; then
  # Remote-tracking branch: create a local tracking branch (not detached HEAD).
  git worktree add "$WT" -b "$SLUG" --track "origin/$SLUG"
else
  git worktree add "$WT" -b "$SLUG" "$BASE"
fi
```

Notes:
- `git worktree add path branch` for an *existing* local branch checks it out;
  naming a remote-tracking ref without `-b` checks out a **detached HEAD**, so
  commits there land on no branch. Use the `-b ... --track` form above.
- `git worktree add path branch` fails if that branch is already checked out in
  another worktree. Choose another slug or remove the other worktree first.
- A dirty main checkout carries **nothing** into the new worktree (verified).
  If you want the in-flight changes there, stash in main (the stash ref is
  shared and applies cleanly in the worktree) or commit them to a temp branch.
- `git worktree add path dev` fails with "already used by worktree" when `dev`
  is checked out in the main tree; base on `origin/dev` instead.

After creating, copy project settings (gitignored, so absent from the new tree)
and link pi's packages if you will run tests:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
[ -f "$R/.pi/settings.json" ] && { mkdir -p "$WT/.pi"; cp "$R/.pi/settings.json" "$WT/.pi/settings.json"; }
(cd "$WT" && bash .pi/extensions/subagent/test/setup-deps.sh)
```

`.pi/todos/` is also gitignored and per-cwd (`<cwd>/.pi/todos`), so a task
claimed in the main checkout is invisible from a worktree. Claim todos in the
worktree where the work happens, or keep todo state in the main checkout only.

## List

```bash
git worktree list                      # path, HEAD, branch; first line is main
git worktree list --porcelain          # machine-readable, one record per worktree
```

Linked worktrees show their branch in brackets (`[feat-x]`) or
`(detached HEAD)`. `git worktree list` annotates a locked worktree with just
`locked` - the reason appears only in `--porcelain`, on the `locked <reason>`
line - and a stale one with `prunable`; in `git branch` output, `+` marks
branches checked out in a linked worktree.

To see what each worktree is doing (paths may contain spaces - use `while read`):

```bash
git worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r wt; do
  printf '=== %s ===\n' "$wt"
  git -C "$wt" status --short --branch
done
```

## Open

There is no editor on this host, so "open" means *run commands against that
tree* or *start a shell/session in it*. Every call is self-contained; use an
absolute `$WT`.

One-off command without changing your own cwd:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
git -C "$WT" status
git -C "$WT" log --oneline -5
```

Or change directory for a single shell invocation (this repo has no `npm`
scripts; its suite is `node --test`, see Review below):

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
(cd "$WT" && git status --short --branch && git log --oneline -3)
```

Persistent shell (tmux) in the worktree. Sanitize the session name (flatten
slashes/dots/colons, which tmux rewrites or rejects), check for an existing
session, and verify the pane's path:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
SOCKET="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}/pi.sock"
mkdir -p "$(dirname "$SOCKET")"
NAME="pi-wt-$(printf '%s' "$SLUG" | tr '/.:' '---')"
[ -d "$WT" ] || { echo "no worktree at $WT" >&2; exit 1; }
if tmux -S "$SOCKET" has-session -t "$NAME" 2>/dev/null; then
  # Sanitizing maps feature/x and feature-x to the same name, so verify the
  # existing session really is rooted here before reporting it as this tree's.
  ACTUAL="$(tmux -S "$SOCKET" display-message -p -t "$NAME:0.0" '#{pane_current_path}')"
  [ "$ACTUAL" = "$WT" ] || { echo "session $NAME is rooted at $ACTUAL, not $WT; pick another slug" >&2; exit 1; }
  echo "session exists: tmux -S '$SOCKET' attach -t '$NAME'"
else
  tmux -S "$SOCKET" new -d -s "$NAME" -c "$WT" -n pi
  ACTUAL="$(tmux -S "$SOCKET" display-message -p -t "$NAME:0.0" '#{pane_current_path}')"
  [ "$ACTUAL" = "$WT" ] || { echo "pane path mismatch: $ACTUAL != $WT" >&2; exit 1; }
  echo "started: tmux -S '$SOCKET' attach -t '$NAME'"
fi
```

Then tell the user the expanded attach command, as the `tmux` skill requires.

Delegate a task to a subagent rooted in the worktree (the subagent tool takes
an absolute `cwd`):

```
subagent({ task: "...", cwd: "/workspace/.worktrees/task-name" })
```

Use the repository root, not a relative path, for `cwd`. One worktree per
subagent: the same branch cannot be checked out twice, and two subagents in one
worktree collide on `index.lock`. Do not remove a worktree while a subagent
rooted in it is still running - cancel or wait for it to finish first.

## Review

Inspect a worktree's own changes. Always pair the committed diff with staged,
untracked, and status output, because the three-dot diff alone hides untracked
files (a brand-new skill directory, for instance):

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
git -C "$WT" status --short --branch
git -C "$WT" ls-files --others --exclude-standard
git -C "$WT" diff --stat
git -C "$WT" diff
git -C "$WT" diff --cached
git -C "$WT" log --oneline --decorate -10
```

Compare the worktree's branch to its base. Fetch first and base on `origin/dev`
so a stale local `dev` cannot attribute upstream commits to the branch:

```bash
git fetch origin
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
git -C "$WT" diff --stat "origin/dev...$SLUG"
git -C "$WT" diff "origin/dev...$SLUG"
# or, to be independent of local refs:
git -C "$WT" diff "$(git -C "$WT" merge-base origin/dev HEAD)"
```

For read-only inspection of another branch without any checkout, use
`/explore <branch>:<path>` (repo-explorer) or `/review` in folder mode, which
already covers a directory. `triage_change` also accepts a `cwd`, so it can
target a worktree directly.

Run its tests (after linking pi packages as above):

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
(cd "$WT" && node --test .pi/extensions/subagent/test/*.test.ts)
```

Lock a worktree you want to keep safe from pruning (e.g. on removable
storage):

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
git worktree lock --reason "in use" "$WT"
git worktree unlock "$WT"
```

## Remove

Stop any tmux sessions rooted in the tree first (by path, not by name), then
remove. The sweep is tab-separated rather than space-split, because a pane path
or session name containing a space makes `$2` match nothing - or the wrong
session (both verified):

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
SOCKET="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}/pi.sock"
tmux -S "$SOCKET" list-panes -a -F "#{session_name}"$'\t'"#{pane_current_path}" 2>/dev/null |
  awk -F'\t' -v wt="$WT" '$2==wt || index($2, wt "/")==1 {print $1}' |
  while IFS= read -r s; do tmux -S "$SOCKET" kill-session -t "$s"; done

git worktree remove "$WT"     # refuses if dirty - that refusal is the review prompt
# Only once you have read `git -C "$WT" status` and accepted the loss:
#   git worktree remove -f "$WT"
rmdir -p "$(dirname "$WT")" 2>/dev/null || true
```

Branch cleanup comes *after* the worktree is gone - git refuses to delete a
branch that is checked out in a worktree. Note that this repo's normal flow is
a squash merge, which leaves the local branch "not fully merged" as far as git
is concerned, so `git branch -d` fails after a normal pull request here. Verify
the PR merged first, then force-delete:

```bash
SLUG="task-name"
# gh pr view "$SLUG" --json state,mergedAt   # confirm merged
git branch -D "$SLUG"     # only after the worktree is removed and the PR is merged
```

Clean up administrative metadata for worktrees whose directories were deleted
outside of git:

```bash
git worktree prune -n     # dry run first
git worktree prune
```

End-state check after removal (`SLUG` is set here because `git branch --list ""`
prints nothing and exits 0 - an unset variable would make the check vacuous):

```bash
SLUG="task-name"
git worktree list                 # only the main worktree expected
git worktree prune -n             # must print nothing
git branch --list "$SLUG"         # must print nothing
```

Move a worktree instead of removing/recreating it:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; NEW_SLUG="feature/task-name-2"
mkdir -p "$R/.worktrees/$(dirname "$NEW_SLUG")"   # move does not create parents (verified)
git worktree move "$R/.worktrees/$SLUG" "$R/.worktrees/$NEW_SLUG"
```

## Parallel subagents

- One worktree, one branch, one slug per subagent. The same branch cannot be
  checked out twice, and two subagents sharing one worktree collide on
  `index.lock`.
- Pass an absolute `cwd` (`<repo-root>/.worktrees/<slug>`), not a relative
  path.
- Remove a worktree only after `subagent_status({ compact: true })` shows the
  run terminal; cancel it first if you cannot wait. Because subagent launch is
  queued and tmux's `-c` silently falls back to the server's cwd when the path
  is missing, a vanished worktree can run in the wrong directory instead of
  failing.

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
