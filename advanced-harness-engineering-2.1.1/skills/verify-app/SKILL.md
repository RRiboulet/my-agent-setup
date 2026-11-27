---
name: verify-app
description: "User-invoked /verify-app (pi: /skill:verify-app): create or audit a project-local E2E verification skill that drives the real app."
disable-model-invocation: true
---

# Verify App

Create or maintain a repository-local verification skill (`verify-<app>/SKILL.md`) that launches, health-checks, drives, and cleans up the real application.

## Choose the mode

- If the repository has no local `verify-<app>` skill yet, run **Create mode**.
- If one already exists, run **Audit mode**.

## Create mode

### 1. Interview the repo, not the user

Inspect the repository before asking anything:

- App surfaces (UI, HTTP API, CLI, background worker) and real entry points.
- Start command, required env vars, migrations, and seed data.
- Existing drive tools already installed (Playwright, Cypress, HTTP client, CLI/PTY harness).
- Whether two local instances can run side by side safely (ports, DB, lockfiles); if not, document the constraint explicitly.

Ask the user only for decisions or credentials the repo cannot answer.

### 2. Write the local verification skill

Create `<repo-skills-dir>/verify-<app>/SKILL.md` (under `.github/skills/` on Copilot CLI, `.pi/skills/` or `skills/` on `pi`, or `.agents/skills/`) with five tight sections:

- **Launch**: exact start command and a real readiness check (usable app, not just open port; include migrations/seed).
- **Doctor**: one fast, read-only health check confirming the running instance is worth driving before sending actions.
- **Drive**: stable selectors, routes, or CLI invocations exercising real user journeys (never internal state setters or shortcuts). For multi-feature apps, put per-feature recipes in `features/<name>.md` with four sections: sub-features, user entry path, drive steps, and gotchas.
- **Evidence**: what counts as proof — the action, the resulting observable state, and any durable side effects (verify what dry-run modes actually skip).
- **Cleanup**: stop only the PIDs or containers you started (never kill by process name); keep collected evidence intact after teardown.

### 3. Prove it end to end

Run the newly written verification skill once against the real app from Launch through Cleanup. **A verification skill that has not been executed is a draft, not a deliverable.** Fix any gap found during the dry run.

## Audit mode

### 1. Check for source drift

Compare each documented journey and selector against current source code (using parallel read-only sub-agents per feature file if available) to flag moved routes, changed flags, or stale selectors.

### 2. Run a live pass

Run **Doctor**, then exercise every documented feature at least once against the real app while maintaining three invariants:

- Re-run **Doctor** whenever the instance behaves unexpectedly.
- Keep captured evidence after cleanup.
- Leave no background processes or temp state behind.

### 3. Triage and report

Classify every issue found:

- **Doc drift**: fix it in the verification skill.
- **Harness gap**: fix or document the missing drive capability.
- **Product regression**: report as a bug — **never weaken a journey to make it pass**.

Load the `prove-it-works` skill on any edits made to the verification skill, then report the outcome as `clean`, `changed`, or `blocked` with observed evidence.
