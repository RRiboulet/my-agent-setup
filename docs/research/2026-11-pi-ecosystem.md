# Pi ecosystem survey — November 2026

Observed 2026-11-17 against Pi `1.5.2`. Stars, downloads, and dates are snapshots, not guarantees. Source links are inline; "last push" comes from the linked GitHub repo. Reddit's JSON endpoints returned a block page, so community pain points below rely on GitHub issues and Hacker News rather than Reddit.

## 0. What Pi actually supports (verified first)

- **Packages** are ordinary npm/git/local sources with `extensions/`, `skills/`, `prompts/`, `themes/`, or an explicit `pi` manifest. `pi install npm:<pkg>` is the documented install form; `pi-package` in `keywords` makes an npm package eligible for the gallery. [docs/packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- **Skills** implement the [Agent Skills spec](https://agentskills.io/specification) and are discovered from `SKILL.md` directories, including `~/.agents/skills/`, `.agents/skills/`, and Pi's own skill paths. [docs/skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- **MCP is built in**: stdio and streamable HTTP, OAuth, resources, and `codemode`/`tool_search`/`direct` exposure. Default exposure is `codemode`, so large tool sets need not sit in the prompt. [docs/mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)
- **Built-in tools** are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; there is no first-class web-search, LSP, memory, or subagent tool in core. [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#overriding-built-in-tools)
- **Discovery is large and noisy**: [pi.dev/packages](https://pi.dev/packages) showed `1–50 / 5500` packages. Among the 50 most recently updated entries, the headline download counts were billion-context (3.58M), pi-mcp-adapter (2.08M), pi-web-access (1.40M), pi-mcp-extension (1.05M), and pi-subagents (995k); ranks shift with the gallery sort. Treat download counts as popularity, not quality.

### Where to browse

- [pi.dev/packages](https://pi.dev/packages) — official gallery, filterable by extension/skill/theme/prompt.
- [shaftoe/awesome-pi-coding-agent](https://github.com/shaftoe/awesome-pi-coding-agent) — auto-curated, updated daily (last update 2026-11-17), 183★.
- [bubbleptr/awesome-pi](https://github.com/bubbleptr/awesome-pi) — community list with searchable site [piindex.dev](https://piindex.dev), 157★.
- [qualisero/awesome-pi-agent](https://github.com/qualisero/awesome-pi-agent) — 1.1k★ but its README now says it is outdated and retired; do not treat it as current.
- [spences10/my-pi](https://github.com/spences10/my-pi) — example personal config/dotfiles repo (LSP, redaction, recall, telemetry), 140★.

## 1. Notable pi packages and extensions

All rows below are **npm-published** unless marked. Install commands are from each project's README. "Last push" is repository activity, not the npm publish date.

| Package / source | What it does, and why it matters | Install | ★ / last push |
|---|---|---|---|
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Delegates to focused child agents: reviewers, scouts, implementers, parallel audits, saved/background workflows. The most mature general delegation option. | `pi install npm:pi-subagents` | 4.2k / 2026-11-17 |
| [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | Claude Code-style isolated subagents with steering, resume, custom agent types, and deterministic JS `parallel()`/`pipeline()` workflows. More orchestration, more surface area. | `pi install npm:@tintinweb/pi-subagents` | 1.5k / 2026-11-16 |
| [@quintinshaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | Turns one request into a JS orchestration script that fans work across isolated subagents, routes models per task, and keeps intermediate results out of chat context. Good for audits/refactors. | `pi install npm:@quintinshaw/pi-dynamic-workflows` | 596 / 2026-11-13 |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Replaces Pi's built-in MCP with a lazy proxy: starts servers on first use, stops after idle, semantic/classifier tool search, keychain tokens, forms/UI, server import. Only needed if built-in MCP is too eager or too limited. Installing it turns built-in MCP off. | `pi install npm:pi-mcp-adapter` | 1.7k / 2026-11-11 |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Web search, page fetch, GitHub repo cloning, PDF extraction, YouTube/local-video understanding, many providers plus zero-config Exa. Fills the biggest core-tool gap. | `pi install npm:pi-web-access` | 1.8k / 2026-11-15 |
| [pi-lens](https://github.com/apmantza/pi-lens) | Runs language servers, linters, formatters, and type checks after edits; feeds blocking findings back to the agent. The de facto LSP layer for Pi. | `pi install npm:pi-lens` (or `git:github.com/apmantza/pi-lens`) | 531 / 2026-11-17 |
| [pi-sandbox](https://github.com/carderne/pi-sandbox) | OS-level sandbox for `bash` plus allow/deny control for read/write/edit, with permission prompts. Addresses the broad permission surface of Pi's built-in tools and extensions. Needs `ripgrep`. | `pi install npm:pi-sandbox` | 308 / 2026-11-13 |
| [pi-memory](https://github.com/jayzeng/pi-memory) | Persistent markdown memory (`MEMORY.md`, daily log, scratchpad) plus optional qmd semantic/hybrid search. Native replacement for a generic memory MCP server. | `pi install npm:pi-memory` | 218 / 2026-11-07 |
| [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks) | Claude Code-style task tracking: 7 task tools, dependency DAG, shared file-backed lists, background processes, optional subagent execution. | `pi install npm:@tintinweb/pi-tasks` | 248 / 2026-10-13 |
| [@plannotator/pi-extension](https://github.com/backnotprop/plannotator) | Browser-based review surface for plans, specs, diffs, PRs, and HTML artifacts; annotations come back as the next turn. The repo overall is 12.8k★; the Pi package is one integration. | `pi install npm:@plannotator/pi-extension` | 12.8k repo / 2026-11-17 |
| [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) | Uses Claude Code (Agent SDK) as a Pi model provider, so Claude subscription models run through Claude Code's loop. Alternative: official [pi-claude-code](https://github.com/earendil-works/pi-claude-code). | `pi install npm:pi-claude-bridge` | 833 / 2026-11-16 |
| [@gotgenes/pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) | Compatibility fixes for Claude Pro/Max OAuth while preserving the built-in Anthropic provider and `/login` flow. For subscription users, not API-key users. | `pi install npm:@gotgenes/pi-anthropic-auth` | 442 / 2026-11-15 |
| [pi-herdsman](https://github.com/boadij/pi-herdsman) | Asynchronous subagents and fleet orchestration on top of `herdr` terminal sessions; branch-based leads, permissions, supervision. Emerging and heavier than pi-subagents. | `pi install npm:pi-herdsman` | 236 / 2026-11-17 |

**Also notable, but not default choices:** [pi-fabric](https://github.com/fabric-runtime/pi-fabric) (one `fabric_exec` runtime for tools/MCP/agents, 338★), [pi-agent-browser-native](https://github.com/fitchmultz/pi-agent-browser-native) (native `agent-browser` tool, 257★), [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) (Cursor agent loop as provider, 353★), [@czottmann/pi-automode](https://github.com/czottmann/pi-automode) (auto-selected model/mode, 222★), [pi-blackhole](https://github.com/k0valik/pi-blackhole) (algorithmic compaction + observational memory, 299★), [pi-posthorse](https://github.com/fitchmultz/pi-posthorse) (no-summary context rollover, 288★), [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) (knowledge graph, last push June 2026), and [@postman/postman-plugin](https://github.com/postmanlabs/postman-plugin) (Postman API skills; install with `npx @postman/postman-plugin@latest`, only 36★ but vendor-backed).

**Cross-agent context tools** are in the Pi gallery but are not plain `pi install` packages. [billion-context](https://github.com/ranxianglei/billion-context) (7.7k★) is installed for Pi with `bili plugin install pi` or the standalone `billion-context-pi`. [context-mode](https://github.com/mksglu/context-mode) (34.2k★) has agent-specific install blocks; follow its current installer rather than assuming a `pi install` command. Both are large, invasive, and worth testing on a throwaway profile before adopting.

**Caveats:** low-adoption packages such as [pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension) (11★) are speculative even though they are npm-published. Stacking multiple context/compaction extensions is a known way to create conflicts; pick one. Pi itself warns that packages and skills can execute code, so review source before installing.

## 2. Skills ecosystems compatible with Pi

Pi implements the Agent Skills spec, so a portable `SKILL.md` collection works without a Pi-specific build. These collections are **GitHub-only** (not npm packages); the `npx skills` installer is the npm-published piece. The [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI explicitly lists `pi` as an agent and installs into `.agents/skills/`; its [agent table](https://github.com/vercel-labs/skills/blob/main/docs/agents.md) is the compatibility evidence. Alternatively, clone/copy skill directories into `~/.agents/skills/` or `~/.pi/agent/skills/`.

| Collection | What it offers | How to use it with Pi | ★ / activity |
|---|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills) | 20 reference skills, including production document skills (`docx`, `pdf`, `pptx`, `xlsx`), `frontend-design`, `webapp-testing`, `mcp-builder`, `skill-creator`. Mostly Apache-2.0. | `npx skills add anthropics/skills -a pi` (select skills), or copy `skills/*` under `~/.agents/skills/` | 196k / 2026-11-16 |
| [obra/superpowers](https://github.com/obra/superpowers) | 15 skills that encode a development methodology: brainstorming, writing/executing plans, TDD, systematic debugging, worktrees, review, verification. | `npx skills add obra/superpowers -a pi`, or copy the `skills/` tree | 319k / 2026-11-03 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 40 skills focused on real engineering practice: code review, bug diagnosis, codebase design, domain modeling, specs, PRs, TDD, triage. | `npx skills add mattpocock/skills -a pi` | 326k / 2026-11-13 |
| [badlogic/pi-skills](https://github.com/badlogic/pi-skills) | 8 Pi-oriented skills: browser tools, Brave search, VS Code, transcription, YouTube transcripts, Google Cloud/Gemini CLIs. Linked from Pi's own docs, but stale. | `git clone https://github.com/badlogic/pi-skills ~/.pi/agent/skills/pi-skills` | 2.7k / 2026-06-06 |
| [waybarrios/opencode-power-pack](https://github.com/waybarrios/opencode-power-pack) | 55 rigorous skills for code review, security audit, feature development, frontend design, and a large Hugging Face subset; explicitly claims Pi support. | `npx skills add waybarrios/opencode-power-pack -a pi` or copy selected skills | 557 / 2026-11-16 |
| [vercel-labs/skills](https://github.com/vercel-labs/skills) | Not a collection: the `npx skills` installer/registry client. `find-skills` is its own skill. | `npx skills find`, then `npx skills add <repo> -a pi` | 39.8k / 2026-11-17 |

**Caveat:** spec compatibility does not guarantee behavioral compatibility. Some skills assume Claude-only tools (`Task`, `Read`), specific scripts, or `allowed-tools`; audit before adopting, and expect to rewrite tool references for Pi.

### Individual skills that would fill a real gap

| Skill | Source | Gap it fills |
|---|---|---|
| `pdf` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/pdf) | Extract text/tables, fill forms, merge/split PDFs; Pi has no document tooling. |
| `docx` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/docx) | Create/edit Word documents with tracked changes and comments. |
| `xlsx` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/xlsx) | Read/write spreadsheets and formulas with a known-good workflow instead of improvised scripts. |
| `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) | Browser-driven testing of local web apps; complements Playwright without making it a default MCP server. |
| `systematic-debugging` | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) | Enforces root-cause investigation before patching; counteracts guess-and-check. |
| `test-driven-development` | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/test-driven-development) | Red/green/refactor loop with explicit evidence, instead of tests after the fact. |
| `using-git-worktrees` | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/using-git-worktrees) | Isolated parallel branches and worktrees; pairs naturally with Pi subagents. |
| `verification-before-completion` | [obra/superpowers](https://github.com/obra/superpowers/tree/main/skills/verification-before-completion) | Forces a verification pass before claiming done; high value for long agent runs. |
| `code-review` | [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review) | A concrete review checklist and workflow, usable by a reviewer subagent. |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Raises UI quality beyond "make it functional"; useful when Pi writes frontend code. |

## 3. MCP servers: what is worth wiring into Pi

Pi already has native MCP, so the question is not "can I connect this?" but "does it add a capability core Pi lacks, without duplicating tools or burning context?" Default `codemode` exposure makes a server cheap to keep configured, but every server is still a moving process and an attack surface. [docs/mcp.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)

| MCP server | Capability | Verdict for Pi | Source |
|---|---|---|---|
| Context7 | Up-to-date library/framework docs, version-specific | **Optional.** Genuinely useful for fast-moving libraries. Its README offers a CLI+Skills mode: on Pi, install that skill and skip the MCP server if you only need docs; otherwise add the remote server. | [upstash/context7](https://github.com/upstash/context7) (65k★, active) |
| Playwright | Browser automation, accessibility snapshots, E2E-style exploration | **Worth it only for persistent exploratory/browser-debug loops.** Its own README now recommends CLI+skills for coding agents because MCP schemas/accessibility trees cost context. For Pi, `pi-agent-browser-native` is a lighter native option. | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) (39.8k★, active) |
| Language-server / Serena | Definitions, references, rename, diagnostics, semantic editing | **Do not wire a generic LSP MCP as the default.** Pi has no built-in LSP; use native [pi-lens](https://github.com/apmantza/pi-lens) instead. Serena is the exception if you specifically want semantic refactoring across languages. `mcp-language-server` is stale (last push March 2026). | [oraios/serena](https://github.com/oraios/serena) (31.5k★), [isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server) (1.6k★) |
| Memory | Knowledge-graph memory across sessions | **Skip.** Pi has session history and project context; native [pi-memory](https://github.com/jayzeng/pi-memory) integrates with Pi's lifecycle and markdown/qmd. The reference memory server is a separate graph with its own schema. | [modelcontextprotocol/servers/memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) |
| Sequential thinking | Structured multi-step reasoning tool | **Skip.** Pi already exposes thinking levels and long-context models; this duplicates reasoning while adding tool calls and context. | [modelcontextprotocol/servers/sequentialthinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) |
| GitHub | Issues, PRs, code search, Actions via GitHub API | **Optional.** If `gh` is installed, `bash` + `gh` is cheaper and more scriptable. Wire the official MCP if you need OAuth-hosted access, structured issue/PR operations, or no local `gh`. Keep it `deferred`/`codemode`, not `direct`. | [github/github-mcp-server](https://github.com/github/github-mcp-server) (34.5k★, active) |
| Chrome DevTools | Performance traces, network inspection, console, DOM | **Optional, specialist.** Better than Playwright for perf/network debugging, worse for general browsing and tests. Run at most one browser server at a time. | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) (57.9k★, active) |
| Filesystem | Read/write/search files | **Skip.** Duplicates `read`, `write`, `edit`, `grep`, `find`, `ls`, and adds a second permission model. | `@modelcontextprotocol/server-filesystem` |

Useful commands (from [Pi MCP docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)):

```bash
pi mcp add playwright -- npx -y @playwright/mcp@latest
pi mcp add context7 --url https://mcp.context7.com/mcp --bearer-token-env-var CONTEXT7_API_KEY
pi mcp add github --url https://api.githubcopilot.com/mcp/   # then /mcp login github if OAuth is requested
```

**Recommended MCP set:** none by default; add Playwright only while doing browser work, and Context7 only if documentation lookup is a recurring task. Prefer native extensions/CLI+skills for LSP, memory, and GitHub. If you keep many servers, `pi-mcp-adapter` is the mitigation (lazy start, semantic tool search, keychain), but it replaces built-in MCP and adds its own failure modes.

## 4. Pi-specific pain points and the extensions built around them

- **Windows is the loudest open thread.** [#7547](https://github.com/earendil-works/pi/issues/7547) (open, 96 comments) collects Windows issues; related: git-bash detection [#5103](https://github.com/earendil-works/pi/issues/5103), terminal color replies leaking into the prompt [#10256](https://github.com/earendil-works/pi/issues/10256), per-keystroke redraw [#6300](https://github.com/earendil-works/pi/issues/6300). This is a harness/platform gap, not something a skill fixes.
- **TUI performance and rendering.** High CPU on long sessions [#7730](https://github.com/earendil-works/pi/issues/7730), fullscreen re-render saturation [#9549](https://github.com/earendil-works/pi/issues/9549), `Intl.Segmenter`/Markdown rebuild cost [#6665](https://github.com/earendil-works/pi/issues/6665), and streaming scroll-jank [#5825](https://github.com/earendil-works/pi/issues/5825). Extensions such as [pi-pretty](https://github.com/heyhuynhgiabuu/pi-pretty) and [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) target presentation, not the core renderer.
- **Context compaction is unsolved.** Auto-compaction failing to trigger [#6879](https://github.com/earendil-works/pi/issues/6879), under-compaction [#128](https://github.com/earendil-works/pi/issues/128), and noisy file output [#4916](https://github.com/earendil-works/pi/issues/4916) explain the wave of [billion-context](https://github.com/ranxianglei/billion-context), [context-mode](https://github.com/mksglu/context-mode), [pi-blackhole](https://github.com/k0valik/pi-blackhole), [pi-posthorse](https://github.com/fitchmultz/pi-posthorse), and [pi-memory](https://github.com/jayzeng/pi-memory). These overlap; do not stack them blindly.
- **MCP integration changed under everyone.** Pi added built-in MCP (the Codemode/MCP PR is [#10040](https://github.com/earendil-works/pi/pull/10040)), which made earlier MCP extensions partly redundant. [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) survives by being lazier and more featureful; [pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension) has little traction.
- **Delegation/task tracking is not in core.** The number of independent subagent and task-layer implementations — [pi-subagents](https://github.com/nicobailon/pi-subagents), [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), [pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows), [pi-herdsman](https://github.com/boadij/pi-herdsman), [pi-tasks](https://github.com/tintinweb/pi-tasks) — is itself evidence of demand.
- **Security/trust is a recurring concern.** Project trust feedback [#5514](https://github.com/earendil-works/pi/issues/5514); the HN "Pi pod" thread (121 points, 45 comments) is about sandboxed hosting ([HN 49937304](https://news.ycombinator.com/item?id=49937304)). Responses include [pi-sandbox](https://github.com/carderne/pi-sandbox), [pi-deltabox](https://pi.dev/packages/pi-deltabox), and [cc-safety-net](https://github.com/kenryu42/cc-safety-net).
- **Package discovery is weak.** npm search stopped indexing new `pi-package`s for a period ([#7885](https://github.com/earendil-works/pi/issues/7885), closed), which is why the gallery and the daily awesome list matter. The most-starred awesome list is retired, so "most stars" is a bad discovery heuristic here.
- **Config location / XDG.** [#534](https://github.com/earendil-works/pi/issues/534) and [#2870](https://github.com/earendil-works/pi/issues/2870) (both closed), plus the HN thread "config folder is out of place on Linux" ([HN 49328206](https://news.ycombinator.com/item?id=49328206)). Users on Linux still notice the non-XDG path.
- **Model/provider friction.** Local-provider demand [#3357](https://github.com/earendil-works/pi/issues/3357), Codex connection reliability [#4945](https://github.com/earendil-works/pi/issues/4945), Claude model edit failures [#6278](https://github.com/earendil-works/pi/issues/6278), and Anthropic OAuth breakage [#581](https://github.com/earendil-works/pi/issues/581). Provider bridges ([pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk)) and auth fixes ([pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth)) grow from this.
- **Session/state edge cases.** Session folder collisions [#4877](https://github.com/earendil-works/pi/issues/4877) and demand for isolated state/profile support ([PR #3963](https://github.com/earendil-works/pi/pull/3963)) show that long-running, multi-project use still needs workarounds.

## Bottom line

1. **Trial first:** `pi-subagents` (delegation), `pi-lens` (LSP feedback), `pi-web-access` (search/fetch), `pi-sandbox` (containment). Add `pi-memory` only if cross-session recall matters.
2. **Don't install all the context tools.** Pick one of billion-context/context-mode/pi-blackhole/pi-posthorse, and test on a disposable profile; they solve overlapping problems with different costs.
3. **Skills are the cheapest capability gain.** Start with `obra/superpowers` for process discipline and `anthropics/skills` for documents/browser testing; add `mattpocock/skills` for review/design. Install through `npx skills ... -a pi` or copy into `~/.agents/skills/`, then audit tool assumptions.
4. **MCP: less than you think.** Playwright for browser work, Context7 for docs, maybe GitHub if `gh` is not enough. Skip filesystem, memory, sequential-thinking; use native extensions instead.
5. **Unverified:** exact behavioral compatibility of third-party skills, long-term maintenance of low-star packages, and Reddit sentiment (blocked during this survey). Re-check stars/dates before pinning anything.
