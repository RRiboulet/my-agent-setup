# Workflow Schema

This document is a routing contract for doing work with the repository's skills
and extensions. It answers four questions:

1. What kind of work is this?
2. Which skill supplies the next discipline?
3. Which extension holds state, delegates work, or enforces a boundary?
4. What artifact proves the step is complete?

It is **descriptive**, not a new engine. The user request, `AGENTS.md`, skill
bodies, and extension implementation remain authoritative. This schema helps
choose among them; it does not replace them or add automatic reviews, goals, or
subagents.

## 1. The mental model

Use three layers:

| Layer | Question it answers | Examples |
|---|---|---|
| **Skills** | How should the agent reason about this step? | `in-your-own-words`, `architect`, `tdd`, `prove-it-works` |
| **Extensions** | What state, capability, coordination, or gate is available? | `todo`, `/goal`, `subagent`, `/orchestrate`, `/triage` |
| **Delivery** | Where does verified work land? | feature branch, PR into `dev`, release PR into `main`, tag |

A skill is a reusable procedure. An extension is a runtime capability. A Git
branch, PR, or tag is a delivery boundary. Do not use one layer to imitate another:
a todo is not a spec, a subagent is not an architecture decision, and a green test
suite is not an independent review.

### Universal lifecycle

```text
request
  -> recover context (only when resuming)
  -> frame goal, scope, done-when, and risks
  -> classify the work
       -> trivial: make the bounded edit
       -> ambiguous/high-risk: clarify and design
       -> several units: spec and ticket graph
  -> execute one verifiable unit at a time
  -> prove the real artifact and run the quality gate
  -> independent review (only if the user requests one)
  -> commit / PR (only as requested)
  -> release (only through the release workflow)
```

Side rails attach where their trigger applies: bug diagnosis, blast-radius
analysis, idempotent design, benchmarking, external research, containers, tmux,
and recurrence prevention. They are not mandatory sequential stages.

## 2. Workflow record schema

For non-trivial work, keep a lightweight workflow record in the conversation,
spec, or handoff. It need not become another file. These fields are the minimum
contract:

| Field | Meaning | Required when |
|---|---|---|
| `objective` | The user-visible problem and why it matters | Always |
| `done_when` | Observable result that permits completion | Always |
| `scope` | Included behavior and deliberately excluded behavior | Non-trivial work |
| `inputs` | Spec, ticket, issue, branch, logs, or conversation to read | Resuming or delegated work |
| `risks` | Assumptions that could change behavior, data, security, API, or scope | Non-trivial work |
| `route` | `trivial`, `bounded`, `design`, `project`, or `unattended` | Choosing a workflow |
| `overlays` | Bug, performance, migration, external research, environment, docs, release | When triggered |
| `units` | Ordered verifiable slices, with dependency edges for project work | More than one unit |
| `artifacts` | Specs, tickets, diffs, test output, reports, PRs | As produced |
| `gates` | Checks that must pass before the next transition | Before claiming progress |
| `delegation` | None, single child, fan-out, or dependency plan; scope and owner for each | When delegating |
| `stop_conditions` | Blockers, exhausted retries, unresolved decision, or abort condition | Long or delegated work |

Example:

```yaml
objective: "Make saved workflow filters survive reloads"
done_when: "A caller saves a filter, reloads, and observes the same filter"
scope:
  include: ["filter persistence", "reload behavior", "regression coverage"]
  exclude: ["filter sharing", "UI redesign"]
route: design
overlays: []
risks:
  - "Existing stored filters have no schema version"
units:
  - id: "01"
    outcome: "Read legacy and current filters without data loss"
    blocked_by: []
  - id: "02"
    outcome: "Persist and restore a newly saved filter"
    blocked_by: ["01"]
gates:
  - "Focused persistence test green"
  - "Repository quality gate green"
  - "Reverting the behavior makes its covering test fail"
delegation: none
stop_conditions:
  - "Storage compatibility cannot be decided from evidence"
```

The repository's machine-readable task contracts are the existing ones: todo
files, ticket frontmatter, goal session state, subagent run records, and wave
journal entries. Do not invent a parallel task database.

