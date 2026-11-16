# Baselines for the three `bg` replay tasks

**Date:** 2026-11-16
**Machine:** aarch64 Ubuntu 24.04.5, pi 1.5.2, `opencode-go/deepseek-v4.1-flash`
at thinking level `high` (the host defaults). The `my-agent-setup` package that
`~/.pi/agent/settings.json` installs was the checkout at `0da2533`; the feature
task necessarily ran against the `dev` source at `5946170` instead (see "Setup").
**Spec:** `docs/specs/2026-11-16-bg-tool-and-test-discipline.md`, *Measured
outcome*.
**Ticket:** `docs/tickets/bg-tool-and-test-discipline/02-replay-baselines.md`.

This is the "before" side of the measured outcome. Ticket 08 reruns the same
three tasks against these numbers. Every figure below is from a session file
written by a real run on this machine; none is estimated, interpolated, or
copied from the spec's earlier diagnosis.

## The four numbers

Measured per session by `tools/measure-bash-blocking.mjs`:

1. **Task wall-clock** — the last minus the first timestamp in the session
   JSONL. For `pi -p`, that is the task from process start to the final message.
2. **Blocking bash seconds** — the sum of `message.durationMs` over bash tool
   results. This is time the agent spent waiting on a `bash` call.
3. **Bash calls over 60 s** — how many of those results report more than
   60 000 ms.
4. **Full-suite runs** — how many bash calls ran a repository's whole test
   suite rather than a targeted file.

## Method

### What counts as a run

One run is **one fresh `pi -p` process**, with one session file, one fixed
prompt, and the task's working directory as cwd. No run continues an earlier
session, so run 2 of a task cannot benefit from run 1's context.

The launch shape, identical for all six recorded runs:

```bash
cd <task-cwd>
env -u PI_CODING_AGENT -u PI_CODING_AGENT_DIR -u PI_MODEL -u PI_PROVIDER \
    -u PI_REASONING_LEVEL -u PI_SESSION_FILE -u PI_SESSION_ID \
    -u PI_TMUX_SUBAGENT_CHILD -u PI_TMUX_SUBAGENT_INTERRUPT \
    -u PI_TMUX_SUBAGENT_RESULT -u PI_TRUE_COLOR \
    [PI_CODING_AGENT_DIR=<feature agent dir>] \
    pi -p --approve "$(cat <prompt-file>)" < /dev/null
```

The `PI_*` scrub matters: this document was written from inside a subagent
session, and an unscrubbed child `pi` inherits that session's identity and agent
directory. The `< /dev/null` matters too: without it, `pi -p` reads the parent
script's stdin as part of its input. Both were found the hard way (see "False
starts").

`--approve` trusts the project's `.pi` files (extensions, settings) without an
interactive prompt. It does not change which model, provider, or thinking level
is used.

### Setup, excluded from the timed run

Setup is done before `pi` starts, so it is **not** in any wall-clock figure
below. Ticket 08 must do the same setup or its numbers will not be comparable.

**Feature task** (a fresh worktree per run, from `origin/dev`):

```bash
git -C /home/ubuntu/my-agent-setup worktree add \
    .worktrees/replay-feature-N -b replay-feature-N origin/dev
cd /home/ubuntu/my-agent-setup/.worktrees/replay-feature-N
bash .pi/extensions/subagent/test/setup-deps.sh
```

`setup-deps.sh` links pi's globally installed packages into the worktree's
`node_modules`; without it no `node --test` can run in a fresh worktree.

**Feature runs need a package-free agent dir.** A my-agent-setup checkout
contains `.pi/extensions`, and `~/.pi/agent/settings.json` also installs
`my-agent-setup` from git. Running pi in the worktree with the default agent
dir loads both copies and aborts on duplicate tools (the extensions report
conflicts one by one, starting with `Tool "get_goal" conflicts with …`). The repo documents this trap, and its
devcontainer avoids it with a package-free agent dir. The recorded feature runs
did the same on the host with a dedicated one:

