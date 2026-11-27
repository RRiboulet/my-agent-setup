# Harness Compatibility Matrix (`pi`)

`my-agent-setup` supports the **`pi` coding agent**. Canonical skills live in [`skills/`](../skills/) and `pi` extensions in `.pi/extensions/`. [`scripts/install.sh`](../scripts/install.sh) can also symlink the skill stack into other skill-directories (Codex, Claude Code, OpenCode, Cursor, Gemini CLI, or any `--target DIR`).

> Checked against the harness's current behavior in this repository. Where upstream documentation disagrees with an implementation detail here, verify with the harness's live `--help` or `scripts/test.sh`.

---

## 1. Installation & wiring

### `pi` coding agent

1. **Global or project package install** (reads [`package.json`](../package.json) `pi.extensions` [11 entry points] and `pi.skills` [32 skills]):

   ```bash
   pi install git:github.com/RRiboulet/my-agent-setup
   pi install -l git:github.com/RRiboulet/my-agent-setup   # project-only
   ```

2. **Global instructions & MCP server catalogue**:

   ```bash
   bash scripts/install.sh --instructions-only ~/.pi/agent/AGENTS.md
   bash bin/mcp-catalogue                 # or /mcp-catalogue in-session; merges mcp/catalogue.json
   ```

   Use `--instructions-only` (rather than `--instructions`) so `scripts/install.sh` does not also link skills into `~/.agents/skills/`, preventing 32 skill collisions with `pi install`.

3. **Isolated checkout / worktree development** (avoids duplicate tool registration errors when working inside a clone or `.worktrees/<slug>` of this repo):
   - **Single checkout on a host:** remove any `git:` install and use `pi install /path/to/my-agent-setup`.
   - **Linked worktrees on a host:** run [`bin/pi-agent-dir`](../bin/pi-agent-dir) (`--shell` installs the `~/.bashrc` hook; `--check` verifies trust/settings; `--print` prints the per-checkout agent dir without `.packages`). For non-login launchers (tmux, CI, cron, editor tasks), invoke [`bin/pi-wrapped`](../bin/pi-wrapped) instead of `pi`, or pass `PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)"` explicitly.
   - **Devcontainer:** [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) sets a dedicated `PI_CODING_AGENT_DIR` on a private volume with no `.packages`, and `postCreate.sh` seeds settings and [`mcp/catalogue.json`](../mcp/catalogue.json).

### Other harnesses

[`scripts/install.sh`](../scripts/install.sh) supports Codex (`--user`), Claude Code (`--claude`), OpenCode, Cursor, Gemini CLI, and custom skill directories (`--target DIR`, `--project DIR`, `--copy`, `--uninstall`), with [`instructions/AGENTS.md`](../instructions/AGENTS.md) as the shared routing snippet. The skills are authored harness-agnostically; only the `pi` extensions in `.pi/extensions/` are `pi`-specific.

---

## 2. Complete 32-skill compatibility matrix

All **32 skills** live in [`skills/`](../skills/): **8 user-invoked** (`disable-model-invocation: true`) and **24 model-invoked** (auto-loaded when triggers match, or invoked manually as `/skill:<name>`).

