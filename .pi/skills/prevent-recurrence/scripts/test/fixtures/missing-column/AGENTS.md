# AGENTS.md

## Rules and enforcement

| Rule | Level | Enforced by |
|---|---|---|
| The suite runs before a claim of done | test | `node --test` |
| No new dependency without a decision record | lint | `node tools/deps-check.mjs` |
