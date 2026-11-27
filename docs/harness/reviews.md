# Review Policy and Frontier Review Pipeline

## Single unified frontier review pipeline

All code reviews run on one unified frontier pipeline—either an ad-hoc user-requested review or an automatic/wave-gated review—using the parent's frontier model (`inheritModel: true`, `thinking: "high"`, read-only tools `["read", "grep", "find", "ls", "bash"]`) rather than a separate triage extension or lower-tier candidate list:

- **Ad-hoc user-requested reviews** follow the one-review-on-request policy below (`/review` or one requested `subagent({ role: "reviewer" })` / `security-reviewer` on `pi`). `prove-it-works` is author verification (proving the change and reporting the test that fails on revert); it is not a review and never triggers one.
- **`/review` isolated dispatch (`pi`)**: `/review` (and `/review pr|branch|commit|uncommitted|folder`) preserves target-selection picking, `REVIEW_GUIDELINES.md` lookup, and rubric assembly, then dispatches an isolated `subagent` with `role: "reviewer"` and read-only tools via `orchestrator:subagent-dispatch` without injecting prompts into the parent session or running an inline code-fixing loop. Completion settles via `orchestrator:run-settled`, automatically marking `reviewVerified`.
- **Automatic `reviewer` gate in Pragmatic Orchestrator mode**: when delegation is active (`mode: "enforce"` or `"warn"`, see `docs/harness/extensions.md`), non-doc edits reaching `>= 2` review-relevant files or `>= 50` changed lines arm a `code-review` gate before `git commit`, `git push`, `gh pr create`, `gh pr merge`, or settlement. Satisfy it either directly by inspecting the post-edit diff/files (`git diff`/`git show`/`git status`/`git log`/`gh pr diff` or `read`) and calling `orchestrator_record_review` with verdict `"pass"` or `"accepted_with_notes"`, or by running an isolated `subagent({ role: "reviewer", ... })`, `security-reviewer`, or `/review`. Any subsequent review-eligible edit after `reviewVerified` was set resets `reviewVerified` unconditionally, even if the follow-up edit is below the initial file/line threshold.
- **Wave orchestration (`orchestrator_wave`)**: `wave-ladder.json` defaults `reviewer` to frontier inheritance (`inheritModel: true`, `thinking: "high"`) unless overridden by local ladder config, propagates canonical `role` tags, and integrates wave `reviewer` settlement with delegation's `reviewVerified`.

## One ad-hoc review, only on request

Never start an ad-hoc `/review` automatically because a change seems non-trivial. When the user requests a review, run one isolated review:
1. **`/review`** on `pi` for interactive or targeted reviews (PR, branch, commit, folder, uncommitted); appends `REVIEW_GUIDELINES.md` and dispatches `subagent({ role: "reviewer", ... })`.
2. **A single `reviewer` / `security-reviewer` subagent** on `pi` when invoked directly by task.

Never run multiple reviews for the same change, never launch a second reviewer if the first finds little, and never let a review subagent spawn additional reviewers. If a `show-me-your-work` trail exists, pass it alongside the diff to that single reviewer.
