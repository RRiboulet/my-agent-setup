---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries. Read this skill before running gh in this repo."
---

<!-- VENDORED, NOT OURS.
     github/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/github/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     Four LOCAL ADAPTATIONS below, each marked in place:
       A. the auth setup (this repo's token lives in GH_CONFIG_DIR, not
          ~/.gitconfig, and the git credential helper is system-wide)
       B. the PR workflow (AGENTS.md prescribes --fill, --squash --delete-branch,
          and dev→main release merges that must not delete dev)
       C. the token rule (never in .git/config, the Dockerfile, or a repo file)
       D. the --repo note (pointless inside this repo, and gh is the credential
          helper here rather than a URL-rewriting proxy) -->

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

<!-- LOCAL ADAPTATION D: inside this repository you are always in a git
     directory, so `--repo` is dead weight on every command below. It matters
     only when the working directory is not a checkout. Also note the login is
     not a URL-rewriting proxy: the devcontainer registers gh as git's
     credential helper system-wide (see AGENTS.md "The workflow"), so plain
     `git push` reaches GitHub with no credential in `.git/config`. -->

## Authentication

<!-- LOCAL ADAPTATION A: upstream assumes gh is already logged in. In this
     repo that one-time step needs a browser and its result only survives
     rebuilds because the token lives in the right place. Verify before
     trusting it:

     - The devcontainer bakes gh in (`gh` is in the Dockerfile, not installed
       at runtime), so a rebuild does not drop the binary.
     - The token lives in the `pi-agent-config` volume via
       `GH_CONFIG_DIR=/home/vscode/.pi/gh`. That is what makes one login last
       across rebuilds — `/home/vscode` itself is container-local and is
       discarded.
     - One-time setup, run by the human (it needs a browser):
         gh auth login --hostname github.com --git-protocol https --web
     - Check *where* the token lives before trusting a login, because that
       path decides whether it survives a rebuild:
         gh auth status
       A login that writes to the container-local overlay (e.g. via
       `gh auth setup-git`, which edits `~/.gitconfig`) looks fine and then
       vanishes. -->

## Pull Requests

<!-- LOCAL ADAPTATION B: the workflow is AGENTS.md's, not discretionary.
     Inside this repo: `git push -u origin <branch>`, then

         gh pr create --fill      # --fill uses the commits for title and body

     Always say in the body what a reviewer should check and what you
     verified. Then, for a feature branch into dev:

         gh pr merge <n> --squash --delete-branch

     `--delete-branch` is not optional politeness: a squash merge does not put
     the branch tip in `dev`'s history, so a later `git branch -d` fails with
     "not fully merged" and needs `-D`. Letting gh delete both the local and
     the remote branch avoids both. After the merge, pull the target branch
     (`git checkout dev && git pull --ff-only`).

     A dev→main release merge is the one exception that is NOT a squash: use
     `gh pr merge <n> --merge --delete-branch`, and make sure it does not
     delete `dev` (re-create it locally if needed: `git branch dev origin/dev`).
     The squash-merge consequence for changelogs: a feature branch's commits
     no longer exist in `dev`, so release notes are written from PR titles and
     bodies, not from `git log`. -->

Check CI status on a PR:
```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:
```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:
```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:
```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:
```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

<!-- LOCAL ADAPTATION C: never put a token in `.git/config`, in the
     Dockerfile, or in a file in the repo. If authentication is needed
     mid-session, stop and ask rather than improvising — the repo has no CI
     to catch a committed secret. The repo's public docs make the same point
     (AGENTS.md "The workflow"; REVIEW_GUIDELINES.md). -->

## JSON Output

Most commands support `--json` for structured output.  You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```