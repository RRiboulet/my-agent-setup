---
name: tmux
description: "Drive interactive CLIs (python, gdb, lldb, psql, node, ...) by sending keystrokes and scraping pane output, on a private pi tmux socket. Use when a process needs a persistent TTY that a one-shot bash call cannot provide."
license: Apache-2.0
---

<!-- VENDORED, NOT OURS.
     tmux/SKILL.md — Copyright (c) mitsuhiko and contributors
     https://github.com/mitsuhiko/agent-stuff (skills/tmux/SKILL.md)
     Licensed under the Apache License, Version 2.0.
     Upstream: mitsupi v1.6.0, commit 0865c84.

     LOCAL ADAPTATIONS below, each marked in place:
       A. socket naming: CLAUDE_TMUX_SOCKET_DIR / claude-* / claude.sock become
          PI_TMUX_SOCKET_DIR / pi-* / pi.sock, and the socket flag is made
          consistent (-S everywhere; upstream mixed -S and -L, which address
          different servers).
       B. the subagent reconciliation: our subagent extension owns a second
          socket and the pi-agent-* name space, both off-limits to this skill.
       C. the license frontmatter: upstream says "license: Vibecoded"; the
          vendored copy is Apache-2.0.
       D. scripts/wait-for-text.sh gains -S/-L so it can reach the private
          socket the rest of the skill requires (upstream's helper silently
          used the default tmux server).
       E. the quickstart sets PYTHON_BASIC_REPL=1 on its python, which the
          skill's own "Spawning Processes" section calls mandatory; upstream's
          example omitted it.
     Both scripts are executable and keep their upstream logic; see the
     attribution header in each. -->

# tmux Skill

Use tmux as a programmable terminal multiplexer for interactive work. Works on Linux and macOS with stock tmux; avoid custom config by using a private socket.

## Quickstart (isolated socket)

```bash
SOCKET_DIR="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}"  # well-known dir for all pi agent sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/pi.sock"                    # keep agent sessions separate from your personal tmux
SESSION=pi-python                               # slug-like names; never the reserved pi-agent-* form
tmux -S "$SOCKET" new -d -s "$SESSION" -n shell
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -200  # watch output
tmux -S "$SOCKET" kill-session -t "$SESSION"                   # clean up
```

