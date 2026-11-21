# Competitor harness survey — what shipped by 2026-11

**Method.** `web_search` was not available in this session (no search tool was exposed). Instead I fetched official docs, changelogs, release feeds, and npm/PyPI metadata directly on **2026-11-17**. Every bullet carries the URL it is based on; each section header states the version/date the claim is true as of. Anything not confirmed by an official source is marked **unverified**.

| Harness | Version / date used below |
|---|---|
| Claude Code | v2.1.326, released 2026-11-16 ([release](https://github.com/anthropics/claude-code/releases/tag/v2.1.326)) |
| OpenAI Codex CLI | 0.169.0 npm latest, docs checked 2026-11-17 ([npm](https://www.npmjs.com/package/@openai/codex)) |
| Gemini CLI | v0.68.0, released 2026-11-10 ([release](https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0)) |
| Cursor | no single product version; docs checked 2026-11-17, latest changelog entry 2026-11-06 ([changelog](https://cursor.com/changelog)) |
| Cline | 4.1.26, GitHub release 2026-10-26 ([release](https://github.com/cline/cline/releases/tag/v4.1.26)) |
| Roo Code | v3.54.0, released 2026-05-15 — last release found ([feed](https://github.com/RooCodeInc/Roo-Code/releases.atom)) |
| Aider | v0.86.2, uploaded 2026-02-12 ([PyPI](https://pypi.org/project/aider-chat/)) |
| Amp | docs pages lastModified 2026-08-25…2026-11-14, checked 2026-11-17 ([index](https://ampcode.com/llms.txt)) |
| OpenCode | v2.3.0, released 2026-11-13 ([changelog](https://opencode.ai/changelog)) |
| Hermes Agent | v0.23.2, released 2026-11-16 ([release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.2)) |

---

## Claude Code — v2.1.326 (2026-11-16)

**Agent-facing mechanisms**
- **Checkpoints / rewind.** A checkpoint is captured before each prompt; `/rewind` restores code, conversation, or both, and keeps the 100 most recent snapshots; edits made only by Bash are not tracked. As of v2.1.326 ([checkpointing](https://code.claude.com/docs/en/checkpointing)).
- **Plan mode.** `plan` is a permission mode (`claude --permission-mode plan`, Shift+Tab cycle): reads and classifier-approved commands only, with edits blocked until you approve a plan ([permission modes](https://code.claude.com/docs/en/permission-modes)).
- **Hooks.** `PreToolUse` can block or rewrite a call; events include `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`, `SubagentStart/Stop`, plus command, HTTP, MCP-tool, prompt, and agent hook handlers ([hooks reference](https://code.claude.com/docs/en/hooks)).
- **Agent teams.** Teammates share a task list (pending/in-progress/completed, with dependencies), message each other through per-agent JSON mailboxes, and can approve or reject plans and shutdown requests ([agent teams](https://code.claude.com/docs/en/agent-teams)).
- **Subagents.** Separate context window, configurable model/tools, and a `memory: user|project|local` field that gives a subagent a persistent directory across sessions ([subagents](https://code.claude.com/docs/en/sub-agents)).
- **LSP / code intelligence.** A language-server plugin starts when Claude first edits a matching file, reports newly introduced diagnostics, and exposes a read-only `LSP` tool for symbols ([code intelligence](https://code.claude.com/docs/en/plugins/code-intelligence)).
- **Sandbox / permissions.** OS-enforced sandbox around shell commands only: filesystem allow/deny lists, network via a host-checking proxy; off by default ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- **Cron / loops.** `/loop` converts an interval to cron (or chooses a dynamic 1–60 min delay) and can re-run a skill; cloud "routines" and Desktop tasks are separate ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)).
- **Browser.** Chrome integration lets Claude test web apps, read console logs, and fill forms ([Chrome](https://code.claude.com/docs/en/chrome)).

**Genuinely differentiated.** The combination of a shared task board, direct teammate mailboxes, and plan-approval messages inside one session; plus a very broad hook event surface ([agent teams](https://code.claude.com/docs/en/agent-teams), [hooks](https://code.claude.com/docs/en/hooks)).
**pi takeaway.** Copy the mailbox/task-board model and the "diagnostics introduced by this edit" loop, not the whole multi-process teammate runtime.

## OpenAI Codex CLI — 0.169.0 (docs 2026-11-17)

**Agent-facing mechanisms**
- **Hooks.** Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `PreModelRequest`, `PostModelRequest`, `Interrupt`, `SessionEnd`; `PreToolUse` can deny, and hooks may call MCP tools ([hooks](https://developers.openai.com/codex/hooks)).
- **Sandbox / approvals.** `read-only` and `workspace-write` sandbox modes with `approval_policy`, network off by default in `workspace-write`, and protected `.git`, `.agents`, `.codex`, `.aws` paths ([approvals & security](https://developers.openai.com/codex/agent-approvals-security)).
- **Subagents.** Parallel agents with their own context; local clients can define custom agents with per-agent model, reasoning effort, and instructions, inheriting the parent's model when unset ([subagents](https://developers.openai.com/codex/subagents)).
- **Skills / plugins.** Skills package instructions, resources, and scripts on the agentskills.io standard; plugins can bundle hooks ([skills](https://developers.openai.com/codex/skills), [hooks](https://developers.openai.com/codex/hooks)).
- **Web search.** `codex --search` switches a run to live web search and keeps search activity visible ([CLI](https://developers.openai.com/codex/cli)).
- **Cloud.** `codex cloud` browses/submits cloud tasks and applies the result to the local repo from the terminal ([cloud](https://developers.openai.com/codex/cloud)).
- **Code review.** Dedicated review of uncommitted changes, a commit, or a base branch; reports prioritized findings without modifying the working tree ([code review](https://developers.openai.com/codex/code-review)).
- **Plan mode.** No dedicated plan-mode doc found; docs say to use `read-only` mode "to chat or plan without making changes" — **unverified** whether a separate plan mode exists ([approvals](https://developers.openai.com/codex/agent-approvals-security)).

**Genuinely differentiated.** A crisp sandbox × approval matrix with protected-path defaults, plus hooks that include a separate `PermissionRequest` stage and model-request stages ([approvals](https://developers.openai.com/codex/agent-approvals-security), [hooks](https://developers.openai.com/codex/hooks)).
**pi takeaway.** Copy `PermissionRequest` as a distinct gate from `PreToolUse`; pi currently has one `tool_call` gate.

## Gemini CLI — v0.68.0 (2026-11-10)

> Status: the docs banner says unpaid-tier and Google One users were moved to Antigravity CLI on **2026-06-18**; Gemini CLI is now positioned for Gemini Code Assist Standard/Enterprise and is not tuned for Gemini 4 ([docs](https://geminicli.com/docs/), [README](https://github.com/google-gemini/gemini-cli)).

**Agent-facing mechanisms**
- **Plan mode.** `--approval-mode=plan` or `/plan`; the agent asks clarifying questions, writes a Markdown plan into a plans directory, lets you edit it (Ctrl+X), then approves/iterates; experimental "model steering" lets you redirect mid-plan ([plan mode](https://geminicli.com/docs/cli/plan-mode/), [model steering](https://geminicli.com/docs/cli/model-steering/)).
- **Checkpointing.** Git snapshot in a shadow repo before file-modifying tools; `/restore` reverts the project; snapshots stored under `~/.gemini/tmp/<hash>/checkpoints` ([checkpointing](https://geminicli.com/docs/cli/checkpointing/)).
- **Hooks.** `SessionStart/End`, `BeforeAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `AfterAgent`, `Notification`; `BeforeTool` can block/rewrite, `BeforeToolSelection` can filter tools ([hooks](https://geminicli.com/docs/hooks/)).
- **Subagents.** Each has its own context loop, system prompt, tool allowlist, optional model, and `maxActionsPerTask`; exposed to the parent as a tool of the same name ([subagents](https://geminicli.com/docs/core/subagents/)).
- **Auto Memory.** A background extraction agent reviews past sessions and proposes memory patches and reusable skills; nothing touches active files until you review `/memory inbox` ([auto memory](https://geminicli.com/docs/cli/auto-memory/)).
- **Sandbox / policy.** Container sandbox plus a policy engine for command/tool rules ([sandbox](https://geminicli.com/docs/cli/sandbox/), [policy engine](https://geminicli.com/docs/reference/policy-engine/)).
- **Git worktrees.** Experimental per-session worktrees ([worktrees](https://geminicli.com/docs/cli/git-worktrees/)).

**Genuinely differentiated.** Auto Memory's proposal-and-review inbox, and plan files that the *user* edits before approval ([auto memory](https://geminicli.com/docs/cli/auto-memory/), [plan mode](https://geminicli.com/docs/cli/plan-mode/)).
**pi takeaway.** Copy the "background extractor proposes, foreground user applies" memory flow; it avoids silent memory corruption.

## Cursor — docs 2026-11-17 (changelog 2026-11-06)

**Agent-facing mechanisms**
- **Hooks.** `beforeShellExecution` / `afterShellExecution`, `beforeMCPExecution` / `afterMCPExecution`, `beforeReadFile` / `afterFileEdit`, `beforeSubmitPrompt`, `stop`, `afterAgentResponse` / `afterAgentThought`; command- or prompt-based, with most also supported in cloud agents ([hooks](https://cursor.com/docs/hooks)).
- **Plan Mode.** Clarifying questions, codebase research, a reviewable plan saved as Markdown; Shift+Tab to enter, then "build the plan" ([plan mode](https://cursor.com/docs/agent/plan-mode)).
- **Browser.** Navigate/click/type/scroll/screenshot, console output, and network traffic; cookies persist per workspace ([browser](https://cursor.com/docs/agent/tools/browser)).
- **Subagents.** Own context, custom prompts/tools/models, foreground or background; built-in `Explore` and `Browser` subagents isolate noisy exploration and DOM/screenshot output ([subagents](https://cursor.com/docs/subagents)).
- **Cloud agents / automations.** Isolated cloud VMs, plus scheduled or event-triggered automations from GitHub, GitLab, Slack, webhooks, Linear, Sentry ([cloud agents](https://cursor.com/docs/cloud-agent), [automations](https://cursor.com/docs/cloud-agent/automations)).
- **CLI / ACP.** Terminal agent with interactive and headless modes, and ACP editor integration ([CLI](https://cursor.com/docs/cli/overview)).
- **Checkpoints.** No per-turn filesystem checkpoint/rewind doc was found — **unverified**.

**Genuinely differentiated.** Browser work is pushed into a dedicated subagent with console/network access, and automations span cron plus a wide event bus ([browser](https://cursor.com/docs/agent/tools/browser), [automations](https://cursor.com/docs/cloud-agent/automations)).
**pi takeaway.** Copy "browser as an isolated, context-filtering subagent" rather than exposing raw DOM snapshots to the main loop.

## Cline — v4.1.26 (2026-10-26)

**Agent-facing mechanisms**
- **Checkpoints.** A shadow Git repo commits after every tool use; compare/restore any step without touching the project's Git history; persists across editor sessions ([checkpoints](https://docs.cline.bot/core-workflows/checkpoints)).
- **Plan / Act.** Plan mode reads/searches but cannot edit files or run commands; Act mode executes with the plan context carried over ([plan & act](https://docs.cline.bot/core-workflows/plan-and-act)).
- **Plugins / hooks.** Lifecycle hooks, custom tools, and slash commands; install from file URL, Git, npm, or local path; the TypeScript LSP plugin is the reference example ([plugins](https://docs.cline.bot/customization/plugins)).
- **Subagents.** `spawn_agent` gives each subagent its own context and tools (no MCP tools), allows nesting, and returns only its final reply; approving the spawn approves all its tool calls ([subagents](https://docs.cline.bot/features/subagents)).
- **Multi-agent teams.** Coordinator tools for a shared task board, mailbox, mission log, and outcome fragments; team state persists in `teams.db` per session ([teams](https://docs.cline.bot/sdk/guides/multi-agent-teams)).
- **Cron / scheduling.** `cline schedule create … --cron … --prompt …`; schedules persist across restarts and run independently of a terminal ([scheduling](https://docs.cline.bot/cli/scheduling)).
- **Memory Bank.** A user-authored Markdown hierarchy (`projectbrief`, `activeContext`, `progress`, …) plus "update memory bank" commands, not an automatic memory engine ([memory bank](https://docs.cline.bot/best-practices/memory-bank)).
- **Browser.** Browser use is an auto-approve category and a first-class action/tool ([auto-approve](https://docs.cline.bot/features/auto-approve), [README](https://github.com/cline/cline)).

**Genuinely differentiated.** The SDK-level team primitive (task board + mailbox + outcome merging, persisted per session) and cron-scheduled agents in the CLI ([teams](https://docs.cline.bot/sdk/guides/multi-agent-teams), [scheduling](https://docs.cline.bot/cli/scheduling)).
**pi takeaway.** Cline's team tool taxonomy is a ready-made schema for a pi subagent-messaging extension.

## Roo Code — v3.54.0 (2026-05-15; last release found)

**Agent-facing mechanisms**
- **Orchestrator / Boomerang subtasks.** A built-in Orchestrator mode splits work into subtasks that run in separate contexts and often in a different mode (Code/Architect/Debug); only the final summary returns to the parent ([boomerang tasks](https://docs.roocode.com/features/boomerang-tasks)).
- **Checkpoints.** Shadow Git repository versions workspace files per task; compare and restore without project Git history ([checkpoints](https://docs.roocode.com/features/checkpoints)).
- **LSP diagnostics.** Captures VS Code Problems before/after an edit, reports only *new* diagnostics, and supports `@problems` to pull the full workspace list ([diagnostics](https://docs.roocode.com/features/diagnostics-integration)).
- **Custom tools.** TypeScript/JS tools in `.roo/tools/` or `~/.roo/tools/`, Zod schemas, esbuild transpile; they are auto-approved when the feature is enabled ([custom tools](https://docs.roocode.com/features/experimental/custom-tools)).
- **Worktrees / background editing.** Per-task Git worktrees in separate VS Code windows; background editing suppresses diff pop-ups for uninterrupted work ([worktrees](https://docs.roocode.com/features/worktrees), [background editing](https://docs.roocode.com/features/experimental/background-editing)).
- **Task todo list.** Explicit todo tool for multi-step tasks ([todo list](https://docs.roocode.com/features/task-todo-list)).
- **Freshness.** No release after 2026-05-15 was found; whether development continues is **unverified** ([feed](https://github.com/RooCodeInc/Roo-Code/releases.atom)).

**Genuinely differentiated.** Diagnostics diffing (only newly introduced type/lint errors) and mode-specialized subtasks whose summaries are the only context that returns ([diagnostics](https://docs.roocode.com/features/diagnostics-integration), [boomerang](https://docs.roocode.com/features/boomerang-tasks)).
**pi takeaway.** The "diagnostics before/after edit" filter is small, high-value, and maps cleanly to `tool_result`.

## Aider — v0.86.2 (2026-02-12)

**Agent-facing mechanisms**
- **Repository map.** A tree-sitter symbol map of the whole Git repo is sent with each request; `--map-tokens` (default 1k) bounds it and graph ranking selects relevant portions ([repo map](https://aider.chat/docs/repomap.html)).
- **Architect / editor split.** Architect mode asks one model for a proposal, then an editor model converts it into concrete file edits; `--editor-model` selects the second model ([chat modes](https://aider.chat/docs/usage/modes.html)).
- **Watch files.** `--watch-files` scans one-line `AI!` / `AI?` comments and triggers edits or questions from them ([watch](https://aider.chat/docs/usage/watch.html)).
- **Lint / test loop.** Auto-lints edited files and runs tests, feeding failures back to the model; configurable per language ([lint & test](https://aider.chat/docs/usage/lint-test.html)).
- **Auto-commit / undo.** Each AI edit is committed with a generated message; `/undo` reverts it ([Git](https://aider.chat/docs/git.html)).
- **Limits.** I found no documented hooks, sandbox, subagents, plan-mode, or checkpoint UI; 0.86.2 is the newest PyPI release, with only unreleased model-support notes on `main` ([history](https://aider.chat/HISTORY.html), [PyPI](https://pypi.org/project/aider-chat/)).

**Genuinely differentiated.** The repo map remains a notably compact whole-repo context mechanism, and the architect/editor split is still a clean two-model pattern ([repo map](https://aider.chat/docs/repomap.html), [modes](https://aider.chat/docs/usage/modes.html)).
**pi takeaway.** Implement the repo map as a `read`-adjacent tool plus a `before_agent_start` context injection; add lint/test output as a `tool_result` transform.

## Amp — docs lastModified 2026-08-25…2026-11-14

**Agent-facing mechanisms**
- **Orbs.** Each thread can run on its own cloud sandbox with a clone of the repo; agents can start other agents in other orbs, exchange files, and bring results back ([orbs](https://ampcode.com/docs/orbs), [agent-to-agent](https://ampcode.com/docs/orbs/agent-to-agent), lastModified 2026-08-25).
- **Automations.** Natural-language schedules stored on a thread (one schedule per thread), one-shot or recurring, plus plugin-created webhook endpoints that wake an orb; snoozing keeps runs in the background ([automations](https://ampcode.com/docs/orbs/automations), lastModified 2026-11-14).
- **Plugin hooks.** `session.start`, `agent.start`, `tool.call` (allow / reject-and-continue / modify / synthesize), `tool.result`, `agent.end`, `changes.prompt`; plugins also register tools and commands and can ask the user ([plugins](https://ampcode.com/docs/customize/plugins), lastModified 2026-11-14).
- **Subagents.** `Task` subagent plus Oracle/Librarian/Finder roles, each with its own context; they cannot talk to each other, but the parent can hand a running Task a follow-up task as steering ([models & subagents](https://ampcode.com/docs/models-and-subagents), lastModified 2026-11-12).
- **Permissions.** Amp does not ask for approval before running tools by default; policy is expected to come from a custom plugin ([tools](https://ampcode.com/docs/tools), lastModified 2026-11-05).
- **Boxes.** Always-on computers for deployed apps, with threads started against the live app ([boxes](https://ampcode.com/docs/boxes), lastModified 2026-11-11).

**Genuinely differentiated.** Agent-to-agent delegation across independent orbs with explicit file transfer, and a `tool.call` hook that can *synthesize* a result without running the tool ([agent-to-agent](https://ampcode.com/docs/orbs/agent-to-agent), [plugins](https://ampcode.com/docs/customize/plugins)).
**pi takeaway.** `synthesize` is a stronger primitive than plain block/allow; pi can emulate it by returning a custom tool result from a gated `tool_call` plus a marker for `tool_result`.

## OpenCode — v2.3.0 (2026-11-13)

**Agent-facing mechanisms**
- **Snapshots / undo.** A snapshot before and after each model step; `/undo` stages a rollback of files plus conversation and restores the prompt for editing, `/redo` cancels it; scope is the session's Git worktree, untracked files ≤2 MiB included ([snapshots](https://opencode.ai/docs/snapshots/)).
- **Background subagents.** As of v2.3.0 subagents return immediately, continue in the background, and report back when idle ([changelog](https://opencode.ai/changelog)).
- **Agents / modes.** Built-in `build` (default), `plan` (no normal project edits), `general` and `explore` subagents; custom agents combine prompt, model, permissions, and `mode: primary|subagent|all` ([agents](https://opencode.ai/docs/agents/)).
- **Permissions / policies.** `allow` / `deny` / `ask` rules keyed by action and resource glob, default `ask`; per-agent rules refine global rules ([permissions](https://opencode.ai/docs/permissions/), [policies](https://opencode.ai/docs/policies/)).
- **Tools.** `question` (multiple-choice + free-form), `subagent`, `execute` JavaScript Code Mode, and a `browser` Code Mode namespace (desktop app) with tabs, snapshots, console/network inspection, screenshots, and Lighthouse ([tools](https://opencode.ai/docs/tools/)).
- **Plugins / web.** Server plugins add tools, hooks, commands, and agents; `webfetch` and `websearch` are built-in tools ([plugins](https://opencode.ai/docs/build/plugins/), [web search](https://opencode.ai/docs/websearch/)).

**Genuinely differentiated.** Snapshot-before/after each model step tied to prompt restoration, and background subagents that report back while the parent keeps working ([snapshots](https://opencode.ai/docs/snapshots/), [changelog](https://opencode.ai/changelog)).
**pi takeaway.** `/undo` should restore the prompt text, not just files; pi can pair `ctx.navigateTree` with a file snapshot in `turn_start`/`tool_result`.

## Hermes — Hermes Agent by Nous Research, v0.23.2 (2026-11-16)

**Identity.** This is **Hermes Agent** (`NousResearch/hermes-agent`), Nous Research's terminal/desktop agent with a messaging gateway — not the Hermes model family. I found no separate "Hermes CLI" product; the CLI is `hermes` inside this repo ([README](https://github.com/NousResearch/hermes-agent)).

**Agent-facing mechanisms**
- **Bounded memory.** `MEMORY.md` (2,200 chars) + `USER.md` (1,375 chars), plus `session_search` over past conversations; periodic background review/nudges propose updates ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)).
- **Self-written skills.** Skills use progressive disclosure, are agent-creatable/editable, and follow the agentskills.io standard; a background **Curator** tracks usage, moves stale skills to archive, and optionally runs an LLM consolidation pass ([skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator)).
- **Cron.** One `cronjob_manage` tool handles schedule/list/pause/edit/delete, natural-language or cron timing, per-job model and timezone pins, delivery to chat/files, no-agent script mode, and webhook-triggered jobs ([cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)).
- **Delegation.** `delegate_task` spawns isolated subagents with their own conversation, terminal, toolset, and (optionally) Python kernel; only the final summary returns, and subagents cannot use `clarify` ([delegation](https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns)).
- **Code execution.** `execute_code` runs Python with RPC access to tools and a persistent per-session kernel; subagents get separate kernels ([code execution](https://hermes-agent.nousresearch.com/docs/user-guide/features/code-execution)).
- **Plugins / hooks.** Python plugins register tools, commands, and hooks; the docs list 27 lifecycle events including `pre_tool_call` (can block) and `post_tool_call` ([plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)).
- **Security.** Approval modes (`manual`/`off`/YOLO), a hardline command blocklist, user-defined deny globs, DM pairing/allowlists, and Docker/Modal/Singularity isolation ([security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).
- **Tools / gateway.** `web_search`, `web_extract`, `browser_exec`/CDP, `clarify`, `todo`, `memory`, `session_search`; one gateway covers Telegram, Discord, Slack, WhatsApp, Signal, email, and more ([tools](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools), [bot mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode)).

**Genuinely differentiated.** The closed learning loop (memory nudges + agent-created skills + Curator) and the breadth of delivery surfaces; the 27 lifecycle hooks are among the largest catalogs here ([skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)).
**pi takeaway.** Copy the bounded-memory budget and the Curator's deterministic stale→archive pass; both are small extensions with outsized effect.

---

## What is copyable on pi's extension API

Verified against the installed docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` (read 2026-11-17). Note: the API is **`pi.on(event, handler)`**, not `ctx.on(...)`; handlers receive `ctx`. `pi.sendMessage(message, options)` takes options as the **second** argument.

| Mechanism | pi implementation |
|---|---|
| Checkpoint per turn | `pi.on('turn_start')` + `pi.exec('git', ['stash', 'create'])`; restore with `pi.exec` in a `/rewind` command; mark points with `pi.setLabel`; clean up in `session_before_fork` (`extensions.md` §turn_start, §setLabel; shipped `git-checkpoint.ts` example). |
| Checkpoint navigation | `ctx.navigateTree(targetId, { summarize, label })` in a command handler; `ctx.sessionManager.getTree()/getBranch()/getLeafId()` for the tree (`extensions.md` §ctx.navigateTree, §ctx.sessionManager). |
| LSP diagnostics | `pi.registerTool({name:'lsp', …})` for hover/definition; `pi.on('tool_result')` to append only newly introduced diagnostics after edit/write (`extensions.md` §tool_result, §registerTool). |
| Hooks / policy | `pi.on('tool_call')` to block or mutate input; `pi.on('tool_result')` to patch output; `pi.on('user_bash')` for `!` commands; `pi.on('project_trust')` for trust policy (`extensions.md` §tool_call, §tool_result, §user_bash, §project_trust). |
| Sandbox / permission gate | `pi.on('tool_call')` returning `{block:true, reason}` after `ctx.ui.confirm`; `createBashTool(cwd,{spawnHook})` to rewrite command/cwd/env; `pi.registerFlag` for startup policy (`extensions.md` §tool_call, §createBashTool; shipped `permission-gate.ts`, `bash-spawn-hook.ts`). |
| Plan mode | `pi.registerCommand('plan')` + `pi.registerFlag` + `pi.on('before_agent_start')` to swap the system prompt; `pi.setActiveTools([...])` to remove edit/bash tools; reuse the shipped `plan-mode/` example (`extensions.md` §before_agent_start, §setActiveTools). |
| Question / clarify tool | `pi.registerTool` with `ctx.ui.select/confirm/input/editor/custom` in `execute`; `ui_prompt_start`/`ui_prompt_end` for host status (`extensions.md` §ctx.ui, §ui_prompt_start). |
| Memory (bounded) | `pi.on('session_start')` read memory files; `pi.on('before_agent_start')` inject them; `pi.on('agent_settled')` queue a reflection via `pi.sendMessage(msg,{deliverAs:'followUp',triggerTurn:true})`; persist durable data with `pi.appendEntry` (`extensions.md` §session_start, §agent_settled, §sendMessage, §appendEntry). |
| Skills / curator | `pi.on('resources_discover')` to add skill paths; a `/curator` command can scan `ctx.sessionManager` usage and move stale skills to an archive dir (`extensions.md` §resources_discover). |
| Task graph / todo | `pi.registerTool` for task create/claim/complete; `pi.appendEntry('task', data)` for durable state; `pi.on('turn_start')` to re-inject the open list (`extensions.md` §registerTool, §appendEntry). |
| Subagent messaging | `pi.sendMessage({customType, content},{deliverAs:'steer' or 'followUp' or 'nextTurn'})` (add `triggerTurn:true` only for `steer`/`followUp`); `pi.sendUserMessage(text,{deliverAs:'steer'})`; `pi.events` for inter-extension messages (`extensions.md` §sendMessage, §sendUserMessage, §pi.events; shipped `subagent/` example). |
| Background jobs | No dedicated background-job API is documented; use `createBashTool(cwd,{spawnHook})` or `pi.exec` to start a detached process, then `pi.sendMessage(...,{deliverAs:'followUp',triggerTurn:true})` on completion (`extensions.md` §createBashTool, §sendMessage). |
| Cron / loops | No scheduler hook is documented; keep timers in the extension, or shell out to OS cron/systemd, and wake the agent with `pi.sendMessage(...,{triggerTurn:true})` from `agent_settled` (`extensions.md` §agent_settled, §sendMessage). Absence of a cron API is **unverified** beyond the docs. |
| Web fetch / search | `pi.registerTool` with `fetch(url,{signal:ctx.signal})` and truncation in the result; or `pi.registerMcpServer` to attach a search/browser MCP server (`extensions.md` §registerTool, §registerMcpServer). |
| Browser | `pi.registerTool` wrapping Playwright/CDP, or an MCP browser server; keep DOM/screenshot noise out of the main thread by delegating to a subagent-style `registerTool` that returns a summary (`extensions.md` §registerTool, §registerMcpServer). |
| Session replacement / fork | `ctx.newSession({setup,withSession})`, `ctx.fork(entryId,{position})`, `ctx.switchSession(path)`; gate with `session_before_switch` / `session_before_fork` (`extensions.md` §ctx.newSession, §ctx.fork, §session_before_fork). |
| Compaction control | `pi.on('session_before_compact')` to cancel or supply a custom summary; `pi.on('session_compact')` to observe (`extensions.md` §session_before_compact). |
| Tool exposure / Code Mode | `pi.registerTool` + `promptSnippet`/`promptGuidelines`; `pi.setActiveTools` for dynamic loadouts; `pi.registerToolRenderer` for custom rendering (`extensions.md` §registerTool, §setActiveTools, §registerToolRenderer). |

### Caveats

- No `web_search` tool was exposed; direct fetches may miss features that are documented only behind a search index or JS-only page. Cursor checkpointing and Codex plan mode are the two gaps I would re-check with a browser.
- "Latest release" dates come from npm/PyPI/GitHub metadata on 2026-11-17; alpha/preview releases are excluded unless stated.
- Vendor claims about quality/speed are deliberately omitted; only documented mechanisms are listed.
