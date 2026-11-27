# Coding and teaching skill provenance

The fourteen coding skills under `.pi/skills/` (`in-your-own-words`,
`blast-radius`, `architect`, `tdd`, `diagnosing-bugs`, `prove-it-works`,
`idempotent-operations`, `benchmark-checklist`, `show-me-your-work`,
`recall`, `to-spec`, `to-tickets`, `implement`, `handoff`) were adapted from
the upstream MIT-licensed coding-skills sources listed below. Three more
skills, `grilling`, `teach` and `writing-for-agents`, were adapted straight from
mattpocock/skills rather than through that stack; they are listed below with the
rest.
`prevent-recurrence` is this repository's own, adapted from pstack's `/correct`
and `principle-encode-lessons-in-structure` at the commit pinned below. All of
them are maintained here as this repository's own skills; there is no refresh
mechanism and no upstream to track.

The adapted material comes from two MIT-licensed projects. Their license
texts are kept beside this file, and the sources are listed per skill below.

| Upstream | Copyright | Pinned commit | License |
| --- | --- | --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) | © 2026 Matt Pocock | [`4ae2317`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d) | [MIT](mattpocock-skills.LICENSE) |
| [cursor/plugins `pstack`](https://github.com/cursor/plugins/tree/main/pstack) | © 2026 Lauren Tan | [`6b03002`](https://github.com/cursor/plugins/tree/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack) | [MIT](pstack.LICENSE) |

## Per-skill sources

Paths are relative to each upstream repository at the pinned commit.

| Skill | Sources |
| --- | --- |
| `in-your-own-words` | pstack `skills/in-your-own-words`; Matt `skills/productivity/grilling` |
| `blast-radius` | pstack `skills/blast-radius` |
| `architect` | pstack `skills/architect`; Matt `skills/engineering/codebase-design` |
| `tdd` | Matt `skills/engineering/tdd` (with `tests.md`, `mocking.md`); pstack `skills/tdd` |
| `diagnosing-bugs` | Matt `skills/engineering/diagnosing-bugs` (with `scripts/hitl-loop.template.sh`); pstack `skills/principle-fix-root-causes` |
| `prevent-recurrence` | pstack `skills/correct`, `skills/principle-encode-lessons-in-structure` |
| `prove-it-works` | pstack `skills/principle-prove-it-works` |
| `idempotent-operations` | pstack `skills/principle-make-operations-idempotent` |
| `benchmark-checklist` | pstack `skills/benchmark-checklist` |
| `show-me-your-work` | pstack `skills/show-me-your-work` (with `scripts/log.sh` and the TSV template) |
| `to-spec` | Matt `skills/engineering/to-spec` |
| `to-tickets` | Matt `skills/engineering/to-tickets` |
| `implement` | Matt `skills/engineering/implement`, `skills/engineering/implement-spec`; pstack `skills/principle-sequence-verifiable-units`, `skills/principle-subtract-before-you-add` |
| `handoff` | Matt `skills/productivity/handoff` |
| `recall` | pstack `skills/recall` |
| `grilling` | Matt `skills/productivity/grilling` (with `skills/productivity/grill-me`, the user-invoked wrapper, folded into its "Where this sits" section rather than shipped as a second skill) |
| `teach` | Matt `skills/productivity/teach` (with `MISSION-FORMAT.md`, `LEARNING-RECORD-FORMAT.md`, `RESOURCES-FORMAT.md`, `GLOSSARY-FORMAT.md`) |
| `writing-for-agents` | Matt `skills/productivity/writing-for-agents` (with `references/skill-mechanics.md`) |

## What changed on the way in

The skills were edited to fit this repository rather than kept as copies:

- **`architect` is the shape step, not a multi-model design run.** pstack's
  version is a five-phase pipeline whose Phase B dispatches several models
  through `arena`; there is no arena, no `pstack-models` rule and no `how` or
  `why` skill here, so those mechanics are gone and the durable discipline stays:
  map what the change touches, sketch two structurally distinct shapes, apply the
  deletion and single-owner tests, then pick or escalate. Upstream's opt-in human
  checkpoint became the default, because the escalation is where the decision
  belongs: `grilling` settles it with the user when both shapes carry real
  tradeoffs. Matt's deep-module vocabulary — depth as leverage at the interface,
  the seam, one adapter is hypothetical and two make it real,
  replace-don't-layer — is folded into the boundary tests rather than shipped as
  a skill of its own. Building against the sketch is `tdd`'s job, so Phase D is
  dropped along with the rationale template, the `references/` files and
  `agents/openai.yaml`.
- **`recall` reads pi's own session store instead of a harness transcript path.**
  Mining is `<agent dir>/sessions/<safePath>/*.jsonl` ordered by modification
  time, with the current session and subagent noise excluded, fanned out through
  `subagent` and collected with `subagent_wait` so the transcripts stay in the
  children. It adds a live-presence source upstream did not have —
  `orchestrator_workspace` `peers`, the other sessions open on this repository —
  with the heartbeat caveat that a stale claim is verified against git, and it
  settles tracker questions through `gh` instead of an assumed integration.
  pstack's routing into skills that are not installed here (`why`,
  `session-pickup`, `automate-me`, `unslop`, `poteto-mode`) is dropped; the
  boundary with `handoff`, which does exist, is kept. It stays user-invoked,
  like every other entry point here.
