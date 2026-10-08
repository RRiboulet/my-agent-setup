# Changelog

Versions are git tags. This repository is not published to npm.

## Unreleased

Added:

- **`.pi/skills/tmux/` — a vendored skill for driving interactive CLIs
  (python, gdb, lldb, psql, …) over a private tmux socket.** Interactive
  processes are the one thing a one-shot bash call cannot do: they need a
  persistent TTY, a prompt to wait for, and keystrokes sent over time. The skill
  documents the socket discipline (`-S` everywhere, never `-L` — they address
  different servers), literal `send-keys`, `capture-pane -J`, prompt polling,
  and recipes for the Python REPL and gdb. Vendored from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/tmux/`
  (Apache-2.0, commit `0865c84`) with the socket names moved from
  `CLAUDE_TMUX_SOCKET_DIR`/`claude-*` to `PI_TMUX_SOCKET_DIR`/`pi-*`, the
  `license: Vibecoded` frontmatter corrected to `Apache-2.0`, and upstream's
  `wait-for-text.sh` given `-S`: it always called bare `tmux`, so on the
  very private socket the skill requires it could not see the pane and would
  only ever time out. `find-sessions.sh` needed four fixes: upstream's
  `'\t'` sat inside single quotes, so tmux printed the literal two characters
  and every row lost its attached/created columns; `#{session_created_string}`
  is not a tmux variable, so the start time was always blank; `-q` grepped the
  whole tab-joined row rather than the session name, so `-q Thu` matched a
  session created on a Thursday; and `#{session_attached}` is a client count,
  so a session with two clients printed as detached. The helpers also warn
  when no socket is given and `$TMUX` is set, because a bare `tmux` then
  follows `$TMUX` — which inside a subagent shell is the subagent socket — and
  a static guard test pins the two sockets apart. The subagent
  reconciliation the todo asked for is the
  `pi-agent-*` reservation: `.pi/extensions/subagent/` keeps its own socket
  (`<agent dir>/tmux-subagents.sock`) and its own session names, the skill's
  helper scripts scan only `PI_TMUX_SOCKET_DIR`, and the skill documents both
  the socket and the name space as off-limits so neither `find-sessions.sh --all`
  nor a `kill-server` can reach a running child. A README row and the
  `package.json` manifest entry travel with it.

- **`.pi/skills/librarian/` — a vendored skill that caches remote git
  repositories under the pi agent dir, so repeated references reuse a local
  checkout.** `checkout.sh` parses `owner/repo`, host-qualified and full-URL
  forms (plus GitHub-style deep links), partial-clones with
  `--filter=blob:none`, and on later calls throttled-fetches (default 300s) and
  fast-forwards when the checkout is clean and has an upstream; `--force-update`
  skips the throttle and `--path-only` prints just the path. Vendored from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  `skills/librarian/` (Apache-2.0, commit `0865c84`) with the cache root moved
  from `~/.cache/checkouts` to `<agent dir>/cache/checkouts`: on this
  devcontainer `~/.cache` is container-local and discarded on every rebuild,
  while the agent dir is the persistent `pi-agent-config` volume, so the cache
  now survives one. `LIBRARIAN_CACHE_ROOT` still overrides it. A README row and
  the `package.json` manifest entry travel with it.

Maintenance:

- **The devcontainer builds on pi 1.1.0, not 1.0.0.** `ARG PI_AGENT_VERSION`
  in `.devcontainer/Dockerfile` is what the image's `npm install -g` bakes in,
  so it — not a runtime `npm install -g @latest` — decides which pi a rebuild
  gets. The image was one release behind, and a container running 1.0.0 that is
  updated by hand reverts on the next rebuild: the pin is the only place the
  version is durable. Bumped to match current upstream.
- **The `todo` tool's six id-taking actions no longer each repeat the same
  guard/validate/`existsSync`/result-shape block.** `get`, `update`, `append`,
  `delete`, `claim` and `release` spelled out the same lines by hand; they now
  share `resolveExistingTodo` (validate + existence in one step, carrying both
  the text shown and the `details.error` stored, which differ on the not-found
  path) and the `todoToolResult` / `todoToolError` builders. The module-level
  mutators (`updateTodoStatus`, `claimTodoAssignment`, `releaseTodoAssignment`,
  `deleteTodo`) deliberately keep their own resolution: their not-found message
  echoes the caller's id case, while the tool paths lower-case it, and that
  pre-existing inconsistency is now pinned by a test rather than quietly
  harmonised. Found in the 2026-10-05 code review.
- **`todos.ts` loads under a strict ESM loader again, which exposed a real
  import bug the old exclusion had been hiding.** The extension used a
  TypeScript parameter property (`private onQuickAction?`), which node's
  strip-only loader rejects, so `extension-load.test.ts` left it out of the
  guard. Converting that to a field and adding it surfaced the actual problem:
  `TUI` is a *type-only* export of `@earendil-works/pi-tui` and was imported as
  a value. pi's jiti loader tolerated the mismatch; the real ESM linker does
  not, so the module would have failed the moment its top level was evaluated
  under one. Both are fixed and `todos.ts` now joins the strict-ESM guard.
- **New `todos-tool.test.ts`.** It drives the real `todo` tool over a throwaway
  `PI_TODO_PATH`: every action's missing-id, malformed-id and not-found
  response (`text` and `details`, including the `"not found"`-vs-full-message
  split and the id-case split above), plus a
  create→get→update→append→claim→release→delete round trip. Verified by
  mutation — changing the not-found `details.error` turns the table red.
- **`finalizeRun` and `markRunFailed` now share one `settleRun` tail.** Both ended
  with the same sequence — read the child's usage, `persist()`,
  `notifyCompletion()`, `refreshStatusWidget()`, `scheduleReap()` — copied into
  each, and the failure path duplicated the "the child may have spent tokens even
  when it failed" reasoning too. `settleRun` holds it once; `finalizeRun` keeps
  only its extra `drainQueue()`. The order is unchanged, and the comment about
  notifying before refreshing (a display problem must not swallow the completion
  message) moved with the code. Found in the 2026-10-05 code review.
