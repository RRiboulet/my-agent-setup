# Agent Notes

## Branches

Two long-lived branches:

| Branch | Purpose |
|---|---|
| `dev` | Integration branch. Every feature branch starts and merges here. |
| `main` | Releases only. Tags cut here; never branch work off `main`. |

Start every feature branch from `dev` (never `main` or another feature branch), named for the change (`fix-changelog-unreleased-structure`). Before committing, verify the base:

```bash
node tools/branch-base.mjs
```

Manual fallback when needed: `git fetch origin`, then check both `git merge-base --is-ancestor dev HEAD` (catches branching off `main` or stale `dev`) and `git log --oneline dev..HEAD` (lists foreign commits). Rationale, verification matrix, stacked branches, and one-branch-per-change details: `docs/harness/branches.md`.

## Pull requests and releases

Authentication uses `GH_TOKEN` from the host (`~/.config/devc/env`) and system-wide `gh` git credentials (`docs/harness/github-auth.md`). Never put a token in `.git/config`, the Dockerfile, or any repo file; if auth breaks mid-session, stop and ask.

Feature workflow:

1. Work on a feature branch off `dev`; commit per `.pi/skills/commit/`.
2. `git push -u origin <branch>`
3. `gh pr create --base dev --fill` — `--base dev` is required because the default branch is `main`; inspect the generated title and summarize verification in the body.
4. `gh pr merge --squash --delete-branch` — squash tips are not in `dev` history, so let `gh` delete both local and remote branches.
5. `git checkout dev && git pull --ff-only`

Release workflow (`dev` → `main`; tags cut from `main` only):

1. On `dev`, update `CHANGELOG.md` (`## Unreleased` → `## vX.Y.Z — <today>`, fresh `## Unreleased` above; per `.pi/skills/update-changelog/`, checked by `.pi/extensions/subagent/test/changelog-structure.test.ts`). A release that starts a new major also deletes the older major's sections in that same commit: the file holds `## Unreleased` and the newest major only, and every older release stays reachable through its tag (`git show vX.Y.Z:CHANGELOG.md`).
2. Commit, push `dev`, and open PR `dev` → `main`. Never squash a release.
3. `gh pr merge <n> --merge` — do not pass `--delete-branch` because `dev` is the head branch and must survive.
4. Tag the merge commit on `main` and push: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Fast-forward `dev` to `main` so `git describe --tags` sees the new tag: `git checkout dev && git merge --ff-only main && git push origin dev`.

Versions are git tags. The `pi` manifest in `package.json` makes this private repo installable as `pi install git:github.com/RRiboulet/my-agent-setup`.

## Extensions and settings

Extensions live in `.pi/extensions/` and skills in `.pi/skills/`. Add every new extension entry point or skill to `package.json`'s `pi` manifest (checked by `.pi/extensions/subagent/test/package-manifest.test.ts`). Cross-extension imports have one home per extension (`.pi/extensions/orchestrator/events.ts`).

Settings: `.pi/settings.json` (tracked in git) sets `defaultTools: ["+tool_search", "+codemode"]` and `codemode.mode: "on"`; `.devcontainer/pi/settings.json` holds container defaults. Prefer `codemode` to batch independent/parallel calls and filter large output; use direct tools (`read`, `edit`, `write`, `bash`) for single-step work.

On a host running `pi` from this checkout, install by local path (`pi install /path/to/my-agent-setup`), never `git:`, to avoid duplicate tool registration errors (`README.md`, "One copy of the extensions, never two"). Linked worktrees live under gitignored `.worktrees/` (`.pi/skills/worktree/`). Consult pi's API docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/`; do not modify pi itself.

Orchestrator settlement gate, advisor, workspace lockScope, and pinned-container setup: `docs/harness/extensions.md` (this repo commits no `.pi/orchestrator.json`, so its gate is report-only). `/orchestrate <folder>` and `orchestrator_wave` enforce tiered wave dispatch and gates inside `.pi/extensions/orchestrator/`.

## Coding skills

Load a skill when its trigger applies rather than waiting to be asked (provenance, mechanics, and repo overrides: `docs/harness/skills.md`):

- **Trivial, unambiguous edit** (no observable behavior at a seam — typo, comment, private rename, dependency bump, release note): make it, check it, skip ceremony (judgment call).
- **Non-trivial or ambiguous request**: `in-your-own-words` before building.
- **Open design shape** (new module, boundary reshape, recurring workaround, competing abstractions): `architect` before code.
- **User asks to be grilled/stress-tested**, or design tree outruns a playback: `grilling`.
- **Crosses a module, service, API, schema, or config boundary**: `blast-radius`.
- **Bug, failing test, CI failure, crash, flake, or regression**: `diagnosing-bugs` first.
- **New or changed behavior** (default implementation style; skip for non-behavior edits): `tdd`.
- **Retries, queues, webhooks, jobs, migrations, or setup scripts**: `idempotent-operations`.
- **Producing or acting on a performance number**: `benchmark-checklist`.
- **Big unsupervised task spanning hours**: `show-me-your-work`.
- **Before claiming done**: `prove-it-works` — revert the behavior change in one edit, watch its covering test go red, restore, re-run, and report the test (otherwise status is `not_run`, never `passed`).
- **Same mistake class corrected twice**: `prevent-recurrence`.
- **Writing/editing a skill, `AGENTS.md`, or pointer doc**: `writing-for-agents`.

Only the user starts the **6** user-invoked entry points (suggest when fitting; never start them yourself): `/skill:handoff`, `/skill:implement`, `/skill:recall`, `/skill:teach`, `/skill:to-spec`, `/skill:to-tickets`.

