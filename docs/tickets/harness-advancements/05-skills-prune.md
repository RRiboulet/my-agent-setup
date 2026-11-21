# 05: Skills become consistent and concise, and the loop's defaults actually trigger

**Blocked by:** 00 for the model-run harness only; `tools/bench/skills.mjs`
landed in #162, so the per-skill part is unblocked.
**Status:** in progress — step 0 and the `worktree` split landed in this branch.
**Re-scoped 2026-11-21** from "23 skills become ~15" to "consistent, concise,
correctly triggered". The skill count is an **output**, not a target: it is 25
today (24 + `writing-for-agents`) and every one of them is kept.
Evidence: `docs/research/2026-11-harness-advancements.md#5-skills-prune-merge-split-ticket-05`

## Why the old shape was wrong

The old ticket assumed dormancy and aimed at ~15 skills. The measurement does
not support either. Re-measured 2026-11-21 after adversarial review; **re-measure
again when executing**, because `tools/bench/skills.mjs` counts any read, edit or
write under `.pi/skills/<name>/` (`skills.mjs:12`), so skill work inflates the
very skills it ranks — the same run moved from 229 to 241 loads in twenty
minutes while four subagents read skill files.

| Claim | Measured |
|---|---|
| 23 skills, 2,887 body lines | **25 skills, 3,222 + the new skill** |
| 22 `SKILL.md` reads across 16 sessions | **241 loads across 242 sessions** (`--all`) |
| one 623-line skill | `worktree` was **630 lines / 32,235 B** |

Pruning has no target under the ticket's own rule ("a zero-load skill that is
kept needs a workflow reference, not sentiment"): the four zero-load skills are
all routed — `tdd` (AGENTS.md, `implement`, `prevent-recurrence`), `blast-radius`
(AGENTS.md, `implement`, `to-tickets`, `prevent-recurrence`),
`benchmark-checklist` (AGENTS.md, `diagnosing-bugs`), `idempotent-operations`
(AGENTS.md, `implement`). Reaching ~15 would mean deleting skills that load.

The cost is not the count. It is **bytes per load**, concentrated:

| Skill | Loads × `SKILL.md` bytes | Share |
|---|---:|---:|
| `worktree` | 41 × 32,235 = 1.32 MB | **47.8%** |
| `devcontainer` | 51 × 8,903 = 454 KB | 16.4% |
| `prevent-recurrence` | 13 × 14,384 = 187 KB | 6.8% |
| `update-changelog` | 18 × 8,173 = 147 KB | 5.3% |
| `commit` | 19 × 6,606 = 126 KB | 4.5% |

**This is a prioritization proxy, not context cost.** It is cumulative bytes over
the window; `worktree`'s 1.32 MB is ~280 K tokens, ~1.2 K tokens per session on
average. The split is justified by the per-load size, not by the headline share.
The always-on surface is **6,558 bytes of descriptions** across the 24 existing
skills, with no cap and two description shapes (16 say `Use when:`, 8 do not).

## Decisions taken (2026-11-21)

1. The goal is consistency and concision, not a skill count.
2. Keep every skill, and make the under-triggered ones **more triggerable**;
   `tdd` is the worked case and should be the *default* implementation style.
3. `in-your-own-words` and `grilling` stay separate; tighten both descriptions.
4. Cheap routing spot-check now; a 12-prompt × 3-model A/B later.
5. Each split skill uses **fewer, grouped** reference files.
6. Description caps: **250 B model-invoked, 150 B user-invoked**, enforced by a
   test rather than review.

## Step 0 (done in this branch): `writing-for-agents`

Installed from the commit already pinned in `licenses/NOTICE.md` (`4ae2317`),
`skills/productivity/writing-for-agents/`:

- `.pi/skills/writing-for-agents/SKILL.md` (upstream body plus an H1, the one
  change) and
  `references/skill-mechanics.md` — the mechanics file moved under `references/`
  and lowercased to match `prevent-recurrence/references/` and
  `tdd/references/`, and so the "every `references/*.md` is linked" assertion
  below covers it.
- Description rewritten to the house form, **202 B**: "Writing the documents an
  agent consumes — skills, AGENTS.md and CLAUDE.md, and docs reached by a
  pointer. Use when: writing or editing a skill, or changing a rule or pointer
  in AGENTS.md or CLAUDE.md."
- Upstream's `agents/openai.yaml` is another harness's interface metadata and is
  not installed; recorded in NOTICE.
