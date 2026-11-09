---
name: handoff
description: "Compact the current session into a handoff document, saved outside the workspace, that a fresh agent in any harness can continue from."
disable-model-invocation: true
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Handoff

Write a document that lets a fresh agent with no memory of this session continue the work. If the user says what the next session is for, tailor the document to that.

This is the document, not the `subagent` tool's context-handoff modes
(`standalone`, `lineage`, `fork`), which seed a child session's context.

## Where

Save it under the pi agent dir — `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/handoffs`
— as `handoff-<YYYYMMDD-HHMM>-<slug>.md`, not in the workspace, unless the user
names a location. In this devcontainer that directory is on the persistent
`pi-agent-config` volume, whereas `/tmp` and `/home/vscode` are container-local
and lost on rebuild.

## What

```markdown
# Handoff: <task>

## Goal
The objective and the done-when condition, or a pointer to the spec or playback.

## State
- Repository and branch: <path>, <branch> at <short commit>
- Uncommitted changes: <summary of git status, or "none">
- Last green check: <command> at <when>; known failures: <list or "none">

## Done
What is finished and verified, with pointers to commits, files, or tickets.

## Next
The next concrete steps in order, starting with the very first command or file.

## Open questions and risks
Unresolved decisions, assumptions in use, and anything fragile.

## Suggested skills
The skills the next agent should load first, and why (for example
`prove-it-works` before claiming done, or `/skill:implement` with the ticket folder).
```

## Rules

- Reference existing artifacts (specs, tickets, ADRs, issues, commits, diffs, decision logs) by path or URL instead of copying them.
- Record facts you verified, and mark anything you only believe.
- Redact secrets, tokens, credentials, and personal data.
- Finish by printing the path and one line the user can paste into the next session: `Read <path> and continue the work it describes.`
