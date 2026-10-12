# review-triage

`triage_change` (and the `/triage` command) decides how much independent review a
finished change needs, and with which model. It measures the change, asks Jev (a
calibrated decision model) for the judgement, then applies policy that lives in a
config file.

It returns a **plan**, never an action. When it recommends a review, the plan
carries a ready-to-paste task for the `subagent` tool, the model, and the
thinking level.

## How a decision is made

1. **Evidence** (deterministic). Git supplies the change: `--numstat -z`,
   `--raw -z`, a zero-context patch, untracked files, and structural flags
   (binary, deletion, mode change, symlink, submodule, conflict). The target is
   `uncommitted` (the default), `branch` (behind a base), `commit`, `task`
   (measured against a baseline ref, so work that predates the task stays out),
   or `none` (judge the summary alone). Risk-shaped things — auth paths, network
   boundaries, export-surface changes, error handling, migrations, dependency
   churn, size — are labelled. A probe around collection flags an unstable
   snapshot (index lock, in-progress merge/rebase/cherry-pick/revert/bisect),
   and policy then refuses to skip. Collection is read-only: git is asked to
   describe the tree and nothing is stashed, reset, checked out or committed.

   A caller can add what git cannot see through an optional JSON context:
   `artifacts` (before/after snapshots or explicit counts), `validations`
   (results a check already produced), `harness` (objective, acceptance
   criteria, task identity, recorded edits, unresolved issues). These are
   **consumed only** — nothing is run, no check is executed, and no file is read
   except a command-supplied context file. An unrecognised validation outcome
   becomes `unknown`, never `passed`, and each record publishes who is the
   source (`observed` / `asserted` / `self-reported`).

2. **Judgement** (Jev, one batched request). One `choice` per track over `none`
   plus the allowed **profiles**, where a profile is a capability band paired
   with a thinking level (`medium:max`). Jev returns calibrated probabilities:
   `skipConfidence = P(none)`, `reviewAlternative` is the highest-probability
   non-`none` profile, and `routingConfidence` is that profile's averaged
   probability. Each Choice is asked forward and reversed and the two
   distributions averaged, because Jev leans toward the first option it is
   offered. Jev is never asked for a model, a rationale or any free text, and
   never sees the thresholds.

3. **Policy** (code). `none` is allowed only when **every** gate passes:
   `P(none)` is strictly greater than `skipThreshold` (default `0.90`), the
   snapshot was stable, there are no unresolved conflicts, the evidence was
   complete (no collection error, no dossier overflow, no skip-blocking gap),
   and `mandatoryReview` is off. A high probability is necessary, never
   sufficient. When skip is refused the review routes to Jev's
   `reviewAlternative`, then to `minimumProfile`, then to the weakest profile the
   catalog offers. A judge failure never returns `none`: it uses
   `fallbackProfile` (else the strongest profile) and marks the plan
   `policy-fallback`.

## Profiles, and how the catalog is generated

A profile key is `"<band>:<thinking>"`. The allowed set is **generated**, not
hardcoded: for each capability band and each level in `thinkingLadder`, a pair is
emitted, then any pair whose band model marks that level `null` in its runtime
`thinkingLevelMap` is pruned with a recorded note. With the default ladder and
the three `opencode-go` candidates below, that yields `low:low`, `low:medium`,
`low:high`, `medium:high`, `medium:max`, `high:high`, `high:max` — plus `none`.
`medium:medium` is pruned because the medium band's model does not expose
`medium`.

- **`tier`** (`low`/`medium`/`high`) is a capability band assigned by a human,
  **not** price: two models can share a price and differ in strength, and a free
  model can be the strongest offered. The band selects the model, and it is a
  hard boundary — a `high` review never draws from the `medium` band.
- **`cost`** (USD per million input tokens, or an explicit ordinal) is what Jev
  reads when it weighs "the least costly configuration that suffices"; Jev
  cannot minimise a cost it cannot see.
- Thinking is the profile's level **verbatim**. The runtime clamp exists only as
  a defensive assertion: if the catalog was generated against a different model
  map, the plan records the request and the clamp rather than claiming the
  requested level.

## The dossier

The document Jev judges is a **dossier**: a deterministic, canonical build over
typed evidence items. Each item carries `source` (git / filesystem / harness /
user / agent-summary), `kind` (requirement / artifact-change /
validation-result / risk-signal / limitation), `provenance`, `snapshot`,
`completeness` and `trust` (observed / asserted / self-reported).