- Model-invoked: the trigger is agent-noticed mid-task work, and
  `prevent-recurrence`'s last rung edits skill prose and an `AGENTS.md` row.
- Registered in `package.json`, `README.md`, `licenses/NOTICE.md` (intro count
  and per-skill row), `coding-skills.test.ts` (`PORTED`) and one AGENTS.md
  routing bullet.
- Overlap with `prevent-recurrence` is split by role in both bodies: that skill
  decides **which level** a lesson lands on and records the row; this one decides
  **how that line is worded** and where it sits on the hierarchy.

## Move 1: split the oversized bodies

### `worktree` — done in this branch

Body **147 lines / 8,483 B** (was 630 / 32,235; −74%), keeping the intro,
**What lives where** (the pointer table), **Location convention**, **Safety
rules**, *Choosing between worktree and branch* and *When NOT to use a worktree*,
and **Cross-references**.

| Reference | Lines | Bytes | Load when |
|---|---:|---:|---|
| `references/lifecycle.md` | 313 | 15,335 | creating, listing, opening, moving or removing a worktree |
| `references/review-repair.md` | 114 | 5,159 | inspecting what a worktree changed, running its tests, or repairing after the main checkout moved |
| `references/parallel.md` | 98 | 5,118 | more than one agent works at once: subagent `cwd` rules and the duplicate-extension failure |

Preservation checked mechanically: all 12 original headings present, 2 added
(`What lives where`, `Delegating to a subagent rooted in a worktree`), and all
**22 code blocks byte-identical** to the original. Three pointers that crossed a
file boundary now name their anchor instead of saying "above"/"below":
`review-repair.md § Review` (from Open), `lifecycle.md § Create` (from Review),
`lifecycle.md § Remove` (from Repair), and `lifecycle.md` (from the delegation
paragraph). **Rule for the remaining split: a moved reference names its anchor,
never "the table above".**

### `add-model` — deferred, with line-level boundaries

327 lines / 16 KB, 4 loads. Section names are not enough; the first attempt's
grouping cut a subsection off its parent:

- **The payload is untrusted** (`:124`) is a `###` *inside* **What the user must
  provide** (`:60`) and its last line (`:145`) points at "the reasoning row of the
  table above". Move the parent and the subsection together, or neither.
- **The edit skeleton** stays in the body while **Manual edit** (`:147-181`) was
  to move — but the skeleton *is* that section's content. Pick the line where the
  workflow ends, not the section title.
- Target body ≤ 120 lines; references `editing.md` (the edit walkthrough,
  alternative edits, after-editing checks, pitfalls) and `catalog.md` (cost
  tiers, deprecating a model) — boundaries to be fixed at execution, by line.

## Move 2: one description contract, enforced by the test

- **Model-invoked (20):** `<what it does, one clause>. Use when: <broadest true
  trigger first>; <narrower>; <narrower>.` — **≤ 250 B**, no other skill's name,
  no paths, no line counts.
- **User-invoked (5):** `User-invoked /skill:<name>: <what it does and when to
  reach for it>.` — **≤ 150 B**.
- Frontmatter `description` stays double-quoted in all of them (already uniform).

