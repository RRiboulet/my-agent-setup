# Test anti-patterns

Part of the [`tdd`](../SKILL.md) skill. The body gives the two-imagined-edits test;
this file is the list of shapes that fail it.

- **Implementation-coupled**: mocks internal collaborators, tests private
  functions, asserts call order or counts, or verifies through a side channel such
  as querying the database instead of reading back through the interface.
- **Tautological**: the expected value is computed the way the code computes it,
  so the test passes by construction.
- **Mocked across the failing boundary**: when a failure crosses a boundary, an
  integration test at that boundary beats mocks.
- **Weakened to pass**: never loosen an assertion, skip a test, or change it to
  match a wrong implementation. Change a test only when the required behavior
  changed, and say why.

The contract decides which side of the line a change falls on: the payload an
external service receives is behavior; a call to an internal helper is not. The
error type callers branch on is contract; the exact message wording usually is
not.

Mock only at system boundaries: external APIs, time, randomness, and sometimes the
database or filesystem. See [mocking.md](mocking.md) and the examples in
[tests.md](tests.md).