```bash
# /home/ubuntu/.pi/agent-replay-feature
#   settings.json: ~/.pi/agent/settings.json minus `packages` (and the
#                  package-version bookkeeping keys); same model,
#                  thinking level, enabledModels, defaultTools
#   symlinks: auth.json, models-store.json, review-triage.json, cache,
#             themes, bin, and sessions -> ~/.pi/agent/sessions
```

The `sessions` symlink is deliberate: pi writes the run's JSONL into the same
tree the measurement script scans.

**Bug task** (a fresh worktree at the analytics-agent `dev` HEAD, plus the
recorded spec):

```bash
git -C /home/ubuntu/analytics-agent worktree add \
    .worktrees-replay/bug-N -b replay-bug-N HEAD
cp -r specs /home/ubuntu/analytics-agent/.worktrees-replay/bug-N/
devc analytics-agent -- bash -lc \
  'cd /workspace/.worktrees-replay/bug-N/analytics-agent && uv sync'
```

The spec is copied because it is untracked in the analytics checkout, where
another session is working on the same defect. The worktree at `HEAD` is clean,
so that session's uncommitted work cannot leak into a replay, and `uv sync`
(pre-warmed) keeps the first test call from paying for environment creation.

**Infra task:** no setup. The task's own first command is `devc doctor`; its
rebuild is the thing being measured.

### The measurement, and why it is trustworthy

```bash
node tools/measure-bash-blocking.mjs
```

The script walks `~/.pi/agent/sessions` recursively, parses every
`type: "message"` line, indexes assistant `toolCall` blocks by `id`, and joins
each `toolResult` to its call through `toolCallId`. The duration is read from
the **result** entry's `message.durationMs`.

That choice was verified, not assumed:

- On the 82 pre-existing session files, all **2 395** bash tool results paired
  with a call and carried a finite `durationMs`; zero were missing.
- Recomputing the spec's own window — the 25 most recent of those 82 files —
  gives **994 bash calls** and **23 calls over 60 s**, exactly the spec's
  figures. The bash total is 4 208 s against the spec's 4 175 s; the 33 s (0.8 %)
  difference is the session-window boundary, not the join.
- The wall-clock from the file span agrees with the external `time` of the six
  runs to within 2 s (table below).

Full-suite detection is by command shape: `node --test
.pi/extensions/subagent/test/*.test.ts`, `npm test` / `npm run test`, or a bare
`uv run pytest` / `pytest` with no file, path, `::` selector, or `-k`
expression. The script skips chunks that start with a read-only command
(`grep`, `echo`, `sed`, …), chunks containing a heredoc, and `DEVC_DRY_RUN=`
invocations, so a command that merely *mentions* `npm test` does not count. It
prints every detected command beside its session id, so the classification can
be checked by eye.

**What it deliberately does not measure:** model/reasoning time (it is inside
wall-clock but not broken out), idle gaps, non-bash tools, tokens or cost, and
whether a slow call was necessary or a poll. `durationMs` also cannot see work
that continues after a call returns — an infra run that backgrounds `devc
rebuild` and polls shows the wait in the later `sleep` calls, not the start.

## The three tasks

### 1. Infra — recreate a project container and run its suite

**Hard constraint:** never rebuild the my-agent-setup devcontainer; it hosts
live sessions. The task uses `pupkeep`, whose container nobody else is using.

**Setup:** none.

**Prompt, verbatim** (`/tmp/replay/prompts/infra.txt` in the recorded runs):

```text
Maintenance task in /home/ubuntu/pupkeep. Do exactly this, in order:

1. `devc rebuild pupkeep` — recreate this project's devcontainer. Named volumes are kept.
2. `devc pupkeep -- bash -lc 'npm test'` — run the project's full test suite inside the fresh container.

Then report: the suite's exit code, and its final summary line. Do not edit any file, do not touch any other project's devcontainer (never rebuild my-agent-setup), and do not push. Finish as soon as you have the suite result.
```

**Done means:** the rebuild reports `"outcome":"success"` and the explicit suite
reports `895 passed, 0 failed` with exit code 0. Both recorded runs did.

### 2. Feature — one small feature in an existing extension, with tests

