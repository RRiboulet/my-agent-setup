# pi coding-agent extensions

Personal pi extensions, skills and the devcontainer that runs them.

Nothing here depends on npm publishing. The repository doubles as a pi
package, so these extensions can be installed into any other project:

```bash
pi install git:github.com/RRiboulet/my-agent-setup          # for me, every project
pi install --local git:github.com/RRiboulet/my-agent-setup  # pin for one project only
```

Verified on a clean agent dir and an empty project: both install every
extension and skill the `pi` manifest below lists. That check predates
`review.ts`, `continue.ts`, `opencode-go-provider/`, `repo-explorer/`,
`review-triage/`, `btw/` and `voice/`; the manifest is kept honest by
`test/package-manifest.test.ts`, and every entry point by the strict-ESM load
test under Tests.

The one non-obvious part is that this needs the `pi` manifest in
`package.json`. A git-sourced package is discovered either from that manifest or
from conventional `extensions/`, `skills/`, `prompts/` and `themes/` directories
at the package root — and this repo keeps its resources in `.pi/extensions/`,
which is dot-prefixed, so a glob will not find it. The manifest therefore lists
each entry point explicitly:

```jsonc
// package.json
"pi": {
  "extensions": [
    ".pi/extensions/answer.ts",
    ".pi/extensions/continue.ts",
    ".pi/extensions/goal.ts",
    ".pi/extensions/mcp-catalogue.ts",
    ".pi/extensions/native-web-search.ts",
    ".pi/extensions/opencode-go-provider/index.ts",
    ".pi/extensions/repo-explorer/index.ts",
    ".pi/extensions/review-triage/index.ts",
    ".pi/extensions/review.ts",
    ".pi/extensions/session-breakdown.ts",
    ".pi/extensions/todos.ts",
    ".pi/extensions/subagent/index.ts",  // the rest of that dir is its internals
    ".pi/extensions/voice/index.ts"
  ],
  "skills": [
    ".pi/skills/add-model",
    ".pi/skills/benchmark-checklist",
    ".pi/skills/blast-radius",
    ".pi/skills/commit",
    ".pi/skills/devcontainer",
    ".pi/skills/diagnosing-bugs",
    ".pi/skills/github",
    ".pi/skills/grilling",
    ".pi/skills/handoff",
    ".pi/skills/idempotent-operations",
    ".pi/skills/implement",
    ".pi/skills/in-your-own-words",
    ".pi/skills/librarian",
    ".pi/skills/native-web-search",
    ".pi/skills/prevent-recurrence",
    ".pi/skills/prove-it-works",
    ".pi/skills/show-me-your-work",
    ".pi/skills/tdd",
    ".pi/skills/teach",
    ".pi/skills/tmux",
    ".pi/skills/to-spec",
    ".pi/skills/to-tickets",
    ".pi/skills/update-changelog",
    ".pi/skills/worktree"
  ]
}
```

Without that file `pi install` succeeds, clones the repo, and quietly loads
nothing.

Pinning works the usual way — append a tag or a commit:
`git:github.com/RRiboulet/my-agent-setup@<ref>`. One caveat worth knowing:
`v1.0.0` is not empty, but it is the old layout — the resources sit in
conventional root `extensions/` and `skills/`, which pi discovers without any
manifest, so pinning to it installs four extensions and one skill (no
`/session-breakdown`, no `commit` or `update-changelog`). What installs
*nothing* is the stretch between the move to `.pi/` and the manifest commit
`e4e072f`: dot-prefixed directories are not found by a glob, so the install
succeeds, clones, and quietly loads zero resources. Pin a ref at or after
`e4e072f`, or track `main`.

Project-local extensions only load **after you grant project trust**, so on a
fresh machine pi asks on first start; until then the extensions are silently
inactive. Installed packages are loaded regardless of project trust.

### One copy of the extensions, never two

Pi discovers extensions from the project (`.pi/extensions`, `.pi/skills`) *and*
from every installed package — and this package's resources are exactly those two
directories. So a checkout of this repo that *also* has the package installed
loads each extension twice, and pi treats a duplicate tool registration as a load
error, not a warning:

```
Error: Failed to load extension "…/agent/git/github.com/RRiboulet/my-agent-setup/.pi/extensions/goal.ts":
  Tool "get_goal" conflicts with /workspace/.pi/extensions/goal.ts
… one line per duplicated tool and flag …
Hint: Start without extensions using "pi -ne".
```

The TUI then exits 1 instead of starting. `pi --version` and `pi --list-models`
print the same lines and carry on, so a quick check looks healthy; and the
extensions that register no tool or flag (`/answer`, `/btw`, `/continue`,
`/review`, `/session-breakdown`, repo-explorer, `/voice`) load twice in silence.
Skills collide the same way, but as a first-one-wins collision diagnostic, so
they never raise the error by themselves.

Both environments therefore keep the working tree as the single source:

| Where | Setup |
|---|---|
| a host that works in this checkout | `pi remove git:github.com/RRiboulet/my-agent-setup`, then `pi install /path/to/my-agent-setup` — the **local path**, not the git source. It resolves to the same files project discovery already found, so pi dedupes instead of conflicting, and there is no clone that can fall behind the checkout |
| this repo's devcontainer | installs no package at all: `PI_CODING_AGENT_DIR` (`.devcontainer/devcontainer.json`) gives the container its own agent dir on a **private** volume, `my-agent-setup-pi-config`. There is no shared agent volume any more, and `postCreate.sh` starts a missing `settings.json` from the committed template `.devcontainer/pi/settings.json` (which deliberately has no `.packages`). Credentials come from the host environment, not from a copied `auth.json` |
| every other project's devcontainer | the image bakes this repo at the tag in that project's `.devcontainer/pi-agent-setup.version`, then `postCreate` declares the baked `/opt/pi-packages/my-agent-setup` path in the container's own agent settings. No volume is shared between containers. The pin is visible as `PI_AGENT_SETUP_TAG`, the image label `org.rriboulet.pi-package`, and `/opt/pi-packages/my-agent-setup/.pi-agent-setup-tag`; each project's CI fails if its Dockerfile and version file disagree, and `postCreate` fails if the running image is older than the checkout's pin |
| a host that works in this checkout **and in its worktrees** | `bin/pi-agent-dir` does the devcontainer's split on a host: it creates `~/.pi/agent-<main checkout directory name>`, a sibling of the shared agent dir, seeded from the shared settings with `.packages` removed, plus credentials and a `trust.json` entry for the checkout. The *shape* is the one `devcontainer.json` declares; the *name* is the checkout directory's, not the project's, so the two differ wherever the directory is not named after the repo — this container mounts the repo at `/workspace`, where the script would compute `agent-workspace` while the container's own dir carries the project's name. That is intended: the script is for hosts, and a host whose directory has another name needs no configuring, because the hook derives the same name at call time. `bin/pi-agent-dir --shell` adds one marker-delimited block to `~/.bashrc` with a `pi` function that selects that dir for any cwd inside the checkout or a worktree of it, and leaves every other project on the shared, package-installed dir |

Removing the git entry matters: installing the local path *next to* it leaves two
entries pointing at different paths (the checkout and the clone), which is the
conflict again. Note what the local entry actually stores: `pi` rewrites it to a
path relative to the agent dir (`normalizePackageSourceForSettings`), e.g.
`../../my-agent-setup` for `~/my-agent-setup`. It therefore encodes *both*
locations, and moving either the checkout or `~/.pi/agent` makes it resolve to
nothing — silently, because a missing local source is skipped, not reported. Re-run
`pi install <path>` after either moves.

