---
name: orchestrate
description: "User-invoked /skill:orchestrate: run a numbered ticket folder in tiered subagent waves — triaged dispatch from the ladder, a reviewer gate on Tier-1 output, verified-only serial commits."
disable-model-invocation: true
---

# Orchestrate

Run a `to-tickets` folder through **tiered subagent dispatch**: every ticket goes
to a subagent whose model matches the ticket's complexity, cheap work runs on
cheap models, and a hard ticket a cheaper model would quietly fumble is
recognized and re-run one tier stronger. A finished run means every ticket either
genuinely passed its validation or is explicitly `blocked` with a reason. The
value is that floor, not the ceiling.

Invoke as `/skill:orchestrate <folder>`, naming a ticket folder (a spec's
`tickets/` folder, or `docs/tickets/<feature-slug>/`).

Three rules hold the run together, and none is this skill's to restate:

1. **The ladder is the single source of truth.** The ladder file at
`.pi/skills/orchestrate/ladder.json` is the only place roster types, tier
*(model, thinking)* pairs, per-type pins and gate rules are written. Read it with `readLadder` from
`ladder.mjs` beside this file and resolve every dispatch from what you read —
never name a model id, a thinking level or a tier count in prose or in a task
text. A second copy of the table is the failure the reader module exists to
prevent.
2. **The graph is code, not judgment.** Parse the folder with the modules in
this skill's directory — `readTickets`, `blockingIssues`, `frontier`,
`resolveTier`, `setTicketStatus` in `tickets.mjs` — and cite them, never
reimplement them. A cycle or a dangling blocker is a named, checkable error, and
the run stops there.
3. **The orchestrator is the only writer of history.** Implementers never
commit. The orchestrator commits serially — one ticket, one commit, message
citing the ticket number — after that ticket's Validation passed. Someone must
own the branch, and it is not a parallel wave.

The reviewer gate in this loop is a dispatch-time quality floor, not a code
review: the one-review-on-request policy in `AGENTS.md` is unchanged, and
running this skill commissions nothing.

## 1. Entry, before anything dispatches

**Read the ladder first** — the wave, the gate and the session check all read
from it. The reader never throws; it hands back a built-in ladder plus a list of
warnings:

```bash
node --input-type=module -e "import { readLadder } from './.pi/skills/orchestrate/ladder.mjs';
	const { ladder, warnings, source } = readLadder();
	console.log(JSON.stringify({ source, warnings, ladder }, null, 2));"
```

Show any warnings to the user. Dispatching from the built-in fallback after a
malformed or missing `ladder.json` is acceptable only when the user says so
after seeing the warning.

**Soft-check the session model.** The orchestrator's own work — composing task
text, reading gate verdicts, authoring commits — is only as good as the model
running this session. Compare:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
```

against the ladder's **top tier** — the highest-numbered entry in
`ladder.tiers`, resolved from the ladder you just read, never a second copy.
If they differ, warn that the run is being orchestrated below its own
escalation target and **require explicit confirmation before the first
dispatch**. The user may accept for a small, low-risk folder; the check is
never skipped silently.

**Parse and sanity-check the graph**, from the same directory:

```bash
node --input-type=module -e "import { readTickets, blockingIssues, frontier } from './.pi/skills/orchestrate/tickets.mjs';
	const graph = readTickets(process.argv[1]);
	const next = frontier(graph);
	console.log(JSON.stringify({ errors: blockingIssues(graph), ready: next.ready,
		waiting: next.waiting, warnings: graph.issues.filter(i => i.severity === 'warning') }, null, 2));" <folder>
