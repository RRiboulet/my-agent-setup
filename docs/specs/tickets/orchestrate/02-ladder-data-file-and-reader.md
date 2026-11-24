---
status: done
blocked-by: []
---

# 02: Ladder — tiered-model data file and pure reader

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
The single source of truth for the dispatch policy: `.pi/skills/orchestrate/ladder.json`
holding the roster (`triage`, `researcher`, `implementer`, `reviewer`,
`verifier`), three tiers of *(model, thinking)* pairs — Tier 1 a free model at
`max` thinking, Tier 2 `deepseek-v4.1-flash` @ `medium`, Tier 3
`mistral/zai-glm-5-3` @ `high` — and per-type pins: `triage` → a Jev-class
decision model, `reviewer`/`verifier` → Tier 2 with `verifier` thinking `high`.
Plus a pure reader module (`.pi/extensions/orchestrator/` reader pattern) that
validates schema, tier coverage, and tier-exempt pins, and fails open with a
visible warning on malformed input.

## Scope
The data file and the reader with `node --test` tests. The skill that reads it
is ticket 05.

## Acceptance criteria
- [ ] `readLadder` returns the parsed ladder for a valid file and a warnings
      list alongside defaults for a malformed one — never throws.
- [ ] Tests cover: missing/thinking-out-of-range tiers, a roster type with no
      tier coverage, an exempt type (triage) without its pin, and unknown
      roster entries.

## Validation
`node --test` on the reader's test glob passes with `fail 0`.
