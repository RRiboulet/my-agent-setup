# Harness advancements: what to change next, ranked

Investigation dated 2026-11-17 against pi `1.5.2`, this package at `v1.14.0`,
on a 2 vCPU / 11 GB / 19 GB-free devcontainer. Companion surveys:

- [`2026-11-competitor-harnesses.md`](2026-11-competitor-harnesses.md) — Claude
  Code, Codex CLI, Gemini CLI, Cursor, Cline/Roo, Aider, Amp, OpenCode, Hermes
  Agent.
- [`2026-11-pi-ecosystem.md`](2026-11-pi-ecosystem.md) — pi packages, skills
  collections, MCP, known pi pain points.
- [`2026-11-open-source-harnesses.md`](2026-11-open-source-harnesses.md) — source
  reading of DeepSeek Harness, Qwen Code, Kimi Code, and KooshaPari/KCode.
- [`2026-11-rework-repo-explorer-session-breakdown.md`](2026-11-rework-repo-explorer-session-breakdown.md)
  — code-level diagnosis of the two extensions the user called broken.

This document supersedes `2026-11-harness-feature-survey.md`, an untracked
survey on `main` that assumed none of these extensions existed. That assumption
is false: `pi-lens`, `pi-web-access`, `pi-tasks`, `pi-sandbox`, and `pi-memory`
are published and maintained, so "build it" is no longer the default answer.

## Method

1. Read the installed pi `1.5.2` docs and the local extensions before claiming
   any api or hook exists.
2. Measure this machine's 109 sessions across all three agent dirs
   (`~/.pi/agent`, `~/.pi/agent-my-agent-setup`, `~/.pi/agent-host`), pairing
   every `toolCall` with its recorded `durationMs`. Read-only scripts; no
   session was modified.
3. Survey competitors from their docs/changelogs, and the open-source trio from
   their source.
4. Rank by **minutes recovered per 17-day window ÷ hours to build**, with a
   veto for anything that adds a daemon, a paid service, or a second runtime.
   The user's felt pain counts as evidence; competitor parity does not.

## Baseline

Window 2026-10-31 to 2026-11-17. 109 sessions, 7,214 assistant messages, 4,652
tool results.

| Tool | Calls | Share |
|---|---|---|
| `bash` | 3,516 | 83% |
| `subagent_status` | 681 | 16% |
| `edit` | 190 | 4.5% |
| `read` | 83 | 2% |
| `codemode` / `subagent` / `write` | 40 / 38 / 36 | — |
| `web_search` / `todo` / `triage_change` | 32 / 12 / 11 | — |

Bash holds 27,086 s of the 27,328 s of tool time. Median call 54 ms, p90 6.3 s;
126 calls over 60 s hold 20,731 s (77%).

Split by command intent:

| Category | Time | Calls | Share |
|---|---|---|---|
| `devc` / docker | 9,630 s | 1,095 | 35% |
| `sleep`-polling | 7,894 s | 158 | 29% |
| test suite (`node --test`) | 6,652 s | 115 | 24% |
| git, gh, npm, curl, tmux, rest | 3,210 s | 2,102 | 12% |

Corrections that matter to the ranking:

- **`devc` is 389 real invocations, not 1,095.** The larger number counted
  commands that merely mention `devcontainer`. The 9,089 s across 25 sessions
  and 6 projects stands: it is the largest single cost, and it is not specific
  to this pi — `/home/ubuntu` multi-project sessions (251 calls),
  `pupkeep` (92), `my-agent-setup` (25), `analytics-agent` (19).
- **Polling is the largest recoverable habit.** 158 bash calls contain `sleep`,
  declaring ~95,000 s between them; the measured tool time is the 7,894 s above.
- **The test suite is 115 calls / 6,652 s.** The `bg` branch runs 1,204 tests
  green in 199 s.
- **Errors are not compile errors.** 191 tool errors: 132 non-zero exits
  (devc/git/ssh/curl), 20 other, 13 command-not-found, 9 failed edits, 5 web
  searches, 3 runtime, 1 read. **No TypeScript type error appears in the tool
  results.** LSP's headline benefit — catch the type error after an edit — is
  unmeasured here.
- **Curl is a capability gap, not a time sink.** 81 calls / 44 s, mostly
  localhost health checks and cloud metadata, not page reads.