```

If `blockingIssues` is non-empty — a cycle, a dangling blocker, a duplicate id,
an unreadable numbered ticket — report every error and stop. Dispatching
around a broken graph is not an option this skill has. Warnings are reported
alongside and do not stop the run.

Report the graph to the user before dispatching: ticket ids with their
statuses, the frontier, who waits on whom and why (the `waiting` reasons), and
the warnings. Only then dispatch.

## 2. The wave loop

Repeat until `frontier` is empty and every ticket is `done` or `blocked`, one
wave at a time.

**a. Recompute the frontier from disk every wave.** Ticket files are the
mid-run status surface — `setTicketStatus` writes them, a plain `grep` reads
them — so the graph is re-read each wave. Never dispatch from a cached node
list; a stale one re-dispatches a finished ticket.

**b. Triage every ticket about to be dispatched**, unless it carries a
`tier-override` or an already-recorded classification. Triage runs the
decision model pinned as `triage` in the ladder — a free Jev-class classifier
— through pi's **classifier machinery** (codemode's `models.classify`, see
`docs/codemode.md`), **not** as a chat subagent: a free decision model's API
refuses chat-traffic dispatches, so the classifier channel is the reachable
path and a pinned subagent run is only the fallback when the channel itself is
unavailable. Sketch, in a codemode script:

```js
const pin = pins.triage; // read from the ladder first
const jev = await models.getModelOfType("classifier", pin.provider, pin.model);
const result = await models.classify(jev, {
	state: { id, title, whatToBuild, acceptanceCriteria, validation },
	questions: { tier: { type: "choice",
		instructions: "Which complexity tier does ticket work need?",
		criteria: {
			"1": "Trivial: mechanical or single-seam change, no design judgment",
			"2": "Standard: new or changed behavior with tests at a seam",
			"3": "Hard: reshapes a boundary, risky, or underspecified enough to need judgment",
		} } } },
});
```

Check `result.stopReason` — a provider error is a failed triage, not a
low-answer — then read the verdict from `result.answers.tier.choice` (answers
are keyed by question id; each answer also carries `confidence`). At most four
classifier calls run at once per script, so a wide
frontier batches inside one script. Record every decision before dispatch: the
tier assigned, and a one-line justification naming the ticket signal that fits
the winning criterion. **A triage decision is never invisible** — every
dispatched ticket maps to a recorded classification, an explicit
`tier-override`, or the recorded floor. Resolve the dispatch tier with
`resolveTier` — two details that are easy to get wrong: the classifier's
`choice` is a **string**, so coerce it (`Number.parseInt(choice, 10)`) before
passing it, or every classification fails the number check and silently falls
to the Tier-1 floor; and pass `{ maxTier: ladder.tiers.length }` from the
ladder you read, so a ladder that grows accepts valid tiers instead of
rejecting them. The override wins, the classification stands, the ladder's
lowest tier is the floor. Do not reimplement the precedence.

**c. Dispatch each implementer** with `subagent`, at the tier's exact
*(provider, model, thinking)* pair taken from the ladder. Task text stays
small and references skills by name — the subagent loads the same package's
skills, so references cannot drift:

- read the ticket file at its path and live up to its acceptance criteria;
- reserve the ticket's file scope (`orchestrator_reserve`) **before** editing;
- work per `tdd`, prove per `prove-it-works`; load `blast-radius` when the
  ticket crosses a boundary, `diagnosing-bugs` when a bug shows up;
- **never commit or run git write commands — the orchestrator commits.**

**d. Mark the ticket `in-progress` at dispatch** with `setTicketStatus(file,
"in-progress")`. The frontmatter is the machine contract; the function keeps
the prose `**Status:**` line in agreement, so do not hand-edit either.

**e. Wait once per wave** with `subagent_wait({ ids })`. One blocking wait,
not polling; `subagent_status` is for the live "what is it doing" question.

**f. Gate Tier-1 output.** A ticket dispatched at a tier at or below
`gates.reviewer.throughTier` passes through a reviewer on completion:
dispatch a reviewer run at the reviewer's pin, have it read the ticket, the
acceptance criteria and the diff, and return a recorded verdict — **pass** or
**escalate**. Output from tiers above the gate is ungated.

**g. Verify before anything lands.** Dispatch a verifier run at the
verifier's pin — its pass/fail verdict is what authorizes the commit, which is
why the ladder pins it deliberately over-thought; restate nothing from the
pin, read it. The verifier runs the ticket's own `Validation` section and
returns the evidence.

**h. Commit serially.** After the verifier passes, commit that ticket's
changes yourself: one ticket, one commit, a subject citing the ticket number —
the `commit` skill's format here, per that skill's own branch and base
checks. Never batch two tickets into a commit, and never start staging a
second ticket while a first is uncommitted.

**i. Mark the ticket `done`** once its commit has landed, with
`setTicketStatus(file, "done")`, then move to the next wave.

## 3. The failure ladder

One policy covers every failed attempt on a ticket:

- **Crash** (aborted or errored run): retry once at the same tier. A second
  crash escalates one tier.
- **Reviewer gate votes escalate**: re-run the ticket one tier up, recording
  the verdict first.
- **Validation fails**: the run landed wrong answers on the cheap; escalate
  one tier and re-run the whole ticket.
- **No rung above** (the retry or the escalation target would pass the
  ladder's top tier): mark the ticket `blocked` with `setTicketStatus(file,
  "blocked", { reason })` — the reason carries the failure class and the tier
  that exhausted. Land nothing for it. Cost is recoverable; a silently-wrong
  hard ticket is not, and a ticket never half-lands.

Escalated tickets re-run the whole ticket at the new tier; an escalation is a
new dispatch, not a patch-up of the failed run's output. Every re-dispatch is
visible as a run record at the new tier's pair.

## 4. Write safety inside a wave

Parallel implementers share one checkout, so writes are fenced. Each
implementer reserves its ticket's file scope before editing (the task text in
step c says so), and when you compose a wave, list live reservations
(`orchestrator_reserve`) and hold any ticket whose scope overlaps one for the
next wave rather than forcing it. A ticket whose blast radius spans many
files — `blast-radius` findings recorded in the ticket or the spec — opts
into a single-runner worktree instead of the shared checkout, per the
`worktree` skill (`.worktrees/` in this repo; the subagent section of
`AGENTS.md` covers launching a worktree child correctly).

## 5. Bookkeeping and the closing report

Ticket-file status is the observable surface of the run: `ready →
in-progress → done/blocked`, written by `setTicketStatus` so the frontmatter
and the prose line agree, greppable mid-run. Tier classifications and their
justifications are recorded in the run's report as they are made, not
reconstructed afterwards.

Done-when: every ticket is `done` or explicitly `blocked` with a reason. Close
with a report covering, per ticket:

- the final tier and where it came from (`tier-override`, triage
  classification, or the recorded floor);
- the gate verdict, when the ticket was gated;
- every escalation and every blocked-status reason;
- the validation evidence and the commit that landed (hash and subject).

Name the ladder the run dispatched from, and any fallback the user confirmed,
so the report is reproducible against `ladder.json` as it stands.
