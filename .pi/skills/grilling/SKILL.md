---
name: grilling
description: "Interview the user relentlessly, in rounds, about a plan, decision, or idea until every branch of the design tree is settled. Use when: the user asks to be grilled, stress-tested or interrogated about something they are about to do, or says a plan needs poking at; or a request's shape is undecided and a ten-line playback cannot carry its assumptions. For the quick pass instead, use in-your-own-words."
---

<!-- Adapted from mattpocock/skills `skills/productivity/grilling`; the MIT notice
     and the list of local changes are in licenses/NOTICE.md. -->

# Grilling

Interview the user until you share one understanding of what will be done. The output is **shared understanding** — not code, not a plan document, and never a decision you made on their behalf.

## The design tree

Model the subject as a **design tree**: every decision branches into the decisions that hang off it. "Which database" branches into "which migration path", which branches into "what happens to the rows the new schema rejects".

The **frontier** is every decision whose prerequisites are already settled: the questions you can ask *now*, without guessing at an answer you have not heard. A **round** is one frontier, asked in full and answered in full.

Work in rounds. Two questions never share a round if one depends on the other; a question that hinges on an answer still open belongs to a later round. Thirteen questions typically land in about three rounds, not thirteen.

## The round

Ask the whole frontier in one round. Number each question, title it, and give your recommended answer:

```
❓ **Q1** - **<question title>**: <body; several paragraphs and offered choices are fine>

➡️ <your recommended answer, and the one reason it wins>

---

❓ **Q2** - **<question title>**: <body>

➡️ <your recommended answer>
```

Word each question so that "yes" accepts your recommendation. Format it so the user can answer by number — "1 yes, 2 the second option, 3 no, because …" — instead of quoting questions back.

Then stop and wait. The next round is computed from what the user actually said, not from what you expected: settled decisions push the frontier outward and unblock questions that depended on them.

## Facts are yours, decisions are the user's

Finding a **fact** is your job. When a frontier question needs something the environment can settle — a file, a config value, a library's real behaviour, a cost — find it: read it, run it, or dispatch a `subagent` with a fresh context window. Never ask the user for something you can look up, and never guess a fact to keep a round tidy.

Do not block the round on that research. A running lookup is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now.

The **decisions** are the user's. Put each one to them and wait. An interviewer who answers its own questions has broken this skill, and the answers it invents will be the ones the existing code already implies rather than the ones they meant.

"I don't know" is a real answer, and usually means the decision needs a prototype or a fact you have not found yet — not that you should pick for them.

## When the frontier is empty

Stop, and ask the user to confirm you share the understanding. Do not act on it before they do.

Then say what comes next and do none of it unasked. Grilling leaves the repository untouched: no edits, no commits, no review. A prototype that would settle an open question is its own request, made after the round — never something slipped in while interviewing. In this repository `to-spec` turns the shared understanding into a spec, `to-tickets` splits it, and `implement` builds it, each started only by the user. A `/skill:grilling` session is also not a review: the review rules in `AGENTS.md` are untouched by it.

If a decision needs knowledge the user does not have, do not teach it inside the interview and do not let them guess: `handoff` the conversation out, learn the topic in a teaching workspace with `teach`, and come back.

## Where this sits

- `in-your-own-words` is the cheap pass: about ten lines, the risky assumptions only, then build. It is the default.
- `grilling` is the full tree, for when the shape is undecided and a wrong assumption is expensive — the user asked to be grilled, described the plan as "rough", or playback kept producing questions they could not answer in one line.
- `to-spec` deliberately does not interview, because it is meant to write down an understanding that already exists. This is where that comes from.

## Length

Count rounds, not questions: forty-odd questions across four rounds is an ordinary session, and there is no cap. Steering in plain language stops it, not a counter.

A session that runs very long usually means the scope is too large: say so, propose splitting the subject, and grill one piece. It can also mean the context is full enough that the questions are getting worse, which is the moment to settle, confirm, and continue in a fresh session from a `handoff`.
