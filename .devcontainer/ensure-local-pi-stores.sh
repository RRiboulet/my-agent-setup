#!/usr/bin/env bash
# Give this container's private pi agent dir local credential/model stores.
# A volume created during the short shared-state experiment still has dangling
# links to /shared-pi-state, which is no longer mounted. Pi follows those links
# and fails with ENOENT instead of creating the missing target.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <pi-agent-dir>" >&2
  exit 2
fi

agent_dir=$1
mkdir -p "$agent_dir"

# Remove only links this repository created, and only while they are dangling.
# Canonicalize the target so /shared-pi-state/./auth.json is recognized too. A
# live or unrelated link belongs to the user and must not be silently rewritten.
for name in auth.json models-store.json models.json; do
  file="$agent_dir/$name"
  if [ -L "$file" ] && [ ! -e "$file" ] \
    && [ "$(realpath -m -- "$file" 2>/dev/null || true)" = "/shared-pi-state/$name" ]; then
    rm -- "$file"
    echo "postCreate: removed dangling shared-state link $file" >&2
  fi
done

seed_store() {
  local name=$1
  local file="$agent_dir/$name"
  local tmp

  if [ -L "$file" ]; then
    if [ -e "$file" ]; then
      echo "postCreate: $file is a live symlink; leaving it unchanged" >&2
      return 0
    fi
    echo "postCreate: $file is an unexpected symlink to $(readlink -- "$file"); its target is missing" >&2
    return 1
  fi
  if [ -e "$file" ] && [ ! -f "$file" ]; then
    echo "postCreate: $file exists but is not a regular file" >&2
    return 1
  fi

  if [ ! -e "$file" ]; then
    # Publish a complete JSON object atomically. `mv -n` also avoids clobbering a
    # store another setup process created after the check above.
    tmp=$(mktemp "$agent_dir/.$name.XXXXXX")
    if ! printf '{}\n' > "$tmp" || ! chmod 600 "$tmp" || ! mv -n -- "$tmp" "$file"; then
      rm -f -- "$tmp"
      return 1
    fi
    # mv -n leaves the source in place when the destination won the race.
    rm -f -- "$tmp"
  fi

  # Existing credentials keep their contents, but never remain world-readable.
  chmod 600 "$file"
}

seed_store auth.json
seed_store models-store.json