The feature is the `todo` tool's `count` action: a read-only per-status tally
that shares `list-all`'s directory and parsing, reports a missing status as
`unknown`, and returns `0 todos` on an empty directory. It is small, has a real
public seam (the tool's `execute`), and is not vendored code.

**Setup:** the worktree and `setup-deps.sh` commands above, plus the
package-free agent dir.

**Prompt, verbatim** (`/tmp/replay/prompts/feature-N.txt`; `{{HOST_WORKTREE}}`
was `/home/ubuntu/my-agent-setup/.worktrees/replay-feature-N`):

```text
Feature task in this worktree ({{HOST_WORKTREE}}). You are already on a dedicated branch; do not create another worktree or branch.

Add a `count` action to the `todo` tool in `.pi/extensions/todos.ts`:

- It returns the number of todos per status plus the total. Plain text: `3 todos: done 1, open 2` — statuses sorted alphabetically, singular `todo` when the total is 1.
- `details` is `{ action: "count", total: 3, statuses: { done: 1, open: 2 } }`, with the same alphabetical key order.
- It is read-only: it must not create, modify, delete, or claim anything.
- It counts every todo in the same directory `list-all` reads, parsed the same way. A todo with no status counts as `unknown`.
- An empty directory returns the text `0 todos` and `{ action: "count", total: 0, statuses: {} }`.

Add tests for the new action in `.pi/extensions/subagent/test/todos-tool.test.ts`: the empty case, and a case with several todos covering at least two statuses. While iterating run only that test file. When it is green, run the full suite exactly once:

    node --test .pi/extensions/subagent/test/*.test.ts

Do not commit and do not push. Report the full-suite pass/fail counts.
```

**Done means:** the `count` action works, its tests pass, and the one full-suite
run is green. Both recorded runs did (1 137 and 1 138 tests passing, 0 failing).

### 3. Bug — fix one recorded defect from a failing test

The defect is **gap 3** of `analytics-agent/specs/0001-manager-eval-tool-call-counts.md`
§2, recorded against the analytics-agent repo:

> `scripts/run_manager_evaluation.py` … builds its own record dict instead of
> using `CaseResult.to_record()` — `results.json` has no `tool_calls` key at all.

This is a deliberate narrowing of the spec's three gaps: gaps 1 and 2 (the
counting seam) are out of scope, and the prompt says so. The recorded failure is
real and reproduced before writing: `_record()` on a case result carrying
`{"query": 3}` returned a dict without a `tool_calls` key.

**Setup:** the worktree, spec copy, and `uv sync` commands above.

**Prompt, verbatim** (`/tmp/replay/prompts/bug-N.txt`; `{{HOST_WORKTREE}}` and
`{{CONTAINER_WORKTREE}}` were the bug-N worktree paths):

```text
Bug-fix task in this worktree ({{HOST_WORKTREE}}). The project home is its `analytics-agent/` directory. You are already on a dedicated branch; do not create another worktree or branch.

The recorded defect: `scripts/run_manager_evaluation.py` builds its own `_record()` dict and omits `tool_calls`, so `results.json` has no `tool_calls` key at all even though `CaseResult` carries the field. This is gap 3 in `specs/0001-manager-eval-tool-call-counts.md` §2; gaps 1 and 2 (the counting seam) are out of scope.

Start from a failing test: add a test pinning the missing behaviour — a case result carrying a non-empty `tool_calls` dict must round-trip through `_record()` — run it, and confirm it fails for the right reason. Then fix the script and confirm the test passes.

Run tests inside the devcontainer, e.g.

    devc analytics-agent -- bash -lc 'cd /workspace/{{CONTAINER_WORKTREE}}/analytics-agent && uv run pytest tests/test_manager_evaluation.py -q'

(adjust the test path to the file you changed; the `.venv` is already synced).

Finish by running the full suite:

    devc analytics-agent -- bash -lc 'cd /workspace/{{CONTAINER_WORKTREE}}/analytics-agent && uv run pytest -q'

Do not commit and do not push. Report the failing-test evidence and the full-suite result.
```

**Done means:** a test that fails before the fix and passes after, and a green
full suite. Both runs added `"tool_calls": result.tool_calls` to `_record()`,
added a test with a non-empty dict, and finished `319 passed, 1 skipped`.

