# Changelog

Versions are git tags. This repository is not published to npm.

Older releases are read from their tags with `git show vX.Y.Z:CHANGELOG.md` and are not kept in this file.

## Unreleased

## v2.1.2 — 2026-11-27

Fixed:

- **CI and the devcontainer install the pinned pi release the `btw` mirror
  targets instead of `@latest` (`.github/workflows/checks.yml`,
  `.devcontainer/Dockerfile`).** pi 1.7.0 changed `client-identity.js`
  (attribution became unconditional and `isInstallTelemetryEnabled` is gone),
  so the "mirrored pi internals have not drifted" gate went red on `@latest`
  while the mirror still matches 1.6.1. `@earendil-works/pi-coding-agent@1.6.1`
  pins its sibling packages exactly, so the pin cannot produce the mixed
  family of issue #52; moving the pin and refreshing the mirror is one change.
## v2.1.1 — 2026-11-27

Changed:

- **Promoted the vendored `advanced-harness-engineering-2.1.1` snapshot to the
  repository root and removed the vendored folder.** The root now carries the
  2.1.1 harness directly: 32 skills in `skills/` (wired through
  `.pi/settings.json` instead of `.pi/skills/`), the updated `.pi/extensions/`
  (`goal` and `review-triage` retired; orchestrator delegation runtime added),
  and the new `scripts/`, `bin/`, `docs/`, and `.agent/` layout. Kept the `pi`
  half only: dropped the Copilot CLI subsystems (`extensions/` tickets+jira,
  `agents/`, `hooks/`, `orchestrator_guard/`, `.claude-plugin/`) and their
  installer, test, CI, and doc wiring, keeping `instructions/AGENTS.md` for the
  `pi` install path. Rewrote the internal-host URLs and the package name to
  this repository (`my-agent-setup`) and adopted this changelog file; the old
  root history stays reachable through git history and its tags.

Fixed:

- **Actionable, role-accurate read-only `bash` block messages and single-command
  delegation guidance (`.pi/extensions/orchestrator/delegation.ts`,
  `delegation-runtime.ts`).** Replaced the generic `coder` redirect on blocked
  parent `bash` commands with `explainReadOnlyBashBlock`, distinguishing
  disallowed shell constructs (chaining, subshells, redirections, newlines) and
  mutating flags from mutating commands so compound or piped read-only
  discovery routes to `explore` instead of `coder`, and added explicit
  single-command guidance in `formatDelegationSection`.

- **Tightened `subagent` and `subagent_*` tool descriptions and schemas to fit
  `codemode`'s 3,000-token inline catalog budget
  (`.pi/extensions/subagent/index.ts`, `codemode-catalog.test.ts`).** Reduced
  `subagent` from 1,531 to 309 tokens alongside slimmer `subagent_*` tool
  descriptions, parameter schemas, and guidelines so `subagent` stays inside
  the default 3,000-token `codemode` inline catalog budget under
  `mode: "only"`, verified by `codemode-catalog.test.ts` regression coverage.

## v2.1.0 — 2026-11-27

Added:

- **Pi orchestration parity and token-efficiency upgrades across
  `.pi/extensions/orchestrator/` and `.pi/extensions/subagent/` (`#2`).**
  Mandatory `role` and `handoff: "fork"` gating now runs in `enforce` mode (with
  resilient sibling patching in `tasks[]` fan-outs under `warn`/`off`) so
  delegated runs cannot accidentally fork bloated parent context or bypass
  role-to-model routing. Workers launch with stripped cold-cache startup flags
  (`--no-extensions --no-skills --no-mcp --no-prompt-templates --no-themes`), a
  `PI_SUBAGENT_WORKER_EXTENSIONS` allowlist that preserves scheme specifiers
  (`builtin:`/`npm:`/`git:`/`http:`), `opencode-go` auto-inclusion, and
  per-task `skills[]` opt-in to eliminate unneeded startup prompt and tool
  overhead. Settled `subagent_wait` and `subagent_status` calls default to
  compact report-first summaries with explicit `includeOutput` and
  `includePane` opt-ins so waiting on workers does not flood the parent
  context.

