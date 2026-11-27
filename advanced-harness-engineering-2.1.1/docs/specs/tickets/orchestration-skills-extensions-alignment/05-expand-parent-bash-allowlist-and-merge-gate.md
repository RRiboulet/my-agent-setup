---
status: done
blocked-by: []
---

# 05: Expand parent read-only bash allowlist and merge gate

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Update parent bash classification in the delegation module so documented
read-only GitHub CLI and git preflight commands work on the parent while
merges pass through the completion gate:

1. Extend `isReadOnlyBashAllowed` to permit safe read-only `gh` inspection
   (`auth status`, `pr view`, `pr list`, `pr checks`, `pr diff`, `pr status`,
   `run list`, `run view`, `issue list`, `issue view`, `release list`,
   `release view`) and safe git preflight (`merge-base`, `describe`, and
   read-only `fetch` without refspec colons, `--force`, or `--prune`).
2. Preserve quote-aware anti-injection validation and continue blocking
   mutating `gh` commands (such as `pr edit`, `pr close`, `pr comment`),
   local branch-mutating git commands (`checkout`, `pull`, `merge`, `tag`),
   refspec/force/prune `fetch`, and general shell commands on the parent.
3. Extend `classifyCommitOrPrCommand` to classify `gh pr merge` alongside
   `git commit`, `git push`, and `gh pr create` so merges are gated by
   `evaluateCompletionGate`, while preserving existing release merge rules
   (including `--merge` without `--delete-branch`).

## Scope
Parent read-only bash allowlist and commit/PR gate classifier in the
delegation module, plus pure-function unit tests. Does not permit local
branch mutations on the parent (those stay delegated to `coder` or explicit
`!direct`).

## Acceptance criteria
- [x] `isReadOnlyBashAllowed` permits safe read-only `gh` inspection and safe
      git `merge-base`, `describe`, and read-only `fetch` preflight commands.
- [x] `isReadOnlyBashAllowed` rejects mutating `gh` commands, `fetch` with
      refspec colons, `--force`, or `--prune`, local branch-mutating git
      commands (`checkout`, `pull`, `merge`, `tag`), and shell-injection
      constructs.
- [x] `classifyCommitOrPrCommand` routes `gh pr merge` through
      `evaluateCompletionGate` alongside `git commit`, `git push`, and
      `gh pr create`.
- [x] Existing release merge constraints (`--merge` without `--delete-branch`)
      remain intact across `github-skill` tests.

## Validation
Unit tests for `isReadOnlyBashAllowed` and `classifyCommitOrPrCommand` cover
all permitted, blocked, and merge-gated cases, and `github-skill` tests pass.
Covers `RB-6`, `RB-7`, and relevant invariants in `RB-11` of the
**Orchestration, Skills, and Extensions Alignment** spec
(`2026-11-26-orchestration-skills-extensions-alignment`).