- **`subagent/status.ts` no longer carries state nothing reads.** Three dead
  things went. `latestEvent` was plumbed from the child's activity snapshot
  through `StatusObservation`, `SubagentStatusState` and
  `observationFromActivity`, but never read — the activity recorder keeps its own
  `latestEvent`, and that is the one the parent uses. `advanceStatusState`
  computed and returned a `SubagentStatusTransition` that its only production
  caller discarded (the comment said so outright: "deliberately ignored"). And
  `StatusSnapshot` exposed raw `elapsedMs` / `activeSinceMs` / `waitingSinceMs`
  for an aggregator that does not exist: the widget and `subagent_status` both
  render the `*Text` form. The comment asserting that aggregator was wrong, so
  the fields went with it. The stall/recovery edge is still observable through
  `currentKind`, which is what `classifyProblemState` reads, and
  `classifier.test.ts` now pins that instead of the removed transition. Found in
  the 2026-10-05 code review.
- **The four session-breakdown tables and two palettes now share one
  implementation each.** `renderModelTable`, `renderCwdTable`, `renderDowTable`
  and `renderTodTable` each rebuilt the same header/divider/row loop and the same
  cost / cost-per-session / share maths; they now call `renderMetricTable`, with
  `metricForKind` selecting the per-key map and denominator. `choosePalette`
  replaces the two choosers' identical cost→tokens→messages→sessions ranking. The
  tables were previously unpinned — nothing asserted their headers — so
  `session-breakdown.test.ts` now asserts the exact pre-refactor output for the
  model and directory tables, the no-data lines, the fixed day/time-of-day order,
  and both palettes; the refactor is byte-identical against it. Found in the
  2026-10-05 code review.

## v1.2.0 — 2026-10-07

Added:

- **`opencode-go` provider** — `/model` gains a provider for fast GLM, Kimi,
  MiniMax, Qwen, DeepSeek and Grok models served through opencode.ai's Go API
  (Go-optimized endpoints, correct wire protocol per model — Anthropic, OpenAI
  Completions, Responses — and prompt-cache session affinity), plus a usage
  widget below the editor showing how much of the 5h / 7d / 30d Go-plan budgets
  remain (`/opencode-go-usage` for the full breakdown). **Vendored** from
  [monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider)
  (MIT), byte-identical to upstream `286c467` with zero local changes (see the
  README). Needs an opencode.ai key in `~/.pi/agent/auth.json` (`opencode-go`)
  or the `OPENCODE_API_KEY` environment variable.
- **`/goal`** — long-running objective mode: `/goal <objective>` (and the
  `get_goal` / `create_goal` / `update_goal` tools) starts an unbounded task
  that keeps pursuing a stated objective across turns, with an optional token
  budget and an `active`/`paused`/`blocked`/`usageLimited`/`budgetLimited`/
  `complete` lifecycle. All state is appended to the session log and
  reconstructed from the active branch on reload and tree navigation — no
  external database. Complements `subagent`: delegation for bounded tasks,
  `/goal` for unbounded ones. **Vendored** from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  (Apache-2.0), with two local changes — a testability refactor
  (`reconstructGoalFromBranch`, `hasExhaustedTokenBudget`) and a `__test__`
  export (see the README).
- **`/review` and `/end-review`** — interactive code review with five modes
  (PR, base branch, uncommitted, commit, folder), loop-fixing toggle, shared
  custom instructions, and project-level `REVIEW_GUIDELINES.md`. **Vendored**
  from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  (Apache-2.0), with two local changes — a testability
  refactor and a `__test__` export (see the README).
- **`github` skill** — gh CLI usage (PRs, CI runs, `gh api`, JSON output).
  **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  (Apache-2.0), with four local adaptations — this repo's `GH_CONFIG_DIR`
  auth setup (token survives rebuilds only because it lives in the volume),
  the AGENTS.md PR workflow (`--fill`, `--squash --delete-branch`, and the
  non-squash dev→main release merge that must not delete `dev`), the token
  rule (never in `.git/config`, the Dockerfile, or a repo file), and a note
  that `--repo` is dead weight inside a checkout (see the README).
- **`continue` shortcut** — `shift+alt+enter` sends the literal prompt
  `continue`, but only when the agent is idle, so it can never steer a running
  turn or queue a follow-up by accident (`isIdle()` is also false while pi is
  retrying, compacting, or has queued messages). **Vendored** from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  (Apache-2.0), byte-identical to upstream `0865c84` with no local changes (see
  the README).

Fixed:

- **`subagent_interrupt` reported an interrupt that landed as "no new interrupt
  was reported" whenever the watcher beat the tool's poll to the marker.** The
  confirmation poll inferred staleness from `noteInterrupt`'s return value, but
  the watcher folds the *same* marker on its 500 ms tick. When the watcher got
  there first, `noteInterrupt` reported "no change" for an interrupt the child had
  genuinely settled, and the tool told the model that a stop it had just caused
  had not happened. Confirmation now rests on the marker's freshness relative to
  the baseline captured before the Escape, never on whether that call happened to
  change the record. The run was always correctly `interrupted`; only the answer
  was wrong. A run that had already reached a terminal status when the abort was
  reported is now answered as `superseded` rather than confirmed — the marker is
  real, but the run is over and claiming a stop would assert a state it is not
  in. Repro without the fix: `subagent_interrupt` against a child whose marker is
  folded by the watcher before the tool reads it.
- **Cancelled and tmux-failed subagent runs now report the tokens and cost they
  had already burned.** Only `finalizeRun` read the child's session usage, so a
  run stopped by `subagent_cancel`, or by a tmux-level failure, wrote
  `usage: undefined` and reported no tokens in `subagent_status`, in the list
  view or in the completion notification — even though a cancelled run is very
  often one that had spent real money first. Usage is now read before the
  terminal status is persisted, and a standalone run's session file (whose exact
  name the parent only learns when the child reports a result) is discovered
  under the run dir so the read has something to read. The inherited-context
  baseline is still honoured, so a fork or resume is not charged for what it
  inherited. A run cancelled by `kill-on-shutdown` is read the same way, so the
  shutdown path reports its cost too.
- **The late-`result.json` re-read in `finalizeMissingChild` is now covered.** It
  guards the window between the watcher's first result read and its pane probe,
  where a child that reports and exits in the same instant would otherwise be
  recorded as failed. Deleting the re-read left the suite green, so the test now
  drives the window directly by writing the result while the pane probe is in
  flight — verified to fail when the re-read is removed.
- **Two `subagent_resume` calls fired in parallel can no longer open two pi
  processes on one transcript.** A finished run stays terminal forever, so the
  "is another resume in flight" scan over `runs` was the only guard — and a
  resume does filesystem I/O (`mkdir`, `countSessionLines`) between that scan and
  the new run being registered, so two calls that did not await each other both
  passed it and appended to the same JSONL, interleaving branches and scrambling
  usage baselines. The transcript is now claimed synchronously, with no `await`
  between the check and the claim, and released once the run is registered.

