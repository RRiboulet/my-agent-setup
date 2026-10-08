# pi coding-agent extensions

Personal pi extensions, skills and the devcontainer that runs them.

Nothing here depends on npm publishing. The repository doubles as a pi
package, so these extensions can be installed into any other project:

```bash
pi install git:github.com/RRiboulet/my-agent-setup          # for me, every project
pi install --local git:github.com/RRiboulet/my-agent-setup  # pin for one project only
```

Verified on a clean agent dir and an empty project: both install the seven
extensions and the three skills. The clean-dir check ran before `review.ts`
was added; the seventh extension is covered by the strict-ESM load test under
Tests.

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
    ".pi/extensions/goal.ts",
    ".pi/extensions/native-web-search.ts",
    ".pi/extensions/review.ts",
    ".pi/extensions/session-breakdown.ts",
    ".pi/extensions/todos.ts",
    ".pi/extensions/subagent/index.ts"   // the rest of that dir is its internals
  ],
  "skills": [
    ".pi/skills/commit",
    ".pi/skills/native-web-search",
    ".pi/skills/update-changelog"
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

## Contents

| Path | What it is |
|---|---|
| `package.json` | the `pi` manifest that makes this repo installable as a package (see above) |
| `.pi/extensions/subagent/` | Non-blocking tmux-backed delegation: `subagent`, `subagent_status`, `subagent_resume`, `subagent_interrupt`, `subagent_cancel`, `subagent_clean`, a live child-activity phase and a status widget above the editor |
| `.pi/extensions/todos.ts` | `/todos` TUI and the `todo` tool |
| `.pi/extensions/answer.ts` | `/answer`: extract questions from the last response and answer them in a focused TUI |
| `.pi/extensions/continue.ts` | `shift+alt+enter` sends the literal prompt `continue`, but only when the agent is idle, so it never steers or queues a message mid-run. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), unmodified |
| `.pi/extensions/review.ts` | `/review` and `/end-review`: PR, branch, commit, folder and uncommitted review modes, loop-fixing, custom instructions, project-level `REVIEW_GUIDELINES.md`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with two local changes — see below |
| `.pi/extensions/goal.ts` | `/goal` and the `get_goal`/`create_goal`/`update_goal` tools: a long-running objective that auto-continues across turns with an optional token budget, its state appended to the session log and reconstructed on reload/tree navigation. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with two local changes — see below |
| `.pi/extensions/session-breakdown.ts` | `/session-breakdown`: sessions, messages, tokens and cost per day over 7/30/90, model breakdown, contributions-style calendar. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with four local patches — see below |
| `.pi/extensions/native-web-search.ts` | Native web search tool — **ours**, not upstream: it registers the `web_search` tool. Ships with `.pi/skills/native-web-search/`, which *is* vendored |
| `.pi/extensions/opencode-go-provider/` | An `opencode-go` provider for `/model`: fast GLM, Kimi, MiniMax, Qwen, DeepSeek and Grok models via opencode.ai's Go API, with the correct wire protocol per model (Anthropic, OpenAI Completions, Responses) and a per-account usage-budget widget below the editor. **Vendored** from [monotykamary/pi-opencode-go-provider](https://github.com/monotykamary/pi-opencode-go-provider) (MIT), byte-identical to upstream — see below |
| `.pi/skills/native-web-search/` | Script + docs for the above. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/native-web-search/`, with four local provider patches: OpenRouter support, and an `opencode-go` default that searches through the Go API's Anthropic-compatible endpoint. The two must travel together |
| `.pi/skills/commit/` | Conventional Commits subjects, and the branch-per-change rule from `AGENTS.md`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/commit/SKILL.md`, with two local adaptations |
| `.pi/skills/github/` | gh CLI usage: PRs, CI runs, `gh api`, structured JSON. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/github/SKILL.md`, with four local adaptations — this repo's `GH_CONFIG_DIR` auth setup, the AGENTS.md squash workflow, the token rule, and the credential-helper note |
| `.pi/skills/librarian/` | Caches and refreshes remote git repos under the pi agent dir (`<agent dir>/cache/checkouts/<host>/<org>/<repo>`) with partial clones, so repeated references reuse a stable local checkout. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/librarian/`, with the cache root moved from `~/.cache/checkouts` to the persistent agent dir and the script invoked by skill-relative path |
| `.pi/skills/tmux/` | Drive interactive CLIs (python, gdb, lldb, psql, …) over a private tmux socket: literal `send-keys`, `capture-pane -J`, prompt polling, and `find-sessions.sh`/`wait-for-text.sh`. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/tmux/`, with local adaptations — `PI_TMUX_SOCKET_DIR`/`pi-*` naming, an explicit split from the subagent extension's socket and reserved `pi-agent-*` sessions, `-S` support in `wait-for-text.sh`, and fixes in `find-sessions.sh` for the format strings, `-q` name matching and the attached-client count |
| `.pi/skills/update-changelog/` | Writes `CHANGELOG.md`'s `Unreleased` section from the commits since the last tag. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) `skills/update-changelog/SKILL.md`, with one local adaptation |
| `REVIEW_GUIDELINES.md` | Project-level review guidelines read by `/review` — branch hygiene, token rules, changelog shape, PR workflow, line endings |
| `pi-session.sh` | Launch pi under tmux with an OpenRouter model |

## Requirements

- `@earendil-works/pi-coding-agent` **1.0.x**
- **Node 24+** — the tests execute TypeScript directly, with no build step
- **tmux** — the subagent extension creates one tmux session per run, and the `tmux` skill drives interactive CLIs on a separate private socket
- An `opencode-go` key for web search — in `~/.pi/agent/auth.json` under `opencode-go`, or via `OPENCODE_API_KEY`. The `web_search` tool and the native-web-search skill both default to this provider. An OpenRouter key is only needed for `pi-session.sh`, which launches a model through OpenRouter.

The `.devcontainer/` provides all of these.

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

Behaviourally it is the most invasive vendor in this repo: the extension
queues its own follow-up turns (`deliverAs: "followUp"`) and filters its
bookkeeping messages out of the model context on the next turn. That is
orthogonal to the subagent extension's queueing — `subagent` messages of the
same delivery kind are unaffected, and the custom message types the two
extensions use never collide — but a real end-to-end continuation run still
needs credentials and is not part of the suite; `goal.test.ts` pins the
reconstruction and the budget-limiting decision instead.

## `/session-breakdown`

Read-only analytics over the session transcripts in `$(pi agent dir)`:
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

## Configuration

The subagent extension reads `PI_SUBAGENT_*` environment variables —
`PI_SUBAGENT_MAX_CONCURRENT` (default 4), `PI_SUBAGENT_NOTIFY`,
`PI_SUBAGENT_AUTO_REAP`, `PI_SUBAGENT_REAP_DELAY_MS`, `PI_SUBAGENT_GC_DAYS`,
`PI_SUBAGENT_KILL_ON_SHUTDOWN`, `PI_SUBAGENT_PROVIDER`, `PI_SUBAGENT_MODEL`,
`PI_SUBAGENT_INTERRUPT_CONFIRM_MS`, `PI_SUBAGENT_STALL_SECONDS`,
`PI_SUBAGENT_TOOL_STALL_SECONDS`. The test README documents what each one does;
the header comment in `.pi/extensions/subagent/index.ts` lists the local patches.

The subagent management tools (`subagent_status`, `subagent_cancel`,
`subagent_interrupt`, `subagent_resume`, `subagent_clean`) are hidden from the
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
0 of the 5 management tools declared. `subagent` stays declared throughout, and
a real run confirmed the model reaching `subagent_status` through `tool_search`
when it was not declared.

`+codemode` is deliberately *not* enabled. Its own description is 4,933 bytes,
and with `codemode.mode: "on"` (the default) every declared tool also carries a
`Codemode: tools.<name>(args) resolves to …` note — ~52 bytes × the declared
set, which scales against you on a large tool set. Together they cost more than
the five hidden tools do. `mode: "only"` hides the base tools too, but its
description then lists all of them, so it lands in the same place. Add
`"+codemode"` if you want the script workflow and the prompt is worth its price
to you; it is one entry, and nothing in the extension changes either way.

Subagent delegation is non-blocking: start independent tasks together and poll
with `subagent_status`. There is no blocking wait, and a finishing run never
takes the turn — its notification is appended to the transcript and the model
reads it next time it acts, while the widget shows the same thing live.