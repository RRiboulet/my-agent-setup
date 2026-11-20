# Prevent recurrence: a four-week checks-first experiment

## Objective

Agents repeat the same mistakes because the correction lives in chat, a review
comment, or a prose rule. Each repetition costs a review round and teaches the
next agent the wrong pattern. This work adds a skill that turns the second
occurrence into a deterministic check at the highest level that works, proves the
check against the actual past mistake, and records the rule with its enforcer.

It also runs a four-week experiment on `exp/prevent-recurrence` to test one
thesis: for a repeated mistake, a check beats another review. `dev` keeps its
current workflow until the experiment wins. The experiment is a feature branch
off `dev`, not a parallel trunk.

The immediate user is the operator of this harness. The downstream user is any
project agent that should stop repeating a correction without reading a longer
instruction file. The first real conversion is the groundedness repeat in
`analytics-agent`; `pupkeep` follows as the greenfield lint gate.

## Current behavior

- `diagnosing-bugs` ends at a root-cause fix and a regression test for one bug.
  It does not ask whether the same mistake class will recur elsewhere.
- `implement` ends at proof. It has no trigger for "the user has corrected this
  twice".
- `AGENTS.md` holds prose rules (branch base, reviews, tests) with no mapping
  from a rule to the check that enforces it.
- There is no repo-local lint rule in this harness, and no checker for a rule
  table.
- pstack's `/correct` and `principle-encode-lessons-in-structure` are credited in
  `licenses/NOTICE.md` but not ported as skills.

Evidence that a repeat is a real problem here:

- `analytics-agent` has three fixes to one class: `50a8260` ignores month/year
  labels in groundedness extraction, `7f3c5de` hardens extraction and preserves
  the first violating draft, `2479ab9` mitigates false positives with a rephrase
  retry.
- `pupkeep` `2c609d2` and `analytics-agent` `2aa6720` are the same devcontainer
  truecolor fix. That points at the shared template, the architecture level.
- `AGENTS.md` records that branching off the wrong parent happened three times in
  one session and was caught by a reviewer, not by a check.

## Required behavior

R1. A model-invoked skill named `prevent-recurrence` can be loaded by its
description and by `/skill:prevent-recurrence`. It accepts a correction described
in conversation, a PR or review comment, a revert, or a fix commit.

R2. The skill classifies the mistake from evidence and chooses the highest level
that works, in this order: architecture, type or validation, lint, test, prose.
It states why a higher level did not work. It does not create a lint rule when
the pattern is not locally recognizable; it selects a type or test instead.

R3. The skill produces a check that fails on the recorded past mistake and passes
on the fixed revision, or on a provided bad and good snippet when history is
unavailable. The proof is recorded with the exact command and exit codes. A check
that has never failed on the real mistake is not accepted.

R4. The skill supports at least these adapters: JS/TS (an ESLint local rule or
`no-restricted-*`, plus dependency boundaries), Python (Ruff `TID251`, existing
Ruff rules, ast-grep, `import-linter`, or a project test when no custom lint
exists), and a language-agnostic fallback (a project test or script). It prefers
configuring an existing rule over writing a new one.

R5. Existing violations can be adopted with a ratchet baseline: the check fails
on new violations and does not require fixing all old ones in the same change.
The baseline may only shrink, and the skill records the baseline path.

R6. Every adopted rule is recorded in the target repository's `AGENTS.md` under a
fixed "Rules and enforcement" table with one row per rule: rule, level, enforcer
command, and proof reference. The table is the single source of truth; there is
no parallel JSON registry.

R7. A deterministic checker validates the table. It checks the required columns,
the allowed levels, a non-empty enforcer, a proof reference that exists (a file
path or a bad/good git ref pair), no exact duplicate rules, and no prose row
without an explicit `judgment` marker and reason. It exits 0 on a valid table, 1
on a violation with a row-specific message, and 2 on a usage error. It supports
`--json`.

R8. The skill never adds a suppression (`eslint-disable`, `noqa`,
`type: ignore`, `pylint: disable`) to make the new check pass. If a suppression
is unavoidable, it records the reason, expiry, and approver on the line and
reports it.

R9. The skill does not commit, push, open a PR, or start a review. It reports the
rule, level, proof, baseline, table row, and open work.