## 3. Choose the smallest sufficient route

Complexity has two independent axes:

- **Workflow size:** how many units, dependencies, contexts, and sessions are
  needed.
- **Risk:** how costly a wrong assumption or silent failure would be.

A one-line storage migration can be high risk. A ten-ticket documentation project
can be low risk. Route by both, not by line count alone.

| Route | Choose it when | Primary path | Extra control |
|---|---|---|---|
| **Trivial** | Typo, comment, private rename, dependency bump, or other unambiguous edit with no behavior seam | Edit directly; inspect the diff; run relevant checks | Skip playback, specs, tickets, and ceremony |
| **Bounded** | One clear behavior or fix in one context | `in-your-own-words` when needed → `tdd` or `diagnosing-bugs` → `prove-it-works` | Add `architect`/`blast-radius` if a boundary is involved |
| **Design** | Ambiguous requirements, competing abstractions, public contract, schema, concurrency, or cross-module change | Playback → `architect` → `blast-radius` → `/skill:to-spec` if the contract is large → `/skill:implement` | Resolve risky decisions before code |
| **Project** | Three or more units, real dependency edges, parallel work, or more than one context window | `/skill:to-spec` → `/skill:to-tickets` → `/skill:implement` **or** `/orchestrate <folder>` | Ticket graph, frontier execution, isolated writes, per-ticket proof |
| **Unattended** | The user explicitly wants one objective pursued across turns, possibly for hours | `/goal <objective>` → todos → `show-me-your-work` when a decision trail is warranted | Explicit stop conditions, usage budget if requested, periodic proof |

### Specialist overlays

An overlay modifies the route; it does not replace it.

| Trigger | Load | Effect |
|---|---|---|
| Failure, crash, flake, regression, unexplained slowness | `diagnosing-bugs` | Reproduce and confirm root cause before fixing |
| Module/service/API/schema/config boundary; persistence, cache, retries, concurrency | `blast-radius` | Enumerate consumers, compatibility, and failure modes |
| Retry, queue, webhook, job, command, setup script, migration | `idempotent-operations` | Design restart/replay convergence and its test |
| Benchmark, speedup, latency or regression claim | `benchmark-checklist` | Vet comparability, load, workload, and measurement |
| Same correction class happens twice | `prevent-recurrence` | Encode the lesson at the highest effective level |
| Remote repository used as reference | `librarian` | Cache a stable local reference checkout |
| Current external documentation or release facts needed | `native-web-search` / `web_search` | Research with sources; separate facts from assumptions |
| Persistent interactive CLI | `tmux` | Use an isolated socket instead of a one-shot shell |
| Devcontainer build, server, database, or host execution | `devcontainer` | Use the safe headless `devc` workflow |
| Model missing or misreported by the provider | `add-model` | Correct provider model metadata through its dedicated procedure |
| Skill, `AGENTS.md`, or agent-facing pointer document | `writing-for-agents` | Keep triggers, hierarchy, and completion criteria precise |
| Changelog or release preparation | `update-changelog` | Use the repository's release-note and retention rules |

## 4. Phase contracts

Each phase has an output and an exit condition. A phase is complete because its
artifact exists and is checkable, not because work "feels done."

| Phase | Actions and tools | Artifact | Exit condition |
|---|---|---|---|
| **Recover** | `/skill:recall`; git/gh state; `orchestrator_workspace peers` | Status brief with sources | Planned state is reconciled with live state |
| **Frame** | `in-your-own-words`; `grilling` only when the decision tree exceeds a short playback | Goal, done-when, scope, assumptions | Risky decisions are answered or explicitly blocked |
| **Shape** | `architect`; `blast-radius`; `idempotent-operations` when applicable | Design sketch and rejected alternative | One owner per state/behavior; compatibility is understood |
| **Contract** | `/skill:to-spec`; `/skill:to-tickets` for several units | Spec or ticket graph | Acceptance criteria and validation are observable |
| **Execute** | `/skill:implement`, or `/orchestrate` for a wave; `tdd`; focused checks | Verified diff and test evidence | Current unit is green; no unit starts on red |
| **Prove** | `prove-it-works`; real-artifact exercise; repository quality gate; revert check | Verification report | Every acceptance criterion has evidence or an honest `not_run` |
| **Review** | Only on request: `/review`, or triage plus one approved reviewer | One review result | Requested findings are addressed and re-proven |
| **Land** | `commit`; `github`; branch-base check; CI | Commit and/or PR | Requested delivery action is complete and checks are known |
| **Release** | `update-changelog`; release PR; merge; tag; fast-forward `dev` | Release PR, tag, synchronized branches | `main` and `dev` agree and the tag points at the release merge |

