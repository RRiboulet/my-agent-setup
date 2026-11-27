# AGENTS.md

Project rules that a check can enforce are recorded here, one row per rule.

## Rules and enforcement

| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| Dependency direction is one-way | architecture | `node tools/boundaries.mjs` | `proof/boundaries.md` |
| No new dependency without a decision record | lint | `node tools/deps-check.mjs` | `proof/evidence.md` |
| The suite runs before a claim of done | test | `node --test` | `proof/evidence.md` |
| Every rule has a named owner | prose | judgment: ownership is a human fact the table cannot infer | `proof/evidence.md` |

Anything below the table ends it.
