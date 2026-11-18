# Source reading: three open-source harnesses (2026-11)

**Method.** Read the source, not the marketing. Shallow clones via the `librarian` skill (`checkout.sh <repo> --path-only`), cached under the resolved agent dir's `cache/checkouts/` (`PI_CODING_AGENT_DIR`; on a devcontainer that is the private volume, not `~/.pi/agent/cache/checkouts`).

| Harness | Commit | Date | Language |
|---|---|---|---|
| deepseek-ai/deepseek-harness | `39163dd3` | 2026-11-13 | TS (Cordis plugin tree) |
| QwenLM/qwen-code | `cb3b8135` | 2026-11-17 | TS (Gemini-CLI fork) |
| KooshaPari/KCode (fork of `1jehuang/jcode`) | `de8f3756` | 2026-11-14 | Rust |

Citations are `path:line` from each clone root. Unconfirmed claims are marked **unverified**. Target API: pi
1.5.2 (`@earendil-works/pi-coding-agent/docs/extensions.md`).

---

## 1. DeepSeek Harness

**Tool surface.** No fixed list — the base bundle mounts tool *packages*
(`packages/bundle/base/cordis.patch.yml:281-340`): `bash`/`pwsh` (platform-disabled), `jobs`, `fs`
(read/write/edit, optional `apply_patch` off by default), `fs-search` (glob/grep), `skill`, `todo`, `goal`,
`web`, `subagent`, `workflow`, `tool-working-directory`. Registration is `ctx.tools.register(defineTool({...}))`
(`packages/core/tools/src/schema.ts:555`). Gating is **computed, not searched**: `ToolRestriction {allow, deny}`
intersects the global mask with every ancestor scope, then overlays the scope's *own* registrations, which are
exempt so a delegated child keeps the tools it answers through (`docs/subsystems/tools.md:165`,
`packages/core/tools/src/contracts.ts:395`). No deferred loading or tool search.

**Plugin architecture.** Everything is a plugin, loop included: *"Every part of the product is a plugin,
including the model adapter, the tool registry, the session log, and the agent loop itself, so each is
replaceable from configuration"* (`docs/architecture.md:9`). Three disjoint hook domains
(`docs/architecture.md:69-73`): waterfall events (`tools/pre-execute`, `tools/post-execute`, `tools/execute`,
`agent/pre-step`, `agent/request`, `llm/stream`), serial events (`agent/turn-stopping`), and durable session
events (`turn/*`, `tool/*`). Permission is `allow|deny|ask` pre-policy → approval service → a **monotonic
`ToolGuard`** that can only deny: *"Because guards have no allow result, listener ordering cannot turn a denial
back into permission"* (`contracts.ts:402-410`). Sandbox is fail-closed — `confine()` rejects with
`SANDBOX_UNAVAILABLE` rather than run unconfined (`packages/sandbox/sandbox-local/README.md:57`).

**Context management.** Four independent, mountable layers: **spill** — oversized results become head/tail + a
locator with retrieval guidance, `maxInlineTokens: 12500` (`packages/spill/spill-policy/src/index.ts:134`);
**tool-result pruner** — `thresholdChars: 8192`, head 4096/tail 1024, marker `[... tool result middle pruned
...]` (`packages/compaction/compaction-tool-result-pruner/src/config.ts:7`); **image offload** — an over-budget
image request replaces the oldest images with text placeholders and retries; **session checkpoints** — a durable
write before each model request and top-level dispatch, fail-closed (`packages/session/session-checkpoint-policy/README.md:12`). Also: background jobs whose completion wakes an idle agent on a follow-up turn
(`packages/jobs/tool-jobs/README.md:12`), a **persistent** bash whose cwd/vars/functions survive calls
(`packages/shell/tool-bash-persistent/README.md:12`), and PTC — the model writes TS calling tools, with
`run_code` the only directly callable tool (`packages/core/tool-executor-ptc/README.md:12`).

