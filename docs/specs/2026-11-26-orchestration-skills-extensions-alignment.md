# Orchestration, Skills, and Extensions Alignment

## Objective

Unify the harness around a single Pragmatic Orchestrator execution and review
model so that wave orchestration, parent-enforced delegation, standalone review
and goal extensions, parent bash gating, and repository skills reinforce each
other without duplicate review pipelines, conflicting settlement hooks, blocked
GitHub/git workflows, or contradictory skill instructions.

Retiring overlapping extensions (`review-triage`, `goal`), rewiring `/review` to
dispatch an isolated frontier `reviewer` subagent, coordinating wave and
delegation gates, expanding the parent read-only/merge command classifiers, and
aligning skills and docs eliminates context bloat and contradictory rules while
preserving all repository invariants.

## Current behavior

Seven verified conditions exist in the repository and active delegation branch
today:

1. **Wave reviewer tier diverges from Pragmatic Orchestrator.**
   `.pi/extensions/orchestrator/wave-ladder.json` pins `reviewer` to Tier 2
   (`opencode-go/deepseek-v4.1-flash`), whereas
   `.pi/extensions/orchestrator/delegation.ts` (`DEFAULT_ROLES.reviewer`) uses
   `inheritModel: true` (frontier parent model, `thinking: "high"`).
2. **Wave and delegation commit/settlement gates are disconnected.**
   `wave-runtime.ts` (`canRunGitCommit`) and `delegation-runtime.ts`
   (`evaluateCompletionGate`) register separate `tool_call` commit gates
   without sharing state; `recordChildSettled` only sets `reviewVerified = true`
   when a completed subagent has `role` in `{"reviewer", "security-reviewer"}`
   and `startedAt >= lastReviewEditAt`.
3. **`review-triage` duplicates the delegation review gate with a non-frontier ceiling.**
   `.pi/extensions/review-triage/` (~5.3k LOC plus ~4k LOC tests) uses Jev
   (`opencode/jev-1.13-free`) and candidates capped at
   `opencode-go/glm-5.3-flash` (`.devcontainer/pi/review-triage.json`),
   duplicating the delegation review trigger (`>=2` files or `>=50` lines) with
   a weaker ceiling. `.pi/extensions/orchestrator/advisor.ts` imports
   `authSourceFromRegistry` and `credentialFix` from
   `../review-triage/credentials.ts`, and `.devcontainer/postCreate.sh`
   installs and validates `review-triage.json`.
4. **`/review` executes inline in the parent context.**
   `.pi/extensions/review.ts` (2.1k LOC) injects `/review` prompts directly into
   the parent session via `pi.sendUserMessage(fullPrompt)`, consuming parent
   context and never marking `reviewVerified`.
5. **`goal` hooks settlement independently and leaks into orchestrator and tests.**
   `.pi/extensions/goal.ts` (1k LOC) hooks `agent_before_settle` with
   `continue: true` (last-writer-wins over the orchestrator gate), re-looping
   the frontier parent without delegation or wave awareness.
   `.pi/extensions/orchestrator/index.ts` imports `activeGoalFromBranch` from
   `../goal.ts`, and `worktree-skill.test.ts` asserts the literal conflict
   string `Tool "get_goal" conflicts with`.
6. **Parent bash allowlist and PR gate block documented `gh` and git-preflight workflows.**
   `isReadOnlyBashAllowed` in `delegation.ts` allows only `ls`, `wc`, and
   `git status|diff|log|show|rev-parse|branch` (read-only flags) piped to
   `head|tail|wc|cat`, and `classifyCommitOrPrCommand` recognizes only
   `git commit`, `git push`, and `gh pr create`. This blocks `AGENTS.md`'s
   PR/release flow (`gh pr merge`, `gh pr checks`, `gh pr view`,
   `gh run list/view`, `gh auth status`), `commit`'s preflight
   (`git fetch origin`, `git merge-base --is-ancestor dev HEAD`), and
   `update-changelog`'s `git describe --tags --abbrev=0` and `gh pr list`.
