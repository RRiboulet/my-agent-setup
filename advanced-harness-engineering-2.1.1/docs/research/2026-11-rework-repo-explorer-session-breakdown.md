# repo-explorer and session-breakdown: why they are hard to use

> **Status note 2026-11-25:** the `/session-breakdown` half of this document is
> history — the extension was removed from the repo outright (see
> `CHANGELOG.md`, `## Unreleased`). The repo-explorer findings remain the
> evidence for the open tickets under `docs/tickets/harness-advancements/`.

Observed 2026-11-17 on branch `new-tools-investigation` (196 tracked files, 15 branch
menu rows), pi 1.5.2, in the tmux pane this VM gives an agent: **80x24**. Both suites
are green (`repo-explorer-*` 131 tests, `session-breakdown` 34), so nothing below is a
failing test: it is layout, defaults and interaction cost. Line counts come from
rendering the real components in-process; items marked **(suspected)** were not
exercised inside a live pi TUI.

## `/explore` — repo-explorer

**What the user sees.** `/explore` runs the branch selector, then a 20-line browser
(border, breadcrumb, filter input, list, key-hint footer; `file-browser.ts:204-213`).
Enter drills into a folder or finishes a file; Esc clears the filter, then walks up,
then cancels (`file-browser.ts:294-307`). The pick is printed into the transcript as a
numbered message, not an overlay (`index.ts:90-100`). `/explore <path> [branch]` and
`/explore <branch>:<path>` skip both menus (`quick-open.ts:8-16`).

**Why it feels unusable, ranked:**

1. **The menu ignores the branch you are on.** Rows are built in refname order with a
   `(current)` marker, then handed as plain labels to `ctx.ui.select`
   (`branch-menu.ts:74-95, 164-183`), which starts at index 0 and shows 10 rows
   (`ExtensionSelectorComponent`, pi dist bundle). `defaultRef` is computed
   (`branch-menu.ts:126-130`) but only quick-open uses it (`quick-open.ts:212-220`);
   `lastBranch` is passed in and never read (`index.ts:187`). Measured: 15 rows,
   current branch at #12 and off-screen, so `/explore` + Enter browses `bg-acceptance`.
   `branch-menu.ts:5-10` also still claims the selector does not scroll; it caps at 10.
2. **Every pick appends a whole file to the session forever** — up to 2000 lines /
   256 KiB (`git.ts:105-111`), no dedup or budget (`file-transcript.ts:16-19`). Here
   `README.md` is 605 lines and `CHANGELOG.md` 3215 (2000 printed): a stray Enter on
   the root listing floods the transcript, the model context and the bill, and pi
   re-renders those lines every frame on 2 vCPU (`file-transcript.ts:101-104`).
3. **Search is one directory deep and name-only** (`file-browser.ts:253`), so
   `assets/icons/x.svg` means drilling four levels; `rg`/`find`/quick-open are faster.
4. **A failed pick destroys the browser.** `activate` finishes first
   (`file-browser.ts:284-286`) and the read happens after `ctx.ui.custom()` returned
   (`index.ts:119-123`), so a binary, oversized or submodule path shows one notify
   (`index.ts:190-199`) and drops you at the prompt with the navigation lost.
5. **Height is hard-coded.** `MAX_VISIBLE = 12` (`file-browser.ts:81-82`) ignores
   `tui.terminal.rows`, which the component is given; 40 files render 20 lines. The
   editor slot is above pi's footer and the viewport is bottom-anchored, so under ~22
   rows the breadcrumb/filter scroll off the top while still accepting keys
   **(suspected)** — you type into an invisible box.
6. **It shows the tip commit, not the working tree** (`git.ts:253-256`): uncommitted
   edits appear in their old form and untracked files do not exist, yet
   `changedFiles` adds working-tree diffs (`git.ts:453-460`) — a mixed model. The set
   is computed once at open (`index.ts:108-118`); a detached HEAD diffs against `dev`
   (`git.ts:439-450`), painting the whole history red **(suspected)**.
7. **Discoverability.** No README `/explore` section (only a table row,
   `README.md:218`), so the grammar lives in code. `/explore main` is a *file* lookup,
   not a branch (`quick-open.ts:25-28`) while the description says "Browse a branch's
   files" (`index.ts:58`). The only key help is the browser's last line — the line
   lost first in (5).

**Three rework options:**

