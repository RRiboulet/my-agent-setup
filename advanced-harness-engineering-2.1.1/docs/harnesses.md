# Dual-Harness Compatibility Matrix (`pi` + GitHub Copilot CLI)

`advanced-harness-engineering` supports two primary agent harnesses from one shared repository: the **`pi` coding agent** and **GitHub Copilot CLI**. Canonical skills live in [`skills/`](../skills/), `pi` extensions in `.pi/extensions/`, and Copilot CLI extensions, custom agents, and hooks in `extensions/`, [`agents/`](../agents/orchestrator.agent.md), [`hooks/`](../hooks/orchestrator-guard.json), and [`orchestrator_guard/`](../orchestrator_guard/README.md).

> Checked against each harness's current behavior in this repository. Where a harness's upstream documentation disagrees with an implementation detail here, verify with the harness's live `--help` or `scripts/test.sh`.

---

## 1. Installation & wiring

### `pi` coding agent

1. **Global or project package install** (reads [`package.json`](../package.json) `pi.extensions` [11 entry points] and `pi.skills` [32 skills]):

   ```bash
   pi install git:github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering
   pi install -l git:github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering   # project-only
   ```

2. **Global instructions & MCP server catalogue**:

   ```bash
   bash scripts/install.sh --instructions-only ~/.pi/agent/AGENTS.md
   bash bin/mcp-catalogue                 # or /mcp-catalogue in-session; merges mcp/catalogue.json
   ```

   Use `--instructions-only` (rather than `--instructions`) so `scripts/install.sh` does not also link skills into `~/.agents/skills/`, preventing 32 skill collisions with `pi install`.

3. **Isolated checkout / worktree development** (avoids duplicate tool registration errors when working inside a clone or `.worktrees/<slug>` of this repo):
   - **Single checkout on a host:** remove any `git:` install and use `pi install /path/to/advanced-harness-engineering`.
   - **Linked worktrees on a host:** run [`bin/pi-agent-dir`](../bin/pi-agent-dir) (`--shell` installs the `~/.bashrc` hook; `--check` verifies trust/settings; `--print` prints the per-checkout agent dir without `.packages`). For non-login launchers (tmux, CI, cron, editor tasks), invoke [`bin/pi-wrapped`](../bin/pi-wrapped) instead of `pi`, or pass `PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)"` explicitly.
   - **Devcontainer:** [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) sets a dedicated `PI_CODING_AGENT_DIR` on a private volume with no `.packages`, and `postCreate.sh` seeds settings and [`mcp/catalogue.json`](../mcp/catalogue.json).

### GitHub Copilot CLI

Pick either the repository installer script (symlinks directly from your clone so `git pull` updates everything) or the Copilot CLI plugin workflow:

1. **One-shot installer + repo guard hooks**:

   ```bash
   bash scripts/install.sh --copilot
   bash scripts/install.sh --copilot-hooks /path/to/repo
   ```

   (`--copilot` wires skills, `~/.copilot/extensions` [`tickets` + `jira`], `~/.copilot/agents/orchestrator.agent.md`, and `~/.copilot/copilot-instructions.md` from [`instructions/AGENTS.md`](../instructions/AGENTS.md). Granular flags `--user`, `--copilot-extensions`, `--copilot-agents`, and `--instructions` remain available, and `scripts/install.sh --target DIR` supports Codex, OpenCode, Cursor, Gemini CLI, and `--claude`.)

2. **Copilot CLI plugin install (alternative)**:

   ```bash
   copilot plugin install https://github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering.git
   # or from a local clone:
   copilot --plugin-dir .
   ```

   [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) already activates `orchestrator-guard` hooks globally when installed via `copilot plugin install` or `copilot --plugin-dir .`. Do **not** also run `scripts/install.sh --copilot-hooks` on the same repository (running both fires every hook twice and halves budgets; use `--copilot-hooks` only with `scripts/install.sh --copilot`, not alongside the plugin).

