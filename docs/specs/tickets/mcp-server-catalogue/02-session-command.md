# 02: `/mcp-catalogue` installs the catalogue from inside a session

**Blocked by:** 01
**Status:** ready

## What to build

A colleague who has installed the package runs `/mcp-catalogue` in a session and
gets the same file ticket 01's shell command produces, from the same
implementation — no second copy of the merge semantics. The command is registered
when the package loads, needs no arguments, reports added and skipped names in the
session, and does not connect to a server.

Covers the session half of R4.

## Scope

Includes one new extension entry point, its addition to the manifest's extension
list and to the hand-maintained entry-point list in `extension-load.test.ts`, the
command's registration test, and the load-time check below. Leaves every file
ticket 01 owns untouched except the entry point it adds.

**Start here:** confirm the assumption the design rests on — that an extension
loaded from a **git-installed package clone** can import a module outside the
extension directory. Install this package into a scratch agent dir, load it, and
see the import resolve. If it does not, the module moves inside the extension's
own directory and the shell entry point reaches it there; report which way it
went before writing the command.

## Acceptance criteria

- [ ] `/mcp-catalogue` is registered when the package loads, and running it in an
      agent dir with no MCP configuration produces the file ticket 01 produces,
      with both entries disabled.
- [ ] Running it twice in one session changes nothing the second time and says
      so.
- [ ] The extension adds nothing to the session's tool surface beyond the command.
- [ ] The manifest and `extension-load.test.ts` both list the new entry point, and
      `package-manifest.test.ts` passes.
- [ ] The command still works when the importing session's cwd is a trusted
      project that has its own `.pi/mcp.json` — the file written is the agent
      dir's, never the project's.

## Validation

`node --test` on a new behavior test beside `extension-load.test.ts`, driving the
command's handler against a temp agent dir; plus
`.pi/extensions/subagent/test/package-manifest.test.ts` and
`extension-load.test.ts` to prove the package still loads under the strict ESM
loader.

The clone-import check is a manual install into a scratch agent dir, recorded in
the ticket's implementation notes with its outcome.

## Implementation notes

The clone-import check was performed and passed, by three independent routes:

- A real `git:` install served from a local git daemon into a scratch agent dir:
  pi cloned the package to `<agent dir>/git/<host>/<org>/<repo>`, a
  non-interactive session loaded `.pi/extensions/mcp-catalogue.ts` from the
  clone, and the relative import of `../tools/mcp-catalogue.mjs` resolved (the
  extension wrote a marker file naming the resolved module path).
- A simulated clone layout loaded through pi's own jiti loader: one command
  registered, no tools, no MCP server, nothing written at load.
- The same clone layout loaded through Node's type-stripping loader, which is
  the strictest of the three: the factory loaded, `/mcp-catalogue` was the only
  registration, `registerMcpServer` was never called, and the clone's own
  `tools/mcp-catalogue.mjs --help` resolved its catalogue beside it.

Because a git-installed package is a whole clone, `tools/` and `mcp/` sit beside
`.pi/` and the fallback named in "Scope" (moving the module inside the extension
directory) was not needed. The one requirement this imposes, and which the
extension's comment records, is that the extension must never resolve anything
through `process.cwd()`: at runtime it lives under `<agent dir>/git/…`.

Shipped surface, as built: `/mcp-catalogue`, no arguments (an argument prints
the usage rather than installing and looking as if it obeyed), reporting one of
`created <path> — added figma, playwright, all disabled, so nothing connects
until a project enables one`, `added <name> to <path> — skipped …`, or
`nothing added to <path> — skipped …`; a refusal is a single error beginning
`mcp-catalogue: nothing was written`.
