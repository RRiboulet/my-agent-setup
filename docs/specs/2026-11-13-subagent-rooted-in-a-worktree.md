# Subagent rooted in a worktree: which geometries still die at startup

Investigation on `investigate-subagent-worktree` (off `dev`, `5ec6697`). Question:
#103 (in v1.11.0) claimed to fix "a subagent rooted in a worktree dies at start
on an extension flag conflict". A downstream project using the package still
reported the symptom, so this records what actually reproduces and what does not.

## Method

The failing thing is the **child** process, and it dies during extension loading,
before any model call. So each geometry was driven with the exact argv
`buildChildPiArgs` produces (`handoff.ts`), in tmux with `remain-on-exit`, then
the dead pane was read. A passing child reaches "No API key found" (the probe
agent dirs carry no credentials) or the TUI footer; a failing one exits 1 on
duplicate tool/flag registrations.

```
node <pi>/dist/bundle/cli.js --provider opencode-go --model deepseek-v4.1-flash \
  --thinking high --session-dir <run>/session --session-id <id> --name <sess> \
  --approve --extension <path/to/subagent/index.ts> @<run>/task.md
```

with `PI_TMUX_SUBAGENT_CHILD=1`, `PI_TMUX_SUBAGENT_RESULT`, `PI_TMUX_SUBAGENT_INTERRUPT`
and an agent dir whose `settings.json` / `trust.json` model the host.

## Results

| # | Geometry | Child result |
|---|---|---|
| 1 | this repo's linked worktree, **package-free** agent dir (the devcontainer) | starts; worktree copy loaded once |
| 2 | separate project `P`, our package installed in the shared agent dir, child `cwd` = `P/.worktrees/task` | starts; package copy loaded once |
| 3 | this repo's linked worktree, **and** this repo also installed as a package (`pi install /path/to/my-agent-setup`, the README's host setup) | **dies**: `Tool "get_goal" conflicts with .../.worktrees/<slug>/.pi/extensions/goal.ts`, `Flag "--attach-subagent" conflicts with ...`, one line per tool, exit 1 |

Geometry 1 is what #103 fixed, and it holds. Geometry 2 — "a separate project
using the coding agent package", the reported shape — starts cleanly at
v1.11.0, so the fix covers it; a symptom there points at a package older than
v1.11.0 (`pi list`, `pi update --extensions`) rather than at the launch path.

Geometry 3 is **not** fixed by #103 and cannot be fixed on the launcher side.
The explicit `--extension` now names the worktree's copy (correct: the child
should run that branch's tooling), but pi *also* discovers the installed package,
which is the main checkout's copy — two different files registering the same
tools and the same `--attach-subagent` flag. This is the README's
"one copy of the extensions, never two" rule, which was only stated for the main
checkout; a linked worktree is a second place where the package copy and the
discovered copy stop being the same file.

Checks that rule out the obvious launcher-side escapes:

- Passing no `--extension` does not help: the conflict is between the worktree's
  project copy and the package copy, and it reproduces with no `-e` at all.
- `--no-approve` would drop project resources and leave the *package* copy, i.e.
  the main checkout's code — it starts, but runs the wrong branch.
- No flag or env var suppresses installed packages *selectively*.
  `PI_PACKAGE_DIR` overrides *pi's own* install path (`getPackageDir()`), not the
  extension packages resolved from `settings.json`. `--no-extensions` (`-ne`)
  does drop package discovery while explicit `-e` paths still load, so a launcher
  could in principle name this repo's extension files under `-ne`; that trades
  the conflict for a child with no built-in extensions and no extension or MCP
  server it did not name — a lossy workaround, not a dedupe, and rejected for
  that reason.
- `.pi` discovery is cwd-only, not ancestor-walking: the same child launched one
  directory down (`.../docs`) does not see the worktree's copy and therefore does
  not conflict — but then it runs the package's copy, not the branch's.

So geometry 3 is a host configuration problem with one real remedy: do not
install this repo as a package on a host that runs subagents in this repo's
worktrees (the devcontainer keeps the working tree as the single source by
giving itself a package-free agent dir), or uninstall the package before using
the worktree flow there.

## Reproducing

```bash
# geometry 1: package-free agent dir
mkdir -p /tmp/agent-nopkg
printf '{ "defaultProvider": "opencode-go", "defaultModel": "deepseek-v4.1-flash" }' > /tmp/agent-nopkg/settings.json
printf '{ "/workspace": true }' > /tmp/agent-nopkg/trust.json

# geometry 3: the same, plus this repo as a package
mkdir -p /tmp/agent-localpkg
printf '{ "packages": ["/workspace"] }' > /tmp/agent-localpkg/settings.json
printf '{ "/workspace": true }' > /tmp/agent-localpkg/trust.json

cd /workspace/.worktrees/<slug>
PI_CODING_AGENT_DIR=/tmp/agent-nopkg  pi -p hi -e "$PWD/.pi/extensions/subagent/index.ts"   # starts
PI_CODING_AGENT_DIR=/tmp/agent-localpkg pi -p hi -e "$PWD/.pi/extensions/subagent/index.ts" # conflicts
```
