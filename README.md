# pi coding-agent extensions

Personal pi extensions, skills and the devcontainer that runs them.

Nothing here depends on npm publishing. pi discovers this repository's
resources from the conventional `extensions/` and `skills/` directories, so it
can be used as a package source directly:

```bash
pi install git:github.com/<user>/<repo>          # clone + discover
pi install --local git:github.com/<user>/<repo>  # pin for this project only
```

Pinning works: `git:github.com/<user>/<repo>@v1.0.0`.

Project-local extensions only load **after you grant project trust**, so on a
fresh machine pi asks on first start; until then the extensions are silently
inactive.

## Contents

| Path | What it is |
|---|---|
| `.pi/extensions/subagent/` | Non-blocking tmux-backed delegation: `subagent`, `subagent_status`, `subagent_resume`, `subagent_interrupt`, `subagent_cancel`, `subagent_clean`, a live child-activity phase and a status widget above the editor |
| `.pi/extensions/todos.ts` | `/todos` TUI and the `todo` tool |
| `.pi/extensions/answer.ts` | `/answer`: extract questions from the last response and answer them in a focused TUI |
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