7. **Skills instruct parent-local mutation or omit `role` tags.**
   `.pi/skills/implement/SKILL.md` walks ticket frontiers manually (duplicating
   `/orchestrate`), prescribes direct parent edits and tests, and states
   `"Parallel sub-agents only on request, and ask before launching one."` Three
   skill locations (`grilling/SKILL.md`, `recall/SKILL.md`,
   `worktree/references/parallel.md`) invoke `subagent` without a `role`.
   Sixteen coding and ops skills describe shell or multi-file actions that are
   blocked on the parent in `enforce` mode.

## Required behavior

- **RB-1: Unified frontier review policy and role propagation in wave dispatch.**
  Align wave's default `reviewer` pin with Pragmatic Orchestrator's frontier
  `reviewer` role (`inheritModel: true`, `thinking: "high"`) unless explicitly
  overridden by local ladder config. Propagate canonical `role` tags in wave
  dispatch plans and kickoff instructions so subagents run with declared roles.

- **RB-2: Coordinated wave and delegation commit/settlement gates.**
  Coordinate wave `ready_to_commit` with delegation's commit and settlement gate
  (`evaluateCompletionGate`) so an active wave ticket in `ready_to_commit` is
  recognized by the delegation gate, wave `reviewer` subagent completions
  satisfy `reviewVerified`, and a verified wave ticket is never double-blocked
  on commit or settlement.

- **RB-3: Retire `review-triage` extension cleanly.**
  Remove the `review-triage` extension, its devcontainer configuration and
  `postCreate.sh` installation/validation, the `orchestrator:triage-planned`
  event bus contract, and all manifest, `README.md`, documentation, and
  `review-triage*.test.ts` references. Relocate `authSourceFromRegistry` and
  `credentialFix` so `advisor` continues working without `review-triage`.

- **RB-4: Rewire `/review` to dispatch an isolated `subagent` with `role: "reviewer"`.**
  Preserve the `/review` user-facing command, target-selection picker,
  `REVIEW_GUIDELINES.md` lookup, and review rubric assembly, but replace inline
  `sendUserMessage` execution with dispatching an isolated `subagent` using
  `role: "reviewer"` (frontier inherited model, read-only tools). Ensure
  completion flows through normal `orchestrator:run-settled` settlement events
  so `reviewVerified` is marked automatically without consuming parent context.

- **RB-5: Retire `goal` extension cleanly.**
  Remove `goal.ts`, its `package.json` manifest entry, `README.md` and harness
  doc references, and `goal`-specific tests. Decouple `activeGoalFromBranch`
  from `orchestrator` settlement and context assembly, and update the worktree
  duplicate-tool conflict documentation and `worktree-skill.test.ts` assertion
  from `get_goal` to a live tool such as `todo` or `subagent`.

- **RB-6: Expand parent read-only bash allowlist for safe `gh` and git preflight.**
  Extend `isReadOnlyBashAllowed` to permit safe read-only `gh` inspection
  (`auth status`, `pr view|list|checks|diff|status`, `run list|view`,
  `issue list|view`, `release list|view`) and safe git preflight (`merge-base`,
  `describe`, and read-only `fetch` without refspec `:` or `--force`/`--prune`).
  Preserve quote-aware anti-injection validation and reject mutating `gh`
  commands, arbitrary `git checkout`/`pull`, and general shell commands on the
  parent.

- **RB-7: Gate `gh pr merge` through the commit/PR completion gate.**
  Extend `classifyCommitOrPrCommand` to recognize `gh pr merge` alongside
  `git commit`, `git push`, and `gh pr create`, enforcing
  `evaluateCompletionGate` before merging. Preserve existing release merge
  rules (including `--merge` without `--delete-branch`).

- **RB-8: Align `implement` skill with `/orchestrate` and Pragmatic Orchestrator.**
  Update `.pi/skills/implement/SKILL.md` to route multi-ticket sets to
  `/orchestrate`, delegate single-ticket code edits and tests to `coder`, and
  remove the blanket `"ask before launching a sub-agent"` rule, while keeping
  `tdd-loop` byte-identical with `tdd`.

- **RB-9: Add canonical `role` tags to all skill `subagent` invocations.**
  Add explicit canonical `role` arguments to the three untagged `subagent` call
  sites (`grilling/SKILL.md`, `recall/SKILL.md`, and
  `worktree/references/parallel.md`).