| # | Name | Invocation | Notes |
|---|---|---|---|
| 1 | `handoff` | User (`/skill:handoff`) | Saves under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/handoffs/`. |
| 2 | `implement` | User (`/skill:implement`) | Routes multi-ticket sets to `/orchestrate` and edits to `coder`. |
| 3 | `implement-spec` | User (`/skill:implement-spec`) | Parallel worktree DAG runner by ready frontier; worktree children use `bin/pi-agent-dir` / `bin/pi-wrapped`. |
| 4 | `recall` | User (`/skill:recall`) | Scans `${PI_CODING_AGENT_DIR}/sessions/` + `orchestrator_workspace` peers. |
| 5 | `teach` | User (`/skill:teach`) | Uses `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/learning/<slug>` (or explicit path). |
| 6 | `to-spec` | User (`/skill:to-spec`) | Writes local spec markdown (`docs/specs/`) or named tracker. |
| 7 | `to-tickets` | User (`/skill:to-tickets`) | Ticket YAML frontmatter is the shared contract for `pi`'s `/orchestrate` wave engine. |
| 8 | `verify-app` | User (`/skill:verify-app`) | Writes `<repo-skills-dir>/verify-<app>/SKILL.md` (`skills/` or `.pi/skills/` on `pi`, or `.agents/skills/`). |
| 9 | `add-model` | Model (`add-model`) | Edits `.pi/extensions/opencode-go-provider/models.json`. |
| 10 | `architect` | Model (`architect`) | Pure design-shape check (trace touches, two shapes, deletion & single-owner tests); escalates tradeoffs to `grilling`. |
| 11 | `benchmark-checklist` | Model (`benchmark-checklist`) | 7-question performance vetting checklist; checks `/proc/loadavg` and repeatability. |
| 12 | `blast-radius` | Model (`blast-radius`) | Dependency/impact trace and invariant proof by executing real code. |
| 13 | `commit` | Model (`commit`) | Conventional Commits + `AGENTS.md` branch-base checks (`node tools/branch-base.mjs`). |
| 14 | `devcontainer` | Model (`devcontainer`) | Uses `bin/devc` (`@devcontainers/cli` + Docker) on headless host; unavailable inside managed/cloud environments without Docker. |
| 15 | `diagnosing-bugs` | Model (`diagnosing-bugs`) | Tight red feedback loop, ranked hypotheses, `scripts/hitl-loop.template.sh`. |
| 16 | `github` | Model (`github`) | `gh` CLI workflows + release merge rule (`gh pr merge <n> --merge`, never `--delete-branch`). |
| 17 | `grilling` | Model (`grilling`) | Multi-round design-tree interview; delegates read-only lookups to `explore` subagents. |
| 18 | `idempotent-operations` | Model (`idempotent-operations`) | Convergence, idempotency keys, atomic writes, leases, and guarded migrations. |
| 19 | `in-your-own-words` | Model (`in-your-own-words`) | Pre-work playback of goal, done-when, scope, and assumptions. |
| 20 | `interrogate` | Model (`interrogate`) | Adversarial break-the-change audit requiring executable proof. |
| 21 | `librarian` | Model (`librarian`) | `checkout.sh` caches under `${PI_CODING_AGENT_DIR}/cache/checkouts`. |
| 22 | `native-web-search` | Model (`native-web-search`) | Uses `web_search` tool or `search.mjs` (Brave/OpenRouter/Anthropic/OpenAI-Codex). |
| 23 | `prevent-recurrence` | Model (`prevent-recurrence`) | Encodes repeated fixes at highest ladder rung + `scripts/rule-table.mjs` validation on `AGENTS.md`. |
| 24 | `prove-it-works` | Model (`prove-it-works`) | Real-artifact verification, quality gate, revert check, and honest status vocabulary (`passed`, `failed`, `not_run`, `unavailable`). |
| 25 | `retro` | Model (`retro`) | Harness/check/doc improvement ladder after friction or milestones. |
| 26 | `review-change` | Model (`review-change`) | Separate Spec / Correctness / Standards review axes (`references/smells.md`); pairs with `/review`. |
| 27 | `show-me-your-work` | Model (`show-me-your-work`) | `scripts/log.sh` TSV decision log; fresh-context audit uses a `reviewer` subagent. |
| 28 | `tdd` | Model (`tdd`) | Vertical-slice red-green-refactor loop (`references/tests.md`, `references/mocking.md`). |
| 29 | `tmux` | Model (`tmux`) | Interactive CLI control over private tmux socket (`PI_TMUX_SOCKET_DIR`); keeps clear of `pi-agent-*` subagent sessions. |
| 30 | `update-changelog` | Model (`update-changelog`) | `CHANGELOG.md` `## Unreleased` and major-retention workflow. |
| 31 | `worktree` | Model (`worktree`) | `.worktrees/<slug>` lifecycle; `pi` child runs inside `.worktrees/` must use `bin/pi-agent-dir` / `bin/pi-wrapped`. |
| 32 | `writing-for-agents` | Model (`writing-for-agents`) | Authoring guide for skills, `AGENTS.md`, and pointer docs (`references/skill-mechanics.md`). |

---

## 3. Extensions compatibility matrix

### `pi` extensions (11 in `.pi/extensions/`)

| Extension | Entry point | Purpose |
|---|---|---|
| `subagent` | `.pi/extensions/subagent/index.ts` | Non-blocking tmux-backed delegation, DAG `tasks[]` (`dependsOn`), `subagent_wait`/`status`/`cancel`/`interrupt`/`resume`/`clean`, `subagent_ask`/`answer` escalation, `report.md` artifacts |
| `orchestrator` | `.pi/extensions/orchestrator/index.ts` | Tiered wave runner (`/orchestrate` + `orchestrator_wave`), Pragmatic Orchestrator delegation (`/delegation`, `!direct`), settlement gate (`/gate`), loop breaker, `advisor`, `orchestrator_workspace` / `orchestrator_reserve` locks, typed event bus |
| `btw` | `.pi/extensions/btw/index.ts` | `/btw` off-transcript side question in a tmux popup reusing the active prompt cache |
| `repo-explorer` | `.pi/extensions/repo-explorer/index.ts` | `/explore` interactive branch tree browser & quick-open transcript printer |
| `review` | `.pi/extensions/review.ts` | `/review` isolated `reviewer` subagent dispatch reading `REVIEW_GUIDELINES.md` |
| `answer` | `.pi/extensions/answer.ts` | `/answer` focused TUI extracting questions from the last response |
| `continue` | `.pi/extensions/continue.ts` | `shift+alt+enter` idle-only `continue` prompt shortcut |
| `todos` | `.pi/extensions/todos.ts` | `/todos` TUI and `todo` tool |
| `mcp-catalogue` | `.pi/extensions/mcp-catalogue.ts` | `/mcp-catalogue` installs `mcp/catalogue.json` (Figma, Playwright) into `<agent dir>/mcp.json` |
| `native-web-search` | `.pi/extensions/native-web-search.ts` | Registers `web_search` tool backed by `skills/native-web-search/search.mjs` |
| `opencode-go-provider` | `.pi/extensions/opencode-go-provider/index.ts` | `opencode-go` `/model` provider and usage budget widget |

