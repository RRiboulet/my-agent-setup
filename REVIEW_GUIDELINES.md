# Project Review Guidelines

These guidelines supplement the default review rubric. When in conflict,
project guidelines take precedence.

## Branch hygiene

- **Always check your base before committing.** A branch must be based on
  `dev`, never on `main` or on another feature branch. Verify with:
  ```bash
  git fetch origin
  git merge-base --is-ancestor dev HEAD    # must succeed
  git log --oneline dev..HEAD              # must list ONLY this change's commits
  ```
- A branch legitimately based on another unmerged feature branch still shows
  foreign commits in `git log dev..HEAD`. Subtract the base explicitly
  (`git log dev..feature-a`) or rebase onto `dev` first.

## Tokens and secrets

- Never put a token in `.git/config`, in a Dockerfile, or in a file tracked
  in the repo. If authentication is needed mid-session, stop and ask rather
  than improvising.
- The `gh` token lives in the `pi-config` volume at
  `/home/vscode/.pi/gh`. The Dockerfile sets `GH_CONFIG_DIR` so `gh auth`
  survives rebuilds.

## Changelog

- `CHANGELOG.md`'s `Unreleased` section is shared ground. Two changes in
  flight both adding a `Maintenance` bullet will conflict on merge even when
  their code does not.
- The `Unreleased` section must be retitled to the current version at release
  time, and a fresh empty `## Unreleased` must be added above it.
- Nothing else in `CHANGELOG.md` moves during a release.

## PR workflow

- After a squash merge the branch's individual commits no longer exist in
  `main`, so release notes are written from PR titles and bodies, not from
  `git log`.
- PR bodies must state what a reviewer should check and what was verified.
- Never build on `main`; everything is built on `dev`.

## Line endings

- `.gitattributes` sets `* text=auto eol=lf`. A file whose blob is LF may
  still be CRLF in the working tree if it was checked out before the attribute
  existed. It shows as clean in `git status` yet bash fails on it.
- If a shell script fails inexplicably, check it before trusting `git status`:
  ```bash
  grep -qU $'\r' <file> && echo "CRLF in working tree"
  ```
- Repair the whole tree with:
  ```bash
  git add --renormalize .
  git ls-files -z | xargs -0 rm -f && git checkout-index -a -f
  ```
