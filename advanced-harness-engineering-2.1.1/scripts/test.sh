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

# --- copilot skills and --copilot meta-flag ---------------------------------
copilot_home="$WORK/copilot-home"
mkdir -p "$copilot_home"
quiet env COPILOT_HOME="$copilot_home" "$INSTALL" --copilot-skills || fail "--copilot-skills install failed"
[ "$(find "$copilot_home/skills" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" = "$skill_count" ] ||
	fail "--copilot-skills did not link $skill_count skills into \$COPILOT_HOME/skills"
for link in "$copilot_home/skills"/*; do
	[ -f "$link/SKILL.md" ] || fail "$link does not resolve to a skill"
done
mkdir "$copilot_home/skills/foreign-skill"
quiet env COPILOT_HOME="$copilot_home" "$INSTALL" --copilot-skills --uninstall || fail "--copilot-skills --uninstall failed"
[ "$(ls "$copilot_home/skills")" = "foreign-skill" ] ||
	fail "--copilot-skills --uninstall left links or removed foreign skill"
ok "--copilot-skills installs and uninstalls via COPILOT_HOME"

copilot_meta="$WORK/copilot-meta"
quiet env COPILOT_HOME="$copilot_meta" "$INSTALL" --copilot || fail "--copilot install failed"
[ "$(find "$copilot_meta/skills" -mindepth 1 -maxdepth 1 -type l | wc -l | tr -d ' ')" = "$skill_count" ] ||
	fail "--copilot did not link all skills"
[ -L "$copilot_meta/extensions/tickets" ] && [ -f "$copilot_meta/extensions/tickets/extension.mjs" ] ||
	fail "--copilot did not link tickets extension"
[ -L "$copilot_meta/extensions/jira" ] && [ -f "$copilot_meta/extensions/jira/extension.mjs" ] ||
	fail "--copilot did not link jira extension"
[ -L "$copilot_meta/agents/orchestrator.agent.md" ] && [ -f "$copilot_meta/agents/orchestrator.agent.md" ] ||
	fail "--copilot did not link orchestrator.agent.md"
grep -qxF '<!-- agent-skills:begin -->' "$copilot_meta/copilot-instructions.md" ||
	fail "--copilot did not write copilot-instructions.md"
grep -qF "Skill files: \`$copilot_meta/skills/<name>/SKILL.md\`." "$copilot_meta/copilot-instructions.md" ||
	fail "--copilot did not record \$COPILOT_HOME/skills in copilot-instructions.md"
meta_out="$(COPILOT_HOME="$copilot_meta" "$INSTALL" --copilot)"
printf '%s\n' "$meta_out" | grep -q 'linked' && fail "re-running --copilot relinked entries"
[ "$(grep -cxF '<!-- agent-skills:begin -->' "$copilot_meta/copilot-instructions.md")" = "1" ] ||
	fail "re-running --copilot duplicated instructions block"
mkdir "$copilot_meta/skills/keep-skill" "$copilot_meta/extensions/keep-ext"
printf 'custom\n' >"$copilot_meta/agents/keep.agent.md"
quiet env COPILOT_HOME="$copilot_meta" "$INSTALL" --copilot --uninstall || fail "--copilot --uninstall failed"
[ "$(ls "$copilot_meta/skills")" = "keep-skill" ] ||
	fail "--copilot --uninstall left skills or removed foreign skill"
[ "$(ls "$copilot_meta/extensions")" = "keep-ext" ] ||
	fail "--copilot --uninstall left extensions or removed foreign extension"
[ "$(ls "$copilot_meta/agents")" = "keep.agent.md" ] ||
	fail "--copilot --uninstall left agents or removed foreign agent"
! grep -qF 'agent-skills:begin' "$copilot_meta/copilot-instructions.md" ||
	fail "--copilot --uninstall left agent-skills block in copilot-instructions.md"
ok "--copilot installs, refreshes idempotently, and uninstalls cleanly"

# --- copilot extensions ------------------------------------------------------
ext_dest="$HOME/.copilot/extensions"
quiet "$INSTALL" --copilot-extensions || fail "--copilot-extensions install failed"
[ -L "$ext_dest/tickets" ] && [ -f "$ext_dest/tickets/extension.mjs" ] ||
	fail "--copilot-extensions did not link tickets extension"
[ -L "$ext_dest/jira" ] && [ -f "$ext_dest/jira/extension.mjs" ] ||
	fail "--copilot-extensions did not link jira extension"
ok "--copilot-extensions links tickets and jira into ~/.copilot/extensions"

ext_out="$("$INSTALL" --copilot-extensions)"
printf '%s\n' "$ext_out" | grep -q 'linked' && fail "re-running --copilot-extensions relinked"
ok "re-running --copilot-extensions is a no-op"

ln -s "$REPO/extensions/removed-ext" "$ext_dest/removed-ext"
quiet "$INSTALL" --copilot-extensions || fail "stale extension pruning failed"
[ ! -L "$ext_dest/removed-ext" ] || fail "stale extension link was kept"
ok "--copilot-extensions prunes stale links"

mkdir "$ext_dest/foreign-ext"
quiet "$INSTALL" --uninstall --copilot-extensions || fail "--uninstall --copilot-extensions failed"
[ "$(ls "$ext_dest")" = "foreign-ext" ] || fail "--uninstall --copilot-extensions left links or removed foreign entry"
ok "--uninstall --copilot-extensions removes only this repository's extensions"

quiet "$INSTALL" --copy --extensions-target "$WORK/ext-copy" || fail "--copy --extensions-target failed"
[ -f "$WORK/ext-copy/tickets/extension.mjs" ] && [ ! -L "$WORK/ext-copy/tickets" ] ||
	fail "--copy --extensions-target did not copy tickets"
[ -f "$WORK/ext-copy/jira/extension.mjs" ] && [ ! -L "$WORK/ext-copy/jira" ] ||
	fail "--copy --extensions-target did not copy jira"
quiet "$INSTALL" --uninstall --extensions-target "$WORK/ext-copy" || fail "--uninstall --extensions-target failed"
[ -z "$(ls -A "$WORK/ext-copy")" ] || fail "--uninstall --extensions-target left copied extension"
ok "--extensions-target supports --copy and --uninstall"

if command -v node >/dev/null 2>&1; then
	quiet node --test "$REPO"/extensions/*/extension.test.mjs || fail "extension node unit tests failed"
	ok "extension unit tests pass"
