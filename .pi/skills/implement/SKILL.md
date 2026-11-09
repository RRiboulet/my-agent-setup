---
name: implement
description: "Implement a spec, ticket, ticket set, or agreed plan end to end: play back the goal, build in small verified units, prove the result, and stop there unless a review was asked for."
disable-model-invocation: true
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Implement

Turn an agreed piece of work into a verified change. The input is whatever the user points at: a spec path, a ticket file or folder, an issue reference, or the plan in the conversation.

## 1. Resolve the input

- Read the referenced spec, ticket, or issue in full, including comments. State its title before starting. If the reference is ambiguous, ask.
- For a ticket set, build the dependency graph and work the **frontier**: tickets whose blockers are all done. Take one ticket at a time unless the user asks for parallel work and the harness can run sub-agents in isolated worktrees.
- Read the code the work touches and the repository's instructions and conventions.

In this repository, "isolated worktrees" means `git worktree` under the
gitignored `.worktrees/` directory at the root, as the `worktree` skill
prescribes. Parallel sub-agents only on request, and ask before launching one.

## 2. Confirm the target

- Load the `in-your-own-words` skill unless a spec or ticket already pins down goal, scope, and acceptance criteria.
- If the work is large and has no written contract, suggest `/skill:to-spec` (and `/skill:to-tickets` for several units) before writing code. Proceed only if the user declines.
- If the change crosses a module, service, API, schema, or configuration boundary, load the `blast-radius` skill.

## 3. Plan verifiable units

- Split the work into small units, each ending in a state that can be checked.
- Prefactor first when it makes the change easier, and remove before adding: dead code, stale flags, or redundant paths the change makes obsolete.
- If retries, queues, jobs, migrations, or other repeated operations are involved, load the `idempotent-operations` skill.

## 4. Build each unit

- New or changed behavior with a testable seam: load the `tdd` skill and build at the seams the spec agreed.
- A bug, failing test, or unexpected behavior: load the `diagnosing-bugs` skill.
- Run focused tests and type or lint checks on what changed after each unit. Never start the next unit on red.
- Do not redesign mid-flight. If the spec turns out wrong or incomplete, stop and surface the conflict with a recommendation instead of silently deviating.
- For long or unattended runs, load the `show-me-your-work` skill and log each non-obvious decision as you make it.

## 5. Prove it

Load the `prove-it-works` skill: run the final gate after the last edit, check the
diff, and report evidence against the acceptance criteria.

## 6. Finish

- Do not commission a review. Finishing this skill means the change is built and proven, not reviewed; the author's own diff check in `prove-it-works` is the last step.
- If the user asks for a review, it is **one** review through one door: `/review` when they want to drive it, otherwise `/triage` and, after their approval, one sub-agent with the profile it names. Both follow `REVIEW_GUIDELINES.md`.
- Commit only if the user asked, on the current branch, with a message that says what changed and why. Never push, open a PR, or close tickets unless asked. In this repository, load the `commit` skill instead of improvising: it checks the branch and its base against `dev` before staging, which this skill does not.
- For a ticket set, mark the ticket done in the way its source records status, and name the next frontier tickets.
- If work stops before completion, suggest `/skill:handoff`.
