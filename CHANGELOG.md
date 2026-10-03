# Changelog

Versions are git tags. This repository is not published to npm.

## v1.0.0 — 2026-10-02

Initial tagged release, tracking pi 1.0.0. Contents:

- `answer` extension (`/answer`) with question extraction.
- `native-web-search` extension and matching skill.
- `todos` extension with file-based todo management.
- `subagent` extension: non-blocking delegation of tasks into detached tmux
  sessions, with status inspection, waiting, and cancellation.

### Unreleased

Maintenance:

- `PI_SUBAGENT_*` integers are now parsed strictly: `"3m"`, `"1e9"` and `"3.9"`
  are reported on stderr and ignored rather than truncated by `parseInt`, which
  would have turned a mistyped stall threshold into seconds. A behavioural change
  to configuration parsing, deliberately called out here rather than filed under
  "no behaviour change".
- Fixed `AGENTS.md`, which still documented `./extensions` and `./skills`
  after they moved to `.pi/` in `3b554e9`, and gave a test command that no
  longer existed. Documented the CRLF trap and how to repair it.
- Renormalized line endings to LF across the tree (`.gitattributes` already
  required it; `pi-session.sh` was committed with CRLF in its blob and other
  files were left stale-CRLF in the working tree, invisible to `git status`).
- Added this `CHANGELOG.md`; `AGENTS.md` mandated it but it did not exist.

Features:

- **Live subagent status widget.** A strip above the editor lists every live
  run with what it is doing (`active (bash 45s)`, `waiting 12s`, `stalled 3m`)
  and how long it has been at it, so progress is visible without polling
  `subagent_status`.
  - New pure classifier (`status.ts`): `observeStatus` / `classifyStatus` /
    `advanceStatusState`. Order comes from the child's `sequence`, the monotonic
    counter it stamps on every write, so a replayed or out-of-order snapshot from
    another process cannot rewind a phase — the same rule `subagent_status` already
    applied to the activity snapshot, so the two surfaces cannot disagree.
  - A snapshot that is valid but has stopped being written is a stall. That is
    the case a wedged child actually produces: it keeps reporting its last phase
    forever, so silence is measured from the last write, not from a missing file.
  - Ported from HazAT/pi-interactive-subagents, minus the `source: "pi" |
    "claude"` split (every child here is pi), the config file, the statusline
    formatters, and the interrupt inference.
  - Three policies deliberately differ from the reference. The stall threshold is
    ours (`PI_SUBAGENT_STALL_SECONDS`, default 180). A run inside a tool call gets
    a much longer one (`PI_SUBAGENT_TOOL_STALL_SECONDS`, default 900), because pi
    fires `tool_execution_update` only when a tool produces output — `npm ci` is
    silent for minutes while working perfectly well, and calling it hung is the
    one mistake a status display must not make. And a stall or recovery never
    wakes the parent, which would duplicate the completion notification.
  - Built on pi's native `ctx.ui.setWidget(..., { placement: "aboveEditor" })`,
    installed lazily while a run is live and cleared when the last one finishes,
    with its own 1s ticker so elapsed times move and queued runs (which have no
    watcher of their own) still update. Guarded on `ctx.mode === "tui"`: RPC
    forwards only string arrays and would drop a component factory.
  - Display only: the classifier cannot finish, fail or interrupt a run, and an
    `interrupted` run is reported as such regardless of what its snapshot says.
