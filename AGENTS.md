# Agent Notes

## Branches

Two long-lived branches, and everything else hangs off them:

| Branch | What lands on it |
|---|---|
| `dev` | all work in flight. Every feature branch starts here. |
| `main` | releases only. Nothing is built here; it is what a tag points at. |

**Start a feature branch from `dev`, never from `main` and never from another
feature branch.** Branch names name the change, not the session:
`attribute-native-web-search`, `fix-changelog-unreleased-structure`.

A branch merges into `dev` through a pull request. `dev` merges into `main` at
release time (see "Releases"). `main` is therefore always releasable, and a
half-finished change is never one merge away from a tag.

### Check your base before you commit

This is not ceremony. Branching off the wrong parent has happened three times in
one session, and each time it shipped a pull request carrying another branch's
commit — caught by a reviewer, not by the author. Two checks, and **both are
needed**, because the two ways of getting this wrong look different:

```bash
git fetch origin
git merge-base --is-ancestor dev HEAD    # 0 = base is right, 1 = it is not
git log --oneline dev..HEAD              # should list ONLY this change's commits
```

The ancestor check is the one that catches the mistake that actually happened:
branching off `main`, or off a `dev` that had fallen behind. In that case
`git log dev..HEAD` prints **nothing** — HEAD simply has nothing `dev` lacks — so
a check based only on that log reports a clean branch that is quietly based on
the wrong commit. The log is the second half: once the ancestor check fails, it
tells you *what* is in the way.

Verified both directions on a scratch branch:

| Situation | `git log dev..HEAD` | `merge-base --is-ancestor` |
|---|---|---|
| branched off `main`, which is behind `dev` | empty — **misses it** | **fails** — catches it |
| foreign commits stacked on `dev` | lists them | passes — correct, base is right |
| correct branch off `dev` | only my commits | passes |

`git fetch` first is not a detail. The check is only as good as the ref it
compares against, and a local `dev` left over from before three PRs merged will
happily list their commits as yours — the same false alarm as the bug it is meant
to catch, and just as likely to be ignored.

Those two commands are the manual fallback. `node tools/branch-base.mjs` runs the
same checks plus the stacked-branch case, against a freshly fetched `origin/dev`,
and prints one line naming the classification and the fix; it is what
`prove-it-works` and CI run. Its row is the first in "Rules and enforcement"
below.

A branch legitimately based on **another unmerged feature branch** still shows
foreign commits, and neither check can tell that apart from a mistake. Subtract
the base branch explicitly (`git log dev..feature-a`) or rebase onto `dev` first.

### Why a branch per change

`CHANGELOG.md`'s `Unreleased` section is shared ground. Two changes in flight
both add a `Maintenance` bullet there, so parallel branches conflict on merge
even when their code does not. A branch keeps one change's tests, files and
changelog entry together, and makes each one independently verifiable: check it
out in a worktree and run the suite before assuming it stands alone.

When two branches are ready at once, merge or rebase in an order you choose
yourself — `dev` is not a priority queue.

## Pull requests

Branches reach GitHub through `gh`, which is baked into the devcontainer image
(`.devcontainer/Dockerfile`) rather than installed at runtime, so a rebuild does
not silently drop it. The token is **not** on a shared volume any more: it arrives
as `GH_TOKEN` from the host environment, alongside the provider keys, and gh's
non-secret config sits at `GH_CONFIG_DIR=/home/vscode/.pi/gh` on this container's
private volume. That is what lets every container use the same credential without
any cross-container mount.

The host-side source is `~/.config/devc/env`, which `devc` sources (with
allexport) before `devcontainer up`; each `devcontainer.json` forwards the values
with `${localEnv:...}`. One-time setup, run by the human:

```bash
mkdir -p ~/.config/devc && chmod 700 ~/.config/devc
printf 'GH_TOKEN=%s\n' "$(gh auth token)" >> ~/.config/devc/env
chmod 600 ~/.config/devc/env
```

A `gh auth login` *inside* a container still works, but it writes only that
container's private volume, so the next container starts unauthenticated. Prefer
the host env file. `git push` then works with no credential in `.git/config`,
because the Dockerfile registers gh as git's credential helper system-wide —
deliberately, not via `gh auth setup-git`, which writes to `~/.gitconfig` on the
container-local overlay and is discarded on rebuild. The token would survive
that; the helper would not, and push would break silently.

