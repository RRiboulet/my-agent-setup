# Add a `grilling` skill with cheap fact-finding sub-agents

## Objective
We sometimes want a plan, design, or decision stress-tested by a structured,
multi-round interview, not just the single playback `in-your-own-words` gives.
Matt Pocock's `grilling` skill does this. Its expensive part is looking up facts
(code, config, tooling) between rounds. A cheap model can do that in a fresh
context while the main model keeps asking the questions. In our Copilot CLI
setup, that cheap model is DeepSeek.

## Current behavior
- `grilling` is listed under "Deliberately left out" in `README.md`. The reason
  given is that `in-your-own-words` covers the everyday need.
- `in-your-own-words` already borrows grilling's "facts are yours, decisions are
  the user's" and "recommend an answer" rules. It does not do multi-round design
  trees.
- Upstream `skills/productivity/grilling/SKILL.md` and `agents/openai.yaml` are
  identical at our pinned commit `4ae2317` and at upstream `main` (checked
  2026-11-17). No pin bump is needed.
- Copilot CLI: `/subagents` already maps the read-only `explore` agent to
  `dbx/model_service.models.1adp-deepseek-4-1-flash`.

## Required behavior
1. A skill `skills/grilling` exists. The user can start it by name
   (`/grilling`, `$grilling` in Codex, `/skill:grilling` in pi), and the agent
   can start it when its triggers apply:
   - the user asks to grill or stress-test a plan, or
   - a plan has several interdependent open decisions.

   A self-started session says why in one line and lets the user decline. It
   never starts when no one is there to answer.
2. It follows upstream's method: a design tree, rounds that ask the whole
   frontier, numbered questions with a recommended answer each, worded so "yes"
   accepts the recommendation, and done only when the frontier is empty and the
   user confirms shared understanding. Nothing is acted on before that.
3. **Every** fact lookup, however small, goes to a **read-only exploration
   sub-agent with fresh context**. The main agent does not read, search, or
   run commands itself while grilling. It looks facts up itself only when the
   harness has no sub-agents. It asks only the questions
   downstream of that lookup to wait, and asks the rest of the frontier now.
4. Each fact-finding sub-agent gets a short, fixed brief so a small model stays
   reliable:
   - one question
   - where to look
   - read-only, no edits
   - return facts with evidence (`path:line`, a command and its output, or a URL)
   - say "not found" rather than guess
   - make no recommendations
   - stop when answered
5. The skill body names no model or vendor. The harness picks the model
   (Copilot: `/subagents`, `explore` → DeepSeek). By your decision at
   implementation time, the body does name the conventional exploration agent
   ("often named Explore or `explore`"), so lookups reliably go to the cheap
   agent. This is a deliberate exception to the README rule against naming
   harness tools.
6. The routing snippet has a trigger line for `grilling`, and
   `in-your-own-words` escalates to it when its risky assumptions depend on
   each other.

## Non-goals
- No harness-specific custom agent file (such as a Copilot `.agent.md` with a
  model pinned in its frontmatter) shipped in this repository.
- Not porting `grill-me` or `grill-with-docs` (the latter needs CONTEXT.md and
  the ADR workflow).
- No change to how other skills use sub-agents.

## Constraints
- Repository conventions in `README.md`, enforced by `scripts/validate.py`:
  - Frontmatter has only `name` and `description`.
  - The description says what the skill does, then `Use when:` with concrete
    triggers.
  - `agents/openai.yaml` sets no implicit-invocation policy.
  - No banned harness-specific names in the body.
  - `README.md` and `instructions/AGENTS.md` must mention `` `grilling` ``.
  - The body stays under 500 lines.
- MIT attribution: add a provenance row to `NOTICE.md`. `licenses/` is
  protected and already holds Matt's license.
- The installed snippet in `~/.copilot/copilot-instructions.md` sits between
  markers and is refreshed only by `scripts/install.sh --instructions`, never
  hand-edited.