Maintenance:

- **Decided and recorded: this repo has no typecheck step, by design.**
  `node --test` strips types without checking them, so a type error can
  survive the suite. Adopting a typechecker would pull in the repo's first npm
  compiler dependency (it consumes no npm packages) and would have to
  reconcile a documented asymmetry — `todos.ts` uses TypeScript parameter
  properties that node's strip-only loader rejects while pi's jiti loader
  accepts, and the `erasableSyntaxOnly` fix is one the files do not currently
  satisfy. The bug class it would catch (a bare identifier used as if it
  existed, a `HarnessOptions` field the factory reads but no caller sets) is
  exactly what the P1/P2 audit fixed and pinned with tests. The decision and
  its reason now live in AGENTS.md next to the test command, so it is not
  re-derived.
- **The `CwdKey` comment in `session-breakdown.ts` no longer claims the cwd
  path is normalized.** The single-line type comment said "normalized cwd
  path", but the only processing is `cwd.trim()` — nothing collapses a
  trailing slash or resolves a relative path, so `/srv/app` and `/srv/app/`
  bucket separately and both appear in the legend.
- **The `subagent` watcher re-arms through one code path, and the legacy `v1.`
  attach target says what it is.** `watchTick` re-armed its own 500 ms timer
  inline at its tail while `scheduleWatch` implemented the identical re-arm;
  the tail now calls `scheduleWatch`, so there is exactly one re-arm (and a
  schedule that lands during a tick's awaits no longer risks arming twice).
  The `v1.`-prefixed base64 target branch in `attachToSubagentAndExit`
  predates session-id targets; no current code path produces it
  (`attachCommand` is always `--attach-subagent <run.id>`, and `run.id` is a
  UUID), so its cut-off is now stated in the code instead of leaving a reader
  to guess whether it is live plumbing. It is kept rather than removed because
  the file stays close to upstream. No behaviour change.
- **`native-web-search`'s script lookup no longer advertises a path that cannot
  exist.** `resolveScriptPath` probed `here/../../skills/native-web-search/`
  for the skill, but `here` is the extensions dir (`.pi/extensions`), so that
  resolved to `<repo>/skills/...` while the script actually lives at
  `<repo>/.pi/skills/...` — the `.pi` being the whole reason a git-sourced pi
  package is discoverable at all. The candidate could never exist, yet the
  thrown error listed it as somewhere to look. It now carries the `.pi`,
  resolving relative to the repo/package root and covering both the repo tree
  and an installed package. The lookup is factored so the candidate list is
  testable, and a fixture-tree test pins it: a regression back to bare
  `skills/` fails the suite.
- **Vendored `session-breakdown.ts` comments no longer restate CHANGELOG
  measurements.** The simplification audit counted ~230 comment lines for
  ~240 code lines and found the specific figures (`$0.067741 / $1.708118` of
  missing cost, a fork transcript's `1,473,545 / 527,566` tokens, `2,989,693`
  tokens already duplicated inside `sessions/`, the "64%") copied into the
  vendored header, `defaultSessionRoots`, and two one-liners — several blocks
  restating CHANGELOG.md verbatim. Those figures are now written once, in the
  CHANGELOG, and the comments point there ("measured 2026-10-04, see
  CHANGELOG.md"), so refreshing the vendored file does not silently create a
  second source of truth that drifts out of step. The reasoning is kept in
  full where it is not in the CHANGELOG — why the dedupe is scoped to a
  lineage and never global, why `model_change` state is still replayed from
  inherited entries, why an unreadable own header counts as broken lineage
  rather than clean. The `inheritedNote` comment, which argued the
  child-transcripts/exclusion rationale a third time, is trimmed to what the
  function needs, and the two `parseSessionFile` comments that explained the
  one `if (inheritedEntry)` skip are merged into one. Comment-only; no
  behaviour change.
- **The management-tool registration memo is closure state, and now says so.**
  A code review read `appliedManagementExposure` / `managementToolsRegistered`
  as module-level and warned that a reload could strand the five management
  tools. They are not module-level: the factory opens far above them and closes
  at the end of the file, so they reset on every extension load — the block is
  simply written without the factory's indentation, which is why it read as
  module state. The suite already depended on the reset (every test builds a
  fresh harness, then calls `subagent_status`), and a new test pins it by
  loading twice in one process and asserting the tools are registered the second
  time; it was verified to fail when the declarations are hoisted. Added a
  comment explaining the shape, and removed a stray `;;`. No behaviour change.
- **`postCreate.sh` now defaults `GH_CONFIG_DIR` instead of trusting the image's
  `ENV`.** The Dockerfile sets it, but a container built from an older image does
  not have it, and the later `mkdir -p "$GH_CONFIG_DIR"` then expands to
  `mkdir -p ""`, which fails under `set -e` and aborts the rest of postCreate.
  Defaulting to the same `/home/vscode/.pi/gh` makes the script self-sufficient
  and cannot change behaviour when the `ENV` is present.
- **The `todo` tool now asks for a symbol or a file name instead of a
  `file:line` number.** Line references drift as the code moves, and the current
  todo list demonstrated it: several had gone stale after a single refactor. The
  tool description tells the model to name the file or the symbol. This is
  advice, not a constraint — a line number is still allowed when it is the
  clearest available locator.
- **`MODELS.txt` removed.** Nothing reads it: `pi-session.sh` takes the model
  as an argument, and the README's file tree no longer lists it.
- **The `lifecycle.test.ts` harness bootstrap is one helper again.** Eight tests
  open-coded the same wrapper — `withTempAgentDir`, `createHarness` with a
  `liveBranchSessionManager(agentDir)` passed through an `as never` cast, and a
  `try`/`finally` shutdown — because `withHarness` did not hand the callback the
  temp `agentDir` the live-branch manager needs. `withHarness` now passes
  `(harness, agentDir)` and accepts `sessionManager?: "liveBranch"`, building
  the manager from the agent dir it has already set, so the eight sites and
  their casts are gone and a test can no longer leak a harness by forgetting the
  `finally`. `HarnessOptions` also declares the four fields `createHarness`
  already read — `activeTools`, `requestedTools`, `unbound`,
  `toolStallSeconds` — which type-checked only because nothing type-checks this
  repo. Tests only; no production change.
- **`todos.ts` error-checking is one guard, and the list renderers share one
  section list.** `withTodoLock<T>` returns `T | { error: string }` with no
  discriminant on the success arm, so callers repeated
  `typeof result === "object" && "error" in result` in ten places, three more
  wrote `"error" in result`, and `withTodoLock` itself wrote the same test on
  `acquireLock`'s return — fourteen inline checks in all, each one a chance to
  get the narrowing subtly wrong. They now call a single `isError(result)` type
  guard over a named `ErrorResult`; `acquireLock` and `withTodoLock` return that
  type instead of an inline object literal. The guard is behaviourally identical to
  the expression it replaces on every shape the callers produce, with one
  deliberate difference: a `null` result used to reach `"error" in null` and
  throw a `TypeError`, and now returns `false` — no caller can produce `null`
  (`ensureTodoExists`'s `null` is guarded at every call site), so this only
  removes a latent crash. Also folded in two related review items: the
  `actionLabel` seven-arm nested ternary in the tool-result renderer is now a
  `TODO_ACTION_LABELS` lookup, and `formatTodoList` / `renderTodoList` share one
  `todoSections` helper instead of each rebuilding the same
  assigned/open/closed list.
- **The last of the dead members are gone, and the `sliceByColumn` hang with
  them.** A code-review pass flagged members with no production reader; this
  removes them. `listTodosSync` in `todos.ts` (the async `listTodos` is the only
  one used), `QnAComponent.allQuestionsAnswered` in `answer.ts`,
  `SubagentActivityRecorder.flush()` in `activity.ts` (every terminal path
  awaits `settled()`/`shutdown()`; its test actually exercised `settled()`, so
  it is renamed rather than dropped), `paneResult()` in the test helpers, and
  the `killCommand` field on `RunRecord` (cancelling re-derives the command with
  `tmuxArgs("kill-session", …)`, so nothing rendered it). The interrupt marker's
  `turnIndex` goes too: it was latched from `turn_end`, written to
  `interrupt.json` and validated, but no reader ever used it — `runSummary`
  renders `interruptedAt` and `interrupts`. `validateActivityState`, a pure
  pass-through, is replaced by exporting `validateActivity` directly. The dead
  legend path in `session-breakdown.ts` (`renderLegendItems`,
  `renderLegendBlock`, `renderLeftRight`, `fitRight`) had no call sites — the
  live legend is built inline — and its only reason to exist was
  `sliceByColumn`, which cannot terminate on an unterminated ESC
  (`sliceByColumn("ab\x1b", 0, 10)` hangs); deleting the path deletes the hang.
  `readSessionHeader` and `readEntryIds` now share one `forEachJsonLine`, so the
  stream/readline/try-finally scaffolding exists once. Deliberately kept:
  `agentActive` / `providerActive` on the activity snapshot, which no renderer
  reads but which the validator uses to enforce "a done snapshot cannot have
  active work" and which make a hand-inspected `activity.json` self-describing;
  a comment on the type now says so.

## v1.1.1 — 2026-10-05

Fixed:

- **The README's `v1.0.0` pinning caveat was backwards.** It said pinning to
  `v1.0.0` "installs nothing", implying the tag predates pi packaging. It does
  not: at `v1.0.0` the resources are in conventional root `extensions/` and
  `skills/`, which pi finds with no manifest at all, so that ref installs four
  extensions and one skill. The ref that installs nothing is the stretch
  between the move to `.pi/` and the manifest commit `e4e072f` — dot-prefixed
  directories are not globbed, so the install succeeds and loads zero. Found by
  installing each of them and reading what actually loaded.


## v1.1.0 — 2026-10-05

Added:

- **`commit` and `update-changelog` skills** (`.pi/skills/commit/`,
  `.pi/skills/update-changelog/`): the two steps of the release procedure in
  `AGENTS.md` that were being done by hand. Both vendored from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0,
  commit `0865c84`), like our other four resources, and adapted in place:
  - `commit` keeps upstream's Conventional Commits subject format but drops its
    72-character limit — 8 of this repo's 30 commits exceed it, the longest at
    102, because the convention here is a subject that carries the actual claim
    — and adds the branch rule, with the release commit as the one deliberate
    exception (`AGENTS.md` has `main` move for releases and nothing else).
  - `update-changelog` replaces upstream's `<baseline>..HEAD` commit range with
    the one a branch-per-change workflow actually wants (`main..HEAD` on a
    branch, `<tag>..main` at release time), and corrects two rules that
    contradict this repo: that insignificant changes should be dropped (most of
    this changelog is exactly those, reasoning included) and that entries are
    bolded lead-ins (the *sections* are plain text; the entries are the bold
    part).
  - It also recorded a wart rather than fixing it: `### Unreleased` sat
    *inside* `## v1.0.0`, so the next tag would have shipped an "Unreleased"
    section under the previous release. The skill told the agent to raise it and
    `CHANGELOG.md` was restructured as a separate change.
- **`/session-breakdown`** (`.pi/extensions/session-breakdown.ts`): sessions,
  messages, tokens and cost per day over 7/30/90, a model / directory / weekday
  / time-of-day breakdown and a contributions-style calendar. Read-only, no
  network, no writes.
  **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
  `extensions/session-breakdown.ts` (Apache-2.0, Copyright (c) mitsuhiko and
  contributors) — not our code. Upstream ships it untested and we keep it close
  to upstream so a refresh stays a readable diff; our four `LOCAL PATCH` hunks
  are listed in the file header and in the README. Two of them fix numbers that
  were wrong on this machine:
  - Upstream hardcodes `<homedir>/.pi/agent/sessions`, so a relocated agent dir
    (`PI_CODING_AGENT_DIR`) was invisible — upstream PR #24 asked for exactly
    this and was closed unmerged — and so were the subagent extension's child
    sessions, which live in sibling trees (`tmux-subagents/`, legacy
    `subagents/`). Measured 2026-10-04 on this machine: **$0.067741 of
    $1.708118 (4.0% of cost) was missing from the view**. Token counts are not
    quoted: they move with every run, and every duplicated entry on this box
    reports `cost.total = 0` anyway. Reproduce the dollar gap with
    `node tools/measure-session-usage.mjs`.
  - A forked session file carries a verbatim copy of its parent's tail, ids
    included, so summing whole files counts those requests twice. This is not
    hypothetical and not only ours: pi's own `/fork`, `/clone` and `--fork` copy
    entries into the session dir, and **2,989,693 tokens (~1% of the reported
    total) were already duplicated inside `sessions/`** before the subagent
    extension was involved. A real `handoff: "fork"` child measured at the time
    held 1,473,545 tokens in its transcript against the 527,566 its own turns
    added — 64% of the file was somebody else's requests. (That transcript has
    since been reaped, so the figure is historical; the arithmetic is in
    TODO-859f419f.) Inherited entries are now excluded from
    messages, tokens and cost, resolved through the `parentSession` path in the
    v3 header, which pi, upstream's `split-fork.ts` and our `handoff.ts` all
    write and no analytics code read. A file still counts as one session; a file
    whose header or parent chain cannot be read is counted in full rather than
    guessed at, and reported.
  - Because a total that silently drops context looks exactly like one that is
    simply wrong, a dimmed footer line reports what the scan did — e.g.
    `last 90 days · N child transcripts · 6 forked sessions, 290 inherited
    entries excluded (3.0M tokens, counted in the parent when it is in range) · 1
    with unreadable header or parent, lineage incomplete` — captured on the day,
    so the file counts move and the token total does not. Delegation is not free
    — a forked child really is billed for re-sending the prefix, mostly as cache
    reads — so this is about counting each request once, not about pretending
    otherwise. Each clause appears only when it has something to report, and the
    uncertain one says "lineage incomplete" rather than "counted in full": a
    half-walked chain is partly excluded and partly not, and the error, when there
    is one, is always towards counting too much.

Fixed:

- **`pi install git:github.com/RRiboulet/my-agent-setup` installed nothing.** The
  README advertised it, but a git-sourced package is discovered either from a `pi`
  manifest in `package.json` or from conventional `extensions/` and `skills/`
  directories at the package root, and this repo had neither — its resources live
  in `.pi/extensions/`, which is dot-prefixed and therefore not found by a glob.
  The install reported success and loaded zero extensions. Added the manifest
  (five extension entry points plus the one skill), and a test that checks it
  against the filesystem in both directions, so adding an extension without
  listing it fails the suite instead of failing silently on someone else's
  machine.

Maintenance:

- **The base check added an hour ago was half a check, and testing it found
  that.** `git log --oneline dev..HEAD` is the wrong primary check: a branch cut
  off `main` is *behind* `dev` rather than ahead of it, so the log prints nothing
  and reports a clean branch that is based on the wrong commit — the exact
  mistake the check was added to catch. The ancestor check,
  `git merge-base --is-ancestor dev HEAD`, is the one that sees it. Both are now
  documented, with the log demoted to answering "what is in the way" once the
  ancestor check has failed, and a table of what each does in each situation.
  Caught by running the check against a deliberately mis-parented branch, not by
  reading it.

- **`native-web-search` is now attributed.** The skill was vendored from
  [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) all along and
  carried no provenance header, which made it look locally original — and I told a
  reviewer exactly that while reviewing a different branch. It is not: all of
  upstream's functions survive and three were added (`runOpenRouterSearch`,
  `defaultModelId`, `defaultBaseUrl`) for OpenRouter, which is the provider this
  machine actually authenticates with. Both files now carry the same
  VENDORED/NOT OURS header and Apache-2.0 line as the other vendored resources,
  `SKILL.md` lists the three patches, and the README distinguishes this skill
  (**vendored**) from `native-web-search.ts` (**ours** — upstream has no such
  extension).