Check *where* the token lives before trusting a login: `env | grep '^GH_TOKEN='`
(never print the value) and `gh auth status`'s config path.

## The workflow

Once authenticated:

1. Work on a branch (see "Branches"), committing as the `.pi/skills/commit/`
   skill directs where it is present.
2. `git push -u origin <branch>`
3. `gh pr create --base dev --fill` — the explicit `--base dev` is not
   decoration. This repository's **default branch is `main`**, and `gh pr create`
   with no `--base` opens the pull request against that default, so the
   unqualified command silently targets `main` — which takes releases only. A
   branch cut from `dev` then drags every change merged since the last release
   into `main` with it, because the squash replays the whole branch. `--fill`
   uses the commits for title and body, which this repo's long commit subjects
   suit; check the title it produced, since `--fill` falls back to the branch
   name when it cannot read a single commit. Always say in the body what a
   reviewer should check and what you verified.
4. `gh pr merge --squash --delete-branch`. `--delete-branch` is not optional
   politeness: a squash merge does not put the branch tip in `dev`'s history, so
   a later `git branch -d <branch>` fails with "not fully merged" and needs `-D`.
   Letting gh delete both the local and the remote branch avoids both.
5. Bring `dev` up to date: `git checkout dev && git pull --ff-only`.

Tags are cut from `main`, never from a feature branch.

Never put a token in `.git/config`, in the Dockerfile, or in a file in the repo.
If authentication is needed mid-session, stop and ask rather than improvising.

Note the consequence for step 1 of any changelog work: after a squash merge the
branch's individual commits no longer exist in `main`, so release notes are
written from PR titles and bodies, not from `git log`.

## Releases

A release is the only thing that moves `main`. Everything since the last tag
accumulates on `dev`; `main` is brought forward and tagged.

1. On `dev`, update `CHANGELOG.md`: retitle `## Unreleased` to
   `## vX.Y.Z — <today's date>`, and add a fresh empty `## Unreleased` above it.
   Nothing else in the file moves. `.pi/skills/update-changelog/` has the detail,
   and `changelog-structure.test.ts` enforces the shape.
2. Commit that, push `dev`, and open a pull request **`dev` → `main`**. This is
   the one merge that is not a squash: a release wants its history, and `main`'s
   commits should be the real ones. Use "Rebase and merge" or "Merge commit",
   never "Squash".
3. `gh pr merge <n> --merge` — **do not pass `--delete-branch`.** The head of
   this pull request is `dev`, so that flag would delete the long-lived
   integration branch. This is the one merge where the head branch must
   survive.
4. Tag the merge commit on `main` and push the tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. Fast-forward `dev` to the release merge, so the new tag is reachable from
   `dev`:

   ```bash
   git checkout dev && git merge --ff-only main && git push origin dev
   ```

   Skipping this leaves the tag on `main` only, and `git describe --tags` on
   `dev` then reports the *previous* release — which is the baseline
   `.pi/skills/update-changelog/` reads, so the next release re-reads work that
   already shipped. It never stops being necessary on its own: every release
   mints a fresh merge commit that `dev` does not otherwise contain. (This step
   was missing through v1.2.0; v1.1.1 and v1.2.0 each needed a manual
   catch-up.)

Versions are git tags. This repository is not published to npm — it is
`private` and consumes no npm packages, but it IS consumable as a pi package:
`package.json` carries a `pi` manifest listing the extension entry points and
skills, which is what makes `pi install git:github.com/RRiboulet/my-agent-setup`
work in another project.

## Extensions

Pi extensions live in `./.pi/extensions` and skills in `./.pi/skills`. When
working in this repo, add or update them there.

Codemode is enabled for this repo (see `.pi/settings.json`: `defaultTools`
includes `+codemode`, `codemode.mode` is `on`). Prefer codemode to batch
independent tool calls, run several calls in parallel, and filter large
output before it reaches the model; use the direct tools (`read`, `edit`,
`write`, `bash`) for one-off, single-step work where a script adds no value.
(`.pi/settings.json` is gitignored on `dev` by design; committed updates
require `git add -f`.)

