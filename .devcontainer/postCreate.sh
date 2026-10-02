#!/usr/bin/env bash
set -euo pipefail

REPO=/workspace
AGENT_DIR=/home/vscode/.pi/agent

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

# Link this repo's extensions and skills into the project's .pi directory, so
# pi discovers them from the workspace without installing anything.
mkdir -p "$REPO/.pi"
ln -sfn "$REPO/extensions" "$REPO/.pi/extensions"
ln -sfn "$REPO/skills" "$REPO/.pi/skills"

sudo chown -R vscode:vscode /home/vscode/.pi "$REPO"

echo "pi coding-agent ready. Sessions persist in the pi-agent-config volume."