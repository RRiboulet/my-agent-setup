---
name: implement-spec
description: "User-invoked /implement-spec (pi: /skill:implement-spec): execute a multi-ticket spec in parallel worktrees by ready frontier."
disable-model-invocation: true
---

# Implement Spec

Execute a dependency-ordered set of tickets against an integration branch using isolated git worktrees for independent frontier tickets.

## 1. Parse the ticket graph

- Read the spec and every ticket in full (local files or the named tracker). If tickets do not exist yet, tell the user to run `/to-tickets` first and stop.
- Build the dependency graph from each ticket's `blocked-by` edges and record each ticket's expected file scope.
- Check for cycles or missing blockers before starting. Confirm the base branch and integration branch name if unclear.

## 2. Prepare the integration branch

- Create a dedicated integration branch from the agreed base branch (never work directly on the default branch).
- Keep shared notes outside the repository if needed; pass workers **context pointers** (spec path, ticket path, commit SHAs) rather than duplicating prose.
- For long runs, load the `show-me-your-work` skill to log integration and scope decisions.

## 3. Compute the ready frontier

- The **frontier** is every unfinished ticket whose blockers are already merged onto the integration branch.
- **Never run two workers in parallel on overlapping files.** If two frontier tickets touch the same files or shared schema, keep one queued until the other merges.
- Respect the harness's sub-agent concurrency limit. If the harness cannot run parallel sub-agents or worktrees, run frontier tickets sequentially on the integration branch.

## 4. Dispatch frontier workers

For each parallelizable frontier ticket, create an isolated git worktree branched from the current integration branch tip and dispatch one worker sub-agent with a self-contained brief containing:

- Spec path, ticket path, acceptance criteria, and the worktree path/branch.
- Explicit instructions to load the `tdd` skill for new behavior (or `diagnosing-bugs` for fixes) and `blast-radius` when crossing boundaries.
- Requirement to run focused checks, commit cleanly on its worktree branch, never push, and stop immediately to report if the spec is wrong or contradictory.

## 5. Merge and re-expand

As each worker finishes:

- Inspect its diff and check output; if it stalled or missed criteria after 1–2 follow-ups, narrow the slice or take over directly.
- Merge the ticket branch into the integration branch, resolve any conflicts cleanly, and re-run affected tests after non-trivial merges.
- Mark the ticket done in its source, remove the temporary worktree and ticket branch, and immediately dispatch newly unblocked frontier tickets.

## 6. Final review and gate

Once every ticket is merged onto the integration branch:

- Load the `review-change` skill (in a fresh-context sub-agent if available) across the full diff against the base branch, and fix accepted findings.
- Load the `prove-it-works` skill to run the repository's full quality gate after the last edit.

## 7. Clean up and report

- Remove any remaining temporary worktrees and scratch branches.
- Report completed tickets, integration branch name, and honest check statuses. Never push or open a PR unless asked. If stopped early, tell the user to run `/handoff`.
