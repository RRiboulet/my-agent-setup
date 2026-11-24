---
status: done
blocked-by: ["01", "02", "03", "04"]
---

# 05: Author the orchestrate skill

**Blocked by:** 01, 02, 03, 04
**Status:** done

## What to build
`.pi/skills/orchestrate/SKILL.md` + the `ladder.json` instantiation: the
wave-based dispatch loop over a ticket folder. Per ticket: triage via the
pinned decision model ( recorded tier + one-line justification, `tier-override`
honored) → tiered dispatch with task text referencing skills by name → crash
retry-once at same tier, then escalate one tier → Tier-1 output passed through
a Tier-2 reviewer gate that may vote to escalate → verifier runs the ticket's
Validation section → orchestrator commits serially, message citing the ticket
number. Exhausted escalation marks the ticket `blocked` with a reason. Session
entry soft-checks that the main model is Tier 3. The run closes with a report:
per-ticket tier, gate verdicts, escalations, blockers. Implementers reserve
their ticket's file scope before editing; wide-blast-radius tickets opt into
single-runner worktrees.

## Scope
The skill file and its ladder instantiation. The reader and parser modules come
from tickets 02–03 and are consumed, not reimplemented.

## Acceptance criteria
- [ ] Every dispatched run's record shows a *(model, thinking)* pair from
      `ladder.json`; `ladder.json` is the only copy of that table.
- [ ] A crashed run retries at the same tier once, then escalates one tier,
      observable in run records.
- [ ] Tier-1 output is gated by a Tier-2 reviewer whose verdict is recorded;
      Tier-2+ output has no gate.
- [ ] Each commit lands after that ticket's validation passed and cites the
      ticket number; no implementer run commits.
- [ ] Entry warns and requires confirmation when the session model is not
      Tier 3.

## Validation
Dry run against a disposable three-ticket folder succeeds end to end (full
proof is ticket 06).