R10. The skill is referenced at the right moment by `diagnosing-bugs` (after a
confirmed root cause, when the class has repeated), `implement` (when the user
corrects the same thing twice), and `prove-it-works` (when a change adds or
updates a rule). On the experiment branch only, `REVIEW_GUIDELINES.md` adds one
question: does this fix a repeat, and where is the row and the proof? `dev` keeps
its current review policy.

R11. The experiment runs on `exp/prevent-recurrence`, branched from `dev`, for
four weeks from the first real conversion. On that branch, `prove-it-works`
requires a rule-table row when a change claims to fix a repeat, and one row per
correction is logged in `docs/experiments/prevent-recurrence.md`. A repeat is the
same mistake class twice in 30 days, evidenced by chat, review, or commit, not
the same line twice. Winning commits merge to `dev` by PR; losing commits never
reach `dev` and the branch is deleted.

R12. The checker is a single Node-stdlib file. The canonical copy lives with the
skill; a project gets a vendored copy in its own `tools/` with a recorded version
or hash, and the project's gate calls it. The harness's own gate runs the
canonical copy against this repository's table.

R13. The comment question is settled by evidence before any comment skill is
written. A stratified sample of 30 comments in `pupkeep` and 30 in
`analytics-agent` is classified as invariant, external quirk, workaround
justification, or narration. At 20% or more workaround justification, a comment
experiment is justified; below that, no comment skill is added in this work.

R14. The first dogfood rule is the branch-base check already earned by three real
misses. It is enforced by CI plus a `prove-it-works` step, not by a pre-commit
hook.

R15. The first real conversion is `analytics-agent`'s groundedness repeat. It is
acceptable for the skill to choose a test or a type instead of a lint; the
groundedness bug is semantic, and forcing it into a lint would fail R2.
`pupkeep` is the second conversion, as a greenfield ESLint gate.

## Non-goals

- `poteto-mode`, the 22 playbooks, model-role routing, named principles as a
  separate system, the `comment-sicko` persona, a blanket comment ban,
  `arena`/`swarm`/`interrogate`, the statechart and verification generators, and
  `reflect`.
- Auto-merge, or removing review for low-risk changes. That is a later
  experiment, only after this one wins.
- Executing arbitrary project replay commands from the harness. The project's own
  gate owns execution; the skill records the command and result.
- A replay runner in this branch. Static table validation only.
- A repo-wide suppression budget, a comment-confession lint, a cross-language
  invariant table, or a rule lifecycle dashboard.
- Changing the one-review policy on `dev`.
- Adding an npm or Python dependency to this repository.

## Constraints

- The harness consumes no npm packages and has no typecheck step. The checker
  uses Node stdlib only and runs under `node --test`.
- The checker must work in a target repository with no git history (degrade to
  snippet proof) and in a linked worktree (resolve from the worktree root).
- The experiment is a feature branch, not a parallel trunk. It follows the
  repository's `dev`/`main` model and lands by PR.
- Skill descriptions must be discoverable, because model-invoked skills are
  advertised by description. Do not add a sixth user-invoked entry point.
- The skill uses the target repository's existing tools and gate. Adding a tool
  to the target repository is a design decision named in the report.
- The rule table lives in the target repository's `AGENTS.md`. The checker ships
  with the skill and is invoked from the target repository.
- The Python adapter must not require Python to run the checker.

## Design decisions

### Reuse boundary

Reused as behavior and vocabulary, not as copied text:

- the correction-to-check loop from pstack `/correct`;
- the ordered enforcement ladder;
- the rule table pairing each rule with what enforces it;
- proof against the real past mistake;
- the ratchet;
- the rule that a diagnostic names the fix;
- the vocabulary "fix the root cause", "encode lessons in structure", "the
  codebase is memory".

Added by us, not pstack:

- the static checker for the table (pstack keeps prose, no checker);
- the local review-policy experiment.

Explicitly not reused: `poteto-mode`, the playbooks, model roles, named
principles, `comment-sicko`, the blanket comment ban, `arena`/`swarm`/
`interrogate`, the statechart and verification generators, and `reflect`.

### Mechanism

- **Skill, not a command.** The trigger is a repeated correction, which the agent
  can notice. A slash command would be a sixth user-invoked entry point and would
  still need the same body.
- **Explicit, ordered level ladder.** Architecture, then type, then lint, then
  test, then prose. The skill must justify why a higher level did not work. This
  is the main defense against "write a lint for everything".
