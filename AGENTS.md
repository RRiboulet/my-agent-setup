# Agent Notes

## Branches

Two long-lived branches, and everything else hangs off them:

| Branch | What lands on it |
|---|---|
| `dev` | all work in flight. Every feature branch starts here. |
| `main` | releases only. Nothing is built here; it is what a tag points at. |

**Start a feature branch from `dev`, never from `main` and never from another
feature branch.** Branch names name the change, not the session:
`attribute-native-web-search`, `fix-changelog-unreleased-structure`.

A branch merges into `dev` through a pull request. `dev` merges into `main` at
release time (see "Releases"). `main` is therefore always releasable, and a
half-finished change is never one merge away from a tag.

### Check your base before you commit

This is not ceremony. Branching off the wrong parent has happened three times in
one session, and each time it shipped a pull request carrying another branch's
commit — caught by a reviewer, not by the author. Two checks, and **both are
needed**, because the two ways of getting this wrong look different:

```bash
git fetch origin
git merge-base --is-ancestor dev HEAD    # 0 = base is right, 1 = it is not
git log --oneline dev..HEAD              # should list ONLY this change's commits
```

The ancestor check is the one that catches the mistake that actually happened:
branching off `main`, or off a `dev` that had fallen behind. In that case
`git log dev..HEAD` prints **nothing** — HEAD simply has nothing `dev` lacks — so
a check based only on that log reports a clean branch that is quietly based on
the wrong commit. The log is the second half: once the ancestor check fails, it
tells you *what* is in the way.

Verified both directions on a scratch branch:

| Situation | `git log dev..HEAD` | `merge-base --is-ancestor` |
|---|---|---|
| branched off `main`, which is behind `dev` | empty — **misses it** | **fails** — catches it |
| foreign commits stacked on `dev` | lists them | passes — correct, base is right |
| correct branch off `dev` | only my commits | passes |

`git fetch` first is not a detail. The check is only as good as the ref it
compares against, and a local `dev` left over from before three PRs merged will
happily list their commits as yours — the same false alarm as the bug it is meant
to catch, and just as likely to be ignored.

A branch legitimately based on **another unmerged feature branch** still shows
foreign commits, and neither check can tell that apart from a mistake. Subtract
the base branch explicitly (`git log dev..feature-a`) or rebase onto `dev` first.

### Why a branch per change

`CHANGELOG.md`'s `Unreleased` section is shared ground. Two changes in flight
both add a `Maintenance` bullet there, so parallel branches conflict on merge
even when their code does not. A branch keeps one change's tests, files and
changelog entry together, and makes each one independently verifiable: check it
out in a worktree and run the suite before assuming it stands alone.

When two branches are ready at once, merge or rebase in an order you choose
yourself — `dev` is not a priority queue.

## Pull requests

Branches reach GitHub through `gh`, which is baked into the devcontainer image
(`.devcontainer/Dockerfile`) rather than installed at runtime, so a rebuild does
not silently drop it. The token lives in the `pi-agent-config` volume via
`GH_CONFIG_DIR=/home/vscode/.pi/gh`, which is what makes one `gh auth login` last
across rebuilds — `/home/vscode` itself is container-local and is discarded.

One-time setup, run by the human (it needs a browser):

```bash
gh auth login --hostname github.com --git-protocol https --web
```

That is the whole setup. `git push` then works with no credential in
`.git/config`, because the Dockerfile registers gh as git's credential helper
system-wide — deliberately, not via `gh auth setup-git`, which writes to
`~/.gitconfig` on the container-local overlay and is discarded on rebuild. The
token would survive that; the helper would not, and push would break silently.

Check *where* the token lives before trusting a login: `gh auth status` prints the
path, and that path decides whether it survives.

## The workflow

Once authenticated:

1. Work on a branch (see "Branches"), committing as the `.pi/skills/commit/`
   skill directs where it is present.
2. `git push -u origin <branch>`
3. `gh pr create --fill` — `--fill` uses the commits for title and body, which
   this repo's long commit subjects suit. Always say in the body what a reviewer
   should check and what you verified.
4. `gh pr merge --squash --delete-branch`. `--delete-branch` is not optional
   politeness: a squash merge does not put the branch tip in `main`'s history, so
   a later `git branch -d <branch>` fails with "not fully merged" and needs `-D`.
   Letting gh delete both the local and the remote branch avoids both.
5. Bring `main` up to date: `git checkout main && git pull --ff-only`.

Tags are cut from `main`, never from a feature branch.

Never put a token in `.git/config`, in the Dockerfile, or in a file in the repo.
If authentication is needed mid-session, stop and ask rather than improvising.

