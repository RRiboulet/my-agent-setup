---
name: prove-it-works
description: "Prove a code change works before claiming it is done: verify against the real artifact rather than a proxy, run the repository's quality gate, check the final diff for scope and hygiene, and report evidence with honest check statuses. Use when: finishing any coding task, before committing or opening a PR, after addressing review feedback, or when asked to validate, verify, or check changes."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Prove it works

"It compiles" or "the tests I wrote pass" is not proof. Verify the real thing directly, then report evidence rather than confidence.

## 1. Check the real thing

- Exercise the changed behavior the way a user or caller would: run the CLI, call the endpoint, run the function on a realistic input, or read the actual output, file, row, or value.
- Do not infer success from proxies such as file timestamps, a log line saying "done", a cached screenshot, or another agent's summary.
- When a check fails, suspect the observation method before the system: the right process, port, environment, and build?
- Prefer a small script that re-runs the comparison to a one-time eyeball, and keep its output so a reviewer can re-run it.

## 2. Find the quality gate

- The project's own instructions come first. Use the commands its instruction file names (`AGENTS.md`, or whatever this harness reads), and say which file you took them from.
- If the repository has `.agent/quality.yaml`, that is a pinned contract: run its checks as written. See [assets/quality.example.yaml](assets/quality.example.yaml) for the format.
- Otherwise use the checks the repository itself defines: CI workflows, `Makefile` or task-runner targets, package scripts, `pyproject.toml`, and contributing docs.
- A check that is not configured is "not configured". Never substitute a tool the project does not use and report it under that check's name.

In this repository the contract is `AGENTS.md` → **Tests**: the subagent suite
(`node --test .pi/extensions/subagent/test/*.test.ts`, after
`bash .pi/extensions/subagent/test/setup-deps.sh`) and, when
`.pi/extensions/opencode-go-provider/` changed, its own separate
`node --test` run. There is no `.agent/quality.yaml`, and AGENTS.md is where
those commands come from.

## 3. Run it

- While iterating, run the narrowest relevant checks: focused tests, and lint or type checks on the changed files.
- After the last edit, run the full gate plus every required check it does not cover. Any later edit makes earlier results stale.
- On failure, fix the root cause (load the `diagnosing-bugs` skill if it is not obvious) and re-run the affected checks.
- Classify each failure as caused by the change, pre-existing, or environmental. When unsure, check the base revision in a separate worktree; never stash or discard the user's work to find out. Pre-existing failures are reported, never hidden, and never excuse a new regression.
- Never delete, skip, or weaken a valid test, lower a threshold, or add a suppression to get green.

## 4. Check the final diff — hygiene, not a review

Inspect `git status` and `git diff`, including untracked files:

- Every requirement in the spec or playback is met, and nothing unrequested slipped in.
- No secrets, `.env` content, debug output, temporary files, stray binaries, or generated artifacts unless intended.
- No formatting churn outside touched code; lockfile changes only for intended dependency changes.
- Tests and docs changed where behavior changed.
- Public interfaces, configuration, persisted data, and error paths stay compatible unless the change was meant to break them.

This is the author checking their own work. It is not an independent review, and
this skill never starts one: no reviewer, no review sub-agent, no `/triage` run
unless the user asked for a review. When an independent review does happen it is
one step with one reviewer — `/review` if the user wants to drive it, otherwise
`triage_change` for a routed sub-agent, and never both. The rubric either one
follows is `REVIEW_GUIDELINES.md`.

## 5. Report

Keep it proportional to the change. Each status means exactly this: `passed` ran and succeeded after the last relevant edit; `failed` ran and failed; `not_run` exists but was not run, with the reason; `unavailable` could not run in this environment or is not configured.

```text
Outcome: <what now works, in the user's terms>
Evidence:
- <claim>: <command, test, or observation> → <result>
Checks:
- <name>: passed | failed | not_run | unavailable (<one-line detail>)
Not verified: <what was not demonstrated, and why>
Risks: <untested conditions, environment limits, pre-existing failures, follow-ups>
```

Never call the result bug-free. Say what was demonstrated and what remains a risk.
