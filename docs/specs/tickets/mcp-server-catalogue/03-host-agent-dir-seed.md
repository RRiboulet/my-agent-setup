# 03: The per-checkout agent dir starts with the catalogue

**Blocked by:** 01
**Status:** ready

## What to build

Running `bin/pi-agent-dir` for a checkout produces an agent dir that already has
`mcp.json` with both catalogue servers disabled, so a host working inside this
repo or any of its worktrees never has to install them. The file is created only
when absent: an existing `mcp.json` is left exactly as it is, and an entry deleted
there is not resurrected by a re-run. `--check` reports the catalogue's presence
alongside the settings, trust and shell lines it already prints.

Covers the host half of R5 and the seeding semantics the spec separates from
ticket 01's add-only install.

## Scope

Includes the seed step in the agent-dir script, the `--check` line, and the
existing sandbox tests extended for both. Leaves the container's seeding to ticket
04, which calls the same seeding mode.

The seed mode is a flag on ticket 01's module rather than a second implementation:
create the file only when it does not exist.

## Acceptance criteria

- [ ] On a fresh sandbox, `bin/pi-agent-dir` leaves an `mcp.json` in the created
      agent dir with both catalogue names, all disabled.
- [ ] A sandbox whose agent dir already has an `mcp.json` — including one missing
      a catalogue name, or one with `figma` disabled by the user — comes out
      unchanged, byte for byte.
- [ ] A re-run changes nothing and stays silent about the catalogue.
- [ ] `--check` prints a catalogue line for a dir that has the file and fails (or
      warns, matching the script's existing severity for a missing seed) when it
      does not.
- [ ] The script still works when the catalogue cannot be read, reporting a note
      rather than aborting the whole seed of settings, credentials and trust.

## Validation

`pi-agent-dir.test.ts` extended on its existing throwaway-home sandbox, asserting
the filesystem effects directly as the other cases there do. Which spec behaviors
it covers: R5's host half, and the seeding-versus-installing distinction (the file
is not merged into).
