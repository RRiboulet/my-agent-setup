# The `/voice` container side

Everything the voice extension needs **in and around this container**, as
opposed to on the phone. The phone side (Termux, Termux:API, sshd, the
`authorized_keys` entry) is documented in `.pi/extensions/voice/README.md`
under "Phone prerequisites" — this file covers the rest.

The chain a `/voice` run drives looks like this:

```
pi session → ssh phone <command> → SOCKS5 proxy (tailscaled) → tailnet →
phone → Termux sshd (port 8022) → termux-microphone-record
```

## Layout: what lives where

| Where | What | Survives a rebuild? |
|---|---|---|
| pi-agent-config volume (`/home/vscode/.pi`) | ssh key pair `ssh/id_ed25519_phone{,.pub}`, ssh config template `ssh/config`, tailscale binaries `bin/{tailscale,tailscaled}`, tailscale state `tailscale/`, pi config incl. `agent/voice.json` | yes — the volume's whole purpose |
| this repo (`/workspace`, bind mount) | the extension itself (`.pi/extensions/voice/`), this file, the two scripts | yes — it is the host checkout |
| container layer (everything else) | apt packages (`netcat-openbsd`), `~/.ssh/config` + `known_hosts`, the running `tailscaled` process | no — wiped on rebuild, kept on restart |

The extension itself never needs attention on a rebuild: it lives in the
repo, which is bind-mounted. Only the three container-layer rows above are
at risk, and `restore-post-rebuild.sh` (below) puts them back.

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
`.ssh` mode `700`) — see the voice README's prerequisites.

**2. Tailscale, userspace mode** — the container has no `/dev/tun`, so the
tailscale daemon runs as a userspace SOCKS5 proxy instead of a kernel
interface:

```bash
# one-time: fetch the tarball, install the binaries into the volume
curl -fsSL -o /tmp/tailscale.tgz https://pkgs.tailscale.com/stable/tailscale_<ver>_amd64.tgz
tar -xzf /tmp/tailscale.tgz -C /tmp
install /tmp/tailscale_<ver>_amd64/{tailscale,tailscaled} ~/.pi/bin/

# start it (also: bash /workspace/.devcontainer/start-tailscaled.sh)
# then join the tailnet: it prints a URL — open it in a browser and approve
# the node once. The state file on the volume remembers the identity, so a
# rebuild needs no second approval.
```

The phone and the container must be on the same tailnet. The daemon's
socket and state live under `~/.pi/tailscale/` (persistent). Termux sshd
answers on port **8022**.

**3. ssh config** — the template at `~/.pi/ssh/config` (copied to
`~/.ssh/config`, which is container-local):

```
Host phone
    HostName <phone-tailscale-ip>     # stable; set once, rarely changes
    User <termux-user>                # `whoami` in Termux
    Port 8022
    IdentityFile ~/.pi/ssh/id_ed25519_phone
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new   # non-interactive first trust
    ProxyCommand nc -X 5 -x 127.0.0.1:1055 %h %p
```

The `ProxyCommand` is what makes a plain `ssh phone ...` route through the
tailscale SOCKS5 proxy; `nc -X 5` is why `netcat-openbsd` is required.

**4. `~/.pi/agent/voice.json`** — transcription config; `sshTarget` is
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

It reinstalls `netcat-openbsd` if missing, restores `~/.ssh/config` from the
volume template, starts `tailscaled` if it is not running, then verifies the
whole chain with `ssh phone true`. Idempotent, so it is also safe to run on a
plain restart, where only the daemon process is actually missing. Everything
it touches is reproducible — if a step fails, its output names the next
command to check.

## If the pi-config volume is ever wiped

The restore script cannot help here: the key pair, the tailscale binaries and
state, and `voice.json` are gone with the volume. Redo First-time setup
1–4, then re-grant the tailnet approval (step 2's URL), then re-test
`ssh phone true`. The phone-side `authorized_keys` entry survives a volume
wipe — only a rebuild *of the phone's Termux* invalidates it.