Two transitions are deliberately strict:

- **Execute → Prove:** all intended units exist, but success is not yet claimed.
- **Prove → Land:** evidence is current after the last relevant edit. A later edit
  makes earlier proof stale.

## 5. Route recipes

### A. Trivial edit

1. Confirm the edit is genuinely unambiguous and has no observable behavior seam.
2. Make the smallest edit.
3. Inspect the diff and run the relevant configured check.
4. Report the result without manufacturing a spec, todo, or review.

Use `prove-it-works` proportionally. A docs-only change with no behavior test uses
link/content validation and reports the behavior revert check as `not_run` with
that reason.

### B. Bounded behavior or bug

1. Play back goal, scope, and done-when if the request is not already precise.
2. For a bug, reproduce it and rank hypotheses before editing.
3. For new behavior, write one failing test at the highest useful public seam.
4. Make the smallest change that passes; widen to surrounding tests.
5. Exercise the real behavior and run the repository gate after the last edit.
6. Revert the behavior in one edit, watch the covering test fail, restore, and
   re-run. Report the test and observed failure.
7. Commit or open a PR only if asked.

### C. Design-heavy change

1. Resolve the goal with `in-your-own-words`; use `grilling` if many coupled
   decisions remain.
2. Load `architect` and sketch two genuinely different shapes.
3. Load `blast-radius` before settling a public contract or cross-boundary shape.
4. Record the chosen shape, why the alternative lost, and the load-bearing
   assumption.
5. Use `/skill:to-spec` when another session or reviewer needs a stable contract.
6. Use `/skill:implement` to build verifiable units, or create tickets if the
   work has expanded into a project.

### D. Bug or regression

1. Load `diagnosing-bugs` before changing code.
2. Establish the smallest reproducible feedback loop.
3. Separate cause from coincidence with ranked hypotheses and instrumentation.
4. Add a regression test that fails for the confirmed root cause.
5. Fix the root, widen checks, and use `prove-it-works`.
6. If the same mistake class has appeared twice, load `prevent-recurrence`.

### E. Ticket project

Choose one execution mode:

**Sequential implementation**

```text
/skill:to-spec
/skill:to-tickets
/skill:implement <ticket-folder>
```

The implementer reads the graph, works the frontier one ticket at a time, and
proves each unit. This is the default when parallel execution adds more
coordination than it saves.

**Tiered wave**

```text
/skill:to-tickets
/orchestrate <ticket-folder>
/orchestrate status
/orchestrate abort       # only when stopping the wave
```

The wave state machine is:

```text
pending -> triaged -> implementing -> reviewing (through configured tier)
        -> verifying -> ready_to_commit -> done
                                      \-> blocked
```

The parent owns triage, dispatch, gates, and serial commits. Implementers do not
commit. Ticket frontmatter is the graph contract; prose is for humans. The
bundled dispatch ladder is the model/tier policy, not a measure of workflow size.

A wave's reviewer/verifier gates are part of the wave the user explicitly
started. Do not add `/review` or a triage reviewer for the same change on top of
that pipeline.

### F. Long-running unattended objective

1. Start `/goal` only when the user explicitly asks for a long-running goal.
   Never infer one from an ordinary task.
2. Create todos for remaining work; a goal says where to go, todos say what is
   left.
3. Use `show-me-your-work` when hours of unattended decisions need an audit
   trail. Do not duplicate the todo list in the trail.
4. Recover after compaction from the goal, todos, live runs, and artifacts—not
   from memory alone.
5. Mark the goal complete only when the objective is actually achieved. Mark it
   blocked only after the strict repeated-blocker audit.
