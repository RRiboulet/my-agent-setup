# Subagent extension tests

Unit and behaviour tests for `.pi/extensions/subagent/`. Node runs these `.ts`
files directly (native type stripping) — there is no build step and no compiler
in the loop, so type errors are not caught here.

## Running

```bash
# 1. Link the globally installed pi packages into node_modules (idempotent)
.pi/extensions/subagent/test/setup-deps.sh

# 2. Run the suite from the repository root
node --test .pi/extensions/subagent/test/*.test.ts
```

No `--test-force-exit` is needed: `session_shutdown` sets a `shuttingDown` flag
that stops the watcher from re-arming its poll timer (local patch 10 in
`index.ts`), so the suite drains its event loop and exits on its own.
`lifecycle.test.ts` pins that behaviour with a regression test that asserts no
further `pi.exec` calls happen after shutdown.

The suite is safe to run from inside a pi subagent child: `createHarness` clears
`PI_TMUX_SUBAGENT_CHILD` / `PI_TMUX_SUBAGENT_RESULT`, which the extension factory
otherwise branches on, and `lifecycle.test.ts` guards that with a regression
test.

## Layout

| File | Covers |
|---|---|
| `export.test.ts` | the `__test__` block in `index.ts` still exists (guards a future re-vendor) |
| `pure.test.ts` | `shellQuote`, `PI_SUBAGENT_*` env parsing, `isSameOrDescendant`, `resolveModel`, `validateCwd` |
| `tmux.test.ts` | tmux session/socket naming, command construction, `--attach-subagent` parsing |
| `status.test.ts` | `runSummary`, `isTerminal`, `holdsChild`, `runDirOwnsLiveTranscript`, `isMissingTmuxTarget`, `statusDetail`, `formatDuration`, `trimPane`, `truncateToolText`, `textFromAssistant` |
| `classifier.test.ts` | the status classifier: phase classification, stall/recovery transitions, monotonicity against stale snapshots, `interrupted` authority |
| `widget.test.ts` | `renderStatusRows` and the widget component: icons, capping, task trimming, width fitting |
| `usage.test.ts` | child session usage/cost accounting |
| `handoff.test.ts` | child launch argv per mode, lineage/fork session seeding, live-branch fork ordering, and the usage baseline |
| `lifecycle.test.ts` | launch, concurrency queueing, finalisation, failure detection, cancel, status, clean, shutdown stops the watcher, turn-level interrupt, the live widget (install/refresh/clear) |
| `interrupt.test.ts` | the `interrupt.json` marker (validation, reading, writing), the child reporter's abort path, and the parent lifecycle of an interrupted run |
| `helpers.ts` | env/temp-dir isolation and polling helpers |

`lifecycle.test.ts` drives the real extension factory with a fake
`ExtensionAPI`; all tmux access goes through `pi.exec`, so no tmux server or
child pi process is required. `PI_CODING_AGENT_DIR` is redirected to a temp
directory, so the tests never touch the real `~/.pi/agent` tree.

## Not covered here

About 20% of `index.ts` lines are still untested. The gaps, in rough order of
size:

- **the widget's placement in a real terminal.** The tests render the component
  directly with a fake TUI and theme, so `setWidget` is called with the right
  key and placement but nothing proves the strip looks right in a live TUI.
  See "Manual check" below.
- **`registerChildReporter`** (~438-560) — its activity wiring is exercised
  (the harness fires the events and reads the snapshot back), as is the
  interrupted settle, but the atomic result writing and the shutdown fallback
  still need a real child pi process.
- **`attachToSubagentAndExit`** (~351-400) — ends in `process.exit`, so it needs
  a real terminal; the legacy `v1.` target decode is untested.
- **`subagent_clean` `all_sessions`** — only the in-session path is covered;
  `delete_files` in-session is now covered, including the transcript accounting
  and the retention of a run dir that still owns a live run's session file.
- **Context handoff against a real child.** `handoff.test.ts` and the lifecycle
  tests cover the argv, the seeded session files and the usage baseline without
  launching pi, but the end-to-end path — a real `pi` opening a forked or
  resumed transcript — needs credentials and is not part of the suite.
- **long-poll behaviour** — the fake always reports `pane_dead = "1"`, so
  "pane still alive, keep waiting" is untested; `pi.exec`'s `timeout` option is
  ignored by the fake, so no timeout or abort path runs.

- **the widget's placement in a real terminal.** The tests render the component
  directly with a fake TUI and theme, so `setWidget` is called with the right key
  and placement, but nothing proves the strip looks right in a live TUI. See
  "Manual check" below.