- **Subagent turn-level interrupt.** New `subagent_interrupt({ id })` tool sends
  Escape (pi's `app.interrupt` — never `C-c`, which quits the child) to the
  child's pane, aborting the in-flight turn while leaving the child alive at its
  prompt with its transcript and tmux session intact. Use it to redirect a run
  that is going the wrong way where `subagent_cancel` would throw it away.
  - The run becomes `interrupted`. It keeps its tmux session, its transcript and
    its concurrency slot until it is cancelled; `subagent_cancel` releases it,
    and `session_shutdown` reaps the idle child (the transcript survives, so the
    run stays resumable).
  - The child reports the abort by writing `<runDir>/interrupt.json` instead of
    a failed `result.json`, and does not shut itself down. `result.json`
    semantics are unchanged, so a run that is interrupted and then finished
    still reports normally. A child launched without the marker path keeps the
    old behaviour (report the abort as a failure) rather than going silent.
  - `interrupted` is *terminal* for waiting (`subagent_wait` returns,
    `subagent_clean` skips) but the child is still alive, so the new
    `holdsChild` predicate guards everything that would destroy or free it:
    auto-reap while the session lives, the concurrency slot, and the guards that
    stop two processes writing one transcript.
  - `subagent_resume` is refused while a run's child is still alive — including
    an interrupted one — because it launches a second pi process on a transcript
    the first one still holds. Attach and type the follow-up there instead, or
    cancel the run first.
  - `subagent_interrupt` never sends two Escapes inside pi's 500ms double-escape
    window (which would open the child's tree selector) and waits up to
    `PI_SUBAGENT_INTERRUPT_CONFIRM_MS` (default 3s, 0 to not wait) for the child
    to confirm. It only accepts a marker newer than the request, so a leftover
    `interrupt.json` from an earlier interrupt cannot confirm a second one.
  - A run whose tmux session is killed by hand while `interrupted` is now failed
    by the watcher instead of being polled forever against a target that cannot
    exist. tmux failures it cannot classify (an unreachable socket, say) are
    tolerated for two ticks and then fail the run as *unreachable* — distinct
    from an exit, which is what the evidence supports.
  - An Escape the child plainly ignored is forgotten once it publishes activity
    newer than the request, so `subagent_status` stops advertising a pending
    interrupt for a child that is simply working.

- **Subagent context handoff.** New `handoff` parameter on the `subagent` tool:
  - `standalone` (default) — unchanged, a fresh session addressed by
    `--session-dir`/`--session-id`.
  - `lineage` — an empty child session whose v3 header records the parent
    session, so pi shows the relationship without sharing context.
  - `fork` — the child is seeded with the parent's live branch, so it already
    knows the task's background.
- **New `subagent_resume({ id, message })` tool.** Reopens a finished run's
  transcript and appends the follow-up, in a fresh tmux session, tracked as an
  incremented attempt.
- **Fixed child usage double-counting.** A forked child inherits the parent's
  transcript verbatim, so summing the whole file charged the child for its
  parent's turns. Runs now record a `usageFromLine` baseline and only the
  remainder is attributed to the run.
- `subagent_clean --delete_files` now reports how many child transcripts it
  destroyed, since those runs can no longer be resumed.

Fixes to the handoff work, from an adversarial review:

- **`subagent_clean` could destroy a live resumed run's transcript.** A resumed
  run keeps its ancestor's transcript, so deleting the ancestor's run dir pulled
  the file out from under a run that was still going. pi holds the descriptor
  open, so the child kept writing to an unlinked inode and lost every entry
  silently. `subagent_clean` now retains a run dir that still owns a live run's
  session file and names it in its output.
- **Two concurrent resumes could append to one transcript.** A finished run
  stays terminal forever, so nothing stopped both resumes from passing the
  "still running" guard; two pi processes then wrote interleaved branches to one
  JSONL. `subagent_resume` now refuses while another non-terminal run shares the
  session file.
- **`subagent_clean` over-reported destroyed transcripts**, counting any record
  with a `sessionFile` rather than one inside the dir being deleted.
- **A fallback reintroduced the wrong-branch trap**: `fork` mode fell back to
  the reopened parent's `getLeafId()`, which is the file's last entry. Fork now
  takes the leaf from the live `ctx.sessionManager` and fails if there is none.
  This also drops a redundant full re-parse of the parent transcript per call.
- `finalizeRun` no longer erases a recorded `sessionFile` when a child reports
  one that is `undefined`.

Fixes found by reviewing that work, before it shipped:

- **A stale `interrupt.json` could confirm an interrupt that never happened.**
  The marker file is never deleted, so a second `subagent_interrupt` on a run
  that was already interrupted read the *first* marker back within a
  millisecond and reported "interrupted" while the child kept streaming. The
  confirmation poll now captures a baseline before Escape is sent and only
  accepts a marker that advances it; a valid-but-older marker is reported as
  stale, which is what it is.
- **Two Escapes inside pi's double-escape window.** On an idle child pi reads
  two Escapes within 500ms as its double-escape action (the session tree by
  default), which blocks the child's prompt without touching the turn.
  `subagent_interrupt` now refuses a second Escape inside that window instead
  of sending it.
- **`subagent_resume` on an interrupted run would have opened a second pi
  process on a transcript the live child still holds** — the interleaved-branch
  corruption the extension's own guard exists to prevent. Resume now refuses
  while a run's child is alive; an interrupted run is steered by attaching, or
  cancelled first and then resumed.
- **An interrupted child would have been orphaned at shutdown.** With
  `PI_SUBAGENT_KILL_ON_SHUTDOWN` off (the default) nothing could reach an idle
  interrupted child once the parent exited, and `subagent_clean` skips it.
  Shutdown now reaps it; killing the tmux session keeps the transcript, so the
  run stays resumable.
- **A run whose tmux session was killed by hand polled forever.** `pane_dead`
  needs a live pane to ask, so a missing target left the watcher re-arming
  every 500ms for the rest of the session while reporting the run as alive. A
  "can't find pane/session" failure now ends the run, and any other persistent
  tmux failure does too after three consecutive ticks, so one hiccup cannot
  fail a healthy child.
- **An `interrupted` run reported itself as idle while it was working.** The
  child can be driven again after an interrupt, so the status line now reads
  the live activity phase instead of assuming, and a second interrupt is
  recorded rather than ignored. An Escape the child plainly ignored (proved by
  activity newer than the request) stops being advertised as pending.
- `PI_SUBAGENT_INTERRUPT_CONFIRM_MS=0` meant 3s, because the positive-only env
  reader rejected it. It is read as a non-negative value now, so 0 means "send
  and do not wait".
- `subagent_resume` no longer copies `interrupts`/`interruptedAt`/
  `interruptRequestedAt` into the new attempt, so a fresh child is not reported
  as interrupted before it has ever been sent a key.

Fixes:

- `persist()` wrote `runs.json` with a plain `writeFile`, so a reader could
  catch the file mid-write and fail `JSON.parse`. It now uses the atomic
  temp-file-plus-rename helper that already existed in the same module. This
  made `lifecycle.test.ts` fail roughly 3 runs in 8.
- `pi --session <missing-file>` does not merely start empty — it invents a new
  UUID, silently diverging from the parent transcript. Resume now verifies the
  file exists and fails loudly instead.