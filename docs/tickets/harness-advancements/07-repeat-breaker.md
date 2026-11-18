# 07: A repeat-breaker ladder — **rejected 2026-11-18, on measurement**

**Blocked by:** —
**Status:** **rejected** (was: later)

The candidate was the top item in the open-source survey: port Kimi Code's
tool-dedupe ladder — append an in-band reminder at streak 3/5/8 and stop the
turn at 12 — as a `tool_result` + `tool_call` extension. It was not built,
because the trigger it would be keyed on does not occur in this harness's
workload.

## The claim, and what it counted

`docs/research/2026-11-harness-advancements.md` row 7 rested on "14× the same
`docker ps`; 8–9× the same suite". Those are counts of commands that *mention*
`docker ps` or `node --test`, not repeats of one command:

- session `01a1d0f6` (host, 2026-11-12) has **18** bash calls containing
  `docker ps` — **18 distinct** commands. No reachable session has 14 repeats of
  one command.
- session `01a1d1e9` (this repo's devcontainer, 2026-11-12) has **32**
  `node --test` calls — **31 distinct** commands, one of them run twice. Both
  sessions ended before the freeze, so these are not an earlier read that grew.

The 108-session baseline those claims were ranked from was the host agent dirs
only. The Method paragraph says it included "the devcontainer's private agent
dir", but the container's volume adds 16 sessions inside the same window, so it
did not. That volume is reachable over `docker exec` (it is not mounted on the
host). Re-measured with it, and with the legacy shared `pi-agent-config` volume,
the result does not change.

## What was measured

Three trigger keys, a streak counted consecutively within one session (Kimi's
chain semantics), on sessions started in the survey's frozen window
(2026-10-31 .. 2026-11-17T09:15Z). Transcript-only scan, so host load does not
affect the counts:

| trigger key | sessions firing (streak ≥ 3) | worst | calls / time in repeats |
|---|---|---|---|
| exact command, leading `cd … &&` stripped | **0 of 124** | — | 0 / 0 s |
| verb + subcommand (`docker exec`, `node --test`) | 43 of 124 | 17× `docker exec` | 740 / 6 480 s |
| identical output, ≥ 40 chars, sha1 | **1 of 124** | 3× | 2 / 5 s |

Each call's time is its recorded `durationMs`; "time in repeats" is every call
in a run after the first. Calls and results pair by `toolCallId` in the
`sessions/*.jsonl` transcripts, so the measurement needs no instrumentation.

Corpus: 108 host sessions + 16 sessions from this container's private volume =
124 sessions, 6 140 tool calls, 4 671 of them bash (sessions started in the
window; a session still open at the cut contributes later calls, 184 of the
6 140). The 65 sessions in the legacy shared volume all dedupe into sessions
already counted — 9 into this container's volume, 56 into lol-dataset's — so
they add none. All-time (145 sessions, 5 145 bash calls) gives the same
exact-args zero and the same one output-hash session. The other project
containers on this host (pupkeep, lol-dataset, analytics-agent; 145 sessions,
10 513 bash calls) are reported apart because this repo's extensions are not what
they load; their verb-level loops (`sed -n`, `python3 -`, `gh pr`, `git stash`)
and repeat verification runs (`tsc`, `node --test`) are a different workload.

Sensitivity check, in case the ladder should count occurrences rather than
consecutive calls: exact-args still fires in **1 of 124** sessions, and that one
is three `sleep 300; echo waited` calls — a deliberate poll.

One scope correction: those keys are bash-only, and Kimi's chain (like
DeepSeek's reminder) keys on every tool. Across all tools a **consecutive**
repeat of 3 fires in **2 of 124** sessions; counted the way DeepSeek does —
occurrences within one user-message segment — **9 of 124**. Every fire is
`subagent_status` polling (4 sessions) or a `codemode` call wrapping the same
poll (5), worst 640 on one run id. That is exactly the
traffic `subagent_wait` (#163) replaced: after it the all-tool trigger has no
workload left, and before it the reminder would have nudged a poll the harness
was about to stop by other means.

What each row means:

- **The exact-args ladder fires zero times.** It would ship as dead code with
  green unit tests — the failure mode `bg` had.
- **The verb-level number is real, but it is not a loop.** The worst run is 17
  consecutive `docker exec` calls, and they are 17 different commands in a
  185-call session (75 of its calls are `docker exec`); across 43 sessions the
  6 480 s is 740 commands sharing a
  two-word prefix. That is `devc`/`sed` latency (candidate 02), and a ladder
  keyed that coarsely would fire on ordinary work, not on a loop.
- **Output-hash is real and rare.** Three sessions in the window repeat an
  identical answer three times: the same model list, an SSH timeout, and "no
  API key found". A reminder there would be useful, for ~5 s across 124
  sessions; only one of the three does it consecutively.
- **Output-hash is also the wrong key for a nudge.** In the busiest
  other-project case the same `tsc --noEmit` output repeats 33 times because the
  model verifies after each edit — the deliberate-retry pattern any ladder must
  not block. That container's five output streaks (4×, 4×, 4×, 3×, 3×) are the
  same shape.

## Why rejected instead of built

The harness ranking's own Later band said "build when a new loop is observed
rather than pre-emptively". No loop is observed: zero exact-args streaks, one 5-second
output streak, and the one large verb streak belongs to another ticket. A
4-hour extension whose trigger fires in 0–1% of sessions, and whose most common
fire elsewhere is a correct verification retry, is surface without evidence.

The DeepSeek repeat-call reminder in the companion survey (row 1) is the same
key without the ladder. Measured on all tools it fires only on
`subagent_status`/`codemode` polling — the traffic #163 removed — so it does not
earn a build either; the companion survey marks it withdrawn.

The alternative triggers in the handoff were considered and are worse:

- **output-hash dedupe** — the reminder text is right, the frequency is not;
  and it fires on post-edit verification.
- **staleness-aware nudge** — firing when the workspace changed since the last
  run fires precisely on deliberate retries ("I edited, re-run the tests"),
  which is the behaviour to preserve, not nudge.

## What would revive it

A measured streak that is neither a poll nor a verification retry: an
exact-args or output-hash run of ≥ 3 in this repo's corpus (host dirs + this
container's volume), with the repeated calls not separated by an edit or a user
message. Name the session ids, re-run the three keys, and the build is
justified. Until then row 7 is withdrawn, not deferred.