6. If the work becomes a ticket graph, use `/orchestrate`; if it becomes a
   cross-session teaching project, use `/skill:teach` in its separate workspace.

### G. Research, explanation, and environment work

| Need | Path |
|---|---|
| Understand an existing branch without checking it out | `/explore <path> [branch]` or `/explore <branch>:<path>` |
| Answer a side question without polluting the transcript | `/btw` in the TUI |
| Answer questions extracted from the last response | `/answer` or `ctrl+.` |
| Resume an idle session manually | `shift+alt+enter` sends `continue` |
| Current external facts | `native-web-search` skill plus `web_search` or `/web-search` |
| Repeated reference to a remote repository | `librarian`, then read the cached checkout |
| Multi-session learning project | `/skill:teach`; workspace stays outside the project checkout |
| Install optional MCP servers | `/mcp-catalogue`, then opt a trusted project in with `.pi/mcp.json` |
| Work inside a project container | `devcontainer` skill and `devc`; never the attaching form |

## 6. Extension map

Extensions supply capabilities; they do not decide that a capability is needed.

| Extension | Surface | Workflow role | Boundary |
|---|---|---|---|
| **Todos** | `todo`, `/todos` | Track remaining work, ownership, and closure | Not a spec or decision history |
| **Goal** | `/goal`, `get_goal`, `create_goal`, `update_goal` | Explicit multi-turn objective and budget state | Create only on explicit request; completion requires the real objective |
| **Subagent** | `subagent`, management tools, `--attach-subagent` | Isolated research, implementation, fan-out, dependency plans | Ask before parallel implementation; parent verifies results |
| **Orchestrator** | `/gate`, `/orchestrate`, `orchestrator_wave`, workspace tools, override | Settlement evidence, loop control, wave state, write coordination | This repo's ordinary gate is report-only; active waves still gate settlement |
| **Review triage** | `triage_change`, `/triage` | Classify review need and choose an approved profile | Recommendation only; launches no review |
| **Review** | `/review`, `/end-review` | One interactive independent review | Only when requested; never combine with triage review for the same change |
| **Repo explorer** | `/explore` | Read-only branch/file exploration | Not a checkout or edit mechanism |
| **Answer** | `/answer`, `ctrl+.` | Focused answers to extracted questions | Interaction aid, not task state |
| **BTW** | `/btw` | Cached-prefix side question in a separate panel | Question/answer stay out of the transcript |
| **Continue** | `shift+alt+enter` | Literal `continue` while idle | Does not steer a running agent |
| **Native web search** | `web_search`, `/web-search` | Current external research with sources | Not evidence that a local change works |
| **MCP catalogue** | `/mcp-catalogue` | Install disabled Figma/Playwright entries into the agent dir | Project opt-in and trust still required |
| **OpenCode Go provider** | `/model`, `/opencode-go-usage` | Model access, protocol compatibility, usage visibility | Infrastructure, not a workflow stage |

`codemode` and `tool_search` are harness capabilities configured in settings, not
additional extensions. Use codemode to batch independent calls and filter large
output; use direct tools for one-step work.

### State ownership

| State | Owner |
|---|---|
| Remaining actionable work | `todo` files |
| One long-running objective | Goal session state |
| Requirements and acceptance criteria | Spec |
| Dependency graph and per-ticket status | Ticket frontmatter plus wave state when orchestrated |
| Child execution and results | Subagent run/plan records |
| Active wave transitions | Orchestrator wave journal |
| Why an unattended decision was made | `show-me-your-work` trail |
| Fresh-session continuation | `/skill:handoff` document |
| Verification evidence | Test/command output and `prove-it-works` report |

## 7. Skill map

### User-invoked entry points

Only the user starts these, by typing `/skill:<name>`. A user-invoked skill may
load model-invoked skills; it does not silently start another user-invoked entry
point.

| Skill | Use at | Output |
|---|---|---|
| `recall` | Recover | Source-cited status brief reconciled with live state |
| `to-spec` | Contract | Spec with test seams and acceptance criteria |
| `to-tickets` | Decompose | Vertical-slice ticket graph with blocked-by edges |
| `implement` | Execute | Verified implementation in small units |
| `handoff` | Transfer | Fresh-session continuation document |
| `teach` | Learn | Stateful teaching workspace outside the project |

