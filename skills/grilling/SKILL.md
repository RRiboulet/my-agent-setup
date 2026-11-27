---
name: grilling
description: "Stress-test a plan, decision, or idea through rounds of numbered questions with recommended answers until nothing is silently assumed. Use when: asked to grill or poke holes in a plan, or when open decisions depend on each other."
---

# Grilling

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

If you started this yourself rather than at the user's request, say in one line why the plan needs grilling and let the user decline. Grilling needs answers, so if no one is there to answer (an unattended or autonomous run), do not start it. Record the open decisions as assumptions instead.

## Rounds

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer, and the one reason it wins>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer and the user can reply by number ("1 yes, 2 the second option, 3 no, because...").

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

## Facts are yours, decisions are the user's

Finding _facts_ is your job, never the user's. Do not ask the user for anything you could look up in the code, files, tools, or docs.

Delegate every lookup to a read-only sub-agent with fresh context. That includes small ones: a single file read, a search, or a directory listing. While grilling, do not read files, search, or run commands yourself; your context is for the design tree. Use the harness's lightweight read-only exploration agent (`subagent({ role: "explore", ... })`), not a general-purpose coding agent: lookups need speed and a clean context, not deep reasoning. Batch related questions into one sub-agent and run independent lookups in parallel. Only if the harness has no sub-agents, look facts up yourself.

Don't block on a lookup: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the report. Ask the rest of the frontier now.

Give each fact-finding sub-agent this brief, filled in:

```text
Question: <one factual question>
Look in: <paths, commands, or docs to start from>
Rules: read-only; change nothing. Answer only this question, then stop.
Return: each fact with its evidence (path:line, a command and its output, or a URL).
If you cannot find it, say "not found" and list where you looked. Do not guess.
Do not recommend or decide anything.
```

Check the report before using it: a fact without evidence is still an open question. The _decisions_ are the user's: put each to them and wait. "I don't know" is a real answer and usually means the decision needs a prototype or an unfound fact — never pick on the user's behalf.

If a decision needs domain knowledge the user does not have, do not teach inside the interview or let them guess: suggest `/handoff` and `/teach` (when available) to learn it separately, then resume.

## Where this sits

- Load the `in-your-own-words` skill for the cheap ten-line playback (the default).
- Grilling is for when the shape is undecided and wrong assumptions are expensive.
- Count rounds, not questions. If scope grows too large or context degrades, settle what is decided, confirm, and suggest `/handoff`.

## Done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Leave the repository untouched (no edits, commits, or unrequested prototypes). Do not act on the shared understanding until the user confirms it. Then suggest the next step: `/to-spec` to write it up, `/to-tickets` if already sized for slices, or `/implement` if the work is small and clear.
