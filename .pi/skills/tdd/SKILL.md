---
name: tdd
description: "Test-first development: make the behavior executable as a failing test at a public seam, then write the smallest code that passes, one vertical slice at a time. Use when: fixing a bug that has a practical test path; adding business logic, parsers, transformations, state transitions, retry or idempotency behavior; changing a public API; or when the user asks for TDD, red-green, a failing test, or a regression test."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Test-driven development

Make the behavior executable before changing production code. A test earns its place when it fails if the behavior breaks and keeps passing when only the internals change.

## Seams: where tests go

A **seam** is the public boundary where you observe behavior without reaching inside: a module's exported interface, an HTTP endpoint, a CLI, a message handler. Tests live at seams, never against internals.

- Use the seams agreed in the spec or ticket, if any.
- Otherwise prefer existing seams to new ones, and the highest seam that still gives a fast, deterministic test. Fewer seams is better.
- State the seam in one line, with what it catches and what it misses, then proceed. Ask first only if testing would need a new public interface.
- Follow the repository's existing test layout, fixtures, helpers, and naming.

## The loop

One vertical slice per cycle: one behavior, one test, the minimal code, repeat. Writing all the tests first tests imagined behavior and locks in structure before you understand the problem.

1. **Red.** Write the smallest test for one behavior. Take the expected value from an independent source: the requirement, a worked example, or a known-good literal.
2. **Watch it fail for the right reason.** Run it. If it passes, or fails for an unrelated reason such as an import error or a fixture bug, fix the test before touching production code.
3. **Green.** Write only enough code to pass. No speculative features.
4. **Widen.** Run the focused test, then the surrounding suite.
5. **Tidy.** Refactor only with tests green, and only what this change needs. Broader cleanup belongs in review.

**Bug fixes.** Reproduce first, then turn the reproduction into the red test at a seam where the real bug pattern occurs. If the bug is hard to reproduce or localize, load the `diagnosing-bugs` skill before writing the test.

## Judge every test with two imagined edits

- **Break the behavior**: return a wrong value, skip an effect, or do it twice. If the test still passes, it proves nothing.
- **Change the internals** while keeping every observable result. If the test now fails, it is pinned to the implementation.

Keep tests that catch the first edit and survive the second. The contract decides: the payload an external service receives is behavior; a call to an internal helper is not. The error type callers branch on is contract; the exact message wording usually is not.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private functions, asserts call order or counts, or verifies through a side channel such as querying the database instead of reading back through the interface.
- **Tautological**: the expected value is computed the way the code computes it, so the test passes by construction.
- **Mocked across the failing boundary**: when a failure crosses a boundary, an integration test at that boundary beats mocks.
- **Weakened to pass**: never loosen an assertion, skip a test, or change it to match a wrong implementation. Change a test only when the required behavior changed, and say why.

Mock only at system boundaries: external APIs, time, randomness, and sometimes the database or filesystem. See [references/mocking.md](references/mocking.md) and the examples in [references/tests.md](references/tests.md).

## When a failing test is impractical

Prefer no new test to a bad one: one that mostly tests mocks, encodes implementation details, depends on timing or global state, or needs heavy infrastructure for a small fix. Generated code, visual-only changes, and code with no practical seam are legitimate exceptions. Use the closest executable check instead, such as a targeted script, a CLI or HTTP call, or a log assertion, and say why.

## Report

- The failing-before test or check, and the failure it produced.
- The passing-after run, and the surrounding suite you ran.
- If you could not show failing-before evidence, why, and what you used instead.
