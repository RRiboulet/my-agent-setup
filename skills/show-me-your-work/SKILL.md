---
name: show-me-your-work
description: "Keep an append-only TSV decision trail, audit it before handing back, and surface flags. Use when: asked to show your work or keep a decision log, on autonomous or multi-phase runs, or for long unsupervised work."
---

# Show me your work

Keep one canonical decision log so a reviewer can trust the result without replaying the session.

Todo trackers cover *what is left to do*; this log covers *what was decided and why*. Use it when the user asks for a decision trail or when a long, multi-phase, or unattended run needs to be judged from its evidence.

## The format

A single TSV file, one row per decision. Cells stay on one line. Evidence is a pointer, not prose. [assets/decision-log-template.tsv](assets/decision-log-template.tsv) holds the header row. Columns:

- **ts**: ISO 8601 UTC timestamp.
- **phase**: the phase or workstream.
- **decision**: what was chosen or done, in one line.
- **why**: the reason in plain words.
- **evidence**: a pointer that proves it: commit SHA, PR number, `file:line`, a command and its output file, or an artifact, trace, or screenshot path. Never a paragraph.
- **result**: the outcome: `tests green`, `reverted`, `pixel-diff 0`, `inconclusive`, `open`.

```text
ts	phase	decision	why	evidence	result
2026-05-24T09:02:00Z	frame	counted the work first, about 100 components	wanted the size before starting a long run	commit 3a9f1c2	found 5 things to sort out first
2026-05-24T09:40:00Z	harness	took screenshots of the old version before changing anything	to compare old against new and catch visual changes	scripts/snapshot.sh, baseline/	saved 120 reference screenshots
2026-05-24T11:15:00Z	widget	moved the widget styles over without changing how it looks	keep the change small and the result identical	commit 7c21e0a, pixel-diff 0	identical, tests pass
2026-05-24T12:30:00Z	widget	threw out a helper's work because its screenshots were blank	checked the real files instead of trusting its summary	discarded the helper's own worktree	redone, tightened the instructions
```

## Logging a row

Write each entry the way you would tell a teammate what you did: plain words, concrete actions, no jargon.

Use [scripts/log.sh](scripts/log.sh) (`scripts/log.sh <logfile> <phase> <decision> <why> <evidence> <result>` from this skill's folder). It stamps `ts`, writes the header on first use, strips tabs and newlines, and prefixes any cell starting with `=`, `+`, `-`, or `@` with a single quote so spreadsheets do not run it as a formula. Appending a row by hand works too, with the same care for generated or user-supplied text.

Log decision points and checkpoints, not every action: a fork chosen, a unit completed with its verification result, a pivot or revert and its trigger, a blocker, a gate fixed. In loops, one row per iteration. Skip the trivial.

A run is one agent session, including its later turns. When a run adds to a log that already has rows, its first row has phase `start`, naming the `ts` range of earlier rows it did not write, with evidence identifying this run (agent or session id). Before writing in a later turn, read the last rows to see whether another run wrote since; if so, add a new `start` row. Use phase `start` for nothing else.

## Where it lives

By default the log is a working file, not committed. Keep it at `.audit/<task-slug>.tsv` in the repository root and, in a git repository, add `.audit/` to `.git/info/exclude` (local only, nothing to commit) so it never shows up as an untracked file in status, diffs, or reviews. Outside a git repository, keep it in the operating system's temporary directory instead.

Commit it only when the work is ambitious enough that a reviewer needs the trail to trust the result, or the user asks; then move it to a path the user agrees on.

## Rules

- Append-only. A wrong call gets a new row that supersedes it. Never edit or delete history.
- Prefer evidence produced by committed scripts over one-off manual checks.

## Audit before handing back

Check that the log told the truth. Walk this run's rows against your own record of what you did: the commands you ran, the files you changed, and the results you saw.

- Every row maps to a real decision or action.
- Every evidence pointer resolves and shows what the row claims.
- A fork, pivot, or abandoned approach that shaped the work but is missing is a gap. Add it.

Correct the log, not the story: never edit or remove a row. Supersede a wrong row with a new one that states what actually happened and points to evidence that resolves.

## Independent review

Before handing back, have an independent fresh-context reviewer inspect the trail — via a `reviewer` subagent (on a different model family if the harness allows). It does not redo the work; it flags what the user should look at:

- Decisions with weak or missing evidence.
- Verification claimed but not shown.
- Choices that look risky in hindsight: premature, scope-creeping, or papering over a symptom.
- Gaps a casual skim would miss.

If no sub-agent is available (or repository policy defers independent review to a separate step), perform that check yourself and say so.

End every reply for a run that produced a trail with an **Attention** section. Its first line is `reviewed by <model>`, or `self-reviewed`, followed by each flag pointing at specific rows. "No flags" is a valid list; the reviewer line is not optional.

## Reading the trail

Read top to bottom, follow the evidence pointers, spot-check. `column -s$'\t' -t .audit/<task-slug>.tsv` renders it in a terminal; GitHub renders a committed TSV as a table.

Other skills that need an audit trail should load this skill rather than invent their own format.
