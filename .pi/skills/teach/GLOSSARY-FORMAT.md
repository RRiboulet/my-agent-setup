# GLOSSARY.md Format

`GLOSSARY.md` is the canonical vocabulary of the teaching workspace. Lessons, exercises, reference sheets and learning records all use its terms. Building it is itself learning: compressing a concept into one tight definition is evidence the user understands it.

<!-- Adapted from mattpocock/skills; MIT notice in licenses/NOTICE.md. Upstream
     ships this file without linking it from SKILL.md, so in practice the
     glossary never got built; `SKILL.md` here links it deliberately. -->

## Structure

```md
# {Topic} Glossary

{One or two sentences describing the topic this glossary covers.}

## Terms

**Hypertrophy**:
Muscle growth driven by mechanical tension and metabolic stress over repeated training sessions.
_Avoid_: Bulking, getting big

**Progressive overload**:
Systematically increasing the demand on a muscle over time, via load, volume, or intensity.
_Avoid_: Pushing harder, levelling up

**RPE (Rate of Perceived Exertion)**:
A 1–10 self-rating of how hard a set felt, where 10 is failure and 8 means two reps left in the tank.
_Avoid_: Effort score, intensity rating
```

## Rules

- **Add a term only when the user understands it.** The glossary records compressed knowledge; it is not a dictionary to read in order to learn. Just-introduced concepts wait until the user can use them correctly.
- **Be opinionated.** When several words exist for one concept, pick one and list the rest as aliases to avoid. That is how language compresses.
- **Keep definitions tight.** One or two sentences, defining what the term *is*, not what it does or how to do it.
- **Use the glossary's own terms inside definitions.** Once a term is in, prefer it everywhere, including inside other definitions: that is what makes later terms easy to absorb.
- **Group under subheadings** when clusters emerge (`## Anatomy`, `## Programming`). A flat list is fine when the terms cohere.
- **Flag ambiguities explicitly.** Where the wider field uses a word loosely, record the resolution: "In this workspace, 'set' always means a working set; warm-ups are tracked separately."
- **Revise as understanding deepens.** A definition from week one may be wrong by week six. Update in place; do not keep a stale entry beside a new one.
