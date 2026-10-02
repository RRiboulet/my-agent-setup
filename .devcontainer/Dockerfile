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