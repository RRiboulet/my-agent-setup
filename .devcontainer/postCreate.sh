#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
# The shared, machine-wide pi agent dir, on the pi-agent-config volume. Other
# projects that mount this volume use it directly; this container does not — see
# PI_CODING_AGENT_DIR in devcontainer.json for why (the personal install of this
# very package would load every extension twice).
AGENT_DIR=/home/vscode/.pi/agent
PROJECT_AGENT_DIR="${PI_CODING_AGENT_DIR:-$AGENT_DIR}"

# The Dockerfile sets GH_CONFIG_DIR as an image ENV, but a container built from an
# older image does not have it. Default it here to the same path so a bare
# `mkdir -p "$GH_CONFIG_DIR"` below cannot expand to `mkdir -p ""`, which fails
# under `set -e` and aborts the whole of postCreate before anything else runs.
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/home/vscode/.pi/gh}"

# --- zsh + Powerlevel10k ---
# The common-utils feature creates ~/.zshrc before postCreate runs.
touch ~/.zshrc
grep -qxF 'source /home/vscode/.aliases.zsh' ~/.zshrc || echo 'source /home/vscode/.aliases.zsh' >> ~/.zshrc
grep -qxF 'source /home/vscode/powerlevel10k/powerlevel10k.zsh-theme' ~/.zshrc || echo 'source /home/vscode/powerlevel10k/powerlevel10k.zsh-theme' >> ~/.zshrc
grep -qxF '[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh' ~/.zshrc || echo '[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh' >> ~/.zshrc

cp "$REPO/.devcontainer/shell/p10k.zsh" /home/vscode/.p10k.zsh

# tmux config: used by pi's tmux-backed subagents.
cp "$REPO/.devcontainer/shell/tmux.conf" /home/vscode/.tmux.conf

# --- pi configuration ---
# Seed the per-project agent dir from the shared one, once. Only files that are
# missing are written, so a rebuild never overwrites a setting made in here; and
# settings.json is seeded *without* .packages, which is the whole point of the
# split (the shared dir's package list names this repo, and /workspace already
# provides its extensions and skills directly).
if [ "$PROJECT_AGENT_DIR" != "$AGENT_DIR" ]; then
  mkdir -p "$PROJECT_AGENT_DIR"
  if [ ! -f "$PROJECT_AGENT_DIR/settings.json" ] && [ -f "$AGENT_DIR/settings.json" ] \
    && command -v jq >/dev/null 2>&1; then
    if jq 'del(.packages, .extensionChangelogVersions)' "$AGENT_DIR/settings.json" \
      > "$PROJECT_AGENT_DIR/settings.json.tmp"; then
      mv "$PROJECT_AGENT_DIR/settings.json.tmp" "$PROJECT_AGENT_DIR/settings.json"
    else
      rm -f "$PROJECT_AGENT_DIR/settings.json.tmp"
      echo '{"theme": "kokomi-theme"}' > "$PROJECT_AGENT_DIR/settings.json"
    fi
  fi
  # Credentials and per-user extension config. Copied, never overwritten: from
  # here on this container owns them (re-run `pi auth login` / edit the file in
  # here), while the shared copies keep serving the other projects. voice.json
  # and review-triage.json are the two polished per-machine configs the
  # extensions read out of the agent dir.
  for name in auth.json voice.json review-triage.json; do
    if [ ! -f "$PROJECT_AGENT_DIR/$name" ] && [ -f "$AGENT_DIR/$name" ]; then
      cp "$AGENT_DIR/$name" "$PROJECT_AGENT_DIR/$name"
    fi
  done
  # Project trust is what makes pi read /workspace/.pi/{settings.json,
  # extensions,skills} at all. Without an entry here the container starts
  # untrusted, and since the package is gone that means **no** extensions or
  # skills: a silent empty agent rather than a broken one.
  if [ ! -f "$PROJECT_AGENT_DIR/trust.json" ]; then
    printf '{\n  "%s": true\n}\n' "$REPO" > "$PROJECT_AGENT_DIR/trust.json"
  fi
fi

mkdir -p "$PROJECT_AGENT_DIR/themes"
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" "$PROJECT_AGENT_DIR/themes/kokomi-theme.json"

# Select the theme WITHOUT clobbering the rest of the user's settings: the
# previous version wrote settings.json wholesale, which silently discarded
# anything else configured on the machine.
SETTINGS="$PROJECT_AGENT_DIR/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  jq --arg t kokomi-theme '.theme = $t' "$SETTINGS" > "$SETTINGS.tmp" \
    && mv "$SETTINGS.tmp" "$SETTINGS" \
    || echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
else
  echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
fi

# Note: extensions and skills live in "$REPO/.pi/" itself (that directory is
# gitignored). Do not link them from "$REPO/extensions" and "$REPO/skills" —
# those paths no longer exist, and "ln -sfn" would drop a dangling symlink
# *inside* the real directories.

# --- git identity ---
# Commit metadata is public the moment a branch is pushed: the author and
# committer addresses and every `Co-authored-by:` trailer live in the commit
# object, so a personal address there can only be removed by rewriting every
# branch and tag — and even then it survives in forks and in GitHub's cached
# commit views. Pin the identity to the GitHub noreply address before any commit
# can be made.
#
# Applied here rather than in the Dockerfile because a personal identity does not
# belong in an image others may build; postCreate re-runs on every container
# creation, so ~/.gitconfig being container-local and discarded with /home/vscode
# does not matter. `--global`, matching the scope `git commit` reads and the one
# a bare `git config user.email` writes.
#
# A manual `git config --global user.email` in this container was a personal
# address, which is how it reached the pushed history; this overwrites it on the
# next rebuild (or immediately: run the two lines by hand).
git config --global user.name "RRiboulet"
git config --global user.email "122018936+RRiboulet@users.noreply.github.com"

# --- clipboard ---
# The host injects WAYLAND_DISPLAY and DISPLAY into the container, but neither
# socket exists here. pi's clipboard helper then finds no wl-copy/xclip and
# reports the clipboard as unavailable. Install the OSC 52 shim under all three
# names so whichever it tries works, and the outer terminal owns the clipboard.
sudo install -m 0755 "$REPO/.devcontainer/shell/osc52-clipboard" /usr/local/bin/osc52-clipboard
for helper in wl-copy xclip xsel; do
  sudo ln -sf /usr/local/bin/osc52-clipboard "/usr/local/bin/$helper"
done

# --- gh (GitHub CLI) ---
# The token is not in the image and never in git. It lives in the pi-config volume
# via GH_CONFIG_DIR (set in the Dockerfile), which is what makes one `gh auth login`
# last across rebuilds. Creating the directory here is all this needs to do; an
# unauthenticated gh is still useful (it reads public repos fine).
# sudo, and after the chown below: on a first-run volume the mount point inherits
# the image's root ownership, so a plain `mkdir -p` as vscode fails and `set -e`
# aborts postCreate before the chown that would have fixed it.

sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"
mkdir -p "$GH_CONFIG_DIR"

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

It prints a one-time code and a URL: open the URL, paste the code, approve. The
token lands in the pi-config volume, so it survives a rebuild. Then run

Nothing else is needed: git's credential helper is configured system-wide in
the Dockerfile, so plain `git push` works in a fresh container without this.
MSG
fi

echo "pi coding-agent ready. Sessions persist in the pi-agent-config volume."