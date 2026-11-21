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
  occurrences across three months are two repeats, and the row records the
  occurrence count, so a reader can see which repeat it is closing.
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
| window opens | 2026-11-21 | ticket 07's conversion lands: check, row and proof in `analytics-agent`, log row here |
| window closes | 2026-12-19 | four calendar weeks after it opens |
| baseline | 2026-10-22 → 2026-11-20 | the 30 days before the window opens |

## The log

One row per correction, appended in date order. Not one row per commit, and not
one row per project: the row is the class, and its proof is the command pair that
decided it.

| date | correction | evidence | repeat count | level | rule | proof: command → exit codes | review rounds | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-11-21 | Groundedness extraction treats period labels and evidence string cells as non-measurements | 2026-10-13 15:35 UTC, `2479ab9`; 2026-10-13 17:06 UTC, `7f3c5de`; 2026-10-13 18:52 UTC, `50a8260` | 3: 2026-10-13 → 2026-10-13 | test | Groundedness extraction treats period labels and evidence string cells as non-measurements | `cd analytics-agent && uv run pytest tests/test_manager_groundedness_labels.py -q` → bad `ce50a49` exit 1, good `d7872e5` exit 0; `node tools/rule-table.mjs check AGENTS.md` → exit 0 | 0 | Baseline: none (no existing violations; new regression test). Suppressions: none. Vendored checker: `tools/rule-table.mjs`, contract version 1, sha256 `9ab0994ddab7d256f654791fb6d89a8f315d577b092ceae83a82887d90645822`; proof `docs/proof/groundedness-labels.md`. The check pins extraction over report text and evidence values; it does not pin the graph's rephrase-retry or first-draft behavior from `2479ab9`/`7f3c5de`. Repeat count is occurrences: three fixes, two repeats, all on 2026-10-13. Capture: **full** for the extraction class as written — month/year labels, dates and evidence string cells are all red at `ce50a49` and green at `d7872e5`, and a real measurement next to a unit still passes. Deliberately out of scope, and a different class: `2479ab9`'s rephrase retry and `7f3c5de`'s first-draft preservation govern what happens when groundedness fails, not what counts as a measurement. Window opens 2026-11-21. |
| 2026-11-21 | Pupkeep's devcontainer advertises truecolor to pi in `containerEnv` and inside tmux, so pi does not fall back to 256 colours | 2026-11-03 09:53:16 UTC, pupkeep `2c609d2`; 2026-11-03 09:53:19 UTC, analytics-agent `2aa6720` | 2: 2026-11-03 → 2026-11-03 | test | Pupkeep's devcontainer advertises truecolor to pi in `containerEnv` and inside tmux, so pi does not fall back to 256 colours | `cd /tmp/pupkeep-truecolor-bad && node --test test/devcontainer-truecolor.test.ts` → bad `f1f53e5` exit 1; `cd /tmp/pupkeep-truecolor-good && node --test test/devcontainer-truecolor.test.ts` → good `2c609d2` exit 0; `cd /tmp/pupkeep-prevent-recurrence && node tools/rule-table.mjs check AGENTS.md` → exit 0 | 0 | Baseline: none (new test; no existing violations). Suppressions: none. Vendored checker: `tools/rule-table.mjs`, contract version 1, sha256 `9ab0994ddab7d256f654791fb6d89a8f315d577b092ceae83a82887d90645822`; proof `docs/proof/devcontainer-truecolor.md`; `npm run check:rules` wired into `.github/workflows/ci.yml`; pupkeep commit `a62c878`. Capture: **partial** — all pupkeep forms are red at `f1f53e5` and green at `2c609d2` (`containerEnv`, tmux RGB/Tc, tmux COLORTERM/PI_TRUE_COLOR), but the check does not pin analytics-agent's copy (`2aa6720`) or a future project's; the shared-template fix the spec points at is open. The spec predicted a lint-level conversion for pupkeep (a greenfield ESLint gate); the evidence chose `test`, because the class lives in `devcontainer.json` and `tmux.conf`, which ESLint cannot see, and an ESLint pass would have been a dependency bought for a rule it cannot carry. Recorded as a divergence from the spec's prediction, not a silent substitution. The kokomi theme half of `2c609d2` is a different class and is not pinned. The four `fix(devcontainer)` commits `e618a05`, `8d40f34`, `2c609d2`, `b0e71f4` are not one class: ownership-before-postCreate, stale package ref, missing truecolor, wiped ssh config; only `2c609d2` is this class, paired with `2aa6720`. Window opened 2026-11-21. |