- **Full Pragmatic Orchestrator persona, `codemode` runtime parity, and
  main-model review gate (`#2`).** Parent sessions receive the full Pragmatic
  Orchestrator persona with per-mode directives and branch-persisted parent
  `write` hiding across `/resume`, `/reload`, and `/tree`.
  `orchestrator_record_review` (parent-only, `codemode`-reachable) records
  direct main-model reviews alongside isolated `/review` dispatches, and
  subsequent review-eligible edits unconditionally reset `reviewVerified` so
  stale sign-offs cannot carry forward. Dedicated
  `orchestrator-delegation-runtime.test.ts` coverage verifies nested `codemode`
  (`parentToolCallId`) hook parity, validated `subagent_answer` steer-unlock,
  and live-worker settlement coordination.

- **Sanitized local Pi setup templates and symlinked ticket-set discovery
  (`#2`).** Added provider-agnostic local Pi setup documentation and example
  templates (`docs/harness/pi-local-setup.md`, `docs/harness/examples/*.json`),
  and updated `extensions/tickets/store.mjs` to discover symlinked ticket sets
  and files with canonical `realpath` deduplication and symlink-preserving
  atomic writes so shared ticket folders work across checkouts without losing
  links.

Performance:

- **Copilot CLI `orchestrator_guard` hook latency reduced by ~45–48% (`#1`).**
  Added `matcher` regex filtering on `preToolUse` and `postToolUse` to skip
  hook spawns for unguarded tools, switched hook invocation to `python3 -S`,
  replaced `@dataclass` on hot state objects with `__slots__` and lazy stdlib
  imports, and switched to dirty-checked compact JSON state writes without
  `os.fsync` plus terminal subagent pruning. `review_dirty_lines` now uses net
  diff (`git diff --no-renames --numstat HEAD` plus untracked files) and disarms
  `review_required` whenever the net diff drops back below threshold.

## v2.0.0 — 2026-11-26

Removed:

- **`/voice` (`.pi/extensions/voice/`), and everything that existed only to
  keep it running.** The dictation extension recorded audio on a phone over
  ssh, fetched the m4a back, and transcribed it through an OpenAI-compatible
  endpoint; it was the repo's only consumer of the phone, of the private-volume
  ssh key pair and `voice.json` that `.devcontainer/restore-post-rebuild.sh`
  re-created after every container rebuild, and of the `PI_VOICE_API_KEY`
  remap in `devcontainer.json`. Gone with it: the extension tree, its
  `voice.test.ts`, `.devcontainer/voice-container.md`, the restore script and
  its step in `postCreateCommand`, the `PI_VOICE_API_KEY` line, the `voice.json`
  entry in `bin/pi-agent-dir`'s copy list, the phone row and fact in the
  `devcontainer` skill, and the README's Voice section, manifest entry and
  Termux requirement. Nothing else references the chain; the last thing that
  ever pointed at it is this entry.

- **`/session-breakdown` (`.pi/extensions/session-breakdown.ts`), with its
  tests.** The vendored analytics extension is out of the `pi` manifest, the
  strict-ESM load guard and the test README. `tools/measure-session-usage.mjs`
  stays: it is an independent, read-only aggregator over the session trees,
  not part of the extension — its header now says so instead of naming a
  removed CHANGELOG entry — because the subagent fixture-trees gap it measures
  is a property of the transcript layout, not of the extension that once
  displayed it. The four LOCAL PATCH hunks and their reasoning stay reachable
  through git history and the entries below.

- **Docs swept for both removals.** Every stale reference in the living docs is
  gone: the manifest example, the duplicate-load silent list, the contents
  table, the advisor's accounting sentence and the requirements in the
  README; the dated research and ticket docs keep their history but carry a
  status note where they still asked for session-breakdown work, so no open
  ticket points at an extension that no longer exists.

- **Retired `review-triage` and `goal.ts` (`RB-1`–`RB-11`).** Removed the
  `.pi/extensions/review-triage/` extension, its tests, its event hooks, and
  `.devcontainer/pi/review-triage.json`, relocating credential lookup to
  `.pi/extensions/orchestrator/credentials.ts` for `advisor.ts`. Retired
  `.pi/extensions/goal.ts` and `goal.test.ts`, and decoupled the orchestrator
  from `activeGoalFromBranch`.

Added:

