# Learning Record Format

Learning records live in `learning-records/` and use sequential numbering: `0001-<dash-case-name>.md`, `0002-…`. Create the directory lazily, with the first record.

<!-- Adapted from mattpocock/skills; MIT notice in licenses/NOTICE.md. -->

They are the teaching equivalent of ADRs: non-obvious lessons, corrected misconceptions, and stated prior knowledge that will steer later sessions. They are what the zone of proximal development is computed from.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

That is the whole format. A learning record can be a single paragraph. The value is recording _that_ this is now known and _why_ it changes what to teach next, not in filling out sections.

## Optional sections

Only when they add genuine value; most records need none.

- **Status** frontmatter (`active | superseded by LR-NNNN`) for an understanding that later turned out to be wrong.
- **Evidence**: how the user demonstrated it — a question answered, an exercise completed, experience cited. Use it when the claim might be revisited.
- **Implications**: what this unlocks or rules out next. Worth recording when non-obvious.

## Numbering

Scan `learning-records/` for the highest existing number and add one. Do not renumber when a record is superseded: the order is the history.

## When to write one

Any of these:

1. **Demonstrated understanding of something non-trivial** — not exposure, but evidence they can use the concept correctly. This raises the floor for what to teach next.
2. **Prior knowledge disclosed** ("I already know X") — so a later session does not re-teach it. Record the depth claimed, not just the topic.
3. **A misconception corrected** — the highest-value record, because it predicts where related topics will trip them up.
4. **The mission shifted in response to learning** — the user discovered they cared about something else. Update `MISSION.md` with their agreement and cross-reference it here.

### What does not qualify

- Material that was merely covered. Coverage is not learning; wait for evidence.
- A term already defined in `GLOSSARY.md`. Do not duplicate a definition.
- A session-by-session activity log. These are decision-grade insights, not a journal.

## Supersession

When a later record contradicts an earlier one — the understanding deepened or was corrected — mark the old one `Status: superseded by LR-NNNN` rather than deleting it. How the user's understanding evolved is itself signal: it says which explanations worked and which only appeared to.
