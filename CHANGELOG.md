# Changelog

Versions are git tags. This repository is not published to npm.

Older releases are read from their tags with `git show vX.Y.Z:CHANGELOG.md` and are not kept in this file.

## Unreleased

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

Added:

- **`/orchestrate <folder>`, and the `orchestrator_wave` tool, inside the
  orchestrator extension.** A to-tickets folder runs through tiered
  subagent waves: every ticket is triaged by a decision model into a
  complexity tier, dispatched at a `(model, thinking)` pair read from
  `wave-ladder.json`, reviewed by a Tier-1 gate before it may commit,
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

Maintenance:

- **CHANGELOG.md keeps only `## Unreleased` and the newest major's
  releases; the tags are the archive.** The file reached 4,400 lines holding
  all 22 releases since v1.0.0, so every changelog edit made every subagent
  load the whole file, and parallel worktrees appending at the same
  `## Unreleased` anchor conflicted at merge time. It is now 241 lines:
  Unreleased plus v1.17.0 and v1.17.1, with a title note pointing at
  `git show vX.Y.Z:CHANGELOG.md` for everything older — nothing is lost,
  every removed section is still readable at its tag. The retention is a
  rule now, not a one-off: the structure test fails if a release of an
  older major appears, `AGENTS.md` orders releases that start a new major
  to delete the older sections in the same commit, and the
  `update-changelog` skill records the whole policy. Concurrent appends
  auto-merge: `CHANGELOG.md merge=union` in `.gitattributes` keeps both
  sides of two worktree branches appending to Unreleased (a local-only
  guarantee — GitHub's server-side squash merge does not run the driver,
  so a PR conflict is resolved with a local `git merge dev`), guarded by a
  test that asserts both the file text and the effective attribute. Built
  as a three-ticket wave with pinned implementer/reviewer/verifier gates;
  the tickets live in `docs/tickets/changelog-trim/`.

- **The applied change-bundle directory is gone, and the dangling docs it left
  behind landed.** `my-agent-setup-harness-changes/` — the 1.9 MB apply bundle
  (`APPLY.md`, `changes.patch`, and full `files/` copies of the tree) that
  rode in with the hardening merge under "to add" subjects — is dropped
  from the tree: it was already applied to the live files, referenced by
  nothing, and its copies had drifted from the tree they duplicated; git
  history keeps it, so nothing is lost. `docs/harness/workflow-schema.md` —
  the routing guide from trivial edit to ticket wave, which the README's
  file table points at — and `docs/tickets/changelog-trim/` — the three
  tickets the changelog-trim entry names — are committed, so no published
  pointer resolves to an untracked path.

## v1.17.1 — 2026-11-24

Added:

- **The shape of a change is now argued on paper instead of discovered through
  the diff.** `.pi/skills/architect/` is model-invoked and fires when a module or
  feature is being designed, a boundary is being reshaped, a workaround keeps
  coming back, or two abstractions compete. It maps every caller and boundary
  the change crosses, sketches two genuinely distinct shapes — different
  ownership, seams and types, not one idea renamed — and tests both on the
  deletion test, single ownership, minimal caller knowledge and
  replace-don't-layer. Then it picks the simpler shape and says why the other
  lost, or hands the decision to the user when both carry real product or
  irreversible tradeoffs. Upstream's scrap signal survives: friction that is a
  pattern rather than an instance means the boundary is wrong, so the sketch is
  thrown out instead of guarded.

- **A sixth user-invoked entry point, `/skill:recall`, rebuilds where the work
  stands before it is resumed.** It mines the session records under the agent
  dir through a `subagent` fan-out, then verifies every state claim against
  `git` and `gh` instead of trusting the transcript that made it. It adds a
  source upstream did not have: `orchestrator_workspace` `peers`, the other pi
  sessions live on this repository right now — read as a heartbeat, so a stale
  presence claim is verified against git rather than repeated. Tests:
  `coding-skills.test.ts`.

- **The stealth reasoning model `hungerg-free` is available in the OpenCode Go
  provider, including offline.** The curated entry registers `HungerG Free` on
  the canonical OpenAI-compatible Go endpoint with text and image input, a
  1,000,000-token context window, 65,536 output tokens and zero pricing. The
  live API advertises reasoning support without an effort list, so the entry
  enables reasoning but leaves pi's default thinking levels in charge rather
  than inventing a level map. Its minimal compatibility flags disable stored
  messages and the developer role while retaining strict mode and
  `max_tokens`; live probes confirmed ordinary assistant history works without
  requiring `reasoning_content`, and both text and image input remain exposed
  through pi's model type.

## v1.17.0 — 2026-11-23

Added:

