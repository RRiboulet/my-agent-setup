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

# --- ownership of the pi-config volume, BEFORE anything writes into it ---
# On a first-run volume Docker copies the image's content at /home/vscode/.pi into
# the new volume, ownership included, and the Dockerfile creates
# /home/vscode/.pi/agent as root. So the whole volume can arrive root-owned, and
# every write below as vscode then fails EACCES under `set -e` — aborting
# postCreate *before* the chown that would have fixed it. Measured, not reasoned:
# with a fresh volume and an image whose `vscode` is uid 1000 (i.e. no devcontainer
# CLI uid remap), the first version of this block died at
# `mkdir: cannot create directory '/home/vscode/.pi/agent-my-agent-setup':
# Permission denied` — the same window one line earlier, at `…/.pi/agent/themes`,
# existed before this branch. The reordering closes both.
#
# The devcontainer CLI normally rebuilds the image with `vscode` remapped to the
# host uid, which also fixes the ownership of /home/vscode — but that is a property
# of the host, not of this repo, so do not rely on it.
#
# `$REPO` is chowned here for the same reason: a bind mount from a host whose uid
# differs from the container user is not writable by vscode, and the .pi/ writes
# that follow (and every `git` / test run afterwards) need it to be.
sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"

# --- pi configuration ---
# Seed the per-project agent dir from the shared one, once. Only files that are
# missing are written, so a rebuild never overwrites a setting made in here; and
# settings.json is seeded *without* .packages, which is the whole point of the
# split (the shared dir's package list names this repo, and /workspace already
# provides its extensions and skills directly). The theme is the one exception:
# it is re-pinned to kokomi-theme on every run, as it always was.
if [ "$PROJECT_AGENT_DIR" != "$AGENT_DIR" ]; then
  mkdir -p "$PROJECT_AGENT_DIR"
  if [ ! -f "$PROJECT_AGENT_DIR/settings.json" ] && [ -f "$AGENT_DIR/settings.json" ] \
    && command -v jq >/dev/null 2>&1; then
    # `jq -e .` first: a truncated or empty shared settings.json parses to
    # *nothing*, and installing that would leave the container with no provider,
    # model or tool defaults instead of failing visibly. The fallback says so.
    if jq -e . "$AGENT_DIR/settings.json" >/dev/null 2>&1 \
      && jq 'del(.packages, .extensionChangelogVersions)' "$AGENT_DIR/settings.json" \
        > "$PROJECT_AGENT_DIR/settings.json.tmp" \
      && [ -s "$PROJECT_AGENT_DIR/settings.json.tmp" ]; then
      mv "$PROJECT_AGENT_DIR/settings.json.tmp" "$PROJECT_AGENT_DIR/settings.json"
    else
      rm -f "$PROJECT_AGENT_DIR/settings.json.tmp"
      echo "postCreate: could not seed $PROJECT_AGENT_DIR/settings.json from $AGENT_DIR (missing, unreadable or invalid JSON); starting it minimal, so default provider/model/tool settings are NOT inherited" >&2
      echo '{"theme": "kokomi-theme"}' > "$PROJECT_AGENT_DIR/settings.json"
    fi
  fi
  # Credentials and per-user extension config. Copied, never overwritten: from
  # here on this container owns them (re-run `pi auth login` / edit the file in
  # here), while the shared copies keep serving the other projects. voice.json
  # and review-triage.json are the two polished per-machine configs the
  # extensions read out of the agent dir; models.json is the hand-maintained
  # model catalogue override (`getModelsPath()`).
  for name in auth.json voice.json review-triage.json models.json; do
    if [ ! -f "$PROJECT_AGENT_DIR/$name" ] && [ -f "$AGENT_DIR/$name" ]; then
      cp "$AGENT_DIR/$name" "$PROJECT_AGENT_DIR/$name"
    fi
  done
  # Project trust is what makes pi read /workspace/.pi/{settings.json,
  # extensions,skills} at all. Without an entry here the container starts
  # untrusted, and since the package is gone that means **no** extensions or
  # skills: a silent empty agent rather than a broken one.
  #
  # Written through a temp file and renamed, like the settings above: this guard
  # is `-f`, so an interrupted write (or a crash between create and write) would
  # leave a 0-byte trust.json that the guard then refuses to repair forever — and
  # pi's own reader throws on it at every startup, which bricks the container in
  # a way that names the file but not the cause.
  if [ ! -f "$PROJECT_AGENT_DIR/trust.json" ]; then
    printf '{\n  "%s": true\n}\n' "$REPO" > "$PROJECT_AGENT_DIR/trust.json.tmp" \
      && mv "$PROJECT_AGENT_DIR/trust.json.tmp" "$PROJECT_AGENT_DIR/trust.json"
  fi
fi

mkdir -p "$PROJECT_AGENT_DIR/themes"
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" "$PROJECT_AGENT_DIR/themes/kokomi-theme.json"

# Select the theme WITHOUT clobbering the rest of the user's settings: the
# previous version wrote settings.json wholesale, which silently discarded
# anything else configured on the machine. Same temp-file-then-rename as the
# seed above, for the same reason: an empty file must never land here.
SETTINGS="$PROJECT_AGENT_DIR/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1 \
  && jq --arg t kokomi-theme '.theme = $t' "$SETTINGS" > "$SETTINGS.tmp" \
  && [ -s "$SETTINGS.tmp" ]; then
  mv "$SETTINGS.tmp" "$SETTINGS"
else
  rm -f "$SETTINGS.tmp"
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
# unauthenticated gh is still useful (it reads public repos fine). The volume is
# already chowned above — before the first write into it, not after.
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