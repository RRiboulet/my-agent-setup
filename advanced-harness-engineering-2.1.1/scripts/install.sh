#!/usr/bin/env bash
# Install the skills in this repository into one or more agent-harness skill
# directories, and optionally add the routing snippet to instruction files.
# Run with --help for usage. Works with bash 3.2+ (macOS) and GNU or BSD tools.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILLS_SRC="$REPO/skills"
EXTS_SRC="$REPO/extensions"
AGENTS_SRC="$REPO/agents"
HOOKS_SRC="$REPO/hooks"
GUARD_SRC="$REPO/orchestrator_guard"
SNIPPET="$REPO/instructions/AGENTS.md"
COPY_MARKER=".agent-skills-install"
BEGIN_MARK="<!-- agent-skills:begin -->"
END_MARK="<!-- agent-skills:end -->"
# Marker comparison ignores surrounding whitespace and a CR, so CRLF files are recognised.
AWK_NORM='function norm(s) { sub(/\r$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
'


usage() {
	cat <<EOF
Install advanced-harness-engineering skills, extensions, agents, hooks, and instructions.
For the pi coding agent, use: pi install <repo-or-path>

Usage: scripts/install.sh [destinations] [options]

Destinations (combine freely; default: --user):
  --user                  ~/.agents/skills  (Codex, pi, GitHub Copilot, OpenCode, Cursor, Gemini CLI)
  --claude                ~/.claude/skills  (Claude Code)
  --project DIR           DIR/.agents/skills (one repository, shared with its team)
  --target DIR            any skills directory, e.g. ~/.copilot/skills or a harness not listed here
  --copilot               ~/.copilot skills, extensions, agents, and copilot-instructions.md
  --copilot-skills        ~/.copilot/skills (or \$COPILOT_HOME/skills; Copilot CLI only)
  --copilot-extensions    ~/.copilot/extensions (or \$COPILOT_HOME/extensions; Copilot CLI only)
  --extensions-target DIR any Copilot CLI extensions directory
  --copilot-agents        ~/.copilot/agents (or \$COPILOT_HOME/agents; Copilot CLI only)
  --agents-target DIR     any Copilot CLI agents directory
  --copilot-hooks DIR     DIR/.github (installs Copilot CLI hooks and orchestrator_guard)

Options:
  --skills a,b,c        install only these skills (default: all)
  --copy                copy instead of symlink (for setups without symlinks; re-run to update)
  --force               replace entries this repo did not install (they are backed up first)
  --instructions FILE   add or refresh the routing snippet in FILE (e.g. ~/.codex/AGENTS.md);
                        repeatable; with --uninstall, remove it
  --instructions-only FILE
                        like --instructions FILE, without defaulting to ~/.agents/skills
  --uninstall           remove only what this repo installed (with only --instructions,
                        just remove the snippet; add a destination to remove skills too)
  --dry-run             print what would happen, change nothing
  -h, --help            show this help

Symlinks point into $REPO, so 'git pull' updates every harness at once.
EOF
}

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}
warn() { printf 'warning: %s\n' "$*" >&2; }
say() { printf '%s\n' "$*"; }
run() {
	if [ "$dry" -eq 1 ]; then
		printf '[dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

absolute() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$PWD" "$1" ;;
	esac
}

# Physical path of $1, resolving symlinks in the deepest existing ancestor.
physical() {
	local p="$1" rest=""
	while [ ! -d "$p" ]; do
		rest="/$(basename "$p")$rest"
		p="$(dirname "$p")"
	done
	printf '%s%s\n' "$(cd "$p" && pwd -P)" "$rest"
}

dests=()
ext_dests=()
agent_dests=()
hook_dests=()
instructions=()
instructions_only=0
selected=""
mode="link"
force=0
dry=0
uninstall=0

