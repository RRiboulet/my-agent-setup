# 05: 23 skills become ~15, and the long ones stop being read whole

**Blocked by:** 00 (per-skill load and context-token baseline)
**Status:** ready
Evidence: `docs/research/2026-11-harness-advancements.md#5-skills-prune-merge-split-ticket-05`

## What to build

23 skills, 2,887 body lines, and **33 explicit loads across 108 sessions**. The
system prompt carries only each skill's name, description and path (~6 KB);
the bodies load on demand. The dormancy is still not harmless: every skill is a
routing candidate the model must reject, and the longest are longer than most
files the agent reads in a turn.

Three moves, all measured:

1. **Prune.** A skill with no load and no workflow reference goes. Keep
   `commit`, `devcontainer`, `worktree`, `github`, `tmux`, `tdd`,
   `diagnosing-bugs`, `prove-it-works`, `blast-radius`, `benchmark-checklist`,
   `update-changelog`, `native-web-search`, `librarian`, `handoff`; decide the
   rest from the load data.
2. **Merge.** The model-invoked planning members — `in-your-own-words`,
   `grilling` — overlap at the trigger level. One router skill ("shape a change
   before building it") with the bodies as `references/`, entered by the
   router's decision table. `grilling` stays directly invocable and
   model-invoked, because it is a mode, not a phase. The user-invoked entry
   points (`implement`, `to-spec`, `to-tickets`) **cannot** be absorbed: they
   are pinned by `coding-skills.test.ts`'s `USER_INVOKED` rule and deliberately
   hidden from model selection, so they stay as thin wrappers that point at the
   router's references.
3. **Split.** `worktree` (623 lines) and `add-model` (327) move their worked
   examples, recipes, and tables into `references/`; the SKILL.md keeps the
   decision rules and the safety rails, under 150 lines.

## Scope

Owns (`.pi/skills/`, `package.json`'s `pi.skills`, and the skill tests):

- The consolidated skill list, with no two descriptions competing for the same
  trigger; the router's table names which reference to load. The
  `coding-skills.test.ts` classification lists (`ALL`, `USER_INVOKED`) and
  `package.json`'s `pi.skills` are updated together; a removed skill's notice in
  `licenses/NOTICE.md` goes with it.
- `references/` files for `worktree`, `add-model`, and the merged planning
  skill; every path the SKILL.md mentions must resolve.
- `package.json` and any `licenses/NOTICE.md` entries for vendored material; a
  removed skill takes its notice with it.
- Update `AGENTS.md` where it names a skill by path.

Does not own: the extension changes in tickets 01–04, or new skills for the
capabilities deferred to the later band.

## Acceptance criteria

- [ ] The advertised skill count is ~15, and no two SKILL.md descriptions share a trigger phrase.
- [ ] `worktree/SKILL.md` and `add-model/SKILL.md` are each under 150 lines, with their recipes and tables in `references/` and every referenced path resolving.
- [ ] The planning router has a decision table; `/skill:grilling` still works directly, and `implement`/`to-spec`/`to-tickets` remain user-invoked (`disable-model-invocation: true`) and pass the classification test.
- [ ] `node --test .pi/extensions/subagent/test/coding-skills.test.ts` passes, and `package.json` lists exactly the directories that exist.
- [ ] The ticket-00 per-skill load data names at least one pruned skill with zero loads; a skill with a load is not pruned without saying why.

## Validation

- Count the description bytes that enter the system prompt before and after.
- Ask the model to route five representative prompts (a bug, a plan, a commit,
  a worktree, a model fix) and record which skill it picks; no prompt may match
  two skills equally.
