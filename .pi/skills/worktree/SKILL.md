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
The guard resolves the **main** checkout root first: this section is the first
thing an agent reads, and the guard runs before Create's main-checkout refusal,
so it is routinely run from inside a linked worktree - where a relative
`.gitignore` is that worktree's own ignored copy, not the file the branch will
commit. It fails loudly rather than falling back to the cwd when the root cannot
be resolved (`dirname ""` is `.`, which would silently edit an unrelated file).
The guard uses `-F` because the pattern is a literal path and `-x` so a longer
line does not count as the entry; the newline is added first because appending
to a file without a trailing newline would glue the entry onto its last line
(verified: `node_modules` became `node_modules.worktrees/`):

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

Every recipe below resolves the **main** checkout root with
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
# behind `dev` - so measure BASE. Two checks, because a wrong base looks like two
# different things: BASE behind origin/dev (a stale local `dev`) fails the
# ancestor check; BASE *ahead* of origin/dev with its own unmerged commits passes
# it, and only the log check below sees it. AGENTS.md asks for both for that
# reason. An unmerged base is refused on purpose; `BASE_STACKED=1` is the
# deliberate way to stack on one.
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
# Second half of the check: ancestry cannot see commits BASE carries beyond
# origin/dev, so a feature branch that already contains origin/dev passes above
# while stacking the new branch on work nobody has merged.
FOREIGN="$(git log --oneline "origin/dev..$BASE")"
if [ -n "$FOREIGN" ]; then
  COUNT="$(printf '%s\n' "$FOREIGN" | wc -l)"
  if [ -n "${BASE_STACKED:-}" ]; then
    # stderr, not stdout: the recipe's own later output would swallow a warning
    # printed into the stream the caller is reading for the worktree path.
    echo "warning: stacking on $BASE, which carries $COUNT commit(s) not in origin/dev (BASE_STACKED is set)" >&2
  else
    echo "$BASE carries $COUNT commit(s) that origin/dev does not have:" >&2
    printf '%s\n' "$FOREIGN" >&2
    echo "refusing to cut a new branch from an unmerged base: rebase $BASE onto origin/dev (or cut from origin/dev), or set BASE_STACKED=1 to stack on $BASE deliberately" >&2
    exit 1
  fi
fi

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
- An unmerged feature branch as `BASE` is **refused**, not silently stacked on:
  the block checks `git log origin/dev.."$BASE"` as well as ancestry, and exits
  non-zero listing the commits it carries. `BASE_STACKED=1` is the deliberate
  opt-in for the legitimate stacked case - it proceeds and warns on stderr, so
  the stack is visible in the output instead of implied by it.

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
an absolute `cwd`). Resolve the path the same way the recipes above do:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
echo "$WT"   # /path/to/that/clone/.worktrees/task-name - pass this as cwd
```

Then pass that expanded path, not a variable (a tool call is not a shell):

```
subagent({ task: "...", cwd: "<the path printed above>" })
```

The child loads the **worktree's own** copy of this repo's extension: pi
discovers project extensions from the child's `cwd` when that project is
trusted, so within this repo the launcher hands it that path explicitly rather
than the main checkout's. That is also why the two must not be mixed - the
failure is in the note below. A `cwd` outside this repo's trusted tree keeps the
launcher's own copy instead, because an explicit extension path is loaded even
for a project pi would refuse to trust.

Use an absolute path for `cwd`, never a relative one. One worktree per
subagent: the same branch cannot be checked out twice, and two subagents in one
worktree collide on `index.lock`. Do not remove a worktree while a subagent
rooted in it is still running - cancel or wait for it to finish first.

If such a subagent exits about two seconds in and all you see is "Child Pi
exited before reporting a result", read the dead child's tmux pane before
anything else: `subagent_status` reports only that generic line, while the pane
holds the reason. A launcher that passed the main checkout's extension path to
a child rooted in a worktree hit this:

```
Failed to load extension ".../.worktrees/task-name/.pi/extensions/subagent/index.ts":
Flag "--attach-subagent" conflicts with /path/to/repo/.pi/extensions/subagent/index.ts
```

That is two copies of one extension, not two extensions: pi discovers the
worktree's copy as the project extension, so the explicit flag must name the
same file the child would discover. This repo's launcher resolves the child's
copy, so the recipe above works. On a checkout without that fix, launch with
`cwd` = the repository root and `cd` into the worktree inside each command
instead, which keeps the child's discovery pointed at the main checkout.

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

The three blocks that destroy or check something - the removal, the branch
cleanup and the end-state check - each set `set -euo pipefail` themselves, and
that is deliberate: a refused removal is a *stop*, not a warning. Worth saying
for a reader pasting one of these blocks into a larger script: errexit stays on
for the rest of that script, so a later command that merely returns non-zero (a
`grep` that finds nothing, a false `[ ... ]`) will now abort it. The
alternative, chaining `|| exit 1` after every command, reads worse and gets
dropped in editing, which is exactly how the removal block came to exit 0 after
git had refused it: `git worktree remove` exits 128 on a dirty tree, the tree
survives, `git worktree list` still lists it - and the trailing `|| true` on the
`rmdir` underneath turned all of that into success. An agent reads exit 0 as
"removed" and moves on with the branch still checked out.

Each of those blocks also resolves the main checkout itself and fails loudly
instead of guessing. With a deleted cwd - or outside a checkout entirely -
`git rev-parse --path-format=absolute --git-common-dir` exits 128 and prints
**nothing** (verified), so there is no root left to build `$WT` from: `dirname
""` hands you `.`, and the removal then runs against `./.worktrees/<slug>` - or
against `/.worktrees/<slug>` if `$R` itself stays empty - instead of the tree you
named. So the resolution is an explicit guard, not an assumption that a failure
leaves the old value or `""` behind. It is repeated per block because these
recipes are copied one at a time and nothing carries over between calls.

Stop any tmux sessions rooted in the tree first (by path, not by name), then
remove. Three details in the sweep are load-bearing, each verified by breaking
it:

- **Tab-separated, not space-split**: a pane path or session name containing a
  space makes `$2` match nothing - or the wrong session.
- **The path goes in the environment, never `awk -v`**: `-v` interprets C-style
  escapes in its value, so a worktree path containing a backslash arrives as a
  different string, matches no pane, and leaks the session - so the removal on
  the next line takes the tree from under a live shell. `ENVIRON` passes it
  verbatim.
- **Deduplicated before the kill loop**: `list-panes -a` prints one row per
  *pane*, so a multi-pane session appears once per pane and every kill after the
  first fails with "can't find session".

Only the sweep is tolerated, and only because its first stage is a listing that
fails whenever no tmux server is running, which is the normal case for a fresh
container: with `pipefail` that status would otherwise abort a clean removal.
Nothing after it - the removal above all - has an escape hatch.

```bash
set -euo pipefail

