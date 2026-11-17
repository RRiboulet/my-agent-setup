# 07: The rule and the changelog

**Blocked by:** 01
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (behaviours 8 and 9).

## What to build

The testing discipline this change exists to make followable, written where it
will be read, and the changelog entry that explains it with the dated numbers.

## Scope

Owns `AGENTS.md`'s `Tests` section and `CHANGELOG.md`'s `Unreleased` section.
Touches no code and no other file — **other tickets must not edit CHANGELOG.md**,
so the entry is yours alone.

The rule, in the `Tests` section beside the commands:

- while iterating, run only the test file(s) for what you touched;
- run the full suite exactly once before commit;
- run that one through `bg`, and say so with the command.

The changelog entry: what the tool is, what the rule is, the measured motivation
(suite runs as the dominant sink, sleeps and re-runs second), and a note that the
acceptance numbers are pending ticket 08 — leave a marked placeholder rather than
inventing figures. Match the existing entries' tone and structure.

## Acceptance criteria

- [ ] `AGENTS.md` carries the rule in the `Tests` section, next to the commands,
      phrased as an instruction to the agent, not as background.
- [ ] The existing changelog structure tests still pass.
- [ ] The `Unreleased` entry names the tool, the rule, and the measurements with
      their date; the acceptance numbers are a marked placeholder for ticket 08.
- [ ] No code changes: `git diff` shows only `AGENTS.md` and `CHANGELOG.md`.

## Validation

`node --test .pi/extensions/subagent/test/changelog-structure.test.ts` and
`coding-skills.test.ts`; then the full suite once before your final commit.