3. **Copilot CLI settings (`~/.copilot/settings.json`)**:
   - Enable `"experimental": true` (or `/settings experimental on`, followed by `/restart`) so custom extensions (`tickets`, `jira`) load.
   - Configure `/subagents` tier routing so `explore`/`research` use a fast/cheap model, `general-purpose` uses a mid-tier coder model, and `code-review`/`security-review` use a frontier model:

   ```json
   {
     "experimental": true,
     "subagents": {
       "agents": {
         "explore": { "model": "claude-haiku-4.5", "effortLevel": "medium" },
         "research": { "model": "claude-haiku-4.5", "effortLevel": "low" },
         "general-purpose": { "model": "claude-sonnet-4.5", "effortLevel": "high" },
         "code-review": { "model": "claude-opus-4.5", "effortLevel": "high" },
         "security-review": { "model": "claude-opus-4.5", "effortLevel": "high" }
       }
     }
   }
   ```

   - For Jira tools, store a single-line PAT in `~/.config/jira/token` (`chmod 600`; see [`extensions/jira/README.md`](../extensions/jira/README.md)).

---

## 2. Complete 32-skill compatibility matrix

All **32 skills** live in [`skills/`](../skills/): **8 user-invoked** (`disable-model-invocation: true`) and **24 model-invoked** (auto-loaded when triggers match, or invoked manually).

- **Invocation syntax:**
  - **User-invoked:** `/name` on Copilot CLI (`/<name>`), `/skill:<name>` on `pi`.
  - **Model-invoked:** loaded automatically by the agent when triggers match; manual `/name` on Copilot CLI or `/skill:<name>` on `pi` also works.

