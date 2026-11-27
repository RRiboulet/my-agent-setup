# advanced-harness-engineering

Dual-harness engineering setup for the **`pi` coding agent** and **GitHub Copilot CLI**, hosted at `https://github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering`.

One repository provides **32 canonical Agent Skills** ([`skills/`](skills/)), **`pi` extensions** (`.pi/extensions/`), **Copilot CLI extensions** (`extensions/tickets`, [`extensions/jira`](extensions/jira/README.md)), the **Pragmatic Orchestrator** agent & guardrails ([`agents/orchestrator.agent.md`](agents/orchestrator.agent.md), [`hooks/orchestrator-guard.json`](hooks/orchestrator-guard.json), [`orchestrator_guard/`](orchestrator_guard/README.md)), and devcontainer/worktree isolation tooling (`bin/`, [`.devcontainer/`](.devcontainer/devcontainer.json)).

See [`docs/harnesses.md`](docs/harnesses.md) for the authoritative **Dual-Harness Compatibility Matrix** covering installation, all 32 skills, all 11 `pi` + 2 Copilot CLI extensions, guardrails parity, Phase 2 cross-porting roadmap, and known limitations.

---

## Quick Start

### GitHub Copilot CLI

Pick either the repository installer script (recommended for local clones so `git pull` updates symlinks in place) or the Copilot CLI plugin workflow:

**Option A — Installer script (`scripts/install.sh`)**

```bash
git clone https://github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering.git
cd advanced-harness-engineering

bash scripts/install.sh --copilot
bash scripts/install.sh --copilot-hooks /path/to/your/repo
```

- `--copilot` wires skills (`~/.copilot/skills`, or `$COPILOT_HOME/skills`), Copilot CLI extensions (`~/.copilot/extensions/tickets` and `jira`), the custom agent (`~/.copilot/agents/orchestrator.agent.md`), and the routing snippet (`~/.copilot/copilot-instructions.md` from [`instructions/AGENTS.md`](instructions/AGENTS.md)).
- `--copilot-hooks /path/to/repo` installs `hooks/orchestrator-guard.json` and `orchestrator_guard/` into `<repo>/.github/`.

**Option B — Copilot CLI plugin**

```bash
copilot plugin install https://github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering.git
# Or test directly from a local clone:
copilot --plugin-dir .
```

> [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) already activates `orchestrator-guard` hooks globally when installed via `copilot plugin install` or `copilot --plugin-dir .`. Do **not** also run `scripts/install.sh --copilot-hooks` on the same repo (running both fires every hook twice and halves budgets; use `--copilot-hooks` only with `scripts/install.sh --copilot`, not alongside the plugin).

**Copilot CLI post-install setup (`~/.copilot/settings.json`)**

1. Enable experimental extensions (`"experimental": true`, or `/settings experimental on` followed by `/restart`) so `/tickets` and `jira_*` load.
2. Route subagent tiers under `"subagents"` so `explore`/`research` use a fast/cheap model, `general-purpose` uses a mid-tier coder, and `code-review`/`security-review` use a frontier model (full example in [`docs/harnesses.md`](docs/harnesses.md)).
3. For Jira tools, save a single-line PAT in `~/.config/jira/token` (`chmod 600`; see [`extensions/jira/README.md`](extensions/jira/README.md)).

### `pi` coding agent

```bash
pi install git:github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering
# Or project-local:
pi install -l git:github-ct.int.automotive-wan.com/uih00686/advanced-harness-engineering

bash scripts/install.sh --instructions-only ~/.pi/agent/AGENTS.md
bash bin/mcp-catalogue   # optional: merges mcp/catalogue.json (Figma, Playwright; disabled by default)
```

