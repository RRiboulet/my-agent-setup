#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
# This container's own agent dir, on its private pi volume. It is not the shared
# `agent` dir any more: no other container mounts this volume. The name is the
# *project's*, matching the shape `bin/pi-agent-dir` gives a host checkout named
# after the repo — this checkout is not, since the repo is mounted at /workspace,
# so the script would compute `agent-workspace` there (see its header on naming).
# Nothing depends on the two agreeing: this dir is the container's own, and no
# host ever resolves it (README, "One copy of the extensions, never two").
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

# --- ownership of the private pi volume, BEFORE anything writes into it ---
# On a first-run volume Docker copies the image's content at /home/vscode/.pi into
# the new volume, ownership included, and the Dockerfile creates
# /home/vscode/.pi/agent as root. So the whole volume can arrive root-owned, and
# every write below as vscode then fails EACCES under `set -e` — aborting
# postCreate *before* the chown that would have fixed it. Measured, not reasoned:
# with a fresh volume and an image whose `vscode` is uid 1000 (i.e. no devcontainer
# CLI uid remap), the first version of this block died creating the per-container
# dir: `mkdir: cannot create directory '…': Permission denied`. The same window
# one line earlier, at `…/.pi/agent/themes`, existed before this branch; the
# reordering closes both.
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
# The volume is private, so there is no shared agent dir to seed from any more.
# A committed template carries the provider/model/tool defaults this container
# starts with; it is written only when settings.json is missing, so a rebuild
# never overwrites a setting made in here. The template deliberately has no
# `.packages`: this repo's checkout's `.pi/` is the single source of extensions
# and skills (README, "One copy of the extensions, never two").
mkdir -p "$PROJECT_AGENT_DIR"
if [ ! -f "$PROJECT_AGENT_DIR/settings.json" ]; then
  if command -v jq >/dev/null 2>&1 \
    && jq -e . "$REPO/.devcontainer/pi/settings.json" >/dev/null 2>&1 \
    && jq . "$REPO/.devcontainer/pi/settings.json" > "$PROJECT_AGENT_DIR/settings.json.tmp" \
    && [ -s "$PROJECT_AGENT_DIR/settings.json.tmp" ]; then
    mv "$PROJECT_AGENT_DIR/settings.json.tmp" "$PROJECT_AGENT_DIR/settings.json"
  else
    rm -f "$PROJECT_AGENT_DIR/settings.json.tmp"
    # A malformed or unreadable template must fail visibly: a 0-byte settings.json
    # would leave pi with no provider or model and look like a broken install.
    echo "postCreate: could not install $REPO/.devcontainer/pi/settings.json into $PROJECT_AGENT_DIR" >&2
    exit 1
  fi
fi

