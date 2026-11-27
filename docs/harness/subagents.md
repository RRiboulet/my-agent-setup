# Subagent Tools and Worktree Isolation

## Role routing and `--tools` allowlists

`subagent` accepts optional `role` and `tools` parameters on both single-run calls and `tasks[]` plan steps:

- **`role`**: declarative role tag (preserved on the run record, plan retries, and `orchestrator:run-started` / `orchestrator:run-settled` payloads).
- **`tools`**: explicit allowlist of built-in or extension tools forwarded to the child CLI via `--tools <comma-joined>` (`buildChildPiArgs` omits `--tools` when `tools` is absent or empty, and sanitizes whitespace/empty entries). When `tools` is restricted and escalation is enabled (`run.escalation !== false`), `launchRun` automatically preserves `subagent_ask` in the child's `--tools` list so restricted roles can still escalate questions to the parent.

Built-in Pragmatic Orchestrator roles (defined in `.pi/extensions/orchestrator/delegation.ts`):

| Role | Default model | Thinking | Default `--tools` | Purpose |
|---|---|---|---|---|
| `explore` | `opencode-go/deepseek-v4.1-flash` | `medium` | `read,grep,find,ls` | Fast/cheap read-only codebase search and discovery |
| `research` | `opencode-go/deepseek-v4.1-flash` | `low` | `read,grep,find,ls` | Fast/cheap read-only docs and reference lookup |
| `coder` | `opencode-go/hy4-flash-free` | `high` | *(full default toolset)* | Mid-tier implementation, multi-file edits, and running tests/linters |
| `reviewer` | inherit parent model | `high` | `read,grep,find,ls,bash` | Frontier-model independent code review |
| `security-reviewer` | inherit parent model | `high` | `read,grep,find,ls,bash` | Frontier-model security and vulnerability audit |

How routing and auth checks interact:
- In parent sessions, passing `role` lets `.pi/extensions/orchestrator/` resolve `provider`/`model`, `thinking`, and `tools` in-place on `tool_call` (across all delegation modes, including `off`). In `enforce` mode, passing explicit `provider`/`model` alongside `role` is blocked unless the user prompt mentioned a model or started with `!direct`. Unknown roles are blocked in `enforce` mode.
- **Built-in default auth fallback**: if a built-in default role (`configuredByUser: false`) routes to a provider/model without configured credentials, the orchestrator emits a one-time warning and falls back to inheriting the parent's model (preserving `thinking` and `tools`).
- **Strict explicit overrides**: user-configured role overrides (`configuredByUser: true`) and explicit `provider`/`model` overrides (`subagent` params or `PI_SUBAGENT_PROVIDER`/`PI_SUBAGENT_MODEL`) still validate strictly via `validateModelSelection` and fail loudly if unknown or missing credentials.

Customize role presets globally in `~/.pi/agent/orchestrator-delegation.json` (or `$PI_CODING_AGENT_DIR/orchestrator-delegation.json`, or `PI_ORCHESTRATOR_DELEGATION_CONFIG`), or per-project under `"delegation"` in trusted `.pi/orchestrator.json` (ignored when the project is untrusted; see `orchestrator.example.json`). For a complete walkthrough and sanitized config templates (`models.json`, `settings.json`, `orchestrator-delegation.json`), see [`pi-local-setup.md`](pi-local-setup.md).

## Running a child inside a linked worktree

`bin/pi-agent-dir` creates a package-free agent directory per checkout (`bin/pi-agent-dir --print` prints its path). A child rooted in `.worktrees/<slug>` that inherits the host's shared `PI_CODING_AGENT_DIR` loads both the installed package and the worktree's `.pi/extensions/`, causing pi to exit 1 on duplicate tool registration before any model call:

```
Tool "todo" conflicts with .../.worktrees/<slug>/.pi/extensions/todos.ts
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