fi

# --- copilot agents ----------------------------------------------------------
agent_dest="$HOME/.copilot/agents"
quiet "$INSTALL" --copilot-agents || fail "--copilot-agents install failed"
[ -L "$agent_dest/orchestrator.agent.md" ] && [ -f "$agent_dest/orchestrator.agent.md" ] ||
	fail "--copilot-agents did not link orchestrator.agent.md"
ok "--copilot-agents links orchestrator.agent.md into ~/.copilot/agents"

agent_out="$("$INSTALL" --copilot-agents)"
printf '%s\n' "$agent_out" | grep -q 'linked' && fail "re-running --copilot-agents relinked"
ok "re-running --copilot-agents is a no-op"

ln -s "$REPO/agents/removed.agent.md" "$agent_dest/removed.agent.md"
quiet "$INSTALL" --copilot-agents || fail "stale agent pruning failed"
[ ! -L "$agent_dest/removed.agent.md" ] || fail "stale agent link was kept"
ok "--copilot-agents prunes stale agent links"

printf 'custom agent\n' >"$agent_dest/foreign.agent.md"
quiet "$INSTALL" --uninstall --copilot-agents || fail "--uninstall --copilot-agents failed"
[ "$(ls "$agent_dest")" = "foreign.agent.md" ] ||
	fail "--uninstall --copilot-agents left links or removed foreign agent"
ok "--uninstall --copilot-agents removes only this repository's agents"

agent_copy="$WORK/agent-copy"
quiet "$INSTALL" --copy --agents-target "$agent_copy" || fail "--copy --agents-target failed"
[ -f "$agent_copy/orchestrator.agent.md" ] && [ ! -L "$agent_copy/orchestrator.agent.md" ] ||
	fail "--copy --agents-target did not copy orchestrator.agent.md"
agent_copy_out="$("$INSTALL" --copy --agents-target "$agent_copy")"
printf '%s\n' "$agent_copy_out" | grep -q 'copied' && fail "re-running --copy --agents-target recopied"
printf 'foreign\n' >"$agent_copy/foreign.agent.md"
quiet "$INSTALL" --uninstall --agents-target "$agent_copy" || fail "--uninstall --agents-target failed"
[ "$(ls "$agent_copy")" = "foreign.agent.md" ] ||
	fail "--uninstall --agents-target left copy or removed foreign agent"
quiet "$INSTALL" --copy --agents-target "$agent_copy" || fail "re-copy --agents-target failed"
printf '\n# local edit\n' >>"$agent_copy/orchestrator.agent.md"
quiet "$INSTALL" --uninstall --agents-target "$agent_copy" || fail "--uninstall --agents-target on modified copy failed"
[ -f "$agent_copy/orchestrator.agent.md" ] || fail "--uninstall --agents-target removed a modified copy"
ok "--agents-target supports --copy, idempotent re-run, and safe --uninstall"