---

## 4. Pragmatic Orchestrator guardrails on `pi`

The harness implements the **Pragmatic Orchestrator** split in-process: keep conversation, planning, tiny surgical edits, and fast read-only checks on the session model while routing broad search (`explore`), external docs (`research`), heavy edits/tests (`coder`), and non-trivial reviews (`reviewer` / `security-reviewer`) to subagents.

| Dimension | `pi` (`.pi/extensions/orchestrator/delegation-runtime.ts`) |
|---|---|
| **Entry & activation** | Built into `.pi/extensions/orchestrator/index.ts`; active automatically in every parent session (unless `mode === "off"`) |
| **Lifecycle seams** | In-process TypeScript hooks: `session_start`, `session_tree`, `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle`, event bus |
| **Mode control & config** | `PI_ORCHESTRATOR_DELEGATION=enforce\|warn\|off` (default `enforce`), `/delegation [enforce\|warn\|off\|--json]`, `~/.pi/agent/orchestrator-delegation.json`, trusted `.pi/orchestrator.json` `"delegation"` section, `PI_ORCHESTRATOR_DELEGATION_CONFIG` |
| **Single-turn bypass** | Leading `!direct` in prompt (`directPrefix`) |
| **Turn classification & discovery budgets** | 6 modes: `security` (2), `implement` (4), `quick-fix` (4), `debug` (5), `review` (5), `qa` (8) over `read`/`grep`/`find`/`ls` (`before_agent_start` injects `sections.delegation` without replacing `systemPrompt`) |
| **Parent write & shell guard** | Denies `write`; caps `edit` at 1 already-`read` file and `<= 20` changed lines/turn; parent `bash`/`powershell` restricted to read-only allowlist (`ls`, `wc`, read-only `git status\|diff\|log\|show\|rev-parse\|branch\|merge-base\|describe\|fetch`, `gh auth status\|pr\|run\|issue\|release` piped to `head\|tail\|wc\|cat`) |
| **Steer-to-unlock** | 2 `subagent_interrupt`/`subagent_resume` steers across `resumeOf` lineage unlock parent editing for that turn |
| **Model routing enforcement** | `tool_call` blocks explicit `provider`/`model` alongside `role` in `enforce` mode (unless prompt names a model or `!direct`), and patches `provider`/`model`/`thinking`/`tools` in-place from `role` |
| **Verification & review gates** | Tracks parent + child `activitySummary` edits; blocks `git commit`, `git push`, `gh pr create`, `gh pr merge`, and `agent_before_settle` (`settleAttemptCap: 2` or `orchestrator_override`, yielding to `ready_to_commit` waves) until tests pass and `reviewer`/`security-reviewer` succeeds for `>= 2` files or `>= 50` lines (`.md`/`.txt`/`.rst`/`.adoc` exempt) |
| **Worker exemption** | Processes with `PI_ORCHESTRATOR_ROLE=worker` (`isDelegatedWorker === true`) are inert |
| **Telemetry & extras** | `/gate`, settlement gate (`openTodos`, `repeatedFailure`, `verification.command`), loop breaker, `advisor`, `orchestrator_override`, `orchestrator_compact-snapshot` |

For deep dives on the `pi` internals, see [`docs/harness/extensions.md`](harness/extensions.md), [`docs/harness/subagents.md`](harness/subagents.md), [`docs/harness/reviews.md`](harness/reviews.md), [`docs/harness/skills.md`](harness/skills.md), and [`docs/harness/workflow-schema.md`](harness/workflow-schema.md).

---

## 5. Known limitations & unsupported features

- **Project trust boundary:** project-local `.pi/settings.json`, `.pi/mcp.json`, and `.pi/orchestrator.json` (`verification.command`, `advisor`, `delegation` project overrides) are ignored silently until project trust is granted.
- **Worktree duplicate-tool trap:** launching `pi` inside a linked `.worktrees/<slug>` with a package-installed `PI_CODING_AGENT_DIR` exits `1` on duplicate tool registration; always use `bin/pi-agent-dir` / `bin/pi-wrapped` or `.devcontainer/`.
- **`native-web-search` credentials:** requires `BRAVE_API_KEY`, OpenRouter, Anthropic, or OpenAI-Codex auth (`opencode-go` models cannot execute hosted web search).
