# Coding skills provenance

The twelve coding skills under `.pi/skills/` (`in-your-own-words`,
`blast-radius`, `tdd`, `diagnosing-bugs`, `prove-it-works`,
`idempotent-operations`, `benchmark-checklist`, `show-me-your-work`,
`to-spec`, `to-tickets`, `implement`, `handoff`) were adapted from
<https://github.com/RRiboulet/agent-coding-skills> at commit `25deecd`. They are
maintained here as this repository's own skills; there is no refresh mechanism
and no upstream to track.

That repository adapts material from two MIT-licensed projects. Their license
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
| `tdd` | Matt `skills/engineering/tdd` (with `tests.md`, `mocking.md`); pstack `skills/tdd` |
| `diagnosing-bugs` | Matt `skills/engineering/diagnosing-bugs` (with `scripts/hitl-loop.template.sh`); pstack `skills/principle-fix-root-causes` |
| `prove-it-works` | pstack `skills/principle-prove-it-works` |
| `idempotent-operations` | pstack `skills/principle-make-operations-idempotent` |
| `benchmark-checklist` | pstack `skills/benchmark-checklist` |
| `show-me-your-work` | pstack `skills/show-me-your-work` (with `scripts/log.sh` and the TSV template) |
| `to-spec` | Matt `skills/engineering/to-spec` |
| `to-tickets` | Matt `skills/engineering/to-tickets` |
| `implement` | Matt `skills/engineering/implement`, `skills/engineering/implement-spec`; pstack `skills/principle-sequence-verifiable-units`, `skills/principle-subtract-before-you-add` |
| `handoff` | Matt `skills/productivity/handoff` |

## What changed on the way in

The skills were edited to fit this repository rather than kept as copies:

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
- **Executable bits.** `diagnosing-bugs/scripts/hitl-loop.template.sh` and
  `show-me-your-work/scripts/log.sh` are executable here; upstream ships them
  mode 100644 while its own `validate.py` requires the bit, so its quality gate
  fails on a fresh clone.
