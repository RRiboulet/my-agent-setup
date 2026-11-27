---
name: prove-it-works
description: "Prove a change works before claiming done: verify the real artifact, run the quality gate, inspect the diff, and report evidence. Use when: finishing a coding task, before committing or opening a PR, or asked to verify changes."
---

# Prove it works

"It compiles" or "the tests I wrote pass" is not proof. Verify the real thing directly, then report evidence rather than confidence.

## 1. Check the real thing

- Exercise the changed behavior the way a user or caller would: run the CLI, call the endpoint, run the function on a realistic input, or read the actual output, file, row, or value.
- Do not infer success from proxies such as file timestamps, a log line saying "done", a cached screenshot, or another agent's summary.
- When a check fails, suspect the observation method before the system: the right process, port, environment, and build?
- Prefer a small script that re-runs the comparison to a one-time eyeball, and keep its output so a reviewer can re-run it.

## 2. Find the quality gate

- If the repository has `.agent/quality.yaml` (or a path its instructions name), it is the contract: run its checks as written. See [assets/quality.example.yaml](assets/quality.example.yaml) for the format.
- Follow the repository's own instruction files (`AGENTS.md` or whatever this harness reads) and say which file you took the commands from.
- Otherwise use the checks the repository itself defines: CI workflows, `Makefile` or task-runner targets, package scripts, `pyproject.toml`, and contributing docs. Say where you found them.
- A check that is not configured is "not configured". Never substitute a tool the project does not use and report it under that check's name.
- When the change adds or updates an enforced rule in `AGENTS.md`, load the `prevent-recurrence` skill and run its checker as part of the gate.

## 3. Run it

- While iterating, run the narrowest relevant checks: focused tests, and lint or type checks on the changed files.
- After the last edit, run the full gate plus every required check it does not cover. Any later edit makes earlier results stale.
- On failure, fix the root cause (load the `diagnosing-bugs` skill if it is not obvious) and re-run the affected checks.
- Classify each failure as caused by the change, pre-existing, or environmental. When unsure, check the base revision in a separate worktree; never stash or discard the user's work to find out. Pre-existing failures are reported, never hidden, and never excuse a new regression.
- Never delete, skip, or weaken a valid test, lower a threshold, or add a suppression to get green.
- **Prove the change is covered, not just green.** For behavioral changes, confirm the covering test can actually fail when the new behavior is reverted or absent, then restore and re-run; report the test name and failure. A change with no test that can fail is `not_run` with the reason, never `passed`.

## 4. Review the final diff — hygiene, not an independent review

Inspect `git status` and `git diff`, including untracked files:

- Every requirement in the spec or playback is met, and nothing unrequested slipped in.
- No secrets, `.env` content, debug output, temporary files, stray binaries, or generated artifacts unless intended.
- No formatting churn outside touched code; lockfile changes only for intended dependency changes.
- Tests and docs changed where behavior changed.
- Public interfaces, configuration, persisted data, and error paths stay compatible unless the change was meant to break them.

This is the author's hygiene check, not an independent review; if an independent review is needed, load the `review-change` skill separately.

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
