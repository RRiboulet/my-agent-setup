---
name: recall
description: "User-invoked /skill:recall: rebuild recent working context from session records and live repository state into a status brief."
disable-model-invocation: true
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Recall

Rebuild what happened across the last few sessions and hand back a brief of where the work actually stands. Run it before starting or resuming work; the user says "catch me up" and asks for it.

Three records answer three different questions: the session files say what was done and decided, the live repository and tracker say what is true now, and the workspace registry says who else is on it this minute. A brief built from one of them is a guess wearing the shape of a status.

## 1. Lock the scope

Default to the current workspace and the last 7 days; take the topic, window and repository the user names. State the scope back before searching, and say what range you actually searched — "all of it" quietly becoming the last week is the failure this step prevents.

Two requests that are not this one: a handoff document for a fresh session, which is what `/skill:handoff` is for, and a spec or ticket to build from. If the user already handed over a state capsule — paths, branch, the change — use it and skip the mining.

## 2. Mine the session records

Sessions live at `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/<safePath>/<ISO-timestamp>_<uuid>.jsonl`, one JSON entry per line. `<safePath>` is the session's working directory with its leading slash dropped and every `/`, `\` and `:` turned into `-`, wrapped in `--`: `/workspace` is `--workspace--`, and a linked worktree gets a directory of its own. Order files by modification time, never by the uuid, and leave out this session's own file and the noise (subagent runs, scratch and test sessions).

Fan out rather than reading the corpus here: `subagent` takes `tasks`, one step per slice — a time range, a worktree, a topic — with its own `cwd`, and `subagent_wait({ plan })` returns every step in order. Where the harness defers them, reach `subagent_wait` and `subagent_status` through `tool_search` first. Children read the transcripts and return one block per session: topic, the goal, decisions, open questions, blockers, and artifacts (branch, commit, PR, ticket), each citing its session file. The full transcript stays in the child's own session file — open one when a thread needs detail the summary cannot carry.

For one or two sessions, skip the fan-out and read them directly.

## 3. Check the live state

- `git status`, `git branch -vv`, `git worktree list`, and `git log --oneline` for the window.
- Open, merged and reverted pull requests and issues through `gh`, per the `github` skill. Unauthenticated `gh` is a null result to report, not a gap to fill by guessing.
- `orchestrator_workspace` action `peers` lists the other pi sessions currently open on this repository, with their directory, branch and last-seen time. Presence is a heartbeat with a TTL of about a minute, so it answers "who is working now" and nothing older: a peer's claim about a merged PR is verified against git like any other claim.

## 4. Reconcile against reality

Session notes go stale within hours, so nothing enters the brief as state until git or the tracker agrees:

- Did the planned change merge, get reverted, or stay uncommitted on a branch or worktree?
- Are two branches or worktrees carrying competing attempts at the same fix?
- Did an open PR collect review comments or failing checks since that session ended?
- Which decisions were recorded and never implemented?

## 5. Write the brief

```text
Scope: <workspace or repo>, <date window>

## Capsule
- <up to 5 bullets: what this work is and where it stands>

## Threads
- <topic> — <one-line status> <tag>

## Problems (only if any)
- <up to 5: recurring symptoms, fixes that bounced or were reverted>

## Next move
- <one concrete next action>
```

Give every thread exactly one tag: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`. A thread with no tag is a thread nobody checked.

Cite by source — the session uuid, the PR or issue number, the path. An adjacent feature stays out unless it blocks this one; when the brief outgrows a screen, cut detail before cutting threads. Keep secrets and private context out of anything that leaves the session.