quiet "$INSTALL" --agents-target "$REPO/agents" && fail "--agents-target into the repository was allowed"
ok "--agents-target refuses destinations inside the repository"

# --- orchestrator_guard unit tests -------------------------------------------
quiet python3 -m unittest discover -s "$REPO/orchestrator_guard/tests" ||
	fail "orchestrator_guard unit tests failed"
ok "orchestrator_guard unit tests pass"

# --- copilot hooks -----------------------------------------------------------
hook_proj="$WORK/hook-proj"
mkdir -p "$hook_proj"
quiet "$INSTALL" --copilot-hooks "$hook_proj" || fail "--copilot-hooks install failed"
[ -L "$hook_proj/.github/hooks/orchestrator-guard.json" ] && [ -f "$hook_proj/.github/hooks/orchestrator-guard.json" ] ||
	fail "--copilot-hooks did not link orchestrator-guard.json"
[ -L "$hook_proj/.github/orchestrator_guard" ] && [ -f "$hook_proj/.github/orchestrator_guard/cli.py" ] ||
	fail "--copilot-hooks did not link orchestrator_guard"
ok "--copilot-hooks links hook config and orchestrator_guard"

hook_out="$("$INSTALL" --copilot-hooks "$hook_proj")"
printf '%s\n' "$hook_out" | grep -q 'linked' && fail "re-running --copilot-hooks relinked"
ok "re-running --copilot-hooks is a no-op"

printf '{}\n' >"$hook_proj/.github/hooks/foreign.json"
mkdir "$hook_proj/.github/foreign_dir"
quiet "$INSTALL" --uninstall --copilot-hooks "$hook_proj" || fail "--uninstall --copilot-hooks failed"
[ "$(ls "$hook_proj/.github/hooks")" = "foreign.json" ] ||
	fail "--uninstall --copilot-hooks left links or removed foreign hook"
[ ! -e "$hook_proj/.github/orchestrator_guard" ] && [ ! -L "$hook_proj/.github/orchestrator_guard" ] ||
	fail "--uninstall --copilot-hooks left orchestrator_guard"
[ -d "$hook_proj/.github/foreign_dir" ] ||
	fail "--uninstall --copilot-hooks removed foreign directory"
ok "--uninstall --copilot-hooks leaves foreign hook files untouched"

hook_copy_proj="$WORK/hook-copy-proj"
mkdir -p "$hook_copy_proj"
quiet "$INSTALL" --copy --copilot-hooks "$hook_copy_proj" || fail "--copy --copilot-hooks failed"
[ -f "$hook_copy_proj/.github/hooks/orchestrator-guard.json" ] && [ ! -L "$hook_copy_proj/.github/hooks/orchestrator-guard.json" ] ||
	fail "--copy --copilot-hooks did not copy orchestrator-guard.json"
[ -d "$hook_copy_proj/.github/orchestrator_guard" ] && [ ! -L "$hook_copy_proj/.github/orchestrator_guard" ] ||
	fail "--copy --copilot-hooks did not copy orchestrator_guard"
[ -f "$hook_copy_proj/.github/orchestrator_guard/cli.py" ] ||
	fail "--copy --copilot-hooks missing cli.py"
[ -z "$(find "$hook_copy_proj/.github/orchestrator_guard" -name '__pycache__' -o -name '*.pyc')" ] ||
	fail "--copy --copilot-hooks copied __pycache__ or .pyc files"
hook_copy_out="$("$INSTALL" --copy --copilot-hooks "$hook_copy_proj")" ||
	fail "re-running --copy --copilot-hooks failed"
printf '%s\n' "$hook_copy_out" | grep -q 'copied orchestrator-guard\.json' &&
	fail "re-running --copy --copilot-hooks recopied orchestrator-guard.json"
printf '%s\n' "$hook_copy_out" | grep -q 'unchanged orchestrator-guard\.json' ||
	fail "re-running --copy --copilot-hooks did not report orchestrator-guard.json unchanged"
[ -z "$(find "$hook_copy_proj/.github/orchestrator_guard" -name '__pycache__' -o -name '*.pyc')" ] ||
	fail "re-running --copy --copilot-hooks left __pycache__ or .pyc files"
