# Orchestrate: tiered subagent dispatch over a ticket graph

## Objective

As a user breaking work into tickets, I want a dispatcher that sends each ticket
to a subagent whose model matches the ticket's complexity — running cheap work on
cheap models and reserving the strong model for tickets that earn it — without
me choosing the model per ticket or babysitting failures.

The value is the *floor*: a hard ticket that a cheap model would quietly fumble
is recognized and re-run on a stronger model, so a completed run means every
ticket either genuinely passed its validation or is explicitly marked blocked
with a reason.

## Current behavior

Six facts, each verified in the repository or harness today:

1. **No complexity→model mapping exists anywhere.** Skills decide *how* work is
   done; the `subagent` extension's fan-out plans accept per-step `model` and
   `thinking` overrides but nothing here assigns them. Every dispatch is made by
   the dispatcher's own judgment, invisibly in the transcript.
2. **An `orchestrator` extension already exists** (`.pi/extensions/orchestrator/`):
   a settlement gate, bounded stronger-model advisor, verification runner, and
   workspace reservations at the *session* level. It decides whether a session
   may settle. It has no concept of subagent types or tiers and is untouched by
   this spec except as prior art for vocabulary (role, gate, reservation).
3. **`to-tickets` emits one prose markdown file per ticket** in a `tickets/`
   folder, with `**Blocked by:**` edges, `**Status:** ready`, acceptance
   criteria, and a `Validation` section — a task graph in prose.
4. **The enabled model set is entirely cheap**: `beam-free`,
   `deepseek-v4.1-flash`, `glm-5.3-flash`, `hy4-flash-free`. `glm-5.3` and the
   decision models (`typesafe/jev-1.13`) exist in provider catalogs but are not
   in `enabledModels`.
5. **`triage_change` in the harness already routes through a calibrated decision
   model (Jev)** — the pattern this design adopts for per-ticket triage.
6. Wave orchestration has working primitives: `subagent_wait({ids, plan})`,
   `subagent_status`, `orchestrator_reserve`, worktrees.

## Required behavior

