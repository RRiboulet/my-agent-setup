# Worktree lifecycle: create, list, open, remove

Part of the [`worktree`](../SKILL.md) skill. Read `../SKILL.md` first for the
location convention and the safety rules; this file assumes both.

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
scripts; its suite is `node --test`, see `review-repair.md` § Review):

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

To delegate work to a subagent rooted in the worktree, read
[`parallel.md`](parallel.md) - the `cwd` rule and the duplicate-extension
failure live there.

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

- **A printable separator, not a control character**: a pane path or session
  name containing a space makes `$2` match nothing - or the wrong session. A
  tab is worse: tmux rewrites it to `_` when the server runs in a non-UTF-8
  locale (measured on the stock Ubuntu and Debian packages, tmux 3.2a-3.6,
  whenever `LANG` and `LC_ALL` are unset), so the separator vanishes and the
  sweep silently matches nothing - the removal then deletes the tree from
  under a live shell, which is the leak this whole block exists to prevent.
  `|` survives every locale; a path containing `|` is pathological.
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
tmux -S "$SOCKET" list-panes -a -F "#{session_name}|#{pane_current_path}" 2>/dev/null |
  WT="$WT" awk -F'|' '$2==ENVIRON["WT"] || index($2, ENVIRON["WT"] "/")==1 {print $1}' |
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

