# The `/voice` container side

Everything the voice extension needs **in and around this container**, as
opposed to on the phone. The phone side (Termux, Termux:API, sshd, the
`authorized_keys` entry) is documented in `.pi/extensions/voice/README.md`
under "Phone prerequisites" — this file covers the rest.

The chain a `/voice` run drives looks like this:

```
pi session → ssh phone → host.docker.internal:8022 → sshd on this host
           → the reverse forward the PHONE opened → phone's Termux sshd (8022)
           → termux-microphone-record
```

**No tailnet.** The container has no `/dev/tun`, and the phone is the side that
can dial out, so the phone opens an ordinary ssh *remote* forward to the host
and the container reaches the host's forwarded port. Earlier versions ran a
userspace `tailscaled` in the container with a SOCKS5 `ProxyCommand`; that is
gone, along with the tailnet approval step and the tailscale binaries on the
volume.

## Layout: what lives where

| Where | What | Survives a rebuild? |
|---|---|---|
| pi-agent-config volume (`/home/vscode/.pi`) | ssh key pair `ssh/id_ed25519_phone{,.pub}`, ssh config template `ssh/config`, pi config incl. `agent/voice.json` | yes — the volume's whole purpose |
| this repo (`/workspace`, bind mount) | the extension itself (`.pi/extensions/voice/`), this file, the restore script | yes — it is the host checkout |
| container layer (everything else) | `~/.ssh/config` + `known_hosts` | no — wiped on rebuild, kept on restart |

The extension itself never needs attention on a rebuild: it lives in the repo,
which is bind-mounted. Only the container-layer row above is at risk, and
`restore-post-rebuild.sh` puts it back.

## First-time setup

Done in order; each step's artifacts land in the table above.

**1. ssh key pair** — the container is the ssh *client*, the phone is the
server, so the container needs a client key. No passphrase: the extension
spawns `ssh` non-interactively, and a prompt would break `/voice`. Stored on
the volume so a rebuild cannot strand the phone's `authorized_keys`:

```bash
mkdir -p ~/.pi/ssh && chmod 700 ~/.pi/ssh
ssh-keygen -t ed25519 -f ~/.pi/ssh/id_ed25519_phone -N "" -C "pi-devcontainer->phone (voice)"
```

Install the public half on the phone (`~/.ssh/authorized_keys`, mode `600`,
`.ssh` mode `700`) — see the voice README's prerequisites. Termux sshd answers
on port **8022**.

**2. Allow the reverse forward on the host.** Two host-side pieces, both
one-liners; neither is optional, and each has a specific failure mode.

*A `-R` forward binds the host's loopback by default, and the container arrives
on the docker bridge gateway, not on `127.0.0.1`.* Let the phone choose the bind
address, then reload sshd:

```bash
# /etc/ssh/sshd_config.d/60-reverse-forward.conf
GatewayPorts clientspecified
```

```bash
sudo sshd -t && sudo systemctl reload ssh   # -t validates before you reload
```

*Host listeners are filtered by `INPUT`, unlike Docker-published ports.* On an
Oracle image `INPUT` accepts established, ICMP, loopback and port 22, then
rejects everything else — so a connection from a container to the host's 8022
fails with `Host is unreachable` even though the forward is listening. Accept
the forwarded port from docker networks only, and keep the rule in the file
`netfilter-persistent` restores at boot:

```bash
sudo iptables -I INPUT 5 -s 172.16.0.0/12 -p tcp -m tcp --dport 8022 -j ACCEPT
```

Then add the same `-A INPUT -s 172.16.0.0/12 -p tcp -m tcp --dport 8022 -j ACCEPT`
line to `/etc/iptables/rules.v4` **before** its final
`-A INPUT -j REJECT --reject-with icmp-host-prohibited`, and check it parses:

```bash
sudo iptables-restore --test < /etc/iptables/rules.v4
```

Edits to that file survive a reboot only if they are made to the file itself; a
live `iptables -I` is gone after `netfilter-persistent` restores at boot. The
source range keeps the port reachable from containers and rejected from
everything else, so binding `0.0.0.0` below does not expose it to the network.

**3. Start the tunnel from the phone** (it is the side that can reach the host):

```bash
ssh -N -R 0.0.0.0:8022:localhost:8022 <user>@<this host>
```

Keep it running — `autossh`, a Termux:Boot entry, or a tmux window. The tunnel
is a property of the phone's session, not of this container: a container
rebuild does not drop it, and a phone reboot does.

**4. ssh config** — the template at `~/.pi/ssh/config` (copied to
`~/.ssh/config`, which is container-local):

```
Host phone
    HostName host.docker.internal   # the host's docker gateway
    User <termux-user>              # `whoami` in Termux
    Port 8022
    IdentityFile ~/.pi/ssh/id_ed25519_phone
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new   # non-interactive first trust
```

`host.docker.internal` is added by `.devcontainer/docker-compose.yml`
(`extra_hosts: host.docker.internal:host-gateway`). No `ProxyCommand` is
needed: the forward lands on the host's own port, so a plain TCP connection is
the whole route.

**5. `~/.pi/agent/voice.json`** — transcription config; `sshTarget` is
already correct by default (`phone`). Example with OpenRouter:

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "openai/whisper-large-v3",
  "apiKey": "<your key>"
}
```

## After a rebuild or restart

The devcontainer's `postCreateCommand` runs the restore script on every
container creation, so normally there is nothing to do. To run it by hand:

```bash
bash /workspace/.devcontainer/restore-post-rebuild.sh
```

It restores `~/.ssh/config` from the volume template, waits up to ten seconds
for the reverse tunnel to accept a connection, then verifies the whole chain
with `ssh phone true`. Idempotent, so it is also safe on a plain restart.
Everything it touches is reproducible — if a step fails, its output names the
next thing to check.

Two details of the script are load-bearing and easy to "fix" back into bugs:

- **Liveness is probed by connecting** to the forwarded port, not by looking
  for a process or a file. The listener belongs to the phone's tunnel, so this
  container can neither see nor inspect it; a connection attempt is the only
  honest test.
- **Scripts here are invoked through an interpreter** (`bash
  restore-post-rebuild.sh`). This checkout is bind-mounted and has
  `core.fileMode false`, so the exec bit is not in git; `./script.sh` fails
  with "Permission denied". The devcontainer's `postCreateCommand` calls
  `bash` for the same reason.

## If the pi-config volume is ever wiped

The restore script cannot help here: the key pair and `voice.json` are gone
with the volume. Redo first-time setup steps 1, 4 and 5, then re-test
`ssh phone true`. The phone-side `authorized_keys` entry survives a volume wipe
— only a rebuild *of the phone's Termux* invalidates it.

The tailscale binaries and state under `~/.pi/{bin,tailscale}` may still be
present on an older volume. Nothing reads them any more; `rm -rf
~/.pi/bin/tailscaled ~/.pi/bin/tailscale ~/.pi/tailscale` is safe once no
`tailscaled` process is running.
