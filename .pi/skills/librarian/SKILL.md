---
name: librarian
description: "Cache and refresh remote git repositories under the pi agent dir so later references reuse a local checkout. Use when the user points you to a remote git repository as reference, or you encounter one through other means."
license: Apache-2.0
---

<!-- VENDORED, NOT OURS.
     librarian/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/librarian/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     LOCAL ADAPTATIONS (also marked in place):
       A. the cache root: upstream caches under ~/.cache/checkouts, which is
          container-local in this devcontainer and lost on rebuild; the default
          is now <pi agent dir>/cache/checkouts, which lives on the persistent
          pi-agent-config volume. LIBRARIAN_CACHE_ROOT still overrides it.
       B. the command path: checkout.sh is invoked as ./checkout.sh, which pi
          resolves against this skill's directory, instead of a bare name that
          only works from inside that directory. -->

Use this skill when the user points you to a remote git repository (GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand).

The goal is to keep a reusable local checkout that is:
- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`<agent dir>/cache/checkouts/<host>/<org>/<repo>`

where `<agent dir>` is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`. Example:

`github.com/mitsuhiko/minijinja` → `~/.pi/agent/cache/checkouts/github.com/mitsuhiko/minijinja`

<!-- LOCAL ADAPTATION A: upstream stored these under ~/.cache/checkouts. On
     this devcontainer ~/.cache is container-local — discarded on every rebuild
     — while /home/vscode/.pi is the persistent pi-agent-config volume, so the
     default moved under the agent dir and now survives rebuilds. -->

The cache is read-only reference material: keep it out of the workspace, do
not commit it, and do not edit a cached checkout in place (see below).

## Command

```bash
bash ./checkout.sh <repo> --path-only
```

Examples:

```bash
bash ./checkout.sh mitsuhiko/minijinja --path-only
bash ./checkout.sh github.com/mitsuhiko/minijinja --path-only
bash ./checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

<!-- LOCAL ADAPTATION B: pi resolves a relative path in a skill against the
     skill's directory, so ./checkout.sh works from any cwd; upstream's bare
     `checkout.sh` only worked from inside that directory. -->

The script will:
1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash ./checkout.sh <repo> --force-update --path-only
```

## Recommended workflow

1. Resolve repository path via `checkout.sh --path-only`.
2. Use that path for searching, reading, and analysis.
3. On later references to the same repo, call `checkout.sh` again; it will find and update the cached checkout.

## If edits are needed

Prefer not to edit directly in the shared cache. Create a separate worktree or copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
- The clone is partial (`--filter=blob:none`), so a server without partial-clone
  support makes the clone fail rather than fall back to a full clone.
  `LIBRARIAN_CACHE_ROOT` and `LIBRARIAN_DEFAULT_HOST` override the cache root
  and the shorthand host.
