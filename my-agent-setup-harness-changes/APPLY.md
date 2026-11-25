# Harness Improvements Bundle

Base commit: `origin/dev` @ `bf91374` (`bf91374eed86c6a011a357f6391d4ef6b9723dd7`)

## How to Apply Cleanly

Option A — apply the complete binary-safe patch:

```bash
git checkout origin/dev
git apply --check changes.patch
git apply changes.patch
```

Option B — copy files and remove deleted paths manually:

```bash
cp -a files/. .
while IFS= read -r path; do
  [ -n "$path" ] && rm -f "$path"
done < DELETED_FILES.txt
```

See `CHANGED_FILES.txt` for the full `git diff --name-status` inventory and `DELETED_FILES.txt` for paths removed relative to `origin/dev`.

## Summary of Changes

- **Subagent hardening** (`.pi/extensions/subagent/index.ts`, tests):
  - Validate explicit `--provider` / `--model` / `PI_SUBAGENT_*` overrides against `modelRegistry` (model existence and configured provider credentials) before launch.
  - Bound `tmux` subprocess calls with `TMUX_EXEC_TIMEOUT_MS`, guard handoff transcript ownership via `runDirOwnsLiveTranscript`, and skip interrupt teardown updates for already-cancelled runs.
  - Add `subagent-clean-cross-session.test.ts` and `subagent-model-validation.test.ts`, plus expanded lifecycle coverage.
- **Orchestrator fixes and codemode exposure** (`.pi/extensions/orchestrator/`):
  - Expose `orchestrator_override` and `orchestrator_wave` under `codemode` when `codemode` or `tool_search` is active, pruning retargeted active tool names.
  - Separate `loopAttemptCap` from settlement `attemptCap` so mid-run loop blocks never consume settlement budget; pair loop-breaker call/result records by `toolCallId` and ignore unresolved calls.
  - Harden `scanEditVerification` matching (`cd <dir> &&` prefix and safe reporter/verbosity flags), UTF-8-safe head/tail truncation with expanded capture buffer in `verify.ts`, untrusted-project config warnings, and peer-message `triggerTurn` in `workspace-runtime.ts`.
- **Wave state machine and gate enforcement replacing `/skill:orchestrate`** (`.pi/extensions/orchestrator/wave*.{ts,mjs,json}`, `.pi/skills/orchestrate/*` deleted):
  - Replace the standalone `.pi/skills/orchestrate` skill with `/orchestrate` and `orchestrator_wave` inside `.pi/extensions/orchestrator/` (`wave.ts`, `wave-runtime.ts`, `wave-ladder.mjs`, `wave-ladder.json`, `wave-tickets.mjs`).
  - Enforce ticket lifecycle transitions, graph cycle/dangling-blocker validation, SHA verification on `record_commit`, `git commit` gating, and active-wave settlement blocking (`block.wave`, default `true`), backed by four new wave test suites.
- **`/btw` teardown race fix** (`.pi/extensions/btw/index.ts`, `btw.test.ts`):
  - Replace `appendFile` with `O_WRONLY | O_APPEND` (`appendExistingAnswer`) so late stream deltas/footers cannot recreate a deleted `answer.md` during teardown.
  - Thread `AbortSignal` through `startViewer`, `runTmux`, and `openBtwPopup` to abort stale launches cleanly.
- **`AGENTS.md` rework and doc drift cleanup** (`AGENTS.md`, `docs/harness/*.md`, `README.md`, `package.json`, `.gitignore`):
  - Extract detailed harness references into `docs/harness/{branches,extensions,github-auth,reviews,skills,subagents,testing}.md` and tighten `AGENTS.md` to concise rules and pointers.
  - Track `.pi/settings.json` in `.gitignore`, remove stale `.pi/skills/orchestrate` from `package.json`, and update `README.md` skill/extension documentation and index tests.

## Verification Commands (`AGENTS.md` `## Tests`)

```bash
bash .pi/extensions/subagent/test/setup-deps.sh              # once: link pi's packages
node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts
(cd .pi/extensions/opencode-go-provider && node --test)  # provider package tests (separate tree)
node --test .pi/skills/prevent-recurrence/scripts/test/*.test.mjs  # rule-table checker
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md  # the rule table; must exit 0
node tools/skills-index.mjs --check                     # the README's skill index; must exit 0
node --test tools/bench/run.test.mjs                     # bench runner tests
node --test tools/mcp-catalogue.test.mjs                 # catalogue install tests
node --test tools/branch-base.test.mjs                   # branch-base check tests
node tools/branch-base.mjs                               # the branch-base rule; must exit 0
```