**What it deliberately does not do.** Plan mode does not restrict tools — *"every tool remains available, so use
sandbox mode and approval prompts for enforced limits"* (`packages/plan/plan-mode/README.md:12`). A withdrawn
PTC executor never falls back to native tools. No semantic tool search. Philosophy: *"everything-is-a-plugin"*
on Cordis, trading a stable internal API for total replaceability — the README warns "THERE WILL BE
COMPATIBILITY-BREAKING CHANGES" (`README.md:7,13`).

**Top 3.** (1) **Repeat-call reminder**: per-agent chain of `(tool, canonical-args)` keys, advisory nudges at
`[3, 5, 8]`, cleared by a new user message (`packages/guard/repeat-tool-reminder/src/index.ts:53,apply()`). →
`pi.on("tool_result")` + `pi.sendMessage({customType:"repeat-guard"}, {deliverAs:"steer"})`; ~60 LOC. (2)
**Head/marker/tail pruner** as a `pi.on("tool_result")` patch returning `{content}`. (3) The **monotonic guard**
as a pi *convention*: hard rules in `tool_call` that return only `{block:true}` or `undefined` — pi's chain has
no allow/deny lattice, so the discipline is "deny-only handlers, loaded last".

**Measured on this host, 2026-11-18: (1) is withdrawn.** Its key is
`(tool, canonical-args)` over every tool, so a bash-only count is not enough:
measured that way, within one user-message segment, a streak of 3 fires in **9 of
124 sessions** — but every fire is `subagent_status` polling (4 sessions) or a
`codemode` call wrapping the same poll (5), 698 repeated calls, worst 640 on one
run id. That is the traffic `subagent_wait` (#163) replaced, so the reminder
would nudge a loop the harness has already removed; after #163 it has no workload
left. The Kimi ladder (the other Top 3, below) was withdrawn on the same
measurement. See
[`2026-11-harness-advancements.md#correction-candidate-07-was-measured-and-withdrawn-2026-11-18`](2026-11-harness-advancements.md#correction-candidate-07-was-measured-and-withdrawn-2026-11-18).

---

## 2. Qwen Code

**Tool surface.** ~35 built-ins (`packages/core/src/tools/`) but **deferred by default**: tools declare
`shouldDefer` (`tools/tools.ts:320`) and only a curated core set enters the initial function-declaration list.
`ToolSearch` resolves hidden tools by `select:Name1,Name2` or scored free text and returns the schema for the
`ToolCall` bridge (`tools/tool-search.ts:8-20`, weights `:72-77`); factories are lazy-resolved on first use
(`tools/tool-registry.ts:238`). Visibility is then filtered per context — plan mode, subagent depth, leader-only
— in `isToolExcludedForCurrentContext` (`agents/runtime/subagent-plan-tool-policy.ts:286`).

**Plugin architecture.** Not a kernel — a Gemini-CLI fork with an **external-process hook system**: 20+ events
(`packages/core/src/hooks/types.ts:24-66`) — `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`,
`UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `MessageDisplay`, `SubagentStart/Stop`,
`PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `TodoCreated/Completed`,
`SessionStart/End/Delete` — with four executor types: `command` (JSON on stdin), `http`, `function`, and
**`prompt`** (an LLM judges the hook and returns a decision) (`docs/users/features/hooks.md`). The loop is
**not** replaceable; extension points are hooks plus `packages/core/src/extension/` (packaging, Claude/Gemini
extension conversion). Permissions: five modes, Auto being a **two-stage LLM classifier** — stage 1
`{shouldBlock}` only, ~300 ms, `max_tokens=256`; stage 2 chain-of-thought review only to rescue stage-1 false
positives (`permissions/classifier.ts:6-14`), with hard allow/deny rules settled before the classifier sees the
call (`docs/users/features/auto-mode.md:16-31`).

**Context management.** `microcompactHistory()` (`services/microcompaction/microcompact.ts:793`) replaces old
tool results with `[Old tool result content cleared]` (`:14`) over a fixed `COMPACTABLE_TOOLS` set (`:40`), no
model call, triggered by characters or by a **wall-clock idle gap** (`evaluateTimeBasedTrigger`, `:299`, default
60 min). Compaction slims its own input (`compactionInputSlimming.ts`) and keeps a retained tail (`retained-compaction-tail.ts`). Rollback: `FileHistoryService` snapshots every touched file with diffs and `MAX_SNAPSHOTS`
(`services/fileHistoryService.ts:689`). Memory is a whole subsystem — `remember`/`recall`/ `forget`, an
extraction agent, a **"dream"** consolidator (`src/memory/dream.ts`, `extract.ts`). Orchestration: task list
(`task-create/list/update/stop`), Agent Teams, Agent Arena (same task on several models in worktrees), Dynamic
Workflows (model writes JS calling `agent()`/`parallel()`/`pipeline()`, `tools/workflow/workflow.ts:8`), and
Goals — loop until an **independent verifier** accepts the model's completion claim
(`docs/users/features/goals.md`).

**What it deliberately does not do.** No replaceable loop, no in-process plugin kernel; hooks are configuration,
not code, and must be trusted (project hooks run only under explicit approval or folder trust,
`docs/users/features/hooks.md:39`). No portable OS sandbox of its own. Philosophy is breadth: *"Qwen Code ships
with a complete agent harness — multi-agent orchestration, persistent memory, and deep extensibility, all built
in"* (`README.md:167`); after v0.1 *"we stopped syncing with upstream and began independent development"*
(`README.md:240`).

**Top 3.** (1) **Microcompaction** → `pi.on("context")` returning `{messages}` with old tool results replaced by
a placeholder, keeping the last N; the idle-gap trigger is the interesting half. (2) **Two-stage classifier**
for bash approval → `pi.on("tool_call")` + `ctx.modelRegistry.getModelOfType(...)/classify()`. (3) **The
`prompt` hook executor** — pi has no LLM-judged policy gate; ~40 LOC inside `tool_call`.

---

## 3. KCode (jcode fork)

**Not the user's KCode.** KooshaPari/KCode below is an incidental side-find — a Rust fork of `1jehuang/jcode`, read before the
real target — kept because its mechanisms are good, not because it is Kimi Code — the real Kimi Code section follows.

**Tool surface.** `base_tools()` registers ~32 tools at startup (`crates/jcode-app-core/src/tool/mod.rs:373-500`): `read`, `write`, `edit`, `replace`, `apply_patch`, `ls`, `bash`, `agentgrep`,
`webfetch`, `websearch`, `batch`, `bg`, `todo`, `memory`, `session_search`, `conversation_search`,
`skill_manage`, `swarm`, `codemode`, `jcode_docs`, `schedule`, `selfdev`, plus `mcp`/`mcp_search`/`mcp_call`.
Deferral is its own crate: phase 1 loads only tool *names*, phase 2 keyword-ranks and lazily caches descriptions
(`crates/jcode-tool-search/src/lib.rs:1-27`). Per-session gating is an overlay — `allowed_tools` ∩
not-`disabled_tools`, with per-(server,tool) MCP grants lifting a blanket `mcp` deny (`tool/mod.rs:173-232`).

**Plugin architecture.** No plugin API; hooks are external commands in `~/.jcode/config.toml`: `turn_end`,
`session_start`, `session_end` (observers, fire-and-forget), `pre_tool` (gate), `post_tool`,
`post_tool_feedback` (stdout fed back to the model), env `JCODE_HOOK_*`, 16 KB JSON payload, and
`JCODE_HOOKS_DISABLED=1` as a recursion guard for nested agents (`docs/HOOKS.md`). The binary is monolithic by
design — *"Every other crate is a leaf in the compile graph"* (`ARCHITECTURE.md:11`). Permissions are the best
part: a **deterministic blast-radius classifier** (`crates/jcode-command-risk/src/lib.rs:1-45`) with
`Safe|Low|Confirm|Catastrophic` (`:52-64`) and a **reflection gate** instead of an LLM judge — `Confirm` refuses
once and demands a `justification` of ≥25 chars that is not a bare affirmation (`src/gate.rs:1-30,75`);
`Catastrophic` (home, `/`, credential stores) is an absolute path-based deny (`src/paths.rs:12`), wired beside
the schema that declares the field (`tool/bash_destructive_gate.rs:10`).

**Context management.** A **context guard** runs before a result reaches the transcript (`tool/mod.rs:1184`): if
it would cross a fraction of the window or exceed `SINGLE_OUTPUT_MAX_TOKENS = 50_000` (`:968`), it is *withheld*
and replaced by `⚠️ OUTPUT WITHHELD: … ~Nk tokens (P% of the budget …)` naming the price and every cheap fix,
with `accept_large_output: true` to spend it anyway (`:1005-1010`); once the window is full it refuses outright
and points at `/compact` (`:1234`). Micro-compaction is a crate (`crates/jcode-micro-compact/src/lib.rs:1-20`)
with a cached path and 60 s TTL. Subagents get a **permission bubble**: `build_forked_messages` builds the child
with a byte-identical leading prefix so parent and child share prompt-cache hits, plus a `ForkDepthGuard` and a
10-rule child template (`crates/jcode-permission-bubble/src/lib.rs:1-25`). Every tool schema centrally gains a
required `intent` string and an `accept_large_output` escape hatch in `ensure_intent_in_schema` (`crates/jcode-tool-core/src/lib.rs:48`).

**What it deliberately does not do.** No plugin kernel, no runtime-loaded extensions, no MCP tool flattening,
and — explicitly — **no LLM judge in the safety path**: *"An LLM judge is expensive, adds latency to every
borderline call, and can be talked around by the same reasoning that produced the command… Instead the harness
refuses once and hands back a structured prompt that forces the generating model to do the thinking it skipped"*
(`src/gate.rs:6-20`); and *"This is defense in depth, not a sandbox"* (`lib.rs:31`). Philosophy is resource
minimalism — *"The most RAM efficient harness"* (`README.md:30`), one binary, a `OnceLock` tool map cloned by
refcount (`tool/mod.rs:373`).

**Top 3.** (1) **Context guard with priced withholding** → `pi.on("tool_result")` + `ctx.getContextUsage()`; the
50k cap and the "no room left → refuse, say `/compact`" branch are the valuable halves. (2) **Destructive-command reflection gate** → override `bash` (pi lets an extension replace a built-in by registering the same
name, `extensions.md:2360`; `createBashToolDefinition()` is exported) to add `justification`, and port only the
subset that matters: catastrophic path set + `rm -rf`/`dd`/`shred`/`truncate`/`find -delete`/`git clean -fdx`/
redirection-to-device. (3) **`intent` on every call** — same override, rendered by `renderCall`, doubles as the
gate's audit line.

---

## Ranked: value ÷ cost for a bash-heavy single-user harness

Value = how much it fixes a real failure mode here (long bash sessions, huge outputs, loop locks). Cost = LOC +
risk in pi 1.5.2.

| # | Mechanism | Copy from | pi mapping | V | C | V/C |
|---|---|---|---|---|---|---|
| 1 | Repeat-call reminder (**withdrawn 2026-11-18**; fires only on #163's polling) | `guard/repeat-tool-reminder/src/index.ts:apply()` (DS) | `pi.on("tool_result")` + `pi.sendMessage(...,{deliverAs:"steer"})` | 9 | 1 | **9.0** |
| 2 | Head/marker/tail pruner | `compaction-tool-result-pruner/src/index.ts:pruneContent()` (DS) | `tool_result` patching `{content}` | 6 | 1 | **6.0** |
| 3 | `intent` on every call | `jcode-tool-core/src/lib.rs:48` (KC) | bash override, `renderCall` | 5 | 1 | **5.0** |
| 4 | Deny-only guard layer | `contracts.ts:402 ToolGuard` (DS) | convention: deny-only `tool_call` handlers, loaded last | 5 | 1 | **5.0** |
| 5 | Clear old tool results | `microcompact.ts:microcompactHistory()` (QW) | `pi.on("context")` → `{messages}` | 9 | 2 | **4.5** |
| 5a | Repeat-breaker ladder (**withdrawn 2026-11-18**; was: build instead of #1) | `toolDedupe/toolDedupeService.ts:390-430` (KM) | `tool_result` + `sendMessage({deliverAs:"steer"})` + `terminate` | 9 | 2 | **4.5** |
| 6 | Withhold + price oversized results | `tool/mod.rs:1184 guard_context_overflow()` (KC) | `tool_result` + `ctx.getContextUsage()` | 8 | 2 | **4.0** |
| 6a | Compaction handoff brief | `fullCompaction/compaction-instruction.md:6-45` (KM) | `pi.on("session_before_compact")` → `{compaction}` | 7 | 2 | **3.5** |
| 6b | Session-scope approval rules w/ arg patterns | `policies/session-approval-history.ts:12-31` (KM) | `tool_call` + `ctx.ui.select` + rule match | 6 | 2 | **3.0** |
| 7 | Fork child, byte-identical prefix | `jcode-permission-bubble/src/lib.rs` (KC) | `ctx.fork(entryId)` for subagent launch | 7 | 3 | **2.3** |
| 8 | Destructive-command reflection gate | `jcode-command-risk/src/{lib,gate,paths}.rs` (KC) | bash override + `justification` | 10 | 5 | **2.0** |
| 9 | Persistent shell (cwd/vars survive) | `shell/tool-bash-persistent` (DS) | bash override over one long-lived PTY | 7 | 4 | **1.75** |
| 10 | `prompt` (LLM-judged) policy hook | `hooks/promptHookRunner.ts` (QW) | nl-policy inside `tool_call` | 4 | 3 | **1.3** |
| 11 | Two-stage classifier for bash | `permissions/classifier.ts:6` (QW) | `getModelOfType(...)`/`classify()` in `tool_call` | 5 | 4 | **1.25** |
| 12 | Background jobs + wake notice | `jobs/tool-jobs` (DS) | 3 `registerTool`s + `sendMessage({triggerTurn:true})` | 6 | 5 | **1.2** |

Build 2, 5 and 6 first: three standalone extensions, none touches pi core. (1 is
withdrawn on this workload's trigger rate — see the notes above; so is 5a.)

## Already in pi 1.5.2 — do not port

- **Deferred tools + search** (QW `ToolSearch`, KC `jcode-tool-search`): pi has `exposure:"deferred"` and a built-in `tool_search` that activates on match (`extensions.md:2661,2764-2770`).
- **Programmatic tool calling** (DS PTC, QW code-mode, KC `codemode`): pi's `codemode` + `ctx.executeTool()` with `parentToolCallId` nesting and usage rollup (`extensions.md:2786-2798`).
- **Spill bash output to a file with a locator**: pi's bash already returns `full_output_path` (seen in this session's schema; not confirmed in prose docs — **unverified**).
- **Session fork / rewind** (QW `FileHistoryService`): pi has `/tree`, `ctx.fork`, per-entry session files (`extensions.md:1383`) — and it is cheaper than copying every touched file.
- **`post_tool_feedback`** (KC): `pi.on("tool_result")` already returns replacement content.

## Unverified

- Whether pi's bash writes full output to disk on *every* truncation path (`full_output_path` appears in the tool schema, not in `extensions.md` prose).
- deepseek PTC runtime internals (`ptc-runtime`) — only the executor README was read.
- Whether a `bash` override can *extend* `bashSchema` and still type-check; the safe path is a new tool name plus `pi.setActiveTools()`.
- KCode swarm/ambient scheduling — read at README level only.

---

## Kimi Code (MoonshotAI/kimi-code)

Read at `2931c7ef` (2026-11-17), the maintained successor to the archived `kimi-cli`: a TypeScript pnpm monorepo where
`packages/agent-core-v2` is the DI × Scope engine and `packages/core` the DI-free loop/LLM/tool runtime. Citations below are
relative to `packages/agent-core-v2/src/` unless a repo-root path is given.

**Tool surface.** 23 documented built-ins plus gated `select_tools`, 4 `*Goal` and 13 `Tower*` tools — each contributed by the feature module that owns it rather than one registry file: `Read`/`Write`/`Edit`/`Grep`/`Glob` (`agent/tools/os/{read,write,grep,glob}/*Tool.ts:745,164,362,345`), `ReadMediaFile` (`agent/tools/read-media-file/read-media-file.ts:3`), `Bash` (`agent/tools/os/bash/bashTool.ts:520`), `WebSearch`/`FetchURL` (`web-search/webSearchTool.ts:117`, `fetch-url/fetchUrlTool.ts:79`), `TodoList` (`features/todo/todoFeature.ts:13`), `Agent` (`agent/tools/agent/agentTool.ts:806`), `AgentSwarm` (`features/swarm/swarmFeature.ts:24`), `AskUserQuestion` (`agent/tools/ask-user-question/askUserQuestionTool.ts:255`), `NotifyUser` (`features/notify/tools/notify-user/notify-user.ts:6`), `Skill` (`features/skill/skillFeature.ts:17`), `ExitPlanMode` (`features/plan/tools/exit-plan-mode/exitPlanModeTool.ts:22`), `TaskList/Output/Stop/WaitFor` (`agent/tools/task/*/*Tool.ts:62,136,72,407`), `Cron*` (`features/cron/cronFeature.ts:17-19`), `*Goal` (`features/goal/goalFeature.ts:28-40`), `Tower*` (`features/tower/towerFeature.ts:50-62`).
Four gates stack: a **model capability** gate (`dynamically_loaded_tools && tool_use`) *and* the `tool-select` flag must both hold
before `select_tools` exists at all (`agent/toolSelect/toolSelectService.ts:113-119`, `agent/toolSelect/flag.ts:6-13`); per-agent
`activeToolNames`/`disallowedTools` intersected with a session `disabledTools` gate (`agent/toolActivation/toolActivationService.ts:66-73`);
and per-environment availability (`agent/toolActivation/toolAvailability.ts`). Only MCP schemas are ever deferred — "Keep MCP tool schemas
out of the immutable top-level tools[]" (`toolSelect/flag.ts:9-10`) — all built-ins are declared always. Gated tools do not vanish
silently: a call gets "unavailable because…" text instead of a schema error (`toolSelectService.ts:91-100`).

**Deferred loading mechanics.** `select_tools` is not just search: the harness injects *announcements* carrying a `revision` and a `snapshot`/`delta` disclosure record, so the model learns what became loadable without re-sending every schema, and `shapeHistory()` rewrites those messages — dropping the `select_tools` calls outright — for models without the capability (`agent/toolSelect/toolSelect.ts:20-36,74-88`, `agent/toolSelect/dynamicTools.ts:45-80`). Load results are typed and counted — `alreadyAvailable`, `alreadyCallable`, `staleLoaded`, `policyDenied`, `unknown`, `escalated`, `consecutiveFailures`, `suggestions` — so a wrong name comes back with candidates instead of an error (`agent/toolSelect/toolSelect.ts:38-50`).

**Hooks and the loop.** Two unrelated systems share the name. *Internal*: a 6-member tool pipeline `validating`/`starting`/`permitting`/`beforeExecute`/`afterExecute` plus an `observe` tap, open to any Feature (`packages/core/src/tool/runtime/types.ts:204-219`); loop hooks `onWillBeginStep`/`onDidFinishStep`/`onBeforeSubmitPrompt` (`agent/loop/loop.ts:329-335`); `fullCompaction.hooks.onWillCompact` (`agent/fullCompaction/fullCompaction.ts:29-31`). *External*: 20 TOML events (`docs/en/customization/hooks.md:114-133`), JSON on stdin, exit `0`/`2`/other, and **fail-open** — "Even if the script errors or times out, the CLI will not interrupt your work" (`hooks.md:20`), with the warning that hooks "should not be used as the sole security barrier" (`hooks.md:23`). Hooks are user-config-only, never project-scoped, so a checked-out repo cannot inject one (`hooks.md:55`), and they always run on the local machine, not the remote target (`hooks.md:57`). The loop is not a plugin but *is* swappable: `IAgentLoopService` is a DI service and `Feature` exposes `contributeService`/`contributeTool`/`contributeCommand` (`features/feature.ts:65,88,99`); no in-repo code replaces it.
Permissions are an **ordered list of 13 small named policies** returning `approve|deny|ask`, first non-`undefined` wins
(`agent/permissionPolicy/permissionPolicyService.ts:38-65`), and an `ask` may carry `resolveApproval` to keep adjudicating after the user
answers (`agent/permissionPolicy/types.ts:41-63`). The order *is* the policy: user deny → dangerous-command ask → auto-mode approve →
session history → user ask/allow → sensitive file → git control path → yolo approve → default approve → fallback ask, which is exactly how
the lenient `yolo` mode still asks before `.env` or `rm -rf`. Naming trap: `yolo` = "Ask When Needed", `auto` = "Never Ask" — the
dangerous-command policy returns early in `auto` yet still asks in `yolo` (`policies/dangerous-command-ask.ts:131-137`), and it is not
registered at all in non-interactive runs (`permissionPolicyService.ts:42-44`). Bash risk is a real parse, not a regex:
tree-sitter-bash under `{timeoutMs:500, maxNodes:10_000}`, nested `bash -c`/`eval`/`busybox` unwrapped to depth 4, and any operand
containing `$`, backtick, `*`, `?`, `[`, `~` degrades to `unanalyzable` → ask (`policies/dangerous-command-ask.ts:15-19,240-260,352-372`,
`AGENTS.md:30`). No OS sandbox: "Worktrees isolate writes, but they are not a security sandbox" (`docs/en/guides/tower.md:131`).

**Context.** Compaction is one model-written handoff: `triggerRatio 0.85`, `reservedContextSize 50_000`, `maxRecentMessages 4` (`agent/fullCompaction/strategy.ts:18-28`), driven by a 74-line instruction that forbids rigid headings, demands the exact commands, paths and error text, names the gaps, and invests in a forward plan — "Right now you hold more context on this task than you ever will again" (`agent/fullCompaction/compaction-instruction.md:6-45`). Tool output is capped at `DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000` (10 MB retention ceiling), reshaped to head 4 096 / tail 1 024 chars with a `[...truncated]` marker and a spill file; a reminder appended later to that same result is also appended to the spill suffix (`agent/toolResultTruncation/toolResultTruncationService.ts:24-32`, `agent/tool/toolContract.ts:7-15`). Undo is turn-granular, stops at the last compaction, and rolls back *derived* state (todos, plan mode) through an undo-participant registry (`docs/en/reference/slash-commands.md:37`, `agent/undo/undoService.ts:9-11`). Session storage is an append-only `wire.jsonl` per agent with `agent.switched` branch edges — i.e. a tree — so resume, fork and undo all read one journal (`wire/tree/tree.ts:3-37`, `docs/en/guides/sessions.md:15-25`). Orchestration has three tiers: `Agent` (isolated context, 2 h timeout, background with synthetic result delivery), `AgentSwarm` (`{{item}}` template → N subagents, cap 128), `Tower` (mission = branch + worktree + mandatory independent reviewer + gated merge). Delegation always terminates: built-ins cannot spawn subagents without an explicit allowlist opt-in (`docs/en/customization/agents.md:19`).

**Kimi-specific.** Progressive disclosure is *capability*-gated, not harness-gated: the model decides whether to pay for MCP schemas (`agent/toolSelect/flag.ts:9-10`). K3 exposes thinking *efforts* `low|high|max` with per-alias `default_effort`/`off_effort`, and users mint variants of one model at different efforts to route subtasks (`docs/en/configuration/config-files.md:41-42,252-282`). Video is a first-class input (`ReadMediaFile`, 100 MB, `docs/en/reference/tools.md:36`). Five UI surfaces — TUI, `kimi web`, desktop, VS Code, and ACP/stdio for Zed/JetBrains (`docs/en/reference/kimi-acp.md`) — plus remote execution as a self-contained NDJSON `exec-server` RPC (`AGENTS.md:28`). The TUI is a vendored pi library: "Our TUI is built on top of `pi-tui`" (`README.md:122`, `packages/pi-tui/package.json:2`). Plan, goal, swarm and Tower are mutually exclusive by construction: a `modeMutex` service exits one mode when another is entered (`agent/modeMutex/modeMutexService.ts:27-40`).

**Philosophy.** Product: "The Starting Point for Next-Gen Agents" (`docs/en/index.md:5`), "Single-binary distribution", "Blazing-fast startup. The TUI is ready in milliseconds", "Purpose-built TUI … optimized end to end for long, focused agent sessions" (`README.md:55-57`). Engineering, from the repo's own agent guide: "Think from first principles… Treat code, not documentation, as the source of truth" (`AGENTS.md:9-10`) — which is why behaviour is configured through `config.toml` + DI rather than a public extension SDK. Half-built work is flag-gated off by default under `KIMI_CODE_EXPERIMENTAL_*` (`AGENTS.md:66`).

**Top 3** (rows 5a/6a/6b in the ranking table). **Do not build (1): it was measured against this workload and withdrawn — see the note at the end of this section.** (1) **Repeat-breaker ladder** — a `(tool, canonical-args)` streak appends an in-band `<system-reminder>` to the result at 3 / 5 / 8 ("state what new information you expect", then "pick one: falsification test, missing input, or conclude", then "write your final response now, no further tool calls"), and at 12 injects that text as a user message and stops the turn as `repeat_breaker` (`agent/toolDedupe/toolDedupeService.ts:36-68,390-430`, `agent/toolDedupe/toolDedupe.ts:18`) → `pi.on("tool_result")` returning patched `{content}` + `pi.sendMessage({customType:"repeat-breaker"},{deliverAs:"steer"})` for the escalation, while the stop is `pi.on("tool_call")` → `{block:true, terminate:true}` (`extensions.md:987,1627`). (2) **Compaction as a handoff brief** — port `compaction-instruction.md` wholesale and run the summary in `pi.on("session_before_compact")`, which may return `{compaction:{summary,firstKeptEntryId,tokensBefore}}` (`extensions.md:534-562`); the prompt, not the code, is the asset. (3) **Session-scope approval rules with argument patterns** — each execution carries an `approvalRule` + `matchesRule`, an approval may answer `{scope:"session"}`, and the resulting `session-runtime` rule is replayed *ahead of* the ask and inherited by subagents (`agent/permissionPolicy/policies/session-approval-history.ts:12-31`, `agent/permissionRules/permissionRules.ts:6-22`, `docs/en/customization/agents.md:48`) → `tool_call` + `ctx.ui.select` (once/session/deny) + a literal path pattern, tool-name-only for swarm-like tools (`docs/en/reference/tools.md:100`). Ranked out: `NotifyUser` progress panel, cron jitter/coalescing (`tools.md:149`), goal budgets that reject *all* tool calls on exhaustion (`features/goal/goalService.ts:26-36`).

**Measured on this host, 2026-11-18: (1) is withdrawn.** The reminder was
ranked on this harness's own workload, and the trigger does not occur there: a
consecutive **bash** streak of 3 fires in **0 of 124 sessions**
over the frozen window (host dirs plus the devcontainer's private volume);
across all tools it fires in 9, and every one is `subagent_status`/`codemode`
polling that #163 removed. An identical-output streak of 3 fires in 1, for 5 s. The ranking's "14× `docker ps`"
was 18 calls containing `docker ps`, 18 distinct commands. See
[`2026-11-harness-advancements.md#correction-candidate-07-was-measured-and-withdrawn-2026-11-18`](2026-11-harness-advancements.md#correction-candidate-07-was-measured-and-withdrawn-2026-11-18)
and `tickets/harness-advancements/07-repeat-breaker.md`. Row 5a still ranks
the mechanism fairly; the reason not to build it is this workload, not the
source.

**Unverified here.** Read-before-write staleness is documented (`docs/en/reference/tools.md:26,28`) but I found no tracker enforcing it in the v2 tools; `minidb` (embedded JSON store + WAL search index) and Tower's comms protocol were read at package/README level only; `*Goal` gating and the `select_tools` catalog rendering were traced by call site, not exercised.
