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
survey on `main` that assumed none of these extensions existed; it was deleted
after the still-valid parts were folded in. That assumption
is false: `pi-lens`, `pi-web-access`, `pi-tasks`, `pi-sandbox`, and `pi-memory`
are published and maintained, so "build it" is no longer the default answer.

## Method

1. Read the installed pi `1.5.2` docs and the local extensions before claiming
   any api or hook exists.
2. Measure this machine's sessions across the host agent dirs, pairing every
   `toolCall` with its recorded `durationMs`. The snapshot is frozen at sessions
   **started before 2026-11-17T09:15Z**, so the investigation's own sessions do
   not inflate it. Read-only scripts; no session was modified. The sentence here
   originally claimed all three dirs including the devcontainer's private one;
   the 108-session baseline is the host dirs only — see "Correction: candidate
   07" below.
3. Survey competitors from their docs/changelogs, and the open-source trio from
   their source.
4. Rank by **minutes recovered per 17-day window ÷ hours to build**, with a
   veto for anything that adds a daemon, a paid service, or a second runtime.
   The user's felt pain counts as evidence; competitor parity does not.

## Baseline

Window 2026-10-31 to 2026-11-17 (frozen at 09:15Z). 108 sessions, 9,617
messages (4,510 assistant, 4,671 tool results, 321 user, 115 system).

| Tool | Calls | Share |
|---|---|---|
| `bash` | 3,531 | 76% |
| `subagent_status` | 681 | 15% |
| `edit` | 191 | 4.1% |
| `read` | 83 | 1.8% |
| `codemode` / `subagent` / `write` | 43 / 39 / 38 | 0.9 / 0.8 / 0.8% |
| `web_search` / `todo` / `triage_change` | 32 / 12 / 11 | <1% each |

Shares are of the 4,674 tool calls; the 4,671 tool results differ by three
calls whose result was not recorded. Bash holds 28,499 s of the 28,781 s of tool
time. Median call 54 ms; 132 calls over 60 s hold 22,120 s (78%).

Split by command intent (mutually exclusive, sums to the bash total; the two
empty-command calls are in *other*):

| Category | Time | Calls | Share |
|---|---|---|---|
| `devc` / docker | 8,476 s | 1,040 | 29.7% |
| test suite (`node --test`) | 7,904 s | 171 | 27.7% |
| `sleep`-polling | 7,786 s | 155 | 27.3% |
| other (ls, rg, sed, node, python) | 2,888 s | 1,463 | 10.1% |
| npm / gh / git / curl / tmux | 1,445 s | 702 | 5.1% |

Corrections that matter to the ranking:

- **`devc` is 252 real invocations / 6,389 s**, not 1,095 calls / 9,630 s.
  Both earlier numbers counted commands that merely mention `devcontainer`.
  Of the 6,388 s: plain `<project> -- <cmd>` exec is 166 calls / 3,236 s
  (~19.5 s each), `ls` 30 / 253 s (~8.4 s), `up` 17 / 703 s, `rebuild` 16 /
  2,068 s, `doctor` 13 / 115 s, and 10 help/list/stop/version invocations /
  13 s. The ticket-02 scope (read + exec) is 3,604 s; rebuild/up are 2,771 s and
  are not in that scope.
- **Polling is the largest recoverable habit.** 155 bash calls contain `sleep`,
  declaring ~95,000 s between them; the measured tool time is the 7,786 s above.
- **The test suite is 171 calls / 7,904 s.** The `bg` branch runs 1,204 tests
  green in 199 s at `a1d48c5`.
- **Errors are not compile errors.** 191 tool errors: 168 bash, 9 edits, 5 web
  searches, 4 status calls, 2 codemode, 2 triage, 1 read. The only TypeScript
  diagnostics are 11 `TS5097` extension errors in one command's output — a
  config complaint, not a type error. **No type-checker diagnostic follows an
  edit.** LSP's headline benefit is unmeasured here.
- **Curl is a capability gap, not a time sink.** 46 direct `curl` invocations /
  11.7 s; 70 commands mention it / 42 s, mostly localhost health checks and
  cloud metadata, not page reads.
