---
status: ready
blocked-by: ["05"]
---

# 06: Dry run — forced failure proves the floor

**Blocked by:** 05
**Status:** ready

## What to build
The end-to-end proof the spec's Verification section calls for: a disposable
three-ticket folder where one Tier-1 ticket is artificially forced to fail its
reviewer gate and one is forced to crash. The dry run demonstrates: gate-vote
escalation retiering the first ticket, retry-then-escalate on the second,
in-place status transitions readable by grep mid-run, serial post-verify
commits citing ticket numbers, and a closing report covering tiers, gate
verdicts, escalations, and blockers.

## Scope
The dry run itself (disposable folder, transient harness) and any skill fix it
surfaces. No new features.

## Acceptance criteria
- [ ] The closing report exists and accounts for all three tickets, including
      the forced failures' escalations.
- [ ] Every commit on the branch cites a ticket number and follows a passed
      validation; the forced-failure ticket's escalation is visible in run
      records.
- [ ] Mid-run status transitions were observed by reading ticket files while a
      wave was live.

## Validation
The dry-run transcript reference plus a green `node tools/branch-base.mjs`
check: only this work's commits between `dev` and HEAD.
