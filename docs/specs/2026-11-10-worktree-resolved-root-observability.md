# Observing the resolved-root contract in the worktree removal recipes

## Objective

Since #116, the `worktree` skill's branch-cleanup and end-state recipes run git
as `git -C "$R" …`, where `R` is the main checkout resolved from
`--git-common-dir`. Nothing tests that contract. It cannot be tested
behaviourally — linked worktrees share refs, so a bare `git branch -D` and
`git -C <main> branch -D` do exactly the same thing from any inside-the-repo
cwd — which means a future edit that drops `-C` (or resolves the wrong root)
passes the suite while removing the guarantee that these blocks act on the
checkout they just resolved, not on wherever the reader happens to stand.

## Current behavior

- `Remove[1]` ends with `git -C "$R" branch -D "$SLUG"`; `Remove[3]` runs three
  `git -C "$R"` commands (`worktree list`, `worktree prune -n`,
  `branch --list`). Both blocks `set -euo pipefail` and guard the root
  resolution.
- The only tests for those blocks are the deleted-cwd tests, which pin the
  guard's failure path (`rev-parse` fails → message + non-zero). The successful
  path asserts effects — the branch is deleted, the listing is clean — and both
  forms produce those effects identically.
- Verified in a scratch repo from a **linked-worktree cwd**: bare
  `git branch -D task-name` and `git -C <main> branch -D task-name` delete the
  same shared ref with identical output and exit status. No behavioural
  assertion can separate them.
- `GIT_TRACE=1` does **not** help: it prints
  `trace: built-in: git branch -D task-name` — the `-C` is consumed before
  tracing (git 2.56.0), so the trace cannot prove whether it was passed.
- A `git` wrapper on `PATH` that records argv and then `exec`s the real binary
  does capture it: the recorded lines were
  `rev-parse --path-format=absolute --git-common-dir` followed by
  `-C /tmp/…/main branch -D task-name`, and the branch was actually deleted,
  because the wrapper passed through.

## Required behavior

1. A test runs `Remove[1]` with cwd set to a **linked worktree** (not the main
   checkout) and a PATH-prepended recorder, and asserts that every git invocation
   after the initial root discovery carries `-C` with the resolved main root.
2. The recorder passes through to the real binary, so the block's effects still
   happen and are asserted: the branch is deleted, the exit status is preserved,
   and git's own stdout/stderr are not swallowed.
3. The same assertion covers `Remove[3]` — its three git calls all carry the
   resolved root.
4. Dropping `-C` from either recipe turns the test red; restoring it turns it
   green (mutation-checked, with the red assertion named).
5. The assertion is on **argv actually received by git**, not on the skill's
   text: no test greps `SKILL.md` for `-C`.
6. The existing deleted-cwd tests remain as the behavioural half (guard and exit
   status); this test does not replace them.

## Non-goals

- Applying argv assertions to `Create`, `Open`, `List` or `Review`. Their
  effects are observable, so argv assertions there would be noise.
- Re-testing `Remove[0]` (the removal itself and the sweep), which has
  behavioural coverage.
- Asserting git's own behaviour, or the wrapper's fidelity beyond the `-C`
  argument.

## Constraints

- The wrapper must `exec` the real git resolved **before** `PATH` is
  prepended — no hardcoded `/usr/bin/git`, because the devcontainer may put a
  shim first.
- Each test writes its own log file (test files run in parallel under
  `node --test`), in the scratch repo or a `mkdtemp`.
- Only `git` is shadowed; `bash`, `awk`, `sort` and `gh` must resolve normally.
- The wrapper must be transparent: same exit code, same stdout/stderr, no
  buffering changes, and it must work when git is invoked with no arguments.
- `Remove[1]` is intentionally force-deleting an unmerged branch; the fixture
  must create a branch that is not merged, so the test proves the `-D` path
  rather than a fast-forward.

## Design decisions