Note the consequence for step 1 of any changelog work: after a squash merge the
branch's individual commits no longer exist in `main`, so release notes are
written from PR titles and bodies, not from `git log`.

## Releases

A release is the only thing that moves `main`. Everything since the last tag
accumulates on `dev`; `main` is brought forward and tagged.

1. On `dev`, update `CHANGELOG.md`: retitle `## Unreleased` to
   `## vX.Y.Z — <today's date>`, and add a fresh empty `## Unreleased` above it.
   Nothing else in the file moves. `.pi/skills/update-changelog/` has the detail,
   and `changelog-structure.test.ts` enforces the shape.
2. Commit that, push `dev`, and open a pull request **`dev` → `main`**. This is
   the one merge that is not a squash: a release wants its history, and `main`'s
   commits should be the real ones. Use "Rebase and merge" or "Merge commit",
   never "Squash".
3. `gh pr merge <n> --merge --delete-branch` — but do **not** let it delete
   `dev`. Re-create it locally if needed: `git branch dev origin/dev`.
4. Tag the merge commit on `main` and push the tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.

Versions are git tags. This repository is not published to npm — it is
`private` and consumes no npm packages, but it IS consumable as a pi package:
`package.json` carries a `pi` manifest listing the extension entry points and
skills, which is what makes `pi install git:github.com/RRiboulet/my-agent-setup`
work in another project.

## Extensions

Pi extensions live in `./.pi/extensions` and skills in `./.pi/skills`. When
working in this repo, add or update them there.

Adding a new extension or skill means adding it to the `pi` manifest in
`package.json` as well: it lives in a dot-prefixed directory, which package
discovery will not glob, so an unlisted extension installs nowhere.
`test/package-manifest.test.ts` fails if the manifest and the tree disagree.

You can consult pi for reference — the installed `@earendil-works/pi-coding-agent`
docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/` are the
source of truth for the API this code targets — but do not modify pi itself.

## Subagent tools

The five management tools — `subagent_status`, `subagent_cancel`,
`subagent_interrupt`, `subagent_resume`, `subagent_clean` — are **not declared**
in this repo's sessions: `defaultTools: ["+tool_search"]` in
`~/.pi/agent/settings.json` puts them behind `tool_search` so their descriptions
and schemas stop riding along on every request (measured: ~890 tokens a
request). `subagent` itself stays declared.

So reach them in two steps:

1. `tool_search` for the tool you want.
2. Then call it, e.g. `subagent_status({ id })`.

There is no blocking wait, so collecting a result means polling
`subagent_status` — `subagent_status({ compact: true })` is the cheap
one-line-per-run form, and the single-run path is the one that returns output.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh              # once: link pi's packages
node --test .pi/extensions/subagent/test/*.test.ts
```

Run it with `bash` (or `sh`), not as `./setup-deps.sh` — see "Line endings"
below. Node runs the TypeScript directly; there is no build step. See
`.pi/extensions/subagent/test/README.md` for what is and is not covered.

#### Typechecking: deliberately none

There is no `tsconfig.json` and no `tsc` in the tree, and this is on purpose.
`node --test` strips types without checking them, so a type error can survive
the suite — a known, accepted cost. Adding a typechecker would mean pulling in
the repo's first npm compiler dependency (it consumes no npm packages) and
reconciling a documented asymmetry: `todos.ts` uses TypeScript parameter
properties that node's strip-only loader rejects while pi's jiti loader
accepts, and the `erasableSyntaxOnly` setting that would resolve that is one
the files do not currently satisfy. The bug class a typechecker catches — a
bare identifier used as if it existed, a `HarnessOptions` field the factory
reads but no caller sets — is exactly what the P1/P2 audit fixed and pinned
with tests, so the residual risk is covered by the suite's load guards.
Decision recorded 2026-10-05 (TODO-914d99f8): not adopting a typecheck step.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so git *normalizes* CRLF away on
comparison. Two consequences that `git status` cannot surface:

- A file whose blob is LF may still be **CRLF in your working tree** if it was
  checked out before `.gitattributes` existed. It shows as clean, yet bash
  fails on it (`$'\r': command not found`, `set: pipefail: invalid option`).
- `git add` does not fix an already-CRLF blob retroactively for files the
  attribute did not apply to when they were first committed.

If a shell script fails inexplicably, check it before trusting `git status`:

```bash
grep -qU $'\r' <file> && echo "CRLF in working tree"
```

Repair the whole tree with:

```bash
git add --renormalize .
git ls-files -z | xargs -0 rm -f && git checkout-index -a -f   # re-checkout applies eol=lf
```

Keep shell files LF. The devcontainer bakes them in verbatim, and a trailing
`\r` ends up inside sourced paths (`~/.aliases.zsh^M`).