- **date** — the day the correction was handled, not the day of the first
  occurrence.
- **correction** — the class in one sentence, the same sentence the table row
  uses. A line number here is a bug fix, not a class.
- **evidence** — every occurrence, each with a date and a ref. This is the column
  a later reader uses to decide whether the repeat was real.
- **repeat count** — occurrences of the class, not repeats: `3` means three
  fixes and two repeats, and the two dates it spans follow it
  (`3: 2026-11-05 → 2026-11-25`). Greater than 1, or the row does not belong
  here. See "A repeat, defined".
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
- **notes** — the capture (`full` or `partial`, and the evidenced forms the check
  does not pin), the baseline path and its starting count, suppressions with
  reason, expiry and approver, open work, and anything the check cannot decide. A
  correction to an earlier row is a dated note here, never a rewrite of the
  evidence above it.

Copy this row and fill it; nothing else in the table moves:

```markdown
| <YYYY-MM-DD> | <class in one sentence> | <occurrence 1: date, ref>; <occurrence 2: date, ref>; <this one: date, ref> | 2: <date> → <date> | <level> | <row text> | `<enforcer>` → bad `<ref>` exit 1, good `<ref>` exit 0; checker exit 0 | <n> | <baseline, suppressions, open work> |
```

The first row is ticket 07's conversion (2026-11-21).

**2026-11-21 — both conversions are on their remotes.** A conversion that exists
only in one checkout does not count, so both branches were pushed and put under
review the day the window opened: `RRiboulet/analytics-agent#17` (base `dev`,
from `0e7a9b1`) and `RRiboulet/pupkeep#84` (base `main`, from `a62c878`). Both
rows' proofs were rerun the same day and returned the exit codes they record:
`analytics-agent` bad `ce50a49` exit 1 (5 failed, 1 passed) / good `d7872e5`
exit 0 (6 passed), the bad run inside a worktree whose `app/` is the bad revision;
`pupkeep` bad `f1f53e5` exit 1 (3 of 4 fail) / good `2c609d2` exit 0 (4 pass);
`node tools/rule-table.mjs check AGENTS.md` exit 0 in both projects. The
analytics-agent run happened inside the project's devcontainer: `uv` is not on
this host, and the project venv is the container's.

**2026-11-21 — correction to the second row's repeat count.** That row records 2
occurrences; the class has 3. The third is `my-agent-setup#96` (`1326f83`,
2026-11-03 11:51 UTC): it added the same `containerEnv` (`PI_TRUE_COLOR`,
`COLORTERM`), the same `terminal-features`/`terminal-overrides` pair and the same
`setenv -g` lines to this repository's own `.devcontainer` — the shared template
the spec names — two hours after the two project fixes (pupkeep `2c609d2`
09:53:16 UTC, analytics-agent `2aa6720` 09:53:19 UTC). So "the shared-template fix
the spec points at is open" in that row is wrong: it landed the same day, in this
repository. What is open is what the row already names — the check pins
pupkeep's forms only, not analytics-agent's copy, not this repository's template,
and not a future project's. The evidence cell above is left as written; this note
is the correction.

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
| baseline: 2026-10-22 → 2026-11-20 | 8 classes / 17 corrections | 182 merged (90 `my-agent-setup`, 82 `pupkeep`, 10 `analytics-agent`) | **cannot be measured** | reconstructed 2026-11-21, the day the window opened; scope, queries and counts below |
| week 1 (2026-11-21 → 2026-11-27) | | | | |
| week 2 (2026-11-28 → 2026-12-04) | | | | |
| week 3 (2026-12-05 → 2026-12-11) | | | | |
| week 4 (2026-12-12 → 2026-12-18) | | | | |

