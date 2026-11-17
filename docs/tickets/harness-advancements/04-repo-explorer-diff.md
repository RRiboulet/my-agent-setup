# 04: repo-explorer becomes `/diff` plus a browser that never eats the chat

**Blocked by:** 00 (trial protocol and baseline)
**Status:** ready
Evidence: `docs/research/2026-11-rework-repo-explorer-session-breakdown.md`,
`docs/research/2026-11-harness-advancements.md#4-repo-explorer-diff--explore-ticket-04`

## What to build

The user's symptom is confirmed in code:

- **Wrong branch on Enter.** `buildBranchMenu` computes `defaultRef`
  (`branch-menu.ts:129`); `chooseBranch` calls `ctx.ui.select` without it
  (`:177`), and `ctx.ui.select` has no preselect argument in pi 1.5.2. Rows are
  in refname order, so in a 15-branch repo Enter opens `bg-acceptance`, not
  HEAD. The fix is to reorder the rows (current branch first) or use
  `ctx.ui.custom` with a preselected index.
- **Every pick is a context dump.** `printFile` sends the whole file (up to
  2,000 lines / 256 KiB) through `pi.sendMessage(..., {display: true})`
  (`index.ts:90,99`; cap in `file-transcript.ts:17`), so it lands in the
  transcript and the model context. `CHANGELOG.md` is one Enter away from
  2,000 lines.
- **Diffs are invisible.** `readFile` reads the branch tip (`git.ts:253-254`),
  so uncommitted edits never appear, and there is no diff renderer at all.

Split the two jobs and stop printing into the conversation. Land the
branch-ordering fix as the **first commit**, so the biggest usability bug is
gone even if the rest slips. A global cap on how much a tool result may append
to the transcript is a ~1 h stopgap, but it does not give you diffs; the split
below is the actual fix.

## Scope

Owns (`.pi/extensions/repo-explorer/` and its tests):

- **`/diff`** — changed files first: staged, unstaged, and untracked against
  HEAD (or an explicit `--base <ref>`), with a file-count summary. Enter opens a
  real unified diff in an overlay, not the transcript. A key cycles file ↔ diff,
  a key toggles context lines, and `s` is the only way a file or diff reaches the
  agent (`pi.sendMessage` with `triggerTurn: false`). A diff is capped like a
  file read (2,000 lines / 256 KiB) and says when it truncated.
- **`/explore`** — search-first fuzzy picker over the **working tree**, preview
  in an overlay, Enter opens the file in the overlay; `s` sends to the agent.
  "Working tree" means the files a human would edit: uncommitted and untracked
  files exist, and for a non-HEAD ref the picker resolves that ref's tree
  instead. The branch menu puts the current branch first (so Enter is HEAD),
  and the browser sizes its list from `terminal.rows`, not a hardcoded 12.
- Carry the existing `ctx.mode !== "tui"` guard into both commands: RPC has
  `hasUI` but cannot drive `ctx.ui.custom`.
- One shared diff/read layer, so `/diff` and `/explore` cannot disagree about a
  file's content. `readFile` grows a source selector: `HEAD`, a refname, or the
  working tree; the current tip-only behaviour is reachable but no longer the
  default.
- A failed read (binary, oversized, submodule) keeps the browser open and shows
  the reason; it does not close the surface.

Leaves for later: blame, inter-branch diff navigation, syntax highlighting,
tree-sitter, a git-status dashboard. A generic per-result transcript cap belongs
to a tool-result pruner, not this extension; it is a stopgap only.

## Acceptance criteria

- [ ] `/explore` + Enter on a 15-branch repo opens the current branch, and the current branch is the highlighted first row.
- [ ] Viewing a file or a diff appends **nothing** to the transcript or model context; only `s` does, and a test asserts `sendMessage` is not called on view.
- [ ] `/diff` shows uncommitted and untracked files and a unified diff for each; a file changed only in the working tree is visible, which the current implementation cannot do.
- [ ] A diff over the 2,000-line / 256 KiB cap truncates with a notice and still renders the first page.
- [ ] Both commands report "requires interactive TUI mode" outside TUI, rather than dropping the custom component silently.
- [ ] At 80×24 and at 40×16 the filter, list, tabs, and hints fit without scrolling; the list height derives from `terminal.rows`.
- [ ] A binary file, a >256 KiB file, and a submodule path each show a reason and leave the browser usable.
- [ ] The trial protocol from ticket 00 answers "what changed in this branch and what does the diff say" in fewer keystrokes and less time than the baseline, on 5 trials.

## Validation

- Render the browser and the diff at 80×24 and 40×16 in tests; the suite
  currently only fixes width 80 and a 6-file fixture.
- Walk the three real cases from the audit: `CHANGELOG.md` (oversized), an
  untracked file, and a branch 12 rows down the menu.
