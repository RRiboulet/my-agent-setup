# Harness benchmark

Ticket 00's measurement harness. One command records a baseline, the same
command records the changed state, and the difference is a table instead of an
argument.

It measures two different things, because one kind does not fit all five
tickets:

- **Model runs** (`run.mjs`) for harness-level changes: fixed tasks, fixed
  models, two states. Tool calls, wall clock, longest tool call, tokens, errors,
  and whether the task's check passed.
- **A deterministic microbenchmark** (`devc-latency.mjs`) for `devc`, where the
  cost is subprocess latency and a model only adds noise.

## Model runs

```bash
# what is defined
node tools/bench/run.mjs --list

# the cells, without spending a token (resolves and validates the repos, so the
# fixture worktrees have to exist; --list is the view that does not need them)
node tools/bench/run.mjs --state baseline --tasks head-hash,devc-ls --models deepseek-v4.1-flash --dry-run

# the same recorded task set, pointed at another clean checkout
node tools/bench/run.mjs --state baseline --tasks head-hash --models deepseek-v4.1-flash --repo /path/to/a/clean/checkout

# one task, one model, real run
node tools/bench/run.mjs --state baseline --tasks head-hash --models deepseek-v4.1-flash

# the full grid
node tools/bench/run.mjs --state baseline --models deepseek-v4.1-flash,glm-5.3-flash,hy4-flash-free
```

A cell is (task, model, state) and writes one JSON file to
`tools/bench/results/<state>/<encoded-model>/<task>.json (`encodeURIComponent`, so a `:` and a `/` cannot collide)`. An existing cell is
skipped unless `--force`, so a long grid can be resumed.

`--state` is required and is the label that names the harness state. Use
`baseline` before a change and `changed` after it. The state is a label, not a
git ref: record the commit in the result file (`repoState.head`) and keep the
two states on the same base when comparing.

### Tasks

`tasks/*.json`, one task per file:

```json
{
  "id": "head-hash",
  "repo": ".worktrees/bench-fixture",
  "timeoutMs": 120000,
  "prompt": "Run `git log -1 --format=%H` and reply with only the hash.",
  "check": { "expectAnswerContains": ["{{gitHead}}"] }
}
```

The prompt may use `{{gitHead}}`, `{{extensionsCount}}`, `{{docsCount}}`,
`{{repo}}` and `{{date}}`; the runner resolves them against the task's repo at
run time. `check` may use `expectAnswerContains`, and/or a `command` run in the
repo with `expectContains` / `expectExit`.

The check is data, not a harness error: a failed check is recorded and the
runner exits 0. A missing task, a dirty repo, or a spawn failure is an error and
the runner exits 1.

#### Where a task runs

`repo` is the workspace the cell runs in, and it is recorded **relative to the
repository root** in every file under `tasks/`: `.worktrees/bench-fixture` and
`.worktrees/bench-tdd-baseline` for the twelve harness scenarios, and `.` for the
two `devc` ones, whose prompt reads nothing from the workspace. Those two set
`"allowDirty": true`, because `.` **is** the checkout the operator is editing:
the dirty refusal would otherwise make `--tasks all` (the default) unusable
whenever work was in flight, for tasks that never look at the workspace. The relative form
is deliberate: an absolute path to one machine's agent directory made the whole
recorded set unrunnable anywhere else, while a relative one resolves to the same
place in any checkout of this repository. Absolute paths are still accepted for a
workspace genuinely outside this repository.

The resolution order, in one place, is:

1. `--repo <path>` when given — resolved against the directory you run from, and
   it wins over every task's own field, relative or absolute.
2. Otherwise the task's `repo` as written: absolute used as-is, relative resolved
   against the repository root (the directory holding `tools/`).
3. `--list` and `--dry-run` show the result of that order, so what you see is
   where the cell will run.

Every cell records the resolved path in `repo`, alongside `repoConfigured` (the
task file's own value) and `repoOverride` (the flag, or `null`), so a result file
says where it ran and whether one flag put every task there.

`--list` is the catalogue view: it prints each task's effective repo and exits
without touching the filesystem, so it works before the fixture worktrees exist.
`--dry-run` resolves *and validates*, because it is the same preflight a real run
uses: a repo that does not exist, is not inside a git work tree, or is dirty
without `--allow-dirty` fails the whole invocation **before any cell starts**,
listing every offending task with its fix. A cell is never silently skipped — a
task dropped from a run would silently drop out of the comparison.

### Isolation

A task must be **read-only**. The runner does not create a worktree per cell, so
a task that edits its repo leaves the next cell dirty and the comparison
worthless. The runner refuses a dirty repo unless `--allow-dirty` (or the task
sets `"allowDirty": true`, which is recorded).

The exemption is for workspaces that cannot be dirty by choice, not for tasks
that want to edit: the two `devc` tasks use it because their `repo` is `.` — the
checkout the operator is editing — while their prompts read nothing from it. A
task that mutates its repo should not carry the field; fix the task instead.

Use a clean checkout — a detached fixture worktree works, and the recorded set
already names it relative to the repository root:

```bash
git worktree add --detach .worktrees/bench-fixture origin/dev
git worktree add --detach .worktrees/bench-tdd-baseline <ref>
```

The harness itself is whatever `pi` loads from the agent configuration; the task's
`repo` is only the workspace the task runs in. Do not point tasks at the checkout
you are editing: pass `--repo <path>` for a different clean checkout, or
`--allow-dirty` when the workspace is legitimately open in another session. (The
two `devc` tasks are the recorded exception: see `allowDirty` above.)

### Models

`hy4-flash-free` is live on `opencode-go` but absent from `enabledModels` in the
agent settings. Add it there, not to the model catalogue:

```json
"enabledModels": ["opencode-go/beam-free", "opencode-go/deepseek-v4.1-flash",
                  "opencode-go/glm-5.3-flash", "opencode-go/hy4-flash-free"]
```

## `devc` latency

```bash
node tools/bench/devc-latency.mjs --runs 5 --dry-run
node tools/bench/devc-latency.mjs --runs 5
node tools/bench/devc-latency.mjs --allow-mutating --runs 3
```

Scenarios live in `scenarios/devc.json`: `ls` and `doctor` at 100 runs, an exec
at 30, `rebuild`/`up` at 3 and skipped unless `--allow-mutating`, because they
replace containers. Results go to `results/devc-latency-<date>.json` with the
host's CPU count and load average, so a slow host is visible rather than
assumed.

Ticket 02 adds `rebuild --if-stale` to the scenario file once the flag exists.

## Per-skill loads

```bash
node tools/bench/skills.mjs --all --since 2026-10-31
```

Scans every `~/.pi/agent*` session for a `SKILL.md` read (a `read` path or a
bash `cat`/`sed` mention), grouped by skill and by session. This is the table
ticket 05's prune is decided by. Every model cell also records
`metrics.skillLoads` for its own run.

## The manual repo-explorer trials

TUI interaction cannot be driven by a model or a headless script honestly. See
[repo-explorer-trials.md](repo-explorer-trials.md): five timed trials of "what
changed in this branch and what does the diff say", at 80×24, before and after
ticket 04.

## Tests

```bash
node --test tools/bench/run.test.mjs
node --test .pi/extensions/subagent/test/bench.test.ts
```

The first covers workspace resolution and the refusal cases through the CLI with
`--list` and `--dry-run`, so it spends no tokens and needs no fixture worktree;
the second covers the task loader, the event summariser and the suite parser.
