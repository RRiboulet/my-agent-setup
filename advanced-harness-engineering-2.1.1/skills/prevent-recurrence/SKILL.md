---
name: prevent-recurrence
description: "Turn a repeated correction into an enforced check that fails without it. Use when: the same mistake class is corrected twice; a review, revert or fix shows a known pattern coming back; or a correction needs to stop a class, not one instance."
---

<!-- Adapted from pstack's /correct and principle-encode-lessons-in-structure;
     MIT notices and per-skill provenance are in licenses/NOTICE.md. -->

# Prevent recurrence

Goal: the second time a mistake class is corrected, the correction becomes
structure that fails without it. Not a longer instruction, and not another review
round.

A repeat is the **same mistake class twice in 30 days**, evidenced by chat, a
review comment, a revert, or commits. Two modules with the same wrong pattern
count; the same wrong line twice does not. One occurrence is a bug fix:
`diagnosing-bugs` owns it, and this skill has nothing to add.

## Trigger and inputs

Load this skill after a correction has happened a second time, or when the first
one was a repeat of something already fixed and forgotten. The input is any of:

- the corrections in the conversation, the review comment, or the PR thread;
- the fix commit, the revert, or the revision before them;
- a repeat already visible in history (`git log -S`, two fixes to one class);
- a bad and a good snippet, when the history cannot be recovered.

Pin two facts before choosing anything:

- the class in one sentence a reviewer can apply to a line of code;
- the evidence it repeated: both occurrences, with dates and commit SHAs, links,
  or the review comments.

If you cannot name the second occurrence, this is not a repeat. Fix the bug,
report why the class does not qualify, and stop.

## Choose the highest level that works

Walk the ladder in order and stop at the first level that can carry the rule. The
report states why each level above the chosen one does not work, in one line
each. A level is chosen because the one above cannot see or enforce the class,
not because it is quicker to write.

1. **Architecture — make the wrong thing impossible.** One owner per piece of
   state, one supported way to do the task, internals that cannot be imported,
   the old path deleted so the nearest example is a correct one. Choose it when
   the mistake comes from two ways to do one job, or from state two places may
   change. This needs no tool run and no memory, which is why it is first.

2. **Type or validation — make the bad state unwritable.** A required parameter,
   a distinct type, an enum or closed union, a schema at the boundary, an
   exhaustiveness check. Choose it when the compiler or the boundary check can
   reject the bad value while the code is written. Above lint because the editor
   and CI show it without a separate rule to remember, and the type carries the
   reason.

3. **Lint — forbid the locally recognizable form.** Choose it when the wrong
   form is legal code and the right form exists, and the difference is visible
   in the offending lines themselves (see the test below). A lint can name the
   replacement in its message, which is what makes it teach.

4. **Test — pin behavior, dataflow, or a semantic property.** Choose it when the
   rule needs execution to decide: a retry that must not double-charge, an
   ordering, a cross-file property, a relation between input and output. The
   test is at a public seam, and it fails on the bad behavior rather than
   asserting that a particular helper was called.

5. **Prose — record the judgment call.** Choose it only when no executable check
   can decide the class, for example a rule about naming that depends on domain
   meaning. It must carry `judgment: <reason>` in the table, and the reason says
   why a check cannot decide it.

"An easier lint" or "a test would take an hour" is not a reason the higher level
did not work. "The pattern is only wrong when the call site already holds a
transaction, which the line cannot see" is.

Do not skip down for convenience. A check at the wrong level is worse than prose:
it claims enforcement and misses the class.

### Lint only for locally recognizable patterns

The test, applied before writing any lint:

> Could a reviewer decide from the offending lines alone, with no imports
> resolved, no types followed across files, and nothing run, whether this is a
> violation?

If yes, a lint can carry it. If no, it belongs at the type or test level.

- A banned import, a raw `except Exception` that returns a default, a `requests`
  call with no timeout, a missing `check=True` — locally recognizable.
- "This retry is not idempotent", "this log line leaks a token", "this query
  misses a tenant filter" — not locally recognizable; they need runtime state,
  dataflow, or domain meaning. Do not write a lint that guesses.

