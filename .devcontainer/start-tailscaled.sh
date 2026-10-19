#!/bin/sh
# Start tailscaled in userspace mode for the devcontainer (no /dev/tun here).
# - SOCKS5 proxy on 127.0.0.1:1055: the only way in/out of the tailnet.
# - Socket and state under ~/.pi (the pi-agent-config volume): the node
#   identity and this config survive container rebuilds; only this script's
#   launch and, after a rebuild, `tailscale up` (or an auth key) must repeat.
exec /home/vscode/.pi/bin/tailscaled \
	--tun=userspace-networking \
	--socks5-server=127.0.0.1:1055 \
	--socket=/home/vscode/.pi/tailscale/tailscaled.sock \
	--state=/home/vscode/.pi/tailscale/tailscaled.state
