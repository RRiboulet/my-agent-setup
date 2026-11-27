# Coding Skills Provenance and Overrides

## Provenance

- **14 adapted coding-loop skills** from `uih00686/agent-skills`: now maintained here with pi rules and invocation syntax; MIT notices and per-skill changes are in `licenses/NOTICE.md`.
- **3 skills ported directly from `mattpocock/skills`**: `grilling`, `teach`, and `writing-for-agents` (recorded separately in `licenses/NOTICE.md`).
  - `grilling` is model-invoked (and `/skill:grilling` works) for multi-round design-tree interviews when `in-your-own-words`'s playback cannot hold all assumptions.
  - `teach` is user-invoked (`/skill:teach`) and stateful: it builds a teaching workspace outside any project checkout (never inside this repo), continued by starting a session in that workspace or via `/skill:handoff`.
  - `writing-for-agents` is model-invoked and governs skill bodies/descriptions, `AGENTS.md` bullets, and `references/` pointers (`references/skill-mechanics.md` covers frontmatter, invocation class, and router skills).
- **`prevent-recurrence` (ours)**: adapts the correction-to-check loop, ordered ladder (`architecture` -> `type` -> `lint` -> `test` -> `prose`), rule table, ratchet, and diagnostic rules from `pstack`'s `/correct`, plus the judgment boundary from `principle-encode-lessons-in-structure`, paired with `scripts/rule-table.mjs` and lint-locality checks. Model-invoked (and `/skill:prevent-recurrence` works); Python recipes live in `references/python.md` and JS/TS recipes in `references/js-ts.md`. It stops at the check, proof, and `AGENTS.md` row without starting a review or committing.

## Repository overrides over adapted skill bodies

Four repository rules override generic skill defaults (each skill notes this in place):

1. **Commits** follow `skills/commit/SKILL.md` (branch and base checks), not `implement`'s looser "commit on the current branch".
2. **Worktrees** live under `.worktrees/` at the repository root per `skills/worktree/SKILL.md`.
3. **Reviews** follow the single-review-on-request policy (`docs/harness/reviews.md`). Both `prove-it-works` and `implement` end at proof and never start a review.
4. **Delegation** follows Pragmatic Orchestrator parent guardrails (`docs/harness/extensions.md`). When delegation is active in `enforce` mode, parent write and shell limits override generic inline-editing or direct-bash wording in adapted coding and ops skills: route multi-file or non-trivial edits and test, build, or branch-mutating commands through `subagent({ role: "coder", ... })` or `/orchestrate`, or prefix the prompt with `!direct`.