- **`/orchestrate <folder>`, and the `orchestrator_wave` tool, inside the
  orchestrator extension.** A to-tickets folder runs through tiered
  subagent waves: every ticket is triaged by a decision model into a
  complexity tier, dispatched at a `(model, thinking)` pair read from
  `wave-ladder.json`, reviewed by a frontier reviewer gate before it may commit,
  escalated on repeated failure or a crashed run, and committed serially by
  the orchestrator only after verification (with `record_commit` verifying
  the commit SHA before it is recorded). The ladder reader fails open — a
  malformed ladder falls back to the built-in reviewer gate rather than
  killing the wave — and the ticket-graph parser refuses cycles and dangling
  blockers, computes the frontier by tier precedence, and writes each
  ticket's status back byte-exactly so a status update cannot create
  spurious diffs. An active wave now blocks settlement: a `wave` gate
  condition reports unfinished tickets at settle time, blocking by default
  (`gate.block.wave` defaults to `true`, so an in-flight wave can be
  overridden with `orchestrator_override` but never silently orphaned). The
  advisory orchestrate skill that started as `.pi/skills/orchestrate` (#237)
  was folded into the extension, so the ladder, the parser, and the gates
  live where they are enforced, and four new wave test suites (ladder,
  tickets, wave, runtime) pin the state machine.

- **The wave's tier roster is live, and the orchestrator inherits the
  session's model (#238).** Tier 3 dispatches `mistral/zai-glm-5-3-flash`;
  tiers 1 and 2 stay `opencode-go/hy4-flash-free` and
  `opencode-go/deepseek-v4.1-flash`, and triage stays pinned to
  `opencode/jev-1.13-free` through the classifier channel. `MISTRAL_API_KEY`
  is forwarded to the container so tier 3 can actually run — a live probe
  of the tier-3 model returned `OK`. The parent or orchestrator inherits the
  harness's current session model, and the container settings no longer
  hardcode `defaultProvider` or `defaultModel`: the model-selection contract
  is documented in the extension instead, and a mutation proof pins the
  no-hardcoded-default guard.

- **Unified frontier review pipeline and Pragmatic Orchestrator alignment
  (`RB-1`–`RB-11`).**
  - Wave `reviewer` defaults to frontier inheritance (`inheritModel: true`,
    `thinking: "high"`), canonical `role` tags propagate across subagent
    launches, and wave active / timestamped `ready_to_commit` state
    coordinates with delegation commit and settle gates.
  - `/review` is rewired to dispatch an isolated `subagent({ role: "reviewer" })`
    via `orchestrator:subagent-dispatch`, dropping inline `sendUserMessage`
    and loop-fixing mode.
  - Parent read-only bash allowlist is expanded for `gh` inspection,
    `git merge-base`, `git describe`, and strict-allowlist `git fetch`, while
    `gh pr merge` is gated through `evaluateCompletionGate`.

Fixed:

- **The devcontainer recovers Pi state left dangling by the retired shared-state
  layout.** A private volume from that experiment still had `auth.json`,
  `models-store.json` and `models.json` symlinks pointing at `/shared-pi-state`,
  a mount that no longer exists. Pi followed those links and failed with `ENOENT`
  when even a model listing tried to read credentials; model-catalog refresh
  failed for the same reason. `postCreate.sh` now removes only dangling links to
  that exact retired location, creates mode-`600` local JSON stores when absent,
  and leaves existing credential contents untouched. Live user-managed store
  symlinks are preserved with a warning rather than making the rest of container
  setup fail. Provider credentials still come from the host environment rather
  than being copied into the volume. The container forwarding allowlist now
  includes Gemini alongside Mistral, so a
  provider key present only in the host environment is not silently omitted.

- **Subagent launches validate explicit model overrides before the child
  exists.** `--provider`, `--model` and `PI_SUBAGENT_*` overrides are checked
  against `modelRegistry` — the model must exist and its provider must have
  credentials configured — so a misspelled override fails the launch locally
  with a nameable cause instead of spawning a child that dies on its first
  model call. `tmux` subprocess calls are bounded by a 5-second
  `TMUX_EXEC_TIMEOUT_MS`, handoff transcript ownership is guarded by
  `runDirOwnsLiveTranscript` so a run directory that no longer owns the live
  transcript is not trusted, and an interrupt's teardown skips re-updating a
  run that is already cancelled. New coverage:
  `subagent-model-validation.test.ts` and
  `subagent-clean-cross-session.test.ts`.

- **Loop blocks no longer spend the settlement gate's budget.**
  `loopAttemptCap` is now separate from the settlement `attemptCap`, so a
  mid-run loop-breaker trigger cannot consume the retries a settlement gate
  needs; loop-breaker call/result records are paired by `toolCallId` and
  unresolved calls are ignored rather than miscounted.
  `scanEditVerification` recognizes `cd <dir> &&`-prefixed verification
  commands and safe reporter/verbosity flags, so a real verification is not
  undercounted as never-run; `verify.ts` truncates head/tail UTF-8-safely with
  a wider capture buffer; an untrusted project's orchestrator config warns
  instead of silently applying; and a peer message carries a `triggerTurn`.
  `orchestrator_override` and `orchestrator_wave` are exposed under
  `codemode`/`tool_search` sessions, pruning retargeted active tool names.

- **A late `/btw` stream delta can no longer resurrect `answer.md` after
  teardown.** The viewer's `appendExistingAnswer` opens `O_WRONLY | O_APPEND`
  instead of `appendFile`, so a delta or footer arriving after the file was
  deleted fails to recreate it instead of leaving a stray file behind; an
  `AbortSignal` is threaded through `startViewer`, `runTmux` and
  `openBtwPopup` so a stale launch aborts cleanly.

- **Hardened `git branch` flag parsing and modifier `--tools` handling.**
  `isSafeGitBranchArgs` treats `--abbrev`, `--color`, and `--column` as
  `--flag` or `--flag=value` only so they cannot consume a following positional
  token, and child `--tools` escalation preserves modifier syntax (`+`/`-`)
  when injecting `subagent_ask`.

Maintenance:

- **CHANGELOG.md keeps only `## Unreleased` and the newest major's
  releases; the tags are the archive.** The file reached 4,400 lines holding
  all 22 releases since v1.0.0, so every changelog edit made every subagent
  load the whole file, and parallel worktrees appending at the same
  `## Unreleased` anchor conflicted at merge time. It now carries
  `## Unreleased` plus `## v2.0.0 — 2026-11-26` (pruning `v1.17.x`), with a
  title note pointing at `git show vX.Y.Z:CHANGELOG.md` for everything older —
  nothing is lost, every removed section is still readable at its tag. The
  retention is a rule now, not a one-off: the structure test fails if a
  release of an older major appears, `AGENTS.md` orders releases that start a
  new major to delete the older sections in the same commit, and the
  `update-changelog` skill records the whole policy. Concurrent appends
  auto-merge: `CHANGELOG.md merge=union` in `.gitattributes` keeps both
  sides of two worktree branches appending to Unreleased (a local-only
  guarantee — GitHub's server-side squash merge does not run the driver,
  so a PR conflict is resolved with a local `git merge dev`), guarded by a
  test that asserts both the file text and the effective attribute. Built
  as a three-ticket wave with pinned implementer/reviewer/verifier gates;
  the tickets live in `docs/tickets/changelog-trim/`.

- **The applied change-bundle directory is gone, and the dangling docs it left
  behind landed.** The 1.9 MB harness-changes apply bundle
  (`APPLY.md`, `changes.patch`, and full `files/` copies of the tree) that
  rode in with the hardening merge under "to add" subjects — is dropped
  from the tree: it was already applied to the live files, referenced by
  nothing, and its copies had drifted from the tree they duplicated; git
  history keeps it, so nothing is lost. `docs/harness/workflow-schema.md` —
  the routing guide from trivial edit to ticket wave, which the README's
  file table points at — and `docs/tickets/changelog-trim/` — the three
  tickets the changelog-trim entry names — are committed, so no published
  pointer resolves to an untracked path.

- **Aligned skills, delegation prompt, and harness documentation
  (`RB-1`–`RB-11`).** Updated `implement`, `grilling`, `recall`,
  `worktree/references/parallel.md`, the parent delegation prompt,
  `AGENTS.md`, `README.md`, `REVIEW_GUIDELINES.md`, and `docs/harness/*` to
  match the unified review pipeline, retired extensions, and Pragmatic
  Orchestrator guardrails.