### Model-invoked disciplines

The agent loads these when their trigger matches; the user may also type them.

| Phase | Skills |
|---|---|
| Frame and shape | `in-your-own-words`, `grilling`, `architect`, `blast-radius` |
| Build and diagnose | `tdd`, `diagnosing-bugs`, `idempotent-operations` |
| Prove and improve | `prove-it-works`, `benchmark-checklist`, `prevent-recurrence` |
| Coordinate and record | `show-me-your-work`, `worktree`, `commit`, `github` |
| Research and environment | `native-web-search`, `librarian`, `tmux`, `devcontainer` |
| Specialized maintenance | `add-model`, `update-changelog`, `writing-for-agents` |

The generated skill index in `README.md` carries every trigger description. Keep
that index and the workflow tables here consistent when skills are added.

## 8. Delegation schema

Delegate a bounded question or implementation unit, not an undefined project.

| Shape | Use when | Wait pattern |
|---|---|---|
| Single child | One isolated research or implementation task | Start, then `subagent_wait({ id })` once |
| Fan-out | Independent slices that can run concurrently | Start `tasks`, then `subagent_wait({ ids })` |
| Dependency plan | Steps have real dependency edges | Start plan, then `subagent_wait({ plan })` |
| Resume | A finished child needs a follow-up in the same context | Cancel/finish any live child, then `subagent_resume` |

Before dispatch, specify:

- the exact input artifacts and working directory;
- the expected output and validation;
- files or directories the child owns;
- whether it may edit, commit, or only report;
- the skills it must load by reference;
- what the parent will verify independently.

For parallel writes, join the workspace, reserve paths, and use linked worktrees
under `.worktrees/` when branches must coexist. A child in a worktree needs the
per-checkout `PI_CODING_AGENT_DIR`; otherwise duplicate extension registration
can prevent startup. See `docs/harness/subagents.md`.

Start work and wait once. Use `subagent_status` for a live progress question, not
completion polling. A child's blocking decision question goes through
`subagent_answer` and requires human confirmation.

## 9. Gates and authority

| Gate | Trigger | Pass evidence | Authority |
|---|---|---|---|
| Acceptance | Unit or project completion | Observable criteria satisfied | Spec/ticket and user request |
| Focused tests | Each behavior unit | Relevant test green for the right reason | `tdd` / `diagnosing-bugs` |
| Coverage proof | Behavior change complete | Revert makes the covering test fail; restore passes | `prove-it-works` |
| Repository quality gate | After last relevant edit | Configured commands succeed | `AGENTS.md` and project config |
| Branch base | Before commit in this repo | `node tools/branch-base.mjs` exits 0 | `commit` skill |
| Wave review | Wave ticket at configured tier | Recorded pass, or escalation | `/orchestrate` policy |
| Wave verification | Wave implementation complete | Ticket validation passes with evidence | `/orchestrate` policy |
| Settlement | Session attempts to finish | Gate verdict allows settlement | `.pi/orchestrator.json` when trusted; active-wave gate otherwise |
| Independent review | User requests one | One reviewer's findings addressed | `/review` or triage + one approved subagent |
| CI | PR pushed | Required checks pass | GitHub |
| Release | `dev` to `main` | Release PR merged, tag pushed, `dev` fast-forwarded | `AGENTS.md` release workflow |

A configured settlement gate can block on open todos, repeated failures, loop
evidence, or its verification command. This repository commits no
`.pi/orchestrator.json`, so those checks are report-only here. Active wave
settlement and commit-order enforcement still apply during a wave.

An override is a recorded one-shot escape hatch, not proof. A cap or timeout that
fails open is not a pass. A missing credential or unavailable check is a reported
limitation, never fabricated success.

## 10. Review and delivery boundaries

### One review, only on request

`prove-it-works` is the author's verification, not a review. When the user asks
for a review, choose exactly one door:

1. `/review` for an interactive review; or
2. `triage_change` / `/triage`, then—after explicit approval—one subagent using
   the returned profile.