| # | Name | Invocation | `pi` support | Copilot CLI support | Notes / Fallbacks |
|---|---|---|---|---|---|
| 1 | `handoff` | User (`/handoff` \| `/skill:handoff`) | Full | Full | `pi` saves under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/handoffs/`; Copilot CLI saves in session `files/` (or OS temp dir). |
| 2 | `implement` | User (`/implement` \| `/skill:implement`) | Full | Full | `pi` routes multi-ticket sets to `/orchestrate` and edits to `coder`; Copilot CLI uses `tickets_*`, `task` (`general-purpose`), or `/implement-spec`. |
| 3 | `implement-spec` | User (`/implement-spec` \| `/skill:implement-spec`) | Full | Full | Parallel worktree DAG runner by ready frontier; `pi` worktree children use `bin/pi-agent-dir` / `bin/pi-wrapped`. |
| 4 | `recall` | User (`/recall` \| `/skill:recall`) | Full | Full | `pi` scans `${PI_CODING_AGENT_DIR}/sessions/` + `orchestrator_workspace` peers; Copilot CLI queries `session_store_sql` + `explore`. |
| 5 | `teach` | User (`/teach` \| `/skill:teach`) | Primary | Fallback | `pi` uses `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/learning/<slug>`; Copilot CLI falls back to `${XDG_DATA_HOME:-$HOME/.local/share}/agent-learning/<slug>` (or explicit path). |
| 6 | `to-spec` | User (`/to-spec` \| `/skill:to-spec`) | Full | Full | Writes local spec markdown (`docs/specs/`) or named tracker; identical across harnesses. |
| 7 | `to-tickets` | User (`/to-tickets` \| `/skill:to-tickets`) | Full | Full | Ticket YAML frontmatter is shared contract for both Copilot CLI `tickets_*` tools and `pi` `/orchestrate`. |
| 8 | `verify-app` | User (`/verify-app` \| `/skill:verify-app`) | Full | Full | Writes `<repo-skills-dir>/verify-<app>/SKILL.md` (`.github/skills/` on Copilot CLI, `skills/` or `.pi/skills/` on `pi`, or `.agents/skills/`). |
| 9 | `add-model` | Model (`add-model`) | **`pi`-only** | Unsupported | Edits `.pi/extensions/opencode-go-provider/models.json`; Copilot CLI manages models via `/model` and `/subagents` settings. |
| 10 | `architect` | Model (`architect`) | Full | Full | Pure design-shape check (trace touches, two shapes, deletion & single-owner tests); escalates tradeoffs to `grilling`. |
| 11 | `benchmark-checklist` | Model (`benchmark-checklist`) | Full | Full | 7-question performance vetting checklist; checks `/proc/loadavg` and repeatability in either harness. |
| 12 | `blast-radius` | Model (`blast-radius`) | Full | Full | Dependency/impact trace and invariant proof by executing real code; harness-agnostic. |
| 13 | `commit` | Model (`commit`) | Full | Full | Conventional Commits + `AGENTS.md` branch-base checks (`node tools/branch-base.mjs`). |
| 14 | `devcontainer` | Model (`devcontainer`) | Primary | Fallback (host only) | Uses `bin/devc` (`@devcontainers/cli` + Docker) on headless host; unavailable inside managed/cloud environments without Docker. |
| 15 | `diagnosing-bugs` | Model (`diagnosing-bugs`) | Full | Full | Tight red feedback loop, ranked hypotheses, `scripts/hitl-loop.template.sh`; harness-agnostic. |
| 16 | `github` | Model (`github`) | Full | Full | `gh` CLI workflows + release merge rule (`gh pr merge <n> --merge`, never `--delete-branch`). |
| 17 | `grilling` | Model (`grilling`) | Full | Full | Multi-round design-tree interview; delegates read-only lookups to `explore` (`subagent` on `pi`, `task` on Copilot CLI). |
| 18 | `idempotent-operations` | Model (`idempotent-operations`) | Full | Full | Convergence, idempotency keys, atomic writes, leases, and guarded migrations; harness-agnostic. |
| 19 | `in-your-own-words` | Model (`in-your-own-words`) | Full | Full | Pre-work playback of goal, done-when, scope, and assumptions; harness-agnostic. |
| 20 | `interrogate` | Model (`interrogate`) | Full | Full | Adversarial break-the-change audit requiring executable proof; harness-agnostic. |
| 21 | `librarian` | Model (`librarian`) | Primary | Fallback | `checkout.sh` caches under `${PI_CODING_AGENT_DIR}/cache/checkouts` on `pi`, falling back to `${XDG_CACHE_HOME:-$HOME/.cache}/agent-librarian` on Copilot CLI; `github-mcp-server` / `semantic_code_search` also work natively on Copilot CLI. |
| 22 | `native-web-search` | Model (`native-web-search`) | Primary | Fallback | `pi` uses `web_search` tool or `search.mjs` (Brave/OpenRouter/Anthropic/OpenAI-Codex); Copilot CLI falls back to built-in `web_fetch` / MCP search (or `search.mjs` when keys are configured). |
| 23 | `prevent-recurrence` | Model (`prevent-recurrence`) | Full | Full | Encodes repeated fixes at highest ladder rung + `scripts/rule-table.mjs` validation on `AGENTS.md`. |
| 24 | `prove-it-works` | Model (`prove-it-works`) | Full | Full | Real-artifact verification, quality gate, revert check, and honest status vocabulary (`passed`, `failed`, `not_run`, `unavailable`). |
| 25 | `retro` | Model (`retro`) | Full | Full | Harness/check/doc improvement ladder after friction or milestones; harness-agnostic. |
| 26 | `review-change` | Model (`review-change`) | Full | Full | Separate Spec / Correctness / Standards review axes (`references/smells.md`); pairs with `/review` (`pi`) or `code-review` (`Copilot CLI`). |
| 27 | `show-me-your-work` | Model (`show-me-your-work`) | Full | Full | `scripts/log.sh` TSV decision log; fresh-context audit uses `reviewer` (`pi`) or `code-review` (`Copilot CLI`). |
| 28 | `tdd` | Model (`tdd`) | Full | Full | Vertical-slice red-green-refactor loop (`references/tests.md`, `references/mocking.md`); harness-agnostic. |
| 29 | `tmux` | Model (`tmux`) | Full | Full | Interactive CLI control over private tmux socket (`PI_TMUX_SOCKET_DIR`); keeps clear of `pi-agent-*` subagent sessions. |
| 30 | `update-changelog` | Model (`update-changelog`) | Full | Full | `CHANGELOG.md` `## Unreleased` and major-retention workflow; harness-agnostic. |
| 31 | `worktree` | Model (`worktree`) | Full | Full | `.worktrees/<slug>` lifecycle; `pi` child runs inside `.worktrees/` must use `bin/pi-agent-dir` / `bin/pi-wrapped`. |
| 32 | `writing-for-agents` | Model (`writing-for-agents`) | Full | Full | Authoring guide for skills, `AGENTS.md`, and pointer docs (`references/skill-mechanics.md`). |

---

## 3. Extensions compatibility matrix

### `pi` extensions (11 in `.pi/extensions/`)

