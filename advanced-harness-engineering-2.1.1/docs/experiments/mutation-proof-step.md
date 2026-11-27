# Does the mutation-proof requirement change what agents do?

The question behind `AGENTS.md`'s "name the test that fails when this change is
reverted" and `prove-it-works`' bullet of the same shape: is that requirement
followed, where does it have to live to be followed, and does it change the tests
an agent writes?

Short answer: **it is followed only when it is both explicit and in context**, and
the model matters more than the placement. On the task below it did not change
test quality at all — it changed the evidence reported.

## Design

- **Task** (identical in every cell, one prompt): add `--since <ISO date>` to
  `tools/bench/run.mjs` in this repository — a cell whose recorded result is older
  than the date is skipped and the summary counts the skips; a malformed date
  fails naming the option and the format; `--list`, `--dry-run` and `--force`
  keep working; run the gate; do not commit.
- **Arms**: `with-rule` is `dev` after #194 (the requirement in `AGENTS.md` *and*
  in the two skill bodies). `no-rule` is the same tree with `AGENTS.md` taken from
  `537f34c` — one commit earlier — so the skill-body mentions stay and only the
  always-loaded rule differs.
- **Models**: `deepseek-v4.1-flash`, `glm-5.3-flash`. **3 runs per cell**, one
  headless `pi -p` each, in its own detached worktree of the same commit, with
  `PI_CODING_AGENT_DIR` set to the per-checkout agent dir so the worktree's own
  skills are the ones advertised.
- **Measured three ways**, because the report is a claim and claims can be wrong:
  1. *did it* — a `cp`, `.bak`, `git checkout --` of the implementation, or a
     `git stash`, appearing in the transcript (the mechanical shape of "revert,
     run, restore");
  2. *did it say so* — the final report names the mutation;
  3. *does it matter* — revert `tools/bench/run.mjs` myself and run the tests the
     run wrote; a suite that does not fail there was never covering the change.

## Result

| Model | Arm | did it (transcript) | said so |
|---|---|---|---|
| deepseek-v4.1-flash | `with-rule` | **3 / 3** | 3 / 3 |
| deepseek-v4.1-flash | `no-rule` (skill bodies only) | 2 / 3 | 2 / 3 |
| glm-5.3-flash | `with-rule` | **1 / 3** | 2 / 3 |
| glm-5.3-flash | `no-rule` (skill bodies only) | 1 / 3 | 2 / 3 |

Per run, with the skills each one actually opened:

| Model | Arm | Run | Skills opened | Did it | Said so |
|---|---|---|---|---|---|
| deepseek | with-rule | ds-y1 | none | yes | yes |
| deepseek | with-rule | ds-y2 | update-changelog | yes | yes |
| deepseek | with-rule | ds-y3 | none | yes | yes |
| deepseek | no-rule | ds-n1 | none | no | no |
| deepseek | no-rule | ds-n2 | prove-it-works, in-your-own-words, writing-for-agents | yes | yes |
| deepseek | no-rule | ds-n3 | tdd | yes | yes |
| glm | with-rule | gl-y1 | none | yes | no |
| glm | with-rule | gl-y2 | tdd | no | yes |
| glm | with-rule | gl-y3 | tdd | no | yes |
| glm | no-rule | gl-n1 | tdd | yes | yes |
| glm | no-rule | gl-n2 | tdd | no | yes |
| glm | no-rule | gl-n3 | none | no | no |

Context, not controls — earlier runs of a smaller task (a `--json` flag on
`tools/branch-base.mjs`), before any such requirement existed anywhere:
**deepseek 0 / 9** performed it and none claimed it; with the skill-body mentions
but no `AGENTS.md` rule, deepseek was 0 / 3 on that task. So for deepseek the
progression is 0 / 9 → 2 / 3 → 3 / 3 as the requirement became explicit and then
always-loaded, on two different tasks and 21 runs in total.

## What it means

1. **A requirement in a model-invoked body is a suggestion.** It is read only if
   the agent decides to open the file. `prove-it-works` was opened in 3 of 21
   runs; whenever it was, the check happened.
2. **The always-loaded rule is what moved deepseek.** Body mentions alone left it
   at 2 / 3 with a loaded skill doing the work; the `AGENTS.md` line made it
   consistent. The marginal effect of the line itself is small at n=3, but the
   jump from "nothing anywhere" (0 / 9) is not.
3. **GLM does it about a third of the time whatever the placement — and claims it
   more often than it does.** Two of its three with-rule runs *said* "mutation
   proof" without the transcript showing a revert. A confident model will describe
   the check instead of performing it; that is a different failure from skipping
   it, and no wording fixes it. Only a check would.
4. **It did not improve the tests.** Reverting the implementation fails 2–15 of
   the tests in **all twelve** runs, both arms and both models. On a task with an
   obvious seam, everyone writes a biting test anyway. To detect a quality effect
   the task has to be one where the cheap test is weak — a status code, a string,
   "it did not throw".

## Caveats

- n = 3 per cell, one task instance, one provider. Read the table as direction,
  not significance.
- The prompt is genuinely ambiguous ("skip results before the date" can mean
  *do not run them* or *recompute them*); two runs stopped to ask instead of
  implementing, which costs them cells.
- "Did it" is inferred from shell shapes (`cp`, `.bak`, `git checkout --`,
  `git stash`) plus a test run; an agent that reverted through the `edit` tool
  twice would be missed.
- The `no-rule` arm is one commit of `AGENTS.md` removed, not a pristine
  pre-requirement tree, so it does not test "no requirement at all" — the earlier
  runs are that, and they are context rather than a controlled arm.

## Reproduction

```bash
# per cell: own worktree at the same commit, its own agent dir
git worktree add -q --detach .worktrees/cell origin/dev
cd .worktrees/cell && PI_CODING_AGENT_DIR="$("$OLDPWD"/bin/pi-agent-dir --print)" \
  pi -p --provider opencode-go --model deepseek-v4.1-flash "$(cat prompt.txt)"
```

The `no-rule` arm additionally runs `git checkout 537f34c -- AGENTS.md` and
commits it, so the worktree is clean when the run starts.