while [ "$#" -gt 0 ]; do
	case "$1" in
		--user) dests+=("$HOME/.agents/skills") ;;
		--claude) dests+=("$HOME/.claude/skills") ;;
		--copilot-skills) dests+=("${COPILOT_HOME:-$HOME/.copilot}/skills") ;;
		--copilot-extensions) ext_dests+=("${COPILOT_HOME:-$HOME/.copilot}/extensions") ;;
		--copilot-agents) agent_dests+=("${COPILOT_HOME:-$HOME/.copilot}/agents") ;;
		--copilot)
			dests+=("${COPILOT_HOME:-$HOME/.copilot}/skills")
			ext_dests+=("${COPILOT_HOME:-$HOME/.copilot}/extensions")
			agent_dests+=("${COPILOT_HOME:-$HOME/.copilot}/agents")
			instructions+=("${COPILOT_HOME:-$HOME/.copilot}/copilot-instructions.md")
			;;
		--project | --target | --extensions-target | --agents-target | --copilot-hooks | --skills | --instructions | --instructions-only)
			[ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
			case "$1" in
				--project) dests+=("$(absolute "$2")/.agents/skills") ;;
				--target) dests+=("$(absolute "$2")") ;;
				--extensions-target) ext_dests+=("$(absolute "$2")") ;;
				--agents-target) agent_dests+=("$(absolute "$2")") ;;
				--copilot-hooks) hook_dests+=("$(absolute "$2")/.github") ;;
				--skills) selected="$2" ;;
				--instructions) instructions+=("$(absolute "$2")") ;;
				--instructions-only)
					instructions+=("$(absolute "$2")")
					instructions_only=1
					;;
			esac
			shift
			;;
		--copy) mode="copy" ;;
		--force) force=1 ;;
		--dry-run) dry=1 ;;
		--uninstall) uninstall=1 ;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			usage >&2
			die "unknown option: $1"
			;;
	esac
	shift
done

# Default destination, except when extensions/agents/hooks are targeted, "--instructions-only FILE" is used, or "--uninstall --instructions FILE".
if [ "${#dests[@]}" -eq 0 ] && [ "${#ext_dests[@]}" -eq 0 ] && [ "${#agent_dests[@]}" -eq 0 ] && [ "${#hook_dests[@]}" -eq 0 ] && [ "$instructions_only" -eq 0 ] && { [ "$uninstall" -eq 0 ] || [ "${#instructions[@]}" -eq 0 ]; }; then
	dests=("$HOME/.agents/skills")
fi

all_skills=()
for dir in "$SKILLS_SRC"/*/; do
	if [ -f "$dir/SKILL.md" ]; then all_skills+=("$(basename "$dir")"); fi
done
[ "${#all_skills[@]}" -gt 0 ] || die "no skills found in $SKILLS_SRC"

skills=()
if [ -n "$selected" ]; then
	IFS=',' read -r -a requested <<<"$selected"
	for name in ${requested[@]+"${requested[@]}"}; do
		[ -n "$name" ] || continue
		[ -f "$SKILLS_SRC/$name/SKILL.md" ] || die "unknown skill: $name (available: ${all_skills[*]})"
		skills+=("$name")
	done
	[ "${#skills[@]}" -gt 0 ] || die "--skills selected nothing"
else
	skills=("${all_skills[@]}")
fi

is_our_link() {
	[ -L "$1" ] || return 1
	case "$(readlink "$1")" in
		"$SKILLS_SRC"/* | "$EXTS_SRC"/* | "$AGENTS_SRC"/* | "$HOOKS_SRC"/* | "$GUARD_SRC") return 0 ;;
		*) return 1 ;;
	esac
}

is_our_ext_link() {
	[ -L "$1" ] || return 1
	case "$(readlink "$1")" in
		"$EXTS_SRC"/*) return 0 ;;
		*) return 1 ;;
	esac
}

is_our_agent_link() {
	[ -L "$1" ] || return 1
	case "$(readlink "$1")" in
		"$AGENTS_SRC"/*) return 0 ;;
		*) return 1 ;;
	esac
}

is_our_hook_link() {
	[ -L "$1" ] || return 1
	case "$(readlink "$1")" in
		"$HOOKS_SRC"/*) return 0 ;;
		*) return 1 ;;
	esac
}

all_extensions=()
if [ -d "$EXTS_SRC" ]; then
	for dir in "$EXTS_SRC"/*/; do
		if [ -f "$dir/extension.mjs" ] || [ -f "$dir/extension.cjs" ] || [ -f "$dir/extension.js" ]; then
			all_extensions+=("$(basename "$dir")")
		fi
	done