| Extension | Entry point | Purpose on `pi` | Copilot CLI status / equivalent |
|---|---|---|---|
| `subagent` | `.pi/extensions/subagent/index.ts` | Non-blocking tmux-backed delegation, DAG `tasks[]` (`dependsOn`), `subagent_wait`/`status`/`cancel`/`interrupt`/`resume`/`clean`, `subagent_ask`/`answer` escalation, `report.md` artifacts | **Native built-in equivalent:** `task` (`explore`, `research`, `general-purpose`, `code-review`, `security-review`), `read_agent`, `write_agent`, `stop_agent`, `list_agents`, `ask_user`, `run_dynamic_workflow`. |
| `orchestrator` | `.pi/extensions/orchestrator/index.ts` | Tiered wave runner (`/orchestrate` + `orchestrator_wave`), Pragmatic Orchestrator delegation (`/delegation`, `!direct`), settlement gate (`/gate`), loop breaker, `advisor`, `orchestrator_workspace` / `orchestrator_reserve` locks, typed event bus | **Partial parity:** Pragmatic Orchestrator delegation & verification gates live in `agents/orchestrator.agent.md` + `hooks/orchestrator-guard.json` + `orchestrator_guard/`. Wave `/orchestrate` -> Copilot CLI `dynamic_workflows` (Phase 2). No built-in `orchestrator_reserve` cross-worktree lock or `advisor` consultation hook. |
| `btw` | `.pi/extensions/btw/index.ts` | `/btw` off-transcript side question in a tmux popup reusing the active prompt cache | **No direct equivalent:** ask inline or in a separate CLI session. |
| `repo-explorer` | `.pi/extensions/repo-explorer/index.ts` | `/explore` interactive branch tree browser & quick-open transcript printer | **Native built-in equivalent:** `view`, `glob`, `grep`, `bash` (`git show`), or VS Code/IDE tools. |
| `review` | `.pi/extensions/review.ts` | `/review` isolated `reviewer` subagent dispatch reading `REVIEW_GUIDELINES.md` | **Native built-in equivalent:** `task` (`code-review` / `security-review`) + `review-change` / `interrogate` skills. |
| `answer` | `.pi/extensions/answer.ts` | `/answer` focused TUI extracting questions from the last response | **Native built-in equivalent:** `ask_user` structured elicitation. |
| `continue` | `.pi/extensions/continue.ts` | `shift+alt+enter` idle-only `continue` prompt shortcut | **No identical keybinding:** prompt directly or use `manage_schedule`. |
| `todos` | `.pi/extensions/todos.ts` | `/todos` TUI and `todo` tool | **Native built-in equivalent:** built-in `sql` tool (`todos` and `todo_deps` tables). |
| `mcp-catalogue` | `.pi/extensions/mcp-catalogue.ts` | `/mcp-catalogue` installs `mcp/catalogue.json` (Figma, Playwright) into `<agent dir>/mcp.json` | **Native built-in equivalent:** Copilot CLI `/mcp`, `~/.copilot/mcp-config.json`, plus built-in `github-mcp-server` and `browser-use`. |
| `native-web-search` | `.pi/extensions/native-web-search.ts` | Registers `web_search` tool backed by `skills/native-web-search/search.mjs` | **Partial native equivalent:** built-in `web_fetch` + `github-mcp-server`; generic web search requires an MCP search server (or running `search.mjs` manually with keys). |
| `opencode-go-provider` | `.pi/extensions/opencode-go-provider/index.ts` | `opencode-go` `/model` provider and usage budget widget | **`pi`-only:** Copilot CLI handles model providers and `/subagents` routing natively. |

### Copilot CLI extensions (2 in `extensions/`)

| Extension | Entry point | Purpose on Copilot CLI | `pi` status / equivalent |
|---|---|---|---|
| `tickets` | `extensions/tickets/extension.mjs` | `/tickets` interactive TUI browser + 5 tools (`tickets_list`, `tickets_get`, `tickets_frontier`, `tickets_create`, `tickets_update`) over `to-tickets` markdown/YAML sets | **Partial equivalent:** `.pi/extensions/orchestrator/wave-tickets.mjs` + `/orchestrate` read/sync ticket frontmatter during waves, and `to-tickets` / `implement` work via files; standalone `/tickets` browser & `tickets_*` tools are Phase 2. |
| `jira` | `extensions/jira/extension.mjs` | 10 `jira_*` tools (`jira_check_auth`, `jira_get_issue`, `jira_search`, `jira_get_comments`, `jira_get_transitions`, `jira_get_project`, `jira_add_comment`, `jira_transition_issue`, `jira_create_issue`, `jira_update_issue`) for Jira Server/Data Center `/rest/api/2` | **None yet:** `pi` currently relies on external CLI/MCP tooling until Phase 2 port. |

### Phase 2 cross-porting roadmap

