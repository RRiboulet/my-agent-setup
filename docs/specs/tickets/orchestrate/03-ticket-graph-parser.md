---
status: done
blocked-by: ["01"]
---

# 03: Ticket-graph parser

**Blocked by:** 01
**Status:** done

## What to build
A pure module that turns a tickets folder into a checkable graph: reads each
ticket's frontmatter into nodes, `blocked-by` into edges, and exposes graph
queries — the frontier (blockers all done), cycles, dangling blocker
references, status transitions — plus `tier-override` precedence over any other
tier source.

## Scope
The parser module and `node --test` tests only. Who calls it (the orchestrate
skill) is ticket 05.

## Acceptance criteria
- [x] Cycles and dangling blockers are reported as named, checkable errors
      before any dispatch could happen.
- [x] `tier-override` in a ticket's frontmatter wins over everything else.
- [x] Status transitions (`ready → in-progress → done/blocked`) write back to
      frontmatter and are visible to a plain file read.

## Validation
`node --test` on the parser's test glob passes with `fail 0`; cases include a
three-node diamond, a cycle, a dangling edge, and an override.
