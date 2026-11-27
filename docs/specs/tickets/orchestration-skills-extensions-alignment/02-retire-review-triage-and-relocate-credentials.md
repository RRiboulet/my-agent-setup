---
status: done
blocked-by: []
---

# 02: Retire review-triage and relocate credential lookup

**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Retire the overlapping `review-triage` extension cleanly while keeping
`advisor` credential diagnostics working:

1. Relocate `authSourceFromRegistry` and `credentialFix` into the orchestrator
   module and rewire `advisor` to consume the relocated helpers so credential
   source reporting and remediation hints continue functioning identically.
2. Remove the `review-triage` extension implementation, the
   `orchestrator:triage-planned` event bus contract, devcontainer config seeding
   and `postCreate` installation/validation for `review-triage`, dedicated
   `review-triage` tests, and all references in the package manifest,
   `README.md`, strict-ESM extension-load tests, and harness documentation.

## Scope
Credential helper relocation into orchestrator, `advisor` import rewiring,
and complete removal of `review-triage` code, devcontainer setup, event
contracts, tests, and manifest/index references. Retains `advisor` as an active
extension. Leaves `/review` rewiring, `goal` retirement, and broad doc cleanup
to sibling tickets.

## Acceptance criteria
- [x] `advisor` resolves credential sources and fix guidance using the
      relocated orchestrator helper with no dependency on `review-triage`.
- [x] The `review-triage` extension, `orchestrator:triage-planned` bus event,
      devcontainer `review-triage` configuration and `postCreate`
      seeding/validation, and dedicated `review-triage` test files are removed.
- [x] Package manifest entries, `README.md` extension listings, and strict-ESM
      extension-load checks reflect the removal of `review-triage` with zero
      dangling references.
- [x] The build and remaining test suites pass cleanly after removal.

## Validation
Extension and advisor tests confirm `advisor` credential diagnostics work via
the relocated helper, strict-ESM extension loading passes without
`review-triage`, and manifest/index parity checks pass. Covers `RB-3` and
relevant invariants in `RB-11` of the **Orchestration, Skills, and Extensions
Alignment** spec (`2026-11-26-orchestration-skills-extensions-alignment`).