1. **Wave `/orchestrate` -> Copilot CLI:** port `.pi/extensions/orchestrator/` tiered wave DAG execution (`/orchestrate`, `wave-ladder`, `ready_to_commit` serialization) to a Copilot CLI dynamic workflow (`run_dynamic_workflow`) / extension.
2. **`tickets` & `jira` -> `pi`:** port `extensions/tickets` (`tickets_*` tools + `/tickets` TUI) and `extensions/jira` (`jira_*` PAT client) into `.pi/extensions/`.

---

## 4. Hooks, custom agents, and guardrails comparison

Both harnesses implement the **Pragmatic Orchestrator** split: keep conversation, planning, tiny surgical edits, and fast read-only checks on the session model while routing broad search (`explore`), external docs (`research`), heavy edits/tests (`coder` / `general-purpose`), and non-trivial reviews (`reviewer` / `code-review`) to subagents.

| Dimension | GitHub Copilot CLI (`orchestrator_guard/` + `hooks/` + `agents/`) | `pi` (`.pi/extensions/orchestrator/delegation-runtime.ts`) |
|---|---|---|
| **Entry & activation** | Custom agent [`agents/orchestrator.agent.md`](../agents/orchestrator.agent.md) + [`hooks/orchestrator-guard.json`](../hooks/orchestrator-guard.json) (activated globally by [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) or per-repo via `--copilot-hooks`) | Built into `.pi/extensions/orchestrator/index.ts`; active automatically in every parent session (unless `mode === "off"`) |
| **Lifecycle seams** | External Python fail-open hooks (`timeoutSec: 5`): `userPromptSubmitted`, `preToolUse`, `postToolUse`, `subagentStart`, `subagentStop`, `agentStop` | In-process TypeScript hooks: `session_start`, `session_tree`, `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle`, event bus |
| **Mode control & config** | `ORCHESTRATOR_HOOKS=enforce\|warn\|off` (default `enforce`), `ORCHESTRATOR_HOOKS_POLICY`, `<cwd>/.github/orchestrator-guard.policy.json`, default [`orchestrator_guard/policy.json`](../orchestrator_guard/policy.json) | `PI_ORCHESTRATOR_DELEGATION=enforce\|warn\|off` (default `enforce`), `/delegation [enforce\|warn\|off\|--json]`, `~/.pi/agent/orchestrator-delegation.json`, trusted `.pi/orchestrator.json` `"delegation"` section, `PI_ORCHESTRATOR_DELEGATION_CONFIG` |
| **Single-turn bypass** | Leading `!direct` in prompt (`direct_prefix`) | Leading `!direct` in prompt (`directPrefix`) |
| **Turn classification & discovery budgets** | 6 modes: `security` (2), `implement` (4), `quick-fix` (4), `debug` (5), `review` (5), `qa` (8) over `view`/`grep`/`glob` (`userPromptSubmitted` injects `additionalContext`) | Identical 6 modes and budgets (`2 / 4 / 4 / 5 / 5 / 8`) over `read`/`grep`/`find`/`ls` (`before_agent_start` injects `sections.delegation` without replacing `systemPrompt`) |
| **Parent write & shell guard** | Denies `create`; caps `edit` at 1 already-`view`ed file and `<= 20` changed lines/turn; parent `bash` restricted to read-only allowlist (`ls`, `wc`, read-only `git status\|diff\|log\|show\|branch` piped to `head\|tail\|wc\|cat`) | Denies `write`; caps `edit` at 1 already-`read` file and `<= 20` changed lines/turn; parent `bash`/`powershell` restricted to read-only allowlist (`ls`, `wc`, read-only `git status\|diff\|log\|show\|rev-parse\|branch\|merge-base\|describe\|fetch`, `gh auth status\|pr\|run\|issue\|release` piped to `head\|tail\|wc\|cat`) |
| **Steer-to-unlock** | 2 `write_agent` steers to the same worker in a turn unlock parent editing for that turn | 2 `subagent_interrupt`/`subagent_resume` steers across `resumeOf` lineage unlock parent editing for that turn |
| **Model routing enforcement** | `preToolUse` denies explicit `model` on `task` unless user prompt names a model/tier (so `/subagents` in `settings.json` applies) | `tool_call` blocks explicit `provider`/`model` alongside `role` in `enforce` mode (unless prompt names a model or `!direct`), and patches `provider`/`model`/`thinking`/`tools` in-place from `role` |
| **Verification & review gates** | Tracks modified files and subagent outcomes (`subagentStop` transcript scan); blocks `git commit`, `git push`, `gh pr create`, and `agentStop` (`[orchestrator-guard:verify-required]`) until tests pass and `code-review` succeeds for `>= 2` files or `>= 50` lines (docs `.md`/`.txt` exempt) | Tracks parent + child `activitySummary` edits; blocks `git commit`, `git push`, `gh pr create`, `gh pr merge`, and `agent_before_settle` (`settleAttemptCap: 2` or `orchestrator_override`, yielding to `ready_to_commit` waves) until tests pass and `reviewer`/`security-reviewer` succeeds for `>= 2` files or `>= 50` lines (`.md`/`.txt`/`.rst`/`.adoc` exempt) |
| **Worker exemption** | Events carrying `agentId` are classified `actor_role="subagent"` and exempt | Processes with `PI_ORCHESTRATOR_ROLE=worker` (`isDelegatedWorker === true`) are inert |
| **Telemetry & extras** | JSONL audit log + `python3 orchestrator_guard/summary.py` CLI (`ORCHESTRATOR_HOOKS_STATE_DIR`) | `/gate`, settlement gate (`openTodos`, `repeatedFailure`, `verification.command`), loop breaker, `advisor`, `orchestrator_override`, `orchestrator_compact-snapshot` |

