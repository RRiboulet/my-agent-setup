# Don't block on tests: a `bg` tool and a testing rule

## Objective

Long commands take the session hostage. A full-suite run, a container rebuild,
or a dev-server probe blocks the agent for minutes and then reports, so the agent
alternates between waiting and working when it could be doing both. The measured
cost is not spread: it is a handful of very slow calls, repeated by habit.

The goal is to reduce wall-clock and the user's attention on ambitious work, not
to reduce tokens. Cost is not the constraint (≈$0.03 per session, no session has
ever compacted), so the only thing worth optimising is time spent waiting.

## Current behavior

Measured on this machine over the 25 most recent sessions (82 files, 21 MB) on
2026-11-16, pairing each `bash` tool call with its result and reading
`message.durationMs`:

- Wall-clock is 58 447 s, of which 47 589 s (81 %) is unstructured idle in
  sessions left open. On real work time (10 858 s), model calls are 6 632 s
  (61 %) and bash is 4 175 s (38 %).
- That bash time is concentrated: 23 calls over 60 s hold 2 997 s (71 %), and 15
  of them are **the same documented command**
  (`node --test .pi/extensions/subagent/test/*.test.ts`) at 143–178 s each —
  2 187 s, or 52 % of all bash time. The median bash call is 40 ms.
- Polling is the second cost: 43 commands containing `sleep` hold 1 183 s (28 %),
  including a deliberate `sleep 240`, plus ~874 s of re-running a command that had
  already been run in the same session.
- Errors are not a cost: 44 non-zero exits over 994 calls (4.4 %), 210 s in total,
  ~21 s of retry overhead.
- The tool mix is 85 % `bash` (994) against 15 `read`, 55 `edit`. So output
  discipline lives in bash, not in the file tools.

There is no way today to start a long command and keep working: `bash` blocks
until it exits or its timeout fires, and the documented workaround in sessions is
`nohup … &` followed by `sleep` and `tail`, which is exactly the polling cost
above.

## Required behavior

1. A `bg` tool with actions `start`, `status`, `logs`, and `kill`, registered so
   that it costs **zero prompt tokens** until the model loads it through
   `tool_search` (deferred exposure, inactive at registration).
2. `start` returns within about a second with a job id, the log path, and the
   command as recorded. The command runs detached in its own process group, with
   the session's working directory and the same session environment the built-in
   bash tool exposes. Nothing about `start` waits on the command.
3. `status` with no id lists this session's jobs: id, state, exit code, elapsed,
   and the first line of the command. With an id it reports the same for one job.
   States are `running`, `exited`, `killed`, and `failed-to-start`.
4. `logs` returns the tail of combined stdout and stderr using the repository's
   existing tail-truncation limits, with the usual notice when truncated. Asking
   for logs of a running job returns what exists so far rather than an error.
5. `kill` terminates the job's process group: SIGTERM, then SIGKILL after a
   five-second grace, mirroring how the harness already terminates commands.
   Killing an already-finished job is a no-op with a clear message, not an error.
6. When jobs finish, the extension sends **one** message per settle window listing
   every job that finished in it — id, first line of the command, exit code,
   duration, log path — rather than one message per job. While the agent is
   streaming it is delivered as a steer; when the agent is idle it starts a turn.
7. On session start the tool repairs its own state: a job recorded as running
   whose process is gone is marked exited, a still-live job started by this
   session is adopted and still notifies on completion, and job directories past
   the retention window are removed.
8. `AGENTS.md` states the testing discipline: while iterating, run only the test
   file(s) for what you touched; run the full suite exactly once before commit,
   and run that one through `bg`.
9. `CHANGELOG.md` gains an `Unreleased` entry describing the tool and the rule,
   with the dated measurements that motivated it, in the repository's existing
   style.

## Non-goals

- **No change to `bash`.** It keeps its blocking semantics; auto-detaching a
  running command after a threshold was considered and rejected as magic.
- **No persistence of a job across sessions beyond pid adoption.** A resumed or
  new session adopts what is still alive; it does not replay a log it missed.
- **No additional notification surfaces.** No desktop notification, status-line
  counter, or tmux pane.
- **No suite speedup in this change.** Whether the 145 s suite is CPU-bound or
  wait-bound on spawned tmux/subagent processes is unmeasured; it decides whether
  the follow-up is a concurrency flag or a restructuring, and that is a separate
  spec.
