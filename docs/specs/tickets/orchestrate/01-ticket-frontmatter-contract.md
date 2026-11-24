---
status: done
blocked-by: []
---

# 01: Ticket frontmatter contract for to-tickets

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
The `to-tickets` skill's ticket template and Process §4 gain structured YAML
frontmatter — `status`, `blocked-by` (list), optional `tier-override` — written
alongside the existing prose sections. The prose `**Blocked by:**` and
`**Status:**` lines stay for human readers; frontmatter is the machine
contract. Consumers parse frontmatter, never prose.

## Scope
`.pi/skills/to-tickets/SKILL.md` template + one generated sample ticket
demonstrating the contract. Leaves the `orchestrate` skill and its parser for
later tickets.

## Acceptance criteria
- [ ] The published template shows frontmatter with `status`, `blocked-by`,
      optional `tier-override`, and prose sections unchanged.
- [ ] A ticket generated from the template has frontmatter that a YAML parser
      reads into `{status, blocked-by[], tier-override?}` with defaults when
      fields are absent (`blocked-by: []`, `status: ready`).

## Validation
Generating the sample ticket from the updated template and parsing its
frontmatter with a one-off script exits 0 with the expected shape.
