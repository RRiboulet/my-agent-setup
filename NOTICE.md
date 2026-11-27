# Notice

This repository builds on and adapts material from upstream open-source projects (plus the vendored `opencode-go` provider). Their license texts and detailed per-skill provenance are kept in [`licenses/`](licenses/) and [`licenses/NOTICE.md`](licenses/NOTICE.md).

| Upstream | Copyright / Author | License | What comes from it |
| --- | --- | --- | --- |
| [`mattpocock/skills`](https://github.com/mattpocock/skills) | © 2026 Matt Pocock (pinned [`4ae2317`](https://github.com/mattpocock/skills/tree/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d)) | [MIT](licenses/mattpocock-skills.LICENSE) | Coding-loop, `grilling`, `teach`, `writing-for-agents`, `to-spec`, `to-tickets`, `implement`, `implement-spec`, `handoff`, and `retro` source material |
| [`cursor/plugins` (`pstack`)](https://github.com/cursor/plugins/tree/main/pstack) | © 2026 Lauren Tan (pinned [`6b03002`](https://github.com/cursor/plugins/tree/6b0300214a09fd6029cfb7077043125758cd1fd2/pstack)) | [MIT](licenses/pstack.LICENSE) | `in-your-own-words`, `blast-radius`, `architect`, `tdd`, `diagnosing-bugs`, `review-change`, `prove-it-works`, `idempotent-operations`, `benchmark-checklist`, `show-me-your-work`, `interrogate`, `verify-app`, `recall`, and `prevent-recurrence` source material |
| [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff) | © mitsuhiko and contributors (upstream `mitsupi` v1.6.0, `0865c84`) | Apache-2.0 | Vendored `pi` extensions (`.pi/extensions/continue.ts`, `review.ts`) and skills (`skills/commit`, `github`, `librarian`, `native-web-search`, `tmux`, `update-changelog`) |
| [`monotykamary/pi-opencode-go-provider`](https://github.com/monotykamary/pi-opencode-go-provider) | © monotykamary (commit `286c467`) | MIT | Vendored `.pi/extensions/opencode-go-provider/` |

See [`licenses/NOTICE.md`](licenses/NOTICE.md) for the per-skill provenance table and local adaptations.

## Provenance per skill

Paths are relative to each upstream repository at the pinned commit.

| Skill | Sources | Main changes |
| --- | --- | --- |
| `in-your-own-words` | pstack `skills/in-your-own-words`; Matt `skills/productivity/grilling` | Expanded a one-line restatement into a structured playback (goal, done-when, out of scope, assumptions, touches). Took the "facts are yours, decisions are the user's" and "recommend an answer" rules from `grilling`. Made model-invoked. |
| `blast-radius` | pstack `skills/blast-radius` | Dropped the step that runs a multi-model `arena`, which is pstack-specific; kept the "one fact it is safe because of" method, the look-where-search-stops checklist, and the evidence ladder. |
| `tdd` | Matt `skills/engineering/tdd` (with `tests.md`, `mocking.md`); pstack `skills/tdd` | Merged Matt's vertical-slice loop with pstack's red-first bug-fix discipline; made the examples explicitly language-agnostic. |
| `diagnosing-bugs` | Matt `skills/engineering/diagnosing-bugs` (with `scripts/hitl-loop.template.sh`, verbatim); pstack `skills/principle-fix-root-causes` | Added the legitimate-state versus impossible-state root-cause test and the list of symptom-hiding fixes. Routed performance numbers to `benchmark-checklist`. |
| `review-change` | Matt `skills/engineering/code-review`; pstack `skills/no-comments`, `skills/unslop`, `skills/principle-subtract-before-you-add` | Renamed to avoid Claude Code's bundled `/code-review`. Added a Correctness axis beside Spec and Standards, whose findings need a run or a concrete failing path. Decoupled from the issue tracker. Moved the Fowler smell baseline to `references/smells.md` and folded in subtraction and comment rules. |
| `prove-it-works` | pstack `skills/principle-prove-it-works` | Added quality-gate discovery (`.agent/quality.yaml` or the repo's own CI and scripts), failure classification, final-diff review, and a status vocabulary for reports. Renamed to avoid Claude Code's `/verify`. |
| `idempotent-operations` | pstack `skills/principle-make-operations-idempotent` | Renamed; made model-invoked with concrete triggers; added techniques (idempotency keys, atomic rename, leases, guarded migrations, reconcile loops) and a test recipe. |
| `benchmark-checklist` | pstack `skills/benchmark-checklist` | Nearly verbatim. Removed references to pstack playbooks; made model-invoked. |
| `show-me-your-work` | pstack `skills/show-me-your-work` (with `scripts/log.sh`, verbatim, and the TSV template) | Replaced the Cursor transcript audit with an audit against the agent's own action record. Cross-model review became "independent sub-agent, different model if available, otherwise say self-reviewed". Made model-invoked. |
| `grilling` | Matt `skills/productivity/grilling` (with `agents/openai.yaml`) | Model-invoked like upstream, with triggers that also cover plans with interdependent open decisions; a self-started session says why, lets the user decline, and never runs unattended. `in-your-own-words` escalates to it. Kept the design-tree rounds verbatim under added section headings. Added a fixed read-only brief for fact-finding sub-agents (evidence required, "not found" over guessing, no recommendations), a rule that every lookup goes to the harness's lightweight exploration agent (named, so cheap models get picked) and never to the main agent, parallel lookups, a check that reported facts carry evidence, and a next-step pointer to `/to-spec` or `/implement`. |
| `to-spec` | Matt `skills/engineering/to-spec` | Writes a local file by default and uses a tracker only when named. New template with current behavior, constraints, acceptance criteria, verification, and open assumptions. |
| `to-tickets` | Matt `skills/engineering/to-tickets` | Local ticket files by default; a tracker only when named. Added Scope and Validation fields and a threshold for when tickets are worth it. |
| `implement` | Matt `skills/engineering/implement`, `skills/engineering/implement-spec`; pstack `skills/principle-sequence-verifiable-units`, `skills/principle-subtract-before-you-add` | Wires in the model-invoked skills at each step. Commits only when asked and never pushes. Parallel sub-agents only on request and with isolated worktrees. |
| `architect` | pstack `skills/architect`; Matt `skills/engineering/codebase-design` | Distilled into a 4-step pre-coding design check: trace touches, sketch two distinct shapes, apply the deletion test and single-owner/minimal-caller checks, and escalate tradeoffs to `grilling`. |
| `interrogate` | pstack `skills/interrogate` | Decoupled from pstack's `arena` and model settings; kept the multi-angle adversarial break-the-change framing, executable-proof requirement, and "no findings is valid" rule. |
| `retro` | Matt `skills/engineering/retro`; pstack `skills/correct` | Merged environment-improvement categories with the fix-at-highest-layer ladder (structure -> automated checks -> tests -> docs last), proof that new checks bite, and sediment pruning. |
| `implement-spec` | Matt `skills/engineering/implement-spec` | Dedicated user-invoked parallel worktree DAG runner by ready frontier, serializing overlapping file scopes, passing context pointers, and ending with `review-change` and `prove-it-works`. |
| `verify-app` | pstack `skills/create-verification-skill`, `skills/maintain-verification-skill` | Combined creation and periodic audit into one lean two-mode skill (Launch, Doctor, Drive, Evidence, Cleanup) requiring an end-to-end proof run and strict regression triage. |
| `recall` | pstack `skills/recall` | Dropped hardcoded harness transcript directories; reconciles harness session history against live git/worktree/PR state into a compact status-tagged brief. |
| `handoff` | Matt `skills/productivity/handoff` | Added a document template (state, last green check, next steps, risks) and a paste-ready resume line. Dropped the non-portable `argument-hint`. |

Every skill also gained an `agents/openai.yaml` (Codex UI metadata and invocation policy) following Matt's convention.