- **Slash commands are near-dead.** 2 user slash commands in 109 sessions.
  `repo-explorer` (1,786 lines, 8 modules) and `session-breakdown` (2,127
  lines) are large surfaces with no measurable invocation traffic.
- **Skills are dormant.** 22 explicit skill loads in 109 sessions, against 24
  skills and 2,887 lines advertised in every system prompt. `worktree` alone is
  623 lines; `add-model` is 327.
- **`subagent_status` is polled 18× per `subagent` start** (681 vs 38).
- `hy4-flash-free` is live on `opencode-go` (1M context, thinking `none/high`)
  but absent from `enabledModels`; enabling it needs one settings line, not a
  model curation.

## Candidate ranking

Effort is hours at this repository's observed cadence, not ideal days. Recovery
is what the measurement supports, per 17-day window; value that no measurement
covers is marked *unmeasured* and cannot win the ratio on its own.

| # | Candidate | Evidence | Recovery | Build | Ratio | Band |
|---|---|---|---|---|---|---|
| 1 | Land the `bg` stack | 7,894 s sleep + 6,652 s blocking tests | 60–90 min | 0 h (2 h review) | already paid | top 5 |
| 2 | `devc` fast paths | 389 calls / 9,089 s / 6 projects | ~45 min at 30% | 16 h | ~0.2 min/h | top 5 |
| 3 | Subagent `wait`/collect | 681 polls vs 38 runs | ~20 min + context | 6 h | structural | top 5 |
| 4 | repo-explorer `/diff` + `/explore` | 1,786 lines; wrong-branch bug; transcript pollution | phone workflow | 12–16 h | felt pain | top 5 |
| 5 | Skills prune/merge/split | 22 loads / 109 sessions; one 623-line skill | context + routing | 10 h | unmeasured | top 5 |
| 6 | Measurement harness | 2,127-line report tool; no A/B runner | enables all of the above | 6 h | prerequisite | ticket 00 |
| 7 | Repeat-breaker ladder (Kimi) | 14× the same `docker ps`; 8–9× the same suite | small | 4 h | cheap | later |
| 8 | Phone notify | SSH+tmux; no Tailscale | attention | 4 h | unmeasured | later |
| 9 | `pi-lens` LSP trial | 0 type errors measured; ~0.5 GB RAM | unproven | 3 h | unproven | later |
| 10 | `pi-web-access` fetch | 81 curls / 44 s, mostly non-web | capability | 2 h | unmeasured | later |
| 11 | Checkpoint/rewind | no failure data | safety | 20 h | unmeasured | later |
| 12 | Task graph for todos | 12 `todo` calls | unmeasured | 12 h | low | later |
| 13 | Permission language / OS sandbox | single user, container already | low | 24 h | veto | rejected |
| 14 | Memory with curator | no measured need; context cost real | low | 16 h | veto | rejected |
| 15 | Declarative hooks bridge | extensions already cover it | low | 8 h | veto | rejected |

## Top five

### 1. Land `bg` (ticket 01)

Already built on `bg-tool-start` (19 commits) plus eight sibling branches. Its
tests are green: 1,204 pass, 0 fail, 199 s. It is the only answer to the two
largest recoverable categories, and every later A/B baseline is cheaper to take
after it. Do not reimplement it in this branch.

### 2. `devc` latency (ticket 02)

The biggest measured cost and the only item used in every project. `devc ls` is
~7 s per call, `devc doctor` ~8 s, plain exec on `pupkeep` averages 28 s.
Rework is **additive**: keep every subcommand and flag, add a cached index for
read-only queries and a persistent exec path, with `--no-cache` to bypass.

### 3. Subagent `wait` / collect (ticket 03)

Turn `subagent_status` from a poll surface into a `wait(id, timeout)` that
returns on settle, make a started child background-by-default (OpenCode v2.3.0
does this), and keep `status` for "what is it doing right now". Target: fewer
than 100 status calls per 17 days, from 681.

### 4. repo-explorer `/diff` + `/explore` (ticket 04)

