# Subagent Tools and Worktree Isolation

## Running a child inside a linked worktree

`bin/pi-agent-dir` creates a package-free agent directory per checkout (`bin/pi-agent-dir --print` prints its path). A child rooted in `.worktrees/<slug>` that inherits the host's shared `PI_CODING_AGENT_DIR` loads both the installed package and the worktree's `.pi/extensions/`, causing pi to exit 1 on duplicate tool registration before any model call:

```
Tool "update_goal" conflicts with .../.worktrees/<slug>/.pi/extensions/goal.ts
```

Pass the per-checkout dir so only the worktree's code and skills load:

```bash
cd .worktrees/<slug> && PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)" pi -p "<task>"
```

Launchers that bypass a login shell miss `~/.bashrc` hooks; invoke `bin/pi-wrapped` instead of `pi` there. It resolves the same dir as `bin/pi-agent-dir --print`, forwards all arguments verbatim, preserves an explicit `PI_CODING_AGENT_DIR`, and falls back to plain `pi` with a stderr note if outside a checkout or if `bin/pi-agent-dir` has not been run yet.

Because the `subagent` tool has no `env` parameter, use the explicit CLI command above (or `pi --attach-subagent`) when a child must execute the worktree branch's extensions or skills. Launching `subagent` with `cwd` = main checkout and `cd`-ing inside shell commands runs the main checkout's extensions instead.

## Two-step `tool_search` and codemode access

The seven subagent management tools (`subagent_wait`, `subagent_status`, `subagent_answer`, `subagent_cancel`, `subagent_interrupt`, `subagent_resume`, `subagent_clean`) are omitted from direct tool declarations when `tool_search` or `codemode` is enabled in `defaultTools` (saving ~890 tokens/request with `+tool_search`; `subagent` stays declared).

Reach them via:
- `tool_search` for the tool name, then invoke it (e.g., `subagent_status({ id })`); or
- `tools.subagent_status({ id })` inside a `codemode` script.

## Wait, don't poll — and child questions

Start independent tasks (or a `tasks` fan-out), then call `subagent_wait({ id })`, `subagent_wait({ ids })`, or `subagent_wait({ plan })` once. Reserve `subagent_status({ compact: true })` for live status inspection rather than polling for completion.

The one intentional blocking wait inside a child is `subagent_ask` (registered only when the parent supplied an escalation channel). The parent's watcher surfaces it as `? waiting on a question` in `subagent_status`, and `subagent_answer({ id, answer })` replies only after `ctx.ui.confirm` (refusing when no UI is present; expired/disconnected children time out and report the blocker). Because the escalation directory is same-uid, the tool confirmation prompt is the trust boundary rather than filesystem permissions. Progress updates (`kind: "progress"`) are fire-and-forget and require no answer.
