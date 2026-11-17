# 03: A subagent run can be waited on, instead of polled

**Blocked by:** 00 (baseline captures polls per run)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#3-subagent-wait--collect-ticket-03`

## What to build

The sessions contain **681 `subagent_status` calls for 38 `subagent` starts** —
18 per run. The tool is instantaneous, so the cost is not the call; it is 600
extra model turns, their tool results in context, and the parent waking every
few seconds to ask "done yet?". OpenCode v2.3.0 makes subagents
background-by-default and reports when idle for the same reason.

Add a blocking `wait` action that returns the moment a run settles (or the
timeout expires, with the partial pane), and keep `status` for the live "what is
it doing right now" question. A fan-out of three children should cost three
starts and three waits, not thirty status polls.

## Scope

Owns (`.pi/extensions/subagent/`):

- `wait` in the subagent tool: `{ action: "wait", id, timeoutMs? }`. Returns the
  same final record `status` returns once terminal, or a `running` record plus
  the latest pane when the timeout expires. It must not busy-poll faster than
  the child's own settle watcher; reuse the existing watcher rather than adding
  a second one.
- A `waitAll` convenience (`ids` + `timeoutMs`) that returns every settled run
  and the still-running ones. This is what a fan-out actually wants.
- Tool descriptions and the `AGENTS.md`/skill text that teaches the model to
  poll: replace the polling advice with "start, then wait once".
- Keep `status` unchanged for live inspection; do not remove the list view.

Leaves for later: inter-agent messaging, a task board, persistent teams.

## Acceptance criteria

- [ ] A three-child fan-out is exercised in a test: 3 `subagent` starts, 1 `waitAll` (or 3 `wait`s), and **zero** `status` calls in the recorded tool sequence.
- [ ] `wait` returns within 250 ms of the child's settle event; a 30 s child does not return early, and a `timeoutMs` of 1 s returns `running` with pane output rather than an error.
- [ ] A child that fails to start, is cancelled, or dies is reported as terminal by `wait`, never waited on forever.
- [ ] The tool description and the skill text no longer tell the model to poll; a test asserts the description mentions `wait`.
- [ ] No regression in the existing lifecycle, interrupt, resume, or result tests.

## Validation

- Replay one real delegation from the sessions (the review-triage fan-out) and
  count status calls before and after in the transcript.
- Run the full subagent suite once through `bg`.