The user's symptom is confirmed in code: `chooseBranch` never uses the computed
`defaultRef` (`branch-menu.ts:70,118`), so Enter opens the first alphabetical
branch; every pick appends up to 2,000 lines / 256 KiB to the transcript and the
model context (`index.ts:106-120`, `file-transcript.ts:16`); `readFile` reads
the branch tip (`git.ts:253-256`), so uncommitted edits — the thing a diff view
is for — are invisible. Split into `/diff` (changed files first, real unified
diff against HEAD, overlay) and `/explore` (search-first browser, working tree,
overlay), with an explicit "send to agent" action.

### 5. Skills prune, merge, split (ticket 05)

24 skills to ~15; merge the decision cluster (`in-your-own-words`, `grilling`,
`to-spec`, `to-tickets`, `implement`) into one router; move the body of
`worktree` (623 lines) and `add-model` (327) into `references/` behind a short
SKILL.md. Success is fewer misroutes and a smaller always-on surface, measured
by skill loads and context tokens, not by a word count.

## Later band

Kept with a trigger, not dropped:

- **Repeat-breaker ladder** (Kimi Code): reminders at streak 3/5/8, forced stop
  at 12. Cheap; build when a new loop is observed rather than pre-emptively.
- **Phone notifications**: tmux bell/status only. No Tailscale at home and no
  third-party push channel on a box holding SSH keys.
- **`pi-lens` LSP trial**: install for one week, measure post-edit diagnostics
  and RAM, then keep or remove. LSP is not a 2026 priority for this harness
  until the error data changes.
- **`pi-web-access`**: adopt when deep research recurs; its zero-config Exa MCP
  path needs no paid key and respects the no-new-service constraint.
- **Checkpoint/rewind**: the largest safety idea in the survey, but 20 h and no
  measured failure data. Revisit after a lost-work incident.
- **Task graph**: 12 `todo` calls. The flat list is not the bottleneck.

Rejected on purpose: permission language and OS sandbox (single user, already
containerized), auto-memory (no measured need; context risk), declarative hooks
(extensions already express every lifecycle event), agent teams/mailboxes (no
parallel-team workflow), browser subagents (RAM on 2 vCPU), embedding indexes
(the measurement does not justify an always-on service).

## Measurement plan

Ticket 00 builds the harness before any change. Two kinds of measurement,
because one does not fit all five:

- **Model runs**: 8 tasks × 3 models (`deepseek-v4.1-flash`, `glm-5.3-flash`,
  `hy4-flash-free`) × 2 harness states (baseline, changed), one run per cell.
  Repos: `my-agent-setup` and `pupkeep` (the latter carries the measured 28 s
  `devc` exec). ~7 min per task, so ~6 h of model time. A second run only for a
  delta that looks real.
- **Deterministic microbenchmarks**: `devc` subcommand latency (100 invocations
  per subcommand, cold and warm) and repo-explorer keystrokes/time for the
  question "what changed in this branch and what does the diff say" (5 trials,
  80×24). A model cannot measure a TUI or a CLI's latency.

Metrics per run: tool calls, wall-clock, blocking time (longest single call),
tokens, errors, user interventions, and whether the task finished. The runner
writes JSON; the report is a table.

## Decisions taken

- Four axes ranked together; measured pain outranks competitor parity.
- Ratio ranking with a maintenance veto; no daemon, no paid service, no second
  runtime; 11 GB / 2 vCPU is the budget.
- `bg` lands first; it is already built in another worktree.
- Skills: prune + merge + progressive disclosure, all three.
- Session-breakdown: replace the graph with a compact table and keep
  `tools/measure-session-usage.mjs`.
- repo-explorer: split commands, overlay only, explicit send.
- Phone: repo-explorer plus a local tmux bell; no push channel.
- Adopt, do not vendor, where a maintained package exists (`pi-lens`,
  `pi-web-access`); reimplement only where this package already owns the
  surface (`subagent`, `todos`, `devc`).
- Docs and tickets land in one PR; implementation follows on one branch per
  ticket.

## What would change this ranking

- A measured post-edit diagnostic cost (say, a week of TypeScript errors in
  tool results) promotes LSP.
- A lost-work incident promotes checkpoints above repo-explorer.
- `devc` rework failing to find 20% latency promotes the repeat-breaker ladder
  and phone notify into the top five.
- A second developer using this package invalidates the single-user assumptions
  and the "free rein to break the tool API" decision.