- **Slash commands are near-dead.** 2 user slash commands in 108 sessions (one
  `/voice`, one typo); `/explore` and `/session-breakdown` were never invoked.
  `repo-explorer` (1,786 lines, 8 modules) and `session-breakdown` (2,127
  lines) are large surfaces with no measurable invocation traffic.
- **Skills are dormant.** 22 reads of a `SKILL.md` in 16 sessions, against 23
  skills; the system prompt carries their names and descriptions (~9 KB
  measured at the last frozen prompt), while their 2,887 body lines load on
  demand. `worktree` is 623 lines; `add-model` is 327.
- **`subagent_status` is polled 17× per `subagent` start** (681 vs 39).
- `hy4-flash-free` is live on `opencode-go` (1M context, thinking `none/high`)
  and was absent from `enabledModels`; it is enabled as of 2026-11-17.

The window is by session start; a session still open at the freeze contributes
its calls as read, which is why two runs of the same script can differ by a few
seconds of a long-running command.

## Correction: the `bg` ticket was measured and withdrawn (2026-11-17)

The ranking below put "land `bg`" first on the strength of the two largest
recoverable categories. It was built, then measured over nine runs, and it does
not recover them: `bg` was called in 1 of 6 acceptance sessions, declaring it at
startup did not change adoption (1 of 2 either way), and on a fan-out task the
model wrapped a sequential batch in one job and waited, so no wall clock moved.
Where parallelism did win — four suite runs in 291.6 s instead of ~660–960 s — it
came from plain `&`, and the flake triage it triggered made that session 2.4×
slower end to end. Full evidence and what survived: `tickets/harness-advancements/01-land-bg.md`.

The concurrent test runner and the two bounds it exposed are re-landed alone in
#165; the lifecycle split stands in #164. Treat the suite category as being fixed
by those, and the polling category as ticket 03's for subagents. Bash polling is
not a repeat-breaker problem either; candidate 07 was measured and withdrawn
below.

## Correction: candidate 07 was measured and withdrawn (2026-11-18)

Row 7 rested on "14× the same `docker ps`; 8–9× the same suite". No reachable
session reproduces 14 repeats of one command: those numbers are counts of
commands that *mention* `docker ps` or `node --test`. The closest sessions are
18 `docker ps` calls (01a1d0f6, all 18 distinct) and 32 `node --test` calls
(01a1d1e9, 31 distinct), and both ended before the freeze, so they are not an
earlier read that grew later.

Re-measured on this host on 2026-11-18, with three trigger keys and a streak
counted consecutively within one session (Kimi's chain semantics). The scan is
transcript-only, so host load does not affect the counts:

| trigger key | sessions firing (streak ≥ 3) | worst | calls / time in repeats |
|---|---|---|---|
| exact command, leading `cd … &&` stripped | **0 of 124** | — | 0 / 0 s |
| verb + subcommand (`docker exec`, `node --test`) | 43 of 124 | 17× `docker exec` | 740 / 6 480 s |
| identical output, ≥ 40 chars, sha1 | **1 of 124** | 3× | 2 / 5 s |

Corpus: the survey window (2026-10-31 .. 2026-11-17T09:15Z) over the host agent
dirs (108 sessions) **plus this repo's devcontainer private volume** (16
sessions), 6 140 tool calls, 4 671 of them bash. The 65 sessions in the legacy shared
`pi-agent-config` volume dedupe entirely into those. The container volume was
not reachable at the freeze and is not in the 108-session baseline; it is
reachable over `docker exec`. All-time (145 sessions, 5 145 bash calls) gives the
same exact-args zero. The other project containers on this host (pupkeep,
lol-dataset, analytics-agent; 145 sessions) are excluded because this repo's
extensions are not what they load; their repeats are `sleep` polls and post-edit
verification runs.

Sensitivity check — if the ladder counted occurrences rather than consecutive
calls — leaves exact-args at 1 of 124, and that one session is three
`sleep 300; echo waited` calls, a deliberate poll.

