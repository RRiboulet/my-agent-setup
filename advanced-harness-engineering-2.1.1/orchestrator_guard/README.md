# Orchestrator Guard

Runtime hook control plane for the Copilot CLI [`orchestrator`](../agents/orchestrator.agent.md) custom agent. Wired via [`hooks/orchestrator-guard.json`](../hooks/orchestrator-guard.json) (using `python3 -S` and `matcher` filters on `preToolUse`/`postToolUse`), it enforces delegation boundaries on parent tool calls while leaving subagents exempt.

## What it enforces

- **Per-mode discovery budgets:** Classifies each prompt (`security`, `review`, `debug`, `implement`, `quick-fix`, `qa`) and caps direct parent `view`/`grep`/`glob` calls so broad discovery is delegated to `explore`.
- **Read-only parent shell:** Restricts parent `bash` calls to read-only inspection (`git status/diff/log/branch/show`, `ls`, `wc`) and delegates tests, builds, and mutations to `general-purpose`.
- **Surgical parent edits:** Blocks parent `create` and limits parent `edit` to one already-`view`ed file and `<= 20` changed lines per turn (auto-unlocking for the turn after repeated worker steers).
- **Subagent model routing:** Blocks explicit `model` overrides on `task` calls unless the user prompt names a model/tier, preserving `/subagents` routing.
- **Post-edit verification gate:** Tracks modified files and subagent outcomes; blocks `git commit`, `git push`, `gh pr create`, and `agentStop` until required tests/lint (`general-purpose`) and `code-review` (for diffs `>= 2` files or `>= 50` net changed lines against git `HEAD`, falling back to per-file line counts outside git) succeed.

## Installation

Install the custom agent globally and the hook manifest into a target repository using [`scripts/install.sh`](../scripts/install.sh):

```bash
scripts/install.sh --copilot-agents
scripts/install.sh --copilot-hooks <project-dir>
```

## Policy configuration

Policy resolution order in `load_policy(policy_path=None, cwd=None)`:

1. Explicit `policy_path` argument
2. `ORCHESTRATOR_HOOKS_POLICY` environment variable
3. `<cwd>/.github/orchestrator-guard.policy.json` (when `cwd` is provided and the file exists)
4. Co-located default [`policy.json`](policy.json)

Create `.github/orchestrator-guard.policy.json` in a repository (or set `ORCHESTRATOR_HOOKS_POLICY`) to override discovery budgets, read-only shell allowlists, file extensions, or verification command patterns per project.

## Environment variables & escape hatch

- `ORCHESTRATOR_HOOKS=enforce|warn|off` — enforcement mode (default: `enforce`).
- `ORCHESTRATOR_HOOKS_STATE_DIR` — directory for per-session state, `events.jsonl` telemetry, and `errors.log`.
- `ORCHESTRATOR_HOOKS_POLICY` — path to an override policy JSON file (takes precedence over `<cwd>/.github/orchestrator-guard.policy.json`).
- **`!direct`** — prefix a user prompt with `!direct` to bypass parent restrictions for that single turn.

## Telemetry CLI

Inspect hook invocations, denial rates, mode distribution, and latency percentiles with [`summary.py`](summary.py):

```bash
python3 orchestrator_guard/summary.py
python3 orchestrator_guard/summary.py --log /path/to/events.jsonl --session <session-id> --json
```
