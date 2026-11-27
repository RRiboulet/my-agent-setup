# Live-tmux coverage for the worktree session sweep

## Objective

The `worktree` skill's Remove recipe stops the tmux sessions rooted in a tree
before removing it. Its only test drives a **fake** `tmux`, so the sweep's
contract with the real tool — one row per pane, the `-F` field order, and what
`kill-session` does on a second call — is asserted against our own assumption
rather than against tmux. A format or flag change, or a symlinked
`pane_current_path`, would leave the suite green while a real sweep leaked a
live session and then deleted the tree under it.

It matters now because the sweep was just rewritten (#115: `ENVIRON` instead of
`awk -v`, plus `sort -u`), and the behaviour that rewrite exists for —
multi-pane deduplication — is exactly the behaviour only a real listing
exhibits.

## Current behavior

- `.pi/extensions/subagent/test/worktree-skill.test.ts` builds a `/bin/sh`
  script named `tmux` in a temp bin dir and prepends it to `PATH`. It answers
  `list-panes` from a hand-written tab-separated fixture (`FAKE_TMUX_PANES`),
  checks that the `-F` string still names both `#{session_name}` and
  `#{pane_current_path}`, logs each `kill-session` **before** checking liveness,
  and answers `can't find session` on a repeat — reproducing tmux's wording.
- The fixture is generated in Node, not derived from the recipe's `-F` string,
  so the fake cannot catch a field-order change; the test comments say so.
- No test in the suite starts a real tmux server. The Remove tests point
  `PI_TMUX_SOCKET_DIR` at an empty directory under the scratch repo, which
  exercises only the "no server" path.
- Verified on this host (**tmux 3.3a**), in a throwaway socket:

  ```
  tmux -S <sock> new -d -s pi-wt-demo -c <wt>
  tmux -S <sock> split-window -d -t pi-wt-demo -c <wt>/sub
  tmux -S <sock> list-panes -a -F '#{session_name}'$'\t''#{pane_current_path}'
    decoy           <other>
    pi-wt-demo      <wt>
    pi-wt-demo      <wt>/sub        # two rows for one session
  tmux -S <sock> kill-session -t pi-wt-demo   # rc 0, `decoy` survives
  ```

  All of it works with no TTY and an isolated socket, which is what makes a
  live test practical rather than flaky.

## Required behavior

1. A live test starts a private tmux server, creates one session with two panes
   rooted inside the worktree (the tree and a subdirectory) plus a decoy session
   rooted outside it, runs `Remove[0]`, and asserts exit 0, that the worktree
   directory is gone, that no session with a pane inside the tree remains, and
   that the decoy still exists.
2. Before running the recipe, the test asserts the listing has the multi-pane
   shape it depends on (two rows for the target session), so it cannot degrade
   silently into a single-pane case that would pass for the wrong reason.
3. The live test fails if the recipe regresses in either direction that #115
   fixed: dropping `sort -u` (a second `kill-session` against the real server,
   which answers `can't find session`, asserted absent from stderr) or
   reverting to `awk -v` (the backslash-corrupted path matches nothing, so the
   session survives).
4. It touches no other tmux server: the socket lives under the scratch repo,
   `kill-server` runs in `finally` even when an assertion fails, and no global
   `PATH`/env mutation leaks to other tests.
5. On a host without `tmux`, the live test skips with a stated reason while the
   fake-based tests keep running, so the suite stays runnable where tmux is not
   installed.

## Non-goals

- Replacing the fake test. It is the cheap coverage for argv shape, the
  no-server path and the error wording, and it stays.
- Testing tmux's own semantics, or the older tmux versions the skill does not
  target.
- CI wiring — this repository has none — or Windows.

## Constraints

- tmux ≥ 3.3 (the skill already requires 3.5+ for extended keys; `-c` on
  `split-window` is long-supported and verified on 3.3a here).
