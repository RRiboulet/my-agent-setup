---
name: devcontainer
description: "Work inside a project's devcontainer from a headless host with `devc` (devcontainer up + exec, tmux, no editor). Use when running commands inside a project container, when a container build, dev server or database misbehaves, or when the user asks to open, reopen, rebuild, stop or diagnose a project's devcontainer."
---

# devcontainers with `devc`

`devc` is a small wrapper around `@devcontainers/cli`: it resolves the project,
runs `devcontainer up` (idempotent, and it recreates a container whose config
changed), checks that the container user's uid matches the host's, and then
either attaches a login shell in tmux or runs one command.

There is no editor on this host. "Open a devcontainer" means *ensure it is
running, then run something inside it*.

## The one rule that matters for an agent

**Never run the attaching form from a tool call.** `devc <name>` and bare `devc`
exec `tmux new-session -A`, which blocks until the session ends — the tool call
hangs, and the human's session is abandoned mid-command. Use `devc up` and
`devc <name> -- <command>` instead. Say so if the user asks for an interactive
shell: they run `devc <name>` themselves.

## Commands

| Goal | Command |
|---|---|
| list projects, state, published ports | `devc ls` |
| make sure it is built and running | `devc up <name>` |
| run one command inside | `devc <name> -- <cmd...>` |
| recreate the container (named volumes kept) | `devc rebuild <name>` |
| recreate and rebuild the image without cache | `devc rebuild <name> --no-cache` |
| stop it (volumes kept) | `devc stop <name>` |
| preflight and known blockers | `devc doctor [name]` |
| show what would run, do nothing | `DEVC_DRY_RUN=1 devc ...` |

`<name>` is the project directory's basename (`pupkeep`, `analytics-agent`,
`my-agent-setup`) or an absolute path. Projects come from an allowlist in
`~/.config/devc/roots`; add a root there rather than guessing a path.

`devc <name> -- <cmd>` is exactly `devcontainer exec --workspace-folder <dir> <cmd>`,
so any command that works in the container works here. Raw equivalents are fine
when debugging: `devcontainer up --workspace-folder <dir>`,
`devcontainer exec --workspace-folder <dir> bash -lc '...'`, and
`docker ps --filter label=devcontainer.local_folder=<dir>`.

## Before running anything

Run `devc doctor` once per session. It reports the Docker daemon and its
architecture, the CLI version, free disk, host uid vs container uid, stale
config, and per-project blockers. If it says nothing blocking, go ahead.

If `docker info` fails with "permission denied", this agent process predates the
user's addition to the `docker` group: prefix commands with
`sg docker -c '...'`, or tell the user to re-login and restart pi.

## Long builds

A first build is 5–30 minutes (apt, npm, features, database init) and a tool call
will time out before it finishes. Do not raise the timeout and hope: start it
detached and poll, e.g.

```bash
nohup devc up analytics-agent > /tmp/devc-aa.log 2>&1 &
sleep 60; tail -5 /tmp/devc-aa.log; devc ls
```

`devc` takes a per-project `flock`, so a second invocation waits instead of
racing the first.

## Running a server

Detach it and read its log; a foregrounded server blocks the exec call:

```bash
devc pupkeep -- bash -lc 'nohup npm start -- --access lan --data /tmp/pupkeep-dev > /tmp/start.log 2>&1 &'
sleep 3; devc pupkeep -- curl -fsS http://127.0.0.1:8787/healthz
```

Ports are published on the **host's loopback** (`127.0.0.1:8787`,
`127.0.0.1:8000`), so `curl` from the host works and nothing is exposed to the
internet. `forwardPorts` in `devcontainer.json` is a VS Code feature and does
nothing here; do not "fix" a missing port by publishing `0.0.0.0`.

## Rules that prevent damage

- Never run `docker compose down -v`, `docker system prune --volumes`, or
  anything that removes a named volume. They hold pi sessions, provider auth,
  the gh token and (analytics) the Olist database.
- Never run `devc` or `devcontainer` under `sudo`. Root skips the uid remap, and
  a project's `postCreate` then chowns the bind-mounted checkout to a uid the
  host user does not own.
- Do not pass `--update-remote-user-uid-default never` or set
  `updateRemoteUserUID: false`. `devc` refuses to attach when the uids differ;
  that guard is the fix, not an obstacle.
- Do not edit `iptables`, `sshd_config.d`, or the Oracle cloud rules to make a
  container reachable. Ports go to loopback and out through `ssh -L`.
- `devc rebuild` recreates the container; it does not delete images or volumes.
  `--no-cache` is for a genuinely stale image, not for a config change.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| `docker: permission denied` | `id -nG`, `docker info` | `sg docker -c '...'`, or re-login |
| `devc doctor` says **stale** | config hash changed | `devc up <name>` recreates it |
| `devc up` says uid mismatch | container user uid ≠ host uid | `devc rebuild <name>`; never disable the remap |
| command not found inside | `devc <name> -- bash -lc 'command -v x'`; `echo $PATH` | the tool is missing from the image, or only on a login shell |
| build fails with "additional privileges requested: … fs.read" | `docker compose build` needs the feature Dockerfile inlined | declare `features` explicitly in `devcontainer.json` (auto-mapped defaults take the broken path on CLI 0.90 + Docker 29) |
| Postgres unreachable | `devc analytics-agent -- bash -lc 'exec 3<>/dev/tcp/postgres/5432'` | it is a compose service, not `localhost`; `devc doctor` for state |
| `ssh phone` fails (voice) | `devc my-agent-setup -- bash -lc 'exec 3<>/dev/tcp/host.docker.internal/8022'` | the phone's `ssh -N -R 0.0.0.0:8022:localhost:8022` is down; see `.devcontainer/voice-container.md` |
| container exists but is the old config | `devc doctor` | `devc rebuild <name>` |

## Host and project facts (this VM)

- Ubuntu 24.04, aarch64, Docker 29.9.2, `@devcontainers/cli` 0.90.0, `devc` at
  `/usr/local/bin/devc` (symlink into `my-agent-setup/bin`).
- Containers run as uid 1001 (`ubuntu`), remapped by the CLI's
  `updateRemoteUserUID`; all three projects build natively for arm64.
- **pupkeep** (`~/pupkeep`): Node 24 + pi 1.4.0; server on 8787; `npm test`
  inside is 275 tests. cloudflared is installed per architecture.
- **analytics-agent** (`~/analytics-agent`): Python + uv; PostgreSQL is the
  `postgres` compose service (`postgres:5432`, volume `analytics-postgres`), the
  MCP server publishes 8000. `DATABASE_URL` comes from `containerEnv`, so
  `.env`'s `localhost` values apply only to a host run. `uv run pytest`.
- **my-agent-setup** (`~/my-agent-setup`): the pi package itself; `/voice`
  reaches the phone through a reverse SSH forward to `host.docker.internal:8022`
  (no Tailscale). No Android SDK, no JDK, no Docker-in-Docker anywhere.

Project-specific detail belongs in each repo's `AGENTS.md`; read it before
changing that project's devcontainer.