Repo overrides over adapted skill bodies: commits follow `commit` (branch and base checks); worktrees use `.worktrees/` (`worktree`); reviews follow `## Reviews` below (`implement` and `prove-it-works` end at proof, never start a review).

## Subagent tools

For a child rooted in `.worktrees/<slug>`, inherit the per-checkout agent dir or pi fails on duplicate tools (`bin/pi-wrapped` handles non-login launchers):

```bash
cd .worktrees/<slug> && PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)" pi -p "<task>"
```

The seven management tools (`subagent_wait`, `subagent_status`, `subagent_answer`, `subagent_cancel`, `subagent_interrupt`, `subagent_resume`, `subagent_clean`) are behind `tool_search` / `codemode` while `subagent` stays declared: call `tool_search` then invoke, or call `tools.subagent_*` in codemode. Start tasks and wait once (`subagent_wait`); reserve `subagent_status` for live inspection. Child-question confirmation (`subagent_ask` / `subagent_answer`) and launcher details: `docs/harness/subagents.md`.

## Reviews

One review pipeline, only when requested (`prove-it-works` never commissions a review). When asked for a review, pick one door: `/review` (interactive, appends `REVIEW_GUIDELINES.md`) or `triage_change` / `/triage` + one subagent. Never run both or start a second reviewer.

Always ask the user before launching a review subagent (propose lens and model, wait for yes). Pick `provider`, `model`, and `thinking` strictly from `candidates` in `.pi/extensions/review-triage/config.ts` (or `~/.pi/agent/review-triage.json`). Details: `docs/harness/reviews.md`.

## Rules and enforcement

| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| A branch descends from origin/dev and carries only its own commits | test | `node tools/branch-base.mjs` | `tools/branch-base.test.mjs` |
| CI checks match AGENTS.md Tests in order | test | `node --test .pi/extensions/subagent/test/checks-parity.test.ts` | `.pi/extensions/subagent/test/checks-parity.test.ts` |
| Release merge never passes --delete-branch | test | `node --test .pi/extensions/subagent/test/github-skill.test.ts` | `.pi/extensions/subagent/test/github-skill.test.ts` |
| Every extension and skill in .pi/ is listed in package.json manifest | test | `node --test .pi/extensions/subagent/test/package-manifest.test.ts` | `.pi/extensions/subagent/test/package-manifest.test.ts` |
| Every extension loads under strict ESM without side effects | test | `node --test .pi/extensions/subagent/test/extension-load.test.ts` | `.pi/extensions/subagent/test/extension-load.test.ts` |
| Per-container agent dir is declared in devcontainer.json only | test | `node --test .pi/extensions/subagent/test/devcontainer-agent-dir.test.ts` | `.pi/extensions/subagent/test/devcontainer-agent-dir.test.ts` |
| CHANGELOG.md keeps ## Unreleased at H2 above descending versions | test | `node --test .pi/extensions/subagent/test/changelog-structure.test.ts` | `.pi/extensions/subagent/test/changelog-structure.test.ts` |
| CHANGELOG.md holds ## Unreleased plus the newest major's releases only, older ones via git show | test | `node --test .pi/extensions/subagent/test/changelog-structure.test.ts` | `.pi/extensions/subagent/test/changelog-structure.test.ts` |
| CHANGELOG.md merges with the union driver so concurrent Unreleased appends merge | test | `node --test .pi/extensions/subagent/test/changelog-union-attribute.test.ts` | `.pi/extensions/subagent/test/changelog-union-attribute.test.ts` |
| Skills follow naming, invocation, byte-cap, and reference-link contracts | test | `node --test .pi/extensions/subagent/test/coding-skills.test.ts` | `.pi/extensions/subagent/test/coding-skills.test.ts` |
| README skill index matches .pi/skills frontmatter | test | `node tools/skills-index.mjs --check` | `.pi/extensions/subagent/test/skills-index.test.ts` |

Table format and checker contract: `.pi/skills/prevent-recurrence/references/rule-table.md`.

## Tests

```bash
bash .pi/extensions/subagent/test/setup-deps.sh              # once: link pi's packages
node --test --test-concurrency=8 .pi/extensions/subagent/test/*.test.ts
(cd .pi/extensions/opencode-go-provider && node --test)  # provider package tests (separate tree)
node --test .pi/skills/prevent-recurrence/scripts/test/*.test.mjs  # rule-table checker
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md  # the rule table; must exit 0
node tools/skills-index.mjs --check                     # the README's skill index; must exit 0
node --test tools/bench/run.test.mjs                     # bench runner tests
node --test tools/mcp-catalogue.test.mjs                 # catalogue install tests
node --test tools/branch-base.test.mjs                   # branch-base check tests
node tools/branch-base.mjs                               # the branch-base rule; must exit 0
```

Run `setup-deps.sh` with `bash` (never `./setup-deps.sh`). Node executes `.ts` directly with no build or typecheck step (`tsconfig.json`/`tsc` intentionally absent). Keep `--test-concurrency=8` fixed; check `cat /proc/loadavg` and `ps` before timing anything, and re-run a failing file alone under host contention (`docs/harness/testing.md`, `.pi/extensions/subagent/test/README.md`).

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, which can hide pre-existing CRLF files in the working tree from `git status`. Keep shell scripts LF; if one fails inexplicably (`$'\r'`), check `grep -qU $'\r' <file>` and repair the tree with:

```bash
git add --renormalize .
git ls-files -z | xargs -0 rm -f && git checkout-index -a -f
```
