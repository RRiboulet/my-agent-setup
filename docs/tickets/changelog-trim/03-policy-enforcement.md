---
status: done
blocked-by: ["01", "02"]
---

# 03: Make the trim a policy: guard test, changelog skill, AGENTS.md

**Blocked by:** 01 (the changelog is already trimmed), 02 (the union driver
and its guard exist, so the docs describe something real)
**Status:** done

Ticket 01 trims the file once. Without this ticket, the file grows back one
release at a time — which is how it reached 4,400 lines — and nothing in the
repo remembers that git tags are the archive.

## What to build

Encode the retention policy as enforced rules, in the repo's own idiom
(rules live in `AGENTS.md`'s rule table; enforcement is a test that fails
without the rule; see `.pi/skills/prevent-recurrence/references/rule-table.md`
for the table contract):

- **Structure guard (TDD).** Extend the changelog structure test with a test
  asserting the policy on shape: every release heading present in
  `CHANGELOG.md` must belong to the newest major in the file (post-ticket-01:
  v1.17.x), i.e. no release of an older major survives in the file. Prove it
  red first — e.g. by temporarily re-inserting an old-major heading — per
  `tdd` and `prove-it-works`, then restore.
- **`AGENTS.md` rule table.** Two rows: (1) CHANGELOG.md carries only
  `## Unreleased` plus the newest major's releases, older ones read via
  `git show vX.Y.Z:CHANGELOG.md`; (2) `CHANGELOG.md` merges with the union
  driver so concurrent Unreleased appends auto-merge. Enforced by the
  structure test and 02's new test respectively. The table must keep passing
  `node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md`.
- **Release workflow step** in `AGENTS.md`: after retitling `## Unreleased`
  to the new version, if the release starts a new major, delete the older
  major's sections from the file (git keeps them).
- **`update-changelog` skill** (local-adaptation and "Where the Unreleased
  section goes" sections): the retention rule, the git-show retrieval for
  old versions, the union-driver behavior (concurrent appends merge
  automatically on local merges — still append at the bottom of the Unreleased
  section rather than editing existing entries), and the release-time pruning
  step. Follow `writing-for-agents` when editing skill prose. Do not change
  the skill's frontmatter (the README index must stay green untouched).
- **Reviewer nits from tickets 01/02, folded in here** (non-blocking per
  their reviewers, recorded in this wave's review reports):
  - Ticket 02's guard test asserts file *text*; it stays green even if a
    later overriding `CHANGELOG.md` attribute rule wins. Strengthen it to
    also assert the effective attribute — `git check-attr merge --
    CHANGELOG.md` resolves to `union` — and add one sentence to its comment
    warning that union keeps near-duplicate bullets from both sides
    **silently** (demonstrated during review: duplicate release headings
    merged with zero conflict markers).
  - Ticket 01 left CHANGELOG.md with an extra blank line at EOF; fixed
    inline by the orchestrator before the verify gate (`git diff --check`
    is clean). Do not regress it: the file ends at exactly one trailing
    newline.

## Scope

Owns the changelog structure guard test, `AGENTS.md` (rule table rows + the
release-workflow sentence + anything the rows obligate near them), the
`update-changelog` skill body, and the two folded-in nits to ticket 02's
guard test (the `git check-attr` assertion and the comment sentence —
ticket 02 is merged and closed by the time this ticket starts). Does not
own: CHANGELOG.md content (already trimmed by 01), the `.gitattributes` line
itself (02), any other skill, the README, or CI.

## Acceptance criteria

- [ ] The structure test fails when an older-major release heading is present
      (red run demonstrated, then green restored).
- [ ] `node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md`
      exits 0 with the two new rows.
- [ ] `node --test --test-concurrency=8 .pi/extensions/subagent/test/checks-parity.test.ts`
      and the full subagent suite pass (the new AGENTS.md rows must not break
      the parity contract).
- [ ] `node tools/skills-index.mjs --check` exits 0 (frontmatter untouched).
- [ ] The `update-changelog` skill states the policy in its own voice,
      matching the surrounding prose.

## Validation

Report the red and green runs of the new guard, the rule-table checker output,
the parity test, `skills-index --check`, and the full suite result.
