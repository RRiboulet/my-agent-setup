---
name: tdd
description: "Default style for new or changed behavior: failing test at a public seam, then the smallest code that passes. Use when: any behavior change, a bug with a test path, or the user asks for TDD or a regression test. Not for a rename, comment or typo."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Test-driven development

The default implementation style for any new or changed behavior: make the
behavior executable before changing production code. A test earns its place when
it fails if the behavior breaks and keeps passing when only the internals change.

A **seam** is the public boundary where behavior is observable: an export, an
endpoint, a CLI, a message handler. Prefer the seam the spec agreed, then an
existing one, then the highest that stays fast and deterministic; state it in one
line with what it misses. Detail in [references/seams.md](references/seams.md).

## The loop

<!-- tdd-loop:begin - keep this block identical in .pi/skills/tdd/SKILL.md and .pi/skills/implement/SKILL.md; coding-skills.test.ts compares them -->
One vertical slice per cycle: one behavior, one test, the minimal code, repeat.

1. **Red.** Write the smallest test for one behavior, with the expected value
   taken from an independent source: the requirement, a worked example, a
   known-good literal.
2. **Watch it fail for the right reason.** If it passes, or fails for an unrelated
   reason such as an import error, fix the test before touching production code.
3. **Green.** Write only enough code to pass. No speculative features.
4. **Widen.** Run the focused test, then the surrounding suite.
5. **Tidy.** Refactor only with tests green, and only what this change needs.
<!-- tdd-loop:end -->

**Bug fixes.** Reproduce first, then make the reproduction the red test. Load
`diagnosing-bugs` when the cause is not obvious from it.

## Judge every test with two imagined edits

**Break the behavior** - wrong value, skipped effect, done twice: if the test
still passes it proves nothing. **Change the internals** keeping every observable
result: if it now fails, it is pinned. Keep what catches the first and survives the
second; the shapes that fail this, and where mocking belongs, are in
[references/anti-patterns.md](references/anti-patterns.md).

## When a failing test is impractical

Prefer no new test to a bad one. Generated code, visual-only changes, no practical
seam, no behavior at all (typo, comment, private rename, release note), and
behavior an existing test covers are legitimate exceptions: use the closest
executable check and name the exception in one line.

## Report

- The failing-before test and its failure; the passing-after run and the suite.
- **Which test fails when this behavior is reverted** - the mutation proof
  `prove-it-works` asks for. If none does, say why.
