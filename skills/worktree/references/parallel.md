# Parallel worktrees and subagents

Part of the [`worktree`](../SKILL.md) skill. Read `../SKILL.md` first for the
location convention and the safety rules; this file assumes both.

## Parallel subagents

- One worktree, one branch, one slug per subagent. The same branch cannot be
  checked out twice, and two subagents sharing one worktree collide on
  `index.lock`.
- Pass an absolute `cwd` (`<repo-root>/.worktrees/<slug>`), not a relative
  path.
- Remove a worktree only after `subagent_wait({ id })` reports the run terminal
  (or `subagent_status({ compact: true })` shows it terminal); cancel it first
  if you cannot wait. Because subagent launch is
  queued and tmux's `-c` silently falls back to the server's cwd when the path
  is missing, a vanished worktree can run in the wrong directory instead of
  failing.


## Delegating to a subagent rooted in a worktree

Delegate a task to a subagent rooted in the worktree (sub-agent invocation takes
an absolute `cwd`). Resolve the path the same way the recipes in
`lifecycle.md` do:

```bash
R="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"; SLUG="task-name"; WT="$R/.worktrees/$SLUG"
echo "$WT"   # /path/to/that/clone/.worktrees/task-name - pass this as cwd
```

Then pass that expanded path, not a variable (a tool call is not a shell):

```
subagent({ role: "coder", task: "...", cwd: "<the path printed above>" })
```

The child loads the **worktree's own** copy of this repo's extension: pi
discovers project extensions from the child's `cwd` when that project is
trusted, so within this repo the launcher hands it that path explicitly rather
than the main checkout's. That is also why the two must not be mixed - the
failure is in the note below. A `cwd` outside this repo's trusted tree keeps the
launcher's own copy instead, because an explicit extension path is loaded even
for a project pi would refuse to trust. The one precondition is that this repo
is not *also* installed as a pi package on that host: pi would discover that
package as well, it is the main checkout's copy rather than the worktree's, and
no launcher rule can dedupe two different files. The note below has the symptom
and the remedy.

Use an absolute path for `cwd`, never a relative one. One worktree per
subagent: the same branch cannot be checked out twice, and two subagents in one
worktree collide on `index.lock`. Do not remove a worktree while a subagent
rooted in it is still running - cancel or wait for it to finish first.

If such a subagent exits about two seconds in and all you see is "Child Pi
exited before reporting a result", read the dead child's tmux pane before
anything else: `subagent_status` reports only that generic line, while the pane
holds the reason. A launcher that passed the main checkout's extension path to
a child rooted in a worktree hit this:

```
Failed to load extension ".../.worktrees/task-name/.pi/extensions/subagent/index.ts":
Flag "--attach-subagent" conflicts with /path/to/repo/.pi/extensions/subagent/index.ts
```

That is two copies of one extension, not two extensions: pi discovers the
worktree's copy as the project extension, so the explicit flag must name the
same file the child would discover. This repo's launcher resolves the child's
copy, so the recipe above works. On a checkout without that fix, launch with
`cwd` = the repository root and `cd` into the worktree inside each command
instead, which keeps the child's discovery pointed at the main checkout.

**The package copy is the one case that fix cannot cover.** If this repo is also
installed as a package on that host (the README's local-path install, or a
`git:` one), the child discovers the package too, and the package is the *main
checkout's* copy — a different file from the worktree's, because the worktree's
copy only becomes discoverable once `cwd` moves into the tree. The child then
exits 1 with one line per extension, e.g.

```
Tool "todo" conflicts with /path/to/repo/.worktrees/task-name/.pi/extensions/todos.ts
Flag "--attach-subagent" conflicts with /path/to/repo/.worktrees/task-name/.pi/extensions/subagent/index.ts
```

That ordering is the tell: the **package** path is the one being refused, so the
conflict is not the launcher's flag but the two copies in the child's own
discovery. It reproduces with no `--extension` at all, and there is no
selective way to suppress it: `--no-extensions` (`-ne`) drops package discovery
along with the built-in extensions and every extension not named with `-e`, so it
is a lossy workaround, not a dedupe. There is no launcher fix to wait for.
On such a host, `bin/pi-agent-dir` is the fix: it gives the checkout a
package-free agent dir of its own (the devcontainer's split, on a host) and
`--shell` adds a `pi` function that selects it from inside the checkout or any
worktree, so the tree's own copy is the only one loaded. A **child** does not go
through that shell hook, so pass the dir explicitly — the same content the hook
would choose:

```bash
cd .worktrees/<slug> && PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)" pi -p "<task>"
```

Resolve that name with `bin/pi-agent-dir --print`; it is per checkout, and a
literal copy in a tracked file is what `devcontainer-agent-dir.test.ts` forbids. Failing that, either
uninstall the package there (every unrelated project then loses its extensions)
or launch with `cwd` = the repository root and `cd` into the worktree inside each
command (starts, but runs the main checkout's extensions, not the branch's).