- **Helper:** a `recordGit()` local to `worktree-skill.test.ts` returning
  `{ env, calls() }`. It resolves the real git from the current `PATH`, writes a
  wrapper into a temp bin dir, and prepends that dir. The wrapper is:

  ```sh
  #!/bin/sh
  printf '%s\n' "$*" >> "$GIT_ARGV_LOG"
  exec "$REAL_GIT" "$@"
  ```

  `REAL_GIT` is an absolute path the test resolved; the wrapper does not search
  `PATH` again, which would find itself.

- **Assertion scope:** skip the first recorded call (the `rev-parse` that
  discovers `R` — it has no `-C` by design) and assert every remaining call
  starts with `-C <R>`. This keeps the rule "after resolution, everything is
  rooted" rather than "every line contains -C", which would be false.
- **cwd is a linked worktree on purpose:** it makes the test's premise visible —
  bare git would have worked there too, which is precisely why the contract
  needs a non-behavioural seam.
- **Rejected:** `GIT_TRACE` (cannot see `-C`, verified above);
  `GIT_TRACE2_EVENT` (its event format is not a contract this repository wants
  to depend on); git hooks (not invoked for builtins such as `branch -D`);
  effects-only assertions (impossible, see Current behavior); a text assertion
  (`SKILL.md` is the thing the recipes are extracted from — asserting the string
  would pass even if the harness stopped running that block).
- A code comment in the test should carry the "shared refs make this
  unobservable behaviourally" reason, so the argv assertion does not read as
  ceremony a future cleanup deletes.

## Test seams

- The recipe seam already exists: `recipe("Remove", 1)` / `recipe("Remove", 3)`
  run through `runScript()` in `test/worktree-recipes.ts`, which already
  supports an `env` override for `PATH`.
- The PATH recorder is the new seam; prior art in the repository is the
  `fakeTmux()` helper in the same test file (a fixture binary that logs what it
  was asked to do), and `repo-explorer` tests' injected `GitRunner`, which
  observe argv the same way at a different boundary.

## Acceptance criteria

- [ ] A test exists and passes, asserting `-C <resolved R>` on the `branch -D`
      call from a linked-worktree cwd. (R1, R5)
- [ ] The branch is actually gone and the block's exit status is 0, proving the
      wrapper passed through. (R2)
- [ ] Every post-resolution call in `Remove[3]` carries `-C <R>`. (R3)
- [ ] Mutation: remove `-C "$R"` from `Remove[1]` → test red on the argv
      assertion; restored green. (R4)
- [ ] Mutation: remove `-C "$R"` from `Remove[3]` → test red; restored green.
      (R4)
- [ ] The deleted-cwd tests for both blocks still pass unchanged. (R6)
- [ ] No test in the file asserts `-C` as text against `SKILL.md`. (R5)

## Verification

```bash
node --test .pi/extensions/subagent/test/worktree-skill.test.ts
# mutation (R4): drop -C from Remove[1], re-run, expect the argv assertion red,
#                restore; repeat for Remove[3].
```

A useful extra check while developing: run the same wrapper with the recipe as
shipped and print the recorded calls, so the expected `-C` value is the resolved
root rather than a hardcoded path.

## Open assumptions

- The `-C` contract is currently defence-in-depth, not a behaviour difference:
  it pins "act on the checkout you resolved" so a future cwd-dependent change
  cannot quietly break it. Risk: a reviewer may read the test as ceremony;
  mitigated by the in-test comment naming the shared-refs reason and by the
  spec's Non-goals — it is deliberately one small test, not a pattern.
- Wrapper fidelity: if git is itself a shim on `PATH`, resolving "the real git"
  before prepending keeps working, but a shim that ignores argv would be
  recorded rather than executed. Risk: low; the passthrough assertion (branch
  actually deleted) catches a dead-end wrapper.
- If the harness ever stops extracting `Remove[1]` by that section name, the
  test fails loudly at `recipe()` rather than silently testing nothing — that
  contract is already covered by the harness's own error message.
