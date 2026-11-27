#!/usr/bin/env bash
# Install the skills in this repository into one or more agent-harness skill
# directories, and optionally add the routing snippet to instruction files.
# Run with --help for usage. Works with bash 3.2+ (macOS) and GNU or BSD tools.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILLS_SRC="$REPO/skills"
SNIPPET="$REPO/instructions/AGENTS.md"
COPY_MARKER=".agent-skills-install"
BEGIN_MARK="<!-- agent-skills:begin -->"
END_MARK="<!-- agent-skills:end -->"
# Marker comparison ignores surrounding whitespace and a CR, so CRLF files are recognised.
AWK_NORM='function norm(s) { sub(/\r$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
'


usage() {
	cat <<EOF
Install my-agent-setup skills and instructions.
For the pi coding agent, use: pi install <repo-or-path>

Usage: scripts/install.sh [destinations] [options]

Destinations (combine freely; default: --user):
  --user                  ~/.agents/skills  (Codex, pi, OpenCode, Cursor, Gemini CLI)
  --claude                ~/.claude/skills  (Claude Code)
  --project DIR           DIR/.agents/skills (one repository, shared with its team)
  --target DIR            any skills directory, or a harness not listed here

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
		--project | --target | --skills | --instructions | --instructions-only)
			[ "$#" -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
			case "$1" in
				--project) dests+=("$(absolute "$2")/.agents/skills") ;;
				--target) dests+=("$(absolute "$2")") ;;
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

# Default destination, except when "--instructions-only FILE" is used, or "--uninstall --instructions FILE".
if [ "${#dests[@]}" -eq 0 ] && [ "$instructions_only" -eq 0 ] && { [ "$uninstall" -eq 0 ] || [ "${#instructions[@]}" -eq 0 ]; }; then
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
		"$SKILLS_SRC"/*) return 0 ;;
		*) return 1 ;;
	esac
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
		if [ "$dry" -eq 1 ]; then
			printf '[dry-run] write %s\n' "$target/$COPY_MARKER"
		else
			printf '%s\n' "$REPO" >"$target/$COPY_MARKER"
		fi
		say "  copied $name"
	fi
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
