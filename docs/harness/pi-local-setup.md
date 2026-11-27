# Local `pi` Setup: Custom Gateway Models, Codemode, and Role Routing

Configure your local `~/.pi/agent/` directory (or `$PI_CODING_AGENT_DIR`) to wire custom OpenAI-compatible or Anthropic-compatible endpoints, enable `codemode`-only tool exposure, and route Pragmatic Orchestrator subagent roles across model tiers.

Keep machine-local gateway endpoints, personal routing overrides, and credentials in `~/.pi/agent/` rather than committing them to the repository. Sanitized templates live under [`docs/harness/examples/`](examples/models.example.json).

---

## 1. Register custom gateway models (`~/.pi/agent/models.json`)

Use [`examples/models.example.json`](examples/models.example.json) as a starting point when routing through an AI gateway supporting `openai-completions`, `openai-responses`, and `anthropic-messages`.

- Set `"apiKey": "$GATEWAY_API_KEY"` (environment variable interpolation) or a non-secret placeholder for a keyless local proxy. Never embed real API keys or tokens in `models.json`.
- Declare `contextWindow`, `maxTokens`, and `reasoning: true` per model so `pi` exposes accurate token budgets and thinking-level controls.

Verify registration with zero schema errors:

```bash
pi --list-models
```

## 2. Configure `codemode`-first defaults (`~/.pi/agent/settings.json`)

Copy and adapt [`examples/settings.example.json`](examples/settings.example.json) while preserving any existing `packages`, `lastChangelogVersion`, and `extensionChangelogVersions` entries:

- `defaultProvider` / `defaultModel` / `defaultThinkingLevel`: set your frontier session model and default effort (`medium` is a good baseline).
- `defaultTools`: `["+tool_search", "+codemode"]` enables progressive tool discovery and scriptable tool batching.
- `codemode`: `{ "mode": "only" }` keeps script-callable tools inside `codemode` instead of declaring direct tool schemas on every turn.

## 3. Configure tiered role routing (`~/.pi/agent/orchestrator-delegation.json`)

Copy and adapt [`examples/orchestrator-delegation.example.json`](examples/orchestrator-delegation.example.json) to match your registered providers and models:

- `mode`: `"enforce"` activates Pragmatic Orchestrator discovery budgets, parent edit caps, read-only shell allowlists, and post-edit verification/review gates (see [extensions design](extensions.md) and [subagent routing](subagents.md)).
- `explore` / `research`: route to a fast, low-cost model with read-only tools (`read`, `grep`, `find`, `ls`).
- `coder`: route to a capable mid-tier model with `high` thinking and the full default toolset.
- `reviewer` / `security-reviewer`: set `"inheritModel": true` with `high` thinking and `["read", "grep", "find", "ls", "bash"]` so reviews run in a fresh context on the session's frontier model.

## 4. Install global instructions (`~/.pi/agent/AGENTS.md`)

Install the shared skill routing snippet without duplicating `skills/` into `~/.agents/skills/` (which would collide with `pi install`):

```bash
bash scripts/install.sh --instructions-only ~/.pi/agent/AGENTS.md
```

## 5. Verification

```bash
pi --list-models
node -e 'import("./.pi/extensions/orchestrator/delegation.ts").then(({ readDelegationConfig }) => console.log(readDelegationConfig(process.cwd())))'
```

Confirm `pi --list-models` lists all configured models cleanly and `readDelegationConfig` returns `warnings: []` with `mode: "enforce"` and your expected `roles` map.