- **Work happens on `dev`; `main` takes releases only.** Feature branches start
  from `dev`, merge into `dev` by pull request, and `dev` merges into `main` only
  when a release is cut. `main` was previously both the integration branch and the
  release branch, which meant a half-finished change was always one merge away
  from a tag.
- **"Check your base before you commit"** (`AGENTS.md`, and the first step of the
  `commit` skill's local adaptation): `git log --oneline dev..HEAD` must list only
  this change's commits. Branching off the wrong parent happened three times in
  one session, and each time it shipped a pull request carrying another branch's
  commit — caught in review every time rather than by the author, which is the
  part worth fixing. A release merge is the one that is not a squash, so `main`'s
  history is the real one.

- **`gh` is baked into the devcontainer** (`.devcontainer/Dockerfile`): branches
  could not reach GitHub from inside the container at all — no `gh`, no
  credential, and an HTTPS remote that could not authenticate. `GH_CONFIG_DIR`
  points at the `pi-agent-config` volume, so one `gh auth login` survives a
  rebuild; `/home/vscode` is container-local and is discarded, and that
  distinction is the whole design. The token is in no image layer, no repo file
  and no `.git/config`. An adversarial review of the first version of this found
  that the credential *survived* a rebuild while the credential **helper** did
  not — `gh auth setup-git` writes to `~/.gitconfig` on the overlay — so `git
  push` broke after every rebuild. The helper is now registered system-wide in
  the Dockerfile, which is the part `gh auth setup-git` should have been.

- **Three subagent behaviours were documented as tested and were not.** A
  simplification audit ran 47 single-behaviour mutations against this suite;
  three survived, meaning nothing would have failed had the behaviour been
  deleted. `usage.fromLine` (`usage.ts`) had no unit coverage at all, despite
  being the guarantee this changelog advertises for token accounting — a fork or
  resume is not charged for inherited context: `usage.test.ts` never passed
  `fromLine`, and `lifecycle.test.ts` pinned the baseline number rather than that
  it is honoured. `MAX_TRANSIENT_TMUX_FAILURES` (`index.ts`) was vacuously
  covered: the harness's `failPaneOnce` broke only the first of the two tmux
  calls a watcher tick makes, so the second succeeded, the failure was cleared,
  and "one failure is tolerated" could not fail for any reason. And
  `observationFromRead`, the only bridge from an activity read to a status
  observation, was untested, which left `snapshotProblemLabel`'s one non-null
  branch reachable only from a hand-built snapshot. Each now has a test that
  fails when the behaviour is removed, verified by reverting the implementation
  in a scratch copy. A fourth audit entry (`validateCwd`'s not-a-directory
  branch) was stale — `pure.test.ts` already covered it — and needed nothing.
  No behaviour changed: the only production edit is one line adding
  `observationFromRead` to the `__test__` export block.
- The tmux-failure tolerance test now synchronises on a counter the harness
  owns rather than a `setTimeout`. It previously slept 700 ms and then asserted
  an exact tick count, which meant it either caught the blip already banked (2)
  or did not (3) — a wrong answer, not a slow one, and a review proved it by
  shortening the sleep. The harness counts ticks, so the test waits for the
  event; both mutation kills (3 to 1, 3 to 2) are re-verified after the change.
- **Five tests for the vendored `/session-breakdown`, covering behaviour that
  had none on either side.** Upstream ships this 1.8k-line file with no tests,
  and we had pinned only our own `LOCAL PATCH` hunks — so three upstream
  behaviours were live in this repo and untested: faux/test-provider sessions are
  skipped (`2ac4480`; their token estimates are synthetic, not usage), only a
  model that actually produced a message is counted (`0865c84`; a default model a
  session switched away from before sending anything was inflating per-model
  session counts), and the cost/session column with provider grouping (`ab1e7f3`).
  Two of the three are numbers a person reads as a bill. Each test was verified
  by re-introducing the upstream fix and watching it fail; deleting LOCAL PATCH 2
  fails 8 tests, so the change did not quietly neuter it.
  Two things worth recording:
  - `0865c84` tightens the dead-session rule that LOCAL PATCH 2 amends, and that
    seam is now asserted from both sides: upstream drops any session where no
    model answered, we keep a declared fork, because a child seeded from a parent
    branch and abandoned is a session the user really started.
  - A test asserting "a tool result naming a model does not mark it used" was
    written and then deleted: upstream deliberately counts such a message
    (`explicitMk || role === "assistant"`), so the test asserted a bug that does
    not exist. The mutation run is what caught it, which is the argument for
    running one.
- `PI_SUBAGENT_*` integers are now parsed strictly: `"3m"`, `"1e9"` and `"3.9"`
  are reported on stderr and ignored rather than truncated by `parseInt`, which
  would have turned a mistyped stall threshold into seconds. A behavioural change
  to configuration parsing, deliberately called out here rather than filed under
  "no behaviour change".
- Fixed `AGENTS.md`, which still documented `./extensions` and `./skills`
  after they moved to `.pi/` in `3b554e9`, and gave a test command that no
  longer existed. Documented the CRLF trap and how to repair it.
- Renormalized line endings to LF across the tree (`.gitattributes` already
  required it; `pi-session.sh` was committed with CRLF in its blob and other
  files were left stale-CRLF in the working tree, invisible to `git status`).
- Added this `CHANGELOG.md`; `AGENTS.md` mandated it but it did not exist.

Pruned for a first iteration, deliberately (all removed, not deprecated):

- **`subagent_wait`.** With the live widget showing a human the same thing, and
  completion notifications still waking the parent, a blocking wait mostly bought
  a turn held open. Models poll `subagent_status` instead. This was also the
  prerequisite for making notifications quiet, and it is what the (now dropped)
  `caller_ping` work depended on.
- **The `/subagents` dashboard.** 163 lines, never covered by a test — the
  harness stubs `registerCommand`, so no test could reach it — and superseded by
  the live status widget, which covers the same ground for every run rather than
  behind a keypress.
- **The completion notification taking the main agent's turn.** Every finished
  run sent `{ deliverAs: "followUp", triggerTurn: true }`, which pi turns into a
  full extra turn with the whole conversation re-sent. Both options are now gone:
  the message is appended to the transcript (idle) or queued as a pending custom
  message (streaming), so a finishing subagent never interrupts what the main
  agent was doing. It still lands in context.
- **`caller_ping`** (never implemented): a child-to-parent help request was
  explicitly gated on a resume channel *and* on `subagent_wait`, and its own
  notes called the child's willingness to call an unmentioned tool the main
  behavioural unknown.

`subagent`, `subagent_status`, `subagent_cancel`, `subagent_clean`,
`subagent_interrupt` and `subagent_resume` all stay: each is either the core
loop or has no other way to happen.

One defect fixed while removing `wait`: `subagent_status` ignored
`include_output` on the single-run path — the path a model now uses to collect a
result — and always returned the full output plus 18 lines of pane.

Features:

- **`subagent_status` no longer pays for the whole list on every poll.** With
  `subagent_wait` gone, polling is the only way a model collects a result, and
  the list view rendered 18 lines of raw pane for *every* live run — around 70
  lines at the default concurrency, mostly a TUI redrawing itself. The pane
  budget is now on the LIST rather than per run: at most two runs get the full
  block (pane, activity, attach command), chosen live first and newest first,
  and every other run gets one line — id, status, elapsed, usage — which is what
  a poll needs to decide which run to inspect. A new `compact: true` drops the
  detail blocks entirely for a cheap poll. Three rules keep the bound honest: the
  budget goes to the runs that actually hold a pane and never to `queued` ones
  (which have no child, are always the newest, and would spend the budget on
  nothing); a one-line row keeps the one thing that cannot simply be re-fetched,
  the failure reason or an interrupted run's attach command; and when
  `include_output` had to leave an answer out, the reply says how many and how to
  get them. Both flags are list-view controls; the
  single-run path still returns the full record and its output, because that is
  the collection path and must not be made cheaper by a flag.
- **The management tools stop costing every request.** `subagent_status`,
  `subagent_cancel`, `subagent_interrupt`, `subagent_resume` and `subagent_clean`
  are registered with pi's `exposure: "codemode"` when — and only when — the
  session has a way to reach a tool that is not declared. Their descriptions,
  parameter schemas, prompt snippets and guidelines stop riding along on requests
  that never use them (pi filters all four by the declared set), while
  `tool_search` loads one on demand or a codemode script calls it directly.
  `subagent` itself stays declared: it is the entry point, and a model that
  cannot start a run has no reason to search for the tools that manage one.
  - Registration is deferred to `session_start`: pi's `getActiveTools()` throws
    during extension loading, so the question cannot be asked earlier. Registering at load and re-registering later does **not** work —
    pi declares the ACTIVE set, and a tool activated on registration stays active —
    so a single late registration is the only shape that removes the
    declarations.
  - **Fails safe, including after `/tools`.** Any path that cannot answer the
    question — no `codemode`, no `tool_search`, an unbound runtime — leaves every
    tool declared, and the answer is re-checked before every agent turn, because a
    host can switch discovery off mid-session and would otherwise leave all five
    registered as hidden, undeclared and unreachable while `subagent` stayed
    declared. A tool the model cannot find is worse than one it pays for.
  - The "the other tools are hidden" note is added through `prepareLoadout` rather
    than baked into the description, so it costs nothing in the sessions where it
    would be false.
  - To switch it on, add either to your tool set, e.g.
    `"defaultTools": ["+tool_search"]` in `~/.pi/agent/settings.json`. Nothing
    is enabled silently. Use the modifier-only form: `resolveDefaultTools`
    replaces the inherited selection as soon as a list contains any plain name,
    and only treats an all-modifier list as an addition. Measured on pi 1.0.2
    with this extension: `["+tool_search"]` takes the request payload from
    19,578 to 16,000 bytes (~890 tokens) with 0 of the 5 management tools
    declared, while `["+codemode", "+tool_search"]` makes it *worse* (21,809) —
    codemode's own description is 4,933 bytes and every declared tool grows a
    ~52-byte note pointing at it. `codemode.mode: "only"` hides the base tools
    but then lists them all in codemode's description, landing in the same
    place (19,985). So the setting ships as `+tool_search` alone; `+codemode` is
    one entry away for anyone who wants the script workflow.

- **The child publishes what it is doing, and the parent reports it.** A live
  run used to be one undifferentiated "running", which cannot distinguish a
  child that is working from one that wedged on its first token. The child now
  writes a small snapshot to `<runDir>/activity.json` — phase, scope, tool name,
  and a monotonic `sequence` — and `subagent_status` shows the live line
  (`activity: active (bash)`) for non-terminal runs. This is what the status
  widget below is built on; it is also the input to its stall detection.
  - Diagnostic only. Nothing about completion, cancellation or failure depends
    on it, and an unreadable, stale or malformed snapshot degrades to "no
    activity observed" rather than to a wrong status.
  - A phase transition bypasses the 500 ms write throttle; chatty updates inside
    a phase do not. Found while testing: a plain throttle let a run look idle to
    the watcher for a whole window immediately after it started working — the
    one moment the snapshot exists to describe. `settled()` forces its write for
    the same reason the parent treats `result.json` as the completion signal:
    "done" has to be durable before the parent reads it.
  - `runningChildId` and `sequence` are both validated on read, so a snapshot
    left by an earlier child in a reused run dir cannot be attributed to the
    current one, and an older snapshot cannot overwrite a newer one the parent
    already saw. Writes are serialized and atomic; after repeated failures the
    recorder disables itself instead of spamming a doomed path.
- **Live subagent status widget.** A strip above the editor lists every live
  run with what it is doing (`active (bash 45s)`, `waiting 12s`, `stalled 3m`)
  and how long it has been at it, so progress is visible without polling
  `subagent_status`.
  - New pure classifier (`status.ts`): `observeStatus` / `classifyStatus` /
    `advanceStatusState`. Order comes from the child's `sequence`, the monotonic
    counter it stamps on every write, so a replayed or out-of-order snapshot from
    another process cannot rewind a phase — the same rule `subagent_status` already
    applied to the activity snapshot, so the two surfaces cannot disagree.
  - A snapshot that is valid but has stopped being written is a stall. That is
    the case a wedged child actually produces: it keeps reporting its last phase
    forever, so silence is measured from the last write, not from a missing file.
  - Ported from HazAT/pi-interactive-subagents, minus the `source: "pi" |
    "claude"` split (every child here is pi), the config file, the statusline
    formatters, and the interrupt inference.
  - Three policies deliberately differ from the reference. The stall threshold is
    ours (`PI_SUBAGENT_STALL_SECONDS`, default 180). A run inside a tool call gets
    a much longer one (`PI_SUBAGENT_TOOL_STALL_SECONDS`, default 900), because pi
    fires `tool_execution_update` only when a tool produces output — `npm ci` is
    silent for minutes while working perfectly well, and calling it hung is the
    one mistake a status display must not make. And a stall or recovery never
    wakes the parent, which would duplicate the completion notification.
  - Built on pi's native `ctx.ui.setWidget(..., { placement: "aboveEditor" })`,
    installed lazily while a run is live and cleared when the last one finishes,
    with its own 1s ticker so elapsed times move and queued runs (which have no
    watcher of their own) still update. Guarded on `ctx.mode === "tui"`: RPC
    forwards only string arrays and would drop a component factory.
  - Display only: the classifier cannot finish, fail or interrupt a run, and an
    `interrupted` run is reported as such regardless of what its snapshot says.
- **Subagent turn-level interrupt.** New `subagent_interrupt({ id })` tool sends
  Escape (pi's `app.interrupt` — never `C-c`, which quits the child) to the
  child's pane, aborting the in-flight turn while leaving the child alive at its
  prompt with its transcript and tmux session intact. Use it to redirect a run
  that is going the wrong way where `subagent_cancel` would throw it away.
  - The run becomes `interrupted`. It keeps its tmux session, its transcript and
    its concurrency slot until it is cancelled; `subagent_cancel` releases it,
    and `session_shutdown` reaps the idle child (the transcript survives, so the
    run stays resumable).
  - The child reports the abort by writing `<runDir>/interrupt.json` instead of
    a failed `result.json`, and does not shut itself down. `result.json`
    semantics are unchanged, so a run that is interrupted and then finished
    still reports normally. A child launched without the marker path keeps the
    old behaviour (report the abort as a failure) rather than going silent.
  - `interrupted` is *terminal* (`subagent_clean` skips it, a cancelled run never
    revives it) but the child is still alive, so the new
    `holdsChild` predicate guards everything that would destroy or free it:
    auto-reap while the session lives, the concurrency slot, and the guards that
    stop two processes writing one transcript.
  - `subagent_resume` is refused while a run's child is still alive — including
    an interrupted one — because it launches a second pi process on a transcript
    the first one still holds. Attach and type the follow-up there instead, or
    cancel the run first.
  - `subagent_interrupt` never sends two Escapes inside pi's 500ms double-escape
    window (which would open the child's tree selector) and waits up to
    `PI_SUBAGENT_INTERRUPT_CONFIRM_MS` (default 3s, 0 to not wait) for the child
    to confirm. It only accepts a marker newer than the request, so a leftover
    `interrupt.json` from an earlier interrupt cannot confirm a second one.
  - A run whose tmux session is killed by hand while `interrupted` is now failed
    by the watcher instead of being polled forever against a target that cannot
    exist. tmux failures it cannot classify (an unreachable socket, say) are
    tolerated for two ticks and then fail the run as *unreachable* — distinct
    from an exit, which is what the evidence supports.
  - An Escape the child plainly ignored is forgotten once it publishes activity
    newer than the request, so `subagent_status` stops advertising a pending
    interrupt for a child that is simply working.

- **Subagent context handoff.** New `handoff` parameter on the `subagent` tool:
  - `standalone` (default) — unchanged, a fresh session addressed by
    `--session-dir`/`--session-id`.
  - `lineage` — an empty child session whose v3 header records the parent
    session, so pi shows the relationship without sharing context.
  - `fork` — the child is seeded with the parent's live branch, so it already
    knows the task's background.
- **New `subagent_resume({ id, message })` tool.** Reopens a finished run's
  transcript and appends the follow-up, in a fresh tmux session, tracked as an
  incremented attempt.
- **Fixed child usage double-counting.** A forked child inherits the parent's
  transcript verbatim, so summing the whole file charged the child for its
  parent's turns. Runs now record a `usageFromLine` baseline and only the
  remainder is attributed to the run.
- `subagent_clean --delete_files` now reports how many child transcripts it
  destroyed, since those runs can no longer be resumed.

Fixes to the handoff work, from an adversarial review:

- **`subagent_clean` could destroy a live resumed run's transcript.** A resumed
  run keeps its ancestor's transcript, so deleting the ancestor's run dir pulled
  the file out from under a run that was still going. pi holds the descriptor
  open, so the child kept writing to an unlinked inode and lost every entry
  silently. `subagent_clean` now retains a run dir that still owns a live run's
  session file and names it in its output.
- **Two concurrent resumes could append to one transcript.** A finished run
  stays terminal forever, so nothing stopped both resumes from passing the
  "still running" guard; two pi processes then wrote interleaved branches to one
  JSONL. `subagent_resume` now refuses while another non-terminal run shares the
  session file.
- **`subagent_clean` over-reported destroyed transcripts**, counting any record
  with a `sessionFile` rather than one inside the dir being deleted.
- **A fallback reintroduced the wrong-branch trap**: `fork` mode fell back to
  the reopened parent's `getLeafId()`, which is the file's last entry. Fork now
  takes the leaf from the live `ctx.sessionManager` and fails if there is none.
  This also drops a redundant full re-parse of the parent transcript per call.
- `finalizeRun` no longer erases a recorded `sessionFile` when a child reports
  one that is `undefined`.

Fixes found by reviewing that work, before it shipped:

- **A stale `interrupt.json` could confirm an interrupt that never happened.**
  The marker file is never deleted, so a second `subagent_interrupt` on a run
  that was already interrupted read the *first* marker back within a
  millisecond and reported "interrupted" while the child kept streaming. The
  confirmation poll now captures a baseline before Escape is sent and only
  accepts a marker that advances it; a valid-but-older marker is reported as
  stale, which is what it is.
- **Two Escapes inside pi's double-escape window.** On an idle child pi reads
  two Escapes within 500ms as its double-escape action (the session tree by
  default), which blocks the child's prompt without touching the turn.
  `subagent_interrupt` now refuses a second Escape inside that window instead
  of sending it.
- **`subagent_resume` on an interrupted run would have opened a second pi
  process on a transcript the live child still holds** — the interleaved-branch
  corruption the extension's own guard exists to prevent. Resume now refuses
  while a run's child is alive; an interrupted run is steered by attaching, or
  cancelled first and then resumed.
- **An interrupted child would have been orphaned at shutdown.** With
  `PI_SUBAGENT_KILL_ON_SHUTDOWN` off (the default) nothing could reach an idle
  interrupted child once the parent exited, and `subagent_clean` skips it.
  Shutdown now reaps it; killing the tmux session keeps the transcript, so the
  run stays resumable.
- **A run whose tmux session was killed by hand polled forever.** `pane_dead`
  needs a live pane to ask, so a missing target left the watcher re-arming
  every 500ms for the rest of the session while reporting the run as alive. A
  "can't find pane/session" failure now ends the run, and any other persistent
  tmux failure does too after three consecutive ticks, so one hiccup cannot
  fail a healthy child.
- **An `interrupted` run reported itself as idle while it was working.** The
  child can be driven again after an interrupt, so the status line now reads
  the live activity phase instead of assuming, and a second interrupt is
  recorded rather than ignored. An Escape the child plainly ignored (proved by
  activity newer than the request) stops being advertised as pending.
- `PI_SUBAGENT_INTERRUPT_CONFIRM_MS=0` meant 3s, because the positive-only env
  reader rejected it. It is read as a non-negative value now, so 0 means "send
  and do not wait".
- `subagent_resume` no longer copies `interrupts`/`interruptedAt`/
  `interruptRequestedAt` into the new attempt, so a fresh child is not reported
  as interrupted before it has ever been sent a key.

Fixes:

- `persist()` wrote `runs.json` with a plain `writeFile`, so a reader could
  catch the file mid-write and fail `JSON.parse`. It now uses the atomic
  temp-file-plus-rename helper that already existed in the same module. This
  made `lifecycle.test.ts` fail roughly 3 runs in 8.
- `pi --session <missing-file>` does not merely start empty — it invents a new
  UUID, silently diverging from the parent transcript. Resume now verifies the
  file exists and fails loudly instead.

- **`### Unreleased` was nested inside `## v1.0.0`.** Tagging the next version
  would have shipped a section labelled "Unreleased" under the *previous*
  release, and the release after that would have had nowhere to write — the file
  has no top-level place for unreleased work. Promoted to a top-level `##`
  Unreleased above the newest release, which also restores the descending order
  the rest of the file uses. The `v1.0.0` notes are untouched. `AGENTS.md`
  describes the release procedure but never mentioned the structure, so a release
  done by following the docs would have got this wrong silently.
- **The changelog's structure had no test at all.** Nothing in the suite read
  `CHANGELOG.md`, so a heading moving to the wrong level was invisible until
  someone cut a release. `changelog-structure.test.ts` now asserts that
  `## Unreleased` exists once at level 2, precedes every release, is never nested,
  that versions descend, and that a section carries at most one `Added:` /
  `Fixed:` / `Maintenance:` block in that order.

## v1.0.0 — 2026-10-02

Initial tagged release, tracking pi 1.0.0. Contents:

- `answer` extension (`/answer`) with question extraction.
- `native-web-search` extension and matching skill.
- `todos` extension with file-based todo management.
- `subagent` extension: non-blocking delegation of tasks into detached tmux
  sessions, with status inspection, waiting, and cancellation.
