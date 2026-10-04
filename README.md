# pi coding-agent extensions

Personal pi extensions, skills and the devcontainer that runs them.

Nothing here depends on npm publishing. The repository doubles as a pi
package, so these extensions can be installed into any other project:

```bash
pi install git:github.com/RRiboulet/my-agent-setup          # for me, every project
pi install --local git:github.com/RRiboulet/my-agent-setup  # pin for one project only
```

Verified on a clean agent dir and an empty project: both install the five
extensions and the `native-web-search` skill.

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
    ".pi/extensions/native-web-search.ts",
    ".pi/extensions/session-breakdown.ts",
    ".pi/extensions/todos.ts",
    ".pi/extensions/subagent/index.ts"   // the rest of that dir is its internals
  ],
  "skills": [".pi/skills/native-web-search"]
}
```

Without that file `pi install` succeeds, clones the repo, and quietly loads
nothing.

Pinning works the usual way — append a tag or a commit:
`git:github.com/RRiboulet/my-agent-setup@<ref>`. One caveat worth knowing:
`v1.0.0` predates this repo becoming a pi package (the resources moved to `.pi/`
after that tag, and `package.json` came later still), so pinning to it installs
nothing. Pin a ref at or after the manifest commit, or track `main`.

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
| `.pi/extensions/session-breakdown.ts` | `/session-breakdown`: sessions, messages, tokens and cost per day over 7/30/90, model breakdown, contributions-style calendar. **Vendored** from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff) (Apache-2.0), with four local patches — see below |
| `.pi/extensions/native-web-search.ts` | Native web search tool (ships with `.pi/skills/native-web-search/`) |
| `.pi/skills/native-web-search/` | Skill for the above — the two must travel together |
| `pi-session.sh` | Launch pi under tmux with an OpenRouter model |
| `MODELS.txt` | Model ids this workspace runs with |

## Requirements

- `@earendil-works/pi-coding-agent` **1.0.x**
- **Node 24+** — the tests execute TypeScript directly, with no build step
- **tmux** — the subagent extension creates one tmux session per run
- An OpenRouter key, e.g. `export OPENROUTER_API_KEY=...`

The `.devcontainer/` provides all of these.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh      # symlinks pi's packages into node_modules
node --test .pi/extensions/subagent/test/*.test.ts
```

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