Anything requiring a live child pi process — real context handoff on resume, key
delivery for `subagent_interrupt` against a real TUI, and liveness when a child
hangs — needs an opt-in integration harness with model credentials, which this
devcontainer does not have.

## Environment

Read once, when the extension factory runs:

| Variable | Default | Effect |
|---|---|---|
| `PI_SUBAGENT_MAX_CONCURRENT` | `4` | children running at once; the rest queue |
| `PI_SUBAGENT_NOTIFY` | `true` | push a message into the main session when a run ends |
| `PI_SUBAGENT_AUTO_REAP` | `true` | kill a finished run's tmux session |
| `PI_SUBAGENT_REAP_DELAY_MS` | `0` | wait this long before reaping |
| `PI_SUBAGENT_GC_DAYS` | `7` | delete run dirs older than this |
| `PI_SUBAGENT_KILL_ON_SHUTDOWN` | `false` | kill live children when the parent exits |
| `PI_SUBAGENT_INTERRUPT_CONFIRM_MS` | `3000` | how long `subagent_interrupt` waits for confirmation; `0` returns immediately |
| `PI_SUBAGENT_STALL_SECONDS` | `180` | silence, in whole seconds, before the widget calls a run stalled |
| `PI_SUBAGENT_TOOL_STALL_SECONDS` | `900` | the same, for a run inside a tool call, which is silent by construction |

A value that is set but is not a positive whole number is reported on stderr and
ignored, in favour of the default.

Integers are parsed strictly: `"3m"`, `"1e9"` and `"3.9"` are ignored in favour of
the default, because a threshold silently shortened by a typo is worse than one
that was never set.

## Tool exposure

`lifecycle.test.ts` covers local patch 15: the five management tools are
registered once at `session_start` with `exposure: "codemode"` when the harness
reports `codemode`/`tool_search` active, and plain otherwise; `subagent` is never
hidden; a settings layer that names codemode while the active set does not is
correctly ignored (the active set is pi's resolved truth); and an unbound `pi`
(which throws from `getActiveTools`, exactly as pi does before the runtime binds)
leaves everything declared.

## Flakiness

`waitFor` polls with a 30s bound, because `node --test` runs test FILES in
parallel and a 500ms watcher timer on a loaded machine can slip by seconds — a
tight default turned "the machine was busy" into a red suite several times.
These waits take well under a second in practice, so the bound only fires for a
real break. `waitForRunStatus` goes further for run transitions: when it gives up
it reports the last persisted run record and the tmux poll counts, so a failure
says whether the watcher died or the machine was slow.

## Manual check for turn-level interrupt

With credentials available, the one thing the suite cannot prove is that pi
really aborts a turn on Escape and settles without exiting:

1. `subagent({ task: "count slowly from 1 to 200" })`, note the id.
2. `subagent_interrupt({ id })` mid-stream — it should report `interrupted`.
3. Confirm the child is alive and idle: `tmux -S ~/.pi/agent/tmux-subagents.sock capture-pane -p -t pi-agent-<id>:0.0`
   shows the prompt, and `<runDir>/interrupt.json` exists.
4. Confirm the transcript is intact and still writable. Attach
   (`pi --attach-subagent <id>`), type a follow-up, and watch it answer:
   `subagent_status({ id })` should show `interrupted` alongside a live
   `activity:` phase rather than claiming the child is idle.
5. `subagent_cancel({ id })` and check the tmux session is gone. Resuming the
   transcript afterwards must go through `subagent_cancel` first —
   `subagent_resume` refuses while the interrupted child still holds the file.

## Manual check for the live widget

1. In a TUI session, start a run with a long task. A strip appears above the
   editor within a second: `◔ <id>  starting · 0s · <task>`.
2. Watch it follow the child: `● <id>  active 45s (bash) · 2m 0s · <task>` while
   it works, `◌ <id>  waiting 12s · 4m 3s · <task>` when the child goes quiet.
   Elapsed times must tick on their own, with nothing else happening.
3. Give the child a silent long tool (`sleep 600`): the row must stay `active`
   for `PI_SUBAGENT_TOOL_STALL_SECONDS` (default 900), not 180. A quiet tool is
   working, not hung.
4. Start a second run and check the cap: at most four rows, then `+N more`.
   After `subagent_interrupt`, the interrupted row sorts last so it cannot push a
   live run out of view.
5. `subagent_cancel` the last run: the strip disappears.
6. Run in `--mode rpc` and confirm no widget appears (RPC cannot render one).