Adding a new extension or skill means adding it to the `pi` manifest in
`package.json` as well: it lives in a dot-prefixed directory, which package
discovery will not glob, so an unlisted extension installs nowhere.
`test/package-manifest.test.ts` fails if the manifest and the tree disagree.

Install this repo where you run `pi` from it **as a local path**
(`pi install /path/to/my-agent-setup`), never as
`git:github.com/RRiboulet/my-agent-setup`: project discovery and an installed
package both find `.pi/extensions`, so the git form loads every extension twice
and pi aborts startup on the duplicate tools. The devcontainer already runs its
own package-free agent dir on a private volume for this reason. Details and the
symptom are in the README section "One copy of the extensions, never two".

Other projects on this host do the opposite, deliberately: their images bake
this repo at a pinned tag under `/opt/pi-packages/my-agent-setup`, and their
`postCreate` points the container's own agent settings at that path. The tag is
recorded in that project's `.devcontainer/pi-agent-setup.version`, mirrored by
the Dockerfile's `PI_AGENT_SETUP_TAG`, and exposed to the running container as
`PI_AGENT_SETUP_TAG`, the image label `org.rriboulet.pi-package`, and
`/opt/pi-packages/my-agent-setup/.pi-agent-setup-tag`. Each project owns the
check that fails when its pin drifts; `my-agent-setup` itself never carries a
package in its container.

Linked worktrees for independent tasks live under `.worktrees/` at the repo root (see `.pi/skills/worktree/`); that directory is gitignored and shared refs mean branch names must be unique across worktrees.

You can consult pi for reference — the installed `@earendil-works/pi-coding-agent`
docs at `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/` are the
source of truth for the API this code targets — but do not modify pi itself.

## Coding skills

