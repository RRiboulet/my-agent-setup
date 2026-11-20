# prevent-recurrence: the four-week experiment log

Ticket 05 of `docs/specs/2026-11-19-prevent-recurrence.md`, covering R10 and R11.
This file is the experiment's record and its template. It exists on
`exp/prevent-recurrence` and nowhere else.

**No `CHANGELOG.md` entry, deliberately.** This branch is not `dev` work: it is a
four-week test that may be deleted, and a changelog announces what shipped. `dev`
keeps its review policy and its changelog until the experiment wins. If it does,
the branch-only files and the winning conversions land in one PR based on `dev`,
and that PR writes the entry — not this branch, and not before the decision.

## The thesis, and how it can lose

For a repeated mistake, a check beats another review. A repeat costs a review
round every time it returns, and the correction lives in whoever remembers it. A
check costs one round to write and then fails on its own.

Two counts and one artifact decide whether that happened: repeat corrections
per week, review rounds per change, and at least one conversion that reached a
check. The log records one row per conversion; the four-week review compares the
counts with the 30 days before the window. Nothing here is a benchmark or a
timing claim — the numbers are counted by hand from the log, git, and the review
history, and the review says so.

## What the branch changes

| file | what it adds | on `dev`? |
|---|---|---|
| `.pi/skills/prove-it-works/SKILL.md` | a repeat fix is not done without its table row, its two-way proof and a green checker | no |
| `REVIEW_GUIDELINES.md` | one question inside the single review: does this fix a repeat, and where is the row and the proof? | no |
| `docs/experiments/prevent-recurrence.md` | this log | no |

`git diff --name-only dev...HEAD` is exactly those three files. That diff is
ticket 05's acceptance check and it holds for every commit added here afterwards;
a fourth path means the branch has picked up `dev` work or a conversion's files,
and the second belongs in the conversion's own project, not in this diff.

## A repeat, defined

A repeat is **the same mistake class twice in 30 days**, evidenced by chat, a
review comment, a revert, or commits. Not the same line twice.

- **Class, not line.** The class is one sentence a reviewer can apply to a line of
  code: "outbound HTTP is imported from the legacy client instead of the
  retry-aware one"; "a broad handler returns a default instead of re-raising". Two
  modules with the same wrong pattern are a repeat. The same broken line repaired
  twice is one occurrence with two attempts.
- **30 days, backwards from the current correction.** The current correction is
  one of the two; one earlier occurrence inside the 30 days is enough. Three
  occurrences across three months are two repeats, and the row's count says which
  repeat it is closing.
- **Evidence carries a date and a ref.** The evidence cell names each occurrence as
  a date plus a SHA, a PR, a review comment, or the conversation it came from. A
  correction with no second occurrence is a bug fix, not a repeat:
  `diagnosing-bugs` owns it, it gets no row here, and no check is owed.
- **What does not count.** The same file changed twice, or the same test breaking
  twice, is not a repeat unless the mistake is the same. An argument repeated
  inside one review round is one occurrence, not two.

A row whose repeat count is 1 does not belong in this log. That is the one column
rule a reader can check at a glance, and it is the rule the definition exists to
support.

## The window

The four weeks start at **the first real conversion — ticket 07, the
`analytics-agent` groundedness repeat with its three fixes (`50a8260`, `7f3c5de`,
`2479ab9`)** — and at nothing earlier. Not when this branch was cut, not when this
file was written, not when the skill merged to `dev`: a policy nobody has used has
measured nothing.

The clock starts on the date that conversion lands its check, its row and its
proof in `analytics-agent`, and its row below. Four calendar weeks from that date,
with the 30 days before it as the baseline. If ticket 07 never reaches a check,
the window never starts and the experiment has no result — and no result is a
loss, not a win by default (see "How a loss is decided").

| | date | what it means |
|---|---|---|
| window opens | — | ticket 07's conversion lands: check, row and proof in `analytics-agent`, log row here |
| window closes | — | four calendar weeks after it opens |
| baseline | — | the 30 days before the window opens |

## The log

One row per correction, appended in date order. Not one row per commit, and not
one row per project: the row is the class, and its proof is the command pair that
decided it.

| date | correction | evidence | repeat count | level | rule | proof: command → exit codes | review rounds | notes |
|---|---|---|---|---|---|---|---|---|

- **date** — the day the correction was handled, not the day of the first
  occurrence.
- **correction** — the class in one sentence, the same sentence the table row
  uses. A line number here is a bug fix, not a class.
- **evidence** — every occurrence, each with a date and a ref. This is the column
  a later reader uses to decide whether the repeat was real.
- **repeat count** — a number greater than 1, with the two dates it spans
  (`2: 2026-11-05 → 2026-11-25`). See "A repeat, defined".