Narrow the rule until it catches the class and nothing else. If it catches
unrelated code, narrow it; do not suppress the unrelated findings.

### Existing tool first

Before writing a rule, use what the project already runs:

1. A stock rule that is already configured, or one the project's lint carries.
2. The stock rule's parameterized form: `no-restricted-imports` /
   `no-restricted-syntax`, or Ruff `TID251` with a naming `msg`.
3. A rule or contract in a tool the project already runs: an `import-linter`
   contract for dependency direction, an ast-grep `rule` YAML with `message`,
   `note` and `fix`, or a local ESLint rule.
4. A project test or check script, when no lint gate exists.
5. A new tool or dependency — a design decision, named in the report with its
   cost. Never install one silently, and prefer the project's existing runner.

The order controls rule sprawl: every new rule needs an owner and a version, and
stock rules already have docs, editor support, and a message convention.

Python recipes — Ruff `TID251` and the stock rules worth reusing, ast-grep with
`sg test`, `import-linter`, and the project-test fallback — are in
[references/python.md](references/python.md). The same order applies in JS/TS:
[references/js-ts.md](references/js-ts.md) covers ESLint's `no-restricted-imports`
and `no-restricted-syntax`, a local flat-config rule when the message must name
the canonical file, dependency-cruiser boundaries, typed linting through
typescript-eslint, oxlint for the inner loop, and the `eslint-disable` /
`@ts-ignore` audit.

## Write the check that names the fix

A diagnostic that says "banned" is a puzzle. The message names the replacement
and, when short, the reason:

```text
Use services.users.fetch (it sets the timeout and records the retry), not requests.get directly.
```

A check whose message names only the rule will be worked around by the next agent
who needs to ship. The naming is part of the check, not a nicety.

## Prove it at both revisions

A check that has never failed on the real mistake is not accepted. Take the
revision before the fix as `bad` and the fixed revision or the current tree as
`good`, then run the exact enforcer both ways:

```text
bad  <ref>: <command>   → exit 1 (the finding this class produces)
good <ref>: <command>   → exit 0
```

- Both runs use the same command that the project's gate will run. `git stash` or
  a temporary worktree is fine; a hand-edited copy of the bad file is not the bad
  revision.
- When the fix adds the check, the bad revision does not have it. Run the fixed
  check against a worktree of the bad code — copy the config, script or test into
  it, or point the fixed command at the bad tree. Checking out `bad` alone runs a
  configuration that did not exist yet and passes for the wrong reason.
- A check that exits 0 at `bad` is not the check. Narrow it, fix its wiring, or
  pick another level — do not record it.
- A check that exits 1 at `good` is wrong. Fix the rule or the code; never
  suppress the finding to make the good run green.
- Record the command, both refs, and both exit codes in a proof file under the
  project (`docs/proof/<rule-slug>.md` or the test file itself) and point the
  table row at it. When the bad revision is gone, put both snippets in that file
  and run the check over each; the proof is then the snippets and the two
  results, which is still stronger than an untested rule.
- Paste the same two lines into the report. The proof file is what a reviewer
  reruns.

## Ratchet existing violations

A rule may land without fixing every old violation. It may not land with a
baseline that hides new ones.

- Use the lint's own baseline when it has one.
- Otherwise check in a text baseline of the current findings, one per line with
  the path and the rule. The check compares the current findings as a set: a
  finding not in the baseline fails, a baseline entry that no longer occurs is
  removed in the same change, and the baseline only shrinks. When the tool has no
  baseline mode, the enforcer is a small wrapper that runs the tool and compares
  the set; that wrapper is the command in the row.
- Record the baseline path in the proof and the report, with the count it
  started at.
- A whole-file ignore, a global rule disable, or an ever-growing allow-list is
  not a baseline. It is a suppression wearing a baseline's name.

## Never add a suppression