# Enforce the package-free invariant even on a volume migrated from the old
# shared layout: this container loads the checkout's `.pi/` only, never a package
# clone. Filter only this repo's entries so an unrelated package a user added is
# left alone.
if command -v jq >/dev/null 2>&1; then
  jq '
    if .packages then
      .packages = [.packages[]
        | select(((if type == "object" then (.source // "") else . end)
            | tostring | test("my-agent-setup") | not))]
      | if (.packages | length) == 0 then del(.packages) else . end
    else . end
  ' "$PROJECT_AGENT_DIR/settings.json" > "$PROJECT_AGENT_DIR/settings.json.tmp" \
    && [ -s "$PROJECT_AGENT_DIR/settings.json.tmp" ] \
    && mv "$PROJECT_AGENT_DIR/settings.json.tmp" "$PROJECT_AGENT_DIR/settings.json" \
    || { rm -f "$PROJECT_AGENT_DIR/settings.json.tmp"; echo "postCreate: could not enforce the package-free settings in $PROJECT_AGENT_DIR" >&2; exit 1; }
fi

# Project trust is what makes pi read /workspace/.pi/{settings.json, extensions,
# skills} at all. Without an entry here the container starts untrusted, and since
# no package is installed that means **no** extensions or skills: a silent empty
# agent rather than a broken one.
#
# Merge rather than create-if-missing, so an older volume that trusts a different
# path still gains /workspace. Written through a temp file and renamed: pi's own
# reader throws on a 0-byte trust.json at every startup, which bricks the
# container in a way that names the file but not the cause.
TRUST="$PROJECT_AGENT_DIR/trust.json"
if [ -f "$TRUST" ] && ! jq -e . "$TRUST" >/dev/null 2>&1; then
  echo "postCreate: $TRUST was not valid JSON; rewriting it" >&2
  rm -f "$TRUST"
fi
if [ -f "$TRUST" ]; then
  jq --arg repo "$REPO" '. + {($repo): true}' "$TRUST" > "$TRUST.tmp" \
    && mv "$TRUST.tmp" "$TRUST"
else
  jq -n --arg repo "$REPO" '{($repo): true}' > "$TRUST.tmp" \
    && mv "$TRUST.tmp" "$TRUST"
fi

mkdir -p "$PROJECT_AGENT_DIR/themes"
cp "$REPO/.devcontainer/pi/themes/kokomi-theme.json" "$PROJECT_AGENT_DIR/themes/kokomi-theme.json"

# Select the theme WITHOUT clobbering the rest of the user's settings: the
# previous version wrote settings.json wholesale, which silently discarded
# anything else configured on the machine. Same temp-file-then-rename as the
# template above, for the same reason: an empty file must never land here.
SETTINGS="$PROJECT_AGENT_DIR/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1 \
  && jq --arg t kokomi-theme '.theme = $t' "$SETTINGS" > "$SETTINGS.tmp" \
  && [ -s "$SETTINGS.tmp" ]; then
  mv "$SETTINGS.tmp" "$SETTINGS"
else
  rm -f "$SETTINGS.tmp"
  echo '{"theme": "kokomi-theme"}' > "$SETTINGS"
fi

# --- review-triage policy ---
# The policy lives on the private volume, not in the image or the clone, so a
# fresh volume — which is what another host gets — would otherwise start from
# the extension's built-in defaults. Seed the checkout's policy when the volume
# has none, and never overwrite it: from then on the file belongs to whoever
# runs the container, and a rebuild must not undo their edit. Validated with jq
# first and installed through a temp file, like settings above, so a malformed
# template fails here instead of leaving pi with a policy it cannot parse.
REVIEW_TRIAGE="$PROJECT_AGENT_DIR/review-triage.json"
if [ ! -f "$REVIEW_TRIAGE" ]; then
  if command -v jq >/dev/null 2>&1 \
    && jq -e . "$REPO/.devcontainer/pi/review-triage.json" >/dev/null 2>&1 \
    && jq . "$REPO/.devcontainer/pi/review-triage.json" > "$REVIEW_TRIAGE.tmp" \
    && [ -s "$REVIEW_TRIAGE.tmp" ]; then
    mv "$REVIEW_TRIAGE.tmp" "$REVIEW_TRIAGE"
  else
    rm -f "$REVIEW_TRIAGE.tmp"
    echo "postCreate: could not install $REPO/.devcontainer/pi/review-triage.json into $PROJECT_AGENT_DIR" >&2
    exit 1
  fi
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
# The token is not in the image and never in git. It arrives as GH_TOKEN from the
# host environment (devcontainer.json), so every container gets the same credential
# without sharing a volume. GH_CONFIG_DIR (set in the Dockerfile) only holds gh's
# non-secret config on this container's private volume. Creating the directory here
# is all this needs to do; an unauthenticated gh is still useful (it reads public
# repos fine). The volume is already chowned above — before the first write into
# it, not after.
mkdir -p "$GH_CONFIG_DIR"

if ! gh auth status >/dev/null 2>&1; then
  cat <<'MSG'

gh is installed but not authenticated. One-time setup, in this terminal:

  gh auth login --hostname github.com --git-protocol https --web

It prints a one-time code and a URL: open the URL, paste the code, approve. The
token is stored by gh in GH_CONFIG_DIR on this container's private volume, so it
survives a rebuild, but the supported path here is GH_TOKEN from the host
environment (`~/.config/devc/env`, sourced by devc). Then run

Nothing else is needed: git's credential helper is configured system-wide in
the Dockerfile, so plain `git push` works in a fresh container without this.
MSG
fi

# --- pi model catalogs ---
# The judge the policy names can be newer than the model list pi ships with, so a
# fresh volume does not have it and the judge fails with "not in pi's catalogue"
# until one refresh has run. A container with no network or no provider key
# cannot refresh and must still come up usable: hence a warning, not an exit. The
# keys arrive from the host environment, so this only has something to talk to
# when the host supplied them.
MODELS_STORE="$PROJECT_AGENT_DIR/models-store.json"
# A refresh that cannot reach a provider still exits 0 and writes an empty
# catalog, so the exit status alone does not prove the judge is reachable.
# Confirm that the model the policy names is actually in the catalog and say so
# when it is not: the only other symptom is triage quietly falling back to its
# most expensive profile.
JUDGE_PROVIDER="$(jq -r '.judge.provider // empty' "$REVIEW_TRIAGE" 2>/dev/null || true)"
JUDGE_ID="$(jq -r '.judge.model // empty' "$REVIEW_TRIAGE" 2>/dev/null || true)"
if ! pi update --models >/dev/null; then
  echo "postCreate: 'pi update --models' failed; review-triage may not find its judge in the catalog (run it again once this container has network and a provider key)" >&2
elif [ -n "$JUDGE_PROVIDER" ] && [ -n "$JUDGE_ID" ] \
  && ! jq -e --arg p "$JUDGE_PROVIDER" --arg id "$JUDGE_ID" \
    '((.[$p].models) // []) | any(.id == $id)' "$MODELS_STORE" >/dev/null 2>&1; then
  echo "postCreate: the review-triage judge $JUDGE_PROVIDER/$JUDGE_ID is not in the model catalog; supply that provider's key and run 'pi update --models' in this container" >&2
fi

echo "pi coding-agent ready. Sessions persist in the private my-agent-setup-pi-config volume."
