# AGENTS.md

## Rules and enforcement

| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| The suite runs before a claim of done | test | `node --test` | `proof/evidence.md` |
No new dependency without a decision record | lint | `node tools/deps-check.mjs` | `proof/evidence.md` |
