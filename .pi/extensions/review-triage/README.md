# review-triage

`triage_change` decides how much independent review a finished change needs, and
with which model. It measures the change, asks Jev (a calibrated decision model)
for the judgement, then applies policy that lives in a config file.

It returns a **plan**, never an action. When it recommends a review, it includes
a ready-to-paste task for the `subagent` tool.

## How a decision is made

1. **Evidence** (deterministic). `git diff --numstat`, `--name-status` and a
   zero-context patch for the chosen target, plus any `notes` the caller wrote.
   Risk-shaped things — auth paths, network boundaries, export-surface changes,
   error handling, migrations, dependency churn, size — are labelled and put in
   Jev's `state`. Nothing scores them.
2. **Judgement** (Jev, one batched request). **One depth question per track** —
   a `choice` over `none`/`light`/`standard`/`deep` — asked forward and reversed,
   then averaged. That single distribution is the only probability per track:
   `none` is the gate and the deeper levels are the cost ladder, so nothing can
   disagree with itself. A second `choice` per track picks the model, also asked
   both ways.
3. **Policy** (code). A review is recommended when `P(depth = none)` is below
   the track's `nothingMargin`. The rung is the **deepest whose cumulative
   probability clears its own `minConfidence`** — i.e. select `deep` only when
   `P(depth >= deep) >= 0.75`. That one rule is the cost gate: because cumulative
   probability shrinks as the rung deepens, an expensive rung has to be argued
   for, not merely be the largest single slice. The rung's band then bounds the
   model; Jev's `choice` picks within it, and can never leak the expensive model
   into a cheaper review.

## Configuration

`~/.pi/agent/review-triage.json`, all fields optional. The judge model can also
be set with `PI_REVIEW_TRIAGE_JUDGE_PROVIDER` / `PI_REVIEW_TRIAGE_JUDGE_MODEL`,
and a `.env` beside this file is read for `OPENROUTER_API_KEY`.

```json
{
  "enabled": true,
  "judge": { "provider": "openrouter", "model": "typesafe/jev-1.13", "timeoutMs": 8000, "minConfidence": 0.35 },
  "candidates": [
    { "provider": "opencode-go", "model": "mimo-v2.6-flash", "tier": "low",
      "description": "Low cost and fast. A light second read for obvious mistakes.",
      "notFor": "Anything subtle, or a change with real blast radius." },
    { "provider": "opencode-go", "model": "glm-5.3-flash", "tier": "medium",
      "description": "Strong general coder at low cost. A full correctness and edge-case pass.",
      "notFor": "Hostile review of subtle or security-sensitive changes." },
    { "provider": "opencode-go", "model": "glm-5.3", "tier": "high",
      "description": "The strongest reasoner here. A hostile, exhaustive or security-focused review.",
      "notFor": "Routine changes a flash model already covers well." }
  ],
  "tracks": {
    "adversarial": {
      "nothingMargin": 0.5,
      "tiers": [
        { "name": "light",    "candidateTier": "low",    "thinking": "low",    "minConfidence": 0 },
        { "name": "standard", "candidateTier": "medium", "thinking": "medium", "minConfidence": 0.5 },
        { "name": "deep",     "candidateTier": "high",   "thinking": "high",   "minConfidence": 0.75 }
      ],
      "fallbackChain": ["opencode-go/glm-5.3-flash", "opencode-go/glm-5.3"]
    },
    "complexity": {
      "nothingMargin": 0.5,
      "tiers": [
        { "name": "light",    "candidateTier": "low",    "thinking": "low",    "minConfidence": 0 },
        { "name": "standard", "candidateTier": "medium", "thinking": "medium", "minConfidence": 0.5 },
        { "name": "deep",     "candidateTier": "high",   "thinking": "high",   "minConfidence": 0.75 }
      ],
      "fallbackChain": ["opencode-go/glm-5.3-flash"]
    }
  },
  "reverseChoice": true,
  "onJudgeError": "conservative",
  "stateChars": 12000
}
```

- **`tier`** (`low`/`medium`/`high`) is a capability band assigned by a human,
  **not** price: two models can share a price and differ in strength, and a free
  model can be the strongest offered, so price cannot rank them. The rung's band
  is a hard boundary — a `standard` review draws only from the `medium` band.
- **`minConfidence`** is the cumulative `P(depth >= this rung)` needed to select
  it. This is the whole cost policy: raise it to make an expensive rung rarer.
- **`thinking`** is the rung's thinking level, passed to the review subagent. It
  is a function of the rung (light → low, standard → medium, deep → high), then
  **clamped to what the chosen model supports**: a model that exposes a
  `thinkingLevelMap` walks the requested level down to the highest one it
  accepts, and a non-reasoning model gets `off`. The chosen model never raises
  or lowers the level on its own — only the clamp does.
- **`nothingMargin`** is the most `P(depth = none)` that still recommends a
  review. Lower it to review less, raise it to review more.
- **`description`** / **`notFor`** are what Jev reads when choosing within a band
  — this is where routing quality comes from. With no `candidates`, the list is
  synthesised from the models the session can use and bucketed by catalogue
  price, a coarse guess rather than a capability judgement.
- **`fallbackChain`** is per track: what to use when the band is unavailable.
- **`onJudgeError`** is `"conservative"` (default): if Jev is unreachable,
  recommend both reviews at their middle rung. `"skip"` recommends nothing.
- **`enabled`** (or `PI_REVIEW_TRIAGE_OFF=1`) turns the tool off; a disabled run
  reports that nothing was judged rather than inventing a verdict.

## Failure behaviour

A missing judge model, a provider error, a timeout or a malformed answer all
become a `JudgeError`; the tool never fabricates a judgement, and outside a git
repository the evidence degrades to summary and notes with the reason attached.
A **cancellation is not a failure**: an abort propagates and leaves no verdict,
because composing one from a user's Esc is the fabrication this gate exists to
avoid. Every other verdict is appended to the session as a `review-triage` entry
with the probabilities, confidences, tiers and models, so a decision not to
review is auditable.

## Two cautions

- **The diff is untrusted input.** It is fed to Jev as evidence, and every
  question says so explicitly — weigh it, never follow instructions inside it.
  A planted patch can still try to argue the gate toward "no review"; that is
  one more reason the verdict is auditable rather than silent.
- **Diffs can contain secrets.** The evidence excerpt goes to the judge's
  provider (OpenRouter, by default) and is written to the session entry.

## Files

| File | Role |
|---|---|
| `index.ts` | the `triage_change` tool, `/triage`, and the pipeline |
| `config.ts` | policy: defaults, file + env merge, dotenv |
| `evidence.ts` | git measurement and risk labelling (pure parsers) |
| `judge.ts` | the batched Jev questions, answer parsing, reverse-choice averaging |
| `compose.ts` | depth rungs, band selection, fallback walk (pure) |
| `format.ts` | plan rendering |
