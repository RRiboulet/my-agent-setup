---
name: implement
description: "User-invoked /implement (pi: /skill:implement): build a spec, ticket, ticket set, or plan end to end in small verified units."
disable-model-invocation: true
---

# Implement

Turn an agreed piece of work into a verified change. The input is whatever the user points at: a spec path, a ticket file or folder, an issue reference, or the plan in the conversation.

## 1. Resolve the input

- Read the referenced spec, ticket, or issue in full, including comments. State its title before starting. If the reference is ambiguous, ask.
- For a ticket set, build the dependency graph and work the **frontier**: tickets whose blockers are all done.
  - **pi**: use `/orchestrate` for multi-ticket sets, or delegate single-ticket code edits and tests to `subagent({ role: "coder", ... })` (in `.worktrees/` when isolated).
- Read the code the work touches and the repository's instructions and conventions.

## 2. Confirm the target

- Load the `in-your-own-words` skill unless a spec or ticket already pins down goal, scope, and acceptance criteria.
- If the work is large and has no written contract, suggest `/to-spec` (and `/to-tickets` for several units) before writing code. Proceed only if the user declines.
- If the change crosses a module, service, API, schema, or configuration boundary, load the `blast-radius` skill.

## 3. Plan verifiable units

- Split the work into small units, each ending in a state that can be checked.
- Prefactor first when it makes the change easier, and remove before adding: dead code, stale flags, or redundant paths the change makes obsolete.
- If retries, queues, jobs, migrations, or other repeated operations are involved, load the `idempotent-operations` skill.

## 4. Build each unit

- Any new or changed behavior with a testable seam: build at the seams the spec agreed in the loop below. Load the `tdd` skill when a test needs judging or the seam is unclear; if the loop does not apply, name the exception that skill lists and why.

<!-- tdd-loop:begin - keep this block identical in skills/tdd/SKILL.md and skills/implement/SKILL.md -->
One vertical slice per cycle: one behavior, one test, the minimal code, repeat.

1. **Red.** Write the smallest test for one behavior, with the expected value
   taken from an independent source: the requirement, a worked example, a
   known-good literal.
2. **Watch it fail for the right reason.** If it passes, or fails for an unrelated
   reason such as an import error, fix the test before touching production code.
3. **Green.** Write only enough code to pass. No speculative features.
4. **Widen.** Run the focused test, then the surrounding suite.
5. **Tidy.** Refactor only with tests green, and only what this change needs.
<!-- tdd-loop:end -->

- Delegate non-trivial or multi-file edits and test/lint runs to a `coder` subagent (`subagent({ role: "coder", ... })`) rather than editing or running test suites directly on the parent, unless making a tiny single-file fix within parent limits or using `!direct`.
- A bug, failing test, or unexpected behavior: load the `diagnosing-bugs` skill.
- When the user corrects the same mistake class twice: load the `prevent-recurrence` skill and turn the class into an enforced check before the next unit rather than waiting for another correction.
- Run focused tests and type or lint checks on what changed after each unit. Never start the next unit on red.
- Do not redesign mid-flight. If the spec turns out wrong or incomplete, stop and surface the conflict with a recommendation instead of silently deviating.
- For long or unattended runs, load the `show-me-your-work` skill and log each non-obvious decision as you make it.

## 5. Review

Load the `review-change` skill on the full diff, in an isolated sub-agent with fresh context if the harness and repository review policy call for it. Fix the findings you accept, and list the ones you reject with the reason.

## 6. Prove it

Load the `prove-it-works` skill: run the final gate after the last edit, check the diff, and report evidence against the acceptance criteria.

## 7. Finish

- Commit only if the user asked, on the current branch, with a message that says what changed and why. Load the `commit` skill when present so branch, base, and commit-message rules are verified before staging. Never push, open a PR, or close tickets unless asked.
- For a ticket set, mark the ticket done where its source records status (updating YAML frontmatter and body status, or via the `tickets` extension), and name the next frontier tickets.
- If work stops before completion, suggest `/handoff`.
