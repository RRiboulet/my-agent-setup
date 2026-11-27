# GitHub Authentication and PR Mechanics

Branches reach GitHub through `gh`, which is baked into `.devcontainer/Dockerfile` rather than installed at runtime so rebuilds never drop it.

## Token and config layout

- `GH_TOKEN` arrives from the host environment alongside provider keys, sourced from `~/.config/devc/env` (with `allexport`) by `devc` before `devcontainer up` and forwarded by `.devcontainer/devcontainer.json` via `${localEnv:...}`.
- `GH_CONFIG_DIR=/home/vscode/.pi/gh` stores non-secret `gh` config on the container's private volume, allowing every container to share credentials without cross-container mounts.
- One-time host setup:

```bash
mkdir -p ~/.config/devc && chmod 700 ~/.config/devc
printf 'GH_TOKEN=%s\n' "$(gh auth token)" >> ~/.config/devc/env
chmod 600 ~/.config/devc/env
```

`gh auth login` inside a container writes only to that container's private volume, leaving the next container unauthenticated; prefer the host env file.

`git push` works with no credentials in `.git/config` because `.devcontainer/Dockerfile` registers `gh` as git's credential helper system-wide rather than via `gh auth setup-git` (which writes `~/.gitconfig` on the container-local overlay and is lost on rebuild).

To verify where authentication comes from without leaking secrets:

```bash
env | grep '^GH_TOKEN='   # presence check only; never print the value
gh auth status
```

## Squash merges and release notes

Feature branches use `gh pr create --base dev --fill` because the repository's default branch is `main` (which takes releases only). Check the generated title since `--fill` falls back to the branch name when it cannot read a single commit, and describe verification in the PR body.

Because feature PRs squash-merge into `dev`, individual branch commits no longer exist in `main`; release notes are compiled from PR titles and bodies rather than `git log`.
