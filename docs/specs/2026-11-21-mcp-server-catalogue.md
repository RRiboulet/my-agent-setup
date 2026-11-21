# MCP server catalogue: install once, enable per project

## Objective

This package can deliver extensions and skills to every project an agent works
in, but not MCP servers: `pi install` reads the `pi` manifest, which has no MCP
key, and pi reads MCP configuration only from `<agent dir>/mcp.json` and a
trusted project's `.pi/mcp.json`. So today an MCP server is either added by hand
in every agent dir or not at all.

The operator wants a small set of MCP servers — Figma and Playwright to start —
available in **every** place this package is installed (this host's ordinary
projects, this checkout's per-project agent dirs, this repo's devcontainer, and
colleagues who install the package), while **nothing connects by default**. A
project opts in with one key in its committed `.pi/mcp.json` or through `/mcp`.

The immediate user is the operator; the downstream user is a colleague who runs
`pi install git:github.com/RRiboulet/my-agent-setup` and expects the operator's
working setup, without inheriting two background processes and an OAuth prompt
in every project they open.

## Current behavior

- No MCP server is configured on this host: the agent dir holds `settings.json`,
  `auth.json`, `models-store.json`, `voice.json`, `trust.json`, `review-triage.json`
  and no `mcp.json`, so `/mcp` reports "No MCP servers configured. Add them to
  …/mcp.json or .pi/mcp.json."
- `package.json`'s `pi` manifest lists only `extensions` and `skills`. A git
  package is discovered from that manifest or from conventional directories
  (`docs/packages.md`, "Create a package"), so `pi install` cannot ship MCP
  configuration. `packages.md` documents no post-install hook either.
- `pi mcp add` writes `<agent dir>/mcp.json` (or `.pi/mcp.json` with `--local`)
  and has **no** flag for `enabled: false`; there is no shell command that
  creates a *disabled* entry.
- A project entry carrying only `enabled`, `exposure` and `toolExposure` merges
  onto a **global** server of the same name in `<agent dir>/mcp.json`. Against a
  name that exists only as an extension registration it fails with
  `server "<name>" needs "command" or "url", or a global server to override`
  (verified in the built `dist/extensions/mcp/config.js`).
- A server registered with `pi.registerMcpServer()` is *replaced* by an
  `mcp.json` entry of the same name, its enabled state is session-scoped, and
  `pi mcp list` cannot see it at all, because shell commands do not load
  extensions (`docs/mcp.md`, `docs/extensions.md`).
- `bin/pi-agent-dir` seeds `auth.json`, `models.json`, `models-store.json`,
  `voice.json` and `review-triage.json` into a per-checkout agent dir, and
  `--check` reports `settings`, `trust` and `shell`. It seeds no `mcp.json`.
- `.devcontainer/postCreate.sh` seeds this repo container's `settings.json` from
  the committed template `.devcontainer/pi/settings.json` and nothing else.
- `pi agent dir` does not exist (`pi --help`, Commands section), although the
  README refers to `$(pi agent dir)`; the agent dir is resolved from
  `PI_CODING_AGENT_DIR` or `~/.pi/agent`.

## Required behavior

R1. `mcp/catalogue.json` exists at the package root, in pi's `mcpServers` shape,
    so it can be copied rather than translated. Every entry has `"enabled":
    false`, an explicit `"exposure": "codemode"`, and no `auth`. Its first two
    members are `figma` (the streamable-HTTP URL `https://mcp.figma.com/mcp` with
    `oauth.clientName` set to the documented compatibility value) and
    `playwright` (the stdio `npx -y @playwright/mcp@latest` launch).

R2. An installer merges the catalogue into `<agent dir>/mcp.json`, adding only
    the names that are missing. A name already present — including one the user
    edited, pinned, or replaced with a full definition — is left byte-identical
    and reported as skipped. Other content in the file is preserved, including
    `autoEnableCodemode` and the file's own indentation; the directory and file
    are created when absent.

R3. Re-running the installer is idempotent: with a file that already contains
    every catalogue name, nothing changes and it reports that.

R4. The installer has two surfaces over one implementation: a session command
    `/mcp-catalogue`, and a shell entry point that a setup script or a container
    can run. Both resolve the agent dir the same way (`PI_CODING_AGENT_DIR`,
    else `~/.pi/agent`) and neither connects to a server or touches the network.

R5. Seeding, both the per-checkout agent dir (`bin/pi-agent-dir`) and this repo's
    container (`.devcontainer/postCreate.sh`), creates `<agent dir>/mcp.json`
    only when the file is absent. It never merges into an existing file, so an
    entry the operator deleted there is not resurrected by a rebuild, and a
    second run leaves an edited file untouched. `bin/pi-agent-dir --check`
    reports whether the catalogue is present.

