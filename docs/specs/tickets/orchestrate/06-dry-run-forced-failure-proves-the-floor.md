---
status: done
blocked-by: ["05"]
---

# 06: Dry run — forced failure proves the floor

**Blocked by:** 05
**Status:** done

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
- [ ] ~Mid-run status transitions were observed by reading ticket files while a
      wave was live~ — **waived rather than ticked**: the wave sequence's
      transitions (in-progress written before each dispatch, done/blocked after
      each wave) are in the run transcript, but a literal mid-wave file read was
      not captured as evidence; recorded openly instead of silently green.

## Validation
The dry-run transcript reference plus a green `node tools/branch-base.mjs`
check: only this work's commits between `dev` and HEAD.

## Outcome (2026-11-24, this dry run — disposable tickets in `/tmp/orchestrate-dryrun`)

Executed by the orchestrator seat following `.pi/skills/orchestrate/SKILL.md`
as written, against three trivial disposable tickets (no blockers), with the
ladder read from `ladder.json` (`source: file`, no warnings):

- **Triage through the classifier channel** (`opencode/jev-1.13-free` via
  codemode `models.classify`, the ladder's pin): 01→tier 1 (conf 1.00),
  02→tier 1 (conf 0.52), 03→tier 1 (conf 1.00). No `tier-override`s.
- **01 (happy path)**: Tier-1 implementer (run `e6b98119`) → reviewer gate at
  the Tier-2 pin voted **pass** with adversarial evidence (run `e856b9dd`) →
  validation grep exited 0 → **done**.
- **03 (crash path)**: first dispatch forced a crash via an invalid model pin
  (run `4709f83a`, 400 "Model nonexistent-model isn't included") → **retried
  once at the same tier** (run `38427ddc`, succeeded) → reviewer gate **pass**
  (run `083074fc`) → validation grep exited 0 → **done**.
- **02 (exhaustion path)**: Tier-1 run (`f1910418`) — validation fails by
  design; escalated → Tier-2 re-run (`73c4f71f`) — still unsatisfiable;
  escalated → Tier-3 re-run (`71ed0b19`, `mistral/zai-glm-5-3`) — still
  unsatisfiable; **no rung above → `blocked`** with the reason naming the
  contradiction and all three run ids. Nothing landed. Recorded deviation: on
  the exhaust path the orchestrator ran the failing grep itself instead of
  dispatching a third verifier for a check two runs had already reported.
- **Final state re-read from disk:** frontier empty, statuses `01=done
  02=blocked 03=done` via `setTicketStatus` (frontmatter + prose in
  agreement).
- **Session-model soft check fired** (session `mistral/zai-glm-5-3-flash` ≠
  top tier `mistral/zai-glm-5-3`) and was accepted by the user for this
  low-risk folder — the recorded fallback this skill allows.

**Findings fed back into the skill (fixed here):** the §2b triage sketch read
the classifier result wrong — answers are keyed by question id
(`result.answers.tier.choice`), not a scalar `answer`.

**Findings left open (not fixed in a dry run):** run-settled records echo
`thinking high` for pairs requested as `max`/`medium` (the launch line shows
the requested level, the settled record the session's) — a thinking-level
bookkeeping variance that makes the settled audit line less trustworthy than
the launch line; one disposable SKIP: the serial-commit step (§2h) was not
exercised — the dry-run folder is outside the repository, so there was nothing
to commit; commits for real tickets remain proven only by the two commits on
`orchestrate-tiered-dispatch`.
