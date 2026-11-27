---
name: retro
description: "Improve the repository's harness, checks, and agent instructions after repeated friction, fixing mistakes at the highest durable layer. Use when: asked for a retro; after repeated corrections; or after a milestone exposes tooling or doc gaps."
---

# Retro

Improve the environment so future sessions cannot repeat the same mistake — not just the code from this turn. Assume every future contributor sees only the files they open and copies the nearest example.

## 1. Collect concrete friction

Review this session (and recent commits or PR reviews if relevant) and list specific failure modes:

- Corrections the user had to repeat.
- Misleading, stale, or contradictory instructions and docs.
- Missing checks, or checks that exist in the repo but are not wired into CI, hooks, or `.agent/quality.yaml`.
- Navigation dead ends or awkward workarounds that burned time.

## 2. Fix at the highest durable layer

For each mistake class, choose the highest layer that prevents it reliably:

1. **Structure or API**: hide internals, enforce one state owner or one supported way so the wrong call cannot compile or import.
2. **Automated check**: type rule, lint rule whose error message names the fix, pre-commit hook, CI check, or `.agent/quality.yaml` step. If a check already exists but is unwired, wiring it is the fix.
3. **Test**: a focused behavioral test that fails when the mistake returns.
4. **Instructions or docs (last resort)**: only for genuine judgment calls that tooling cannot enforce.

## 3. Prove new checks bite

Before accepting any new lint, type, or test guardrail, confirm it fails against the real past mistake (or a minimal scratch repro) and passes once reverted.

## 4. Prune sediment

While editing instructions or docs, delete:

- Stale rules that no longer match the codebase.
- Caches that merely restate `package.json`, `pyproject.toml`, or config files.
- No-op generic advice that capable agents already follow.

Keep agent instruction files short so real rules are not drowned out.

## 5. Propose and apply

Present each proposed harness change with four fields: **friction observed**, **target file**, **layer**, and **how it will be verified**. Wait for user approval before modifying repo conventions, hooks, or CI, then load the `prove-it-works` skill on the applied changes.