fi

all_agents=()
if [ -d "$AGENTS_SRC" ]; then
	for f in "$AGENTS_SRC"/*.agent.md; do
		[ -f "$f" ] || continue
		all_agents+=("$(basename "$f")")
	done
fi

all_hooks=()
if [ -d "$HOOKS_SRC" ]; then
	for f in "$HOOKS_SRC"/*.json; do
		[ -f "$f" ] || continue
		all_hooks+=("$(basename "$f")")
	done
fi

is_known_extension() {
	local known
	for known in ${all_extensions[@]+"${all_extensions[@]}"}; do
		[ "$known" = "$1" ] && return 0
	done
	return 1
}

is_known_agent() {
	local known
	for known in ${all_agents[@]+"${all_agents[@]}"}; do
		[ "$known" = "$1" ] && return 0
	done
	return 1
}

is_known_hook() {
	local known
	for known in ${all_hooks[@]+"${all_hooks[@]}"}; do
		[ "$known" = "$1" ] && return 0
	done
	return 1
}

install_entry() {
	local src_root="$1" dest_dir="$2" name="$3"
	local target="$dest_dir/$name" src="$src_root/$name"
	if [ "$mode" = "link" ] && is_our_link "$target" && [ "$(readlink "$target")" = "$src" ]; then
		say "  unchanged $name"
		return 0
	fi
	if [ -e "$target" ] || [ -L "$target" ]; then
		if is_our_link "$target" || is_our_copy "$target"; then
			run rm -rf "$target"
		elif [ "$force" -eq 1 ]; then
			backup "$target"
		else
			warn "skipped $target: it exists and was not installed from this repo (use --force to back it up and replace it)"
			failures=$((failures + 1))
			return 0
		fi
	fi
	if [ "$mode" = "link" ]; then
		run ln -s "$src" "$target"
		say "  linked $name"
	else
		run cp -R "$src" "$target"
		if [ "$src" = "$GUARD_SRC" ]; then
			run find "$target" -type d -name '__pycache__' -prune -exec rm -rf {} +
			run find "$target" -type f -name '*.pyc' -exec rm -f {} +
		fi
		if [ "$dry" -eq 1 ]; then
			printf '[dry-run] write %s\n' "$target/$COPY_MARKER"
		else
			printf '%s\n' "$REPO" >"$target/$COPY_MARKER"
		fi
		say "  copied $name"
	fi
}

file_hash() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{sub(/^\\/, "", $1); print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif command -v python3 >/dev/null 2>&1; then
		python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"
	else
		die "cannot compute sha256: need sha256sum, shasum, or python3"
	fi
}

file_copies_db() {
	printf '%s/agent-skills/file-copies.tsv\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

file_copy_key() {
	local pdir base
	pdir="$(physical "$(dirname "$1")")"
	base="$(basename "$1")"
	if [ "$pdir" = "/" ]; then
		printf '/%s\n' "$base"
	else
		printf '%s/%s\n' "$pdir" "$base"
	fi
}

record_file_copy() {
	local target="$1" key hash db tmp
	key="$(file_copy_key "$target")"
	hash="$(file_hash "$target")"
	db="$(file_copies_db)"
	mkdir -p "$(dirname "$db")"
	tmp="$(mktemp "${db}.XXXXXX")"
	if [ -f "$db" ]; then
		KEY="$key" awk -F '\t' '$1 != ENVIRON["KEY"]' "$db" >"$tmp"
	fi
	printf '%s\t%s\t%s\n' "$key" "$REPO" "$hash" >>"$tmp"
	mv -f "$tmp" "$db"
}

remove_file_copy_record() {
	local target="$1" key db tmp
	db="$(file_copies_db)"
	[ -f "$db" ] || return 0
	key="$(file_copy_key "$target")"
	tmp="$(mktemp "${db}.XXXXXX")"
	KEY="$key" awk -F '\t' '$1 != ENVIRON["KEY"]' "$db" >"$tmp"
	mv -f "$tmp" "$db"
}

file_copy_recorded_hash() {
	local target="$1" key db
	db="$(file_copies_db)"
	[ -f "$db" ] || return 1
	key="$(file_copy_key "$target")"
	KEY="$key" REPO_PATH="$REPO" awk -F '\t' '
		$1 == ENVIRON["KEY"] { found = 1; r = $2; h = $3 }
		END {
			if (!found || r != ENVIRON["REPO_PATH"] || h == "") exit 1
			print h
		}
	' "$db"
}

has_conflicting_file_copy_record() {
	local target="$1" key db
	db="$(file_copies_db)"
	[ -f "$db" ] || return 1
	key="$(file_copy_key "$target")"
	KEY="$key" REPO_PATH="$REPO" awk -F '\t' '
		$1 == ENVIRON["KEY"] { found = 1; r = $2 }
		END { exit (found && r != ENVIRON["REPO_PATH"]) ? 0 : 1 }
	' "$db"
}

is_our_unmodified_file_copy() {
	local target="$1" rec_hash cur_hash
	[ -f "$target" ] && [ ! -L "$target" ] || return 1
	rec_hash="$(file_copy_recorded_hash "$target")" || return 1
	cur_hash="$(file_hash "$target")"
	[ "$cur_hash" = "$rec_hash" ]
}

install_file_entry() {
	local src_root="$1" dest_dir="$2" name="$3"
	local target="$dest_dir/$name" src="$src_root/$name"
	if [ "$mode" = "link" ] && is_our_link "$target" && [ "$(readlink "$target")" = "$src" ]; then
		say "  unchanged $name"
		return 0
	fi
	if [ "$mode" = "copy" ] && [ -f "$target" ] && [ ! -L "$target" ]; then
		if ! has_conflicting_file_copy_record "$target" && cmp -s "$target" "$src"; then
			if [ "$dry" -eq 0 ] && ! is_our_unmodified_file_copy "$target"; then
				record_file_copy "$target"
			fi
			say "  unchanged $name"
			return 0
		elif is_our_unmodified_file_copy "$target"; then
			run cp "$src" "$target"
			[ "$dry" -eq 0 ] && record_file_copy "$target"
			say "  updated $name"
			return 0
		fi
	fi
	if [ -e "$target" ] || [ -L "$target" ]; then
		if is_our_link "$target"; then
			run rm -f "$target"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		elif [ "$mode" = "link" ] && is_our_unmodified_file_copy "$target"; then
			run rm -f "$target"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		elif [ "$mode" = "link" ] && [ -f "$target" ] && [ ! -L "$target" ] && ! has_conflicting_file_copy_record "$target" && cmp -s "$target" "$src"; then
			run rm -f "$target"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		elif [ "$force" -eq 1 ]; then
			backup "$target"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		else
			warn "skipped $target: it exists and was not installed from this repo (use --force to back it up and replace it)"
			failures=$((failures + 1))
			return 0
		fi
	fi
	if [ "$mode" = "link" ]; then
		run ln -s "$src" "$target"
		say "  linked $name"
	else
		run cp "$src" "$target"
		[ "$dry" -eq 0 ] && record_file_copy "$target"
		say "  copied $name"
	fi
}

uninstall_file_entry() {
	local src="$1/$3" target="$2/$3"
	if is_our_link "$target"; then
		run rm -f "$target"
		[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		say "  removed $3"
	elif is_our_unmodified_file_copy "$target"; then
		run rm -f "$target"
		[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		say "  removed $3"
	elif [ -f "$target" ] && [ ! -L "$target" ] && [ -f "$src" ] && ! has_conflicting_file_copy_record "$target" && cmp -s "$target" "$src"; then
		run rm -f "$target"
		[ "$dry" -eq 0 ] && remove_file_copy_record "$target"
		say "  removed $3"
	elif [ -e "$target" ] || [ -L "$target" ]; then
		say "  left $3 (not installed from this repo)"
	fi
}

prune_stale_extensions() {
	local entry
	for entry in "$1"/*; do
		[ -e "$entry" ] || [ -L "$entry" ] || continue
		is_known_extension "$(basename "$entry")" && continue
		if is_our_ext_link "$entry" || is_our_copy "$entry"; then
			run rm -rf "$entry"
			say "  removed stale $(basename "$entry")"
		fi
	done
}

prune_stale_agents() {
	local entry
	for entry in "$1"/*; do
		[ -e "$entry" ] || [ -L "$entry" ] || continue
		is_known_agent "$(basename "$entry")" && continue
		if is_our_agent_link "$entry" || is_our_unmodified_file_copy "$entry"; then
			run rm -f "$entry"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$entry"
			say "  removed stale $(basename "$entry")"
		fi
	done
}

prune_stale_hooks() {
	local entry
	for entry in "$1"/*; do
		[ -e "$entry" ] || [ -L "$entry" ] || continue
		is_known_hook "$(basename "$entry")" && continue
		if is_our_hook_link "$entry" || is_our_unmodified_file_copy "$entry"; then
			run rm -f "$entry"
			[ "$dry" -eq 0 ] && remove_file_copy_record "$entry"
			say "  removed stale $(basename "$entry")"
		fi
	done
}

is_our_copy() {
	[ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$COPY_MARKER" ] &&
		[ "$(cat "$1/$COPY_MARKER")" = "$REPO" ]
}

backup_root="${XDG_STATE_HOME:-$HOME/.local/state}/agent-skills/backups/$(date +%Y%m%d-%H%M%S)"

backup() {
	local target="$1" slot
	slot="$backup_root/$(printf '%s' "$(dirname "$target")" | tr '/' '_')"
	run mkdir -p "$slot"
	run mv "$target" "$slot/"
	say "  backed up $target -> $slot/$(basename "$target")"
}

failures=0

install_skill() {
	install_entry "$SKILLS_SRC" "$1" "$2"
}

uninstall_skill() {
	local target="$1/$2"
	if is_our_link "$target" || is_our_copy "$target"; then
		run rm -rf "$target"
		say "  removed $2"
	elif [ -e "$target" ] || [ -L "$target" ]; then
		say "  left $2 (not installed from this repo)"
	fi
}

is_known_skill() {
	local known
	for known in "${all_skills[@]}"; do
		[ "$known" = "$1" ] && return 0
	done
	return 1
}

# Remove links and copies this repo made for skills that no longer exist in it.
prune_stale() {
	local entry
	for entry in "$1"/*; do
		[ -e "$entry" ] || [ -L "$entry" ] || continue
		is_known_skill "$(basename "$entry")" && continue
		if is_our_link "$entry" || is_our_copy "$entry"; then
			run rm -rf "$entry"
			say "  removed stale $(basename "$entry")"
		fi
	done
}

for dest in ${dests[@]+"${dests[@]}"}; do
	if [ -L "$dest" ] && [ ! -e "$dest" ]; then
		die "$dest is a dangling symlink; remove or fix it and re-run"
	fi
	case "$(physical "$dest")" in
		"$REPO" | "$REPO"/*) die "$dest resolves inside this repository; choose a directory outside $REPO" ;;
	esac
	if [ "$uninstall" -eq 1 ]; then
		say "Uninstalling from $dest"
		[ -d "$dest" ] || {
			say "  nothing to do"
			continue
		}
		for name in "${skills[@]}"; do uninstall_skill "$dest" "$name"; done
		prune_stale "$dest"
	else
		say "Installing to $dest ($mode)"
		[ -d "$dest" ] || run mkdir -p "$dest"
		for name in "${skills[@]}"; do install_skill "$dest" "$name"; done
		prune_stale "$dest"
	fi
done

for dest in ${ext_dests[@]+"${ext_dests[@]}"}; do
	if [ -L "$dest" ] && [ ! -e "$dest" ]; then
		die "$dest is a dangling symlink; remove or fix it and re-run"
	fi
	case "$(physical "$dest")" in
		"$REPO" | "$REPO"/*) die "$dest resolves inside this repository; choose a directory outside $REPO" ;;
	esac
	if [ "$uninstall" -eq 1 ]; then
		say "Uninstalling extensions from $dest"
		[ -d "$dest" ] || {
			say "  nothing to do"
			continue
		}
		for name in ${all_extensions[@]+"${all_extensions[@]}"}; do uninstall_skill "$dest" "$name"; done
		prune_stale_extensions "$dest"
	else
		[ "${#all_extensions[@]}" -gt 0 ] || die "no extensions found in $EXTS_SRC"
		say "Installing extensions to $dest ($mode)"
		[ -d "$dest" ] || run mkdir -p "$dest"
		for name in "${all_extensions[@]}"; do install_entry "$EXTS_SRC" "$dest" "$name"; done
		prune_stale_extensions "$dest"
	fi
done

for dest in ${agent_dests[@]+"${agent_dests[@]}"}; do
	if [ -L "$dest" ] && [ ! -e "$dest" ]; then
		die "$dest is a dangling symlink; remove or fix it and re-run"
	fi
	case "$(physical "$dest")" in
		"$REPO" | "$REPO"/*) die "$dest resolves inside this repository; choose a directory outside $REPO" ;;
	esac
	if [ "$uninstall" -eq 1 ]; then
		say "Uninstalling agents from $dest"
		[ -d "$dest" ] || {
			say "  nothing to do"
			continue
		}
		for name in ${all_agents[@]+"${all_agents[@]}"}; do uninstall_file_entry "$AGENTS_SRC" "$dest" "$name"; done
		prune_stale_agents "$dest"
	else
		[ "${#all_agents[@]}" -gt 0 ] || die "no agents found in $AGENTS_SRC"
		say "Installing agents to $dest ($mode)"
		[ -d "$dest" ] || run mkdir -p "$dest"
		for name in "${all_agents[@]}"; do install_file_entry "$AGENTS_SRC" "$dest" "$name"; done
		prune_stale_agents "$dest"
	fi
done

for dest in ${hook_dests[@]+"${hook_dests[@]}"}; do
	if [ -L "$dest" ] && [ ! -e "$dest" ]; then
		die "$dest is a dangling symlink; remove or fix it and re-run"
	fi
	case "$(physical "$dest")" in
		"$REPO" | "$REPO"/*) die "$dest resolves inside this repository; choose a directory outside $REPO" ;;
	esac
	hooks_dir="$dest/hooks"
	if [ -L "$hooks_dir" ] && [ ! -e "$hooks_dir" ]; then
		die "$hooks_dir is a dangling symlink; remove or fix it and re-run"
	fi
	case "$(physical "$hooks_dir")" in
		"$REPO" | "$REPO"/*) die "$hooks_dir resolves inside this repository; choose a directory outside $REPO" ;;
	esac
	if [ "$uninstall" -eq 1 ]; then
		say "Uninstalling hooks from $dest"
		if [ -d "$hooks_dir" ]; then
			for name in ${all_hooks[@]+"${all_hooks[@]}"}; do uninstall_file_entry "$HOOKS_SRC" "$hooks_dir" "$name"; done
			prune_stale_hooks "$hooks_dir"
		else
			say "  nothing to do in $hooks_dir"
		fi
		if [ -d "$dest" ]; then
			uninstall_skill "$dest" "orchestrator_guard"
		else
			say "  nothing to do in $dest"
		fi
	else
		[ "${#all_hooks[@]}" -gt 0 ] || die "no hooks found in $HOOKS_SRC"
		[ -d "$GUARD_SRC" ] || die "orchestrator_guard directory not found in $REPO"
		say "Installing hooks to $dest ($mode)"
		[ -d "$hooks_dir" ] || run mkdir -p "$hooks_dir"
		for name in "${all_hooks[@]}"; do install_file_entry "$HOOKS_SRC" "$hooks_dir" "$name"; done
		prune_stale_hooks "$hooks_dir"
		install_entry "$REPO" "$dest" "orchestrator_guard"
	fi
done

# Rewrite FILE with the snippet block added or refreshed in place, or removed.
# Writes through any symlink and keeps the file's permissions.
update_instructions() {
	local file="$1" state tmp
	if [ ! -e "$file" ]; then
		if [ "$uninstall" -eq 1 ]; then
			say "Instructions: $file does not exist, nothing to remove"
			return 0
		fi
		run mkdir -p "$(dirname "$file")"
		[ "$dry" -eq 1 ] || : >"$file"
	fi
	[ -f "$file" ] || [ "$dry" -eq 1 ] || die "$file is not a regular file"
	state="none"
	if [ -f "$file" ]; then
		state="$(awk -v b="$BEGIN_MARK" -v e="$END_MARK" "$AWK_NORM"'
			{ l = norm($0) }
			l == b { if (seen || open) bad = 1; open = 1; seen = 1; next }
			l == e { if (!open) bad = 1; open = 0 }
			END { print (bad || open) ? "bad" : (seen ? "one" : "none") }' "$file")"
	fi
	[ "$state" != "bad" ] || die "$file has misordered, unbalanced, or repeated agent-skills markers; fix them by hand"
	if [ "$dry" -eq 1 ]; then
		if [ "$uninstall" -eq 1 ]; then
			say "[dry-run] remove the agent-skills block from $file"
		else
			say "[dry-run] add or refresh the agent-skills block in $file"
		fi
		return 0
	fi
	tmp="$(mktemp "${TMPDIR:-/tmp}/agent-skills.XXXXXX")"
	if [ "$uninstall" -eq 1 ]; then
		awk -v b="$BEGIN_MARK" -v e="$END_MARK" "$AWK_NORM"'
			{ l = norm($0) }
			l == b { skip = 1; next }
			skip && l == e { skip = 0; next }
			skip { next }
			{ lines[++n] = $0 }
			END {
				while (n > 0 && norm(lines[n]) == "") n--
				for (i = 1; i <= n; i++) print lines[i]
			}' "$file" >"$tmp"
		say "Instructions: removed the agent-skills block from $file"
	else
		# Match the file's line endings so a CRLF file stays CRLF.
		awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v snippet="$SNIPPET" -v loc="$skills_location" "$AWK_NORM"'
			NR == 1 && /\r$/ { eol = "\r" }
			function emit(   i) {
				print b eol
				for (i = 1; i <= m; i++) print block[i] eol
				if (loc != "") {
					print "" eol
					print "Skill files: `" loc "/<name>/SKILL.md`." eol
				}
				print e eol
			}
			BEGIN { while ((getline line < snippet) > 0) block[++m] = line }
			{ l = norm($0) }
			l == b { emit(); skip = 1; done = 1; next }
			skip && l == e { skip = 0; next }
			skip { next }
			{ print; last = l; n++ }
			END {
				if (!done) {
					if (n > 0 && last != "") print "" eol
					emit()
				}
			}' "$file" >"$tmp"
		say "Instructions: added or refreshed the agent-skills block in $file"
	fi
	cat "$tmp" >"$file"
	rm -f "$tmp"
}

skills_location=""
if [ "${#instructions[@]}" -gt 0 ]; then
	# Name the first destination in the block so harnesses without native skill discovery can find the files.
	[ "${#dests[@]}" -eq 0 ] || skills_location="${dests[0]}"
	if [ -z "$skills_location" ] && [ "$instructions_only" -eq 0 ]; then
		skills_location="$HOME/.agents/skills"
	fi
	case "$skills_location" in
		"$HOME"/*) skills_location="~${skills_location#"$HOME"}" ;;
	esac
	for file in "${instructions[@]}"; do update_instructions "$file"; done
fi

if [ "$failures" -gt 0 ]; then
	die "$failures skill(s) were skipped because of existing entries; see the warnings above"
fi
