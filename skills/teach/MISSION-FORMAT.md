# MISSION.md Format

`MISSION.md` lives at the workspace root and captures the _reason_ the user is learning this topic. Every teaching decision — what to teach next, which resources to surface, which exercises to design — should trace back to it.

<!-- Adapted from mattpocock/skills; MIT notice in licenses/NOTICE.md. -->

## Template

```md
# Mission: {Topic}

## Why
{1-3 sentences. The concrete real-world goal the user is chasing. What changes in their life or work when they have this skill? Avoid abstract framings like "to understand X"; push for the underlying outcome.}

## Success looks like
- {A specific, observable thing the user will be able to do}
- {Another specific thing}
- {…}

## Constraints
- {Time, budget, prior commitments, learning preferences, anything that bounds the approach}

## Out of scope
- {Adjacent topics the user explicitly does not want to chase right now, protecting the zone of proximal development}
```

## Rules

- **One mission per workspace.** Two unrelated things are two workspaces, in two directories.
- **Concrete over abstract.** "Run a half marathon by October" beats "get fitter." "Ship a Rust CLI to my team" beats "learn Rust."
- **Push back on vagueness.** If the user cannot say why, interview them before writing anything. A bad mission is worse than no mission, because every later lesson inherits its drift.
- **Revise when reality shifts,** after confirming the change with the user. Never leave a stale mission steering future sessions.
- **Keep it short.** Past one screen it has stopped being a compass and started being a plan.