- **A parent with live delegated runs parks its settlement instead of spending an
  attempt on a turn with nothing to act on.** A block starts another turn, so a
  parent that had just launched background subagents could burn its
  `attemptCap` before the first child reported, and the completion notice does
  not wake an idle session. The new `block.waitForSubagents` key (default
  `false`) opts a project into parking: a settlement that would block while a
  delegated run is live returns no continuation, spends no attempt, and records
  `parked: true` with the live run ids. The orchestrator keeps that set from the
  new `orchestrator:run-started`, `orchestrator:runs-snapshot` and
  `orchestrator:run-settled` lifecycle events, rebuilds it from the snapshot on
  reload, and sends exactly one `orchestrator-resume` message with
  `triggerTurn: true` when the last run settles — normal completion notices stay
  non-waking. `run-settled` now also reports `cancelled` and `interrupted`, so a
  cancelled or interrupted only-run releases the park; a worker never parks.
  Tests: `orchestrator-gate.test.ts`, `lifecycle-launch.test.ts`.

- **"Passed" now means the verification command actually verified something.**
  The settlement gate used to trust exit code 0, which made three common
  misconfigurations read as green: a configured `npm test || true`, a runner that
  matched no test files, and a model's own matching shell call whose output
  nobody read. A command that syntactically discards its own failure (`|| true`,
  `|| :`, `; true`, `; exit 0`, a trailing `2>/dev/null`, `set +e`) is now
  reported as `weak-command` and names the construct; a run whose bounded output
  matches a documented zero-test indicator (`0 passing`, `no tests found`,
  `ran 0 tests`, `0 tests`, `no test files` — not `0 tests failed`) is
  `inconclusive` and says why. Both new statuses fail open, so a false positive
  settles the run instead of trapping it. The opt-in
  `verification.successPattern` is a regular expression the bounded output must
  match for `passed`; a mismatch is `failed`, with the pattern as the reason. A
  model-run of the configured command clears the unverified edits only when its
  result classifies as a real pass, and a persisted `passed` verdict written
  before these statuses existed is re-checked against today's rules rather than
  trusted. Tests:
  `orchestrator-verify.test.ts`, `orchestrator-gate.test.ts`.

- **A project can ask for reservations that hold across linked worktrees, not
  just inside one.** `workspace.lockScope` in the committed
  `.pi/orchestrator.json` is `"worktree"` (the default, which reproduces the
  previous behaviour exactly: two linked worktrees may each reserve the same
  repository-relative file, and one worktree still refuses it twice) or
  `"repo"`, which maps every reservation into the shared repository root — the
  main checkout, resolved from the git common directory — so the same relative
  path is one claim across all of them. A repo-scoped claim is enforced against
  a session that kept the default scope, because the write guard maps its
  candidate into the holder's namespace before matching; a path outside the
  worktree keeps its absolute pattern and gains no cross-tree meaning. Records
  are version 2 and carry the scope and the reserving worktree's root; a version
  1 record is still read and enforced as worktree-scoped with no migration
  write, an unknown scope is unusable rather than guessed (it blocks nothing),
  and presence and peer messages keep version 1 so an older build in the next
  worktree neither loses its peers nor drops its inbox. The key is not a gate
  block: it neither blocks a settlement nor changes when `orchestrator_override`
  is registered. Tests: `orchestrator-reservations.test.ts`,
  `orchestrator-workspace.test.ts`.


- **The orchestration advisor redacts its digest, can fail over once, and its
  cost is now visible in `/session-breakdown`.** The digest already excluded
  tool-output bodies, but a file name, todo title, verification summary or loop
  detail can carry a credential, so every field it keeps now passes through a
  documented redactor (`advisor.redact`, on by default): an `sk-…` key, a GitHub
  `ghp_`/`github_pat_` token, an `AKIA…` access key id, a Slack `xox…` token, a
  `Bearer` header's token, and the value of an `api_key`/`access_token`/`secret`/
  `password` assignment — the key name stays, the value becomes `[redacted]`.
  Prose and paths are untouched, and the digest's shape and 4 KB bound are
  unchanged because redaction replaces characters before the bound is applied.
  `advisor.fallback` names one other provider/model tried once when the primary
  call fails with a provider error or rate limit; it is not used for a credential
  refusal or an abort, where a retry would hide a configuration error or keep
  calling after nobody is waiting, and an empty answer is reported rather than
  spent on a second provider. The record names the model that answered and the
  primary it replaced, and two provider calls are still one record and one budget
  unit. Separately, `/session-breakdown` counted only `type: "message"` entries,
  so pi's `appendUsage` entries — one per advisor consultation — were billed to
  nobody; the vendored file gains a fifth `LOCAL PATCH` that accounts those
  entries' tokens and cost (and their model bucket) without counting a message,
  and an inherited usage entry is excluded by the existing fork patch. Tests:
  `orchestrator-advisor.test.ts`, `session-breakdown.test.ts`.