R6. With the catalogue installed and no project override, no catalogue server
    connects: `pi mcp list` lists both, `pi mcp list` exits `0`, and a session's
    tool surface is unchanged apart from the one-line listing of disabled
    servers.

R7. Enabling a catalogue server in a project needs no code path of ours: a
    trusted project's `.pi/mcp.json` containing only `{ "mcpServers": { "figma":
    { "enabled": true } } }` connects that server, and `/mcp` → *Enable in this
    project* writes the same override.

R8. The README documents, under the existing setup table: the colleague recipe
    (install the package, run the installer once), the opt-in override and the
    `/mcp` equivalent, that a committed `.pi/mcp.json` reaches linked worktrees
    while an uncommitted one does not, how to add a server to the catalogue, the
    Figma `clientName` workaround, and the advice to pin `@playwright/mcp` if a
    release breaks. It also stops referring to a `pi agent dir` command that does
    not exist.

R9. `CHANGELOG.md` records the change, because it ships to other people.

## Non-goals

- No MCP server registered by extension code (`pi.registerMcpServer`), and no
  registration fallback for when `mcp.json` is absent.
- No write into a colleague's agent dir at session start: installing the
  catalogue is an explicit action.
- No credential in the catalogue, and no automatic OAuth sign-in. Signing in
  stays `/mcp login <server>` (or `/mcp`) once per agent dir.
- No change to `pi`'s own MCP behaviour, no `--disabled` flag contributed
  upstream, no wrapper around `pi mcp add`.
- No catalogue entries beyond Figma and Playwright in this change; no
  per-project catalogue of a colleague's own servers (a project that wants a
  server we do not ship defines it in full in its own `.pi/mcp.json`).
- No change to `defaultTools`, `autoEnableCodemode`, or any other setting.

## Constraints

- `auth` is global-only, and a project override may carry only `enabled`,
  `exposure` and `toolExposure`. Nothing version-like can ride in an override,
  so re-installation must be name-based and not rely on a marker.
- Entries pi's validator rejects are skipped by pi itself with a reported error,
  so a malformed catalogue would be a silent no-op in the agent dir. The
  installer refuses to write a catalogue that fails validation.
- The installer runs on a colleague's machine from a package clone whose path
  moves between installs, so it must be self-contained in the repository and
  invocable without an install-to-PATH step.
- Node standard library only, as in `tools/branch-base.mjs`: the shell surface
  must not depend on `jq` (unlike `bin/pi-agent-dir`, which already requires it)
  and must not need a TypeScript type-stripping flag.
- JSON is rewritten by our code, so formatting is our responsibility: preserve
  indentation and key order of untouched entries.

## Design decisions

**The catalogue is data, and it is the only copy.** `mcp/catalogue.json` sits at
the package root and the installer reads it. Rejected: reusing
`.devcontainer/pi/mcp.json` (host-side scripts would reach into the devcontainer
directory, and the file would mean two things), and one file per server (merge
machinery and a discovery rule for two entries).

**Copy is an add-only merge keyed by server name.** Rejected: overwrite by name,
which is what pi's own `addMcpServerConfig` does and would silently undo a local
pin; and never-touch-after-first-install, which leaves a colleague's file without
new servers and with no way to learn that.

**Delivery is file configuration written by an explicit command, not extension
registration.** Registration cannot satisfy the objective: it breaks the
project-override mechanism the whole design rests on (see Current behavior), its
enabled state does not persist, and `pi mcp list` cannot report on it. The cost
of this choice is the one manual invocation R8 documents.

**One implementation, two surfaces.** The merge lives in a single Node module in
`tools/`, which the shell entry point runs and the `/mcp-catalogue` command
imports; the shell side computes the agent dir itself because `pi agent dir`
does not exist. Rejected: a `jq` reimplementation for the shell side, which is a
second source of truth for merge semantics — the failure this repository names
repeatedly.

**Two seeding semantics, deliberately.** Seeding (`R5`) creates the file only
when absent; installing (`R2`) merges add-only. Seeding runs unattended on every
container rebuild and every `bin/pi-agent-dir` run, so it must never resurrect a
deleted entry; installing runs when a person asks, so adding a name the person
has not got yet is the point.

**Explicit `exposure: "codemode"`,** so a change to pi's default cannot silently
make two servers' tools appear in every request, and so the file states its
intent to whoever reads it.

**The Figma `clientName` workaround ships.** pi's own documentation pairs the
Figma URL with `oauth.clientName`, which reads as "Figma's authorization server
accepts registrations only from known clients". Shipping it means a colleague's
first sign-in has a chance of working; the README says what it is and that it is
the first thing to look at if sign-in fails.

## Test seams

1. `tools/mcp-catalogue.test.mjs` — spawns the real CLI against a temp agent dir
   and asserts the file's contents, following `tools/branch-base.test.mjs`
   (the contract is the process: exit code plus reported names) and
   `pi-agent-dir.test.ts` (real script, throwaway tree). This is the seam for
   R1–R4: add-only, skip, idempotence, formatting and key preservation, the
   absent-file case, an invalid catalogue, and the `PI_CODING_AGENT_DIR`
   resolution.
2. `pi-agent-dir.test.ts` — extended on its existing sandbox: after the script
   runs, the per-checkout agent dir has a catalogue file with every entry
   disabled; a pre-existing `mcp.json` is untouched; `--check` reports it. Covers
   R5 for the host half.
3. A static guard that `.devcontainer/postCreate.sh` invokes the same seeding
   command, in the style of `devcontainer-agent-dir.test.ts`. `postCreate.sh`
   needs root and a devcontainer to run, so the assertion is that the one line
   exists and names the command, not that it executed.
4. `/mcp-catalogue` registration, in the style of `extension-load.test.ts`,
   which already loads every manifest entry point. Covers R4's session surface
   and keeps the manifest honest together with `package-manifest.test.ts`.

R6 and R7 are verified by hand: only pi can say that a disabled server is not
connected, and only a trusted project can show the override resolving.

## Acceptance criteria

- [ ] R1: `mcp/catalogue.json` parses, its two entries carry `enabled: false`,
      `exposure: "codemode"`, and no `auth`; a test fails if a future entry does
      not.
- [ ] R2: installing into an empty agent dir creates the file with both names;
      installing over a file where `playwright` already exists with different
      `args` leaves that entry byte-identical and reports it skipped; an
      unrelated `autoEnableCodemode` key and the file's indentation survive.
- [ ] R3: a second install reports no additions and the file is unchanged
      (compared as bytes).
- [ ] R4: `/mcp-catalogue` is registered when the package loads; the shell entry
      point run with `PI_CODING_AGENT_DIR` pointing at a temp dir writes there,
      and run with it unset targets `$HOME/.pi/agent`.
- [ ] R5: `bin/pi-agent-dir` on a fresh sandbox leaves a catalogue file with both
      entries disabled; a pre-existing `mcp.json` is not merged into; `--check`
      mentions the catalogue. The container's `postCreate.sh` calls the same
      seeding command (static guard).
- [ ] R6: after installing in a temp agent dir, `pi mcp list` lists `figma` and
      `playwright`, connects to neither, and exits `0`.
- [ ] R7: in a trusted project whose `.pi/mcp.json` contains only the `enabled`
      override, `/mcp` shows `figma` enabled and the tools reachable; the same
      project with no override shows it disabled.
- [ ] R8: the README section exists and covers the six points named in R8.
- [ ] R9: `CHANGELOG.md` has an entry for the change.

## Verification

```bash
node --test tools/mcp-catalogue.test.mjs
node --test --test-concurrency=8 .pi/extensions/subagent/test/pi-agent-dir.test.ts \
  .pi/extensions/subagent/test/extension-load.test.ts \
  .pi/extensions/subagent/test/package-manifest.test.ts \
  .pi/extensions/subagent/test/mcp-catalogue.test.ts