### The baseline, reconstructed 2026-11-21

Reconstructed on the day the window opened, because the baseline decays and
because the spec counts an unmeasurable count as a loss rather than a pass.

**Scope.** The three repositories this harness's agent worked in during the
period: `my-agent-setup`, `analytics-agent`, `pupkeep`. A correction made in any
of them is a correction the same agent made, and the window's own rows are in the
last two, so counting only this repository would make the two periods
incomparable.

**Queries**, run 2026-11-21, all reproducible:

```bash
for r in my-agent-setup pupkeep analytics-agent; do
  gh pr list -R RRiboulet/$r --state merged --limit 400 \
    --json number,title,mergedAt,reviews,body > /tmp/base-$r.json
done
# then filter mergedAt to 2026-10-22T00:00Z..2026-11-20T23:59Z
git log --since=2026-10-22 --until=2026-11-21 --format='%h %ad %s' --date=short
gh pr view <n> -R RRiboulet/<repo> --json title,body,reviews
```

**Changes reviewed.** 182 merged changes in the period — 90 in
`my-agent-setup`, 82 in `pupkeep`, 10 in `analytics-agent`. This is the
reproducible activity count, and it carries a caveat that must not be read past:
**"reviewed" is not distinguishable from "merged" for the baseline.** GitHub
records 0 review events on those 182 changes (the only review on a PR merged in
the period, on `#54`, was submitted 2026-10-15 and so falls outside it), and the
policy reviews a change only when the user asks, so the number of changes that
were actually reviewed is not written down anywhere. The window's number has to
be counted the same way for the comparison to mean anything.

**Repeat corrections.** 8 classes, 17 corrections. Each class has two dated
occurrences inside the 30 days except the truecolor class, which has three. The
class had to be one sentence that applies to both changes; a shared
`fix(devcontainer)` or `fix(worktree)` scope was not enough, and PR titles alone
were not evidence — each pair was confirmed against both commit bodies.