**A linked worktree is the same trap one level down, and the local-path entry
does not cover it.** The entry dedupes against project discovery only because
both name files in the same checkout. A child process rooted in
`.worktrees/<slug>` discovers *that tree's* `.pi/extensions` as its project
extension, while the package still resolves to the main checkout's copy — two
different files registering the same tools and the same `--attach-subagent`
flag, so pi exits 1 with one `Tool "…" conflicts with
…/.worktrees/<slug>/.pi/extensions/…` line per extension. This is not the bug the
subagent launcher fixed: it reproduces with no `--extension` at all, and there
is no *selective* way to suppress the package copy for one run. `PI_PACKAGE_DIR`
overrides pi's own install path, not the installed extensions;
`--no-extensions` (`-ne`) does drop package discovery, but it also disables the
built-in extensions and every extension not named with `-e`, so it is a lossy
workaround rather than a dedupe. The launcher therefore cannot fix it. The
devcontainer is immune for the same reason
as above — its agent dir installs no package. On a host that installs this repo
as a package, the remedy is `bin/pi-agent-dir` (below): the worktree's own copy
is then the only one loaded, which is also the only variant that runs the
*branch's* extension code. The two fallbacks are worse — uninstall the package
there and every other project loses its extensions, or launch with `cwd` = the
main checkout and `cd` into the tree inside each command, which starts but runs
the main checkout's extensions, not the branch's.