## Results

Session ids are the lookup key in the measurement output. "External" is the
runner's `time`; "wall" is the session file span.

| Run | Session | External | Wall s | Bash calls | Blocking bash s | >60 s | >60 s sum | Suite runs | Outcome |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| infra-1 | `01a1e4f6-0f72-7515-a5ae-121471267997` | 672 s | 671.7 | 6 | 643.4 | 4 | 593.9 | 1 | rebuild ok; 895/895 |
| infra-2 | `01a1e500-5105-7781-9d54-9982ed84f6cc` | 694 s | 693.9 | 9 | 636.2 | 4 | 632.3 | 1 | rebuild ok; 895/895 |
| feature-1 | `01a1e511-716a-76ae-ae07-075ad6a75e2c` | 294 s | 293.6 | 8 | 205.0 | 1 | 194.9 | 1 | 1 137/1 137 |
| feature-2 | `01a1e515-efb9-74fb-9452-8068c7357835` | 298 s | 296.8 | 14 | 152.5 | 1 | 149.3 | 1 | 1 138/1 138 |
| bug-1 | `01a1e50b-38dd-70e0-97c6-309104a1835d` | 173 s | 171.8 | 22 | 90.5 | 0 | 0.0 | 1 | 319 passed, 1 skipped |
| bug-2 | `01a1e50d-da52-774b-96db-ae99d02c2d87` | 203 s | 202.4 | 16 | 92.0 | 0 | 0.0 | 1 | 319 passed, 1 skipped |

All six recorded runs completed with exit code 0. The suite-run counts count
only the **explicit** suite command; see the infra caveat below.

### Infra detail

- Wall-clock is almost entirely blocking bash: 643/672 s and 636/694 s (96 % and
  92 %). The >60 s calls are the agent's own polls — `sleep 120`, `sleep 150`,
  `sleep 180` in run 1, and a 301 s `for … sleep 15` loop in run 2 — plus the
  explicit suite.
- The rebuild is ~340 s (run 1) and ~274 s (run 2). For run 2 the log file's
  last write is `15:40:39` and the container was created at `15:36:48`, against
  a launch at `15:36:05`; for run 1 the last logged output is at `~15:30:39`
  against a launch at `~15:24:58`, so the following `sleep 180` was pure
  overshoot. **postCreate runs `npm test` inside the rebuild**: 168.8 s in run 1
  and 145.5 s in run 2, invisible as separate bash calls because it happens
  inside the single `devc rebuild` call. The explicit suite then ran again for
  140.9 s / 178.5 s.
- Run 2's rebuild also downloaded Playwright Chromium: `100% of 195.7 MiB`,
  `chromium-1254`, plus FFmpeg, into the container's cache. The cache is not on
  a named volume, so every recreate pays for it. Run 1's log was overwritten by
  run 2, but its postCreate ran the same browser-render tests and passed them,
  so it installed a browser too.
- The task's irreducible critical path is therefore
  `rebuild (~274–340 s) + explicit suite (141–179 s)`: about **482 s (72 %)**
  in run 1 and **453 s (65 %)** in run 2. The agent's polling overshoots that
  (672/694 s measured), but backgrounding cannot go below the critical path.

### Feature detail

- One full-suite run dominates: 194.9 s of 205.0 s blocking bash in run 1, and
  149.3 s of 152.5 s in run 2. Everything else is reads and one targeted test
  file (9 s and ~1 s).
- The same task, same tests (1 137 vs 1 138) produced a 31 % spread in suite
  time (194.9 s vs 149.3 s). Both runs first ran the targeted test file (9 s in
  run 1, ~1 s in run 2, plus a 1 s rerun after an edit). Nothing about the
  change explains the suite-time difference; treat it as machine noise (another
  unrelated agent session was active on this host during the window).
- Run 2 also added a `CHANGELOG.md` entry, which the prompt did not ask for.
  That is a small scope difference between the two runs, not a measurement
  difference; it did not add a suite run.

### Bug detail

- No call exceeded 60 s. The full pytest run is 49 s (run 1) and 45 s (run 2),
  under the threshold.
