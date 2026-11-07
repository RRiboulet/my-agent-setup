# Follow-up fixes from adversarial review (dev commits)

Source: adversarial subagent reviews of commits on `dev` ahead of `main` (v1.10.0).
Reviews run with `opencode-go/beam-free` (max thinking). This file documents
proposed changes; none have been applied yet.

Scope:
- `77aa5bb` feat(skill): manage git worktrees for independent tasks (#100)
- `bb2bfc3` / `093621c` / `aecb04c` voice f-keys, opencode-go reasoning/thinkingLevelMap, add-model skill
- `1326f83` fix(devcontainer): advertise truecolor to programs inside tmux (#96)

---

## A. Worktree skill (`.pi/skills/worktree/SKILL.md`, `worktree-skill.test.ts`)

### A1. Remove / branch-cleanup / end-state blocks must run git against main root (High)
- **Where:** SKILL.md lines ~306-347 (Remove, branch-cleanup, prune, end-state).
- **Problem:** blocks resolve `R` only to build `$WT`, then call bare `git worktree remove "$WT"`, `git branch -D "$SLUG"`, `git worktree list`, `git worktree prune -n`, `git branch --list "$SLUG"`. Run from a stale/deleted worktree cwd, `git` cannot run (`fatal: Unable to read current working directory`) and the block silently no-ops.
- **Fix:** prefix with `git -C "$R"` (or `cd "$R"`), consistent with Open/Review blocks.

### A2. No `set -e` in recipes; failures swallowed (High)
- **Where:** SKILL.md Create ~96-140, Remove ~306-316, end-state ~342-347.
- **Problem:** a failed `git worktree remove` (dirty tree) is followed by `rmdir -p … || true`, so the block exits 0 and looks successful while the worktree remains.
- **Fix:** add `set -e` (or `&&` chains) to each block; make dirty-refusal the intended stop.

### A3. End-state check does not guard empty `SLUG` (Medium)
- **Where:** SKILL.md ~343-347.
- **Problem:** `SLUG=""` makes `git branch --list ""` print nothing and exit 0 → vacuously passes.
- **Fix:** add `: "${SLUG:?SLUG must be set}"` (and update the test's expected string).

### A4. `awk -v wt="$WT"` mangles backslashes; duplicate kill-session (Low)
- **Where:** SKILL.md ~309-311.
- **Problem:** `awk -v` interprets C-style escapes; a path with a backslash corrupts `wt`. Multi-pane sessions emit duplicate session names → repeated `kill-session` spam.
- **Fix:** pass `wt` via `ENVIRON`/environment; `sort -u` before the loop.

### A5. Base hygiene accepts a local branch ahead of origin/dev without warning (Low)
- **Where:** SKILL.md ~113-123.
- **Problem:** ancestor check only rejects bases not descending from origin/dev; an unpushed local branch passes silently.
- **Fix:** document the asymmetry or gate on `origin/dev..$BASE` being empty.

### A6. Detached worktrees (`-d`) break Review/Remove (Low)
- **Where:** SKILL.md ~256-275, ~325-329.
- **Problem:** no `$SLUG` ref, so `origin/dev…$SLUG` and `git branch -D "$SLUG"` fail.
- **Fix:** document branch-only scope, or resolve branch via `git -C "$WT" branch --show-current`.

### A7. Ignore guard operates on cwd's `.gitignore` (Low)
- **Where:** SKILL.md ~40-43.
- **Problem:** running from a linked worktree edits that tree's `.gitignore`.
- **Fix:** resolve main root first.

### A8. Subagent delegation example hardcodes `/workspace` (Low)
- **Where:** SKILL.md ~242.
- **Fix:** use `<repo-root>/.worktrees/…`.

### A9. Test coverage gaps (worktree-skill.test.ts)
- Static substring checks cannot catch A1-A8. Add assertions for `git -C "$R"`, empty-SLUG guard, and (ideally) execute recipes in scratch repos.

---

## B. Truecolor devcontainer (`.devcontainer`, `bin/devc`)

### B1. Misleading comment in tmux.conf (Medium)
- **Where:** `.devcontainer/shell/tmux.conf` lines 13-18.
- **Problem:** claims `terminal-features` is what tmux hands to inner programs; empirically inner `TERM` stays `tmux-256color` and `tput colors` = 256. What flips pi is `setenv COLORTERM/PI_TRUE_COLOR`.
- **Fix:** correct the comment.

### B2. No version guard for `terminal-features` / `terminal-overrides` (Medium)
- **Where:** `.devcontainer/shell/tmux.conf`.
- **Problem:** `terminal-features` requires tmux ≥3.2; older tmux refuses to parse the config → breaks subagent server startup.
- **Fix:** guard the two lines behind a version check like `extended-keys-format`.

### B3. `*` wildcard forces truecolor for all outer terminals (Low)
- **Where:** same.
- **Problem:** SSH from a non-truecolor client gets RGB sequences it can't render.
- **Fix:** restrict to known truecolor terminals or document accepted risk.

### B4. Stale tmux-server environment after config change (Low)
- **Where:** operational.
- **Problem:** `setenv -g` only affects new panes; existing subagent server keeps old env.
- **Fix:** document `tmux -S … kill-server` in SKILL.md troubleshooting.

### B5. `bin/devc` DRY_RUN output stale (Cosmetic)
- **Where:** `bin/devc` attach_shell.
- **Fix:** update printfs to reflect injected `--remote-env`.

### B6. Verify `PI_TRUE_COLOR` is consumed by pi (Open question)
- Check pi's dist (`terminal-image.js` `detectCapabilities`) confirms `PI_TRUE_COLOR=1` flips `trueColor`. Already verified by reviewer; no change needed.

---

## C. Voice / opencode-go / add-model

### C1. `transformApiModel` out of sync with real live API shape (Medium)
- **Where:** `.pi/extensions/opencode-go-provider/index.ts` ~186-240.
- **Problem:** uses `apiModel.provider?.npm` (always undefined) → every live model becomes `openai-completions` / `zen/go/v1`; cost reads flat `apiModel.cost?.input` (real shape is `cost.text.input.price`); `input` filters exact `"image"` (API reports MIME types).
- **Fix:** parse `api["chat-completions"/"messages"].base_url`, nested `cost.text.*.price`, and `image/*` MIME prefixes. Align with add-model skill docs.

### C2. `loadStaleModels` does not refresh stale cached entries (Medium)
- **Where:** `index.ts` ~362-373.
- **Problem:** cached entries keep old reasoning/thinkingLevelMap until revalidation succeeds.
- **Fix:** refresh only `reasoning` + `thinkingLevelMap` from embedded (avoid clobbering cost/contextWindow that caused the #97 revert).

### C3. Curated reasoning never updates from live (Low-Medium)
- **Where:** `mergeWithEmbedded` ~297-298.
- **Problem:** `...embedded` overwrites `reasoning` with curated value; a model losing reasoning support upstream keeps `reasoning: true`.
- **Fix:** decide policy; optionally override when live says `supported: false`. Document.

### C4. `toggle: true` on claude-haiku not mapped to `off` (Low)
- **Where:** `transformApiModel` ~204-207.
- **Problem:** no `"none"`/`"off"` effort advertised → `off` level not available.
- **Fix:** investigate whether toggle should imply an `off` mapping.

### C5. add-model skill: `supportsStrictMode` not consumed by pi (Low)
- **Where:** `.pi/skills/add-model/SKILL.md`.
- **Fix:** remove from "minimum" list; keep `supportsStore`, `supportsDeveloperRole`, `maxTokensField`.

### C6. add-model skill: contradictory baseUrl guidance (Low)
- **Where:** same.
- **Fix:** pick canonical (`inference/go/...` vs `zen/go/v1`) and state the other is an alias.

### C7. add-model skill wording overstates curation (Low)
- **Where:** same.
- **Fix:** clarify `thinkingLevelMap` is embedded-first with live fallback.

### C8. add-model skill: patch.json caveat for custom models (Low)
- **Where:** same.
- **Fix:** one-line caveat that patches can refine custom-model entries.

---

## Priority order

1. C1, C2 (opencode-go correctness — affects live/API-only models)
2. A1, A2, A3 (worktree safety — silent no-ops)
3. B2, B1 (truecolor guard + comment)
4. A4-A8, B3-B5, C3-C8 (hardening/docs)

## Not in scope here

- Brave web-search follow-ups are tracked in PR #101 (draft) and its review notes.