- **level** — `architecture`, `type`, `lint`, `test`, or `prose`, and it is the
  level the skill chose after walking the ladder. A `prose` row also carries
  `judgment: <reason>` in the target repository's table, per the skill.
- **rule** — the row's rule text as it reads in the target repository's
  `AGENTS.md`, so the two can be compared without opening it.
- **proof: command → exit codes** — the exact enforcer, the bad revision's exit
  code, and the good revision's exit code. By the skill's rule that is `1` then
  `0`. A proof file records the same pair; this cell is the summary a reviewer
  reruns.
- **review rounds** — the number of review passes the occurrence cost, defined in
  the next section.
- **notes** — the baseline path and its starting count, suppressions with reason,
  expiry and approver, open work, and anything the check cannot decide. A
  correction to an earlier row is a dated note here, never a rewrite of the
  evidence above it.

Copy this row and fill it; nothing else in the table moves:

```markdown
| <YYYY-MM-DD> | <class in one sentence> | <occurrence 1: date, ref>; <occurrence 2: date, ref>; <this one: date, ref> | 2: <date> → <date> | <level> | <row text> | `<enforcer>` → bad `<ref>` exit 1, good `<ref>` exit 0; checker exit 0 | <n> | <baseline, suppressions, open work> |
```

No rows yet: the first is ticket 07's conversion.

## Review rounds, counted

A review round is one independent review of a change, per `REVIEW_GUIDELINES.md`'s
one-review-per-change rule. The column counts the rounds an occurrence cost,
including the one that caught it:

- `0` — a check or the author caught it before a reviewer saw it. This is what the
  experiment is buying: the class fails on its own.
- `1` — review caught it in the change that introduced it.
- `2` — the change merged, the mistake came back, and the follow-up was reviewed
  too. This is the repeat tax, and it is the number the experiment sets out to
  remove. A repeat with a longer tail counts every round in it.

The count does not add a review and does not relax the policy: it records rounds
the change would have had anyway. A win that needs fewer rounds *because* review
was skipped is not a win — that is a later experiment, and the spec names it a
non-goal.

## The four-week review

Fill this at the close of the window. `repeat corrections` and
`changes reviewed` are counted per week from the log, git, and the review history;
`review rounds per change` is the mean of the log's round column over those
changes, with the same count taken for the baseline window.

| window | repeat corrections | changes reviewed | review rounds per change | notes |
|---|---|---|---|---|
| baseline: 30 days before the window | | | | |
| week 1 (—) | | | | |
| week 2 (—) | | | | |
| week 3 (—) | | | | |
| week 4 (—) | | | | |

### How a win is decided

All three, or the experiment loses:

1. **A conversion reached a check.** At least one row's level is `architecture`,
   `type`, `lint` or `test` — not `prose` — and its proof shows the enforcer
   exiting 1 at the bad revision and 0 at the good one, with the checker exiting 0
   on the row. A prose row can be the honest answer and is recorded; it just does
   not show that a check replaced a review.
2. **Repeat corrections fell, at comparable activity.** Repeat corrections per week
   in the window are below the baseline window's rate, and the window reviewed at
   least as many changes per week as the baseline did. Without the second half, a
   quiet month with three changes in it reads as a win.
3. **Review rounds did not rise.** Review rounds per change in the window are at or
   below the baseline. A check that stops a repeat but costs the same review every
   time has not replaced anything.

Then the review does what the spec's checklist says: record the first conversion's
bad revision, fix revision, commands, exit codes, table row and checker run; merge
or delete; and choose the next experiment from evidence — auto-merge, named
principles, a comment skill, or none.

Four weeks and one or two conversions is a small sample, and the spec's first open
assumption says so. The decision is a judgement over the counts, written in one
paragraph under the table, and "the sample cannot tell" is a loss.

### How a loss is decided, and the default

Everything else is a loss, including a window that never opened and a count that
cannot be measured — four weeks with no conversion, a baseline that cannot be
reconstructed, a repeat count that only reaches 1 on inspection. An unmeasurable
count is not a pass. The default is delete: it is the reversible direction, and
this branch has never been `dev`'s workflow.

## What happens to losing commits

They never reach `dev`. No merge, no cherry-pick, no "just the policy files" PR —
a policy that applies only to a deleted branch is dead text, and a check with no
conversion behind it is a claim the experiment set out to test.

The branch is deleted, local and remote, at the review. `dev` was never changed,
so deleting is the whole cleanup. One thing has to be written before the branch
goes, because it dies with it: the outcome — the counts, the decision, the reason
— on the issue or PR that tracked the experiment. The first conversion's own
record (bad revision, fix revision, commands, exit codes) lives in
`analytics-agent` beside its check, where the code is and where a later agent will
look.

A conversion that clears its own proof while its neighbours do not is still a
loss for the branch as a whole: the decision is merge or delete, not salvage.