- **Lint only for locally recognizable patterns.** If the rule needs cross-file
  dataflow or runtime state, the skill selects a type or test. This is the main
  defense against brittle rules.
- **Existing tool first.** Configure `no-restricted-*`, `TID251`, or existing
  Ruff rules before writing a local AST rule. Write a custom rule only for a
  repo-specific invariant. This controls rule sprawl.
- **Rule table in `AGENTS.md`, not a separate registry.** Agents already read it
  and humans review it. The checker parses the markdown table. A JSON registry
  would be invisible and would drift.
- **Static checker, not a replay runner.** The checker validates structure and
  references; the project's gate executes the proof. This avoids running
  arbitrary commands from the harness and keeps the checker portable.
- **Ratchet, not mass fix.** A rule can land with a baseline, but the baseline
  may only shrink. This matches pstack's `/correct` and avoids a giant cleanup
  PR.
- **Model-invoked.** The trigger is a repeated correction, which the agent can
  notice. `/skill:prevent-recurrence` still works.
- **Adapters as references, not generators.** Toolchains differ per repository.
  Copy-paste recipes with worked bad and good examples are more honest than a
  generator that guesses the config.
- **No suppression escape.** The skill may not add a suppression to pass its own
  rule. This is the one place where the "no comments, no escape hatch" principle
  is enforced directly.
- **Vendored checker.** Project CI and other agents may not have the harness
  installed. The check must live in the project's own gate. The canonical copy
  stays with the skill; the project records the version or hash it vendored.
- **Evidence before a comment skill.** The scan found no `TODO`/`FIXME`/`HACK`
  and mostly invariant comments. A sample audit decides whether a comment
  experiment is justified. Porting `comment-sicko` now would be a solution in
  search of a problem.
- **First conversion in `analytics-agent`.** Its groundedness repeat is real and
  contained, and a semantic bug is the honest test of the ladder. `pupkeep` is
  second because it needs a whole lint gate, which is a different kind of work.

## Test seams

Primary seam: the checker CLI over fixture repositories. It is deterministic,
fast, and exercises the only machine-checkable contract. Tests live beside the
script and run under `node --test`.

Fixtures:

- a valid table with one lint row and an existing proof file exits 0;
- a missing column, unknown level, empty enforcer, missing proof path, duplicate
  rule, and prose-only row without `judgment` each exit 1 with a row-specific
  message;
- invalid usage (no path, unknown flag) exits 2;
- `--json` output has stable fields;
- a table in a linked worktree resolves paths from the worktree root, not the
  main checkout;
- a no-git fixture with bad and good snippets validates the reference format
  without requiring git.

Secondary seam: a docs and metadata test that every skill listed in
`package.json` has a `SKILL.md` with `name` and `description`, and that every
local path referenced from the new skill exists. Extend an existing test if one
exists; otherwise add one only if it stays small.

Not a seam: the skill's judgment quality. Verify with the first real conversion
in `analytics-agent` and record the transcript (bad exit 1, good exit 0, table
row, checker pass). Do not pretend a unit test proves prose.

## Acceptance criteria

- [ ] A model-invoked skill `prevent-recurrence` exists, is listed in
      `package.json`, advertised in `README.md` and `AGENTS.md`, and credited in
      `licenses/NOTICE.md`.
- [ ] The skill body contains the ordered level ladder, the
      locally-recognizable test for lint, the proof requirement, the ratchet
      rule, the no-suppression rule, and the three integration triggers.
- [ ] JS/TS and Python reference recipes exist, each with a worked bad and good
      example and the exact command that distinguishes them.
- [ ] The checker validates the required columns, allowed levels, proof
      references, duplicates, and judgment rows; it exits 0, 1, or 2 as
      specified and supports `--json`.
- [ ] Checker tests cover the valid fixture, each rejection class, usage errors,
      `--json`, and a linked-worktree path case; they run in the harness gate.
- [ ] `AGENTS.md` has a "Rules and enforcement" table with the branch-base
      dogfood row, and the checker passes on it.
- [ ] The branch-base check runs in CI and in `prove-it-works`, not in a
      pre-commit hook, and its rule-table row names both.
- [ ] `diagnosing-bugs`, `implement`, and `prove-it-works` name the new skill at
      the right moment; `dev`'s review policy is unchanged.
