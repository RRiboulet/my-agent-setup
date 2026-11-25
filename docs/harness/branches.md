# Branch Discipline and Base Verification

## Why check the base before committing

Branching off the wrong parent happened three times in one session, each time shipping a pull request carrying another branch's commits — caught by a reviewer rather than the author. Both manual checks below are needed because the two failure modes look different:

```bash
git fetch origin
git merge-base --is-ancestor dev HEAD    # 0 = base is right, 1 = it is not
git log --oneline dev..HEAD              # should list ONLY this change's commits
```

The ancestor check catches branching off `main` or off a stale `dev`. In that case `git log dev..HEAD` prints nothing — `HEAD` has nothing `dev` lacks — so a log-only check reports a clean branch that is quietly based on the wrong commit. Once the ancestor check fails, the log shows what is in the way.

| Situation | `git log dev..HEAD` | `merge-base --is-ancestor` |
|---|---|---|
| Branched off `main` (behind `dev`) | empty — misses it | fails — catches it |
| Foreign commits stacked on `dev` | lists them | passes — base is right |
| Correct branch off `dev` | only this change's commits | passes |

`git fetch` first is essential: comparing against an outdated local `dev` flags already-merged PRs as foreign commits, causing false alarms.

`node tools/branch-base.mjs` runs both checks plus the stacked-branch case against freshly fetched `origin/dev` and prints one line naming the classification (`correct`, `superseded`, `behind-dev`, `foreign-commits`, `wrong-base`) and the fix.

A branch legitimately stacked on an unmerged feature branch shows foreign commits; subtract the base branch explicitly (`git log dev..feature-a`) or rebase onto `dev` first.

## Why a branch per change

`CHANGELOG.md`'s `Unreleased` section is shared ground: two in-flight changes that both add a `Maintenance` bullet conflict on merge even when their code does not. Keeping one branch per change isolates its tests, files, and changelog entry and makes each branch independently verifiable in a worktree. When multiple branches are ready at once, merge or rebase in any order — `dev` is not a priority queue.