`bin/pi-agent-dir` writes only what is missing, so re-running it is safe: an
existing `settings.json` is kept (it belongs to that project from then on, like
the container's), credentials are copied once and never overwritten,
`trust.json` is merged rather than replaced so a second project does not evict
the first, and `mcp.json` is seeded from the catalogue only when it is absent, so
an entry deleted there stays deleted — see
[MCP servers](#mcp-servers-installed-once-enabled-per-project). Trust matters
more here than it looks: it is what makes pi read
`<checkout>/.pi/` at all, and a saved decision applies to a directory or any of
its parents, so the one entry covers `.worktrees/<slug>`. Without it the
package-free dir is a *silently empty* agent — no extensions, no skills — rather
than a broken one. `--check` reports those four things — the catalogue as a
warning, because a dir works without it — and exits non-zero if a package would
still conflict; `--print` resolves the path without writing anything.

**A launcher that bypasses a login shell gets none of that.** The hook lives in
`~/.bashrc`, so a tmux child, a CI step, a scheduled job or an editor task starts
`pi` without it and lands back on the shared, package-installed agent dir — the
worktree conflict above, from a process nobody is watching. `bin/pi-wrapped` is
the command for those: it selects the same per-project dir and forwards every
argument to `pi` unchanged, with no option of its own (a flag it saw is a flag
for `pi`, and `--`, `@file` arguments and values with spaces are passed as
given). An agent dir already in the environment wins, because an explicit choice
outranks a derived one; outside a git checkout, or when the project's dir has
never been created, it runs `pi` with its defaults and says why on stderr rather
than failing. It never creates the dir: one without trust is a *silently empty*
agent, and seeding the user's agent root as a side effect of starting `pi` is not
a launcher's job — `bin/pi-agent-dir` is the one-time step, and the wrapper names
it in the note.

In the devcontainer, that dir is the container's own and the volume is private:
the model and tool defaults start from `.devcontainer/pi/settings.json`, and
everything else is created in the container. Rotate a key or change a default *in
the container*; no other container sees it. Sessions stay on the private volume,
so history from before the split (on the old shared volume) does not appear in
`--continue` here. `gh`'s non-secret config lives at `GH_CONFIG_DIR` on the private
volume, while its token arrives as `GH_TOKEN` from the host environment.

Credentials for every container come from one host-side file,
`~/.config/devc/env` (mode 600, never committed): `devc` sources it before
`devcontainer up`, and each `devcontainer.json` passes the variables in with
`${localEnv:...}`. `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `BRAVE_API_KEY`,
`TYPESAFE_API_KEY` and `GH_TOKEN` are the current set; `PI_VOICE_API_KEY` reuses
the OpenRouter key. Values therefore appear in `docker inspect` and in child
process environments. That is the accepted trade-off: it keeps credentials
shared without any cross-container mount or coupling.

### MCP servers: installed once, enabled per project

`pi install` ships this package's extensions and skills and **none of its MCP
servers**: the `pi` manifest has no MCP key, and pi reads MCP configuration only
from `<agent dir>/mcp.json` and a trusted project's `.pi/mcp.json`. The servers
are therefore a catalogue in [`mcp/catalogue.json`](mcp/catalogue.json) — Figma
over streamable HTTP, Playwright through `npx -y @playwright/mcp@latest
--browser chromium --headless` — and one command that ships with the clone
installs it:

```bash
bash bin/mcp-catalogue      # from the clone; in a session: /mcp-catalogue
```

`pi install` (the top of this file) is the first half of that setup; this is the
second, and it runs once per agent dir that should have the servers — from the
clone, by path, with no PATH entry, no `jq` and no build step.

That merges the catalogue into `<agent dir>/mcp.json`, where the agent dir is
`$PI_CODING_AGENT_DIR` when it is set and non-empty, else `~/.pi/agent`. It
**adds only the names you have not got**: an existing `figma` or `playwright`
entry — one you edited or pinned — is left byte-identical and reported as
skipped, and every other byte of the file survives, unrelated keys and its
indentation included. Re-running it reports nothing added and changes nothing.
`--if-missing` is the other mode, create the file only when it is absent and
never merge into it: that is what the two automatic paths below use, and a
person rarely needs it. Exit `1` means it refused to write and changed nothing
(invalid catalogue, or an `mcp.json` it cannot merge into); exit `2` means it
could not run. `bash bin/mcp-catalogue --help` prints the whole contract.

**Nothing connects until a project opts in.** Every catalogue entry ships
`"enabled": false` with an explicit `"exposure": "codemode"`, so installing it
starts nothing — no process, no sign-in prompt, no tool in any request. `pi mcp
list` only lists them:

```console
$ pi mcp list
figma: disabled (codemode, global)
  https://mcp.figma.com/mcp
playwright: disabled (codemode, global)
  npx -y @playwright/mcp@latest --browser chromium --headless
```

**Opt a project in with one key** in its committed `.pi/mcp.json`:

```json
{ "mcpServers": { "figma": { "enabled": true } } }
```

That is the whole override: a project entry carrying only `enabled`, `exposure`
or `toolExposure` layers onto the global server of the same name and keeps its
`url`, `args` and `oauth`. The same thing without typing: `/mcp`, select the
server, *Enable in this project* — in a trusted project, that writes exactly
this override. `/reload` picks up a change made outside the session.

Two facts about that file have bitten before. A **committed** `.pi/mcp.json`
reaches every checkout of the branch, linked worktrees included, because it is
part of the tree; an **uncommitted** one exists only in the working tree you
wrote it in, so a worktree started from the same branch sees nothing. And an
override needs the global entry to exist: without the catalogue installed,
`{"figma": {"enabled": true}}` is a hard configuration error (`server "figma"
needs "command" or "url", or a global server to override`), while in an
**untrusted** project the file is ignored in silence — project trust is what
makes pi read `.pi/` at all.

**Which agent dirs get it without the command.** Two, both through
`--if-missing`, so neither ever merges into a file that already exists:

- this repo's devcontainer, from `postCreate.sh`, when the private volume is
  fresh;
- a per-checkout agent dir, when `bin/pi-agent-dir` creates it — `--check`
  reports the catalogue file and warns rather than fails when it is missing.

Everything else needs the command once per agent dir: `~/.pi/agent` on a host,
another project's container, a machine where the package was installed by git
source. Because seeding never merges, an entry you delete from one of those dirs
stays deleted across a rebuild or a re-run; only the explicit command adds a
newly catalogued server.

**Signing in is once per agent dir, not per project.** Figma's server uses
OAuth: `/mcp login figma` (or `pi mcp login figma`) opens the authorization page
and stores the token in the agent dir's `mcp-auth.json`, so every project on
that dir shares it.

**Figma's `clientName` is a compatibility value, and it is the first thing to
look at if sign-in fails.** The catalogue sends `"oauth": { "clientName":
"Claude Code" }`, which tells Figma's authorization server that the client
registering is one it recognises — pi's own documentation pairs this URL with
it. If the sign-in is rejected, change or drop that field in your own `mcp.json`
before looking anywhere else; the installer skips an entry that already exists,
so your edit survives every re-run.

**Playwright needs its browser installed once per machine.** The catalogue asks
for Playwright's own Chromium on purpose: the `chrome` channel the server
defaults to cannot be installed on arm64 hosts, and the headed default cannot
open a window where pi runs headless. One install per machine, using the same
Playwright version the server ships so the browser build numbers agree:

```bash
npx --package @playwright/mcp@latest -- playwright install chromium   # ~130 MB
sudo npx --package @playwright/mcp@latest -- playwright install-deps chromium
```

Without them the server still connects and lists its tools, and every action
fails with an `Executable doesn't exist` or `Missing system dependencies` error
that names the command to run. Neither is a project concern, so nothing about
them belongs in a project's `.pi/mcp.json`.

**Playwright tracks the newest release, so a broken one is a pin away.** The
catalogue launches `npx -y @playwright/mcp@latest`. If a release breaks, edit
your own entry to `"args": ["-y", "@playwright/mcp@<version>", "--browser",
"chromium", "--headless"]` and re-run the installer freely: `playwright` is
already present, so it is reported as skipped and your pin is not undone. The
same rule cuts the other way, and it is worth knowing before you look for a bug
in the catalogue: a change to the catalogue's own arguments does not reach an
entry you already have. Delete that entry from your `mcp.json` and re-run the
installer to take the new one.

**Adding a server to the catalogue** is one object in
[`mcp/catalogue.json`](mcp/catalogue.json) under `mcpServers`, then the
installer in each agent dir that should have it:

```json
"my-server": {
  "command": "npx",
  "args": ["-y", "my-mcp-server"],
  "enabled": false,
  "exposure": "codemode"
}
```

Name it with letters, digits, `_` and `-` only; give it `command` or `url`, not
both; keep `enabled: false` and state `exposure` explicitly, because the
catalogue's promise that nothing connects must not depend on pi's defaults; and
never put `auth` in it — a credential belongs to the agent dir that signs in.
The installer validates the catalogue before writing and exits `1` with the
reason, rather than writing an entry pi would skip with one line in a log.

## Upgrading to v1.12.0

Two changes need an action on an existing install. This block is replaced at each
release, not accumulated — the reasoning stays in the `CHANGELOG.md` entry.

**Install this repo by local path, not `git:`.** If `pi` here now exits 1 with
`Tool "…" conflicts with …`, the package and this working tree are both providing
the extensions; that is the trap above under "One copy of the extensions, never
two", and the fix is to replace the package entry:

```bash
pi remove git:github.com/RRiboulet/my-agent-setup
pi install /path/to/my-agent-setup
```

**Delete any `opencode-go` web-search provider.** The Go plan never actually
searched — its models accept the `web_search` tool definition and answer from
memory — so an explicit `--provider opencode-go` or
`PI_WEB_SEARCH_PROVIDER=opencode-go` is now an error instead of a silent
fallback behind another plan's budget. Remove the value rather than replace it:
**Brave is the first choice whenever a Brave key resolves** (`BRAVE_API_KEY`,
else a `brave`/`brave-search` entry in `auth.json`), OpenRouter is the native
default when it does not, and the `opencode-go` credential itself still serves
`/model`.

## Contents

| Path | What it is |
|---|---|
| `package.json` | the `pi` manifest that makes this repo installable as a package (see above) |
| `.pi/extensions/subagent/` | Non-blocking tmux-backed delegation: `subagent`, `subagent_status`, `subagent_wait`, `subagent_resume`, `subagent_interrupt`, `subagent_cancel`, `subagent_clean`, a live child-activity phase and a status widget above the editor; every run that reports a final answer (completed or failed) leaves a `report.md` artifact with it, plus a bounded copy and a pointer in its run record |
| `.pi/extensions/todos.ts` | `/todos` TUI and the `todo` tool |
| `.pi/extensions/answer.ts` | `/answer`: extract questions from the last response and answer them in a focused TUI |
| `.pi/extensions/continue.ts` | `shift+alt+enter` sends the literal prompt `continue`, but only when the agent is idle, so it never steers or queues a message mid-run. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), unmodified |
| `.pi/extensions/review.ts` | `/review` and `/end-review`: PR, branch, commit, folder and uncommitted review modes, loop-fixing, custom instructions, project-level `REVIEW_GUIDELINES.md`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with two local changes — see below |
| `.pi/extensions/mcp-catalogue.ts` | `/mcp-catalogue`: install this package's MCP server catalogue into the agent dir, every server disabled — see [MCP servers](#mcp-servers-installed-once-enabled-per-project). **Ours** |
| `.pi/extensions/goal.ts` | `/goal` and the `get_goal`/`create_goal`/`update_goal` tools: a long-running objective that auto-continues across turns with an optional token budget, its state appended to the session log and reconstructed on reload/tree navigation. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with three local changes — see below |
| `.pi/extensions/session-breakdown.ts` | `/session-breakdown`: sessions, messages, tokens and cost per day over 7/30/90, model breakdown, contributions-style calendar. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with four local patches — see below |
| `.pi/extensions/native-web-search.ts` | Native web search tool — **ours**, not upstream: it registers the `web_search` tool. Ships with `.pi/skills/native-web-search/`, which *is* vendored |
| `.pi/extensions/repo-explorer/` | `/explore`: browse a branch's file tree with a directory-by-directory fuzzy filter and print a file into the transcript, or quick-open `/explore <path> [branch]` / `<branch>:<path>` to skip the menus. Read-only git resolved against the session cwd; the process runner, branch menu, browser, transcript renderer, display sanitizer and argument grammar are separate internals. **Ours** |
| `.pi/extensions/review-triage/` | `triage_change` tool and `/triage`: measure a finished change from its git diff, ask a calibrated decision model (Jev, via `ctx.modelRegistry.classify()`) whether it needs an adversarial and/or complexity review, how hard each should push and which allowed model should run it, and return a depth-runged, fallback-chained plan for the `subagent` tool. Policy (judge model, candidates, thresholds, chains) lives in `~/.pi/agent/review-triage.json` — this repo ships it as `review-triage.example.json` beside the extension, with every candidate on `opencode-go` and only the judge on another provider; the verdict is appended to the session for audit. **Ours** |
| `.pi/extensions/voice/` | `/voice`: dictation with the phone as microphone — start `termux-microphone-record` over ssh, fetch the m4a, transcribe it through an OpenAI-compatible `/audio/transcriptions` endpoint, and paste the transcript at the cursor (or submit it with `autoSubmit`). `/voice cancel` aborts; `alt+r` (and `ctrl+shift+r` on a Kitty terminal) toggle the same cycle. **Ours** |
| `.pi/extensions/btw/` | `/btw`: opens a panel and asks for the question (submit it empty to reopen a running panel), then answers in-process from the exact conversation prefix, so the provider prompt cache is reused; the streaming answer is shown in its own tmux popup, rendered by pi-tui's own `Markdown` component in pi's own theme — the panel draws the answer with the renderer and the colours the transcript draws an assistant message with. Neither the question nor the answer enters the transcript. Escape returns to pi while the answer keeps running; a new question replaces the panel. **Ours** |
| `.pi/extensions/opencode-go-provider/` | An `opencode-go` provider for `/model`: fast GLM, Kimi, MiniMax, Qwen, DeepSeek and Grok models via opencode.ai's Go API, with the correct wire protocol per model (Anthropic, OpenAI Completions, Responses) and a per-account usage-budget widget below the editor. **Vendored** from [monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider) (MIT), byte-identical to upstream — see below |
| `.pi/skills/native-web-search/` | Script + docs for the above. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/native-web-search/`, with local provider patches: OpenRouter support, unknown-provider rejection, and a test seam (`__test__` + direct-invocation guard). The two must travel together |
| `.pi/skills/commit/` | Conventional Commits subjects, and the branch-per-change rule from `AGENTS.md`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/commit/SKILL.md`, with two local adaptations |
| `.pi/skills/in-your-own-words/` | Plays the goal, done-when, scope and risky assumptions back before non-trivial work; asks only about decisions, never facts. Part of the coding skill stack below |
| `.pi/skills/grilling/` | Interviews the user in rounds about a plan, decision or idea until every branch of the design tree is settled: ask the whole frontier, recommend an answer per question, find facts yourself with a `subagent`, leave the decisions to them. **Ported** from mattpocock/skills `skills/productivity/grilling`, with its user-invoked `grill-me` wrapper folded in rather than shipped as a second skill |
| `.pi/skills/blast-radius/` | Finds what a change can break beyond its diff, names the one fact it is safe because of, and proves it by running real code |
| `.pi/skills/tdd/` | Red-green-refactor at public seams, one vertical slice at a time, with the two-imagined-edits test and mocking rules |
| `.pi/skills/diagnosing-bugs/` | Feedback loop first, then reproduce, minimise, rank hypotheses, instrument, and fix the root cause with a regression test |
| `.pi/skills/idempotent-operations/` | Retries, consumers, jobs, locks and migrations that converge however many times they run or however far a previous run got |
| `.pi/skills/add-model/` | Add or fix a model in the opencode-go provider: thinking levels, reasoning flags, cost tiers. **Ours** |
| `.pi/skills/benchmark-checklist/` | Seven questions that vet a performance number before it is reported or acted on |
| `.pi/skills/show-me-your-work/` | Append-only TSV decision log for a big task left unsupervised for a long time, self-audited before handing back; `scripts/log.sh` writes a sanitised row |
| `.pi/skills/prove-it-works/` | Verifies the real artifact, runs the repository's quality gate, checks the final diff for scope and hygiene, and reports statuses with honest meaning. The one finishing step — it never starts a reviewer |
| `.pi/skills/prevent-recurrence/` | Turns the second correction of one mistake class into a check at the highest level that works — architecture, type, lint, test, then prose — proves it at the bad and good revision, ratchets existing findings, and records the rule with its enforcer in `AGENTS.md`'s "Rules and enforcement" table. **Ours**, adapted from pstack's `/correct` and `principle-encode-lessons-in-structure`; `scripts/rule-table.mjs` is the checker |
| `.pi/skills/to-spec/` | User-invoked `/skill:to-spec`: writes the conversation up as a spec with test seams and acceptance criteria |
| `.pi/skills/to-tickets/` | User-invoked `/skill:to-tickets`: splits a spec into tracer-bullet tickets with blocked-by edges |
| `.pi/skills/implement/` | User-invoked `/skill:implement`: builds a spec or ticket end to end through the skills above |
| `.pi/skills/handoff/` | User-invoked `/skill:handoff`: writes a handoff document a fresh session can continue from |
| `.pi/skills/teach/` | User-invoked `/skill:teach`: teaches a topic across sessions in a stateful workspace of short cited HTML lessons, reference sheets, vetted resources, a glossary and ADR-style learning records. **Ported** from mattpocock/skills `skills/productivity/teach`, with the workspace kept out of any project checkout and the glossary format linked instead of orphaned |
| `.pi/skills/writing-for-agents/` | How to write any document an agent consumes — context pointers, the two loads, the information hierarchy, steps and completion criteria, splitting, leading words and pruning — plus `references/skill-mechanics.md` for the skill-specific branch. **Ported** from mattpocock/skills `skills/productivity/writing-for-agents`, with upstream's `agents/openai.yaml` not carried over |
| `.pi/skills/devcontainer/` | Drive a project's devcontainer from a headless host: `devc` (`devcontainer up` + `exec`), the rule that an agent must never run the attaching form, long-build and long-server recipes, the volume/uid/port rules that prevent damage, and a symptom→fix table. **Ours** |
| `.pi/skills/github/` | gh CLI usage: PRs, CI runs, `gh api`, structured JSON. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/github/SKILL.md`, with four local adaptations — this repo's `GH_CONFIG_DIR` auth setup, the AGENTS.md squash workflow, the token rule, and the credential-helper note |
| `.pi/skills/librarian/` | Caches and refreshes remote git repos under the pi agent dir (`<agent dir>/cache/checkouts/<host>/<org>/<repo>`) with partial clones, so repeated references reuse a stable local checkout. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/librarian/`, with the cache root moved from `~/.cache/checkouts` to the persistent agent dir and the script invoked by skill-relative path |
| `.pi/skills/tmux/` | Drive interactive CLIs (python, gdb, lldb, psql, …) over a private tmux socket: literal `send-keys`, `capture-pane -J`, prompt polling, and `find-sessions.sh`/`wait-for-text.sh`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/tmux/`, with local adaptations — `PI_TMUX_SOCKET_DIR`/`pi-*` naming, an explicit split from the subagent extension's socket and reserved `pi-agent-*` sessions, `-S` support in `wait-for-text.sh`, and fixes in `find-sessions.sh` for the format strings, `-q` name matching and the attached-client count |
| `.pi/skills/update-changelog/` | Writes `CHANGELOG.md`'s `Unreleased` section from the commits since the last tag. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/update-changelog/SKILL.md`, with one local adaptation |
| `.pi/skills/worktree/` | Creates, lists, opens, reviews and removes git worktrees (linked working trees) for independent tasks, under a gitignored `.worktrees/` directory. **Ours** |
| `REVIEW_GUIDELINES.md` | Project-level review guidelines read by `/review` — branch hygiene, token rules, changelog shape, PR workflow, line endings |
| `licenses/` | MIT notices for the two projects the coding skill stack adapts, plus `NOTICE.md` with per-skill provenance and what changed here |
| `mcp/catalogue.json` | The one list of MCP servers this package ships — Figma and Playwright, each disabled with `exposure: "codemode"`; installed by `bin/mcp-catalogue` and `/mcp-catalogue` |
| `pi-session.sh` | Launch pi under tmux with an OpenRouter model |
| `bin/mcp-catalogue` | Shell surface of that installer, for a setup script or a container; the merge itself is `tools/mcp-catalogue.mjs` |
| `bin/devc` | Open a project's devcontainer from a terminal — headless, no GUI, tmux-backed. See [`devc`](#devc) |
| `bin/pi-wrapped` | Start `pi` with the per-project agent dir a login shell would have selected, for launchers that bypass the shell — see [One copy of the extensions, never two](#one-copy-of-the-extensions-never-two) |

Rows prefixed `User-invoked /skill:<name>:` are the five entry points only you can
start; every other skill is model-invoked, which means you can type it and the
agent also loads it on its own when the task matches. The full list, with each
skill's trigger text, is [below](#skills-and-how-they-are-invoked).

### The coding skill stack

The twelve skills from `in-your-own-words` to `handoff` were adapted from
[RRiboulet/agent-coding-skills](https://github.com/RRiboulet/agent-coding-skills)
and are now maintained here as ours: pi invocation syntax (`/skill:<name>` for
the five user-invoked entry points), this repo's commit and worktree rules,
`dev` as the review base, the gate read from `AGENTS.md`, and the handoff written
under the persistent agent dir instead of `/tmp`. The stack adapts MIT material
from mattpocock/skills and cursor/plugins `pstack`; their notices and the
per-skill provenance are in [`licenses/NOTICE.md`](licenses/NOTICE.md).

`grilling`, `teach` and `writing-for-agents` are ported from mattpocock/skills
directly, and the notice records them separately. `grilling` joins the trigger
list in `AGENTS.md` as the full design-tree interview — `in-your-own-words`
remains the cheap default — and `teach` is the fifth user-invoked entry point,
which builds a teaching workspace outside any project checkout.
`writing-for-agents` joins that trigger list too: it is the reference for writing
a skill, an `AGENTS.md` line or any other document an agent reads.

`prevent-recurrence` is the model-invoked answer to a correction that came back.
It classifies the mistake from the fix commits and review comments, then walks
architecture → type → lint → test → prose and has to say why every higher rung
did not work. A lint is allowed only when the offending lines alone prove the
violation, and an existing stock rule is tried first: the Python adapter in
`references/python.md` covers Ruff `TID251` and the stock rules worth selecting,
ast-grep, `import-linter`, and a project test, and the JS/TS adapter in
`references/js-ts.md` covers ESLint's `no-restricted-imports` and
`no-restricted-syntax`, a local flat-config rule with suggestions,
dependency-cruiser boundaries, typed linting through typescript-eslint, oxlint
for the inner loop, and the suppression audit. The check must fail at the
recorded bad revision and pass at the fixed one, with both commands and exit
codes recorded in a proof file; existing violations may land behind a ratchet
that only shrinks. The rule then gets a row in the target's `AGENTS.md`
`Rules and enforcement` table, which `scripts/rule-table.mjs` validates. It never
adds a suppression, commits, pushes, opens a PR, or starts a review — it hands
back the rule, level, proof, row, and open work.

The review workflow is deliberately narrow:

- `prove-it-works` closes every change. It is the author's own proof and diff
  check, and it never starts a reviewer.
- A change gets **one** independent review, only when asked, through exactly one
  door: `/review` for an interactive review, or `triage_change`/`/triage` and one
  approved sub-agent. Never both, never a second reviewer.
- The rubric either one follows is `REVIEW_GUIDELINES.md`, which now carries the
  Spec / Correctness / Standards method that used to be a separate skill.
- `show-me-your-work` is only for a big task left unsupervised for a long time;
  its trail is handed to that one reviewer rather than reviewed separately.

`/btw` notes: the command takes no arguments — it always asks for the question
(submit it empty to reopen a running panel), so spaces and punctuation in it
cannot be lost. The request reuses the main
conversation's prompt prefix — no system-prompt or tool-list override — but the
provider's cache only stays warm for a few minutes of idle time, so the first
question after a gap pays full price once (and warms the cache for the next
main turn). Escape closes the
popup and never reaches the viewer; the answer keeps streaming into its file.
Copying text out needs nested tmux copy-mode (`C-b C-b`, because the outer
client keeps the prefix). The panel renders the answer with pi-tui's own
`Markdown` component — the one the TUI renders an assistant message with — so
tables, nested lists and syntax-highlighted code blocks come out as the
transcript draws them, and the panel's colours are the transcript's colours
(the parent hands the viewer its resolved theme and the paths of pi's own
packages; `.pi/extensions/btw/theme.mjs` and
`.pi/extensions/btw/entry-points.mjs`). Two things the transcript does are
*not* done in the panel: its Markdown transforms (a mermaid diagram is shown
as its source) and its scrollback behaviour (the panel's history is the
answer's history, except after a resize, which redraws the panel and clears
it, as the transcript does). The pane still scrolls natively — copy mode
(`C-b [`), and the mouse wheel where the tmux config sets `set -g mouse on`
(the devcontainer's does) — like the subagent attach views, because the
viewer only draws and never takes the keyboard. The popup's title bar names the
panel and its question (`btw 01a14e96 why does the cache matter?`); the id alone
is a UUIDv7 timestamp and could not tell two panels apart. The question is
collapsed to one line and truncated to fit; it is read from the answer file's
header, so a launch and a reattach show the same title and a reopened panel
still says what it is answering, and a blockquote in the answer itself is
never mistaken for it. The next `/btw` restarts the viewer on the same answer. On a session with an active `/goal` the
main request's forced system prompt differs, so the panel may re-bill the
context and show goal notes; `.pi/extensions/btw/request.ts` documents that
limitation.

## Skills and how they are invoked

The skills split on one axis: **who can invoke them**.

- **User-invoked** are reachable only when you type them — pi spells that
  `/skill:<name>`. Their job is to orchestrate: `to-spec` writes the contract,
  `to-tickets` cuts it up, `implement` builds it, `handoff` passes it on, `teach`
  explains it later. They set `disable-model-invocation: true`, so their
  descriptions are not in the model's context and they cost nothing until asked
  for.
- **Model-invoked** can be typed the same way, and the agent also loads one
  itself when the task matches the description in its frontmatter. They hold the
  reusable discipline — `tdd`, `blast-radius`, `diagnosing-bugs`,
  `prevent-recurrence` — and their descriptions sit in context every turn, which
  is the price of that reach.

Two rules follow, and both hold here today. A user-invoked skill may load
model-invoked skills (`implement` does, at the seam the spec agreed); it never
*starts* another user-invoked one — it suggests `/skill:to-spec` and stops. And
nothing model-invoked needs the user to remember it exists: its description is
the pointer.

The frontmatter is the source of truth. `disable-model-invocation: true` makes a
skill user-invoked and keeps its description out of the model's context, and
`coding-skills.test.ts` pins the classification and the
`User-invoked /skill:<name>: …` description shape of the five. The tables below
are generated from that same frontmatter by `tools/skills-index.mjs --write`;
`skills-index.test.ts` fails when the README and the skills disagree, so this
list cannot drift the way a hand-written one does.

## Requirements

- `@earendil-works/pi-coding-agent` **1.0.x**
- **Node 24+** — the tests execute TypeScript directly, with no build step
- **tmux** — the subagent extension creates one tmux session per run, and the `tmux` skill drives interactive CLIs on a separate private socket
- **A phone with Termux + Termux:API** for `/voice` — setup is in `.pi/extensions/voice/README.md`
- An OpenRouter key for web search — in `~/.pi/agent/auth.json` under `openrouter`. The `web_search` tool and the native-web-search skill default to it (Brave when a Brave key is configured). The same key is used by `pi-session.sh`, which launches a model through OpenRouter. An `opencode-go` key is for the `/model` provider only; the Go plan's Anthropic models do not carry native web search.

The `.devcontainer/` provides all of these.

## devc

`bin/devc` opens a project's devcontainer from a terminal, which is what "open"
has to mean on a headless host: there is no `code`, and the Dev Containers CLI
has no `open` subcommand. It makes sure the container is built and running, then
attaches a login shell inside it under tmux, so a dropped SSH connection does not
kill the session.

```bash
devc                     # pick a project (lists when stdin is not a TTY)
devc ls                  # names, paths, state, published ports
devc up <name>           # ensure built/running; no shell
devc <name>              # ensure, then attach a login shell in tmux
devc <name> -- <cmd>     # run one command in the container
devc rebuild <name> [--no-cache]
devc stop <name>         # stop; named volumes are kept
devc doctor [name]       # preflight: docker, CLI, disk, iptables, per-project blockers
```

Install it once with `ln -s "$PWD/bin/devc" ~/bin/devc`. Projects come from
`~/.config/devc/roots` (seeded on first run with `$HOME`), one directory per
line; a directory either contains `.devcontainer/devcontainer.json` itself or
holds projects one level down. There is deliberately no registry: the config
file in the repo is the source of truth, and an allowlist is what keeps the
cached copies under `~/.pi/agent/git` out of the list.

Three behaviours are worth knowing because they exist to stop silent breakage:

- **It recreates a container whose config changed.** `devcontainer up` on 0.90
  reports success and leaves an existing container alone even when
  `devcontainer.json` or the compose file has changed, so an edited environment
  silently keeps running the old one. `devc` hashes those files (plus the
  Dockerfile, lifecycle scripts and `.dockerignore`), records the hash next to
  the container, and recreates when it moves. `devc doctor` reports the drift.
- **It refuses a uid mismatch.** If the container's user does not match the
  host uid, the bind-mounted repo is unwritable and the project's `postCreate`
  "fixes" it by chowning the host checkout to a uid the host user does not own.
  `devc` stops before that and says why. The Dev Containers CLI's default
  `updateRemoteUserUID` is the mechanism; do not disable it.
- **It never removes volumes.** `rebuild` recreates the container and leaves
  named volumes (pi sessions, provider auth, gh token, databases) in place.
  Nothing here runs `docker compose down -v` or `docker system prune --volumes`.

Requires `docker` (the user in the `docker` group) and
`@devcontainers/cli@0.90.0`. `DEVC_DRY_RUN=1` prints the commands instead of
running them.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh      # symlinks pi's packages into node_modules
node --test .pi/extensions/subagent/test/*.test.ts
```

## `/review`

Interactive code review with five modes — PR (`/review pr 123` or a full URL),
base branch (`/review branch main`), uncommitted changes (`/review uncommitted`),
a specific commit (`/review commit <sha>`), and folder/file snapshot
(`/review folder src docs`). Toggles for loop-fixing (review/fix cycle, max 10
iterations) and shared custom instructions. Reads a project-level
`REVIEW_GUIDELINES.md` (looked up next to `.pi/`), so house rules — check the
base before committing, never put a token in `.git/config`, changelog shape —
are where the reviewer actually reads them.

It is **vendored, not ours**: `review.ts` comes from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
(`extensions/review.ts`, Apache-2.0 — Copyright (c) mitsuhiko and contributors).
Upstream ships it with no tests; the file is kept close to upstream on purpose,
so a later refresh is a readable diff. Our changes are listed in the file
header:

1. **Testability refactor.** `parseReviewPaths`, `parseArgs`, `tokenizeArgs`
   and the end-review prompt templates were moved from inside the export
   factory to module scope, `export`ed and re-indented, so the parsing and
   rubric logic is unit-testable without pi's jiti loader.

2. **`__test__` export** at the bottom exposes the module-private helpers
   (arg parsers, PR-ref parsing, verdict and findings logic) so
   `review.test.ts` can cover them without loading the extension through
   jiti.

## `/goal`

Long-running objective mode: `/goal <objective>` starts a task that keeps
pursuing that objective across turns instead of ending when the turn does.
`/goal` alone shows the current goal; `/goal edit|pause|resume|clear` manage it.
Three tools expose the same state to the model — `get_goal` (current status,
usage and remaining budget), `create_goal` (only on explicit request; replaces a
completed goal, refuses while one is unfinished) and `update_goal` (marks the
goal `complete` or, after the strict three-turn blocked audit, `blocked`). An
optional token budget (`/goal <objective>` with a `create_goal` budget, or the
`token_budget` tool parameter) stops automatic continuation once spent, landing
the goal in `budgetLimited`; assistant errors with usage/rate/quota wording land
it in `usageLimited` instead of `blocked`. Objectives are capped at 4,000
characters — beyond that the extension tells you to put the instructions in a
file and refer to it. All state is appended to the session log as custom entries
and reconstructed from the active branch on reload and tree navigation; there
is no external database, so `/fork`ed and subagent sessions each carry the goal
of their own branch.

It is **vendored, not ours**: `goal.ts` comes from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
(`extensions/goal.ts`, Apache-2.0 — Copyright (c) mitsuhiko and contributors).
Upstream ships it with no tests; the file is kept close to upstream on purpose,
so a later refresh is a readable diff. Our changes are listed in the file
header:

1. **Testability refactor.** `reconstructGoalFromBranch` — the reconstruction
   loop that runs over the branch on session start and tree navigation, which
   is where a reload can silently lose or double-count goal state — and
   `hasExhaustedTokenBudget`, the budget-exhaustion condition, were moved from
   inside the export factory to module scope and `export`ed, so the
   session-reconstruction and budget-limiting logic is unit-testable without
   pi's jiti loader.

2. **`__test__` export** at the bottom exposes the module-private helpers
   (reconstruction, status normalization, the objective limit, usage
   accounting, continuation/budget prompts) so `goal.test.ts` can cover them
   without loading the extension through jiti.

3. **Continuation at the settlement boundary.** Upstream asks for the next goal
   turn from `agent_end`, where pi may still retry, compact and retry, or drain
   a queued follow-up. The request is now a `custom_message` draft plus
   `continue: true` returned from `agent_before_settle`, the final actionable
   boundary: pi honours it exactly once per run and composes it with other
   handlers' proposals. An aborted run skips that boundary, so it requests no
   continuation — the abort-pause prompt stays in `agent_end`, as do the usage
   accounting and the error-stop decision.

Behaviourally it is the most invasive vendor in this repo: a run's next turn is
requested at its settlement boundary, and `/goal` — which runs outside any run —
still queues a follow-up message directly (`deliverAs: "followUp"`); on the next
turn the extension filters its own bookkeeping messages out of the model context.
That is orthogonal to the subagent extension's queueing — `subagent` messages of
the same delivery kind are unaffected, and the custom message types the two
extensions use never collide — but a real end-to-end continuation run still
needs credentials and is not part of the suite; `goal.test.ts` pins the
reconstruction, the budget-limiting decision and the boundary's returned
proposal instead.

## `/session-breakdown`

Read-only analytics over the session transcripts in pi's agent dir
(`PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`):
sessions, messages, tokens and cost per day over the last 7/30/90 days, a model
/ directory / weekday / time-of-day breakdown, and a GitHub-contributions-style
calendar. Nothing is written and no network call is made.

It is **vendored, not ours**: `session-breakdown.ts` comes from
[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)
(`extensions/session-breakdown.ts`, Apache-2.0 — Copyright (c) mitsuhiko and
contributors). Upstream ships it with no tests; the file is kept close to
upstream on purpose, so a later refresh is a readable diff. Our changes are four
`LOCAL PATCH` hunks, marked in place and listed in the file header:

1. **Roots.** Upstream hardcodes `<homedir>/.pi/agent/sessions`. We read the
   agent dir from pi (`getAgentDir()`, so `PI_CODING_AGENT_DIR` works — upstream
   PR #24 asked for this and was closed unmerged) and sweep three trees:
   `sessions/`, plus `tmux-subagents/` and the legacy `subagents/`, which is
   where the subagent extension writes child transcripts. Those are siblings of
   `sessions/`, so the stock scanner never saw them.
2. **Inherited entries are not this session's spend.** A forked session file
   starts with a verbatim copy of its parent's tail, entry ids included. pi's own
   `/fork`, `/clone` and `--fork` do this, and so does a subagent run launched
   with `handoff: "fork"`. Those copies are records of requests some other
   process made, so they are excluded from messages, tokens and cost — resolved
   through the `parentSession` path in the v3 header, which every producer writes
   and nothing read before. The file still counts as one session, and a file
   whose parent can no longer be read is counted in full rather than guessed at.
3. **A footer line** saying how many inherited entries were excluded and how
   many files had an unreadable parent, because a total that silently drops
   context is indistinguishable from one that is simply wrong.
4. **A `__test__` export**, so the aggregation is testable over fixtures instead
   of a developer's real transcripts.

Measured on this machine on 2026-10-04, with
`node tools/measure-session-usage.mjs` (read-only, independent of the extension
so a bug in it cannot hide on both sides of the comparison): child transcripts
that were invisible — **$0.067741 of $1.708118, 4.0% of the cost** — are now
counted, and **3,003,013 duplicated tokens across 6 forked files** are no longer
counted twice (that figure comes from the extension's own lineage walk, which the
harness does not reproduce; the harness reports the dollar gap and, per fork run,
the prefix measured against the extension's recorded `usageFromLine`).

Those counts are of a machine that was being used while they were taken, so they
move; the dollar figures are stable only because every duplicated entry on this
box reports `cost.total = 0`. One file carries a `parentSession` that cannot be
resolved — its source transcript is gone — so its lineage is incomplete and the
footer says that instead of leaving it to be discovered.

A forked child's *own* turns still cost real money: its re-send of the parent's
prefix is billed, mostly as cache reads. This is about counting each request
once, not about pretending delegation is free. The footer line is the honest
version of that, and it only appears when there is something to report.

## opencode-go provider

`/model` gains an `opencode-go` provider serving fast GLM, Kimi, MiniMax, Qwen,
DeepSeek and Grok models through [opencode.ai](https://opencode.ai)'s Go API —
Go-optimized endpoints at lower latency, the correct wire protocol per model
(Anthropic, OpenAI Completions, Responses) and prompt-cache session affinity.
Pick it with `/model`; the provider's default model is `kimi-k2.6`. A usage
widget below the editor shows how much of the 5h / 7d / 30d Go-plan budgets
remain (`/opencode-go-usage` prints the full breakdown; `off`/`on` hide and show
the widget). Credentials resolve as `--api-key` flag → `~/.pi/agent/auth.json`
under `opencode-go` → the `OPENCODE_API_KEY` environment variable, in that order
(see [pi's providers doc](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/providers.md)).

It is **vendored, not ours**: the whole directory comes from
[monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider)
(MIT — Copyright (c) monotykamary), multi-file package kept intact.
The manifest here imports `.pi/extensions/opencode-go-provider/index.ts`
directly, so a refresh is a plain `cp` of the upstream tree; there are **zero
local changes** — the files above are byte-identical to upstream commit
`286c467` (main, 2026-10-07, package.json v1.1.18). The extension is
side-effect-free at load (the strict-ESM guard covers it) and only depends on
pi's host packages.

## Voice

`/voice` turns a phone into the microphone: it starts
`termux-microphone-record` over ssh, stops it on the second `/voice`, fetches
the recording, and POSTs it to an OpenAI-compatible `/audio/transcriptions`
endpoint. The transcript is pasted at the cursor by default (a long paste
collapses to pi's `[paste #n]` marker and expands on submit), or submitted as a
prompt with `autoSubmit` — queued as a follow-up while the agent streams.
`/voice cancel` aborts any phase; `alt+r` toggles the same cycle on every
terminal, `ctrl+shift+r` on a Kitty one, so the recording can be finished
without retyping the command.

Setup, the configuration table, the key routing (the ambient OpenAI key is
never sent to a custom endpoint), the single `response_format` retry and the
phone prerequisites are in `.pi/extensions/voice/README.md`.

## Configuration

The subagent extension reads `PI_SUBAGENT_*` environment variables —
`PI_SUBAGENT_MAX_CONCURRENT` (default 4), `PI_SUBAGENT_NOTIFY`,
`PI_SUBAGENT_AUTO_REAP`, `PI_SUBAGENT_REAP_DELAY_MS`, `PI_SUBAGENT_GC_DAYS`,
`PI_SUBAGENT_KILL_ON_SHUTDOWN`, `PI_SUBAGENT_PROVIDER`, `PI_SUBAGENT_MODEL`,
`PI_SUBAGENT_INTERRUPT_CONFIRM_MS`, `PI_SUBAGENT_STALL_SECONDS`,
`PI_SUBAGENT_TOOL_STALL_SECONDS`. The test README documents what each one does;
the header comment in `.pi/extensions/subagent/index.ts` lists the local patches.

The subagent management tools (`subagent_status`, `subagent_wait`,
`subagent_cancel`, `subagent_interrupt`, `subagent_resume`, `subagent_clean`) are hidden from the
model's tool declarations when pi can reach them another way — that is, when
`codemode` or `tool_search` is in your tool set:

```jsonc
// ~/.pi/agent/settings.json
{ "defaultTools": ["+tool_search"] }
```

Use the modifier-only form. `resolveDefaultTools` (settings-manager.js:55)
*replaces* the inherited selection as soon as a list contains any plain name,
and only treats an all-modifier list as an addition — so this composes with
whatever another layer's `defaultTools` says, where restating pi's four defaults
would silently couple this repo to them.

`tool_search` then loads one when the model asks for it, and a codemode script
can call it as `tools.subagent_status({ id })`. Without either tool they stay
declared exactly as before, so nothing depends on this being switched on.

### Measured, not assumed

Request payloads, real pi 1.0.2 with this extension, headless `--print` with a
one-word prompt; bytes are the whole provider payload, averaged over the (single)
request of each run:

| `defaultTools` | payload | declared tools |
|---|---|---|
| *(unset)* | 19,578 B | 12 |
| `["+tool_search"]` | **16,000 B** | 8 |
| `["+codemode"]` | 21,069 B | 8 |
| `["+codemode", "+tool_search"]` | 21,809 B | 9 |
| `["+codemode", "+tool_search"]` + `codemode.mode: "only"` | 19,985 B | 2 |

So `+tool_search` alone is the win: **−3,578 B per request (~890 tokens)**, and
0 of the 6 management tools declared (the table predates `subagent_wait`). `subagent` stays declared throughout, and
a real run confirmed the model reaching `subagent_status` through `tool_search`
when it was not declared.

`+codemode` is deliberately *not* enabled. Its own description is 4,933 bytes,
and with `codemode.mode: "on"` (the default) every declared tool also carries a
`Codemode: tools.<name>(args) resolves to …` note — ~52 bytes × the declared
set, which scales against you on a large tool set. Together they cost more than
the hidden tools do. `mode: "only"` hides the base tools too, but its
description then lists all of them, so it lands in the same place. Add
`"+codemode"` if you want the script workflow and the prompt is worth its price
to you; it is one entry, and nothing in the extension changes either way.

Subagent delegation is non-blocking: start independent tasks together, then
call `subagent_wait` once per run (or once with `ids`) instead of polling.
`subagent_status` remains the live "what is it doing right now" view. If the
session ends while a wait is pending, it returns `details.ended` with the run's
current state — never a claim that the run settled. A finishing run never takes the turn — its notification is appended to the
transcript and the model reads it next time it acts, while the widget shows the
same thing live.

A run that reports a final answer — completed, or failed with an error — leaves its complete report in `<runDir>/report.md`, beside
`result.json` rather than inside the child's session transcript. The run record
carries a pointer (`artifactPath`, `artifactBytes`) and a bounded head, plus the
child's parsed `status`, `summary`, `files`, `commands` and `unresolved` when it
ended with the requested `subagent-report` block; `output` keeps its previous
meaning and cap. A child from an older build, or one that simply forgot the
block, still completes: the plain final text is preserved and the record says
why the report degraded. The artifact is written at settlement, so it exists for
failed runs too, where the failure text is the complete report. A cancelled or
shutdown-killed run has none: its child never reported an answer, and the run
record says so by carrying no `report`.

<!-- skills-index:begin — generated by tools/skills-index.mjs --write; do not edit by hand -->

### User-invoked — 5: only you can start these, by typing `/skill:<name>`

| Skill | What it does, and when to reach for it |
|---|---|
| [`handoff`](.pi/skills/handoff/SKILL.md) | User-invoked /skill:handoff: write a handoff document a fresh agent in any harness can continue from. |
| [`implement`](.pi/skills/implement/SKILL.md) | User-invoked /skill:implement: take a spec, ticket, ticket set or plan end to end in small verified units. |
| [`teach`](.pi/skills/teach/SKILL.md) | User-invoked /skill:teach: teach a topic across sessions in a workspace of lessons and records, when the learning is the project, not one explanation. |
| [`to-spec`](.pi/skills/to-spec/SKILL.md) | User-invoked /skill:to-spec: write a spec with test seams and acceptance criteria from the current conversation. |
| [`to-tickets`](.pi/skills/to-tickets/SKILL.md) | User-invoked /skill:to-tickets: break a spec or plan into tracer-bullet tickets with explicit blocked-by edges. |

### Model-invoked — 20: you can type `/skill:<name>`, and the agent loads one itself when its description matches

| Skill | What it does, and when to reach for it |
|---|---|
| [`add-model`](.pi/skills/add-model/SKILL.md) | Add or fix a model in the opencode-go provider. Use when: a model is missing or stale; shows as non-reasoning; or has wrong or missing thinking levels. |
| [`benchmark-checklist`](.pi/skills/benchmark-checklist/SKILL.md) | Vet a performance measurement before reporting or acting on it. Use when: running a benchmark; reporting a speedup or regression; comparing libraries or configurations on speed; or building a performance test harness. |
| [`blast-radius`](.pi/skills/blast-radius/SKILL.md) | Find what a change could break beyond its diff. Use when: it crosses a module boundary; alters a public API, schema, wire format, config or env var; touches persistence, caching, retries or concurrency; spans many files; or the user asks what breaks. |
| [`commit`](.pi/skills/commit/SKILL.md) | Make a git commit following this repo's format and branch rules. Use when: committing current changes. |
| [`devcontainer`](.pi/skills/devcontainer/SKILL.md) | Work inside a project's devcontainer from a headless host with `devc`. Use when: running commands inside a project container; a container build, dev server or database misbehaves; or the user asks to open, rebuild, stop or diagnose a devcontainer. |
| [`diagnosing-bugs`](.pi/skills/diagnosing-bugs/SKILL.md) | Diagnose to a confirmed root cause and a regression test, via a tight feedback loop and ranked hypotheses. Use when: something is broken, failing, flaky or slow; the user says diagnose or debug; or an earlier fix attempt did not work. |
| [`github`](.pi/skills/github/SKILL.md) | Work with GitHub through the `gh` CLI. Use when: issues, pull requests, CI runs or releases; or any `gh` command in this repository. |
| [`grilling`](.pi/skills/grilling/SKILL.md) | Interview the user relentlessly, in rounds, until every branch of the design tree is settled. Use when: the user asks to be grilled or stress-tested; a plan needs poking at; or a request's shape outruns a ten-line playback. |
| [`idempotent-operations`](.pi/skills/idempotent-operations/SKILL.md) | Design state-changing operations so they converge however many times they run. Use when: writing retries, queues, webhooks, jobs, commands, scripts or migrations, or anything that must survive crashes and restarts. |
| [`in-your-own-words`](.pi/skills/in-your-own-words/SKILL.md) | Play the goal, done-when, scope and risky assumptions back before non-trivial work; ask about decisions, never facts. Use when: a request is ambiguous, spans several files or messages, or involves state transitions, retries or migrations. |
| [`librarian`](.pi/skills/librarian/SKILL.md) | Cache and refresh remote git repositories under the pi agent dir so later references reuse a local checkout. Use when: the user points you to a remote git repository as reference; or you encounter one through other means. |
| [`native-web-search`](.pi/skills/native-web-search/SKILL.md) | Trigger native web search. Use when: you need quick internet research with concise summaries and full source URLs. |
| [`prevent-recurrence`](.pi/skills/prevent-recurrence/SKILL.md) | Turn a repeated correction into an enforced check that fails without it. Use when: the same mistake class is corrected twice; a review, revert or fix shows a known pattern coming back; or a correction needs to stop a class, not one instance. |
| [`prove-it-works`](.pi/skills/prove-it-works/SKILL.md) | Prove a code change works by verifying the real artifact and reporting evidence. Use when: finishing any coding task; before committing or opening a pull request; after addressing review feedback; or when asked to verify changes. |
| [`show-me-your-work`](.pi/skills/show-me-your-work/SKILL.md) | Keep an append-only decision trail for a task the user left running unattended, audit it, and report what still needs their eyes. Use when: the user asks for a decision log; or a run is long and unsupervised enough to be judged from the trail. |
| [`tdd`](.pi/skills/tdd/SKILL.md) | Default style for new or changed behavior: failing test at a public seam, then the smallest code that passes. Use when: any behavior change, a bug with a test path, or the user asks for TDD or a regression test. Not for a rename, comment or typo. |
| [`tmux`](.pi/skills/tmux/SKILL.md) | Drive interactive CLIs (python, gdb, lldb, psql) over a private tmux socket. Use when: a process needs a persistent TTY that a one-shot bash call cannot provide. |
| [`update-changelog`](.pi/skills/update-changelog/SKILL.md) | Update the repository's changelog correctly. Use when: updating CHANGELOG.md or CHANGELOG; preparing a release. |
| [`worktree`](.pi/skills/worktree/SKILL.md) | Create, list, open, review, and remove git worktrees (linked working trees) for independent tasks. Use when: a task needs an isolated working tree or branch without disturbing the current checkout; or parallel tasks need separate checkouts. |
| [`writing-for-agents`](.pi/skills/writing-for-agents/SKILL.md) | Writing the documents an agent consumes — skills, AGENTS.md and CLAUDE.md, and docs reached by a pointer. Use when: writing or editing a skill; or changing a rule or pointer in AGENTS.md or CLAUDE.md. |

<!-- skills-index:end -->
