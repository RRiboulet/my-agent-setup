# 03: The prevent-recurrence skill is loadable with the Python adapter

**Blocked by:** 01, 02
**Status:** ready

## What to build

A model-invoked skill that turns a repeated correction into an enforced check at
the highest level that works. The body owns the process, not the diagnosis: it
gathers evidence, groups the mistake class, chooses architecture, type, lint,
test, or prose with a reason why a higher level did not work, then writes the
check, proof, ratchet, and table row.

Python is the first adapter because the first conversion is Python.

## Scope

- Skill body: trigger description; inputs; the ordered ladder; lint only for
  locally recognizable patterns; existing tool first; prove bad and good; ratchet;
  table row; no suppression; no commit, push, pull request, or review; report.
- Python recipes: Ruff `TID251` with a fix-naming `msg`; existing Ruff rules
  (`S110`, `BLE001`, `B006`, `RUF006`, `PGH003`, `RUF100`); ast-grep YAML with
  `message`, `note`, `fix`, and `sg test`; `import-linter` contracts; a project
  test as the fallback when no custom lint exists.
- Packaging and triggers: `package.json`, README, the `AGENTS.md` trigger list,
  NOTICE provenance, and a changelog bullet; references from `diagnosing-bugs`,
  `implement`, and `prove-it-works`.
- Uses the checker and table format from ticket 01.

Leaves the JS/TS adapter (04), the experiment branch (05), and the real
conversion (07).

## Acceptance criteria

- [ ] The skill is listed in the package manifest, advertised by its description,
      and credited in the provenance notice.
- [ ] The body contains the ladder, the lint-local test, proof, ratchet, no
      suppression, the table row, and no commit or review.
- [ ] The Python recipes have a worked bad and good example and the exact
      commands.
- [ ] `diagnosing-bugs`, `implement`, and `prove-it-works` name the skill at the
      right moment.
- [ ] A manual dry run on a fixture correction produces a level, a check, a
      proof, and a row the checker accepts.

## Validation

Manual dry run; the docs and metadata test; the checker on the sample table.
Covers R1-R5, R8-R10, and R12.
