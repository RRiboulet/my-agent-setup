# Project Review Guidelines

These guidelines supplement the default review rubric. When in conflict,
project guidelines take precedence.

## One review per change

- **`prove-it-works` is not a review.** It is how the author proves a change and
  reports evidence. It never starts a reviewer.
- A change gets **one independent review, and only when the user asks for one**.
  Two forms exist; use exactly one of them:
  - `/review` when the user wants to drive it interactively;
  - `triage_change` (or `/triage`) and, after the user approves, **one**
    sub-agent with the profile it names.
- Never run both for the same change, and never start a second reviewer because
  the first found little. The reviewer must not spawn further reviewers.
- Do not repeat what the author already proved. Re-run a check only when you
  doubt it.

## What a review covers

Pin the change first. In this repository the base is `dev`, never `main`: a
branch or PR review is `git diff dev...HEAD`, and uncommitted work is
`git diff HEAD` plus untracked files. Confirm the ref resolves and the diff is
not empty.

Cover three axes and keep their findings apart — one kind must not mask another:

- **Spec.** Does the change do what was asked, and only that? Quote the
  requirement for anything missing, half-done, or implemented wrongly; call out
  behavior nobody asked for as scope creep. If no spec exists, judge against the
  request as stated and say so.
- **Correctness.** Try to break it: wrong results, unhandled edge cases (empty,
  null, boundary, duplicate, concurrent, retried), regressions, broken
  compatibility (public interfaces, persisted data, wire formats, config), error
  paths, and missing or weak tests. **Every finding needs proof** — a failing
  test, a repro script, or command output. When a run is impractical, give the
  concrete failing path with `file:line`. Anything weaker is labelled
  "unverified" and kept separate.
- **Standards.** Documented conventions only: this file, `AGENTS.md`, and any
  `CONTRIBUTING.md`, ADR, or lint config. Skip what tooling already enforces.
  The smell baseline below is judgement calls, and a documented rule overrides
  them.

Report findings; fix them only when the user asked (or `/review`'s loop-fixing
mode is on). Report in whatever format the review mechanism requires — `/review`
has its own priority tags, verdict, and human-reviewer callouts — but keep the
three axes distinguishable inside it.

## Standards baseline

Smells from Martin Fowler, *Refactoring*, chapter 3. Label them as possible
issues, never violations; if a documented repo rule endorses one, suppress it.

- **Mysterious Name** — the name hides what it does; rename, or the design is murky.
- **Duplicated Code** — same logic shape in several places; extract the shared shape.
- **Feature Envy** — a function reaches into another object's data; move it next to the data.
- **Data Clumps** — the same few fields travel together; bundle them into one type.
- **Primitive Obsession** — a primitive stands in for a domain concept; give it a type.
- **Repeated Switches** — the same switch on the same type in several places; one shared map or polymorphism.
- **Shotgun Surgery** — one logical change forces scattered edits; gather what changes together.
- **Divergent Change** — one module edited for unrelated reasons; split it.
- **Speculative Generality** — abstractions for needs the spec does not have; delete them.
- **Message Chains** — long navigation a caller should not depend on; hide the walk.
- **Middle Man** — a class that mostly delegates; cut it and call the real target.
- **Refused Bequest** — a subclass ignoring most of what it inherits; use composition.

Also flag subtraction the change could have made (dead code, stale flags,
redundant validation, a bigger diff than the problem needs), comments that
narrate the next line or the change history instead of explaining why, and prose
that is vague or hyped without evidence.

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