New assertions in `.pi/extensions/subagent/test/coding-skills.test.ts`:
description byte cap by class; `Use when:` present for model-invoked; no
description names another skill; **every `references/*.md` is linked from its
`SKILL.md`** (the existing walk catches a dead link but not an unreachable
file — the bug `teach`'s orphaned `GLOSSARY-FORMAT.md` had);
`worktree/SKILL.md` and `add-model/SKILL.md` ≤ 150 lines.

The 250/150 caps are worth ~2 KB of the 6.5 KB always-on surface (~500 tokens):
**the value is consistency, the saving is small.** Say so rather than selling it
as a win.

## Move 3: triggerability, with `tdd` as the worked case

Today `tdd` is gated on "a testable seam" in both routing surfaces
(`AGENTS.md:237`, `implement` §4), while the body is what decides whether a
practical seam exists (`## When a failing test is impractical`). The gate fires
before the judgement it depends on, and the skill has **0 loads in 242
sessions**. Its description (420 B) lists four branches that miss the shapes this
repository actually works in (a CLI flag, a UI change, a script, a migration), and
its bug branch is already given to `diagnosing-bugs` by the routing table.

Five edits, revised after review:

1. `tdd` description — default first, ≤ 250 B, keep the user-ask branch:
   "The default implementation style for new or changed behavior: … Use when:
   implementing any behavior change, fixing a bug with a test path, or when the
   user says TDD, red-green or test-first."
2. `AGENTS.md:237` — `Any new or changed behavior — the default implementation
   style: `tdd`. For a bug, `diagnosing-bugs` first.`
3. `AGENTS.md:228` — write the trivial-edit boundary as **judgement**, not as a
   rule: trivial means no behavior observable at a seam (typo, comment, private
   rename, dependency bump, release-note edit). AGENTS.md says prose is a rule
   only once a table row enforces it, and no test can decide this one.
4. `implement` §4 — matching wording, and **not** "load `tdd` first": §2
   (`blast-radius`) and §3 (`idempotent-operations`) legitimately run earlier.
5. `tdd` body `:52` — add "no behavior at all" and "already covered by an
   existing test" to the exceptions, and require the one-line reason the
   `## Report` section already demands. This is where a wrongly-loading `tdd`
   gets rejected; AGENTS.md prose cannot do it.

Same audit for the other three: the first trigger clause in each description
becomes the broadest true one.

## Move 4: prune zero, recorded

One row per skill in this ticket: kept / split / why. The four zero-load skills
keep their routing reference, named. The "~15" target is deleted.

## Move 5: cheap routing spot-check (Move 3 only)

Six prompts, one model, recorded **before and after the Move 3 wording change**.
It validates the trigger rewrite, **not** the Move 2 descriptions — every prompt
below routes through the AGENTS.md/`implement` lines that Move 3 edits, so a
delta cannot be attributed to Move 2.

| task | prompt | expected pick |
|---|---|---|
| `tdd-cli-flag` | "add a `--since` flag to the CLI" | `tdd` |
| `idempotent-retry` | "the webhook consumer double-charges on retry" | `idempotent-operations` (+ `tdd`) |
| `trivial-rename` | "rename this variable and update the comment" | none |
| `blast-radius-schema` | "read this schema change and tell me what else breaks" | `blast-radius` |
| `benchmark-number` | "the p50 in my benchmark looks 30% better" | `benchmark-checklist` |
| `recurrence-timeout` | "I keep having to tell you to add a timeout" | `prevent-recurrence` |

Built as six `tools/bench/tasks/*.json` files for the existing runner (which
already records `metrics.skillLoads`), not as prose. Name the model in the
result. Budget more than the 0.5 h the first draft assumed.

## Measurement support

Extend `tools/bench/skills.mjs` with per-skill `descBytes` and `bodyBytes` in the
table and `--json`. Also record whether a load was a `SKILL.md` read or another
file under the skill directory, so skill-development sessions stop inflating the
ranking. Loads stay a two-week follow-up check, never the gate for a wording
change.

## Acceptance criteria

- [x] `writing-for-agents` installed from the pinned commit, in `references/`
      form, registered in `package.json`, README, NOTICE and the classification
      test, links resolving.
- [x] `worktree/SKILL.md` ≤ 150 lines with three grouped references, every path
      resolving and each linked with its load condition.
- [ ] `add-model` split at line-level boundaries, ≤ 150 lines.
- [ ] Every description meets its class cap and shape; total description bytes
      recorded before and after (baseline **6,558 B**).
- [ ] The four new assertions exist and fail on a planted violation (300 B
      description, missing `Use when:`, another skill's name, unlinked
      `references/*.md`), then pass on this tree.
- [ ] `tdd` is the default in its description, its body, `implement` §4 and
      AGENTS.md, with the judgement-only trivial boundary and the extended
      exception list.
- [ ] Routing tasks recorded before and after, with the delta and the model.
- [ ] Per-skill verdict table, and the recorded decision that the count is 25.
- [ ] `node --test .pi/extensions/subagent/test/coding-skills.test.ts`,
      `node --test .pi/extensions/subagent/test/package-manifest.test.ts` and
      `node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md`
      all exit 0.

## Non-goals

No merges (`in-your-own-words` + `grilling` stay separate), no new skills beyond
step 0, no deletions, no real routing A/B, no change to the review policy, no
rewording that widens or narrows a skill's actual scope.

## Order and cost

~~0.5 h~~ step 0 and the `worktree` split: **spent**. Remaining: `add-model` 1.5 h
· descriptions 2 h · `tdd`/`implement`/AGENTS 1 h · assertions 1 h · routing
tasks 1 h · re-measure and docs 1 h.