Never run both. Never commission a second reviewer because the first found
little. Pass any `show-me-your-work` trail to that same reviewer.

### Feature delivery

1. Start from `dev`; never commit directly to `dev` or branch from `main`.
2. Prove the change.
3. Run `node tools/branch-base.mjs` before committing.
4. Commit through the `commit` skill.
5. Push and open `gh pr create --base dev --fill` through the `github` skill.
6. When asked to merge, squash with `--delete-branch`, then fast-forward `dev`.

### Release delivery

Use `update-changelog` and the release workflow in `AGENTS.md`: release PR from
`dev` to `main`, non-squash merge without `--delete-branch`, annotated tag on the
merge commit, then fast-forward `dev` to `main`.

## 11. Worked examples

### Documentation typo

- Route: **trivial**.
- Skills: `prove-it-works` proportionally; `writing-for-agents` if the text is an
  agent-facing pointer.
- Extensions: none required.
- Gate: inspect diff and validate affected links/content.
- Delivery: only if asked.

### New persisted setting

- Route: **design**.
- Skills: `in-your-own-words` → `architect` → `blast-radius` →
  `idempotent-operations` if setup/retry is involved → `tdd` →
  `prove-it-works`.
- Extensions: `todo` only if several steps need tracking.
- Artifacts: design/spec if the contract is not obvious; migration and
  compatibility test; revert-proof evidence.
- Gate: old data remains readable, restart/replay converges, repository checks
  pass.

### Eight-ticket cross-module project

- Route: **project**.
- Skills: `/skill:to-spec` → `/skill:to-tickets`; each ticket references `tdd`
  and `prove-it-works`.
- Extensions: `/orchestrate <folder>` for tiered dispatch, workspace reservations,
  review/verify gates, and serial commits.
- Artifacts: one spec, eight ticket files, wave journal, child reports, per-ticket
  validation, closing report.
- Human decisions: approve graph and scope; approve any separate final review;
  authorize PR/release actions.
- Completion: every ticket is `done` or explicitly `blocked` with a reason; no
  half-landed ticket is reported as complete.

## 12. Failure modes to avoid

- **Ceremony inflation:** specs and tickets for a typo.
- **Risk inflation:** choosing a stronger model before identifying the actual
  failure mode.
- **State duplication:** copying todos into a decision log, or ticket status into
  an unowned side file.
- **Invisible delegation:** a child edits without a scope, validation contract, or
  parent verification.
- **Silent scope change:** implementing a different contract when the spec proves
  wrong instead of stopping and surfacing the conflict.
- **Review by habit:** treating non-triviality as permission to start a reviewer.
- **Goal by inference:** creating a persistent goal for an ordinary request.
- **Green-by-proxy:** reporting success from timestamps, summaries, or exit code
  zero without checking the real artifact and meaningful test output.
- **Tier confusion:** treating wave Tier 1/2/3 as the workflow route or as a
  universal risk score.
- **Delivery drift:** committing on `dev`, targeting `main` for a feature PR, or
  deleting `dev` during a release merge.

## 13. Maintaining this schema

When a skill or extension changes, update the smallest relevant table here and
its authoritative source. Keep these checks true:

- every `package.json` skill and extension entry has a role in this document;
- every command/tool name matches the implementation or README;
- the six user-invoked skills remain distinct from model-invoked disciplines;
- review, goal, branch, and release boundaries match `AGENTS.md`;
- no table becomes a second copy of model lists, provider prices, or test timing;
- links resolve and the generated README skill index remains current.

Authoritative references:

- `AGENTS.md` — repository rules, branch workflow, tests, and releases
- `README.md` — installation, extension surfaces, and generated skill index
- `docs/harness/skills.md` — skill provenance and repository overrides
- `docs/harness/extensions.md` — extension architecture and orchestration gates
- `docs/harness/subagents.md` — delegation access and worktree isolation
- `docs/harness/reviews.md` — single-review policy and approved candidates
- `docs/harness/branches.md` — branch-base verification
- `docs/harness/testing.md` — test concurrency, host load, and typecheck policy