- **RB-10: Document repository-level skill delegation override and single frontier review pipeline.**
  Add a concise repository-level delegation override in harness skills
  documentation and the parent delegation prompt section covering the 16 coding
  and ops skills that reference shell or multi-file actions. Update `AGENTS.md`,
  `docs/harness/skills.md`, `docs/harness/reviews.md`, and
  `docs/harness/extensions.md` to reflect the single frontier review pipeline
  and retired extensions.

- **RB-11: Preserve all automated repository invariants.**
  Keep `package.json` manifest entries, `README.md` skills and extensions
  indexes, `AGENTS.md` rule table and CI checks parity, `coding-skills.test.ts`
  byte/line limits and `tdd-loop` parity, `github-skill.test.ts`,
  `worktree-skill.test.ts`, and strict-ESM `extension-load.test.ts` all green.

## Non-goals

- Redesigning the Pragmatic Orchestrator delegation role catalog or replacing
  the parent-enforced delegation mechanism established in the base branch.
- Allowing local branch-mutating git commands (`git checkout`, `git pull`,
  `git merge --ff-only`, `git tag`) on the parent read-only bash allowlist; those
  remain delegated to `coder` or executed explicitly via `!direct`.
- Retiring `advisor`; it remains active using the relocated credential helper.
- Adding new complexity tiers or changing Jev triage behavior inside
  `/orchestrate`.
- Changing unrelated pre-existing skills outside `implement`, the three
  untagged `subagent` skills, and the repository-level delegation override.

## Constraints

- **`coding-skills.test.ts` contracts:** `tdd-loop` must remain byte-identical
  between `tdd` and `implement`; `tdd/SKILL.md` must stay at or below 3000
  bytes; `worktree/SKILL.md` must stay at or below 150 lines (currently 147,
  leaving 3 lines of headroom); model-invoked skill descriptions must be at most
  250 bytes and contain `"Use when:"`; user-invoked skill descriptions must be
  at most 150 bytes and start with `"User-invoked /skill:<name>: "`; skill
  descriptions must contain no cross-skill name mentions; every
  `references/*.md` file must be reachable from `SKILL.md`.
- **`worktree-skill.test.ts` string pins:** Specific strings in `worktree`
  documentation are pinned by tests (including the duplicate-tool conflict
  phrase, which must be updated in lockstep with the documentation when retiring
  `goal`).
- **`github-skill.test.ts` release rule:** Release merges without
  `--delete-branch` are enforced across both `github/SKILL.md` and `AGENTS.md`.
- **Strict ESM and manifest parity:** All extensions must satisfy
  zero-side-effect strict ESM loading (`extension-load.test.ts`), and
  `package.json` must remain in parity with `README.md` and `AGENTS.md`
  (`package-manifest.test.ts`, `skills-index.test.ts`, `checks-parity.test.ts`).
- **Worker inertness and reservations:** Delegated worker inertness
  (`PI_ORCHESTRATOR_ROLE=worker`) must be preserved for both delegation and
  wave runtimes, while workspace reservations intentionally remain active for
  workers.
- **Base branch layering:** Changes must layer cleanly on top of the
  in-progress Pragmatic Orchestrator delegation branch in
  `/home/dev/worktrees/advanced-harness-engineering`.

## Design decisions

1. **Retire `review-triage` rather than keeping it as an optional fallback.**
   Maintaining two independent change-review triggers creates divergent thresholds,
   duplicated credential plumbing, and non-frontier review conclusions that do
   not satisfy the delegation completion gate. Relocating the small credential
   lookup utility into the orchestrator module preserves the advisor's ability
   to report credential sources without retaining five thousand lines of triage
   state machine. Rejected alternative: gating `review-triage` behind a config
   flag, which would preserve dead maintenance surface and devcontainer drift.

2. **Rewire `/review` to dispatch an isolated `reviewer` subagent.**
   The existing review command already owns valuable interactive target
   selection, guideline discovery, and prompt construction, but sending that
   prompt into the parent conversation pollutes parent context and bypasses the
   orchestrator's settlement accounting. Turning the review command into a thin
   caller that dispatches the canonical `reviewer` subagent role keeps the user
   experience intact while letting normal settlement events mark review
   verification automatically. Rejected alternative: duplicating the review
   verification bookkeeping inside the standalone review extension, which would
   couple it directly to internal delegation state.