One scope correction: those keys are bash-only, and Kimi's chain (like
DeepSeek's reminder) keys on every tool. Across all tools, a repeat of 3 within
one user-message segment fires in 9 of 124 sessions — every one of them
`subagent_status` polling (4 sessions) or a `codemode` call wrapping the same
poll (5), 698 repeated calls, worst 640 on one run id. That is the category
`subagent_wait` (#163) removed; a reminder there would re-fight a solved
problem, and after #163 the all-tool trigger has no workload left either.

Read it as the `bg` result: the exact-args ladder fires zero times and would
ship as dead code with green tests. The verb-level row is real but is `devc`
latency: one session's 17-call consecutive `docker exec` run is 17 different
commands, and the 6 480 s across 43 sessions is 740 commands sharing a two-word
prefix. A ladder keyed that coarsely would fire on every `devc`/`sed` session
and tell the model nothing. Output-hash is real and rare (three sessions repeat
an answer three times: a model list, an SSH timeout, a missing API key), and in
the busiest other-project case the repeated answer is a post-edit `tsc --noEmit`
— the deliberate retry a nudge must not block. Row 7 is therefore **withdrawn,
not deferred**; the evidence and the revival trigger are in
`tickets/harness-advancements/07-repeat-breaker.md`.

## Candidate ranking

Effort is hours at this repository's observed cadence, not ideal days. Recovery
is what the measurement supports, per 17-day window; value that no measurement
covers is marked *unmeasured* and cannot win the ratio on its own. The order is
the user's confirmed order from the investigation; the ratio column is shown so
the thin rows are visible, not to hide them. `devc` at #2 is the clearest
example: its in-scope recovery is minutes, it stays because the user confirmed
the order and it is the only tool every project goes through, and the ratio
does not earn the slot.

Two-week shape: week 1 is ticket 00 Phase A, ticket 01 (land `bg`), and the
`bg` cells of Phase B. Week 2 runs **at most two** implementation branches at a
time; this host is 2 vCPU and a four-way grid plus the full suite already
contends. If it slips, 04 and 05 defer first — their evidence is felt pain and
routing, not measured wall-clock.

| # | Candidate | Evidence | Recovery | Build | Ratio | Band |
|---|---|---|---|---|---|---|
| 1 | ~~Land the `bg` stack~~ **cancelled 2026-11-17** | measured: adoption 1 of 6, no wavefront (see `tickets/…/01-land-bg.md`) | 0 | — | — | withdrawn |
| 2 | `devc` fast paths | 252 calls / 6,389 s; ticket scope 3,604 s | ~18 min at 30% of scope; up to +14 min if `rebuild --if-stale` lands | 16 h | ~0.1–0.2 min/h | top 5 |
| 3 | Subagent `wait`/collect | 681 polls vs 39 runs (17×) | ~20 min + context | 6 h | structural | top 5 |
| 4 | repo-explorer `/diff` + `/explore` | 1,786 lines; wrong-branch bug; transcript pollution | phone workflow | 12–16 h | felt pain | top 5 |
| 5 | Skills prune/merge/split | 22 SKILL.md reads / 16 sessions; 23 skills; one 623-line skill | context + routing | 10 h | unmeasured | top 5 |
| 6 | Measurement harness | 2,127-line report tool; no A/B runner | enables all of the above | 6 h | prerequisite | ticket 00 |
| 7 | ~~Repeat-breaker ladder (Kimi)~~ **rejected 2026-11-18** | measured: bash exact-args streak ≥ 3 in 0 of 124 sessions; one 5 s output streak (see `tickets/…/07-repeat-breaker.md`) | ~5 s | — | — | withdrawn |
| 8 | Phone notify | SSH+tmux; no Tailscale | attention | 4 h | unmeasured | later |
| 9 | `pi-lens` LSP trial | 0 type errors measured; ~0.5 GB RAM | unproven | 3 h | unproven | later |
| 10 | `pi-web-access` fetch | 70 curls / 42 s, mostly non-web | capability | 2 h | unmeasured | later |
| 11 | Checkpoint/rewind | no failure data | safety | 20 h | unmeasured | later |
| 12 | Task graph for todos | 12 `todo` calls | unmeasured | 12 h | low | later |
| 13 | Permission language / OS sandbox | single user, container already | low | 24 h | veto | rejected |
| 14 | Memory with curator | no measured need; context cost real | low | 16 h | veto | rejected |
| 15 | Declarative hooks bridge | extensions already cover it | low | 8 h | veto | rejected |

## Top five

### 1. Land `bg` (ticket 01)

Already built on `bg-tool-and-test-discipline`, with its nine sibling branches
merged in. At
the tip checked on 2026-11-17 (`a1d48c5`) its tests were green: 1,204 pass, 0
fail, 199 s. The branch has moved twice since and is owned by another worktree,
so re-run the suite before merging. It is the only answer to the two largest
recoverable categories. Phase A records the baseline before it lands; Phase B
re-runs only its cells. Do not reimplement it in this branch.

### 2. `devc` latency (ticket 02)

`devc` is 252 invocations / 6,389 s across 6 projects — 22% of bash time, and
the only item used everywhere. In-scope for this ticket: plain exec 166 calls /
3,236 s (~19.5 s each), `ls` 30 / 253 s (~8.4 s), `doctor` 13 / 115 s (~8.8 s).
`rebuild` (16 / 2,068 s) and `up` (17 / 703 s) are 2,771 s the ticket does not
touch unless `rebuild --if-stale` lands. Rework is **additive**: keep every
subcommand and flag, add a cached index for read-only queries and a persistent
exec path, with `--no-cache` to bypass.

### 3. Subagent `wait` / collect (ticket 03)

Turn `subagent_status` from a poll surface into a `wait(id, timeoutMs)` that
returns on settle (the watcher polls every 500 ms, so budget ~1 s), and keep
`status` for "what is it doing right now". The `subagent` tool stays
non-blocking; `wait` is a separate management tool. Target: fewer than 100
status calls per 17 days, from 681.

### 4. repo-explorer `/diff` + `/explore` (ticket 04)

The user's symptom is confirmed in code: `chooseBranch` never uses the computed
`defaultRef` (`branch-menu.ts:129,177`), so Enter opens the first alphabetical
branch; every pick appends up to 2,000 lines / 256 KiB to the transcript and the
model context (`index.ts:90,99`, `file-transcript.ts:17`); `readFile` reads
the branch tip (`git.ts:253-254`), so uncommitted edits — the thing a diff view
is for — are invisible. Split into `/diff` (changed files first, real unified
diff against HEAD, overlay) and `/explore` (search-first browser, working tree,
overlay), with an explicit "send to agent" action.

### 5. Skills prune, merge, split (ticket 05)

23 skills to ~15; merge the model-invoked planning members (`in-your-own-words`,
`grilling`) into one router and keep the user-invoked entry points (`implement`,
`to-spec`, `to-tickets`) as thin wrappers or references, because
`coding-skills.test.ts` pins those three as user-invoked; move the body of
`worktree` (623 lines) and `add-model` (327) into `references/` behind a short
SKILL.md. Success is fewer misroutes and a smaller always-on surface, measured
by per-skill loads and context tokens, not by a word count.

## Later band

Kept with a trigger, not dropped:

- ~~**Repeat-breaker ladder** (Kimi Code)~~ — withdrawn 2026-11-18 on
  measurement: a bash exact-args streak of 3 fires in 0 of 124 sessions, and
  every all-tool repeat is #163's polling. Revive only
  on a measured loop that is neither a poll nor a verification retry, per
  `tickets/harness-advancements/07-repeat-breaker.md`.
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
- **Context pruning** (Qwen's microcompaction, KCode's priced withholding):
  pi only summarizes at compaction, and no session in the baseline has
  compacted, so the trigger is the first real compaction. Revisit then; the
  mechanism is cheap but unmeasured here.

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
  Repos: a clean detached fixture at `origin/dev`, plus `/home/ubuntu` for the
  `devc` tasks (`pupkeep`'s exec path is the measured ~19.5 s). ~7 min per task, so ~6 h of model time. A second run only for a
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
- `bg` lands first; it is already built in another worktree. The repeat-breaker
  ladder is withdrawn on measurement, not deferred.
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
- `devc` rework failing to find 20% latency promotes phone notify into the top
  five. It does not promote the repeat-breaker ladder: that was measured and
  withdrawn separately, on the trigger rather than on `devc`.
- A second developer using this package invalidates the single-user assumptions
  and the "free rein to break the tool API" decision.
