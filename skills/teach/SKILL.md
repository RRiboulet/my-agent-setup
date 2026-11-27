---
name: teach
description: "User-invoked /teach (pi: /skill:teach): teach a topic across sessions in a stateful workspace of lessons and records."
disable-model-invocation: true
---

<!-- Adapted from mattpocock/skills `skills/productivity/teach` (with its four
     *-FORMAT.md files); the MIT notice and the list of local changes are in
     licenses/NOTICE.md. The user-invoked-only form is upstream's own
     `disable-model-invocation: true`. -->

# Teach

The user wants to learn something over multiple sessions. This is stateful: the course lives in a workspace of files, not in this conversation, and the next session continues from those files rather than from what is left of this one.

## Where the workspace lives

Resolve it from what the user said. Otherwise:

1. A directory they name.
2. If you were invoked inside a project checkout — this repository included — **do not** create it there. A teaching workspace is a standing thing, not project work: it would show up as untracked scope in every `prove-it-works` and every diff. Use `<agent dir>/learning/<topic-slug>` instead, where the agent dir is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` and is persistent across container rebuilds.
3. If they want to keep the lessons, commit them, or share them, that is a workspace of its own: suggest a dedicated git repository.

> **Harness note:** Default workspace root is `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/learning` (or an explicit path you name).

Never commit a teaching workspace into someone else's project. Say where the workspace is before creating it.

## What the workspace holds

Workspace paths resolve from the workspace directory; only the `*-FORMAT.md` links resolve from this skill's directory.

| Path | What it holds |
| --- | --- |
| `MISSION.md` | why the user is learning this. Every teaching decision traces back to it. Format: [MISSION-FORMAT.md](./MISSION-FORMAT.md) |
| `RESOURCES.md` | the vetted sources it teaches from, split into knowledge and wisdom (communities). Format: [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md) |
| `GLOSSARY.md` | the workspace's canonical vocabulary, once a term has been demonstrated. Format: [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md) |
| `lessons/*.html` | the lessons: numbered `0001-<dash-case-name>.html`, the primary unit of teaching |
| `reference/*.html` | compressed cheat sheets, algorithms, syntax, glossaries: the documents the user returns to |
| `learning-records/*.md` | ADR-style notes on what has actually been learned, used to pick the next lesson. Format: [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md) |
| `assets/*` | reusable components shared across lessons |
| `NOTES.md` | the user's stated preferences about how they want to be taught |

## Philosophy

Deep learning needs three things, and they are acquired differently:

- **Knowledge**, from high-quality, high-trust sources.
- **Skills**, through interactive lessons built on that knowledge.
- **Wisdom**, from real interaction with other learners and practitioners.

Do not trust parametric knowledge. Until `RESOURCES.md` is well populated, finding good sources *is* the work; a lesson with no citations is you teaching from memory, and the user has no way to check it. Risk is highest in procedural domains with exact notation — a wrong move sequence in a Rubik's course, a wrong dosage — and lowest where the result is immediately verifiable, like code the user can run.

Some topics are knowledge-heavy (theoretical physics) and some skill-heavy (yoga). Decide which, because it changes how the lesson is built.

### Fluency vs storage strength

**Fluency strength** is in-the-moment recall; it makes the user feel like they have mastered something they will have lost in a week. **Storage strength** is long-term retention, and it is the goal. Build it with desirable difficulty:

- **Retrieval practice** — recall from memory, not re-reading.
- **Spacing** — spread practice over sessions.
- **Interleaving** — mix related topics, for skills practice only.

## Lessons

The lesson is the thing you produce. One self-contained HTML file in `lessons/`, numbered, short enough to finish in one sitting, tied to the mission, giving one tangible win the user can build on, inside their zone of proximal development.

Learner working memory is small: a lesson that teaches three things teaches none of them. Make it beautiful with clean typography and layout — the user will come back to it, so think Tufte — and make it a single page.

Every lesson:

- cites the sources behind its claims, with links;
- links to sibling lessons and to the reference documents it grew from;
- recommends **one** primary source to read or watch afterwards, the best one found, so the user can check you rather than trust you;
- reminds the user they can ask follow-up questions, since you are their teacher;
- if it has a quiz, has a component that shuffles the answers at render time (see [Assets](#assets)).

Open the finished lesson for the user: `xdg-open` or `open` if a display is available, otherwise print the absolute path and say it is ready to open.

## Assets

Lessons are built from reusable **components** in `assets/`: stylesheets, quiz widgets, simulators, diagram helpers, anything a second lesson could reuse.

Reuse is the default. Read `assets/` before authoring a lesson and build from what is there. When a lesson needs something new and reusable, write it as a component and link it; never inline code a future lesson would duplicate.

A shared stylesheet is the first component every workspace earns: every lesson links it, so the course looks like one course instead of a pile of one-offs.

The quiz shuffle belongs here too. Instructions ("vary which position holds the correct answer") have been measured not to work — the correct answer still lands first — so the fix is a component that shuffles at render time, written once and reused. In text, also keep every answer the same number of words, so reasoning length cannot give the answer away.

## The mission

Every lesson ties back to the mission: the concrete reason the user wants this. If `MISSION.md` is missing or thin, your first job is to interview them on why — an ungrounded mission makes lessons abstract and leaves you no way to judge what to teach next. Interviewing is a `grilling`-shaped task: ask the frontier, one round, with your recommendation.

Missions change as understanding grows. That is normal. Confirm the change with the user before rewriting `MISSION.md`, and write a learning record for what shifted and why.

## Zone of proximal development

Each lesson should feel like a challenge that is just enough. If the user names exactly what they want to learn, teach that. Otherwise read `learning-records/` (what is demonstrably known), read `MISSION.md` (where they are going), and teach the most relevant thing that fits between the two.

There is no assessment step, and in session one there are no learning records, so your first lesson can quietly assume too much. Ask for prior knowledge and known gaps in the first exchange, record the answer as a learning record with its claimed depth, and treat a complaint about jargon as a correction: define the term in the glossary, then use it.

## Knowledge

Design the lesson around the skill the user will acquire; include only the knowledge that skill needs, from trusted sources, with citations. Difficulty is the enemy of acquisition — it eats the working memory needed to understand.

## Skills

Make the knowledge stick. Here difficulty is the tool: effortful retrieval is what builds storage strength. Skills are taught through interactive lessons with a **feedback loop** — a quiz, an in-browser task, or a list of real-world steps (yoga poses, drills) where the user gets feedback on their performance. The tighter the loop, the better; immediate and automatic beats "submit it and wait".

Do not let a drill be skipped politely. "Thanks, that was great" is not evidence of learning.

## Wisdom

When a question needs real-world judgement, attempt an answer and then point to a **community** where they can test it: a moderated forum, a subreddit, a class, a local group. Prefer places with strong moderation over places with volume. If the user says they do not want to join a community, respect it and record the preference in `RESOURCES.md`.

## Reference documents and the glossary

Lessons are rarely revisited; reference documents are. So the short form of a lesson — the syntax table, the algorithm, the pose sequence, the glossary — belongs in `reference/`, not buried in the lesson that introduced it.

The glossary earns its place separately: add a term only once the user can use it correctly, then prefer it everywhere, including inside other definitions. `GLOSSARY-FORMAT.md` is linked above; upstream ships it unlinked, which is why the glossary never got built — here it is part of the course.

## NOTES.md

Record stated preferences here — how much theory before practice, session length, dislikes — so a later session honours them without being told again.

## Upholding the promise

The workspace is the promise: a new session in that directory can continue the course. That holds only if the files are true. `MISSION.md` reflects the current goal, `RESOURCES.md` holds only sources you actually read, learning records hold only what was demonstrated, and the next lesson is the one the records and mission justify.

## Honest limits

Say these when they matter rather than padding the course:

- **Nothing schedules review.** Lessons can practise spacing; nothing will remind the user. Offer review on request, and do not promise scheduled drilling.
- **No exit criteria ship.** You are better at making the next lesson than at knowing when to stop making them. When the mission's successes are demonstrable, say so and propose switching to practice, review, or a real-world project.
- **You are not authoritative.** The citations are what make a lesson checkable, and checking is the user's job. Point at the primary source and mean it.

## Where this sits

`teach` is standalone, and its only real neighbour here is `/skill:handoff`: when a `grilling` session hits something the user does not understand, hand off to a teaching workspace, learn it there, then come back with the understanding. `to-spec`, `to-tickets` and `implement` share nothing with it — the workspace is not project work.
