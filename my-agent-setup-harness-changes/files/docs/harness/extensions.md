# Extensions, Settings, and Orchestrator Design

## Cross-extension event bus and settlement gate

Cross-extension imports have one home per extension: `.pi/extensions/orchestrator/events.ts` owns the typed event bus (`orchestrator:run-settled`, `orchestrator:plan-settled`, `orchestrator:todo-changed`, `orchestrator:triage-planned`, `orchestrator:gate-decided`) imported by `todos.ts`, `review-triage/index.ts`, and `subagent/index.ts`, keeping the publisher independent of the bus and avoiding directories without entry points (which fail the manifest test).

The settlement gate (`.pi/extensions/orchestrator/`) records a verdict as a session `custom` entry at `agent_before_settle`, publishes `orchestrator:gate-decided`, and acts only when a trusted project commits `.pi/orchestrator.json` (see `orchestrator.example.json` beside the extension). This repository intentionally commits none, so its gate is report-only.

When configured:
- Settlement blocking checks (`block.openTodos`, `block.repeatedFailure`, or configured `verification.command`) return `continue: true` with evidence instead of letting the run settle; `block.loops` enables the mid-run tool-call loop breaker on `tool_call`.
- An unresolved settlement condition keeps blocking while its evidence is unchanged; a new edit, todo, or failure re-arms it.
- Settlement blocks spend from `attemptCap` (default `3`), while mid-run loop-breaker blocks spend from a separate `loopAttemptCap` (default `3`) so loop blocks never exhaust the settlement gate budget. `orchestrator_override` skips the next block without spending an attempt.
- The gate yields `continue` when a goal owns it and never returns `continue: false`. Checks that cannot be evaluated fail open.
- Delegated workers (`PI_ORCHESTRATOR_ROLE=worker`) record `scope: child` and block nothing.
- `advisor` asks a configured stronger model for a second opinion when a branch hits an unanswered loop block or repeated settlement failure, within a cooldown and per-branch budget. It injects the verdict as a `before_agent_start` prompt section (never replacing the system prompt or switching models, preserving the cached prefix), refuses loudly without credentials, and redacts secrets while excluding tool output bodies from its 4 KB digest.
- `workspace.lockScope` (`"worktree"` default or `"repo"`) sets the namespace for `orchestrator_reserve` file locks.

## Tiered wave orchestration (`/orchestrate` and `orchestrator_wave`)

- `/orchestrate <folder>` starts a wave in non-worker parent sessions: resolves `<folder>` against `cwd`, loads the dispatch ladder via `readLadder()`, rejects ticket graphs with cycles or dangling blockers (`blockingIssues(graph)`), soft-checks `ctx.model` against the ladder's highest tier, records an `orchestrator-wave` custom entry, and sends the kickoff turn. `/orchestrate status` (or `/orchestrate` while active) reports the wave state and live disk frontier; `/orchestrate abort` aborts an active wave.
- `orchestrator_wave` (`exposure: "codemode"` when `codemode` or `tool_search` is active) drives the pure state machine (`pending -> triaged -> implementing -> reviewing (throughTier) -> verifying -> ready_to_commit -> done | blocked`), syncs ticket frontmatter via `setTicketStatus`, and verifies commit SHAs with `git rev-parse --verify` on `record_commit`.
- Ladder overrides resolve in order: `PI_ORCHESTRATE_LADDER`, `<PI_CODING_AGENT_DIR>/orchestrate-ladder.json`, then the bundled `wave-ladder.json` (falling back to `DEFAULT_LADDER`).
- Enforcement: while a wave is active, `tool_call` blocks `git commit` unless at least one ticket is `ready_to_commit`, and `agent_before_settle` blocks premature settlement (`block.wave`, default `true`) even without `.pi/orchestrator.json`—parking when delegated subagent runs are live and clearing once the wave completes or aborts.

## Settings and codemode policy

- `.pi/settings.json` (tracked in git) configures project defaults: `defaultTools: ["+tool_search", "+codemode"]` and `codemode.mode: "on"`.
- `.devcontainer/pi/settings.json` carries container defaults (including model selection and the same `defaultTools` / `codemode` settings, with no `packages` entry).
- Prefer `codemode` to batch independent/parallel tool calls and filter large output before it hits context; use direct tools (`read`, `edit`, `write`, `bash`) for single-step edits or commands.

## Package installation and container isolation

- On a host working in this checkout, install by local path (`pi install /path/to/my-agent-setup`), never `git:github.com/RRiboulet/my-agent-setup`: project discovery and a git package both load `.pi/extensions`, causing duplicate tool registration errors.
- This repository's devcontainer uses a dedicated `PI_CODING_AGENT_DIR` on a private volume with no installed packages (`README.md` section "One copy of the extensions, never two").
- Other project devcontainers bake this repo at a pinned tag under `/opt/pi-packages/my-agent-setup` and point container settings there (tracked via `.devcontainer/pi-agent-setup.version`, Dockerfile `PI_AGENT_SETUP_TAG`, image label `org.rriboulet.pi-package`, and `/opt/pi-packages/my-agent-setup/.pi-agent-setup-tag`).

For pi's API contract, consult `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/`; never modify pi itself.
