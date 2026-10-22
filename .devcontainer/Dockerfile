FROM mcr.microsoft.com/devcontainers/base:bookworm

# gh's token lives in the pi-config volume (see docker-compose.yml), not in this
# image and not in the container-local home — /home/vscode is discarded on
# rebuild, /home/vscode/.pi is a named volume. Set here rather than mid-file so
# every later layer and postCreate sees it.
ENV GH_CONFIG_DIR=/home/vscode/.pi/gh
ENV GH_PROMPT_DISABLED=1

# Node is needed because the extension tests execute TypeScript directly;
# Node 24+ strips types natively, so there is no build step.
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

# tmux is not optional: the subagent extension creates one tmux session per
# delegated run and reports pane state back to the parent.
#
# The JDK and unzip are here for the Android build (the pi-termux-mobile app
# lives in its own repository, but it is built from this container):
# openjdk-17 is what AGP 8.7.3 needs, and unzip unpacks the Android SDK's
# cmdline-tools. The SDK itself is not in the image -- it is ~1.5 GB and only
# one project needs it -- `.devcontainer/android-sdk.sh` installs it onto the
# persistent volume instead. `javac -version`, not `java -version`: the JDK is
# there to compile, and a JRE-only image would pass a `java` check.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y tmux git curl jq unzip openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && javac -version

# gh (GitHub CLI) is how branches reach the remote: `gh pr create` / `gh pr merge`
# drive the PR workflow, and `gh auth setup-git` makes plain `git push` work
# afterwards by installing gh as git's credential helper. Installed from GitHub's
# apt repo so it survives this layer rather than being apted in by hand at runtime,
# which a rebuild would silently drop.
#
# The token itself is NOT baked in. `GH_CONFIG_DIR` points at the pi-config volume
# (see docker-compose.yml), so `gh auth login` survives a rebuild: /home/vscode is
# container-local and is discarded, while /home/vscode/.pi is a named volume.
# `curl | dd` would mask curl's exit status and leave a 0-byte keyring, which apt
# reports as NO_PUBKEY rather than "could not fetch the key". -o plus `test -s`
# keeps the diagnostic honest.
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

# Install the newest @earendil-works/pi-coding-agent on every rebuild. Pinning a
# single version while leaving the sibling ranges (pi-ai, pi-tui, pi-codemode,
# ...) unpinned is what produced the mixed family in issue #52; tracking
# `@latest` keeps pi-coding-agent and its siblings from npm's own resolution
# on the same release. See issue #52.
RUN npm cache clean --force \
    && npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent@latest \
    && pi --version

# Powerlevel10k (standalone; no Oh My Zsh required)
RUN git clone --depth=1 https://github.com/romkatv/powerlevel10k.git /home/vscode/powerlevel10k \
    && chown -R vscode:vscode /home/vscode/powerlevel10k

RUN mkdir -p /home/vscode/.pi/agent

WORKDIR /workspace

COPY .devcontainer/shell/aliases.zsh /home/vscode/.aliases.zsh

# ANDROID_HOME and PATH are image content, not something a restore script
# writes at container creation. Writing shell rc files from a postCreate step
# is what an earlier version of this change did, and it replaced the whole file
# with a temp-file path on every rebuild -- losing the aliases and p10k theme
# lines appended here and in postCreate.sh. Baked lines cannot be lost that
# way, and they reach VS Code's non-login terminals (the default profile is
# zsh), tmux panes and login shells alike. The SDK path is fixed and lives on
# the volume, so the exports are correct before the SDK is installed.
RUN cat <<'EOF' >> /home/vscode/.zshrc
source /home/vscode/.aliases.zsh
export ANDROID_HOME=/home/vscode/.pi/android-sdk
export ANDROID_SDK_ROOT=/home/vscode/.pi/android-sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
EOF

RUN cat <<'EOF' >> /home/vscode/.bashrc
export ANDROID_HOME=/home/vscode/.pi/android-sdk
export ANDROID_SDK_ROOT=/home/vscode/.pi/android-sdk
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
EOF

# gh's credential helper, system-wide, so `git push` works in a FRESH container.
# `gh auth setup-git` writes to ~/.gitconfig, which is on the container-local
# overlay and is discarded on rebuild — the token survives (it lives in the volume)
# but the thing that lets git USE it does not, so push breaks after every rebuild.
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