## Design decisions
- **Model-invoked, so both the user and the agent can start it** (revised
  2026-11-17; first implemented as user-only).
  - The triggers are broader than upstream's "grill" phrases: they also fire
    when a plan has interdependent open decisions.
  - `in-your-own-words` stays the everyday default and escalates only in that
    case.
  - Guard against unwanted long interviews: a self-started session states its
    reason, the user can decline, and it never runs unattended.
  - Rejected: user-only `/grilling`, because the agent could never reach for it.
- **Model choice lives in harness config, not in the skill.** This keeps the
  skill portable across Codex, pi, Claude Code, and the other harnesses.
  `docs/harnesses.md` gets a short section, "Sending sub-agents to a cheaper
  model". It covers Copilot `/subagents` (`subagents.agents` in
  `settings.json`, with `explore` as the read-only fact-finder) and points other
  harnesses to their own docs. Rejected: shipping a Copilot custom agent file
  with a pinned model.
- **Fact-finder brief inside the skill.** This is the only material addition
  over upstream. It costs a few lines and makes delegation to small models
  predictable. Put it in `SKILL.md` unless it exceeds about 15 lines, then move
  it to `references/fact-finder.md`.
- **Documentation updates:**
  - `README.md`: add a row to the Skills table, move `grilling` out of
    "Deliberately left out" (keep `grill-me`), and add it to the flow diagram
    as an optional step before `/to-spec`.
  - `NOTICE.md`: add a provenance row.
  - `docs/harnesses.md`: add the model section.

## Test seams
- `scripts/validate.py` is the existing structural seam. It already covers
  frontmatter, openai.yaml policy, snippet and README coverage, banned names, and
  links. No new test code is needed.
- `scripts/test.sh` exercises install, uninstall, and the snippet. Its fixtures
  name skills explicitly, so a new skill needs no test changes. Confirm by
  running it.
- Behavior is checked with one live Copilot CLI session (see Verification).
  That is the real artifact. Validator checks are only a proxy.

## Acceptance criteria
- [ ] `skills/grilling/SKILL.md` and `skills/grilling/agents/openai.yaml` exist
      and follow every convention above (behaviors 1, 2, 5).
- [ ] The body contains the sub-agent fallback wording and the fact-finder brief
      (behaviors 3, 4).
- [ ] `instructions/AGENTS.md` has a `grilling` trigger line and `in-your-own-words` escalates to it
      (behavior 6).
- [ ] `README.md`, `NOTICE.md`, and `docs/harnesses.md` are updated as described.
- [ ] `python3 scripts/validate.py && scripts/test.sh` pass.
- [ ] After `scripts/install.sh --target ~/.copilot/skills --instructions
      ~/.copilot/copilot-instructions.md`, `/skills list` in Copilot CLI shows
      `grilling`.
- [ ] In a live `/grilling` session on a real plan that needs at least one
      repository fact:
      - rounds are numbered with recommendations
      - at least one fact lookup runs as an `explore` sub-agent
      - the session usage shows the DeepSeek model for it
      - no edits happen before you confirm

## Verification
1. `python3 scripts/validate.py && scripts/test.sh` (the repository's
   `final_gate`).
2. `scripts/install.sh --dry-run --target ~/.copilot/skills` to preview, then
   install for real and re-run with `--instructions
   ~/.copilot/copilot-instructions.md`.
3. In Copilot CLI: `/skills reload` and `/skills list`, then
   `/grilling <a plan from leitstand>`.
4. Confirm the model with `/tasks` during the session or the session usage
   records afterwards (`session_usage.usage_model` for that session includes the
   DeepSeek model).

## Open assumptions
- The agent self-starts grilling too often. Risk: low to medium. The triggers are
  narrow, the user can decline, and the skill never runs unattended. If it gets
  noisy, narrow the trigger or revert to user-only.
- The main agent will choose `explore` for fact lookups when the skill says
  "read-only sub-agent with fresh context". Risk: medium. If it picks
  `general-purpose` (Opus) instead, the cost saving is lost. Resolved: the skill
  names the exploration agent (see behavior 5). Verified in a live Copilot CLI
  run on 2026-11-17: both lookups ran as `explore` on DeepSeek flash.
- DeepSeek flash is good enough for fact lookups with `path:line` evidence. Risk:
  low. The brief demands evidence, and the main model can reject unsupported
  answers.
