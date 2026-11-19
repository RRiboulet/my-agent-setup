---
name: prevent-recurrence
description: Turn a repeated correction into an enforced check at the highest level that works, prove it against the real past mistake, and record the rule in the repository's "Rules and enforcement" table. Use when the same mistake class has been corrected twice.
disable-model-invocation: true
---

# prevent-recurrence

> **Scaffolding.** This file exists so the checker in `scripts/` has its canonical
> home in the tree and the skill directory is a valid pi skill. The process body —
> the ordered level ladder, the lint-locality test, the Python adapter (the JS/TS
> adapter lands in ticket 04), the ratchet, the no-suppression rule, and the
> integration triggers — lands in ticket 03
> (`docs/specs/tickets/prevent-recurrence/03-skill-and-python-adapter.md`), which
> also rewrites `description` and removes `disable-model-invocation`. Until then
> the skill is deliberately hidden from model selection: an advertised skill with
> no process behind it would be worse than an absent one.

## What exists now

`scripts/rule-table.mjs` — the deterministic checker for the
`## Rules and enforcement` table, with its fixtures and tests beside it.

```bash
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check --json AGENTS.md
node --test .pi/skills/prevent-recurrence/scripts/test/*.test.mjs
```

Exit 0 when every row is enforceable, 1 on a violation with the file line, table
row and reason, 2 on a usage error. The table format, the `--json` field
contract, and the violation codes are documented in
[`references/rule-table.md`](references/rule-table.md).
