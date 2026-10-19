#!/bin/sh
# Restore everything the voice extension needs after a container rebuild
# (or restart). Everything persistent lives on the pi-agent-config volume
# (~/.pi): the ssh key pair and config template in ~/.pi/ssh, the tailscale
# binaries and state in ~/.pi/{bin,tailscale}, and ~/.pi/agent/voice.json.
# This script is idempotent — safe to run any time.
#
# Usage:  bash /workspace/.devcontainer/restore-post-rebuild.sh
#
# Run automatically on container creation by the devcontainer's
# postCreateCommand. If the whole pi-config volume was wiped, this script is
# not enough (key, tailscale state and binaries are gone): redo the setup in
# .devcontainer/voice-container.md from scratch.

PI=/home/vscode/.pi

# 1. netcat-openbsd — the ssh ProxyCommand (`nc -X 5`) that routes ssh
#    through the tailscale SOCKS5 proxy. apt packages live in the container
#    layer: wiped on rebuild, kept on restart.
if ! command -v nc >/dev/null 2>&1 || ! nc -h 2>&1 | grep -q -- '-X'; then
	echo "[restore] installing netcat-openbsd (needed for the ssh proxy command)"
	sudo apt-get update -qq || true
	sudo apt-get install -y netcat-openbsd
else
	echo "[restore] netcat-openbsd present"
fi

# 2. ~/.ssh/config — container-local, wiped on rebuild; the template is on
#    the volume. known_hosts regenerates itself (accept-new in the config).
if [ -f "$PI/ssh/config" ]; then
	mkdir -p "$HOME/.ssh"
	chmod 700 "$HOME/.ssh"
	cp "$PI/ssh/config" "$HOME/.ssh/config"
	echo "[restore] ~/.ssh/config restored from ~/.pi/ssh/config"
else
	echo "[restore] WARNING: no ~/.pi/ssh/config template found" >&2
fi

# 3. tailscaled — not an init service: it dies with the container and must be
#    relaunched. Binaries and state are on the volume, so the node keeps its
#    tailnet identity and no re-approval is needed.
#
#    Liveness is probed by *connecting* to the socket, not by testing for the
#    file: a container teardown SIGKILLs the daemon, which leaves the socket
#    file behind, so `[ -S ]` reports a dead daemon as running and the script
#    then skips the launch. tailscaled tolerates and replaces a stale socket,
#    so nothing has to be cleaned up first.
SOCKET="$PI/tailscale/tailscaled.sock"
if nc -z -U "$SOCKET" 2>/dev/null; then
	echo "[restore] tailscaled already running"
else
	echo "[restore] starting tailscaled (userspace SOCKS5 on 127.0.0.1:1055)"
	# `sh <script>` rather than `./<script>`: this bind-mounted checkout has
	# core.fileMode false, so the exec bit is not in git — the same reason
	# postCreate.sh is invoked through an interpreter and not directly.
	nohup sh /workspace/.devcontainer/start-tailscaled.sh >"$PI/tailscale/tailscaled.log" 2>&1 &
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		nc -z -U "$SOCKET" 2>/dev/null && break
		sleep 1
	done
fi

# 4. End-to-end verification: the whole chain in one command.
sleep 1
if ssh -o ConnectTimeout=15 phone true 2>/dev/null; then
	echo "[restore] OK: ssh phone works — /voice is ready"
else
	echo "[restore] WARNING: ssh phone failed. Check, in order:" >&2
	echo "[restore]   1. tailscale: ~/.pi/bin/tailscale --socket=$PI/tailscale/tailscaled.sock status" >&2
	echo "[restore]      (if logged out: ... up)" >&2
	echo "[restore]   2. phone: sshd running, phone on the same tailnet" >&2
fi
