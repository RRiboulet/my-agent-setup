#!/usr/bin/env bash
# Link the globally installed pi packages into ./node_modules so the subagent
# extension's test suite can run with `node --test` and no build step.
#
# Why symlinks instead of `npm install`:
#   - The tests must exercise the exact pi runtime this devcontainer provides
#     (pi 1.0.0, installed globally by .devcontainer/Dockerfile).
#   - No lockfile or version drift to manage, and nothing new is fetched.
#
# `node_modules/@earendil-works/` and `node_modules/typebox` are gitignored, so
# these links are never committed.
#
# Usage (from the repository root):
#   .pi/extensions/subagent/test/setup-deps.sh
#   node --test .pi/extensions/subagent/test/*.test.ts

set -euo pipefail

PI_ROOT="${PI_GLOBAL_ROOT:-$(npm root -g)}/@earendil-works/pi-coding-agent"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

if [[ ! -d "$PI_ROOT" ]]; then
	echo "error: pi-coding-agent not found at $PI_ROOT" >&2
	echo "       set PI_GLOBAL_ROOT to override 'npm root -g'" >&2
	exit 1
fi

mkdir -p "$REPO_ROOT/node_modules/@earendil-works"

link() {
	local target="$1" name="$2"
	ln -sfn "$target" "$REPO_ROOT/node_modules/$name"
	echo "linked node_modules/$name -> $target"
}

link "$PI_ROOT" "@earendil-works/pi-coding-agent"
link "$PI_ROOT/node_modules/@earendil-works/pi-ai" "@earendil-works/pi-ai"
link "$PI_ROOT/node_modules/@earendil-works/pi-tui" "@earendil-works/pi-tui"
link "$PI_ROOT/node_modules/typebox" "typebox"