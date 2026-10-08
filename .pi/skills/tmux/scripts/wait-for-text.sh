#!/usr/bin/env bash
set -euo pipefail

# VENDORED, NOT OURS.
# scripts/wait-for-text.sh — Copyright (c) mitsuhiko and contributors
# https://github.com/mitsuhiko/agent-stuff (skills/tmux/scripts/wait-for-text.sh)
# Licensed under the Apache License, Version 2.0.
# Upstream: mitsupi v1.6.0, commit 0865c84.
#
# LOCAL ADAPTATION D (marked in place below): upstream always invoked bare
# `tmux`, so against the private socket the skill requires it could never find
# the pane. Added -S/--socket-path and -L/--socket-name, threaded through to
# every tmux call, with the same mutual-exclusion rule find-sessions.sh uses.
# -L is kept only for parity with find-sessions.sh; the skill always uses -S.
# The polling loop and its options are otherwise upstream's.

usage() {
  cat <<'USAGE'
Usage: wait-for-text.sh -t target -p pattern [options]

Poll a tmux pane for text and exit when found.

With neither -S nor -L this uses tmux's ambient socket -- the one in $TMUX
when set, which inside a pi/subagent session is the subagent socket --
otherwise tmux's default. Pass -S for the skill's private socket.

Options:
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -L, --socket-name  tmux socket name (passed to tmux -L); parity only, the skill uses -S
  -t, --target    tmux target (session:window.pane), required
  -p, --pattern   regex pattern to look for, required
  -F, --fixed     treat pattern as a fixed string (grep -F)
  -T, --timeout   seconds to wait (integer, default: 15)
  -i, --interval  poll interval in seconds (default: 0.5)
  -l, --lines     number of history lines to inspect (integer, default: 1000)
  -h, --help      show this help
USAGE
}

target=""
pattern=""
grep_flag="-E"
timeout=15
interval=0.5
lines=1000
# LOCAL ADAPTATION D: socket selection, absent upstream.
socket_name=""
socket_path=""

# A value-taking option followed by nothing would otherwise make `shift 2` hit
# `set -e` and exit 1 with no message.
require_value() {
  if [[ $# -lt 2 ]]; then
    echo "Option $1 requires a value" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -S|--socket-path) require_value "$@"; socket_path="$2"; shift 2 ;;
    -L|--socket-name) require_value "$@"; socket_name="$2"; shift 2 ;;
    -t|--target)   require_value "$@"; target="$2"; shift 2 ;;
    -p|--pattern)  require_value "$@"; pattern="$2"; shift 2 ;;
    -F|--fixed)    grep_flag="-F"; shift ;;
    -T|--timeout)  require_value "$@"; timeout="$2"; shift 2 ;;
    -i|--interval) require_value "$@"; interval="$2"; shift 2 ;;
    -l|--lines)    require_value "$@"; lines="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$target" || -z "$pattern" ]]; then
  echo "target and pattern are required" >&2
  usage
  exit 1
fi

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -S or -L, not both" >&2
  exit 1
fi

if ! [[ "$timeout" =~ ^[0-9]+$ ]]; then
  echo "timeout must be an integer number of seconds" >&2
  exit 1
fi

if ! [[ "$lines" =~ ^[0-9]+$ ]]; then
  echo "lines must be an integer" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# Keep the skill's socket discipline from being broken by omission: a bare tmux
# follows $TMUX when it is set, which inside a pi/subagent shell is the subagent
# socket.
if [[ -z "$socket_name" && -z "$socket_path" && -n "${TMUX:-}" ]]; then
  echo "Warning: no -S/-L given; tmux will use \$TMUX (${TMUX%%,*}), which inside a pi/subagent session is the subagent socket. Pass -S explicitly." >&2
fi

# LOCAL ADAPTATION D: build the socket prefix once and reuse it for every poll.
tmux_cmd=(tmux)
if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
elif [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
fi

# End time in epoch seconds (integer, good enough for polling)
start_epoch=$(date +%s)
deadline=$((start_epoch + timeout))

while true; do
  # -J joins wrapped lines, -S uses negative index to read last N lines
  pane_text="$("${tmux_cmd[@]}" capture-pane -p -J -t "$target" -S "-${lines}" 2>/dev/null || true)"

  if printf '%s\n' "$pane_text" | grep $grep_flag -- "$pattern" >/dev/null 2>&1; then
    exit 0
  fi

  now=$(date +%s)
  if (( now >= deadline )); then
    echo "Timed out after ${timeout}s waiting for pattern: $pattern" >&2
    echo "Last ${lines} lines from $target:" >&2
    printf '%s\n' "$pane_text" >&2
    exit 1
  fi

  sleep "$interval"
done