| class, in one sentence | occurrences | why these are one class |
|---|---|---|
| `devc` names its per-project state files by basename, so two projects with the same name share one | 2026-11-10 `#125` `23fb92a` (the lock); 2026-11-14 `#150` `9d97a36` (the config stamp) | `#150`'s body: "Same class as the shared-lock bug (23fb92a), same fix" |
| A `devc` per-project check reads only `.devcontainer/devcontainer.json`, so a repo-root `.devcontainer.json` project is silently unserved | 2026-11-10 `#124` `f4b6bd8` (`cfg_hash` hashes an empty stream); 2026-11-14 `#149` `9428c50` (`doctor` skips the project and prints "nothing blocking") | both are the same omitted layout in different functions, and `#149` names the functions that already handled it |
| The worktree `Remove` sweep can match no pane and still proceed, so the tree is removed from under a live shell | 2026-11-10 `#115` `9a115ac` (`awk -v` escapes the path); 2026-11-20 `#174` `a37b60d` (tmux rewrites the tab in a C locale) | both bodies: an empty sweep and a completed sweep print the same output, and the next line takes the tree from under a live session |
| `opencode-go`'s stale model cache serves routing the code has left behind | 2026-11-11 `#120` `feff441` (curated `reasoning`/`thinkingLevelMap` never refreshed); 2026-11-13 `#136` `fcdf23c` (the cache is unversioned, so a pre-`#117` cache replays old `api`, `baseUrl` and cost) | `#136` is written as the residual of `#120` "after #120, refreshing only …" |
| The parent launches a subagent with an `--extension` copy the child must not load, so pi dies on duplicate `--attach-subagent` registration | 2026-11-08 `#103` `66148f7` (resolved from the parent's tree, so a worktree-rooted child loads two copies); 2026-11-13 `#139` `21c39d9`, with the same-round `#140` `591c804` (a copy the child's project excludes) | the same startup error and the same "Child Pi exited before reporting a result" symptom in both |
| The `review-triage` policy that ships is not the policy a real install runs, so a review dies or silently falls back | 2026-11-12 `#134` `5ec6697` (candidates on a provider with no credential); 2026-11-15 `#157` `4f3121d` (an unconfigured install leaves the bands empty; a missing credential is dropped silently) | both fix shipped-configuration ≠ working configuration; `#157` adds the diagnosis `#134`'s failure lacked |
| The devcontainer does not advertise truecolor, so pi falls back to 256 colours in the container and inside tmux | 2026-11-03 `pupkeep` `2c609d2` (09:53:16 UTC); 2026-11-03 `analytics-agent` `2aa6720` (09:53:19 UTC); 2026-11-03 `#96` `1326f83` (11:51 UTC, this repository's shared template) | the class is the second row of the log above, and its conversion is that row; the three fixes landed within two hours, which is what makes this the structural one |
| A JSX line splits two expressions, so the literal space between them is dropped | 2026-11-12 `pupkeep` `#71` `3b4d891`; 2026-11-12 `pupkeep` `#72` `31561d0` | `#72`'s body: "the same defect class as the appointment detail fixed in #71" |

Pairs that were **not** counted as repeats, and why:

- `#111` → `#119` (subagent `result.json` validation) — `#119` closes the findings
  of `#111`'s own two reviews, so that is one occurrence with two attempts.
- `#139` → `#140` — same review round, same day, same change; counted once.
- `#120` and `#122` (same day, `opencode-go` curated-vs-live reasoning) — one
  round's findings in two PRs, so one occurrence.
- `#142` → `#146` (`opencode-go` cost tiers) — one sentence does not apply to
  both: `#142` corrected a flat price read, `#146` corrected the band mapping
  `#142` introduced. Different mistakes in the same function.
- `#110` → `#124`/`#125` — `#124` and `#125` close **review findings on
  `#110`**, so the `#110` round is one occurrence; `#125` is then paired with
  `#150` (its own repeat) and `#124` with `#149`, as above.

**Review rounds per change: cannot be measured.** Three sources were tried.
GitHub has 0 review events on the 182 changes (above). The review tooling keeps
no log: `~/.pi/agent/review-triage.json` is policy, and a `triage_change` call
leaves no record. The agent's own session store exists —
`~/.pi/agent-host/sessions`, 28 session files — but its oldest file is
2026-11-14, so it covers 7 of the baseline's 30 days and, even there, records
conversations rather than reviews per change. A mean over 7 of 30 days is a proxy
nobody defined, and the spec forbids it here: the cell says "cannot be measured",
not a number.

**What that means for the verdict.** By "How a loss is decided", a count that
cannot be measured is a loss, not a pass. Criterion 3 — review rounds did not
rise — compares the window's mean with the baseline's, and the baseline's does
not exist, so criterion 3 cannot be satisfied whatever the window records. That
is written here on 2026-11-21, the day the window opened, rather than discovered
at the close as an excuse. The window still runs to 2026-12-19 for the other two
counts and for the record; the default direction remains delete.

### How a win is decided

All three, or the experiment loses:

1. **A conversion reached a check, and it says what it captured.** At least one
   row's level is `architecture`, `type`, `lint` or `test` — not `prose` — and its
   proof shows the enforcer exiting 1 at the bad revision and 0 at the good one,
   with the checker exiting 0 on the row. A prose row can be the honest answer and
   is recorded; it just does not show that a check replaced a review. The row also
   states its **capture**:

   - **full** — every form the class's evidence shows is red at the bad revision
     and green at the good one;
   - **partial** — some evidenced form is left unenforced.

   A partial capture is a real row and real enforcement for what it pins, but on
   its own it does not satisfy this criterion: the experiment asks whether a class
   stopped recurring, not whether one shape of it was caught. Narrowing the class
   to the forms the check pins is allowed — the row's rule text then has to say
   the narrower thing, and the notes have to name the forms dropped and why they
   are a different class. A rule narrowed by silence takes the credit of the
   broad class it replaced, which is the failure this experiment exists to stop.
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
