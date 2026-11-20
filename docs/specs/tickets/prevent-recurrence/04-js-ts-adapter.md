# 04: The JS/TS adapter is available

**Blocked by:** 03
**Status:** ready

## What to build

The JS/TS half of the skill: existing-rule-first recipes, a local ESLint rule
when the invariant is repository-specific, dependency boundaries, typed linting,
and oxlint for the fast loop. A worked bad and good example proves the recipe
without adding a dependency to this repository.

## Scope

- `no-restricted-imports` and `no-restricted-syntax` for zero-code bans.
- A local flat-config rule with `meta.messages`, `hasSuggestions`, and `suggest`
  for the case where the message must name the canonical file or symbol.
- Dependency boundaries through dependency-cruiser or a boundaries plugin.
- Typed linting through typescript-eslint for the root causes a syntax rule
  cannot see.
- oxlint for the inner loop, with the same plugin where possible.
- Suppression audit guidance for `eslint-disable`, `@ts-ignore`, and
  `@ts-expect-error`.
- A worked example and exact commands, proven in a scratch project that already
  has ESLint or through `npx`.

Leaves the `pupkeep` rollout. Adds no harness dependency.

## Acceptance criteria

- [ ] The recipe covers zero-code bans, a local rule, boundaries, typed linting,
      and oxlint.
- [ ] A worked bad and good example shows the diagnostic and the pass.
- [ ] No new harness dependency.
- [ ] The example's rule row is compatible with the checker.

## Validation

Run the example in a scratch project and show the failing and passing outputs.
Covers R4 for JS/TS.