3. **Retire `goal` instead of stacking settlement hooks.**
   A standalone extension registering an independent settle hook creates a
   last-writer-wins conflict against the orchestrator's completion gate and
   encourages parent-side looping unaware of active subagents or wave tickets.
   Removing the extension and severing the orchestrator's branch-goal helper
   eliminates competing settlement authorities. Updating the worktree
   duplicate-tool conflict example and test expectation to reference an active
   built-in tool keeps the documentation truthful without losing test coverage.
   Rejected alternative: teaching `goal` to inspect delegation state, which adds
   cross-extension coupling for an unmaintained workflow.

4. **Align wave `reviewer` to frontier inheritance and propagate `role` metadata.**
   Using the inherited frontier model by default in the wave ladder ensures
   ticket reviews meet the same quality floor as ad-hoc delegation reviews while
   still respecting explicit local ladder overrides when configured. Propagating
   canonical `role` values in wave dispatch plans and kickoff prompts guarantees
   that worker completions emit role-attributed settlement records. Rejected
   alternative: hardcoding a specific model identifier in the wave ladder, which
   would drift whenever the session's frontier parent model changes.

5. **Share explicit readiness state between wave runtime and delegation gate.**
   Rather than merging the two runtimes into a single monolithic state store,
   the wave runtime exposes whether the current commit corresponds to a wave
   ticket already in `ready_to_commit`, and records wave `reviewer` completions
   through the shared settlement pathway so `reviewVerified` transitions
   consistently. When a wave ticket is verified and ready to commit, the
   delegation gate defers rather than double-blocking. Rejected alternative:
   bypassing the delegation gate globally whenever any wave is active, which
   would weaken enforcement for non-wave parent mutations.

6. **Use a tight prefix-and-flag parser for parent read-only bash and merge gating.**
   Extending the parent allowlist via explicit subcommand and flag rules for
   read-only GitHub CLI inspection and read-only git preflight (specifically
   forbidding refspec colons, force flags, and pruning on fetch) keeps the
   parent capable of verifying PR status, CI checks, tags, and branch ancestry
   without relaxing shell-injection defenses or permitting local branch edits.
   Classifying `gh pr merge` in the commit-and-PR gate applies the same
   pre-landing verification discipline to merges as to pushes and PR creation.
   Rejected alternative: whitelisting all `gh` or `git` subcommands and relying
   only on blocklists, which risks bypassing mutating operations through flags
   or aliases.

7. **Resolve skill conflicts via a single repository-level override plus targeted edits.**
   Sixteen skills mention shell execution or multi-file edits that remain valid
   inside delegated `coder` workers even when blocked on the parent in enforce
   mode. Adding a concise repository-level delegation override in the skills
   reference and parent delegation prompt preserves skill readability without
   rewriting sixteen stable files or bloating tight byte and line budgets. Only
   `implement` (which directly contradicted delegation and `/orchestrate`) and
   the three untagged subagent callers receive direct edits. Rejected
   alternative: rewriting all sixteen skills individually, which would create
   widespread churn and risk breaking byte-capped skill contracts.

## Test seams

- **Wave and delegation gate coordination:** Unit tests invoking the wave
  runtime commit check and delegation `evaluateCompletionGate` across states
  (`ready_to_commit` vs. unverified edits, `reviewer` wave subagent settlement
  setting `reviewVerified`, and `gh pr merge` gate enforcement).
- **Parent bash classifier:** Pure-function unit tests for
  `isReadOnlyBashAllowed` and `classifyCommitOrPrCommand` covering allowed
  read-only `gh` commands, safe `git merge-base`/`describe`/`fetch` forms,
  rejected mutating flags (`fetch origin main:dev`, `--force`, `--prune`,
  `gh pr edit/close/comment`), and `gh pr merge` gating.
- **`/review` subagent dispatch:** Extension tests verifying target selection
  and prompt assembly dispatch a `subagent` with `role: "reviewer"` without
  calling `pi.sendUserMessage`, and settle through `orchestrator:run-settled`
  to mark `reviewVerified`.
- **Relocated credential helper & retirement cleanup:** Tests verifying
  `advisor` resolves credentials via the relocated helper, `extension-load.test.ts`
  verifying strict-ESM loading of remaining extensions with `goal` and
  `review-triage` absent, and manifest/index parity checks (`package-manifest.test.ts`,
  `skills-index.test.ts`, `checks-parity.test.ts`).