| Option | Hours | Keeps | Throws away |
|---|---|---|---|
| **A. Delete it; rely on `read`/`rg`/`find`** (or keep only a thin `git show` printer for `/explore <path> [branch]`) | 1-2 | the read-only ref read and the transcript renderer/sanitizer if wanted | branch menu, browser, red colouring, ~1.5k lines and 131 tests |
| **B. Minimal repairs:** current/last branch first, browser stays open on a failed read, list height from `terminal.rows`, path-wide filter | 5-7 | the architecture, sanitizer, transcript, tests | dir-scoped-only filter rule, fixed 12-row list |
| **C. Search-first picker:** one fuzzy list over every `ls-tree` path, preview pane in an overlay, branch-switch key | 12-16 | `git.ts`, `runner.ts`, `sanitize.ts`, transcript | `file-browser.ts`'s directory model and the branch menu |

**Smallest change.** Put the resolved default (current branch, else the last pick)
**first** in `buildBranchMenu` so bare `/explore` + Enter browses HEAD — one ordering
change at `branch-menu.ts:74-95` plus the call at `:177`, ~30 min with the menu test
updated. Then re-open the browser on a failed read (`index.ts:119-123`) and size the
list from `tui.terminal.rows - 8` (`file-browser.ts:82`).

## `/session-breakdown`

**What the user sees.** A progress loader, then an editor-slot component
(`session-breakdown.ts:2036-2097`): tab bar (7d/30d/90d · sess/msg/tok ·
model/cwd/dow/tod), key hints, summary plus inherited-context note, a 7-row
contributions calendar with a right-hand legend, and a metric table. Keys: ←/→ range,
↑/↓ or j/k view, tab/shift-tab or t metric, p providers, q close
(`session-breakdown.ts:1775-1836`).

**Why the graph is unclear, ranked:**

1. **No height budget.** Measured with 8 grouped models at 80x24: 23 lines; at
   `rows=16`: 20 (never fits); at width 40: 27. `tableMaxRows` subtracts a hardcoded
   17 (`:1766-1773`) that omits the inherited note (`:1947-1949`) and the below-graph
   legend fallback (`:1955-1998`). The editor slot is above pi's footer, so at 80x24
   the lines lost first are the tab bar and key hints — the only place the range,
   metric and keys are shown **(suspected)**.
2. **Two encodings, no key.** Hue is a weighted model mix (`:1136-1180`); brightness
   is `log1p(value)/log1p(range max)` with a 0.2 floor (`:1279-1283`). A blended hue
   cannot be attributed to a model, there is no axis or per-day value, and the
   normalisation changes per range, so one day changes shade between tabs.
3. **Palette and legend are pinned to the last 30 days** (`:1732-1734, 1963-1964`): on
   7d or 90d a top model can be grey "other" while the title still says "(30d palette)".
4. **The note contradicts the summary:** `inheritedNote` always prints "last 90 days"
   (`:1512-1535, 1948`) under "Last 7 days: …".
5. **Silent metric substitution.** `tok` with no tokens draws messages/sessions
   (`:1184-1204`) while the tab still highlights tok; per-day hue falls back to
   messages/sessions when tokens are zero (`:1140-1160`), so hue and brightness can
   encode different quantities.
6. **The 7d tab is a sliver**: `cellWidth = min(4, …)` over two week columns
   (`:1915-1925`) gives a ≤9-column block; the calendar only reads well at 90d.
7. **No layout test.** Tests render at `rows: 40` / width 160
   (`session-breakdown.test.ts:570-574, 874-879`); `renderGraphLines` is not in
   `__test__`, and nothing counts lines against the terminal.

**Three rework options:**

| Option | Hours | Keeps | Throws away |
|---|---|---|---|
| **A. 80x24 budget:** render to `rows - 2`, pin header/hints, table rows = remainder (min 0), delete the below-graph legend, note names the selected range | 3-4 | calendar, tables, aggregation | responsive legend and cell scaling |
| **B. Honest encoding:** one metric drives hue *and* brightness, add a scale line, palette per selected range, cursor + per-day readout | 5-7 | calendar, tables, tests | hue-as-model-mix |
| **C. Bars, not a calendar:** per-day ranked bars + the existing tables, no colour-only encoding, fits any height | 8-12 | aggregation, cost, tables | the contributions calendar |

**Smallest change.** At the end of `render`, if `lines.length > terminal.rows - 2`,
drop from the bottom (table rows first, then legend rows) so the tab bar and key hints
never scroll away, and make the note name the selected range. ~1-2 h, no data change.

**The shared cause:** both are editor-slot components that assume a tall pane and
put their only orientation text in the lines that scroll off first. Fix the height
budget and the default selection before touching the data layer.
