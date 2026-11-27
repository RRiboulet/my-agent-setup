# Pi Orchestration Parity and Token Efficiency

## Objective

Bring `pi` to full Pragmatic Orchestrator parity with GitHub Copilot CLI while
eliminating cold-cache prompt bloat, redundant worker spawns, and unrouted
frontier fallbacks.

Today a local `pi` session lacks DBX loopback gateway models, spawns workers
with every extension, skill, and MCP server re-discovered on a cold cache,
injects only a terse delegation cap summary, dumps multi-kilobyte raw subagent
output back into the frontier parent context, and forces a duplicate cold-cache
frontier spawn for post-edit reviews even when the main model can review
directly. Wiring local DBX models with `codemode`-first defaults, enforcing
canonical role routing and minimal worker startup, trimming blocked parent tools
while injecting the full orchestrator persona, returning compact report-first
worker summaries, supporting first-class main-model review verification alongside
`/review`, and verifying nested `codemode` and steer-unlock edge cases will give
`pi` fast, token-efficient, and policy-equivalent orchestration.

## Current behavior

Seven verified conditions exist today:

1. **Local Pi environment (`~/.pi/agent/`) is unconfigured for DBX models and codemode.**
   - `~/.pi/agent/settings.json` contains only `packages: ["../../.copilot/advanced-harness-engineering"]`
     and changelog metadata; `defaultProvider`, `defaultModel`, `defaultTools`,
     and `codemode` are unset.
   - `~/.pi/agent/models.json`, `~/.pi/agent/orchestrator-delegation.json`, and
     `~/.pi/agent/AGENTS.md` do not exist; `auth.json` and `models-store.json`
     are empty `{}` (`pi --list-models` reports `"No models available"`).
   - Meanwhile Copilot CLI (`~/.copilot/providers.json` + `~/.copilot/settings.json`)
     is configured against a local loopback AI gateway
     (`http://127.0.0.1:8793/ai-gateway/...`) with three providers (`dbx` chat
     completions, `dbx-responses` responses API, `dbx-claude` Anthropic
     messages), session model `dbx/model_service.models.1adp-gemini-4-neon`
     (medium effort), and tiered subagent routing: `explore`/`research` →
     `dbx/model_service.models.1adp-deepseek-4-1-flash` (`medium`/`low`),
     `general-purpose`/`task` → `dbx/model_service.models.1adp-gemini-4-hydrogen`
     (`high`/`medium`), `code-review`/`security-reviewer` →
     `dbx/model_service.models.1adp-gemini-4-neon` (`high`).

2. **Delegation is already `enforce` by default, but unrouted subagent calls silently inherit the frontier parent model.**
   - `.pi/extensions/orchestrator/delegation.ts` defaults to `mode: "enforce"`
     with built-in `opencode-go/*` defaults, but `evaluateSubagentCall` skips
     entries without `role` (`if (!hasNonEmptyString(entry.role)) continue`),
     causing `.pi/extensions/subagent/index.ts` (`resolveModel`) to inherit the
     parent's frontier model, thinking level, and full toolset.
   - When a built-in role's default provider has no credentials,
     `evaluateSubagentCall` silently falls back to inheriting the parent model
     (emitting only a warning).
   - In `warn`/`off` mode, a single unknown role in a `tasks[]` fan-out causes
     `evaluateSubagentCall` to return `patches: []`, dropping role routing for
     all valid sibling steps.

3. **Worker processes incur heavy cold-cache startup token overhead.**
   - `buildChildPiArgs` (`.pi/extensions/subagent/handoff.ts`) spawns `pi`
     inside detached tmux without `--no-extensions`, `--no-skills`, `--no-mcp`,
     `--no-prompt-templates`, or `--no-themes`. Every worker re-discovers all
     11 package extensions, all 32 skills (~7.2 KB / ~1,790 tokens of
     frontmatter index), MCP servers, and context files on a cold prompt cache.
   - `handoff: "fork"` transplants the entire parent session branch into the
     child's first prompt.

4. **Parent model lacks a full orchestrator persona and retains blocked tool schemas.**
   - Unlike Copilot CLI's `agents/orchestrator.agent.md` + per-mode directives
     (`orchestrator_guard/policy.json`), Pi's `before_agent_start` injects only
     a ~10-line cap summary (`formatDelegationSection`) into
     `systemPromptOptions.sections.delegation` and fails silently if `sections`
     is unavailable.
   - The parent keeps `write` active even though `enforce` mode always denies
     it, wasting tokens and turns on preventable denials.

