#!/usr/bin/env bash
# Self-test: validate the skills, then exercise install.sh and log.sh in a
# throwaway HOME. Never touches the real home directory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL="$REPO/scripts/install.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-skills-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

export HOME="$WORK/home"
export XDG_STATE_HOME="$WORK/state"
mkdir -p "$HOME"

passed=0
fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}
ok() {
	passed=$((passed + 1))
	printf 'ok %d - %s\n' "$passed" "$*"
}
quiet() { "$@" >/dev/null 2>&1; }

skill_count="$(find "$REPO/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
dest="$HOME/.agents/skills"

# --- validator --------------------------------------------------------------
python3 "$REPO/scripts/validate.py" >/dev/null || fail "validate.py reports problems"
ok "validate.py passes on the repository"

copy="$WORK/repo-copy"
mkdir -p "$copy"
(cd "$REPO" && tar --exclude=.git -cf - .) | (cd "$copy" && tar -xf -)
printf -- '---\nname: tdd\ndescription: "x"\nargument-hint: "y"\n---\nbody\n' >"$copy/skills/tdd/SKILL.md"
errors="$(python3 "$copy/scripts/validate.py" 2>&1)" && fail "validate.py accepted a broken skill"
printf '%s' "$errors" | grep -q "'argument-hint' is not portable" || fail "validate.py missed the non-portable key"
printf '%s' "$errors" | grep -q "needs 'Use when:' triggers" || fail "validate.py missed the missing triggers"
ok "validate.py rejects non-portable frontmatter and missing triggers"

(cd "$REPO" && tar --exclude=.git -cf - .) | (cd "$copy" && tar -xf -)
# shellcheck disable=SC2016 # the backticks are literal Markdown
printf '\nLoad the `implement` skill.\n' >>"$copy/skills/tdd/SKILL.md"
errors="$(python3 "$copy/scripts/validate.py" 2>&1)" && fail "validate.py accepted loading a user-invoked skill"
printf '%s' "$errors" | grep -q "loads user-invoked skill 'implement'" || fail "validate.py missed the user-invoked load"
ok "validate.py rejects a model-invoked skill loading a user-invoked one"

(cd "$REPO" && tar --exclude=.git -cf - .) | (cd "$copy" && tar -xf -)
# shellcheck disable=SC2016 # the backticks are literal Markdown
printf '\nThen run `handoff`.\n' >>"$copy/skills/tdd/SKILL.md"
errors="$(python3 "$copy/scripts/validate.py" 2>&1)" && fail "validate.py accepted a bare user-invoked name"
printf '%s' "$errors" | grep -q "refers to user-invoked skill as \`handoff\`" || fail "validate.py missed the bare name"
ok "validate.py rejects other wording that points a model-invoked skill at a user-invoked one"

# --- default install ---------------------------------------------------------
quiet "$INSTALL" || fail "default install failed"
[ "$(find "$dest" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" = "$skill_count" ] ||
	fail "expected $skill_count symlinks in $dest"
for link in "$dest"/*; do
	[ -f "$link/SKILL.md" ] || fail "$link does not resolve to a skill"
done
ok "default install links every skill into ~/.agents/skills"

out="$("$INSTALL")"
printf '%s\n' "$out" | grep -q 'linked' && fail "re-running install relinked skills"
ok "re-running install is a no-op"

# --- collisions --------------------------------------------------------------
rm "$dest/tdd"
mkdir "$dest/tdd"
printf 'mine\n' >"$dest/tdd/SKILL.md"
quiet "$INSTALL" && fail "install overwrote a foreign directory without --force"
[ "$(cat "$dest/tdd/SKILL.md")" = "mine" ] || fail "foreign directory was modified"
ok "install refuses to replace a foreign entry and exits non-zero"

quiet "$INSTALL" --force || fail "install --force failed"
[ -L "$dest/tdd" ] || fail "--force did not link tdd"
backup="$(find "$XDG_STATE_HOME/agent-skills/backups" -path '*/tdd/SKILL.md' | head -n 1)"
[ -n "$backup" ] && [ "$(cat "$backup")" = "mine" ] || fail "--force did not back up the foreign entry"
ok "install --force backs up the foreign entry before replacing it"