Twelve skills adapted from
[RRiboulet/agent-coding-skills](https://github.com/RRiboulet/agent-coding-skills)
cover the coding loop and now live here as ours: they carry this repo's rules in
their bodies, and `licenses/NOTICE.md` records the MIT provenance. They are
advertised by their descriptions, so load one when its trigger applies rather
than waiting to be told:

- Trivial, unambiguous edit — no behavior observable at a seam (typo, comment,
  private rename, dependency bump, release note): make it, then check it. No
  ceremony. Where that boundary falls is a judgement, not a rule: no check can
  decide it, so it is prose and not a row in the table below.
- Non-trivial or ambiguous request: `in-your-own-words` before building.
- The user asks to be grilled, stress-tested or interviewed, or a request's
  shape is undecided and a ten-line playback cannot carry its assumptions:
  `grilling`. It is the full design-tree interview in rounds; the cheap playback
  stays the default.
- A change crossing a module, service, API, schema or config boundary:
  `blast-radius`.
- A bug, failing test, CI failure, crash, flake or regression: `diagnosing-bugs`.
- Any new or changed behavior — the default implementation style: `tdd`. For a
  bug, `diagnosing-bugs` first. A rename, comment, typo or release note is not
  behavior: skip `tdd` there, as `tdd`'s own description says.
- Retries, queues, webhooks, jobs, migrations or setup scripts:
  `idempotent-operations`.
- Producing or acting on a performance number: `benchmark-checklist`.
- A **big task left unsupervised for a long time** — hours of work the user did
  not watch and will judge afterwards: `show-me-your-work`. Not for ordinary
  sessions.
- Before saying work is done: `prove-it-works`. It asks for one thing no gate
  can: **name the test that fails when this change is reverted.** Revert the
  behavior in one edit, watch that test fail, restore, re-run. If no test can
  fail, the change is `not_run`, never `passed`.
- The same mistake class corrected a second time, or a review that calls a fix a
  repeat: `prevent-recurrence`. It chooses the highest level that can carry the
  rule, proves it at the bad and good revision, and records the row; it does not
  commission another review.
- Writing or editing a skill, or changing a rule or pointer in `AGENTS.md`:
  `writing-for-agents`.

Only the user starts the five user-invoked entry points, which pi spells
`/skill:<name>`: `/skill:to-spec`, `/skill:to-tickets`, `/skill:implement`,
`/skill:handoff`, `/skill:teach`. Suggest them when they fit; never start them
yourself.

`grilling`, `teach` and `writing-for-agents` are ported straight from
[mattpocock/skills](https://github.com/mattpocock/skills) rather than through that
stack, and `licenses/NOTICE.md` records them separately. `grilling` therefore
sits in the trigger list above although it is not one of the twelve adapted
skills. It is model-invoked (so it is advertised by its description, and
`/skill:grilling` still works). `teach` is user-invoked and stateful: it builds a
teaching workspace outside any project checkout — never in this one — and the
course is continued by starting a session in that directory and asking for the
next lesson, or by `/skill:handoff` out of the session you are in.

`writing-for-agents` is model-invoked too, and it is the rulebook for the prose
this repository and its projects hand to an agent: skill bodies and
descriptions, `AGENTS.md` bullets, and the pointers that reach a `references/`
file. Load it before writing or reshaping any of those, and before adding a
rule here. `references/skill-mechanics.md` covers the skill-specific part —
frontmatter, the model-invoked vs user-invoked choice, and router skills.

`prevent-recurrence` is ours: the correction-to-check loop, the ordered ladder,
the rule table, the ratchet and "the diagnostic names the fix" come from pstack's
`/correct`; the judgment boundary — when a lesson cannot be encoded, make the
instruction more prominent and show the failure mode — comes from
`principle-encode-lessons-in-structure`. The static checker for the table and
the lint-locality test are added here. It is model-invoked because a repeated
correction is something the agent can notice, and `/skill:prevent-recurrence`
still works. Its Python recipes are in `references/python.md`. It ends at the
check, the proof and the row; committing and reviewing stay with the existing
skills and the review policy below.

Three repo rules win over those skill bodies, and the skills say so in place:

- **Commits** follow the `commit` skill (branch and base checks), not
  `implement`'s looser "commit on the current branch".
- **Worktrees** live under `.worktrees/` per the `worktree` skill.
- **Reviews** follow the next section: one per change, only when asked, and
  `prove-it-works` never starts one. `implement` therefore ends at proof, not at
  a review.

## Subagent tools

**A child may run inside a worktree, and on this host it must be told which agent
dir to use.** `bin/pi-agent-dir` has given this checkout a package-free agent dir of its own,
a sibling of the shared one (`bin/pi-agent-dir --print` names it). A child rooted in
`.worktrees/<slug>` inherits `PI_CODING_AGENT_DIR` from you, which is the *shared*
dir with this repo installed as a package — so pi loads both that package and the
worktree's own `.pi/`, and exits 1 on duplicate tool registration before any model
call:

```
Tool "update_goal" conflicts with .../.worktrees/<slug>/.pi/extensions/goal.ts
```

Pass the per-project dir instead, and the worktree's copy is the only one loaded —
which also means the child runs the branch's code and the branch's skills:

```bash
cd .worktrees/<slug> && PI_CODING_AGENT_DIR="$(bin/pi-agent-dir --print)" pi -p "<task>"
```

A launcher that bypasses a login shell gets no `~/.bashrc`, so the `--shell` hook
cannot pick the dir for it: run `bin/pi-wrapped` instead of `pi` there. It
resolves the same dir `bin/pi-agent-dir --print` names, forwards every argument
to `pi` unchanged and has no flags of its own, keeps a `PI_CODING_AGENT_DIR`
already set in the environment, and falls back to a plain `pi` with a note on
stderr outside a checkout or when the dir was never created. It does not create
the dir — `bin/pi-agent-dir` is the one-time step.

The `subagent` tool has no env argument, so for a child that must live in a
worktree, run it this way (or `pi --attach-subagent` into an existing session)
rather than through `subagent({ cwd })`. Launching with `cwd` = the main checkout
and `cd`-ing inside each command is the fallback: it starts, but it runs the main
checkout's extensions and skills, not the branch's — which is enough for file
edits and wrong for anything that tests the branch itself.

The six management tools — `subagent_wait`, `subagent_status`,
`subagent_cancel`, `subagent_interrupt`, `subagent_resume`, `subagent_clean` —
are **not declared** in this repo's sessions: `defaultTools: ["+tool_search"]` in
`~/.pi/agent/settings.json` puts them behind `tool_search` so their descriptions
and schemas stop riding along on every request (measured: ~890 tokens a
request). `subagent` itself stays declared.

So reach them in two steps:

1. `tool_search` for the tool you want.
2. Then call it, e.g. `subagent_status({ id })`.

Start, then wait once: `subagent_wait({ id })` blocks until the run settles and
returns its record — `subagent_wait({ ids })` waits for a whole fan-out, and a
timed-out wait returns the current state rather than an error. Keep
`subagent_status` for the live "what is it doing right now" question
(`subagent_status({ compact: true })` is the cheap one-line-per-run form, and
the single-run path is the one that returns output), not for collecting a result
you could have waited on.

## Reviews: one per change, and only when asked

There is **one** review pipeline, and it starts only on request. `prove-it-works`
is how the author proves and reports a change; it is not a review and it never
commissions one. Do not run a review because a change feels non-trivial, because
a skill suggested it, or because `/review` and `/triage` both exist.

When the user asks for a review, pick exactly one door:

- **`/review`** when they want to drive it interactively (PR, branch, commit,
  folder, uncommitted). `/review` appends `REVIEW_GUIDELINES.md`, which carries
  the Spec / Correctness / Standards method and this repo's rules.
- **`triage_change` (or `/triage`) and one sub-agent** when they want an
  independent read without staying in the loop. Triage is
  **recommendation-only**: it measures the diff, asks the judge, and returns a
  plan; it never launches anything.

Never do both for the same change, and never start a second reviewer because the
first found little. The sub-agent must not spawn further reviewers.

**Always ask the user before launching a review subagent**, even when triage
recommends one. A recommendation is not an instruction, and a question that
merely *sounds* like it invites a review is not approval either: starting a
reviewer spends real tokens and runs an independent process, so it is the user's
call every time. Propose the lens and model, then wait for a yes.

When the user does approve one, the reviewer's `provider`, `model` and
`thinking` come from the `candidates` in the effective review-triage policy —
the built-in defaults, or `~/.pi/agent/review-triage.json` when that file
exists. Never hand-pick a model outside that list: if a lens needs a model the
config lacks, add it to the config first. Which model sits in which capability
band is a human judgement, not the agent's.

Every candidate must name `opencode-go`, the provider this machine actually
authenticates; the judge is the only model on another provider (`opencode`,
OpenCode Zen, for the free `jev-1.13-free` classifier — same `OPENCODE_API_KEY`).
The policy is built into `.pi/extensions/review-triage/config.ts`, so installing
the package is enough, and the same policy is written out for editing as
`.pi/extensions/review-triage/review-triage.example.json`; a test fails if a
candidate's provider or stated cost drifts, and another fails if the example and
the built-in defaults diverge. Whether a machine has a provider's credential is
checked at run time (`credentials.ts`), not assumed: a missing reviewer provider
drops its bands and names the provider, models and fix in the plan, and a missing
judge provider short-circuits the call as `judgeFailure: unavailable`. The plan
therefore never names a model this machine cannot run without saying why.

A `show-me-your-work` trail does not get its own reviewer. If a review is
commissioned, hand the trail to that one reviewer alongside the diff.

## Rules and enforcement

| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| A branch descends from origin/dev and carries only its own commits | test | `node tools/branch-base.mjs` | `tools/branch-base.test.mjs` |

One row per rule, and the row names what fails when the rule is broken. This
table is the single source of truth: no separate registry, and prose in this file
is a rule only once a row here enforces it. The checker validates the shape —
the four columns, an allowed level, a non-empty enforcer, a proof that exists,
no duplicate rule, no prose row without `judgment: <reason>`:

```bash
node .pi/skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
```

The branch row is the dogfood rule earned by the three recorded misses under
"Branches" above: `tools/branch-base.mjs` fetches `origin/dev` and classifies the
branch, `tools/branch-base.test.mjs` builds the fixture repositories, and both
run in `prove-it-works` and in CI. Its five classifications (`correct`,
`superseded`, `behind-dev`, `foreign-commits`, `wrong-base`) are documented in
the script's header. The table format and the checker's `--json` contract are in
`.pi/skills/prevent-recurrence/references/rule-table.md`.

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

Green is necessary, not sufficient: a gate proves the suite passes, not that it
covers what you changed. Before reporting a behavior change as done, revert it in
one edit and confirm the test that covers it goes red; restore and re-run. Report
the test that failed. Measured on one task: the check appeared only in runs that
had read `prove-it-works`, and a model that never opens a skill body never
performed it. So it is written here, in context every turn, as well as in that
skill.

Run it with `bash` (or `sh`), not as `./setup-deps.sh` — see "Line endings"
below. Node runs the TypeScript directly; there is no build step. See
`.pi/extensions/subagent/test/README.md` for what is and is not covered.

**`--test-concurrency=8` is not optional.** Node defaults the file concurrency to
`availableParallelism() - 1`, which is **1** on this 2-core host, so the
"parallel" runner was running one file at a time: 184 s of wall clock for 67 s of
CPU (36 %), which says the suite is wait-bound, not CPU-bound. Measured
2026-11-16: 119-132 s with the flag at 8, and no further gain at 16 (132 s), so
the number is fixed rather than derived from `nproc`.

Raising it also exposed two tests that had only ever passed because nothing ran
beside them, both fixed here: a `btw` viewer test that waited 8 s for a spawned
`node` process to render (now 30 s), and a widget ticker that needed two 20 ms
ticks inside 120 ms (now 500 ms). Both now assert the behaviour rather than the
machine, which is the rule `helpers.ts` already states for its own poll bound. If
you raise the concurrency and see a red run, suspect a missing or tight wait
before you suspect the code.

#### One heavy thing at a time on this host

`cat /proc/loadavg` and `ps` before you time anything, and record the load average
beside every number you keep. This host has 2 vCPUs and more than one agent
session runs on it, so a benchmark grid, another session's suite or a `devc` call
will take the load from 0.4 to 33 — and a measurement taken in that window is a
measurement of someone else's work. It cuts both ways: a grid started while
another session is timing makes *its* numbers meaningless, which is worse than
being slow, because each side then spends an hour triaging a "flake" that was
contention.

Two rules follow. **Never compare two timings taken at different loads** — re-run
the pair, or say the comparison cannot be made. And when the suite goes red under
load, **run the failing file alone before calling it a bug**: every red we have had
under contention was a wall-clock bound in a test rather than the code it tests —
a viewer waiting on a spawned `node` process, a 20 ms ticker needing two ticks, a
widget row read one ticker before it refreshed itself. Those bounds are widened
now, but the lesson is general: suspect a missing or too-tight wait first, and
check the load average before you suspect the product.

#### Typechecking: deliberately none

There is no `tsconfig.json` and no `tsc` in the tree, and this is on purpose.
`node --test` strips types without checking them, so a type error can survive
the suite — a known, accepted cost. Adding a typechecker would mean pulling in
the repo's first npm compiler dependency (it consumes no npm packages) and
reconciling a documented asymmetry: `todos.ts` uses TypeScript parameter
properties that node's strip-only loader rejects while pi's jiti loader
accepts, and the `erasableSyntaxOnly` setting that would resolve that is one
the files do not currently satisfy. The bug class a typechecker catches — a
bare identifier used as if it existed, a `HarnessOptions` field the factory
reads but no caller sets — is exactly what the P1/P2 audit fixed and pinned
with tests, so the residual risk is covered by the suite's load guards.
Decision recorded 2026-10-05 (TODO-914d99f8): not adopting a typecheck step.

## Line endings

`.gitattributes` sets `* text=auto eol=lf`, so git *normalizes* CRLF away on
comparison. Two consequences that `git status` cannot surface:

- A file whose blob is LF may still be **CRLF in your working tree** if it was
  checked out before `.gitattributes` existed. It shows as clean, yet bash
  fails on it (`$'\r': command not found`, `set: pipefail: invalid option`).
- `git add` does not fix an already-CRLF blob retroactively for files the
  attribute did not apply to when they were first committed.

If a shell script fails inexplicably, check it before trusting `git status`:

```bash
grep -qU $'\r' <file> && echo "CRLF in working tree"
```

Repair the whole tree with:

```bash
git add --renormalize .
git ls-files -z | xargs -0 rm -f && git checkout-index -a -f   # re-checkout applies eol=lf
```

Keep shell files LF. The devcontainer bakes them in verbatim, and a trailing
`\r` ends up inside sourced paths (`~/.aliases.zsh^M`).