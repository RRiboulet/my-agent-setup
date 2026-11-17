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

# the cells, without spending a token
node tools/bench/run.mjs --state baseline --tasks head-hash,devc-ls --models deepseek-v4.1-flash --dry-run

# one task, one model, real run
node tools/bench/run.mjs --state baseline --tasks head-hash --models deepseek-v4.1-flash

# the full grid
node tools/bench/run.mjs --state baseline --models deepseek-v4.1-flash,glm-5.3-flash,hy4-flash-free
```

A cell is (task, model, state) and writes one JSON file to
`tools/bench/results/<state>/<provider>_<model>/<task>.json`. An existing cell is
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
  "repo": "/path/to/a/clean/checkout",
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

### Isolation

A task must be **read-only**. The runner does not create a worktree per cell, so
a task that edits its repo leaves the next cell dirty and the comparison
worthless. The runner refuses a dirty repo unless `--allow-dirty` (or the task
sets `"allowDirty": true`, which is recorded).

Use a clean checkout — a detached fixture worktree works:

```bash
git worktree add --detach .worktrees/bench-fixture origin/dev
```

The harness itself is whatever `pi` loads from the agent configuration; `--repo`
is only the workspace the task runs in. Do not point tasks at the checkout you
are editing.

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
node --test .pi/extensions/subagent/test/bench.test.ts
```
