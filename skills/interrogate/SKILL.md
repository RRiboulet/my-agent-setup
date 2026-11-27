---
name: interrogate
description: "Run an adversarial break-the-change audit that proves concrete failures by executing code, skipping style. Use when: asked to red-team or stress-test a change; or before merging high-risk auth, security, concurrency, or migration code."
---

# Interrogate

Try to break a change and prove every failure by running real code. Skip style, naming, and spec-completeness checks (load the `review-change` skill for balanced multi-axis review).

## 1. Pin the target

- Identify the exact diff (`git diff <base>...HEAD` plus working tree changes, including untracked files) or the files named by the user.
- State the intended behavior in one sentence. Confirm the diff is non-empty before proceeding.

## 2. Attack from distinct failure angles

If the harness supports parallel read-only sub-agents with fresh context, fan out 2–3 adversaries (different angles, never editing the repo); otherwise run each angle in separate passes:

- **Trust and security**: authz/authn bypasses, secret or PII leakage, injection, unvalidated external input, privilege or tenant bleed.
- **Edge and failure states**: empty, null, huge, malformed, duplicate, or out-of-order inputs; partial failures; timeouts; silent fallbacks that mask errors.
- **State and concurrency**: races, retries, non-idempotent writes, leaked resources, rollback or teardown order, backward-compatibility breaks.

Every adversary works under one rule: **try to break the stated intent and prove it with a command; "no findings" is a valid result.**

## 3. Verify every finding yourself

- Re-run every reported repro command, failing test, or script against the real code (including uncommitted edits).
- Keep a finding only if the observed output demonstrates the failure **and** violates the stated intent.
- Drop weak suspicions. If a plausible risk cannot be run locally (for example, external infrastructure), place it under a separate **Unverified leads** list with the exact check that would confirm it.

## 4. Report

Order confirmed findings by severity:

```text
## Confirmed findings
1. <title> — <impact>
   Location: <file:line>
   Proof: `<command>` -> <observed failing output>

## Unverified leads (only if any)
- <risk> — confirm with: <exact check>
```

If nothing broke, say `No findings` and list the angles tested and commands run.
