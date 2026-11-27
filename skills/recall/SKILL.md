---
name: recall
description: "User-invoked /recall (pi: /skill:recall): rebuild working context from recent sessions, git, and PRs into a brief."
disable-model-invocation: true
---

# Recall

Rebuild working context across recent sessions and the repository's live state without relying on stale memory.

## 1. Lock the scope

- Default to the **active workspace** and the **last 7 days** unless the user specifies another timeframe, repository, or topic.
- State the exact scope and time window searched. Never silently turn "all" into a truncated recent slice.
- Two requests that are not this one: creating a handoff for a fresh session (use `/handoff`) and writing a spec or tickets (`/to-spec`, `/to-tickets`). If the user already handed over a verified state capsule, use it and skip session mining.

## 2. Gather evidence in parallel

Use read-only lightweight sub-agents in parallel (when available) to gather two independent views:

- **Session history** (skip sub-agent or scratch test noise; extract topic, goal, decisions made, open questions, blockers, and referenced PRs/commits/branches):
  - **pi:** scan `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/<safePath>/<ISO-timestamp>_<uuid>.jsonl` ordered by modification time (excluding the current session file), fanning out via `subagent` tasks with `role: "explore"` + `subagent_wait` (or reading directly for 1–2 sessions), and check active sibling sessions via `orchestrator_workspace` (`peers` action).
- **Live repo and tracker state:** run read-only checks on `git status`, `git branch -vv`, `git worktree list`, recent `git log --oneline`, and open, merged, or reverted PRs and issues (`gh` CLI or GitHub tracker tools). Report unauthenticated or unavailable tracker access rather than guessing.

## 3. Reconcile against reality

Session memories go stale quickly. Always verify status claims against current `git` and tracker output:

- Did a planned change actually merge, get reverted, or stay uncommitted on a branch/worktree?
- Are two worktrees or branches carrying conflicting attempts at the same fix?
- Did an open PR pick up new review comments or failing checks since the last session?
- Which recorded decisions were never implemented?

## 4. Output the brief

Keep the report tight and scannable, citing sources (session ID/path, PR/issue number, branch):

```text
Scope: <workspace/repo>, <date window>

## Capsule
- <up to 5 bullets summarizing current state>

## Threads
- <topic> — <one-line status> [<tag>]

## Recurring problems (only if any)
- <up to 5 bullets, including fixes that bounced or were reverted>

## Next move
- <one concrete recommended next step>
```

Assign each thread **exactly one** status tag: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`.