- **No `arena` or `swarm` skill.** `arena` is the next change, as its own PR.

## Constraints

- No new npm dependencies. `node:child_process` and `node:fs` only, matching the
  repository's zero-dependency posture.
- The extension must load under node's strip-only TypeScript loader and be strict
  ESM; the existing extension-load test pins that for every entry point.
- Tool results must use the exported truncation helpers rather than ad-hoc
  slicing.
- Deferred registration must be verifiable, not asserted in prose: the tool's
  registration metadata is what the test checks.
- Log storage must be bounded. A job that writes forever must not fill the agent
  directory, and the agent must be told when a log was capped.
- Watchers and timers must stop on shutdown, or the suite cannot drain and exits
  by timeout.

## Design decisions

**Storage layout.** Job state lives under the agent directory, one directory per
job, keyed by session: a metadata file plus a combined output log, with metadata
written atomically (write-then-rename). Rejected: a single JSON index for the
whole session (concurrent `start` calls would race on it), and `/tmp` (lost on
container rebuild, and no affinity with the session that owns the job).

**Spawn, don't wrap.** Jobs are ordinary detached child processes in their own
process group, with stdout and stderr piped to the log. The process-group id is
the pid, so killing is one negative-pid signal. Rejected: running jobs inside
tmux (job lifetime would then depend on a tmux server and duplicate the subagent
extension's machinery for no gain).

**Watch by poll, not by `exit` event.** A single watcher timer observes pid
liveness and log size, so a job adopted after a restart follows exactly the same
state machine as one started in-process. This is the same shape as the subagent
extension's watcher, including its shutdown flag, which the suite depends on.

**Coalesce notifications, don't queue them.** One debounce timer per settle
window, one message for however many jobs finished. Rejected: per-job messages
(noise proportional to parallelism, which is the shape we are moving toward) and
passive polling (reproduces the `sleep`-and-`tail` loop this change exists to
remove).

**One cap, not a corpus.** Each log is capped at a fixed size with a truncation
marker appended when the cap is hit; job directories are pruned by age on session
start. Retention and cap are constants with named settings, not a configuration
surface.

**Where the rule goes.** The testing rule belongs in the `Tests` section of
`AGENTS.md`, beside the commands it governs, because that is where a human or
agent looks before running them. Rejected: a skill, because a skill is loaded on
demand and the failure mode being fixed is running the expensive command out of
habit, before anything is loaded.

## Test seams

1. **The tool's behaviour through the real extension factory**, booted against a
   temporary agent directory, driving `start`/`status`/`logs`/`kill` and asserting
   results. Prior art: the `todo` tool's test file boots the real factory and
   drives the real `execute`; the shared helpers already provide a temp agent dir
   and a generous poll.
2. **Notifications at the message seam**, with the fake API recording messages the
   way the subagent lifecycle test records registrations and exposure. This is
   where "exactly one message per settle" is observable without a terminal.
3. **Real processes for lifecycle behaviour** — short shell commands that sleep,
   exit non-zero, spawn a grandchild, or ignore SIGTERM — because pid liveness,
   process-group kill, and the SIGKILL grace are the behaviour under test, and a
   mock would assert our beliefs instead.
4. **Documentation as shape**, asserting the `AGENTS.md` rule and the changelog
   structure, following the existing changelog and skill-shape tests, which check
   structure rather than wording.

## Acceptance criteria

Behaviour 1 — deferred registration:

- [ ] The tool's registration carries deferred exposure and starts inactive, and a
      test asserts both.

Behaviour 2 — non-blocking start:

- [ ] `start` of a command that sleeps for 30 s returns in under 2 s with a job id
      and a log path, and `status` immediately reports it running.
- [ ] The job's working directory and session environment variables are what the
      built-in bash tool would use.

Behaviour 3 — status:

- [ ] Listing shows every job of the session with state, exit code, elapsed, and
      command; a single id shows one.
- [ ] A command that cannot start at all is reported as `failed-to-start`, not as
      a running job.

Behaviour 4 — logs:

- [ ] A job writing 5 000 lines returns the tail with the truncation notice, not
      the whole log.

Behaviour 5 — kill:

- [ ] Killing a running job reports it killed and the process is gone within the
      grace period; a command that ignores SIGTERM is still gone after SIGKILL.
- [ ] Killing a finished job is a no-op with a message, not an error.

Behaviour 6 — notifications:

- [ ] Three jobs finishing within the same window produce exactly one message
      naming all three, with exit codes and durations.
- [ ] With the agent streaming, the message is delivered as a steer; with the
      agent idle, it starts a turn.

Behaviour 7 — repair:

- [ ] A metadata record claiming a dead pid is repaired to `exited` on session
      start.
- [ ] A live job is adopted and its completion still notifies.

Behaviours 8 and 9 — docs:

- [ ] `AGENTS.md` carries the rule; `CHANGELOG.md` carries the entry under
      `Unreleased`.

Measured outcome, on the three replay tasks (infra rebuild + suite; a small
feature with tests; a real bug fixed from a failing test), two runs each, default
model and thinking level, evaluated on the mean:

- [ ] **Infra task: zero calls over 60 s.** The baseline was 4 per run, every one
      of them self-inflicted polling.
- [ ] **Blocking bash time per session ≤ 50 % of baseline**, on all three tasks.
- [ ] **Explicit full-suite runs ≤ 1 per task.** A rebuild's internal suite run
      is named and excluded, not silently uncounted.
- [ ] **Feature task: at least 30 s of the suite run overlaps other tool work.**
      The baseline was 0, because a blocking run cannot overlap anything.
- [ ] **Wall-clock is reported, not thresholded.** A difference under 10-15 % is
      called noise: the feature task varied 31 % between identical baseline runs.

**Revised 2026-11-16, after the baseline was measured.** The first draft of this
section asked for infra wall-clock ≤ 60 % and ≤ 1 full-suite run per task. Both
were wrong for reasons the baseline exposed rather than the change failing:

- The rebuild's critical path is 274-340 s and its postCreate runs the suite
  (145-169 s), with the explicit suite adding 141-179 s more. That is 65-72 % of
  the 671-694 s baseline *before* any polling is removed, so no amount of
backgrounding reaches 60 % on that task. The polled calls, not the wall clock,
are what this change can actually delete there: 4 per run, all `sleep`.
- "≤ 1 suite run" counted only the explicit one, because the postCreate run is
  nested inside the rebuild and invisible to a command-level count.
- The feature task's baseline is stale for a second reason: this repo's suite was
  184 s serial when it was measured and is ~121 s now that test files run
  concurrently. The feature baseline is recaptured against the merged base with
  `bg` unavailable; the infra and bug baselines are reused as measured, because
  neither runs this repository's suite.

What the change is expected to move on the infra task is therefore the count of
calls over 60 s (4 → 0) and the blocking bash seconds, with wall-clock reported
beside them and explained.

## Verification

```bash
bash .pi/extensions/subagent/test/setup-deps.sh
node --test .pi/extensions/subagent/test/bg.test.ts      # the new seams alone
node --test .pi/extensions/subagent/test/*.test.ts       # the whole suite, once
```

The measured outcome needs a timed replay, not an argument: baselines come from
session JSONL timestamps using the same field the baseline above was derived from
(`durationMs` on tool-result entries), and the before/after numbers are recorded
in the changelog entry with their dates, as this repository already does for
measurements. The full suite in the final run is itself started through `bg`, so
the new path is exercised on its own acceptance run.

## Open assumptions

- **The 145 s suite's cost structure is unknown.** If it is CPU-bound, the
  follow-up is a concurrency or sharding flag; if it is wait-bound on spawned
  processes, it is a restructuring. Risk: the follow-up may be larger than the
  main change. Confirmed by running the suite with timing instrumentation before
  that spec is written.
- **A one-second coalescing window is a guess.** Too short and a parallel fan-out
  produces several messages; too long and a single job's completion is delayed.
  Risk: noise or latency at the edges. Tuned against the replay tasks.
- **Idle-turn triggering can surprise.** A job started in one turn and finishing
  after the user has moved on will start a turn. Risk: an unwanted turn on a stale
  job. Mitigated by naming the job and its age in the message, so the agent can
  recognise a stale completion.
- **The four thresholds assume the replay tasks are representative.** If the infra
  task's time is dominated by an image pull, 60 % may be unreachable through
  backgrounding alone. Confirmed by the first baseline run, before any threshold
  is treated as binding.
