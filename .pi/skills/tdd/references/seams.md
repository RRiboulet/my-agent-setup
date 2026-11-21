# Seams: where tests go

Part of the [`tdd`](../SKILL.md) skill. The body states the rule; this file is the
detail behind it.

A **seam** is the public boundary where you observe behavior without reaching
inside: a module's exported interface, an HTTP endpoint, a CLI, a message handler.
Tests live at seams, never against internals.

- Use the seams agreed in the spec or ticket, if any.
- Otherwise prefer existing seams to new ones, and the highest seam that still
  gives a fast, deterministic test. Fewer seams is better.
- State the seam in one line, with what it catches and what it misses, then
  proceed. Ask first only if testing would need a new public interface.
- Follow the repository's existing test layout, fixtures, helpers, and naming.

## Choosing between two seams

The higher seam costs more to set up and catches more of the real path; the lower
one runs faster and pins less. Choose the highest seam that stays deterministic
and fast enough to run on every change, then say so in one line. A test at the
wrong seam is why a suite is green while the product is broken: it observes a
piece the user never reaches.

## When a seam does not exist

If the behavior is unreachable without inventing an interface, that is a design
finding, not a testing problem: say what interface would make it reachable, and
ask before adding it. Until then, use the closest executable check and record it
as the exception in the report, per the body's "When a failing test is
impractical".
