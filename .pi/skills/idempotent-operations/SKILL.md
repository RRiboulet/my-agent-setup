---
name: idempotent-operations
description: "Design state-changing operations so they converge to the same end state no matter how many times they run or where a previous run stopped. Use when: writing or reviewing retries, queue or event consumers, webhooks, scheduled or background jobs, CLI or lifecycle commands, deploy or setup scripts, data migrations, or anything that must survive crashes and restarts."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Idempotent operations

Every state-changing operation must answer two questions: what happens if this runs twice, and what happens if the previous run crashed halfway? Where crashes, restarts, timeouts, and retries are normal, an operation whose outcome depends on leftover partial state turns every restart into a debugging session.

## The idea

Derive each step from the state that exists, not from what the previous run meant to do. Read the current state, compare it with the goal, and apply only the difference. A step written this way is safe to repeat, because a repeat finds nothing left to do.

Anything a run leaves behind (a lock, a temporary file, a half-written record, a claimed job) must be recognizable as stale by the next run. Judge staleness by evidence that stays true wherever the previous run could have stopped, not only in the common case. A marker the next run cannot judge turns every crash into manual cleanup.

## Techniques

- **Create or update:** use upserts, `CREATE ... IF NOT EXISTS`, `mkdir -p`, or "ensure" functions instead of blind inserts and creates.
- **Requests and messages:** accept an idempotency key or a natural unique key, record it with the result in the same transaction as the effect, and return the stored result on a repeat. Treat queues and webhooks as at-least-once: deduplicate in the consumer, not only in the producer.
- **Files and artifacts:** write to a temporary path in the same directory, then rename it into place atomically. Compare by content or checksum, not by timestamp or creation order.
- **Multi-step workflows:** make each step check its own postcondition and skip if it already holds, or record progress in durable state written with the step's effect, so a restart resumes instead of repeating.
- **Locks and claims:** give them an owner and an expiry or heartbeat, so the next run can tell a live holder from a dead one.
- **Migrations and setup scripts:** guard each change on the current schema or state, make backfills resumable in batches, and never assume the previous run finished.
- **External side effects** (emails, payments, third-party calls): pass the provider's idempotency key, or record "sent" with a unique key before or atomically with the call, and decide explicitly which failure mode is acceptable: at most once or at least once.
- **Reconcile loops:** for anything that drifts, prefer a loop that compares desired with actual state and fixes the difference over a sequence of one-shot commands.

## The test

1. What happens if this runs twice in a row?
2. What happens if the previous run crashed at each possible point?
3. Does re-running converge to the same end state?

If any answer is "it depends on what state was left behind", the operation needs a reconciliation step. Where it fits, encode question 1 or 2 as a test: run the operation twice, or interrupt it between steps, and assert the end state.