node tools/branch-base.mjs                       # branch base, per AGENTS.md
```

Manual, for R6 and R7:

1. `PI_CODING_AGENT_DIR=$(mktemp -d) bash bin/mcp-catalogue` — or the same dir
   exported for a session — then `pi mcp list`: both servers listed, neither
   connected, exit status 0.
2. In a trusted project, write `.pi/mcp.json` with only
   `{ "mcpServers": { "figma": { "enabled": true } } }`, start a session, and
   check `/mcp` reports the project override; remove it and check it is disabled
   again.
3. `pi --no-mcp` in the same project still starts normally (R6's "no other
   behaviour changes" claim).

## Open assumptions

- **A package-installed extension can import a module outside `.pi/`.** The
  manifest lists extension entry points, and a clone contains the whole
  repository, so `tools/mcp-catalogue.mjs` should resolve. Risk: if pi copies or
  sandboxes extension files, the import fails at load time for every colleague;
  confirm by installing this package from a git source into a scratch agent dir
  and loading it. The fallback is to place the module inside the extension's own
  directory and have `bin/` reach it there.
- **A disabled server is "listed, not connected".** `pi mcp list` exits `1` only
  when an *enabled* server fails, which is what R6 assumes; the manual check in
  Verification settles it. If it turns out to exit non-zero for a disabled
  server, R6's exit-status clause is dropped and the listing assertion stands.
- **The Figma entry works with `oauth.clientName` from pi.** It is what pi's
  documentation demonstrates; only a real sign-in proves it, and that is a
  per-agent-dir manual step (non-goal to automate).
- **Playwright at `@latest` is acceptable for colleagues.** Accepted in
  conversation; if a release breaks, the README's pin advice is the fix and this
  assumption is revisited then.