<!-- LOCAL ADAPTATION A: upstream's snippet used ${TMPDIR:-/tmp}/claude-tmux-sockets,
     "$SOCKET_DIR/claude.sock" and session names like claude-python. Those names
     are now pi's; the socket discipline (one private path, passed with -S on
     every call) is unchanged. -->

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```
To monitor this session yourself:
  tmux -S "$SOCKET" attach -t pi-lldb

Or to capture the output once:
  tmux -S "$SOCKET" capture-pane -p -J -t pi-lldb:0.0 -S -200
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop.  But the earlier you send it, the happier the user will be.

## Socket convention

- Agents MUST place tmux sockets under `PI_TMUX_SOCKET_DIR` (defaults to `${TMPDIR:-/tmp}/pi-tmux-sockets`) and use `tmux -S "$SOCKET"` so we can enumerate/clean them. Create the dir first: `mkdir -p "${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}"`.
- Default socket path to use unless you must isolate further: `SOCKET="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}/pi.sock"`.
- **Use `-S` (a socket *path*), never `-L` (a socket *name* under tmux's own directory).** The two address different servers: a `-L` call looks at `<tmux tmpdir>/tmux-<uid>/<name>` and will not see a session created with `-S`. Upstream mixed the two in a few examples; every command here uses `-S`.

<!-- LOCAL ADAPTATION B: our subagent extension is a second owner of tmux
     sessions, and upstream has no such thing. The rules that keep the two from
     stepping on each other, and the reason find-sessions.sh --all does not show
     subagent sessions. -->

## Relationship to the subagent extension

`.pi/extensions/subagent/` runs each child Pi in a detached tmux session named `pi-agent-<run-id>`, on one dedicated socket at **`<pi agent dir>/tmux-subagents.sock`** (`getAgentDir()`, usually `~/.pi/agent`). That socket and those sessions are managed entirely by the extension, which kills and reaps its own runs. So:

- Do **not** create sessions on the subagent socket, and do **not** `kill-session` a `pi-agent-*` session — the extension still believes it owns that run.
- This skill's sessions belong on `PI_TMUX_SOCKET_DIR` (`.../pi-tmux-sockets`), which is a different directory from the agent dir, so the two sockets cannot collide by default.
- Names on the skill socket are `pi-<slug>` (`pi-python`, `pi-lldb`). `pi-agent-` is reserved for subagents; treat it as a name space this skill does not use.
- To inspect or steer a *subagent* session, use the extension's own tools (`subagent_status`, the attach command it prints), not this skill.

## Targeting panes and naming

- Target format: `{session}:{window}.{pane}`, defaults to `:0.0` if omitted. Keep names short (e.g., `pi-py`, `pi-gdb`).
- Use `-S "$SOCKET"` consistently to stay on the private socket path. If you need user config, drop `-f /dev/null`; otherwise `-f /dev/null` gives a clean config.
- Inspect: `tmux -S "$SOCKET" list-sessions`, `tmux -S "$SOCKET" list-panes -a`.

## Finding sessions

- List sessions on your active socket with metadata: `./scripts/find-sessions.sh -S "$SOCKET"`; add `-q partial-name` to filter.
- Scan all sockets under the shared directory: `./scripts/find-sessions.sh --all` (uses `PI_TMUX_SOCKET_DIR` or `${TMPDIR:-/tmp}/pi-tmux-sockets`).

## Sending input safely

- Prefer literal sends to avoid shell splitting: `tmux -S "$SOCKET" send-keys -t target -l -- "$cmd"`
- When composing inline commands, use single quotes or ANSI C quoting to avoid expansion: `tmux -S "$SOCKET" send-keys -t target -- $'python3 -m http.server 8000'`.
- To send control keys: `tmux -S "$SOCKET" send-keys -t target C-c`, `C-d`, `C-z`, `Escape`, etc.

## Watching output

- Capture recent history (joined lines to avoid wrapping artifacts): `tmux -S "$SOCKET" capture-pane -p -J -t target -S -200`.
- For continuous monitoring, poll with the helper script (below) instead of `tmux wait-for` (which does not watch pane output).
- You can also temporarily attach to observe: `tmux -S "$SOCKET" attach -t "$SESSION"`; detach with `Ctrl+b d`.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action don't assume they remembered the command.

## Spawning Processes

Some special rules for processes:

- when asked to debug, use lldb by default
- when starting a python interactive shell, always set the `PYTHON_BASIC_REPL=1` environment variable. This is very important as the non-basic console interferes with your send-keys.

## Synchronizing / waiting for prompts

- Use timed polling to avoid races with interactive tools. Example: wait for a Python prompt before sending code:
  ```bash
  ./scripts/wait-for-text.sh -S "$SOCKET" -t "$SESSION":0.0 -p '^>>>' -T 15 -l 4000
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.

## Interactive tool recipes

- **Python REPL**: `tmux -S "$SOCKET" send-keys -- 'PYTHON_BASIC_REPL=1 python3 -q' Enter`; wait for `^>>>`; send code with `-l`; interrupt with `C-c`. Always with `PYTHON_BASIC_REPL`.
- **gdb**: `tmux -S "$SOCKET" send-keys -- 'gdb --quiet ./a.out' Enter`; disable paging `tmux -S "$SOCKET" send-keys -- 'set pagination off' Enter`; break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a session when done: `tmux -S "$SOCKET" kill-session -t "$SESSION"`.
- Kill all sessions on a socket: `tmux -S "$SOCKET" list-sessions -F '#{session_name}' | xargs -r -n1 tmux -S "$SOCKET" kill-session -t`.
- Remove everything on the private socket: `tmux -S "$SOCKET" kill-server`.
- Never point the two "kill everything" commands above at the subagent socket (`<agent dir>/tmux-subagents.sock`): `kill-server` there takes down every running child Pi.

## Helper: wait-for-text.sh

`./scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS with bash + tmux + grep.

```bash
./scripts/wait-for-text.sh -S SOCKET -t session:0.0 -p 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-S`/`--socket-path` socket path (required for a private socket; omitted falls back to the default tmux server)
- `-L`/`--socket-name` tmux socket name, instead of `-S`
- `-t`/`--target` pane target (required)
- `-p`/`--pattern` regex to match (required); add `-F` for fixed string
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured text to stderr to aid debugging.

<!-- LOCAL ADAPTATION D: -S/-L above are ours. Upstream's helper accepted only
     -t/-p/-F/-T/-i/-l and always called bare `tmux`, so on the very socket the
     skill tells you to use it would find no server and time out. -->
