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

Subagent delegation is non-blocking: start independent tasks together and poll
with `subagent_status`. There is no blocking wait, and a finishing run never
takes the turn — its notification is appended to the transcript and the model
reads it next time it acts, while the widget shows the same thing live.