5. **Subagent wait/status returns raw output and dead tmux panes into parent context.**
   - `subagent_wait({ id })` calls `runSummary(run, { pane: true, output: true })`,
     dumping up to 18 lines of tmux pane plus up to 50 KB / 2,000 lines of raw
     child output into the frontier parent's context instead of defaulting to
     the parsed `subagent-report` envelope and `report.md` pointer.

6. **Post-edit review gate forces a second cold-cache frontier spawn and misses follow-up edits.**
   - `recordChildSettled` only sets `reviewVerified = true` when a subagent
     with `role` in `{"reviewer", "security-reviewer"}` completes, ignoring
     reviews performed directly by the main frontier model.
   - A small follow-up edit below the file/line threshold after a completed
     review does not reset `reviewVerified`.

7. **Codemode inner calls and steer-unlock parity have untested/incomplete edges.**
   - Pi 1.6.1 dispatches nested codemode `tools.<name>(args)` calls through
     `tool_call` and `tool_result` with `parentToolCallId` set, but
     `delegation-runtime.ts` has no dedicated unit test file verifying nested
     codemode reads/edits/bash/subagent calls or `codemode.mode = "only"`
     reachability of orchestrator tools.
   - Steer-unlock counts `subagent_interrupt` and `subagent_resume` (without
     verifying the run exists) but omits `subagent_answer`.
   - `waitForSubagents` defaults to `false`, and `PI_SUBAGENT_NOTIFY` does not
     trigger a turn, allowing the parent to settle silently while workers are
     live.

## Required behavior

- **RB-1: Local DBX model wiring, `codemode`-first defaults, and generic repo templates.**
  - Local `~/.pi/agent/models.json` registers `dbx` (`openai-completions`),
    `dbx-responses` (`openai-responses`), and `dbx-claude`
    (`anthropic-messages`) pointing to the local loopback gateway
    (`http://127.0.0.1:8793/ai-gateway/...`) with all 7 models, accurate
    `contextWindow`/`maxTokens`/reasoning metadata, and no secrets.
  - Local `~/.pi/agent/settings.json` sets `defaultProvider: "dbx"`,
    `defaultModel: "model_service.models.1adp-gemini-4-neon"`,
    `defaultThinkingLevel: "medium"`,
    `defaultTools: ["+tool_search", "+codemode"]`, `codemode: { "mode": "only" }`,
    preserving `packages`.
  - Local `~/.pi/agent/orchestrator-delegation.json` maps `explore`
    (`deepseek-4-1-flash`, `medium`, read-only tools), `research`
    (`deepseek-4-1-flash`, `low`, read-only tools), `coder`
    (`gemini-4-hydrogen`, `high`), `reviewer` (`inheritModel: true`, `high`,
    read-only + bash), and `security-reviewer` (`inheritModel: true`, `high`,
    read-only + bash).
  - Local `~/.pi/agent/AGENTS.md` is installed via
    `scripts/install.sh --instructions-only ~/.pi/agent/AGENTS.md`.
  - Generic, provider-agnostic example config templates and setup docs are
    added to `advanced-harness-engineering` (with no hardcoded internal loopback
    URLs or credentials).

- **RB-2: Mandatory `role` in `enforce` mode and resilient fan-out patching.**
  - In `enforce` mode (outside `!direct`), `subagent` calls (single or any
    `tasks[]` item) omitting `role` are blocked with a clear denial naming valid
    roles.
  - In `warn`/`off` mode, an unknown role on one `tasks[]` step does not drop
    patches for valid sibling steps.

- **RB-3: Minimal worker process startup to cut cold-cache token overhead.**
  - Worker spawns default to
    `--no-extensions --no-skills --no-prompt-templates --no-themes --no-mcp`
    while explicitly loading `--extension <subagent>` plus any explicitly
    configured worker extensions (so `models.json`-backed providers need zero
    extra extensions, and dynamic provider extensions remain configurable when
    used).
  - Support optional explicit skill opt-in (`skills?: string[]` → repeatable
    `--skill <path>`) for delegated tasks that require specific skills.
  - Keep `handoff: "standalone"` as default; block or require `!direct` override
    for `handoff: "fork"` in `enforce` mode to prevent accidentally re-sending
    the entire parent transcript to a cold worker.

