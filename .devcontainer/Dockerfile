FROM mcr.microsoft.com/devcontainers/base:bookworm

# Node is needed because the extension tests execute TypeScript directly;
# Node 24+ strips types natively, so there is no build step.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

# tmux is not optional: the subagent extension creates one tmux session per
# delegated run and reports pane state back to the parent.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y tmux git curl jq \
    && rm -rf /var/lib/apt/lists/*

# gh (GitHub CLI) is how branches reach the remote: `gh pr create` / `gh pr merge`
# drive the PR workflow, and `gh auth setup-git` makes plain `git push` work
# afterwards by installing gh as git's credential helper. Installed from GitHub's
# apt repo so it survives this layer rather than being apted in by hand at runtime,
# which a rebuild would silently drop.
#
# The token itself is NOT baked in. `GH_CONFIG_DIR` points at the pi-config volume
# (see docker-compose.yml), so `gh auth login` survives a rebuild: /home/vscode is
# container-local and is discarded, while /home/vscode/.pi is a named volume.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version

ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

ARG PI_AGENT_VERSION=1.0.0
RUN npm cache clean --force \
    && npm install -g --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_AGENT_VERSION}" \
    && pi --version

# Powerlevel10k (standalone; no Oh My Zsh required)
RUN git clone --depth=1 https://github.com/romkatv/powerlevel10k.git /home/vscode/powerlevel10k \
    && chown -R vscode:vscode /home/vscode/powerlevel10k

RUN mkdir -p /home/vscode/.pi/agent

WORKDIR /workspace

COPY .devcontainer/shell/aliases.zsh /home/vscode/.aliases.zsh

RUN cat <<'EOF' >> /home/vscode/.zshrc
source /home/vscode/.aliases.zsh
EOF

RUN git config --system alias.st status \
    && git config --system alias.co checkout \
    && git config --system alias.br branch \
    && git config --system alias.last 'log -1 HEAD --stat' \
    && git config --system alias.lg 'log --oneline --decorate --graph -20'

RUN chown vscode:vscode /home/vscode/.aliases.zsh /home/vscode/.zshrc