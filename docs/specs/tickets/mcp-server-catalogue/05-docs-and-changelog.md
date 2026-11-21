# 05: The README tells a colleague how to get the catalogue, and the changelog records it

**Blocked by:** 01, 03, 04
**Status:** ready

## What to build

A colleague who installs this package can follow the README from install to a
working opt-in, without asking the operator anything. The section covers, in the
reader's order of need:

- installing the package, then running the installer once;
- opting a project in, with the committed `.pi/mcp.json` override and the `/mcp`
  → *Enable in this project* equivalent;
- that a committed override reaches linked worktrees and an uncommitted one does
  not;
- which agent dirs get the catalogue on their own (this repo's container, a
  per-checkout dir) and which need the command;
- adding a server to the catalogue;
- Figma's `clientName` compatibility value — what it is, and that it is the first
  thing to look at if sign-in fails;
- pinning the Playwright package if a release breaks, since the catalogue tracks
  the newest one.

It also stops referring to a `pi agent dir` command that does not exist. The
CHANGELOG records the feature, because it ships to other people.

Covers R8 and R9.

## Scope

Includes the README section under the existing setup table, the stale
`pi agent dir` reference, and the CHANGELOG entry. Leaves the code and its tests to
tickets 01–04: this ticket documents behavior that exists, and any command text it
prints must be one the earlier tickets actually ship.

## Acceptance criteria

- [ ] The README covers all seven points above, each in the section a colleague
      would look in.
- [ ] Every command the section prints exists as shipped (checked by running it,
      or against the merged source).
- [ ] No reference to `pi agent dir` remains anywhere tracked.
- [ ] The CHANGELOG entry states what a colleague gains and that nothing connects
      until a project opts in.
- [ ] The section names the file that holds the catalogue, so "add a server" has
      somewhere to point.

## Validation

A read of the rendered section against the acceptance list, plus the repository's
existing changelog-structure test. The guard that no doc repeats a value owned
elsewhere is `devcontainer-agent-dir.test.ts`; it is not extended here, but the
section must not hard-code an agent-dir path that ticket 03's script computes.