- **After a successful compaction the model is told the orchestrator's state
  again.** Gate and advisor state already survive compaction — both are rebuilt
  from the active branch — but the model's own context does not, so after a
  compaction it could be unaware of an open goal, open todos, a pending
  verification, live delegated runs or a spent advisor budget. The new
  `session_compact` observer appends exactly one `orchestrator:compact-snapshot`
  `custom_message` naming the active goal, the open todo ids and titles, the gate
  attempts and `attemptCap` with every blocked condition's evidence and the last
  verdict's reason, the live delegated run ids with their `queued`/`running`
  status, and the advisor's budget, recorded attempts and consumed trigger keys.
  It is sent with `display: false` and `triggerTurn: false`, is bound to 4 KB
  with a truncation note, and is not sent at all when there is nothing to report
  or when the compaction failed. Compaction itself stays pi's: no
  `session_before_compact` handler is registered, no `compaction` result is
  returned, and nothing is read back from the snapshot — `/gate` and the next
  settlement reconstruct the same attempts and blocked evidence as before.
  Tests: `orchestrator-compact-snapshot.test.ts`.

Fixed:

- **The advisor's provider call now carries the parent session id.** OpenCode Go
  requires `x-opencode-session` and rejected the consultation with
  `MissingSessionID`; the registry derives that header from a `sessionId` option,
  which the side call omitted. The primary and the fallback use the parent
  session's id, so a provider that routes by conversation can answer.
- **A failed advisor call's reported usage is no longer dropped when a fallback
  answers.** The record is still one attempt, but its usage and cost are the sum
  of both provider calls; a provider that reports none on a failed call
  contributes nothing rather than a guess.
- **Advisor redaction no longer misses a passphrase, a Basic-auth header or a URL's
  userinfo.** A quoted value containing spaces aborted the old assignment
  pattern, so `password: "correct horse battery staple"` reached the provider
  verbatim, and an unquoted value left its tail behind. Quoted values (doubled
  quotes included) and unquoted values through the end of the assignment are now
  replaced, and `Basic <token>`, `scheme://user:password@host` and a lowercase
  `bearer` are covered. A fallback whose own credential check refuses now records
  that the primary was called, instead of claiming no call was made. A sentence
  that uses one of the key words as a label is over-redacted; that is the safe
  direction for evidence about to be sent to another provider.
- **A delegated worker no longer passes its role to a `pi` its shell starts.**
  `PI_ORCHESTRATOR_ROLE=worker` is inherited by every bash-tool subprocess, so a
  nested `pi` launched from a worker's shell resolved as a worker and skipped its
  own gate and advisor. The child now removes the marker at `session_start` —
  after every extension factory has read it, and before any tool can spawn a
  process — so it cannot outlive the run it was written for. The legacy
  `PI_TMUX_SUBAGENT_CHILD` fallback still assumes the orchestrator loads before
  the subagent factory, which the package manifest's order guarantees.
- **A parked settlement is released by every terminal state, including after a
  reload.** An interrupted run is terminal in-process, but the reload snapshot
  listed it as live, so a parent that parked before a reload could wait forever
  for an event the interrupt marker can no longer publish; `interrupted` is now
  excluded from the snapshot. A park also no longer runs the verification command
  whose result it would discard, and an aborted run clears the park so a late
  child cannot wake a session the user stopped. The subagent→orchestrator path is
  covered by a cross-factory test over one live event bus.
- **A delegated child no longer runs the project's verification command or blocks
  its own settlement.** The orchestrator decided "am I a child?" by reading
  `PI_TMUX_SUBAGENT_CHILD` at every boundary, while the subagent extension reads
  that variable in its factory and then deletes it so a `pi` spawned from the
  child's shell tool cannot re-enter child mode — so by the first
  `agent_before_settle` the guard was gone and the child was held to the parent's
  policy, stalling the delegation its parent was waiting on. The role is now
  resolved once at module load (`.pi/extensions/orchestrator/role.ts`) from the
  launcher-set `PI_ORCHESTRATOR_ROLE=worker`, with the legacy
  `PI_TMUX_SUBAGENT_CHILD=1` still honoured, so scrubbing the environment cannot
  change it. A worker reports with `scope: child`, runs no command, blocks
  nothing, consults no advisor and registers no override tool; a top-level run
  (`pi -p`, RPC, CI) carries no marker and settles normally. The child command
  now writes `PI_ORCHESTRATOR_ROLE=worker` as a literal, and a fresh-process test
  drives the real factory with the launcher's environment instead of only the
  test seam, which is what let the original bug through. A child-side test proves
  the marker is removed at `session_start`. Tests: `orchestrator-role.test.ts`,
  `orchestrator-gate.test.ts`, `lifecycle-launch.test.ts`.

Maintenance:

- Documented the lock-scope boundary: a repo-scoped claim binds edits inside the
  writer's own worktree, a path outside it keeps its absolute form, and a v1
  record's root is its recorded cwd.