For deep dives on the `pi` internals, see [`docs/harness/extensions.md`](harness/extensions.md), [`docs/harness/subagents.md`](harness/subagents.md), [`docs/harness/reviews.md`](harness/reviews.md), [`docs/harness/skills.md`](harness/skills.md), and [`docs/harness/workflow-schema.md`](harness/workflow-schema.md).

---

## 5. Known limitations & unsupported features

### GitHub Copilot CLI

- **Experimental extensions gate:** `tickets` and `jira` require `"experimental": true` in `~/.copilot/settings.json` (and `/restart`). Without it, extensions are silently not loaded.
- **`disable-model-invocation` enforcement:** Copilot CLI's handling of `disable-model-invocation: true` is not uniformly documented across versions; [`instructions/AGENTS.md`](../instructions/AGENTS.md) reinforces the user-only rule in prose, and user-only descriptions carry no `"Use when:"` triggers.
- **Guard hook activation & duplicate-hook hazard:** [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) already activates `orchestrator-guard` hooks globally when installed via `copilot plugin install` or `copilot --plugin-dir .`. When installing manually with `scripts/install.sh --copilot` or `--copilot-agents` instead of the plugin, each repository needs `scripts/install.sh --copilot-hooks <repo>` (and `python3` in `PATH`). Do **not** also run `scripts/install.sh --copilot-hooks` on the same repository when the plugin is active—running both fires every hook twice and halves discovery/edit budgets. Hook errors fail open and write to `$ORCHESTRATOR_HOOKS_STATE_DIR/errors.log`.
- **Missing `pi`-only capabilities:** no `/orchestrate` tiered wave runner (use `/implement-spec` or `run_dynamic_workflow`), no `/btw` cache-reusing popup, no `orchestrator_reserve` cross-worktree file lock, no `advisor` consultation hook, and no `opencode-go` provider extension (`add-model` is unsupported).
- **Jira PAT & API scope:** `extensions/jira` targets Jira Server / Data Center (`/rest/api/2`) and requires a single-line PAT file (`~/.config/jira/token` / `JIRA_TOKEN_FILE`, or `/run/secrets/jira_token` in containers).

### `pi` coding agent

- **Project trust boundary:** project-local `.pi/settings.json`, `.pi/mcp.json`, and `.pi/orchestrator.json` (`verification.command`, `advisor`, `delegation` project overrides) are ignored silently until project trust is granted.
- **Worktree duplicate-tool trap:** launching `pi` inside a linked `.worktrees/<slug>` with a package-installed `PI_CODING_AGENT_DIR` exits `1` on duplicate tool registration; always use `bin/pi-agent-dir` / `bin/pi-wrapped` or `.devcontainer/`.
- **Missing Copilot-CLI-only extensions:** no standalone `/tickets` interactive TUI (`tickets_*` tools) or `jira_*` tools yet (Phase 2).
- **`native-web-search` credentials:** requires `BRAVE_API_KEY`, OpenRouter, Anthropic, or OpenAI-Codex auth (`opencode-go` models cannot execute hosted web search).