# Resolve the main checkout from the common git dir. Fails loudly instead of
# leaving $R empty, which would point $WT at `/.worktrees/<slug>`.
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || {
  echo "cannot resolve the main checkout: run from a live checkout" >&2; exit 1; }
: "${COMMON:?cannot resolve the main checkout: run from a live checkout}"
R="$(dirname "$COMMON")"

SLUG="task-name"; : "${SLUG:?SLUG must be set}"; WT="$R/.worktrees/$SLUG"
SOCKET="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}/pi.sock"

# No tmux server is the normal case: tolerate the sweep, never the removal.
tmux -S "$SOCKET" list-panes -a -F "#{session_name}"$'\t'"#{pane_current_path}" 2>/dev/null |
  WT="$WT" awk -F'\t' '$2==ENVIRON["WT"] || index($2, ENVIRON["WT"] "/")==1 {print $1}' |
  sort -u |
  while IFS= read -r s; do tmux -S "$SOCKET" kill-session -t "$s"; done || true

# No `|| true` on the removal: a refusal must be this block's exit status.
git -C "$R" worktree remove "$WT"   # refuses if dirty - that refusal is the review prompt
# Only once you have read `git -C "$WT" status` and accepted the loss:
#   git -C "$R" worktree remove -f "$WT"
rmdir -p "$(dirname "$WT")" 2>/dev/null || true   # ignored only now that removal succeeded
```

Branch cleanup comes *after* the worktree is gone - git refuses to delete a
branch that is checked out in a worktree. Note that this repo's normal flow is
a squash merge, which leaves the local branch "not fully merged" as far as git
is concerned, so `git branch -d` fails after a normal pull request here. Verify
the PR merged first, then force-delete:

```bash
set -euo pipefail
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || {
  echo "cannot resolve the main checkout: run from a live checkout" >&2; exit 1; }
: "${COMMON:?cannot resolve the main checkout: run from a live checkout}"
R="$(dirname "$COMMON")"
SLUG="task-name"; : "${SLUG:?SLUG must be set}"
# gh pr view "$SLUG" --json state,mergedAt   # confirm merged
git -C "$R" branch -D "$SLUG"   # only after the worktree is removed and the PR is merged
```

Clean up administrative metadata for worktrees whose directories were deleted
outside of git:

```bash
git worktree prune -n     # dry run first
git worktree prune
```

End-state check after removal (`SLUG` is set here because `git branch --list ""`
prints nothing and exits 0 - an unset variable would make the check vacuous). The
root is resolved here too: from a deleted cwd every bare `git` call fails 128
with "Unable to read current working directory" and says nothing about what to
do, which reads like an ordinary failure of the removal rather than a bad cwd.

```bash
set -euo pipefail
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || {
  echo "cannot resolve the main checkout: run from a live checkout" >&2; exit 1; }
: "${COMMON:?cannot resolve the main checkout: run from a live checkout}"
R="$(dirname "$COMMON")"
SLUG="task-name"; : "${SLUG:?SLUG must be set}"
git -C "$R" worktree list          # only the main worktree expected
git -C "$R" worktree prune -n      # must print nothing
git -C "$R" branch --list "$SLUG"  # must print nothing
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