- [`package.json`](package.json) declares all 11 entry points in `.pi/extensions/` and all 32 skills in `skills/`.
- Use `--instructions-only` (rather than `--instructions`) so `scripts/install.sh` does not also link all 32 skills into `~/.agents/skills/`, which would collide with `pi install`.
- **Isolated checkouts and linked worktrees:** Never combine a `git:` install with a working checkout of this repo—`pi` treats duplicate tool registration as a hard load error. See [One copy of the extensions, never two](#one-copy-of-the-extensions-never-two) below.

### One copy of the extensions, never two

`pi` discovers extensions from the project's `.pi/extensions/` **and** from every installed package—and this package's resources are those exact directories. When a working checkout (or linked `.worktrees/<slug>` worktree) also has this repository installed as a package under a different path, `pi` loads each extension twice and exits `1` on duplicate tool or flag registration (for example `Tool "todo" conflicts with .../.pi/extensions/todos.ts`).

Both host worktrees and the devcontainer therefore keep the working tree's `.pi/` as the single source of extensions and skills:

- **Single-checkout host:** Remove any `git:` package entry and install by local path (`pi install /path/to/advanced-harness-engineering`) so `pi` dedupes against project discovery.
- **Host with linked worktrees (`.worktrees/<slug>`):** A worktree's `.pi/extensions/` resolves to a different path than a local-path package pointing at the main checkout, so [`bin/pi-agent-dir`](bin/pi-agent-dir) creates a dedicated, package-free `PI_CODING_AGENT_DIR` (`~/.pi/agent-<main checkout directory name>`, seeded from base settings without `.packages` and trusting the main checkout). Use `bin/pi-agent-dir --shell` for interactive shells, and [`bin/pi-wrapped`](bin/pi-wrapped) for non-login launchers (tmux, CI, editor tasks).
- **This repo's devcontainer:** [`.devcontainer/devcontainer.json`](.devcontainer/devcontainer.json) sets a dedicated `PI_CODING_AGENT_DIR` on a private volume (`advanced-harness-engineering-pi-config`), and [`.devcontainer/postCreate.sh`](.devcontainer/postCreate.sh) initializes it from [`.devcontainer/pi/settings.json`](.devcontainer/pi/settings.json) with no `.packages` and adds `/workspace` to `trust.json`.

### Other harnesses

[`scripts/install.sh`](scripts/install.sh) also supports Codex (`--user`), Claude Code (`--claude`), OpenCode, Cursor, Gemini CLI, and custom skill directories (`--target DIR`, `--project DIR`, `--copy`, `--uninstall`). See [`docs/harnesses.md`](docs/harnesses.md).

---

## Engineering Workflow

The skill stack enforces a small, composable lifecycle from intent to verified change:

```text
in-your-own-words ──► grilling (if coupled decisions remain)
        │
        ▼
    /to-spec ──► /to-tickets
                      │
                      ▼
       /implement  │  /implement-spec  │  /orchestrate (pi wave)
                      │
                      ▼
        review-change / interrogate (when requested or gated)
                      │
                      ▼
               prove-it-works
```

1. **Frame & design:** `in-your-own-words` plays back goal, scope, and assumptions; `grilling` interviews through coupled design trees; `architect`, `blast-radius`, and `idempotent-operations` check boundaries and convergence.
2. **Spec & ticketize:** `/to-spec` captures test seams and acceptance criteria; `/to-tickets` breaks work into vertical-slice tickets with `blocked-by` YAML frontmatter shared by Copilot CLI's `/tickets` extension and `pi`'s `/orchestrate`.
3. **Execute:** `/implement` (single ticket or bounded task), `/implement-spec` (parallel worktree DAG runner), or `/orchestrate` (`pi` tiered wave dispatcher) build one verified vertical slice at a time with `tdd` or `diagnosing-bugs`.
4. **Review & prove:** `review-change` and `interrogate` provide adversarial/spec review; `prove-it-works` exercises the real artifact, runs the quality gate, and verifies a revert turns the covering test red.
5. **Maintain & continue:** `prevent-recurrence` turns repeated mistakes into enforced checks (`AGENTS.md` rule table); `retro` improves harness layers; `/handoff` and `/recall` bridge sessions; `/verify-app` maintains E2E app verification skills; `/teach` runs persistent learning workspaces.

> **User-invoked vs. model-invoked:** Only you start the 8 user-invoked skills (`/handoff`, `/implement`, `/implement-spec`, `/recall`, `/teach`, `/to-spec`, `/to-tickets`, `/verify-app`; spelled `/skill:<name>` on `pi`). All 24 model-invoked skills load automatically when their trigger matches (and can also be invoked manually).

---

## Architecture & Contents

| Path | What it is |
|---|---|
| [`docs/harnesses.md`](docs/harnesses.md) | Authoritative dual-harness compatibility matrix (`pi` + Copilot CLI): setup, all 32 skills, all 11 `pi` + 2 Copilot CLI extensions, guardrails comparison, Phase 2 roadmap, and known limits |
| `docs/harness/` | `pi` deep dives: [`branches.md`](docs/harness/branches.md), [`extensions.md`](docs/harness/extensions.md), [`github-auth.md`](docs/harness/github-auth.md), [`pi-local-setup.md`](docs/harness/pi-local-setup.md), [`reviews.md`](docs/harness/reviews.md), [`skills.md`](docs/harness/skills.md), [`subagents.md`](docs/harness/subagents.md), [`testing.md`](docs/harness/testing.md), [`workflow-schema.md`](docs/harness/workflow-schema.md) |
| `docs/specs/` | Architecture specs and ticket sets, including [`2026-11-26-orchestration-skills-extensions-alignment.md`](docs/specs/2026-11-26-orchestration-skills-extensions-alignment.md) |
| [`skills/`](skills/) | 32 canonical Agent Skills (8 user-invoked, 24 model-invoked) |
| `.pi/extensions/` | 11 `pi` extensions: `subagent`, `orchestrator`, `btw`, `repo-explorer`, `review`, `answer`, `continue`, `todos`, `mcp-catalogue`, `native-web-search`, `opencode-go-provider` |
| [`.pi/settings.json`](.pi/settings.json) | Default `pi` tool config (`+tool_search`, `+codemode`, `codemode.mode: "on"`) |
| `extensions/` | Copilot CLI extensions: `tickets` (`/tickets` TUI + `tickets_*` tools) and [`jira`](extensions/jira/README.md) (10 `jira_*` PAT tools) |
| [`agents/orchestrator.agent.md`](agents/orchestrator.agent.md) | Copilot CLI Pragmatic Orchestrator custom agent |
| [`hooks/orchestrator-guard.json`](hooks/orchestrator-guard.json) & [`orchestrator_guard/`](orchestrator_guard/README.md) | Copilot CLI fail-open Python hook control plane (discovery budgets, parent write/shell guard, verification & `code-review` gates, telemetry) |
| [`instructions/AGENTS.md`](instructions/AGENTS.md) | Shared global instruction snippet injected by `scripts/install.sh --instructions` |
| [`mcp/catalogue.json`](mcp/catalogue.json) | `pi` MCP server catalogue (Figma, Playwright; disabled with `exposure: "codemode"`) |
| `bin/` | Host & container wrappers: [`devc`](bin/devc), [`mcp-catalogue`](bin/mcp-catalogue), [`pi-agent-dir`](bin/pi-agent-dir), [`pi-wrapped`](bin/pi-wrapped) |
| [`scripts/`](scripts/install.sh) | Cross-harness [`install.sh`](scripts/install.sh), skill/manifest [`validate.py`](scripts/validate.py), and [`test.sh`](scripts/test.sh) |
| `tools/` | Node stdlib repo checkers and tooling (`skills-index.mjs`, `branch-base.mjs`, `mcp-catalogue.mjs`, `bench/`) |
| [`AGENTS.md`](AGENTS.md) & [`REVIEW_GUIDELINES.md`](REVIEW_GUIDELINES.md) | Repository workflow invariants, rule-enforcement table, and review rubric |
| [`NOTICE.md`](NOTICE.md) & [`licenses/`](licenses/NOTICE.md) | Upstream attributions and license texts |

---

## Verification & Tests

Run checks for the harness(es) you work in (see [`AGENTS.md`](AGENTS.md) for CI parity details):

### Copilot CLI & shared skill checks

```bash
python3 scripts/validate.py                               # skill frontmatter, links, agents, hooks, policy
bash scripts/test.sh                                      # installer, Copilot extensions, and guard tests
python3 -m unittest discover -s orchestrator_guard/tests  # Python hook guard engine tests
node --test extensions/*/extension.test.mjs               # Copilot CLI tickets & jira extension tests
```

### `pi` & shared repository checks

```bash
bash .pi/extensions/subagent/test/setup-deps.sh               # once: link pi's packages
node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts
(cd .pi/extensions/opencode-go-provider && node --test)
node --test skills/prevent-recurrence/scripts/test/*.test.mjs
node skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
node tools/skills-index.mjs --check
node --test tools/bench/run.test.mjs
node --test tools/mcp-catalogue.test.mjs
node --test tools/branch-base.test.mjs
```

---

## Skills and how they are invoked

<!-- skills-index:begin — generated by tools/skills-index.mjs --write; do not edit by hand -->

### User-invoked — 8: only you can start these, by typing `/skill:<name>`

| Skill | What it does, and when to reach for it |
|---|---|
| [`/handoff`](skills/handoff/SKILL.md) | User-invoked /handoff (pi: /skill:handoff): compact the session into a handoff document for a fresh agent. |
| [`/implement`](skills/implement/SKILL.md) | User-invoked /implement (pi: /skill:implement): build a spec, ticket, ticket set, or plan end to end in small verified units. |
| [`/implement-spec`](skills/implement-spec/SKILL.md) | User-invoked /implement-spec (pi: /skill:implement-spec): execute a multi-ticket spec in parallel worktrees by ready frontier. |
| [`/recall`](skills/recall/SKILL.md) | User-invoked /recall (pi: /skill:recall): rebuild working context from recent sessions, git, and PRs into a brief. |
| [`/teach`](skills/teach/SKILL.md) | User-invoked /teach (pi: /skill:teach): teach a topic across sessions in a stateful workspace of lessons and records. |
| [`/to-spec`](skills/to-spec/SKILL.md) | User-invoked /to-spec (pi: /skill:to-spec): turn the conversation into a written spec with test seams and acceptance criteria. |
| [`/to-tickets`](skills/to-tickets/SKILL.md) | User-invoked /to-tickets (pi: /skill:to-tickets): break a spec or plan into vertical-slice tickets with blocked-by edges. |
| [`/verify-app`](skills/verify-app/SKILL.md) | User-invoked /verify-app (pi: /skill:verify-app): create or audit a project-local E2E verification skill that drives the real app. |

### Model-invoked — 24: you can type `/skill:<name>`, and the agent loads one itself when its description matches

| Skill | What it does, and when to reach for it |
|---|---|
| [`add-model`](skills/add-model/SKILL.md) | Add or fix a model in the opencode-go provider. Use when: a model is missing or stale; shows as non-reasoning; or has wrong or missing thinking levels. |
| [`architect`](skills/architect/SKILL.md) | Design the shape of a change before coding: sketch two distinct interfaces, cut pass-throughs, keep one owner per state. Use when: designing a module or feature, reshaping a boundary, or choosing between abstractions. |
| [`benchmark-checklist`](skills/benchmark-checklist/SKILL.md) | Vet a performance measurement (limiter, tuning, physical limits, errors, repeatability, relevance, real work) before reporting. Use when: running a benchmark, claiming a speedup or regression, or comparing speed. |
| [`blast-radius`](skills/blast-radius/SKILL.md) | Find what a change could break beyond its diff, and prove the safety invariant with real code. Use when: crossing module boundaries; changing public APIs, schemas, wire formats, configs, persistence, or concurrency; or touching many files. |
| [`commit`](skills/commit/SKILL.md) | Make a git commit following this repo's format and branch rules. Use when: committing current changes. |
| [`devcontainer`](skills/devcontainer/SKILL.md) | Work inside a project's devcontainer from a headless host with `devc`. Use when: running commands inside a project container; a container build, dev server or database misbehaves; or the user asks to open, rebuild, stop or diagnose a devcontainer. |
| [`diagnosing-bugs`](skills/diagnosing-bugs/SKILL.md) | Diagnose bugs, test failures, crashes, flakes, or regressions to a confirmed root cause via a tight red feedback loop. Use when: something is broken, failing, flaky, or slow; asked to debug; or an earlier fix failed. |
| [`github`](skills/github/SKILL.md) | Work with GitHub through the `gh` CLI. Use when: issues, pull requests, CI runs or releases; or any `gh` command in this repository. |
| [`grilling`](skills/grilling/SKILL.md) | Stress-test a plan, decision, or idea through rounds of numbered questions with recommended answers until nothing is silently assumed. Use when: asked to grill or poke holes in a plan, or when open decisions depend on each other. |
| [`idempotent-operations`](skills/idempotent-operations/SKILL.md) | Design state-changing operations to converge regardless of retries or partial crashes. Use when: writing retries, queues, webhooks, background jobs, CLI commands, setup scripts, or data migrations. |
| [`in-your-own-words`](skills/in-your-own-words/SKILL.md) | Play back the goal, success condition, scope, and risky assumptions before building. Use when: a request changes behavior, spans multiple files, is ambiguous, or involves state transitions, retries, or migrations. |
| [`interrogate`](skills/interrogate/SKILL.md) | Run an adversarial break-the-change audit that proves concrete failures by executing code, skipping style. Use when: asked to red-team or stress-test a change; or before merging high-risk auth, security, concurrency, or migration code. |
| [`librarian`](skills/librarian/SKILL.md) | Cache and refresh remote git repositories under the pi agent dir so later references reuse a local checkout. Use when: the user points you to a remote git repository as reference; or you encounter one through other means. |
| [`native-web-search`](skills/native-web-search/SKILL.md) | Trigger native web search. Use when: you need quick internet research with concise summaries and full source URLs. |
| [`prevent-recurrence`](skills/prevent-recurrence/SKILL.md) | Turn a repeated correction into an enforced check that fails without it. Use when: the same mistake class is corrected twice; a review, revert or fix shows a known pattern coming back; or a correction needs to stop a class, not one instance. |
| [`prove-it-works`](skills/prove-it-works/SKILL.md) | Prove a change works before claiming done: verify the real artifact, run the quality gate, inspect the diff, and report evidence. Use when: finishing a coding task, before committing or opening a PR, or asked to verify changes. |
| [`retro`](skills/retro/SKILL.md) | Improve the repository's harness, checks, and agent instructions after repeated friction, fixing mistakes at the highest durable layer. Use when: asked for a retro; after repeated corrections; or after a milestone exposes tooling or doc gaps. |
| [`review-change`](skills/review-change/SKILL.md) | Review a diff on separate Spec, Correctness, and Standards axes, proving correctness findings with runs or concrete paths. Use when: asked to review a branch, PR, diff, or uncommitted work; or after a non-trivial change before claiming done. |
| [`show-me-your-work`](skills/show-me-your-work/SKILL.md) | Keep an append-only TSV decision trail, audit it before handing back, and surface flags. Use when: asked to show your work or keep a decision log, on autonomous or multi-phase runs, or for long unsupervised work. |
| [`tdd`](skills/tdd/SKILL.md) | Test-first development: write a failing test at a public seam, then the smallest code that passes. Use when: adding or changing behavior, fixing a bug with a test path, changing a public API, or asked for TDD or a regression test. |
| [`tmux`](skills/tmux/SKILL.md) | Drive interactive CLIs (python, gdb, lldb, psql) over a private tmux socket. Use when: a process needs a persistent TTY that a one-shot bash call cannot provide. |
| [`update-changelog`](skills/update-changelog/SKILL.md) | Update the repository's changelog correctly. Use when: updating CHANGELOG.md or CHANGELOG; preparing a release. |
| [`worktree`](skills/worktree/SKILL.md) | Create, list, open, review, and remove git worktrees (linked working trees) for independent tasks. Use when: a task needs an isolated working tree or branch without disturbing the current checkout; or parallel tasks need separate checkouts. |
| [`writing-for-agents`](skills/writing-for-agents/SKILL.md) | Writing documents an agent consumes — skills, AGENTS.md, harness instruction files, and docs reached by a pointer. Use when: writing or editing a skill; or changing a rule or pointer in AGENTS.md or harness instruction files. |

<!-- skills-index:end -->