- Most of the 22/16 calls are `devc analytics-agent -- …` exec calls of 0–7 s:
  the devcontainer boundary adds ~3–6 s per test invocation, which is why bash
  time (90–92 s) is high relative to the suite alone.
- Both runs made the same one-line production change and added a test; the
  diffs are 26 and 29 added lines, both touching
  `scripts/run_manager_evaluation.py` and `tests/test_manager_evaluation.py`
  only.

## False starts (excluded, not measured)

Recorded here because honesty about what was thrown away is part of the method.

1. **Two infra launches were aborted by the operator and are not in the
   numbers.** The first put the wrong prompt in the session because the driver
   did not redirect `pi`'s stdin, so `pi` read the rest of the task list. The
   second was killed as soon as the first was found still alive, because both
   were driving `devc rebuild pupkeep` and contending on the project lock.
   Their session files were deleted before this document was written; the
   container rebuild was simply redone by the recorded run that followed.
2. **Two feature launches aborted at startup (exit 1, no session file)** with
   duplicate-tool errors, because the worktree's `.pi/extensions` collided with
   the git-installed package in `~/.pi/agent`. They never reached a model call.
   The recorded feature runs use the package-free agent dir described above.
3. **Three smoke sessions** (`/tmp/pi-smoke`, "reply OK") were deleted; they were
   launch checks, not task runs.

No run was replaced, re-run after seeing a disappointing number, or averaged
away. Each row is one launch.

## What this data already makes suspicious

1. **The infra wall-clock threshold (≤60 % of baseline) looks unreachable as
   the task is written.** The critical path — recreate + the explicit suite —
   is 65–72 % of the measured baseline before any of the agent's polling is
   removed. `bg` can remove the 593–632 s of >60 s polling, but it cannot
   overlap the rebuild with its own suite. If ticket 08 misses this threshold,
   the task definition or the threshold is the cause, not the tool. The spec's
   own open assumption anticipated exactly this shape ("if the infra task's
   time is dominated by an image pull"); here it is a Chromium download and a
   postCreate suite, not an image pull, but the consequence is the same.
2. **"Full-suite runs ≤ 1" undercounts the infra task by one.** The recreate
   runs the project suite inside postCreate, and the task then runs it again.
   The script reports 1 because the first execution is nested inside
   `devc rebuild`. If the threshold is meant to bound *suite executions*, the
   infra task starts at 2 and fails it; if it is meant to bound *agent-issued
   suite commands*, it is 1 and trivially met. The spec should say which.
3. **Blocking bash and wall-clock are not independent.** On the infra task,
   blocking bash is 92–96 % of wall-clock, so halving bash time can nearly halve
   wall-clock — but only by removing polling, which is exactly the part `bg`
   removes. On the feature task the single suite run is 50–66 % of wall-clock;
   on the bug task bash is 45–53 %. A single "blocking bash ≤50 %" threshold
   will therefore be easy on infra, meaningful on feature, and tight on bug
   unless the devcontainer exec overhead is also addressed.
4. **Two runs do not bound the suite's variance.** The same my-agent-setup
   suite took 194.9 s and 149.3 s (31 % apart) with no difference in the test
   set large enough to explain it. Any after/before comparison that treats a
   wall-clock difference smaller than that as a result is noise.
5. **"Calls over 60 s ≤ 1 per task" is already met by the bug task (0) and the
   feature task (1).** It only bites the infra task, where all four >60 s calls
   per run are self-inflicted polling. This is the threshold `bg` should clear
   most obviously, and the one least able to demonstrate a wall-clock win.

## Reproduce

```bash
# From this repository root. Read-only, no arguments, node stdlib only.
node tools/measure-bash-blocking.mjs
```

It prints one row per session, newest first; the six ids above are the replay
runs. To rerun a task, use the setup and prompt blocks above, launch `pi` with
the scrubbed environment, and then read the new session's row. The full suite
once before commit is the repository's own command:

```bash
bash .pi/extensions/subagent/test/setup-deps.sh
node --test .pi/extensions/subagent/test/*.test.ts
```