- **One review pipeline.** The adapted `review-change` skill was folded into
  `REVIEW_GUIDELINES.md`, which is what `/review` appends and what a
  triage-launched reviewer follows. `prove-it-works` now says plainly that it is
  the author's proof, not a review, and that it never starts a reviewer. A change
  gets one independent review, only when asked, through `/review` or through
  `triage_change` and one approved sub-agent — never both.
- **`show-me-your-work` narrowed** to a big task left unsupervised for a long
  time, and its independent-review step removed: it self-audits, and if a review
  is commissioned the trail goes to that one reviewer.
- **pi invocation syntax.** pi runs a user-invoked skill as `/skill:<name>`, so
  the four entry points and their cross-references spell it that way.
- **Repository specifics.** `implement` defers commits to the `commit` skill and
  worktrees to the `worktree` skill; `prove-it-works` reads the gate from
  `AGENTS.md` (there is no `.agent/quality.yaml`); `handoff` writes under the
  persistent agent dir instead of `/tmp` and is disambiguated from the `subagent`
  tool's context-handoff modes.
- **`prevent-recurrence` is model-invoked, and its table has a checker.**
  pstack's `/correct` and `principle-encode-lessons-in-structure` are
  user-invoked; here a repeated correction is something the agent notices, so the
  skill is advertised by its description and `/skill:prevent-recurrence` still
  works. The ordered ladder, the rule table, the ratchet, and "the diagnostic
  names the fix" are pstack's. Added here: a deterministic Node-stdlib checker
  for the rule table, the lint-locality question that sends semantic rules to a
  type or a test, and the hard stop before committing and reviewing. A lesson
  that needs judgment does not become a lint that guesses: it stays prose with a
  `judgment: <reason>` row and an example of the failure mode, which is the
  boundary `principle-encode-lessons-in-structure` draws.
- **`grilling` merged the family.** Upstream splits the same interview into a
  model-invoked `grilling` and a user-invoked `grill-me` wrapper whose whole body
  is "call `grilling`". Here there is one skill: pi runs user-invoked skills as
  `/skill:<name>` and model-invoked ones still reachable that way, so the wrapper
  added nothing. Its prose — count rounds not questions, no cap, split an
  over-long scope, hand the session to `to-spec` — is folded into `grilling`'s
  "Length" and "Where this sits" sections. The local boundary with
  `in-your-own-words` and `to-spec` is stated in place, because the cheap playback
  and the full interview are easy to confuse.
- **`teach` keeps the workspace out of the checkout, and links its glossary.**
  Upstream treats the directory `/teach` was run in as the workspace, which here
  would litter a project with untracked course files; `SKILL.md` sends it to
  `<agent dir>/learning/<slug>` (or a directory or repo the user names) instead.
  Upstream also ships `GLOSSARY-FORMAT.md` without linking it from `SKILL.md`, so
  the glossary it describes is never built ([issue
  #559](https://github.com/mattpocock/skills/issues/559)); here it is part of the
  workspace table. The measured quiz finding — the correct answer lands first no
  matter what the instructions say ([issue
  #335](https://github.com/mattpocock/skills/issues/335)) — is answered by
  requiring a shuffle component in `assets/` rather than by wording alone, and
  the gaps the skill's own docs admit (no scheduling, no exit criteria, no
  assessment step) are stated in "Honest limits" instead of being left for the
  user to discover.
- **`writing-for-agents` keeps upstream's body, moves its mechanics file, and
  drops its harness adapter.** The body is upstream's text and so is the
  mechanics file, apart from a top-level title heading (the only skill here
  without one) — relocated to `references/skill-mechanics.md` (upstream
  keeps it beside `SKILL.md`) to match `prevent-recurrence/references/` and
  `tdd/references/`, and so the skill test's "every `references/*.md` is linked"
  assertion covers it. The
  `description` is rewritten in this repository's house form (what it does, then
  the trigger branches) so it advertises itself like the other model-invoked
  skills here, and upstream's `agents/openai.yaml` — another harness's interface
  metadata, which pi does not read — is not installed.
- **Executable bits.** `diagnosing-bugs/scripts/hitl-loop.template.sh` and
  `show-me-your-work/scripts/log.sh` are executable here; upstream ships them
  mode 100644 while its own `validate.py` requires the bit, so its quality gate
  fails on a fresh clone.
