FROM mcr.microsoft.com/devcontainers/base:bookworm

# gh's configuration lives on this container's private pi volume (see
# docker-compose.yml), not in this image and not in the container-local home —
# /home/vscode is discarded on rebuild, /home/vscode/.pi is a named volume. The
# token itself arrives as GH_TOKEN from the host environment; GH_CONFIG_DIR only
# holds gh's non-secret config. Set here rather than mid-file so every later
# layer and postCreate sees it.
ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

# Node is needed because the extension tests execute TypeScript directly;
# Node 24+ strips types natively, so there is no build step.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

# tmux is not optional: the subagent extension creates one tmux session per
# delegated run and reports pane state back to the parent.
#
# unzip unpacks downloaded tool archives; the Android SDK it was originally
# added for is not installed here any more (it was only needed by one project
# and Google publishes no arm64 Linux build tools).
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y tmux git curl jq unzip \
    && rm -rf /var/lib/apt/lists/*

# Give non-interactive shells a no-op git editor. Nothing here sets core.editor,
# so git falls back to vi, and vi blocks forever when stdin is not a terminal:
# `git rebase --continue`, `git commit --amend` without -m and `git rebase -i`
# then hang an agent's command instead of failing, leaving the work staged with
# no error to read - a rebase that looks "stuck" when it is only waiting on an
# editor nobody can see. `true` accepts the existing message unchanged, and a
# bare `git commit` with no message aborts instead of hanging. BASH_ENV is read
# by non-interactive bash only, so an interactive shell keeps its real editor.
RUN printf 'export GIT_EDITOR=true\n' > /etc/agent-bash-env
ENV BASH_ENV=/etc/agent-bash-env

# gh (GitHub CLI) is how branches reach the remote: `gh pr create` / `gh pr merge`
# drive the PR workflow, and `gh auth setup-git` makes plain `git push` work
# afterwards by installing gh as git's credential helper. Installed from GitHub's
# apt repo so it survives this layer rather than being apted in by hand at runtime,
# which a rebuild would silently drop.
#
# The token itself is NOT baked in: it arrives as GH_TOKEN from the host
# environment (devcontainer.json), and gh's non-secret config lives on this
# container's private volume. `curl | dd` would mask curl's exit status and leave
# a 0-byte keyring, which apt reports as NO_PUBKEY rather than "could not fetch
# the key". -o plus `test -s` keeps the diagnostic honest.
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && test -s /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/* \
    && gh --version \
    && test "${GH_CONFIG_DIR#/home/vscode/.pi}" = "/gh"

# Install the pi release the `btw` mirror targets ("the mirrored pi internals
# have not drifted" in `.pi/extensions/subagent/test/btw-request.test.ts`),
# pinned instead of tracking `@latest`: a new pi release changes the internals
# the mirror is cut against, and the drift gate goes red until the mirror is
# refreshed. Pinning a single version is safe now because 1.6.1 pins its
# sibling packages (pi-ai, pi-tui, pi-codemode, ...) exactly, so npm's own
# resolution cannot produce the mixed family of issue #52. Move this pin and
# refresh the mirror in the same change. Same command as
# `.github/workflows/checks.yml`, so CI and the container track one release.
RUN npm cache clean --force \
    && npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@1.6.1 \
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

# gh's credential helper, system-wide, so `git push` works in a FRESH container.
# `gh auth setup-git` writes to ~/.gitconfig, which is on the container-local
# overlay and is discarded on rebuild — GH_TOKEN survives in the host env but the
# thing that lets git USE it does not, so push breaks after every rebuild.
# The empty-value line first, exactly as gh writes it, to shadow the helper
# vscode-server installs system-wide.
RUN git config --system credential.https://github.com.helper '' \
    && git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
    && git config --system credential.https://gist.github.com.helper '' \
    && git config --system credential.https://gist.github.com.helper '!/usr/bin/gh auth git-credential' \
    && git config --system alias.st status \
    && git config --system alias.co checkout \
    && git config --system alias.br branch \
    && git config --system alias.last 'log -1 HEAD --stat' \
    && git config --system alias.lg 'log --oneline --decorate --graph -20'

RUN chown vscode:vscode /home/vscode/.aliases.zsh /home/vscode/.zshrc