Never add `# noqa`, `# type: ignore`, `# pylint: disable`, `eslint-disable`, a
rule exclusion, or a per-file ignore to make the new check pass. Fix the code, or
narrow the rule so it stops catching the wrong thing.

If a suppression is genuinely unavoidable, put the reason, an expiry date, and
the approver's name on the offending line, and report it as open work. An
unexplained suppression is the same as no check for that line.

## Record the row

Add one row to the target repository's `AGENTS.md` under
`## Rules and enforcement`. If the heading and table do not exist, add them
first; the columns are fixed:

```markdown
| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| A broad exception handler re-raises instead of returning a default | lint | `python3 tools/check_error_policy.py` | `docs/proof/error-policy.md` |
```

- **Rule** names the class, not one instance.
- **Level** is one of `architecture`, `type`, `lint`, `test`, `prose`.
- **Enforced by** is the exact command the project's gate runs. Not a
  description of it, and not a placeholder.
- **Proof** is a backticked path that exists, or `bad=<ref> good=<ref>` when the
  bad revision is still in history. Use one form, never both. A prose row uses
  `judgment: <reason>` in the enforcer cell.
- Do not add a row before the proof exists. A row without a check claims
  enforcement and is worse than the prose it replaced.
- Do not add a row for this skill's own process rules. The table holds rules the
  repository enforces, not advice.

Run the checker over the target's table and paste its exit code into the report:

```bash
# this repository: the canonical copy is the gate
node skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md

# another project: vendor the file and call the copy, never a harness path
cp <skill>/scripts/rule-table.mjs tools/rule-table.mjs
node tools/rule-table.mjs check AGENTS.md
```

A project that vendors the checker records the contract version and the file's
SHA-256 beside it (`tools/rule-table.version`), so drift is visible and
re-vendoring is one file. The checker is Node standard library only and never
executes a proof; a project without Node has to use its own test runner as the
enforcer and say so. Exit 0 is required before the row is reported as adopted;
a rejected row is not adopted.

The table format, the `--json` contract, and every violation code are in
[references/rule-table.md](references/rule-table.md).

## Stop before git and review

The skill ends with the check, its proof, and the row in the working tree.

- Do not stage, commit, push, or open a pull request. If the user wants a commit,
  the repository's commit skill and branch checks own that step.
- Do not commission a review, and do not add a second reviewer because the change
  touches a rule. The project's review policy decides; a check does not earn a
  review round.
- Say plainly what is uncommitted when you hand back.

## Report

Keep it to these lines. The proof file and the table row carry the detail.

```text
Rule: <one sentence, the class>
Evidence: <occurrence 1 — date, ref>; <occurrence 2 — date, ref>
Level: <architecture|type|lint|test|prose>
Why not higher: <one line per level above it>
Check: <path> — <command>
Proof: <bad ref> → exit 1; <good ref> → exit 0 (file: <path>)
Ratchet: <baseline path and starting count, or "none: no existing violations">
Table row: <the exact row, or the AGENTS.md line it was added at>
Checker: <command> → exit 0
Open work: <suppressions with reason, expiry, approver; unenforced follow-ups; a new tool and its cost>
```

## Where this sits

- `diagnosing-bugs` reaches this skill after the root cause is confirmed and the
  class has repeated. Do not start here with an unconfirmed cause; the check would
  encode the wrong rule.
- `/implement` reaches it when the user corrects the same thing a second time. The
  third pass belongs in a check, not another edit.
- `prove-it-works` reaches it when a change adds or updates a rule in the table,
  and runs the checker as part of the gate.
- `tdd` owns the test-level check; `blast-radius` is worth loading when the chosen
  level is architecture.

## Limits

The check proves the class it names, not the intent. Code can satisfy the rule
and still repeat the mistake another way; that is a new occurrence, and the next
pass widens the check or moves up a level.

The table checker is static: it confirms the row's shape and that the proof exists,
not that the command still fails at `bad` and passes at `good`. The proof file's
exit codes are evidence from this run, and a reviewer should rerun the two
commands when in doubt.

A first conversion may honestly land at a test or a type. A lint is not the goal;
the highest level that works is.
