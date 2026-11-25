# Review Policy and Triage Candidates

## One review pipeline, only on request

`prove-it-works` is author verification (proving the change and reporting the test that fails on revert); it is not a review and never triggers one. Never start a review automatically because a change seems non-trivial or because `/review` and `/triage` exist.

When the user requests a review, choose one path:
1. **`/review`** for interactive reviews (PR, branch, commit, folder, uncommitted); appends `REVIEW_GUIDELINES.md`.
2. **`triage_change` (or `/triage`) + one subagent** for an automated independent read. Triage only measures the diff and returns a plan — it launches nothing.

Never run both for the same change, never launch a second reviewer if the first finds little, and never let a review subagent spawn additional reviewers. If a `show-me-your-work` trail exists, pass it alongside the diff to that single reviewer.

**Always ask the user before launching a review subagent**, even when triage recommends one. Propose the lens and model, then wait for explicit confirmation.

## Candidate policy and provider bands

Approved review subagent `provider`, `model`, and `thinking` values must come strictly from `candidates` in the active review-triage policy (built-in defaults in `.pi/extensions/review-triage/config.ts`, or `~/.pi/agent/review-triage.json` when present; editable example at `.pi/extensions/review-triage/review-triage.example.json`). Do not invent models outside that list — edit the config if a capability band needs another model.

- All review candidates use `opencode-go`.
- The triage judge uses `opencode` (`jev-1.13-free`, sharing `OPENCODE_API_KEY`).
- Tests fail if candidate providers/costs drift or if the example config diverges from built-in defaults.
- Credentials are checked at runtime (`.pi/extensions/review-triage/credentials.ts`): a missing reviewer provider drops those bands and names the fix in the plan; a missing judge credential short-circuits with `judgeFailure: unavailable`.
