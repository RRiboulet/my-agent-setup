# 02: Baselines for the three replay tasks

**Blocked by:** None (can start immediately)
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (see *Current behavior* and *Acceptance criteria*).

## What to build

The three replay tasks, run against today's harness, with the four numbers
recorded and a script that reproduces them. This must land **before** any `bg`
code merges, or the "after" comparison has no baseline.

## Scope

Owns:

- `tools/` — one read-only measurement script that turns session JSONL into the
  four numbers (blocking bash seconds, calls over 60 s, suite runs, task
  wall-clock). It pairs tool calls to results and reads `durationMs` — the field
  the diagnosis used — and writes nothing.
- `docs/research/` — one baselines document, dated, with the raw per-run numbers
  and the method.

The three tasks (fix them now and do not redesign them):

1. **Infra** — recreate a project container and run its suite in it.
   **Hard constraint: never rebuild the my-agent-setup devcontainer.** It hosts
   live sessions. Use `pupkeep` or another project whose rebuild cannot disturb
   anyone.
2. **Feature** — add one small feature to an existing extension, with tests, then
   the full suite once at the end.
3. **Bug** — fix one real defect that starts from a failing test, in
   `analytics-agent` or `pupkeep` (pick something already recorded as broken; do
   not invent a bug).

Run each task twice. Record wall-clock per run, blocking bash time, calls over
60 s, and how many full-suite runs it took.

Leaves for later: everything in the `bg` extension; ticket 08 re-runs the same
three tasks against these numbers.

## Acceptance criteria

- [ ] The three tasks are written down concretely enough for another agent to
      rerun them verbatim (commands included).
- [ ] Two runs per task are recorded, with the four numbers per run.
- [ ] The method is stated well enough to be repeated: which timestamps, which
      field, what counts as a "run".
- [ ] The script reproduces the recorded numbers when pointed at the sessions it
      describes.
- [ ] No product code changes. `git diff` on the branch touches only `tools/` and
      the baselines document.

## Validation

Run the script against the recorded sessions and show it agreeing with the
document. Then the repo suite once, to prove nothing else moved.