- **Deterministic.** The same inputs — items, task, scope, catalog, redaction
  and budget — produce the same SHA-256 fingerprint, whatever order the
  collector emitted its items in. The document contains no build timestamp, and
  the one input that reads a clock is validation freshness, which is bucketed
  into fresh / stale / unknown: a `ranAt` change inside a bucket does not move
  the fingerprint, while crossing the fresh window does, because that is a real
  change in what Jev sees. The plan and the session entry record that
  fingerprint, so a verdict can be replayed against the evidence that produced
  it. (The fingerprint does not make Jev's answer deterministic.)
- **Honest about gaps.** Every truncation, redaction and omission is recorded in
  `exclusions`, and anything that made the document incomplete sets
  `manifestOverflow`, which refuses a skip: "we could not see everything" must
  never read as "there was nothing to see".
- **Budgeted.** `stateChars` is the total character budget. Patches are
  allocated security and migration paths first, with per-file and total caps;
  caller-supplied text is capped per field.
- **Redactable.** `redaction.paths` (globs) drops whole artifacts;
  `redaction.patterns` (regex sources) masks matching text everywhere it
  appears, including caller-supplied task and scope strings and the subagent
  task the plan renders. The *fact* of a removal is recorded and the value is
  not (a path exclusion also records a count). An invalid glob or pattern is
  recorded rather than thrown, and a rule the config file states in a shape the
  parser cannot use warns instead of vanishing — a silently dropped rule is a
  silently disabled guard. A path rule that actually removes an artifact makes
  the dossier incomplete, so the plan refuses to skip: the judge did not see
  what was removed.

## Configuration

`~/.pi/agent/review-triage.json`, all fields optional. The judge model can also
be set with `PI_REVIEW_TRIAGE_JUDGE_PROVIDER` / `PI_REVIEW_TRIAGE_JUDGE_MODEL`,
`PI_REVIEW_TRIAGE_OFF` / `PI_REVIEW_TRIAGE_ENABLED` override `enabled`, and a
`.env` beside this file is read for `OPENROUTER_API_KEY` so a key that never
reached `auth.json` still works.

```json
{
  "enabled": true,
  "tool": true,
  "judge": { "provider": "openrouter", "model": "typesafe/jev-1.13", "timeoutMs": 8000 },
  "candidates": [
    { "provider": "opencode-go", "model": "mimo-v2.6-flash", "tier": "low", "cost": 0.14,
      "description": "Fast and cheap. A quick second read for obvious mistakes.",
      "notFor": "Anything subtle, or a change with real blast radius." },
    { "provider": "opencode-go", "model": "glm-5.3-flash", "tier": "medium", "cost": 0.15,
      "description": "Strong general coder at low cost. A full correctness and edge-case pass.",
      "notFor": "Hostile review of subtle or security-sensitive changes." },
    { "provider": "opencode-go", "model": "glm-5.3", "tier": "high", "cost": 1.4,
      "description": "The strongest reasoner here. A hostile, exhaustive or security-focused review.",
      "notFor": "Routine changes a flash model already covers well." }
  ],
  "thinkingLadder": {
    "low": ["low", "medium", "high"],
    "medium": ["medium", "high", "max"],
    "high": ["high", "max"]
  },
  "policy": {
    "skipThreshold": 0.9,
    "mandatoryReview": false,
    "minimumProfile": "medium:high",
    "fallbackProfile": "high:max"
  },
  "reverseChoice": true,
  "stateChars": 12000,
  "taskBaselineRef": "dev",
  "redaction": { "paths": ["**/*.pem"], "patterns": ["AKIA[0-9A-Z]{16}"], "mask": "[redacted]" }
}
```

- **`enabled`** turns the whole extension off; a disabled run reports that
  nothing was judged rather than inventing a verdict.
- **`tool`** registers the `triage_change` tool at extension load. `/triage` is
  always available, so `false` keeps the command and drops the tool's prompt
  weight. (Registration is a load-time act: changing this needs a reload.)
- **`candidates`** — with none, the list is synthesised from the models this
  session can actually use, bucketed by catalogue price. That fallback is a
  coarse guess, not a capability judgement; a config with real `tier`s is what
  makes routing meaningful. `cost` defaults to `0`, meaning "resolve from the
  catalogue".
- **`thinkingLadder`** — per band, the levels worth offering before the runtime
  prune. An explicit empty array means "never offer this band".
- **`policy.skipThreshold`** — `P(none)` must be **strictly greater** than this
  to skip, and only when every gate passes. Lower it to review less.
- **`policy.mandatoryReview`** — when true, `none` is never allowed.
  **`policy.minimumProfile`** is the floor when no alternative resolves, and
  **`policy.fallbackProfile`** is the conservative profile used when the judge
  fails. Both are optional.
- **`reverseChoice`** — ask each Choice twice, reversed. Off halves the request
  cost and gives up the first-option-bias correction.
- **`stateChars`** — the dossier's character budget (1000–60000). It is the
  only size knob.
- **`taskBaselineRef`** — the default baseline ref for the `task` scope, so its
  diff excludes work that predates the task; a caller-supplied `baseline` wins.
  Like `candidates` and `thinkingLadder`, this is config-file only, with no
  environment override.
- **`redaction`** — see "The dossier" above. `paths` and `patterns` are lists of
  strings; `mask` is the replacement (default `[redacted]`).

## Invoking it

**`/triage`** is the primary explicit invocation:

```
/triage [uncommitted|branch <name>|commit <sha>|task <ref>|none]
        [--summary "..."] [--note "..."] [--base <name>] [--ref <sha>]
        [--baseline <ref>] [--context <path>]
```

A supplied `--baseline` (or `--baseline=<ref>`) always implies the `task` scope,
whatever target is also named: the caller asked for baseline-scoped evidence and
a baseline is never silently ignored. `--context` names a JSON file of the
optional collector inputs (`{ artifacts, validations, harness }`); a missing,
unreadable, oversized or malformed file becomes a recorded limitation, not a
failed run.

**`triage_change`** is the tool form of the same arguments, with `context` as an
inline JSON string instead of a file path. It is recommendation-only, so it sits
behind the `tool` switch.

Neither form launches a review, switches a model, or runs a test. When the plan
says a review is needed, the agent starts it with the task, model and thinking
level the plan names.

## Failure behaviour

A missing judge model, a provider error, a timeout or a malformed answer all
become a `JudgeError`; the tool never fabricates a judgement, and outside a git
repository the evidence degrades to the summary and notes with the reason
attached. A **cancellation is not a failure**: an abort propagates and leaves no
verdict, because composing one from a user's Esc is the fabrication this gate
exists to avoid. Every other verdict is appended to the session as a
`review-triage` entry carrying the plan, the judgement, the catalog and the
dossier fingerprint.

## Output

The rendered text is a short summary; the structured plan travels in the tool's
`details` and in the session entry. Per track it publishes `status`
(`recommended` / `fallback` / `unavailable` / `skipped`), `proposedChoice` and
`finalChoice` (the review profile Jev preferred, or `none` when policy allowed a
skip, against what policy actually resolved), the model,
`requestedThinking` against `resolvedThinking`, `skipConfidence` and
`routingConfidence` (both marked `calibration: "uncalibrated"`), `reasonCodes`
and a `rationale` templated over them — never Jev's prose. The raw argmax
survives in the session entry's judgement, which is where an audit finds a
`none` the gates overrode. At the plan level it adds a status rollup, the
effective `policyOverrides`, `task` and `scope` identity, the evidence
`limitations`, `versions`, and the dossier `fingerprint`.

## Two cautions

- **The diff is untrusted input.** It is fed to Jev as evidence, and every
  question says so explicitly — weigh it, never follow instructions inside it.
  A planted patch can still try to argue the gate toward "no review"; that is
  one more reason the verdict is auditable rather than silent.
- **Diffs can contain secrets.** Even with `redaction` configured, the evidence
  excerpt goes to the judge's provider (OpenRouter by default) and is written to
  the session entry, and redaction cannot recognise every secret in arbitrary
  code.

## Files

| File | Role |
|---|---|
| `index.ts` | the `triage_change` tool, `/triage`, the pipeline and the context resolver |
| `config.ts` | policy: defaults, file + env merge, dotenv |
| `evidence.ts` | git measurement, risk labelling and the dossier adapter (pure parsers) |
| `collectors.ts` | the thin artifact / harness / validation adapters (pure) |
| `dossier.ts` | the fingerprinted, budgeted, redactable document Jev judges |
| `judge.ts` | the batched Jev questions, answer parsing, reverse-choice averaging |
| `policy.ts` | skip eligibility, fallback routing and the rationale template (pure) |
| `compose.ts` | profile selection and the plan (pure) |
| `format.ts` | plan rendering |