# --- selection, dry run, guards -------------------------------------------------
quiet "$INSTALL" --target "$WORK/picked" --skills tdd,handoff || fail "--skills install failed"
[ "$(find "$WORK/picked" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = "2" ] || fail "--skills installed the wrong set"
ok "--skills installs only the named skills"

quiet "$INSTALL" --skills nope && fail "--skills accepted an unknown skill"
ok "--skills rejects unknown skill names"

quiet "$INSTALL" --target "$WORK/dry" --dry-run --instructions "$WORK/dry.md" || fail "--dry-run failed"
[ ! -e "$WORK/dry" ] && [ ! -e "$WORK/dry.md" ] || fail "--dry-run changed the filesystem"
ok "--dry-run changes nothing"

quiet "$INSTALL" --target "$REPO/skills" && fail "install into the repository was allowed"
ln -s "$REPO" "$WORK/repo-link"
quiet "$INSTALL" --target "$WORK/repo-link/nested" && fail "install through a symlink into the repository was allowed"
[ ! -e "$REPO/nested" ] || fail "install wrote into the repository"
ok "install refuses destinations that resolve inside the repository"

# --- copy mode ---------------------------------------------------------------
quiet "$INSTALL" --copy --target "$WORK/copies" || fail "--copy install failed"
[ -d "$WORK/copies/tdd" ] && [ ! -L "$WORK/copies/tdd" ] || fail "--copy did not copy"
[ -x "$WORK/copies/show-me-your-work/scripts/log.sh" ] || fail "--copy lost the executable bit"
printf 'stale\n' >"$WORK/copies/tdd/stale.txt"
quiet "$INSTALL" --copy --target "$WORK/copies" || fail "--copy refresh failed"
[ ! -e "$WORK/copies/tdd/stale.txt" ] || fail "--copy refresh kept stale files"
ok "--copy installs real directories and refreshes them on re-run"

mkdir "$WORK/copies/someone-elses"
quiet "$INSTALL" --uninstall --target "$WORK/copies" || fail "--uninstall of copies failed"
[ "$(ls "$WORK/copies")" = "someone-elses" ] || fail "--uninstall left copies or removed a foreign entry"
ok "--uninstall removes copies and leaves foreign entries"

# --- instructions block ------------------------------------------------------
agents_md="$WORK/codex/AGENTS.md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$agents_md" || fail "--instructions on a new file failed"
grep -qxF '<!-- agent-skills:begin -->' "$agents_md" || fail "block not written to a new file"
ok "--instructions creates the file and writes the block"

printf '# Mine\n\nKeep this.\n' >"$agents_md"
cp "$agents_md" "$WORK/original.md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$agents_md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$agents_md"
[ "$(grep -cxF '<!-- agent-skills:begin -->' "$agents_md")" = "1" ] || fail "block duplicated on re-run"
head -n 3 "$agents_md" | cmp -s - "$WORK/original.md" || fail "existing content was not preserved"
grep -qF 'prove-it-works' "$agents_md" || fail "snippet content missing"
grep -qF 'Explaining permission requests' "$agents_md" || fail "permission explanation snippet missing"
grep -qF "Skill files: \`$WORK/t1/<name>/SKILL.md\`" "$agents_md" || fail "skill location line missing"
ok "--instructions is idempotent and preserves existing content"

quiet "$INSTALL" --uninstall --target "$WORK/t1" --instructions "$agents_md" || fail "--uninstall --instructions failed"
cmp -s "$agents_md" "$WORK/original.md" || fail "uninstall did not restore the original file"
ok "--uninstall --instructions restores the original file"

printf 'shared\n' >"$WORK/real.md"
ln -s "$WORK/real.md" "$WORK/linked.md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$WORK/linked.md"
if [ ! -L "$WORK/linked.md" ] || ! grep -qF 'agent-skills:end' "$WORK/real.md"; then
	fail "symlinked instruction file was replaced"
fi
ok "--instructions writes through a symlinked instruction file"

printf '<!-- agent-skills:begin -->\n' >"$WORK/broken.md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$WORK/broken.md" && fail "unbalanced markers were accepted"
ok "--instructions refuses unbalanced markers"

printf 'a\n<!-- agent-skills:end -->\nmine\n<!-- agent-skills:begin -->\nmore mine\n' >"$WORK/reversed.md"
cp "$WORK/reversed.md" "$WORK/reversed.orig"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$WORK/reversed.md" && fail "reversed markers were accepted"
quiet "$INSTALL" --uninstall --instructions "$WORK/reversed.md" && fail "reversed markers were accepted on uninstall"
cmp -s "$WORK/reversed.md" "$WORK/reversed.orig" || fail "a file with reversed markers was modified"
ok "--instructions refuses misordered markers and leaves the file untouched"

crlf="$WORK/crlf.md"
printf '# Mine\r\n' >"$crlf"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$crlf"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$crlf"
[ "$(grep -c 'agent-skills:begin' "$crlf")" = "1" ] || fail "CRLF file got a duplicated block"
[ "$(grep -c $'\r$' "$crlf")" = "$(wc -l <"$crlf" | tr -d ' ')" ] || fail "CRLF file got mixed line endings"
quiet "$INSTALL" --uninstall --instructions "$crlf"
[ "$(cat "$crlf")" = $'# Mine\r' ] || fail "uninstall did not restore the CRLF file"
ok "--instructions handles CRLF files without duplicating the block"

quiet "$INSTALL" || fail "reinstall before instructions-only uninstall failed"
printf 'x\n' >"$WORK/only.md"
quiet "$INSTALL" --target "$WORK/t1" --instructions "$WORK/only.md"
quiet "$INSTALL" --uninstall --instructions "$WORK/only.md" || fail "instructions-only uninstall failed"
[ "$(find "$dest" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" = "$skill_count" ] ||
	fail "instructions-only uninstall removed skills"
ok "--uninstall with only --instructions leaves installed skills alone"

# --- --instructions-only -----------------------------------------------------
pi_home="$WORK/pi-home"
mkdir -p "$pi_home"
quiet env HOME="$pi_home" "$INSTALL" --instructions-only "$WORK/pi-agents.md" --dry-run ||
	fail "--instructions-only --dry-run failed"
[ ! -e "$WORK/pi-agents.md" ] && [ ! -e "$pi_home/.agents" ] ||
	fail "--instructions-only --dry-run modified the filesystem"

printf '# Pi\n' >"$WORK/pi-agents.md"
quiet env HOME="$pi_home" "$INSTALL" --instructions-only "$WORK/pi-agents.md" ||
	fail "--instructions-only install failed"
grep -qxF '<!-- agent-skills:begin -->' "$WORK/pi-agents.md" ||
	fail "--instructions-only did not write managed block"
! grep -qF 'Skill files:' "$WORK/pi-agents.md" ||
	fail "--instructions-only should not write Skill files: line"
[ ! -e "$pi_home/.agents/skills" ] ||
	fail "--instructions-only created ~/.agents/skills"

quiet env HOME="$pi_home" "$INSTALL" --uninstall --instructions-only "$WORK/pi-agents.md" ||
	fail "--uninstall --instructions-only failed"
[ "$(cat "$WORK/pi-agents.md")" = "# Pi" ] ||
	fail "--uninstall --instructions-only did not remove managed block cleanly"
[ ! -e "$pi_home/.agents/skills" ] ||
	fail "--uninstall --instructions-only created ~/.agents/skills"
ok "--instructions-only writes and uninstalls the block without creating ~/.agents/skills"

ln -s "$REPO/skills/renamed-away" "$dest/renamed-away"
quiet "$INSTALL" || fail "install with a stale link failed"
[ ! -L "$dest/renamed-away" ] || fail "stale link to a removed skill was kept"
ok "install prunes links to skills that no longer exist"

ln -s "$WORK/nowhere" "$WORK/dangling-dest"
quiet "$INSTALL" --target "$WORK/dangling-dest" && fail "a dangling destination symlink was accepted"
[ ! -e "$WORK/nowhere" ] || fail "install followed a dangling destination"
ok "install refuses a dangling destination symlink"

# --- uninstall ---------------------------------------------------------------
mkdir "$dest/other-skill"
quiet "$INSTALL" --uninstall || fail "--uninstall failed"
[ "$(ls "$dest")" = "other-skill" ] || fail "--uninstall left links or removed a foreign entry"
ok "--uninstall removes only this repository's links"

# --- show-me-your-work log helper ----------------------------------------------
log="$WORK/log/decisions.tsv"
"$REPO/skills/show-me-your-work/scripts/log.sh" "$log" build "=SUM(A1)" "tab	inside" "commit abc" "tests green"
[ "$(head -n 1 "$log")" = "$(cat "$REPO/skills/show-me-your-work/assets/decision-log-template.tsv")" ] ||
	fail "log header does not match the template"
row="$(sed -n 2p "$log")"
[ "$(printf '%s' "$row" | awk -F '\t' '{print NF}')" = "6" ] || fail "log row does not have 6 cells"
printf '%s' "$row" | cut -f 3 | grep -qxF "'=SUM(A1)" || fail "formula cell not neutralised"
ok "log.sh writes a header and a sanitised 6-cell row"

printf '\nall %d tests passed\n' "$passed"
