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
2. **Judgement** (Jev, one batched request). Two `noul` gates (does this need
   adversarial / complexity review?), two `score` readings (how hard should each
   push, 0–3), and each model `choice` asked twice, forward and reversed, then
   averaged to cancel Jev's first-option bias.
3. **Policy** (code). A `noul` probability at or above the track threshold means
   "needed". The `score` picks a tier; each tier carries a thinking level and a
   cost floor the chosen model must clear. A confident `choice` inside the floor
   is used; a low-confidence or unavailable choice walks the fallback chain.

## Configuration

`~/.pi/agent/review-triage.json`, all fields optional. The judge model can also
be set with `PI_REVIEW_TRIAGE_JUDGE_PROVIDER` / `PI_REVIEW_TRIAGE_JUDGE_MODEL`,
and a `.env` beside this file is read for `OPENROUTER_API_KEY`.

```json
{
  "judge": { "provider": "openrouter", "model": "typesafe/jev-1.13", "timeoutMs": 8000, "minConfidence": 0.35 },
  "candidates": [
    { "provider": "opencode-go", "model": "glm-5.3-flash", "cost": "low",
      "description": "Fast and cheap. A quick second read for obvious mistakes." },
    { "provider": "opencode-go", "model": "glm-5.3", "cost": "medium",
      "description": "Competent mid-tier. A full correctness pass on ordinary work." },
    { "provider": "opencode-go", "model": "kimi-k2", "cost": "high",
      "description": "Strong reasoning. Hostile review of subtle or high-stakes work.",
      "notFor": "Routine work a cheaper model handles well." }
  ],
  "tracks": {
    "adversarial": {
      "threshold": 0.5,
      "tiers": [
        { "name": "light",    "minScore": 0,   "thinking": "low",    "costFloor": "low" },
        { "name": "standard", "minScore": 1.5, "thinking": "medium", "costFloor": "medium" },
        { "name": "deep",     "minScore": 2.5, "thinking": "high",   "costFloor": "high" }
      ],
      "fallbackChain": ["opencode-go/glm-5.3", "opencode-go/glm-5.3-flash"]
    },
    "complexity": {
      "threshold": 0.5,
      "tiers": [
        { "name": "light",    "minScore": 0,   "thinking": "low",    "costFloor": "low" },
        { "name": "standard", "minScore": 1.5, "thinking": "medium", "costFloor": "medium" },
        { "name": "deep",     "minScore": 2.5, "thinking": "high",   "costFloor": "high" }
      ],
      "fallbackChain": ["opencode-go/glm-5.3"]
    }
  },
  "reverseChoice": true,
  "onJudgeError": "conservative",
  "stateChars": 12000
}
```

- **`cost`** (`low`/`medium`/`high`) is both the price and the capability rank the
  cost floor is enforced against.
- **`description`** / **`notFor`** are what Jev reads when choosing. With no
  `candidates`, the list is synthesised from the models the session can use,
  bucketed by catalogue price.
- **`onJudgeError`** is `"conservative"` (default): if Jev is unreachable,
  recommend both reviews at their middle rung. `"skip"` recommends nothing.

## Failure behaviour

A missing judge model, a provider error, a timeout or a malformed answer all
become a `JudgeError`; the tool never fabricates a judgement. Outside a git
repository the evidence degrades to summary and notes with the reason attached.
Every verdict is appended to the session as a `review-triage` entry with the
probabilities, confidences, tiers and models, so a decision not to review is
auditable.

## Files

| File | Role |
|---|---|
| `index.ts` | the `triage_change` tool, `/triage`, and the pipeline |
| `config.ts` | policy: defaults, file + env merge, dotenv |
| `evidence.ts` | git measurement and risk labelling (pure parsers) |
| `judge.ts` | the batched Jev questions, answer parsing, reverse-choice averaging |
| `compose.ts` | thresholds, tier/floor selection, fallback walk (pure) |
| `format.ts` | plan rendering |
