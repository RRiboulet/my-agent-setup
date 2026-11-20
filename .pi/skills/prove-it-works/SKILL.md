---
name: prove-it-works
description: "Prove a code change works before claiming it is done: verify against the real artifact rather than a proxy, run the repository's quality gate, check the final diff for scope and hygiene, and report evidence with honest check statuses. Use when: finishing any coding task, before committing or opening a PR, after addressing review feedback, or when asked to validate, verify, or check changes."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Prove it works

"It compiles" or "the tests I wrote pass" is not proof. Verify the real thing directly, then report evidence rather than confidence.

## 1. Check the real thing

- Exercise the changed behavior the way a user or caller would: run the CLI, call the endpoint, run the function on a realistic input, or read the actual output, file, row, or value.
- Do not infer success from proxies such as file timestamps, a log line saying "done", a cached screenshot, or another agent's summary.
- When a check fails, suspect the observation method before the system: the right process, port, environment, and build?
- Prefer a small script that re-runs the comparison to a one-time eyeball, and keep its output so a reviewer can re-run it.

## 2. Find the quality gate

- The project's own instructions come first. Use the commands its instruction file names (`AGENTS.md`, or whatever this harness reads), and say which file you took them from.
- If the repository has `.agent/quality.yaml`, that is a pinned contract: run its checks as written. See [assets/quality.example.yaml](assets/quality.example.yaml) for the format.
- Otherwise use the checks the repository itself defines: CI workflows, `Makefile` or task-runner targets, package scripts, `pyproject.toml`, and contributing docs.
- A check that is not configured is "not configured". Never substitute a tool the project does not use and report it under that check's name.

In this repository the contract is `AGENTS.md` → **Tests**: the subagent suite
(`node --test .pi/extensions/subagent/test/*.test.ts`, after
`bash .pi/extensions/subagent/test/setup-deps.sh`), the rule-table checker, and
`tools/branch-base.test.mjs`; and, when
`.pi/extensions/opencode-go-provider/` changed, its own separate
`node --test` run. There is no `.agent/quality.yaml`, and AGENTS.md is where
those commands come from.

The branch-base rule is its own gate step, and it comes **before committing**
because that is the cheap moment to fix it. The check fetches `origin/dev` itself
against an explicit refspec, so a stale local `dev` cannot mislead it; run it
from the repository or a linked worktree, and it must exit 0:

```bash
node tools/branch-base.mjs    # must exit 0
```

Exit 1 is `behind-dev`, `foreign-commits` or `wrong-base`, and the line names
the rebase that fixes it. Exit 2 means the check could not run, which is not a
pass: no `origin/dev`, a fetch that failed (it would otherwise classify against
a stale base), a shallow clone whose grafted history cannot decide ancestry, or
a repository with no commit yet. Fix the environment and run it again; do not
proceed on anything but 0.

When the change adds or updates a rule in the repository's `AGENTS.md` under
**Rules and enforcement**, load the `prevent-recurrence` skill and run the table
checker as part of the gate. A new row needs a check that failed at the bad
revision and passes at the good one; a row without that is a claim, not a rule.
In this repository the canonical checker is:

```bash
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md  # must exit 0
```

### Branch-only: a repeat fix needs its row (`exp/prevent-recurrence`)

This part is the `exp/prevent-recurrence` experiment branch's own policy. It is
branch-only: `dev`'s copy of this skill does not have it, and nothing else in the
repository enforces it. It exists here for four weeks, and it goes when the
branch goes.

When a change **claims to fix a repeat** — the same mistake class a second time
within 30 days, evidenced by chat, a review comment, a revert, or commits — it is
not done until three things are true:

- `AGENTS.md`'s **Rules and enforcement** table carries a row for the class, not
  for the instance, or its existing row is updated. No row means not fixed.
- The row's proof ran both ways: the enforcer exits 1 at the bad revision and 0 at
  the good one. Both commands and both exit codes are in the proof file and pasted
  into the report.
- `node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md`
  exits 0.

The same change appends one row to
[docs/experiments/prevent-recurrence.md](../../../docs/experiments/prevent-recurrence.md),
which defines the columns and what counts as a repeat. That row is how the
four-week decision counts conversions, so a conversion that is proven but not
logged has not happened.

Load the `prevent-recurrence` skill for the conversion itself: it chooses the
level, writes the check and records the proof. This section only decides when the
work may be called done. A change that does not claim to fix a repeat is not
touched by it, and the gate above is the whole gate.

What makes this a contract rather than a request is the same thing that makes any
row one: the checker decides the row's shape and whether its proof exists, and the
proof is two exit codes a reviewer can rerun. What the checker cannot decide is
whether the change really is a repeat — that claim is the author's, which is why
the branch's review asks for it by name (`REVIEW_GUIDELINES.md`).

Report the three results in the §5 template as their own `Checks` lines. A repeat
fix whose row is missing, whose proof was never run at the bad revision, or whose
checker exits 1 is `failed` — or `not_run`, if it was skipped — whatever else
passed.

## 3. Run it

- While iterating, run the narrowest relevant checks: focused tests, and lint or type checks on the changed files.
- After the last edit, run the full gate plus every required check it does not cover. Any later edit makes earlier results stale.
- On failure, fix the root cause (load the `diagnosing-bugs` skill if it is not obvious) and re-run the affected checks.
- Classify each failure as caused by the change, pre-existing, or environmental. When unsure, check the base revision in a separate worktree; never stash or discard the user's work to find out. Pre-existing failures are reported, never hidden, and never excuse a new regression.
- Never delete, skip, or weaken a valid test, lower a threshold, or add a suppression to get green.

## 4. Check the final diff — hygiene, not a review

Inspect `git status` and `git diff`, including untracked files:

- Every requirement in the spec or playback is met, and nothing unrequested slipped in.
- No secrets, `.env` content, debug output, temporary files, stray binaries, or generated artifacts unless intended.
- No formatting churn outside touched code; lockfile changes only for intended dependency changes.
- Tests and docs changed where behavior changed.
- Public interfaces, configuration, persisted data, and error paths stay compatible unless the change was meant to break them.

This is the author checking their own work. It is not an independent review, and
this skill never starts one: no reviewer, no review sub-agent, no `/triage` run
unless the user asked for a review. When an independent review does happen it is
one step with one reviewer — `/review` if the user wants to drive it, otherwise
`triage_change` for a routed sub-agent, and never both. The rubric either one
follows is `REVIEW_GUIDELINES.md`.

## 5. Report

Keep it proportional to the change. Each status means exactly this: `passed` ran and succeeded after the last relevant edit; `failed` ran and failed; `not_run` exists but was not run, with the reason; `unavailable` could not run in this environment or is not configured.

```text
Outcome: <what now works, in the user's terms>
Evidence:
- <claim>: <command, test, or observation> → <result>
Checks:
- <name>: passed | failed | not_run | unavailable (<one-line detail>)
Not verified: <what was not demonstrated, and why>
Risks: <untested conditions, environment limits, pre-existing failures, follow-ups>
```

Never call the result bug-free. Say what was demonstrated and what remains a risk.
