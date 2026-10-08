#!/usr/bin/env bash
set -euo pipefail

# VENDORED, NOT OURS.
# scripts/find-sessions.sh — Copyright (c) mitsuhiko and contributors
# https://github.com/mitsuhiko/agent-stuff (skills/tmux/scripts/find-sessions.sh)
# Licensed under the Apache License, Version 2.0.
# Upstream: mitsupi v1.6.0, commit 0865c84.
#
# LOCAL ADAPTATIONS (the letters refer to SKILL.md's list, so the two files
# cannot drift into meaning different things by "adaptation B"):
#   - SKILL.md A: the shared socket directory is PI_TMUX_SOCKET_DIR (default
#     ${TMPDIR:-/tmp}/pi-tmux-sockets), not upstream's CLAUDE_TMUX_SOCKET_DIR.
#   - SKILL.md F: three find-sessions fixes. (1) upstream's '\t' sat inside
#     single quotes, which tmux does not expand, so every row lost its
#     attached/created columns; use a real tab. (2) #{session_created_string}
#     is not a tmux format variable (3.3a has #{session_created}), so the start
#     time was always blank; use #{t:session_created}. (3) -q now matches the
#     session NAME, as its usage documents, not the whole tab-joined row, and
#     the attached label treats #{session_attached} as a client count.
# The -L/-S/-A/-q option set is otherwise upstream's.

usage() {
  cat <<'USAGE'
Usage: find-sessions.sh [-L socket-name|-S socket-path|-A] [-q pattern]

List tmux sessions on a socket. With neither -L nor -S this uses tmux's
ambient socket -- the one in $TMUX when set, which inside a pi/subagent
session is the subagent socket -- otherwise tmux's default. Pass -S.

Options:
  -L, --socket       tmux socket name (passed to tmux -L)
  -S, --socket-path  tmux socket path (passed to tmux -S)
  -A, --all          scan all sockets under PI_TMUX_SOCKET_DIR
  -q, --query        case-insensitive substring to filter session names
  -h, --help         show this help
USAGE
}

socket_name=""
socket_path=""
query=""
scan_all=false
# LOCAL ADAPTATION A: PI_TMUX_SOCKET_DIR is this repo's convention; CLAUDE_TMUX_SOCKET_DIR is upstream's.
socket_dir="${PI_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/pi-tmux-sockets}"

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
    -L|--socket)      require_value "$@"; socket_name="$2"; shift 2 ;;
    -S|--socket-path) require_value "$@"; socket_path="$2"; shift 2 ;;
    -A|--all)         scan_all=true; shift ;;
    -q|--query)       require_value "$@"; query="$2"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$scan_all" == true && ( -n "$socket_name" || -n "$socket_path" ) ]]; then
  echo "Cannot combine --all with -L or -S" >&2
  exit 1
fi

if [[ -n "$socket_name" && -n "$socket_path" ]]; then
  echo "Use either -L or -S, not both" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH" >&2
  exit 1
fi

# Keep the skill's socket discipline from being broken by omission: a bare tmux
# follows $TMUX when it is set, and inside a pi/subagent shell that is the
# subagent socket. --all never uses the ambient socket, so it is exempt.
if [[ "$scan_all" != true && -z "$socket_name" && -z "$socket_path" && -n "${TMUX:-}" ]]; then
  echo "Warning: no -S/-L given; tmux will use \$TMUX (${TMUX%%,*}), which inside a pi/subagent session is the subagent socket. Pass -S explicitly." >&2
fi

list_sessions() {
  local label="$1"; shift
  local tmux_cmd=(tmux "$@")

  # LOCAL ADAPTATION F (bug fixes, per SKILL.md): upstream wrote '#{session_name}\t...' inside
  # single quotes. tmux does not expand \t, so the literal two characters were
  # printed, the tab-splitting `read` below saw a single field, and every row
  # lost its attached/created columns. Use a real tab. Also, #{session_created_string}
  # is not a tmux variable; #{t:session_created} is the formatted creation time.
  local tab=$'\t'
  if ! sessions="$("${tmux_cmd[@]}" list-sessions -F "#{session_name}${tab}#{session_attached}${tab}#{t:session_created}" 2>/dev/null)"; then
    echo "No tmux server found on $label" >&2
    return 1
  fi

  if [[ -n "$query" ]]; then
    # Match the session NAME (field 1), not the whole tab-joined row: grepping
    # the row made `-q Thu` match a session created on a Thursday and `-q .`
    # match everything, though the option is documented as a substring of the
    # name. A case-folded literal index(), so regex metacharacters are inert.
    sessions="$(printf '%s\n' "$sessions" | awk -F'\t' -v q="$query" 'index(tolower($1), tolower(q))')"
  fi

  if [[ -z "$sessions" ]]; then
    echo "No sessions found on $label"
    return 0
  fi

  echo "Sessions on $label:"
  printf '%s\n' "$sessions" | while IFS=$'\t' read -r name attached created; do
    # #{session_attached} is the number of attached clients, not a boolean:
    # treating only "1" as attached mislabelled a session with two clients.
    attached_label=$( (( ${attached:-0} > 0 )) && echo "attached" || echo "detached" )
    printf '  - %s (%s, started %s)\n' "$name" "$attached_label" "$created"
  done
}

if [[ "$scan_all" == true ]]; then
  if [[ ! -d "$socket_dir" ]]; then
    echo "Socket directory not found: $socket_dir" >&2
    exit 1
  fi

  shopt -s nullglob
  sockets=("$socket_dir"/*)
  shopt -u nullglob

  if [[ "${#sockets[@]}" -eq 0 ]]; then
    echo "No sockets found under $socket_dir" >&2
    exit 1
  fi

  # A stale socket (a socket file whose server is gone) is not an error for
  # --all: keep scanning, and only fail if no socket answered at all. This also
  # makes a directory of plain files behave like an empty one instead of
  # silently succeeding.
  listed=0
  for sock in "${sockets[@]}"; do
    if [[ ! -S "$sock" ]]; then
      continue
    fi
    if list_sessions "socket path '$sock'" -S "$sock"; then
      listed=1
    fi
  done

  if [[ "$listed" == 0 ]]; then
    echo "No tmux server found on any socket under $socket_dir" >&2
    exit 1
  fi
  exit 0
fi

tmux_cmd=(tmux)
socket_label="ambient socket (no -S/-L given)"

if [[ -n "$socket_name" ]]; then
  tmux_cmd+=(-L "$socket_name")
  socket_label="socket name '$socket_name'"
elif [[ -n "$socket_path" ]]; then
  tmux_cmd+=(-S "$socket_path")
  socket_label="socket path '$socket_path'"
fi

list_sessions "$socket_label" "${tmux_cmd[@]:1}"
