# 06: The comment question has an evidence-backed answer

**Blocked by:** None (can start immediately)
**Status:** ready

## What to build

A read-only audit that decides whether comment slop is a real problem in
`pupkeep` and `analytics-agent`, or whether the keyword scan was right. Thirty
comments per project, stratified by adjacency to suppressions, timers, retries,
and ordinary code; each classified as invariant, external quirk, workaround
justification, or narration.

## Scope

- An extraction script using the standard library, and a short report beside the
  experiment docs.
- Counts per class, at least one example per class with secrets redacted, the
  percentage of workaround justification, and a decision against the 20%
  threshold.
- No product code and no comment skill.

Leaves any comment experiment to a follow-on if the threshold is met.

## Acceptance criteria

- [ ] Thirty comments from each project are classified and the counts add up.
- [ ] At least one example per class is recorded.
- [ ] The decision against the 20% threshold is recorded.
- [ ] No comment skill is added.

## Validation

Re-run the extraction and recount. Covers R13.
