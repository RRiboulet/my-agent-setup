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
| `status.test.ts` | `runSummary`, `isTerminal`, `holdsChild`, `runDirOwnsLiveTranscript`, `formatDuration`, `trimPane`, `truncateToolText`, `textFromAssistant` |
| `usage.test.ts` | child session usage/cost accounting |
| `handoff.test.ts` | child launch argv per mode, lineage/fork session seeding, live-branch fork ordering, and the usage baseline |
| `lifecycle.test.ts` | launch, concurrency queueing, finalisation, failure detection, cancel, wait, status, clean, shutdown stops the watcher, turn-level interrupt |
| `interrupt.test.ts` | the `interrupt.json` marker (validation, reading, writing), the child reporter's abort path, and the parent lifecycle of an interrupted run |
| `helpers.ts` | env/temp-dir isolation and polling helpers |

`lifecycle.test.ts` drives the real extension factory with a fake
`ExtensionAPI`; all tmux access goes through `pi.exec`, so no tmux server or
child pi process is required. `PI_CODING_AGENT_DIR` is redirected to a temp
directory, so the tests never touch the real `~/.pi/agent` tree.

## Not covered here

About 20% of `index.ts` lines are still untested. The gaps, in rough order of
size:

- **the `/subagents` dashboard** (`index.ts` ~1680-1800) — the handler is never
  invoked, because the harness stubs `registerCommand`. Layout, selection and
  the refresh interval are not covered.
- **`registerChildReporter`** (~438-560) — its activity wiring is exercised
  (the harness fires the events and reads the snapshot back), as is the
  interrupted settle, but the atomic result writing and the shutdown fallback
  still need a real child pi process.
- **`attachToSubagentAndExit`** (~214-270) — ends in `process.exit`, so it needs
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

Anything requiring a live child pi process — real context handoff on resume, key
delivery for `subagent_interrupt` against a real TUI, and liveness when a child
hangs — needs an opt-in integration harness with model credentials, which this
devcontainer does not have.

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