- **RB-4: Full Pragmatic Orchestrator persona, per-mode directives, and parent tool trimming.**
  - Inject the complete Pragmatic Orchestrator role-split persona and
    per-turn-mode directive (matching Copilot CLI's 6 modes) via
    `before_agent_start` `systemPromptOptions.sections`, notifying once if
    `sections` is unavailable.
  - Remove/hide `write` from parent active tools while in `enforce` mode
    (restored under `!direct` or `/delegation off`) so the parent model does
    not waste context or turns attempting blocked writes.

- **RB-5: Compact report-first `subagent_wait` and `subagent_status` output.**
  - Default settled run summaries in `subagent_wait` (`{id}`, `{ids}`,
    `{plan}`) and `subagent_status` to concise structured output (status,
    role/model/usage, parsed `subagent-report` summary or bounded fallback tail,
    `report.md`/transcript paths) without dead tmux panes or multi-kilobyte raw
    output.
  - Support explicit `includeOutput: true` and `includePane: true` opt-ins for
    deep inspection on demand.

- **RB-6: Main-model review as a first-class post-edit gate satisfier alongside `/review`.**
  - Provide a lightweight structured review-recording tool (`record_review`)
    allowing the main frontier model to satisfy `reviewVerified` directly after
    inspecting the diff/files post-edit (`lastReviewEditAt`) and recording a
    passing/accepted verdict with scope and findings summary—avoiding a
    duplicate cold-cache frontier spawn.
  - Preserve `/review` and `subagent({ role: "reviewer" | "security-reviewer" })`
    as an equally valid isolated fresh-context review path; keep one review
    standard without reintroducing `review-triage` or `goal`.
  - Any review-eligible edit occurring after `reviewVerified` was set must clear
    `reviewVerified` regardless of whether that single follow-up edit crosses
    the threshold on its own.

- **RB-7: Verified `codemode` (`mode: "only"`) + `tool_search` guardrail enforcement.**
  - Ensure nested codemode tool invocations (`parentToolCallId` set) pass
    through all delegation `tool_call` and `tool_result` checks identically to
    top-level calls: discovery budgeting, `viewedFiles` recording on `read`,
    write/edit caps, read-only bash allowlist, commit/PR gates, and `subagent`
    role validation/patching.
  - Ensure `orchestrator_override` and `record_review` remain callable from
    codemode scripts when `codemode.mode = "only"`.

- **RB-8: Lifecycle and steer-unlock parity.**
  - Count `subagent_answer` alongside `subagent_interrupt` and
    `subagent_resume` toward the steer-unlock threshold (default 2), only when
    targeting a known run ID.
  - Document and harden live-subagent settlement coordination
    (`waitForSubagents` / settle parking behavior) so the parent does not drop
    active workers unnoticed.

## Non-goals

- Replacing Pi's tmux-backed subagent architecture with in-process subagents.
- Reintroducing retired `review-triage` or `goal` extensions, or creating a
  second review rubric.
- Checking machine-local loopback URLs (`http://127.0.0.1:8793/...`), personal
  auth tokens, or `.pi/orchestrator.json` into `advanced-harness-engineering`.
- Changing Copilot CLI's own `orchestrator_guard` Python hooks or
  `settings.json`.
- Adding a TypeScript build step or `package.json` `scripts`.

## Constraints

- **Dual-harness repo rules (`AGENTS.md`):** Start implementation branch from
  `dev` (not `main`), no `tsconfig.json`/build step, Node strips TypeScript
  directly, `--test-concurrency=8`, and tests live under
  `.pi/extensions/subagent/test/*.test.ts`.
- **No secrets or machine-local URLs in repo:** Never commit secrets or personal
  loopback URLs into tracked repository files.
- **Worker inertness:** `PI_ORCHESTRATOR_ROLE=worker` children must remain inert
  with respect to parent delegation gates.
- **Single cross-extension event contract:** Cross-extension communication must
  stay on the single event bus contract (`.pi/extensions/orchestrator/events.ts`).
- **Worker model/extension compatibility:** `models.json` loading must continue
  working in workers when `--no-extensions` is passed; users relying on
  extension-registered providers (such as `opencode-go`) must still be able to
  allowlist their provider extension for workers.
- **Rule-table integrity:** If a new invariant or rule is added to `AGENTS.md`,
  validate it with `node skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md`.

## Design decisions

1. **Local machine wiring paired with provider-agnostic repository templates.**
   Local DBX gateway endpoints, model catalog definitions, role overrides, and
   `codemode`-only settings belong strictly in the user's local Pi agent
   directory, while the repository ships sanitized, provider-agnostic example
   configurations and documentation illustrating the same layout. Keeping
   loopback URLs and personal routing outside version control prevents
   machine-specific drift across contributors and CI environments.
   *Rejected alternative:* committing loopback provider entries into tracked
   repository settings, which would break non-local users and violate repository
   hygiene constraints.

2. **Strict role presence in `enforce` mode and per-entry patching in fan-outs.**
   In `enforce` mode (outside direct override), omitting `role` on a single
   dispatch or any entry of a parallel fan-out must be rejected immediately with
   a message listing valid canonical roles rather than silently falling back to
   parent-model inheritance. In `warn` and `off` modes, evaluation processes
   each fan-out entry independently so one unknown role warns without discarding
   valid role patches on sibling entries.
   *Rejected alternative:* defaulting omitted roles to `coder` or `explore`,
   which hides caller mistakes and risks misrouting expensive writes or trivial
   searches.

3. **Stripped worker startup flags with explicit extension and skill allowlists.**
   Spawning workers with all auto-discovery disabled by default eliminates
   cold-cache loading of unrelated extensions, the full skill frontmatter index,
   MCP servers, prompt templates, and themes on every delegated turn. Loading
   only the subagent extension (plus an optional list of configured worker
   provider extensions) preserves `models.json`-backed providers with zero extra
   overhead while allowing extension-backed providers to opt in. An explicit
   skill list argument injects only the skills needed for a specific task.
   Keeping `standalone` as the default handoff and gating `fork` behind
   `enforce` denial or direct override stops accidental full-transcript
   transplants into cold workers.
   *Rejected alternative:* keeping full discovery in workers and relying solely
   on prompt caching, which fails on the first turn of every fresh tmux worker
   and across distinct model families.

4. **Complete persona injection and proactive parent tool trimming.**
   Injecting the full Pragmatic Orchestrator persona alongside a per-turn
   directive matching the active mode aligns Pi parent behavior with Copilot
   CLI without requiring users to maintain duplicate instructions; emitting a
   one-time warning when section injection is unavailable avoids silent policy
   degradation. Removing the write tool from active parent tools while in
   `enforce` mode (and restoring it on direct override or when delegation is
   turned off) removes an unusable tool schema from the prompt and prevents
   wasted denial round-trips.
   *Rejected alternative:* leaving the write tool declared on the parent and
   relying only on runtime rejection, which still costs tool-schema tokens and
   invites failed tool calls.

5. **Report-first subagent output with explicit raw-detail opt-in.**
   Settled status and wait responses default to a structured digest containing
   run status, role, model, token/cost usage, the parsed report envelope (or a
   bounded tail fallback when unstructured), and pointers to the persisted report
   and transcript artifacts. Callers needing terminal scrollback or full output
   pass explicit flags to retrieve them on demand.
   *Rejected alternative:* truncating raw stdout/pane dumps with a larger cap,
   which still wastes frontier context tokens on progress chatter and dead tmux
   frames.

6. **Dual-path post-edit review gate with monotonic dirty invalidation.**
   The main frontier model can satisfy the post-edit review requirement directly
   via a lightweight structured `record_review` tool after inspecting post-edit
   diffs or files, recording verdict, scope, and findings summary without
   spawning a second cold-cache frontier process. The existing isolated reviewer
   command and `reviewer` / `security-reviewer` subagent pathways remain equally
   valid and share the same completion state (`reviewVerified`). Any
   review-eligible edit occurring after verification clears `reviewVerified`
   unconditionally, regardless of whether that single follow-up edit exceeds the
   initial multi-file or line-count trigger threshold.

   Prototype schema (for `record_review` tool parameters, clarifying verdict
   and precondition fields):
   ```json
   {
     "verdict": "pass | accepted_with_notes | fail",
     "scope": "string (non-empty description of inspected diff/files)",
     "summary": "string (findings or confirmation of clean review)",
     "inspectedPaths": ["string (optional paths reviewed)"]
   }
   ```
   Only `"pass"` or `"accepted_with_notes"` transitions `reviewVerified` to true,
   and only when post-edit inspection evidence (`viewedFiles` or diff read since
   `lastReviewEditAt`) is present.
   *Rejected alternative:* allowing `record_review` without inspection evidence
   or requiring every small edit to spawn an isolated reviewer subagent, which
   either weakens the gate or wastes frontier startup tokens.

7. **Uniform `codemode` hook parity and explicit tool reachability.**
   Nested invocations emitted by `codemode` scripts with a parent tool call ID
   must traverse the exact same `tool_call` and `tool_result` delegation hooks
   as top-level tool calls so discovery budgets, viewed-file tracking, edit
   caps, read-only bash rules, commit/PR gates, and subagent role routing cannot
   be bypassed inside scripts. Under `codemode` `"only"` mode, `orchestrator_override`
   and `record_review` must remain exposed to `codemode` execution and
   discoverable via `tool_search`.
   *Rejected alternative:* inspecting only top-level tool calls and trusting the
   codemode script wrapper, which would turn `codemode` into a guardrail bypass.

8. **Validated steer-unlock accounting and live-worker settlement awareness.**
   Counting `subagent_answer` alongside `subagent_interrupt` and
   `subagent_resume` toward the steer-unlock threshold closes an asymmetry for
   interactive workers asking questions, while requiring a recognized run ID
   prevents blind counters from unlocking parent edits on bogus IDs. Parking or
   coordinating settlement when live subagents are still running prevents the
   parent turn from finishing and dropping background work silently.
   *Rejected alternative:* unlocking on any status/wait call or ignoring
   `subagent_answer`, which either weakens edit gating or forces callers to
   interrupt instead of answering questions.

## Test seams

- **Pure delegation rules (`.pi/extensions/subagent/test/orchestrator-delegation.test.ts`):**
  Tests `evaluateSubagentCall` mandatory `role` rejection in `enforce` mode,
  resilient per-entry `tasks[]` patching in `warn`/`off` modes, `handoff: "fork"`
  gating, unconditional `reviewVerified` reset on follow-up edits after a
  review, `record_review` verdict and inspection precondition logic, and
  persona plus per-mode directive formatting.
- **Worker spawn arguments and tool allowlists (`.pi/extensions/subagent/test/handoff.test.ts`, `.pi/extensions/subagent/test/subagent-role-tools.test.ts`):**
  Tests `buildChildPiArgs` emitting `--no-extensions --no-skills --no-mcp --no-prompt-templates --no-themes`,
  explicit `--extension` entries, optional repeatable `--skill` arguments,
  `--tools`, and `standalone` default handoff.
- **Compact report-first summaries (`.pi/extensions/subagent/test/subagent-wait.test.ts`, `.pi/extensions/subagent/test/status.test.ts`):**
  Tests `subagent_wait` (`{id}`, `{ids}`, `{plan}`) and `subagent_status`
  returning compact parsed `subagent-report` envelopes and `report.md` pointers
  by default, while honoring `includeOutput: true` and `includePane: true`.
- **Isolated `/review` subagent parity (`.pi/extensions/subagent/test/review.test.ts`):**
  Tests `/review` continuing to dispatch an isolated `reviewer` subagent and
  satisfying `reviewVerified` via settlement without breaking existing command
  behavior.
- **Strict-ESM loading contract (`.pi/extensions/subagent/test/extension-load.test.ts`):**
  Tests zero-side-effect strict-ESM exports for any new tools or helpers added
  to orchestrator or subagent modules.
- **Runtime integration and `codemode` parity (new `.pi/extensions/subagent/test/orchestrator-delegation-runtime.test.ts` using `fake-pi.ts` `createFakeHost()`):**
  Tests `before_agent_start` persona/section injection and one-time warning
  when `sections` is unavailable, parent `write` tool trimming in `enforce`
  mode and restoration under `!direct` / `/delegation off`, nested `codemode`
  `tool_call`/`tool_result` hooks with `parentToolCallId` set across
  read/edit/bash/subagent calls, reachability of `orchestrator_override` and
  `record_review` when `codemode.mode = "only"`, `record_review` integration
  with commit/settle gates, and `subagent_answer` steer-unlock with known run-ID
  validation.

## Acceptance criteria

- [ ] Local `~/.pi/agent/` configures `models.json` (7 models across `dbx`, `dbx-responses`, `dbx-claude`, zero secrets), `settings.json` (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `defaultTools: ["+tool_search", "+codemode"]`, `codemode: { "mode": "only" }`, preserving `packages`), `orchestrator-delegation.json`, and `AGENTS.md`, while generic provider-agnostic templates and docs are added to `advanced-harness-engineering`. (`RB-1`)
- [ ] In `enforce` mode outside `!direct`, single or `tasks[]` `subagent` calls omitting `role` are blocked with a denial listing valid roles; in `warn`/`off` mode, one unknown role in `tasks[]` does not drop role patches for valid siblings. (`RB-2`)
- [ ] Worker spawns default to `--no-extensions --no-skills --no-prompt-templates --no-themes --no-mcp` plus `--extension <subagent>` and any configured worker extensions, support optional `skills?: string[]` (`--skill <path>`), default to `handoff: "standalone"`, and gate `handoff: "fork"` in `enforce` mode. (`RB-3`)
- [ ] `before_agent_start` injects the full Pragmatic Orchestrator persona and per-mode directive into `systemPromptOptions.sections` (warning once if unavailable), and `write` is removed/hidden from parent active tools in `enforce` mode and restored under `!direct` or `/delegation off`. (`RB-4`)
- [ ] `subagent_wait` and `subagent_status` return compact structured report summaries and artifact pointers by default, omitting dead tmux panes and multi-kilobyte raw output unless `includeOutput: true` or `includePane: true` is passed. (`RB-5`)
- [ ] `record_review` lets the main frontier model satisfy `reviewVerified` after inspecting post-edit diffs/files and recording a passing/accepted verdict, `/review` and `reviewer`/`security-reviewer` subagents continue working via one shared rubric, and any post-review edit resets `reviewVerified` regardless of threshold. (`RB-6`)
- [ ] Nested `codemode` tool calls (`parentToolCallId` set) pass through all delegation `tool_call`/`tool_result` checks identically to top-level calls, and `orchestrator_override` and `record_review` remain callable under `codemode.mode = "only"`. (`RB-7`)
- [ ] `subagent_answer` increments the steer-unlock counter alongside `subagent_interrupt` and `subagent_resume` only for known run IDs, and live-subagent settlement coordination (`waitForSubagents` / settle parking) is hardened and documented. (`RB-8`)

## Verification

Run the repository verification suite from `AGENTS.md`:

```bash
node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts
python3 scripts/validate.py
bash scripts/test.sh
node tools/skills-index.mjs --check
node skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
```

Local machine smoke checks for `~/.pi/agent/`:

```bash
# Confirm all 7 dbx / dbx-responses / dbx-claude models are registered
pi --list-models
```

- Start `pi` interactively and confirm `defaultProvider` (`dbx`),
  `defaultModel` (`model_service.models.1adp-gemini-4-neon`),
  `codemode.mode = "only"`, and `delegation.mode = "enforce"` are active.
- Spawn an `explore` worker and confirm it routes to `deepseek-4-1-flash` with
  minimal startup flags (`--no-extensions --no-skills --no-mcp --no-prompt-templates --no-themes`
  plus `--extension <subagent>`) and returns a compact report-first summary.

## Open assumptions

1. **Worker `models.json` loading with `--no-extensions`:** Assumed `pi` core
   reads `~/.pi/agent/models.json` even when `--no-extensions` is passed;
   `medium` risk—confirm during local `pi` smoke test with an `explore` worker
   before finalizing worker flags (owner: implementer).
2. **DBX loopback gateway availability and model IDs:** Assumed the local
   loopback gateway (`http://127.0.0.1:8793/ai-gateway/...`) accepts standard
   `openai-completions`, `openai-responses`, and `anthropic-messages` payloads
   without extra custom headers beyond Copilot CLI's provider config; `medium`
   risk—confirm with `pi --list-models` and a live worker prompt (owner: user /
   implementer).
3. **`waitForSubagents` default / settle parking behavior:** Assumed changing or
   coordinating settlement parking while workers are live does not break
   interactive cancellation or `/orchestrate` wave tests; `low` risk—verify
   against existing orchestrator settle tests (owner: implementer).
4. **Pi 1.6.1 `write` tool hiding mechanism:** Assumed `pi.setActiveTools` or
   the `before_agent_start` / tool-filtering API cleanly removes and restores
   `write` without breaking `codemode` tool lookup when switching into or out
   of `!direct` and `/delegation off`; `medium` risk—verify in
   `orchestrator-delegation-runtime.test.ts` and live `pi` session (owner:
   implementer).
