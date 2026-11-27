# 01: One command installs the catalogue into an agent dir

**Blocked by:** None (can start immediately)
**Status:** done - merged in #182 (2026-11-21); the Playwright entry's browser flags amended in #185

## What to build

The catalogue data file and the single merge implementation, reachable from a
shell. Run one command in an environment whose agent dir has no MCP
configuration, and `<agent dir>/mcp.json` afterwards lists `figma` and
`playwright` with `enabled: false`, an explicit `codemode` exposure, and no
`auth`. Run it again and nothing changes. Add `playwright` by hand with a pinned
`args` first, and the command leaves that entry byte-identical and says it
skipped it. Nothing connects and no network call happens at any point.

Covers R1 (catalogue shape), R2 (add-only merge), R3 (idempotence), and the
shell half of R4 (agent-dir resolution from `PI_CODING_AGENT_DIR`, else the
default).

## Scope

Includes the catalogue data, the merge module and its process-level contract,
the shell entry point, and the tests at that seam. Leaves the session command to
ticket 02, and installing into the two agent dirs we seed to tickets 03 and 04 —
this ticket creates the module they will call.

The merge module is Node standard library only and is written as plain
JavaScript, following `tools/branch-base.mjs`, so a colleague's Node runs it
without a type-stripping flag. It exposes the merge as a function and as a
command, since 02 imports the function.

## Acceptance criteria

- [ ] The catalogue file parses, its two entries carry `enabled: false`,
      `exposure: "codemode"`, and no `auth`; a test fails if a future entry does
      not.
- [ ] Installing into an empty agent dir creates the file and reports both
      names added.
- [ ] Installing over a file that already defines `playwright` with different
      `args` leaves that entry byte-identical, reports it skipped, and still
      adds `figma`.
- [ ] An unrelated `autoEnableCodemode` key and the file's indentation survive a
      merge.
- [ ] A second install changes no byte of the file and reports nothing added.
- [ ] A catalogue entry pi's validator rejects makes the command refuse to write
      and exit non-zero.
- [ ] The command resolves the agent dir from `PI_CODING_AGENT_DIR` when set and
      from the home default when not.

## Validation

`tools/mcp-catalogue.test.mjs`, spawned against temp agent dirs, in the style of
`tools/branch-base.test.mjs` (the contract is the process: exit code and reported
names) and `pi-agent-dir.test.ts` (real script, throwaway tree).

Manual, for the two behaviors only pi can show:

1. After installing into a temp agent dir, `pi mcp list` lists both servers,
   connects to neither, and exits 0 (settles the spec's open assumption about
   disabled servers).
2. In a trusted project whose `.pi/mcp.json` holds only
   `{ "mcpServers": { "figma": { "enabled": true } } }`, `/mcp` reports the
   project override and the tools become reachable; removing it disables the
   server again. `pi --no-mcp` still starts normally in the same project.