- `node --test` runs test **files** in parallel: the socket path must be unique
  per test (`mkdtemp`), and teardown must be per-test.
- No TTY: detached creation only (`new -d`, `split-window -d`).
- `#{pane_current_path}` may report a symlink-resolved path; either resolve both
  sides (`realpath`) or assert on a prefix after normalising, or the test fails
  for a filesystem reason rather than a sweep reason.
- Server start is ~50 ms here; the test should stay well under a second.

## Design decisions

- **Where:** beside the fake test in `worktree-skill.test.ts`, as a small
  `liveTmux()` helper in that file. Not in the harness: it has one user, and the
  harness is fixture plumbing, not a tmux client.
- **Skip detection:** `spawnSync("tmux", ["-V"])` at the start of the test, then
  `t.skip()` with the reason. A missing tmux is an environment fact, not a
  failure of the recipe.
- **Seam:** the existing `runScript(recipe("Remove", 0))` with
  `PI_TMUX_SOCKET_DIR` under the scratch repo — the same seam the fake test
  uses, so the live test is a second fixture of one interaction rather than a
  second code path.
- **Rejected:** driving tmux through the extension's own session helpers
  (couples skill tests to extension internals); asserting the fixture text
  (that is what the fake already does); replacing the fake outright (loses the
  no-server path and makes every Remove test depend on tmux).
- Prototype of the fixture setup, which is the decision-rich part:

  ```
  tmux -S "$SOCK" new -d -s "$NAME" -c "$WT"
  tmux -S "$SOCK" split-window -d -t "$NAME" -c "$WT/.pi"
  tmux -S "$SOCK" list-panes -a -F "#{session_name}"$'\t'"#{pane_current_path}"
  ```

## Test seams

- The recipe seam already exists: `recipe("Remove", 0)` executed by
  `runScript()` (`test/worktree-recipes.ts`), with an env override.
- The private tmux server under the scratch root is the new fixture; prior art
  in the repository is `tmux.test.ts` (extension side) and the
  `PI_TMUX_SOCKET_DIR` isolation already used by `worktree-skill.test.ts`.

## Acceptance criteria

- [ ] A live test exists and passes here, asserting R1 in one test. (R1)
- [ ] It asserts two pre-sweep rows for the target session. (R2)
- [ ] Mutation: dropping `sort -u` from `Remove[0]` turns it red, and the red
      message is on the "can't find session" assertion or the session-survives
      assertion; restoring turns it green. (R3)
- [ ] Mutation: reverting to `awk -F'\t' -v wt="$WT"` turns it red on the
      session-survives assertion; restored green. (R3)
- [ ] The server is gone and no socket remains after a **failing** run
      (deliberately fail an assertion once and check teardown). (R4)
- [ ] With `tmux` removed from `PATH`, the live test reports skipped with a
      reason and the fake tests still pass. (R5)

## Verification

```bash
node --test .pi/extensions/subagent/test/worktree-skill.test.ts
# mutation 1 (R3): drop `sort -u` from the sweep, re-run, expect red, restore
# mutation 2 (R3): restore `-v wt="$WT"`, re-run, expect red, restore
# skip path (R5): PATH=$(dirname $(command -v bash)):... node --test ...   # no tmux on PATH
```

## Open assumptions

- A skip on a tmux-less host cannot silently pass a broken sweep, because the
  fake test still pins shape — but it also cannot catch format drift there.
  Risk: medium. Mitigation: the skip message says the live coverage did not run;
  the trade is accepted rather than hidden.
- The "second kill" is observable only as tmux's `can't find session` on stderr,
  since the recipe tolerates the sweep's failure with `|| true`. Risk: low; the
  fake test already asserts that exact string is absent, so the live test
  mirrors a known convention rather than inventing one.
- Pane paths under `/tmp` may be symlink-resolved on some hosts. Risk: low on
  Linux; resolved by comparing `realpath`s.
