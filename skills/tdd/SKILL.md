---
name: tdd
description: "Test-first development: write a failing test at a public seam, then the smallest code that passes. Use when: adding or changing behavior, fixing a bug with a test path, changing a public API, or asked for TDD or a regression test."
---

# Test-driven development

Make the behavior executable before changing production code. A test earns its place when it fails if the behavior breaks and keeps passing when only the internals change.

A **seam** is the public boundary where behavior is observable: an export, an endpoint, a CLI, or a message handler. Prefer the seam the spec agreed, then an existing one, then the highest that stays fast and deterministic; state it in one line with what it misses. See [references/seams.md](references/seams.md).

## The loop

<!-- tdd-loop:begin - keep this block identical in skills/tdd/SKILL.md and skills/implement/SKILL.md -->
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

**Bug fixes.** Reproduce first, then turn the reproduction into the red test at a seam where the real bug pattern occurs. Load the `diagnosing-bugs` skill when the cause is not obvious.

## Judge every test with two imagined edits

**Break the behavior** (wrong value, skipped effect, done twice): if the test still passes, it proves nothing. **Change the internals** while keeping every observable result: if it now fails, it is pinned. Keep tests that catch the first and survive the second. Anti-patterns and mocking rules are in [references/anti-patterns.md](references/anti-patterns.md) and [references/mocking.md](references/mocking.md); concrete examples are in [references/tests.md](references/tests.md).

## When a failing test is impractical

Prefer no new test to a bad one. Generated code, visual-only changes, no practical seam, no behavior change (typo, comment, private rename), and behavior already covered by an existing test are legitimate exceptions: use the closest executable check instead and name the exception in one line.

## Report

- The failing-before test or check, and the failure it produced.
- The passing-after run, and the surrounding suite you ran.
- Which test fails when this behavior is reverted (for verification when you load the `prove-it-works` skill), or why none applies.