1. **Orchestrate invocation.** A user runs `/skill:orchestrate` naming a ticket
   folder (or the spec's `tickets/` folder). The orchestrator parses the graph,
   sanity-checks it (cycles, dangling blockers), and reports the graph before
   dispatching.
2. **Per-ticket complexity triage.** Every ready ticket is classified before
   dispatch by a dedicated call to a calibrated **decision model** (Jev-class,
   e.g. `typesafe/jev-1.13`), which assigns one of three complexity tiers and a
   one-line justification. A ticket's structured `tier-override` header field
   overrides classification. The triage decision is recorded — never made
   invisibly.
3. **Tiered dispatch.** Each roster type dispatches with a *(model, thinking)*
   pair taken from a one-source-of-truth `ladder.json`; nothing dispatches from
   ad-hoc judgment.
4. **Quality-floor escalation.** A crashed run retries once at the same tier,
   then escalates one tier. Tier-1 output additionally passes a reviewer gate
   that can vote to escalate. A ticket whose escalation target fails is marked
   `blocked` with a reason and never half-lands. Tier-2+ output is ungated.
5. **Verified-only landing.** A ticket is committed only after its ticket file's
   `Validation` section passes under the verifier. Commits are made serially by
   the orchestrator, citing the ticket number. Implementers never commit.
6. **Observable progress.** Ticket files' `Status` fields are updated in place
   (`ready → in-progress → done/blocked`), so a user can grep status mid-run.
   The run ends with a closing report: per-ticket tier, gate verdicts,
   escalations, and blockers.
7. **Done-when**: every ticket is `done` or explicitly `blocked` with a reason;
   the closing report exists.

## Non-goals

- No new orchestrator engine: nothing replaces pi's subagent extension or the
  existing settlement-gate/orchestrator extension; this spec layers dispatch
  policy on top.
- No decomposition: the orchestrator does not split or reshape work —
  garbage-in tickets dispatch as-is (triage may flag, never rewrite).
- No model auto-cycling, no cost tracking, no provider discovery.
- No cross-repo / issue-tracker orchestration (file-based tickets only).
- No enforcement extension in the first pass — advisory skill first,
  enforcement later, against the same `ladder.json`.

## Constraints

- All tier models must be free-tier (the current provider catalog); the ladder
  is capability/latency-driven, not cost-driven.
- `enabledModels` scopes startup model selection and cycling; Tier 3 is
  already covered (`mistral/zai-glm-5-3`, enabled). The remaining question is
  the decision model (see Open assumptions).
- The orchestrator is advisory in pass one: the skill steers; nothing in this
  spec permits an extension to block a dispatch.

## Design decisions

### The ladder (`ladder.json`, single source of truth)

Lives next to the skill at `.pi/skills/orchestrate/ladder.json`; readable by
both the skill prose and a future enforcement extension. Encodes:

- the roster (`triage`, `researcher`, `implementer`, `reviewer`, `verifier`),
  each excluded `triage`;
- three tiers as *(model, thinking)* pairs:
    - **Tier 1** a free-tier model (`hy4-flash-free`, `beam-free`, `glm-5.3-flash`
    are the candidates) @ `max` thinking — trivial tickets, the exception kept
    for the cheapest duty; capability comes from deliberation, not model size
  - **Tier 2** `deepseek-v4.1-flash` @ `medium` — the workhorse; ~most tickets
    land here, subagent-dispatched work is "pretty much always" this tier
  - **Tier 3** `mistral/zai-glm-5-3` @ `high` — escalation target; the mistral
    provider's GLM entry is already enabled, so Tier 3 dispatches today
- per-type overrides: `triage` pinned to a Jev-class **decision model**
  (`typesafe/jev-1.13`), `reviewer` and `verifier` pinned to **Tier 2**, with
  `verifier` pinned to thinking `high` — its pass/fail verdict authorizes the
  commit, and a Tier 1 model is most prone to hallucinating green.

While every tier model is free, the quality dial is thinking, not spend: Tier 1
spends deliberation (`max`) on small work; Tier 2 stays at `medium`; only Tier 3
runs at `high`. The global `high` default stops being the baseline every task
pays.

### Ticket-file contract (to-tickets template extension)

Each ticket file gains YAML frontmatter (`status`, `blocked-by`, optional
`tier-override`) alongside the existing prose sections; the orchestrator parses
frontmatter, never prose. Graph sanity-check (cycles, dangling blockers) runs
before any dispatch and the parsed graph is reported to the user first.

### Dispatch and escalation policy (quality floor first)

- **Triage first**: every ready ticket is classified by the pinned decision
  model, which assigns a tier and one-line justification; a `tier-override`
  header field overrides classification. Triage decisions are recorded.
- **Crash**: retry once at the same tier, then escalate one tier.
- **Silent failure**: Tier-1 output passes a `reviewer` gate pinned to Tier 2 —
  an independent grader, since a same-weight model re-reading its own contribution
  finds the same blind spots it wrote past. A gate vote escalates one tier.
  Tier-2+ output is ungated.
- **Exhaustion**: a ticket whose Tier 3 run fails is `blocked` with a reason and
  never half-lands. Cost is recoverable; a silently-wrong hard ticket is not.

### Write safety in a wave

Parallel implementers each **reserve their ticket's file scope** before editing
("worktree"-scoped reservations); a ticket whose scope overlaps a live
reservation is held for the next wave rather than forced. Tickets whose blast
radius spans many files (recognizable from `blast-radius` findings recorded in
the ticket or spec) are opt-in single-runner worktrees instead.

### Skill payload by reference

Dispatched task text references skills by name ("work per `tdd`; validate with
`prove-it-works`") rather than inlining instructions — subagents load skills
from the same package, so references can't drift. Keep task text small.

### Bookkeeping

The orchestrator updates each ticket file's `**Status:**`/`status` field in
place (`ready → in-progress → done/blocked`); ticket files are the mid-run
status surface (`grep -r Status docs/tickets/`). Done-when: every ticket `done`
or `blocked` with a reason; the run closes with a report — per-ticket tier, gate
verdicts, escalations, blockers.

### Alternatives rejected

- *Complexity in the roster* (`quick-researcher` vs `deep-researcher`): doubles
  the type list; escalation becomes a type change. Type = capability, tier =
  quality knob, always orthogonal.
- *Orchestrator LLM self-judgment* for triage: invisible in the transcript,
  drifts with the dispatcher model.
- *New orchestrator engine*: reimplements concurrency, retries, persistence
  the subagent extension already ships.
- *Worktrees for every implementer*: merge overhead on every ticket instead of
  only the wide ones.
- *Enforcement extension first*: would enshrine rules before the skill session
  has shown which rules hold.

## Test seams

1. **`ladder.json` reader as a pure module** (`.pi/extensions/orchestrator/` has
   established the pattern: pure readers, `node --test`, scripted doubles).
   A `readLadder` module validates schema, tier coverage, roster/pin integrity;
   tests cover malformed files (fail-open with visible warning, mirroring the
   gate reader's rule), tier-exempt types, missing pins.
2. **Ticket-graph parser** as a pure module: frontmatter → graph, tested with
   the same `node --test` runner the repo already uses
   (`node --test --test-concurrency=8` per the gate's own verification command);
   cases: cycle, dangling blocker, `tier-override` winning, prose fallback
   absent.
3. The skill's behavior itself is exercised end-to-end by `prove-it-works`'s
   existing conventions (branch base check `node tools/branch-base.mjs`).

## Acceptance criteria

- [ ] `/skill:orchestrate <folder>` parses a `to-tickets` folder, reports the
      graph (cycles/dangling blockers detected before dispatching), and only
      then dispatches. (Behaviors 1, 2)
- [ ] Every dispatched subagent's run record shows a *(model, thinking)* pair
      from `ladder.json`, and each ticket maps to a recorded triage decision
      (tier + justification) or an explicit `tier-override`. (Behavior 3)
- [ ] A Tier-1 implementer's output is followed by a Tier-2 reviewer gate whose
      verdict is recorded; Tier-2+ output has no gate. (Behavior 4)
- [ ] A crashed run retried at the same tier, then escalated one tier, is
      observable in the run records; a ticket that exhausts Tier 3 ends
      `blocked` with a reason and nothing landed for it. (Behavior 4)
- [ ] Every commit on the feature branch lands after that ticket's Validation
      passed and cites the ticket number; no implementer run produced a commit.
      (Behavior 5)
- [ ] Ticket files' `Status` transitions are observable mid-run by reading the
      files; the closing report exists and covers per-ticket tier, gate
      verdicts, escalations, and blockers. (Behavior 6, 7)
- [ ] `ladder.json` is the only place roster types, tier models, thinking pins,
      and gate rules are written; the orchestrate skill contains no second copy
      of the table. (Design decision: single source of truth)

## Verification

- `node --test --test-concurrency=8 .pi/extensions/orchestrator/test/*.test.ts`
  (or the module's own test glob) covering the two pure seams above.
- `node tools/branch-base.mjs` per the repo's branch-base rules.
- One dry run against a disposable three-ticket folder: artificially force one
  Tier-1 ticket to fail its gate, and confirm the report shows the escalation
  and the in-place status transitions.

## Open assumptions

- **Tier-3 dispatchability: resolved.** `glm-5.3` comes from the mistral
  provider as `mistral/zai-glm-5-3` (reasoning, 1M context) and is already
  enabled — no settings change needed.
- **The Jev-class decision model must be dispatchable for triage.**
  `typesafe/jev-1.13` exists in the openrouter/opencode catalogs but is not
  currently enabled. Assumption: enabling it (each provider one line) suffices
  for the triage calls. **Who can confirm:** the user, by dispatching one
  triage run. Risk: medium — a ladder whose triage pin cannot dispatch fails
  before the first ticket does.
- **Triage-channel finding (2026-11-24).** The decision-model pin resolves to
  `opencode/jev-1.13-free` after three probes: `openrouter/typesafe/jev-1.13`
  fails 401 (`User not found` — credential problem), the paid
  `opencode/jev-1.13` fails 429 (`SpendLimitError`, org spend limit), and a
  direct subagent dispatch of `jev-1.13-free` fails 429 (`FreeUsageLimitError` —
  free decision models work only through OpenCode's own product or the
  classifier channel). The pin is **proven reachable through the harness's
  calibrated-judge channel** (a live judge call answered in 251 ms), so
  ticket 05 routes triage through that channel — pi's classifier machinery —
  with a pinned-subagent dispatch only as fallback. Tier-3 dispatchability was
  proven directly: `mistral/zai-glm-5-3` completed a live probe run. Risk:
  low-medium — the classifier channel is proven but its per-call ergonomics
  from a skill are ticket 05's to work out.
- **Free tiers stay free.** The ladder is capability-driven; if the provider
  starts billing for any tier model, the map's economics change. Risk: low;
  watch at tier-1 volume.
