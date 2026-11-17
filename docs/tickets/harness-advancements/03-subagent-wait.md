# 03: A subagent run can be waited on, instead of polled

**Blocked by:** 00 (baseline records status calls per run)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#3-subagent-wait--collect-ticket-03`

## What to build

The sessions contain **681 `subagent_status` calls for 39 `subagent` starts** —
17 per run. The tool is instantaneous, so the cost is not the call; it is ~600
extra model turns, their tool results in context, and the parent waking every
few seconds to ask "done yet?". OpenCode v2.3.0 makes subagents
background-by-default and reports when idle for the same reason.

`subagent` is contractually non-blocking (`pi.registerTool` returns immediately
so a fan-out can start three children), so `wait` is a **separate management
tool**, not an `action` on `subagent`. The existing management surface is
`subagent_status` / `subagent_cancel` / `subagent_interrupt` / `subagent_resume`
/ `subagent_clean`.

## Scope

Owns (`.pi/extensions/subagent/` and its own new test file):

- `subagent_wait({ id?, ids?, timeoutMs? })`. With an `id`, it resolves when
  that run reaches a terminal state and returns the same record `status`
  returns; with `ids`, it returns every settled run and the still-running ones.
  On timeout it returns the current record plus the latest pane, never an
  error.
- Reuse the existing settle watcher rather than adding a second poll loop. The
  watcher interval is 500 ms (`index.ts:245`, `POLL_INTERVAL_MS`), so the
  acceptance tolerance is ~1 s, not 250 ms.
- A run still queued at timeout returns `queued`, not `running` and not a hang.
  A run that failed to start, was cancelled, or died is terminal.
- The tool descriptions and the `AGENTS.md`/skill text that teaches polling:
  replace "poll status" with "start, then wait once". Keep `status` for the
  live "what is it doing right now" question and keep the list view.
- Its own `subagent-wait.test.ts`; it does not edit the shared helpers or the
  tests owned by tickets 00/04/05.

Leaves for later: inter-agent messaging, a task board, persistent teams.

## Acceptance criteria

- [ ] A scripted three-child fan-out (the test harness's fake model, not a live model) records exactly 3 `subagent` starts, 1 `subagent_wait`, and **zero** `subagent_status` calls.
- [ ] `subagent_wait` returns within 1 s of the child's settle event; a 30 s child does not return early; a `timeoutMs` of 1 s returns the current record with pane output.
- [ ] A queued run returns `queued` at timeout; a failed-to-start, cancelled, or dead run is returned as terminal and never waited on forever.
- [ ] `subagent_status` still answers "what is it doing now" and its tests are unchanged.
- [ ] The tool description and the skill text no longer tell the model to poll; a test asserts the description mentions `subagent_wait`.
- [ ] No regression in the existing lifecycle, interrupt, resume, or result tests.

## Validation

- Replay one real delegation from the sessions (the review-triage fan-out) and
  count status calls before and after in the transcript.
- Run the full subagent suite once through `bg`.
