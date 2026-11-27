---
status: done
blocked-by: ["01", "02", "03", "04", "05"]
---

# 06: Align skills, parent delegation prompt, and harness docs

**Blocked by:** 01, 02, 03, 04, 05
**Status:** done

## What to build
Align repository skills, the parent delegation prompt, and harness
documentation with the unified Pragmatic Orchestrator model and confirm every
repository invariant passes end to end:

1. Update the `implement` skill to hand multi-ticket sets to `/orchestrate`,
   delegate single-ticket code edits and tests to `coder`, and remove the
   blanket subagent consent requirement while keeping the `tdd-loop` block
   byte-identical with the `tdd` skill.
2. Add explicit canonical `role` tags to the untagged `subagent` invocations in
   the `grilling` skill, the `recall` skill, and the `worktree` skill's
   parallel reference while keeping `worktree` within its 150-line budget.
3. Add a concise repository-level skill delegation override in harness skills
   documentation and the parent delegation prompt section covering the coding
   and ops skills whose shell or multi-file steps run inside delegated `coder`
   workers rather than on the parent in `enforce` mode.
4. Remove stale references to retired `review-triage` and `goal` extensions
   and reflect the single frontier review pipeline across `AGENTS.md`,
   `README.md`, and harness skills, reviews, and extensions documentation.

## Scope
Targeted updates to `implement`, `grilling`, `recall`, and `worktree` parallel
guidance, parent delegation prompt text, `AGENTS.md`, `README.md`, and harness
skills/reviews/extensions documentation, followed by full-repository invariant
verification. Leaves unrelated pre-existing skills untouched.

## Acceptance criteria
- [x] The `implement` skill routes multi-ticket sets to `/orchestrate`,
      delegates single-ticket implementation and testing to `coder`, drops the
      blanket ask-before-launching-subagent rule, and retains a byte-identical
      `tdd-loop` block matching `tdd`.
- [x] All `subagent` invocations in `grilling`, `recall`, and `worktree`
      parallel guidance specify an explicit canonical `role`.
- [x] Harness skills documentation and the parent delegation prompt include the
      concise repository-level skill delegation override without breaching
      `tdd` byte or `worktree` line limits, description byte/prefix rules, or
      `references` reachability checks.
- [x] `AGENTS.md`, `README.md`, and harness skills, reviews, and extensions
      documentation reflect the single frontier review pipeline and contain
      no stale references to `review-triage` or `goal`.
- [x] All repository test suites and invariant checks (`coding-skills`,
      `github-skill`, `worktree-skill`, `extension-load`, `package-manifest`,
      `skills-index`, `checks-parity`, `rule-table`, `prevent-recurrence`,
      `opencode-go-provider`, `bench`, `mcp-catalogue`, and `branch-base`) pass.

## Validation
Run the complete `AGENTS.md` test and parity verification suite (subagent test
suite, `opencode-go-provider` tests, `prevent-recurrence` tests and rule-table
check, `skills-index` check, and tools `bench`, `mcp-catalogue`, and
`branch-base` checks/tests) and confirm zero failures or regressions. Covers
`RB-8`, `RB-9`, `RB-10`, and `RB-11` of the **Orchestration, Skills, and
Extensions Alignment** spec
(`2026-11-26-orchestration-skills-extensions-alignment`).
