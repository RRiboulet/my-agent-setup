---
name: to-spec
description: "Turn the current conversation and codebase understanding into a written spec with test seams and acceptance criteria, without re-interviewing you."
disable-model-invocation: true
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# To spec

Synthesize what is already known into a spec someone else could implement and verify. Do not interview the user; the conversation and the code are the input.

## Process

1. **Gather.** Read the conversation, any linked issue or document, and the code it touches. If the repository has a glossary, ADRs, or architecture docs in this area, use their vocabulary and respect their decisions. If an existing issue or doc already holds all of this, say so and stop instead of duplicating it.
2. **Play it back.** If no playback exists yet, load the `in-your-own-words` skill. Resolve its risky assumptions before writing.
3. **Choose test seams.** Prefer existing seams to new ones and the highest seam that exercises the behavior; the ideal is one. Show the user the proposed seams and any remaining risky assumptions in a few lines, and adjust if they object.
4. **Write the spec** with the template below.
5. **Save it.** Use the destination the user named. Otherwise follow the repository's convention for specs or design docs. Otherwise write `docs/specs/<YYYY-MM-DD>-<slug>.md`. Publish to an issue tracker only if the user names one. Do not commit unless asked.
6. **Report** the path and suggest the next step: `/skill:to-tickets` when the work has three or more units, real dependency edges, or will not fit one session; otherwise `/skill:implement`.

## Template

```markdown
# <Title>

## Objective
The problem from the user's perspective and why it matters now.

## Current behavior
What happens today, with the evidence (command, test, or observation).

## Required behavior
What must be true afterwards, from the user's or caller's perspective. Number the
behaviors (or write them as user stories) so tickets and tests can cite them.

## Non-goals
What this deliberately does not do.

## Constraints
Compatibility, performance, security, data, and operational limits.

## Design decisions
Modules and interfaces that change, contracts, schema changes, and notable
trade-offs with the alternatives rejected.

## Test seams
Where behavior will be tested and why there; prior art in the repository.

## Acceptance criteria
- [ ] Observable, checkable criteria, each traceable to a required behavior.

## Verification
The commands, checks, or manual steps that prove the acceptance criteria.

## Open assumptions
Anything still assumed, with its risk and who can confirm it.
```

Keep file paths and code snippets out of design decisions; they go stale. The exception is a snippet from a prototype that pins a decision more precisely than prose (a state machine, schema, or type shape): include only the decision-rich part and note that it came from a prototype.