quiet "$INSTALL" --uninstall --copilot-hooks "$hook_copy_proj" || fail "--uninstall --copy --copilot-hooks failed"
[ -z "$(ls -A "$hook_copy_proj/.github/hooks")" ] ||
	fail "--uninstall --copilot-hooks left copied hook files"
[ ! -e "$hook_copy_proj/.github/orchestrator_guard" ] ||
	fail "--uninstall --copilot-hooks left copied orchestrator_guard"
ok "--copy --copilot-hooks copies cleanly without __pycache__, handles re-run, and uninstalls cleanly"

quiet "$INSTALL" --copilot-hooks "$REPO" && fail "--copilot-hooks into the repository was allowed"
ok "--copilot-hooks refuses destinations inside the repository"

# --- --copy single-file ownership tracking across upstream changes -----------
upstream_copy="$WORK/upstream-repo-copy"
mkdir -p "$upstream_copy"
(cd "$REPO" && tar --exclude=.git -cf - .) | (cd "$upstream_copy" && tar -xf -)
upstream_agents="$WORK/upstream-agents"
upstream_hooks_proj="$WORK/upstream-hooks-proj"
mkdir -p "$upstream_hooks_proj"

quiet "$upstream_copy/scripts/install.sh" --copy --agents-target "$upstream_agents" ||
	fail "initial --copy --agents-target from temp repo failed"
quiet "$upstream_copy/scripts/install.sh" --copy --copilot-hooks "$upstream_hooks_proj" ||
	fail "initial --copy --copilot-hooks from temp repo failed"

printf '\n<!-- upstream-v2 -->\n' >>"$upstream_copy/agents/orchestrator.agent.md"
python3 - "$upstream_copy/hooks/orchestrator-guard.json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as fh:
    data = json.load(fh)
data["_upstream_version"] = 2
with open(p, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
PY

up_agent_out="$("$upstream_copy/scripts/install.sh" --copy --agents-target "$upstream_agents")" ||
	fail "re-running --copy --agents-target after upstream change failed"
printf '%s\n' "$up_agent_out" | grep -q 'updated orchestrator\.agent\.md' ||
	fail "re-running --copy --agents-target did not report updated orchestrator.agent.md"
cmp -s "$upstream_agents/orchestrator.agent.md" "$upstream_copy/agents/orchestrator.agent.md" ||
	fail "copied orchestrator.agent.md was not updated to new upstream content"

up_hook_out="$("$upstream_copy/scripts/install.sh" --copy --copilot-hooks "$upstream_hooks_proj")" ||
	fail "re-running --copy --copilot-hooks after upstream change failed"
printf '%s\n' "$up_hook_out" | grep -q 'updated orchestrator-guard\.json' ||
	fail "re-running --copy --copilot-hooks did not report updated orchestrator-guard.json"
cmp -s "$upstream_hooks_proj/.github/hooks/orchestrator-guard.json" "$upstream_copy/hooks/orchestrator-guard.json" ||
	fail "copied orchestrator-guard.json was not updated to new upstream content"

python3 - "$upstream_copy/hooks/orchestrator-guard.json" <<'PY'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as fh:
    data = json.load(fh)
data["_upstream_version"] = 3
with open(p, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
PY

quiet "$upstream_copy/scripts/install.sh" --uninstall --copilot-hooks "$upstream_hooks_proj" ||
	fail "--uninstall --copilot-hooks after upstream hook change failed"
[ ! -e "$upstream_hooks_proj/.github/hooks/orchestrator-guard.json" ] ||
	fail "--uninstall --copilot-hooks left dangling orchestrator-guard.json after upstream change"
[ ! -e "$upstream_hooks_proj/.github/orchestrator_guard" ] ||
	fail "--uninstall --copilot-hooks left orchestrator_guard after upstream change"

printf '\n<!-- local-edit -->\n' >>"$upstream_agents/orchestrator.agent.md"
quiet "$upstream_copy/scripts/install.sh" --copy --agents-target "$upstream_agents" &&
	fail "--copy without --force overwrote a locally edited copied agent"
grep -qF '<!-- local-edit -->' "$upstream_agents/orchestrator.agent.md" ||
	fail "locally edited copied agent was modified on refused --copy"
quiet "$upstream_copy/scripts/install.sh" --uninstall --agents-target "$upstream_agents" ||
	fail "--uninstall --agents-target on locally edited copy failed"
[ -f "$upstream_agents/orchestrator.agent.md" ] &&
	grep -qF '<!-- local-edit -->' "$upstream_agents/orchestrator.agent.md" ||
	fail "--uninstall removed or altered locally edited copied agent"
ok "--copy tracks single-file ownership across upstream changes and preserves local edits"

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
