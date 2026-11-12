#!/bin/sh
# Restore what the /voice extension needs after a container rebuild or restart.
#
# The chain a /voice run drives:
#
#   pi session -> ssh phone -> host.docker.internal:8022 (this host)
#              -> ssh remote forward the PHONE opened -> phone's Termux sshd
#              -> termux-microphone-record
#
# There is no tailnet here. The phone dials the host (it is the side that can),
# sshd on the host publishes that connection on 8022, and the container reaches
# the host's forwarded port through host.docker.internal — which docker-compose
# adds with `extra_hosts: host.docker.internal:host-gateway`.
#
# Persistent (pi-agent-config volume, ~/.pi): the ssh key pair and the
# ~/.pi/ssh/config template, plus voice.json in this container's pi agent dir
# (~/.pi/agent-my-agent-setup, seeded once from the shared ~/.pi/agent — see
# postCreate.sh).
# Container-local, wiped on rebuild: ~/.ssh/config and known_hosts.
#
# Idempotent — safe to run any time.
#
# Usage:  bash /workspace/.devcontainer/restore-post-rebuild.sh
#
# Run automatically on container creation by the devcontainer's
# postCreateCommand. If the whole pi-config volume was wiped this script is not
# enough (the key and the template are gone): redo the setup in
# .devcontainer/voice-container.md from scratch.

PI=/home/vscode/.pi
HOST=${VOICE_TUNNEL_HOST:-host.docker.internal}
PORT=${VOICE_TUNNEL_PORT:-8022}

# 1. ~/.ssh/config — container-local, wiped on rebuild; the template lives on
#    the volume. known_hosts regenerates itself (`StrictHostKeyChecking
#    accept-new` in the template).
if [ -f "$PI/ssh/config" ]; then
	mkdir -p "$HOME/.ssh"
	chmod 700 "$HOME/.ssh"
	cp "$PI/ssh/config" "$HOME/.ssh/config"
	chmod 600 "$HOME/.ssh/config"
	echo "[restore] ~/.ssh/config restored from ~/.pi/ssh/config"
else
	echo "[restore] WARNING: no ~/.pi/ssh/config template found" >&2
	echo "[restore]   see .devcontainer/voice-container.md, first-time setup" >&2
fi

# 2. Wait for the phone's reverse tunnel to be listening on the host.
#
#    Liveness is probed by *connecting*, never by looking for a process or a
#    file: the tunnel is owned by the phone, so nothing in this container can
#    inspect it, and a listener that is gone leaves no artifact to check.
#    `bash -c` because this script is /bin/sh and /dev/tcp is a bash feature;
#    it avoids an apt package just for a TCP probe.
probe() {
	/bin/bash -c "exec 3<>/dev/tcp/$HOST/$PORT" 2>/dev/null
}

if probe; then
	echo "[restore] reverse tunnel is up on $HOST:$PORT"
else
	echo "[restore] waiting for the phone's reverse tunnel on $HOST:$PORT (up to 10s)"
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		sleep 1
		probe && break
	done
	if probe; then
		echo "[restore] reverse tunnel is up on $HOST:$PORT"
	else
		echo "[restore] WARNING: nothing is listening on $HOST:$PORT" >&2
		echo "[restore]   the phone must open the tunnel:" >&2
		echo "[restore]     ssh -N -R 0.0.0.0:$PORT:localhost:$PORT <user>@<this host>" >&2
		echo "[restore]   and this host needs both, once:" >&2
		echo "[restore]     GatewayPorts clientspecified   (in sshd_config.d, then reload ssh)" >&2
		echo "[restore]     iptables -I INPUT 5 -s 172.16.0.0/12 -p tcp --dport $PORT -j ACCEPT" >&2
	fi
fi

# 3. End-to-end verification: the whole chain in one command. Best effort —
#    container creation must not fail because the phone is elsewhere.
if ssh -o ConnectTimeout=15 phone true 2>/dev/null; then
	echo "[restore] OK: ssh phone works — /voice is ready"
else
	echo "[restore] WARNING: ssh phone failed. Check, in order:" >&2
	echo "[restore]   1. tunnel: ssh -N -R 0.0.0.0:$PORT:localhost:$PORT on the phone" >&2
	echo "[restore]   2. phone: Termux sshd running on port $PORT" >&2
	echo "[restore]   3. key: ~/.pi/ssh/id_ed25519_phone.pub is in the phone's" >&2
	echo "[restore]      ~/.ssh/authorized_keys (mode 600; ~/.ssh mode 700)" >&2
fi
