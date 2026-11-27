# Worktree review and repair

Part of the [`worktree`](../SKILL.md) skill. Read `../SKILL.md` first for the
location convention and the safety rules; this file assumes both.

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
already covers a directory.

Run its tests, after copying `.pi/settings.json` and running `setup-deps.sh`
(`lifecycle.md` § Create):

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


## Repair

When the main checkout - or the whole repository root - is moved (a remounted
`/workspace`, a relocated clone), the pointers between it and its worktrees go
stale, and the symptoms read like damage rather than bookkeeping:

- `git worktree list` shows a linked tree at a path that no longer exists, or
  marks it `prunable`.
- `git -C <worktree> status` fails with exit 128, because the tree's `.git` file
  still names the old main checkout.
- `git worktree prune -n` prints `Removing worktrees/<slug>: gitdir file points
  to non-existent location`.

`git worktree repair` rewrites those pointers, and the argument decides what it
can reach. A **bare** `git worktree repair` only repairs the worktrees it can
find, which means it handles a main checkout that moved while the trees stayed
where they were - it fixes each tree's `.git` file. It does **nothing** for a
moved repository root, where the recorded worktree paths are stale too
(verified: exits 0, prints nothing, trees still unusable). Pass each tree's
*current* path instead:

```bash
set -euo pipefail
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)" || {
  echo "cannot resolve the main checkout: run from a live checkout" >&2; exit 1; }
: "${COMMON:?cannot resolve the main checkout: run from a live checkout}"
R="$(dirname "$COMMON")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"   # where it is NOW

git -C "$R" worktree list                 # diagnose: a dead path, or `prunable`
git -C "$R" worktree repair "$WT"         # re-points the admin entry at "$WT"
git -C "$R" worktree list                 # "$WT" must now be listed at that path
git -C "$WT" rev-parse --abbrev-ref HEAD  # and git must work in the tree again
```

Verify with those last two commands rather than trusting the exit status:
`repair` exits 0 even when it prints a line beginning `fatal:`, and even when it
repairs nothing at all (both verified).

Do **not** run `git worktree prune` first, not even to "clean up" the stale
entry. It does not tolerate that entry, it deletes it - silently, so `-n` is the
only way to see what it will remove - and the entry is the pointer `repair`
needs: after a prune in this state, `git worktree repair "$WT"` fails with
`unable to locate repository; .git file does not reference a repository` and
the tree stays unusable (verified). Prune is for a tree whose directory is gone
for good; repair is for one that is somewhere else.

A **copied** worktree directory is not repairable into a second worktree. The
two copies share one administrative entry, so `git worktree repair <copy>` does
not add the copy beside the original - it re-points that single entry, and
`git worktree list` then names the copy while the original is left unlisted but
still usable (verified). Copy the whole repository and repair that, or create a
fresh worktree; to relocate one worktree on purpose, use `git worktree move`
(`lifecycle.md` § Remove).

Repair rewrites administrative files. It is not a replacement for `remove` when
the tree should be gone, and it cannot bring back a worktree whose directory no
longer exists.