- **Skills invariants:** `coding-skills.test.ts` (byte/line limits, `tdd-loop`
  byte parity, description rules, `references/*.md` reachability),
  `worktree-skill.test.ts` (updated live-tool conflict string), and
  `github-skill.test.ts` (release merge without `--delete-branch`).

## Acceptance criteria

- [ ] Wave's default `reviewer` configuration uses `inheritModel: true` and `thinking: "high"`, and wave dispatch plans/instructions include canonical `role` tags. (`RB-1`)
- [ ] Wave tickets in `ready_to_commit` and wave `reviewer` settlements integrate with delegation's `reviewVerified` and `evaluateCompletionGate` with zero spurious double-blocks. (`RB-2`)
- [ ] `review-triage` extension directory, devcontainer config/validation, `orchestrator:triage-planned` event, and all manifest/doc/test references are removed, while `advisor` continues resolving credentials via the relocated helper. (`RB-3`)
- [ ] `/review` preserves target selection and guideline/rubric assembly, dispatches an isolated `subagent` with `role: "reviewer"`, stops calling `sendUserMessage`, and marks `reviewVerified` on settlement. (`RB-4`)
- [ ] `goal.ts`, its manifest/README/doc/test references, and `activeGoalFromBranch` coupling in `orchestrator` are removed; worktree duplicate-tool conflict doc and `worktree-skill.test.ts` cite a live tool. (`RB-5`)
- [ ] `isReadOnlyBashAllowed` permits safe `gh` read-only commands and safe `git merge-base`/`describe`/`fetch` preflight while rejecting mutating `gh`, refspec/force/prune `fetch`, arbitrary `git checkout`/`pull`, and general shell commands. (`RB-6`)
- [ ] `classifyCommitOrPrCommand` classifies `gh pr merge` through `evaluateCompletionGate` while preserving `--merge` without `--delete-branch` release rules. (`RB-7`)
- [ ] `.pi/skills/implement/SKILL.md` routes multi-ticket sets to `/orchestrate`, delegates single-ticket edits/tests to `coder`, drops the blanket `"ask before launching a sub-agent"` rule, and maintains byte-identical `tdd-loop` parity with `tdd`. (`RB-8`)
- [ ] `grilling/SKILL.md`, `recall/SKILL.md`, and `worktree/references/parallel.md` specify canonical `role` tags on all `subagent` invocations. (`RB-9`)
- [ ] Repository-level skill delegation override and single frontier review pipeline documentation are updated across `AGENTS.md`, `docs/harness/skills.md`, `docs/harness/reviews.md`, `docs/harness/extensions.md`, and the parent delegation prompt section. (`RB-10`)
- [ ] Full repository test and invariant suite passes cleanly with zero manifest, index, parity, strict-ESM, or skill-budget regressions. (`RB-11`)

## Verification

Run the complete `AGENTS.md` `## Tests` verification suite in
`/home/dev/worktrees/advanced-harness-engineering`:

```bash
bash .pi/extensions/subagent/test/setup-deps.sh
node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts
(cd .pi/extensions/opencode-go-provider && node --test)
node --test .pi/skills/prevent-recurrence/scripts/test/*.test.mjs
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
node tools/skills-index.mjs --check
node --test tools/bench/run.test.mjs
node --test tools/mcp-catalogue.test.mjs
node --test tools/branch-base.test.mjs
node tools/branch-base.mjs
```

## Open assumptions

1. **`review.ts` optional "loop fixing" mode:** Assumed dropped or delegated to
   `coder` + `reviewer` rather than mutating code from the parent; confirm
   before implementing `/review` rewiring.
2. **Post-merge local branch mutations and release tagging:**
   `git checkout dev && git pull --ff-only`, `git tag`, and
   `git merge --ff-only` in `AGENTS.md` are assumed to stay off the parent
   read-only allowlist (run via `coder` or `!direct`), keeping parent
   local-branch mutation disallowed.
3. **`advisor.ts` retention:** Assumed retained and powered by the relocated
   credential helper rather than retired in this pass.
4. **Base branch state:** In-progress Pragmatic Orchestrator delegation changes
   in `advanced-harness-engineering` are assumed committed/landed as the base before
   implementing tickets derived from this spec.
