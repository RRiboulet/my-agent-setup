#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
AGENT_DIR=/home/vscode/.pi/agent

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
mkdir -p "$AGENT_DIR/themes"
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" "$AGENT_DIR/themes/kokomi-theme.json"

# Select the theme WITHOUT clobbering the rest of the user's settings: the
# previous version wrote settings.json wholesale, which silently discarded
# anything else configured on the machine.
SETTINGS="$AGENT_DIR/settings.json"
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