- [ ] `exp/prevent-recurrence` exists off `dev`, carries the branch-only
      `prove-it-works` and `REVIEW_GUIDELINES.md` changes, and has the experiment
      log with the repeat definition.
- [ ] The comment sample is recorded: 30 comments in `pupkeep` and 30 in
      `analytics-agent`, four classes, and a decision against the 20% threshold.
- [ ] The `analytics-agent` conversion shows a check that fails at the bad
      revision, passes at the good revision, and a table row the checker accepts.
- [ ] `pupkeep` is named as the second conversion with its own gate change, not
      done in this branch.
- [ ] The four-week review is a checklist in this spec, not a ticket, and names
      the two counts and the merge-or-delete decision.
- [ ] No new npm or Python dependency; the existing subagent and provider tests
      still pass.
- [ ] `CHANGELOG.md` has an Unreleased entry naming the skill, the checker, and
      the experiment branch.

## Verification

Commands:

```bash
bash .pi/extensions/subagent/test/setup-deps.sh
node --test .pi/extensions/subagent/test/*.test.ts
(cd .pi/extensions/opencode-go-provider && node --test)
node --test .pi/skills/prevent-recurrence/scripts/test/*.test.mjs
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check <fixture>/AGENTS.md
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check --json <fixture>/AGENTS.md
```

The bad fixtures are exercised by the test file and are expected to exit 1. The
`AGENTS.md` Tests section must name the new test command, because
`prove-it-works` reads the gate there.

First real conversion, in `analytics-agent`:

1. Check out `50a8260` (or its parent) and the fix revision.
2. Run the chosen check at the bad revision (expect exit 1) and at the fix
   (expect exit 0). A test or type check is an acceptable outcome; a lint is not
   required.
3. Add the row to `analytics-agent/AGENTS.md` and run the vendored checker
   (expect exit 0).
4. Paste the commands and exit codes into the change report.

Comment sample:

1. Extract 30 comments from `pupkeep` and 30 from `analytics-agent`, stratified
   by adjacency to suppressions, timers, retries, and ordinary code.
2. Classify each as invariant, external quirk, workaround justification, or
   narration.
3. Record the counts and the decision against the 20% threshold.

Experiment branch:

1. Confirm `git merge-base --is-ancestor dev HEAD` and that `git log dev..HEAD`
   lists only the branch's commits.
2. Confirm the branch-only policy changes are present and `dev` is unchanged.
3. At four weeks, work through the experiment review checklist below.

## Experiment review checklist

At four weeks from the first conversion:

- [ ] Record repeat corrections per week and review rounds per change for the
      window and for the baseline.
- [ ] Record the first conversion result: bad revision, fix revision, commands,
      exit codes, the table row, and the checker run.
- [ ] Decide: merge the winning commits to `dev` by PR, or delete the branch.
- [ ] If merging, include the branch-only policy changes and update the
      changelog.
- [ ] If deleting, record why; `dev` was never changed.
- [ ] Choose the next experiment from evidence: auto-merge, named principles, a
      comment skill, or none.

## Open assumptions

1. **The experiment wins or loses on a small sample.** Risk: medium. Four weeks
   and one real conversion may not separate the effect from noise. The manual
   counts are honest, and the branch is reversible.
2. **`analytics-agent`'s groundedness repeat is fixable at a checkable level.**
   Risk: medium. It may be a judgment-heavy semantic problem with no stable
   check. If so, the honest outcome is a type or a narrower test, and that is
   still a valid result for the experiment.
3. **A markdown table in `AGENTS.md` is the right registry.** Risk: medium.
   Commands inside cells need escaping. If the checker becomes painful, switch
   to a fenced YAML block under the same heading and keep the table for humans;
   the checker contract would change.
4. **Node is available in target projects.** Risk: low in this harness, which
   has Node and Python. A Python-only project without Node would need a Python
   port of the checker.
5. **The checker validates proof references without running them.** Risk:
   medium. A stale proof file or a command that no longer fails at the bad
   revision can still pass. Mitigation: the skill records the command and exit
   codes, and reviewers can rerun. A replay runner is a follow-on.
6. **The vendored checker does not drift.** Risk: low. The version or hash in the
   project makes drift visible; re-vendoring is one file.
7. **The branch-base check fits CI.** Risk: medium. CI must fetch `dev` and
   compare against the right base, and a merge queue can change what `HEAD`
   means. The check is specified in tickets against a real CI run, not assumed.
