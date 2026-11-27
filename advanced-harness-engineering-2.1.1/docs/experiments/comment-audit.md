# Comment audit: is comment slop a real problem in `pupkeep` and `analytics-agent`?

Ticket 06 of `docs/specs/2026-11-19-prevent-recurrence.md`, covering R13. The
question the ticket asks is narrow and decidable: classify 30 comments in each
project, count the ones that exist to justify a workaround, and let a 20%
threshold decide whether a comment experiment is worth running. This report is
the evidence; `tools/comment-audit.mjs` is the script that re-derives it.

Projects audited, read-only, at these revisions:

| project | root | revision | committed |
|---|---|---|---|
| `pupkeep` | `/home/ubuntu/pupkeep` | `c6888b481c08` | 2026-11-19 |
| `analytics-agent` | `/home/ubuntu/analytics-agent` | `d7872e599a84` | 2026-11-19 |

## 1. Decision

**The threshold is met in `pupkeep` and not in `analytics-agent`, so a comment
experiment is justified for `pupkeep` alone — and by a narrower margin than the
number suggests.**

| project | workaround justification | sample | weighted over the inventory | 20% threshold |
|---|---|---|---|---|
| `pupkeep` | **7 of 30** | **23.3%** | 23.1% | met |
| `analytics-agent` | **1 of 30** | **3.3%** | 3.2% | not met |

Under R13 that means: a comment experiment is justified as a follow-on for
`pupkeep`; nothing in this measurement supports one for `analytics-agent`. No
comment skill is added in this ticket — the ticket's Scope says so outright, and
nothing here changes that.

The margin matters, so it is stated up front rather than buried in §5: five of
the seven `pupkeep` units are workarounds of a defect or a hazard, and two are
comments that justify an *error path*. Drop both error-path units and `pupkeep`
falls to 5 of 30 (16.7%, weighted 15.7%), below the threshold. Drop one and it
sits on 20.0% exactly (weighted 19.4%). §5 tabulates all three readings. The
honest summary is that `pupkeep` is at or just above 20% depending on whether
"justifies a deliberate error-handling shape" counts as a workaround, so 23.3%
should not be read as a wide margin.

## Follow-on: the experiment the threshold bought

`pupkeep`'s 23.3% was acted on. An experiment branch there
(`experiment/comment-discipline`, local, not merged) adds a check that a comment
whose first sentence announces a dodge — "Backstop", "hack", "for now",
"temporarily" and nine more — must carry `WORKAROUND(owner: …, expires: …)` and
eight words naming the defect, with a 13-row ratchet baseline and a six-week
window to 2027-01-02. The full design, the baseline command and the win/loss
terms are in `pupkeep/docs/experiments/comment-discipline.md`.

One caveat belongs next to that number rather than under it: the lexicon fires
on **one** of the seven workaround units this audit sampled — the other six read
"a macrotask, not a microtask", "not fatal", "does not wait out" and so on. So
the experiment measures *announced* dodges (13 of 3,683 units, 0.35%), which is
a different and much narrower thing than this report's 23.3%, and it does not
inherit that figure. What closes the gap is the experiment's own D-time gate: a
fresh 30-unit draw must read at most 20% workaround with no undeclared one in
it, so the judgement at the end is this report's method, rerun, rather than the
lexicon's recall.

Two findings are worth more than the percentage:

* **`analytics-agent`'s suppressions are silent.** 6 of its 10
  suppression-adjacent sample units are bare `# type: ignore[...]` / `# noqa`
  directives: a tool constraint with no reason recorded. That is exactly what
  R8 forbids for new suppressions, and the existing ones predate it.
* **`pupkeep` has no suppressions at all** (0 directive lines, 0 files), so its
  whole 20-unit ordinary sample and 10-unit timer sample carry the decision. Its
  comments are overwhelmingly load-bearing in a way `analytics-agent`'s are not:
  17 of 30 invariants versus 14, and 1 external quirk versus 9.

## 2. Method

### 2.1 Scope, from `git ls-files` only

The inventory comes from `git ls-files` in each project root, filtered by
extension, so an untracked, ignored or vendored tree cannot leak in by being on
disk. Explicitly excluded: `node_modules/`, `web/vendor/`, `.venv/`,
`evaluation_results/`, `.worktrees/`, `.pi/git/`.

| project | extensions | tracked files | in scope | excluded |
|---|---|---:|---:|---|
| `pupkeep` | `.ts .js .mjs .sh .css` | 270 | **216** | 4 vendored `web/vendor/*.mjs` (minified preact/htm) |
| `analytics-agent` | `.py .sql .sh` | 146 | **86** | none tracked with those extensions |

In scope, by directory:

| `pupkeep` | files | | `analytics-agent` | files |
|---|---:|---|---|---:|
| `src/` | 93 | | `analytics-agent/app/` | 51 |
| `test/` | 80 | | `analytics-agent/tests/` | 25 |
| `web/` (first-party) | 32 | | `analytics-agent/db/` | 4 |
| `scripts/` | 7 | | `analytics-agent/scripts/` | 3 |
| `bin/` | 2 | | `.devcontainer/` | 2 |
| `.devcontainer/` | 2 | | `pi-session.sh` | 1 |

`web/vendor/*.mjs` is excluded on purpose: it is pinned third-party code,
hash-checked by `test/vendor.test.ts`, and counting four minified files' three
comments as first-party prose would put library text in the population.

### 2.2 What counts as one comment

A **comment unit** — one vote in the sample — is one of:

* a maximal run of *full-line* line comments on consecutive lines (`//`, `#`,
  `--`), with the marker stripped and the lines joined;
* one block comment (`/* … */`), counted once however many lines it spans;
* one Python docstring;
* one *trailing* comment on a line that also holds code.

Trailing comments never merge with anything. `a(); // x` and `b(); // y` are two
annotations on two statements, and merging them would fuse a run of per-line
`# type: ignore`s into one giant unit — the exact stratum this audit needs to see
one directive at a time.

Counting units rather than lines is the draft's rule, kept: a ten-line paragraph
that states one rule is one unit, so it cannot outvote a one-line comment eight
times over. The obvious cost is that a unit can mix genres; §5 and §7 say where
that mattered.

Python docstrings are counted (324 of them). They are how this codebase
documents its functions, and excluding them would remove most of the
`analytics-agent` invariants while leaving the `pupkeep` JSDoc blocks in.

### 2.3 Strata, assigned from text and never from meaning

Assigned mechanically, before any comment was read:

| stratum | rule |
|---|---|
| **S** — suppression-adjacent | the unit holds a suppression directive, or a directive occurs within ±3 lines of it |
| **T** — timer/retry/async-adjacent | not S, and a *code* line within ±3 lines matches the keyword set below |
| **O** — ordinary | everything else |

The keyword set is the draft's, adopted verbatim and fixed before the draw:
`setTimeout setInterval clearTimeout clearInterval sleep delay retry retries
backoff await async promise AbortSignal AbortController schedul* deadline timeout
timer thrott* poll* asyncio ThreadPoolExecutor set_alarm recurring interval`,
case-insensitive. Comment lines are blanked out of the haystack first, so a
comment *about* retries cannot pull itself into T.

The directive pattern, also fixed in advance: `noqa`, `eslint-disable[-next-line
|-line]`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `type: ignore`,
`pylint: disable`, `flake8: noqa`, `prettier-ignore`.

### 2.4 The draw

* **Quota** 10 S + 10 T + 10 O = 30 per project, from the ticket.
* **Shortfall** moves down a published order (O, then T, then S) and is printed
  by the script. `pupkeep` has an empty S pool, so its S quota becomes 10 more
  ordinary units: its sample is 10 T + 20 O. That is disclosed here and in every
  run's output, not absorbed.
* **IDs** are content-addressed: the first 8 hex characters of
  `sha256("<path>:<start line>")`, prefixed `PU-`/`AA-`. The same unit keeps the
  same ID if the population around it changes; the draft's four-digit indices do
  not, which is why its 60 labelled units cannot be re-identified here (§6).
* **Order and seed** units are sorted by ID and drawn per stratum with a
  Fisher–Yates shuffle over sfc32 seeded from
  `sha256("comment-audit-v1-pupkeep")` and `sha256("comment-audit-v1-analytics")`.
  Stdlib only (`node:crypto` for the digest), and reproducible in any JS engine.
* **No re-draws.** The first draw is the sample. Nothing was swapped, rejected
  or re-drawn after reading it, including units that weaken the result — one
  `pupkeep` unit (`PU-088ae9e6`) is a 26-line module header carrying several
  separable rules, and it counts once.

### 2.5 The classification rule

One class per unit, decided by its **primary assertion**, applied in this order:

1. **N — narration.** The unit restates what the code does or what a fixture
   means, or is a section banner (`// === x ===`, `# --- y ---`).
2. **E — external quirk.** The stated cause is outside this code's design:
   runtime, browser, OS, library, checker, protocol, model, network. A bare
   suppression directive with no reason is E — it records a tool constraint, not
   a justification.
3. **WJ — workaround justification.** The unit justifies a choice about *how the
   code is written* — a shape, an ordering, a guard, a redundancy, a
   deliberate error path — by naming what it avoids: the hazard, the failure
   mode, or the alternative that was rejected. Both halves are required. A
   comment that states a rule and then explains why the rule is true is not WJ; a
   comment that explains why the code takes the odd path it does, and what breaks
   on the straight one, is.
4. **I — invariant.** Everything else that states a rule, contract, shape,
   ordering, or boundary that must hold, including a test that names the
   property it pins.

The distinction that carried the most weight, stated plainly because it decides
the `pupkeep` result: a comment justifying a **data** contract ("the record
travels with the answer") is I; a comment justifying a **code-shape** decision
("a macrotask, not a microtask") is WJ. And a stated purpose ("so the document
stays bounded") is not an avoided harm, so it stays I.

Each unit was read with ±4 lines of source. The class and a one-clause reason for
every unit are in `tools/comment-audit-labels.json`, keyed by ID and pinned to
the unit's text hash; the script joins them, so the counts below are recounted
from that file rather than from this prose. A comment edited after labelling
fails the join instead of silently changing a number.

### 2.6 Lexer validation

The counts are only as good as the scanners, so they were checked against
independent implementations:

* **Python** — all 79 files, against CPython 3.12's own tokenizer and `ast`:
  1,162 `COMMENT` tokens and 324 docstrings, **exact match on every file, zero
  discrepancies**.
* **TypeScript/JavaScript/CSS** — no JS parser is installed in either tree (the
  `typescript` package in `pupkeep/node_modules` is the native preview, with no
  JS API). Instead: every `//` and `/*` that survives in the comment-blanked
  source was located (154 of them) and each one is inside a string, template
  literal or regex literal; and a naive "line starts with `//`" grep was compared
  with the lexer's own-line tokens, where every difference is explained by
  syntax the naive grep does not know: shebangs in `.js`/`.ts`, `#private`
  fields, CSS `--custom-properties`, `--flag` lines inside a block comment, and
  CSS block comments (a line-comment map by construction excludes those). That
  check found one real bug, now fixed: comments inside `${…}`
  template interpolations were being swallowed as string text, which is where
  `web/views/settings.js` keeps one of its comments.
* **Shell and SQL** — every `#`/`--` line in the 15 files compared with a naive
  line grep: identical, except three `#` lines inside the heredoc that
  `scripts/termux-sshd.sh` *generates* (a config file's contents, not comments in
  the script), which the lexer deliberately skips.

## 3. Inventory

| | `pupkeep` | `analytics-agent` |
|---|---:|---:|
| in-scope files | 216 | 86 |
| comment units | **3,616** | **962** |
| of which docstrings | 0 | 324 |
| suppression-directive lines | **0** | **49** |
| files holding a directive | 0 | 13 |
| S pool (suppression-adjacent) | 0 | 63 |
| T pool (timer/retry/async) | 1,349 | 310 |
| O pool (ordinary) | 2,267 | 589 |

The 49 `analytics-agent` directives split as **44 in `analytics-agent/tests/`
(9 files) and 5 in `analytics-agent/app/` (4 files)** — none in `db/` or
`scripts/`. Counted independently with
`git grep -nE 'noqa|type:\s*ignore|pylint:\s*disable'`, which reproduces 49 lines
in 13 files.

Note that 63 S units from 49 directive lines is not a contradiction: adjacency is
a ±3-line window, so one trailing directive makes several neighbouring units S.
The `analytics-agent` S pool is 6.5% of its units, and a tenth of its sample.

## 4. Counts and examples

| project | I invariant | E external quirk | **WJ workaround** | N narration | total |
|---|---:|---:|---:|---:|---:|
| `pupkeep` | 17 | 1 | **7** | 5 | 30 |
| `analytics-agent` | 14 | 9 | **1** | 6 | 30 |

By stratum, so the weighted estimate in §5 can be re-derived by hand:

| | S (n=10) | T | O | WJ total |
|---|---|---|---|---|
| `pupkeep` | — (empty pool) | 2 of 10 | 5 of 20 | 7 |
| `analytics-agent` | 0 of 10 | 1 of 10 | 0 of 10 | 1 |

### One example per class

Typographic markup (`/** */`, `#`, `*` gutters) is stripped; the wording is
verbatim. **Redaction:** every comment unit in both projects was swept for
credential shapes (`-----BEGIN …`, `key/token/secret/password = value`, and
base64-looking runs of 32+ characters containing digits and capitals). It found
11 *prose* mentions — route documentation like `` `/login?token=` `` and the
sentence "A hash or opaque token" — and zero credential values, so no quotation
below needed masking. The appendix previews still pass through the redactor.

**I — invariant** (`pupkeep`, `src/server/http.ts:1505`), the wire contract for
one route: *"`ended`/`discarded` and their replay share a 200; `replayed` is the
flag."*

**I — invariant** (`analytics-agent`, `tests/test_agent_components.py:93`), the
property a test pins: *"A search_metadata-only failure completes schema-only and
is not an error."*

**E — external quirk** (`pupkeep`, `test/termux-scripts.test.ts:523`): *"Non-interactive,
and prompt-free at the dpkg level: nobody is at the phone."* The code's shape
follows from `dpkg`'s prompting behaviour and a headless deployment.

**E — external quirk** (`analytics-agent`, `tests/test_middleware.py:73`), a bare
directive: `# noqa: RUF001` — a linter constraint on a non-ASCII literal, with no
reason recorded.

**WJ — workaround justification** (`pupkeep`, `src/server/agent/state.ts:118`):
*"A macrotask, not a microtask: `subscribeCommits` runs while the commit is being
adopted, and this read must not queue on the mutation line the commit still
holds."* Code shape (which queue to use), hazard named (queueing on a held
mutation line).

**WJ — workaround justification** (`analytics-agent`,
`app/manager/graph.py:331`): *"A transient `LLMError` retries bounded (shared
budget); exhausting the budget, or unusable output, degrades to no follow-up
(recorded in `inspect_error`) instead of failing the run — the report stays
achievable from the sub-analysis evidence, and this stage is optional by intent
(D009)."* Error-path shape, rejected alternative named ("instead of failing the
run").

**N — narration** (`pupkeep`, `test/pwa.test.ts:980`): *"=== app.js scheduling
=== … app.js has no build step and no module mocking; the test strips its imports
(their behaviour is the fake store's) and runs the rest against a fake DOM."* A
banner plus a description of the harness.

**N — narration** (`analytics-agent`, `app/manager/graph.py:145`), a one-line
docstring: *"Runtime dependencies injected into the manager graph."*

## 5. Arithmetic and decision

R13's criterion is on the **sample**: a stratified sample of 30 per project, and
20% or more workaround justification justifies a comment experiment. The
design-weighted estimate is reported beside it because the draw over-samples S in
`analytics-agent` (10 of 30 units, against 63 of 962 in the population), so the
sample could exaggerate a stratum's weight; the estimate is what the same rates
give over the whole inventory.

**`pupkeep`** — S pool empty, so 10 T + 20 O:

* sample: 7 ÷ 30 = **0.2333** = 23.3% ≥ 20% → **threshold met**
* weighted: (1349 × 2/10 + 2267 × 5/20) ÷ 3616 =
  (269.80 + 566.75) ÷ 3616 = 836.55 ÷ 3616 = **0.2313** = 23.1%

**`analytics-agent`** — 10 S + 10 T + 10 O:

* sample: 1 ÷ 30 = **0.0333** = 3.3% < 20% → **threshold not met**
* weighted: (63 × 0/10 + 310 × 1/10 + 589 × 0/10) ÷ 962 =
  31.0 ÷ 962 = **0.0322** = 3.2%

Both readings agree in both projects, so the decision does not depend on the
sample-versus-population question. It does depend on the classification of two
`pupkeep` units, so here is the full sensitivity table:

| reading | `pupkeep` sample | `pupkeep` weighted | threshold | `analytics-agent` |
|---|---|---|---|---|
| **primary** — code-shape justification, error paths included | **7/30 = 23.3%** | 23.1% | **met** | 1/30 = 3.3% |
| one error-path unit excluded (`PU-2350ecce` or `PU-11ebe87d`) | 6/30 = 20.0% | 19.4% | met on the sample, not on the estimate | unchanged |
| both excluded (defect/hazard workarounds only) | 5/30 = 16.7% | 15.7% | not met | unchanged |
| bare checker directives counted as WJ (R8's "workaround" reading) | unchanged | unchanged | met | 7/30 = 23.3%, weighted 7.2% |

The last row is the mirror of the draft's own sensitivity note, with corrected
numbers: if a bare `# type: ignore` counts as "workaround-related", `analytics-agent`
crosses 20% *in the sample* while its population estimate stays at 7.2%, because
suppression-adjacent units are only 63 of 962 there. That reading fails the
ordinary meaning of "justification" — a directive with no reason states no
reason — and it is not the one used.

## 6. What changed from the draft, and from the reviewer's corrections

The draft's method — fixed seeds, published IDs, disclosed empty stratum,
unweighted plus weighted estimates, a sensitivity note — was sound and is kept.
Its inventory numbers do not survive re-derivation, and neither does one of the
corrections I was given. Every number below was re-derived by the script in this
branch.

| claim | draft | re-derived here |
|---|---|---|
| `pupkeep` in-scope files | 218 | **216** first-party (220 tracked with those extensions, minus the 4 vendored `web/vendor/*.mjs` the draft said it excluded but counted) |
| `pupkeep` comment units | 3,554 | **3,616** |
| `pupkeep` S / T / O | 0 / 1,175 / 2,379 | **0 / 1,349 / 2,267** |
| `analytics-agent` in-scope files | 83 | **86** (the draft's directory list dropped `.devcontainer/*.sh` and `pi-session.sh`) |
| `analytics-agent` comment units | 929 | **962** (324 of them docstrings) |
| `analytics-agent` S / T / O | 56 / 289 / 584 | **63 / 310 / 589** |
| `analytics-agent` directive lines | 63, "mostly in `tests/`" | **49 in 13 files: 44 in `analytics-agent/tests/`, 5 in `analytics-agent/app/`** — "mostly in tests" was right |
| `pupkeep` suppressions | 0 | **0** ✓ |
| decision | 10% / 10%, no experiment | **23.3% `pupkeep` (met), 3.3% `analytics-agent` (not met)** |

Two of the corrections I was given need correcting themselves, and one draft
claim turns out to be half right. These are stated because a later reader will
otherwise re-inherit them:

1. **"There are 49 directive lines and none in `tests/` — all in `app/`, `db/`,
   `scripts/`."** The count (49) is right. The location is not: 44 of the 49 are
   in `analytics-agent/tests/`, and none are in `db/` or `scripts/`. The nine
   files are `test_agent_components.py`, `test_analytics_tools.py`,
   `test_evaluation.py`, `test_manager_graph.py`, `test_manager_inspect.py`,
   `test_mcp_concurrency.py`, `test_metadata_tools.py`, `test_middleware.py`,
   `test_tools.py`.
2. **"Its S pool of 56 is larger than the directive lines that exist, so it is
   impossible."** Adjacency legitimately yields more S units than directive
   lines, because one directive inside a ±3-line window pulls several
   neighbouring units into S. This re-derivation finds **63 S units from 49
   directive lines** with the same rule. The draft's 56 was therefore not
   disqualified by that argument; its directive-line count was wrong, which is a
   different charge.
3. **"63 raw directive lines, mostly in `tests/`" (the draft's own figure).**
   Half right: the location holds, the count does not — it is 49 lines, 44 of
   them in `tests/`.

Two further consequences of re-deriving the inventory:

* **The draft's sample is not this sample.** Its IDs are sequential indices
  (`PU-0819`), so they shift with the inventory; with 3,554 versus 3,616 units
  and different strata pools, the same index is a different comment. This audit
  draws fresh, content-addressed IDs from the published seeds and labels are
  pinned to text hashes. No inherited number — including the 10%/10% decision —
  was carried over.
* **The draft's conclusion does not survive the re-draw.** It found 3/30 in both
  projects; this draw finds 7/30 in `pupkeep` and 1/30 in `analytics-agent`. Part
  of that is the draw (30 units is a small sample: one unit is 3.3 percentage
  points), and part is a stated difference in what counts as a workaround (the
  draft's WJ required "rather than"/"without that call" phrasing; this audit
  also admits a comment that justifies an error path for the same reason). The
  sensitivity table above is the bridge between the two.

## 7. What could not be verified, and confidence

**Confidence in the inventory: high.** Every file count is a `git ls-files` line
count, the Python extraction matches CPython exactly on all 79 files, and the
JS/CSS/shell/SQL markers were reconciled against independent greps (§2.6). The
one scanner limitation left is that a `//` inside a regex literal that my
heuristic mistakes for division could hide a comment; the marker reconciliation
found no such case, and the 154 surviving markers are all inside strings,
templates or regexes.

**Confidence in the sample: high.** The draw is deterministic and published;
running the script twice produces byte-identical output, and the labels file is
pinned to text hashes so an edited comment fails the join.

**Confidence in the classification: moderate, and it is the part that decides the
ticket.** One rater (me), no second labelling, no inter-rater agreement. Points a
reader should push on, in the order they matter:

1. **`PU-2350ecce`** (`src/server/agent/growth-tools.ts:95`) — "The domain's
   refusal is a sentence the model must repeat, not retry blindly; anything else
   is a real failure and surfaces as one." Called **WJ** as a justification of a
   narrow catch. A reader who sees ordinary error-type discrimination here
   counts 6/30.
2. **`PU-11ebe87d`** (`src/server/app.ts:597`) — "… A failure is not fatal: the
   events stay in the hot document and the next boot retries." Called **WJ** as a
   justification of a swallowed error. A reader who treats archiving as a feature
   rather than a dodge also counts 6/30. Excluding both gives 5/30 and flips the
   decision.
3. **`PU-088ae9e6`** (`src/server/reminders/appointment-schedule.ts:1`), a
   26-line module header. Called **I** — its primary assertion is a rule set
   (atomicity, "the instant is never stored", "no task is ever created from a tool
   call"). One of its paragraphs does justify a best-effort retirement ("costs
   nothing but a task that wakes to change its mind"), so a rater who counts by
   content share rather than primary assertion would score one more WJ.
4. **`PU-2acc1a74`** (`web/store.js:1`) and **`AA-170a75f7`**
   (`app/config.py:127`) are the two units closest to the I/WJ line: both state a
   constraint and then justify it. Both are I and E respectively here; neither
   changes a decision.
5. **Test comments.** Docstrings that name the property a test pins are **I**
   (`AA-45bf5851`), inline comments that restate the assertion are **I** when they
   name the property (`AA-4e45e6f1`) and **N** when they merely restate the setup
   (`PU-6ff40e07`). That line is a judgement, and it moves N-versus-I counts, not
   the WJ percentage.

**What was not read:** 4,518 of the 4,578 units. Only the 60 sampled units were
read with source context; the population totals they scale up to were counted
mechanically. This is what a sample is for, but it means a unit misclassified by
the *text* rules — a comment whose class depends on code outside the ±4-line
window — would not be caught.

**Not covered by this audit:** documentation and Markdown, generated evaluation
results, CSV/JSON data, HTML, configuration files, and the vendored trees. The
conclusions apply to first-party source comments only.

## 8. Reproducing

```bash
cd <this repo>                                   # a worktree is fine
node tools/comment-audit.mjs                     # inventory, strata, draw, counts, decision
node tools/comment-audit.mjs --json              # the same data, machine-readable
node tools/comment-audit.mjs --sample-only       # just the draw, for re-labelling
node tools/comment-audit.mjs --context 4         # the draw with 4 lines of source around each unit
```

Roots default to the two paths in the table at the top and can be overridden
with `--pupkeep=/path --analytics=/path` or
`COMMENT_AUDIT_PUPKEEP` / `COMMENT_AUDIT_ANALYTICS`. The only command run against
a target is `git ls-files`; files are opened read-only; nothing is written inside
either project. Exit codes: `0` ok, `1` the labels file disagrees with the
inventory (missing label, stale text hash, unknown ID), `2` usage error or a
target root that is not a git checkout.

Re-running the extraction and recounting is the ticket's validation step, and it
is two commands: run the script, compare its `counts:` and `weighted:` lines with
§4 and §5.

## Appendix: every sampled unit

`stratum`: S suppression-adjacent, T timer/retry/async-adjacent, O ordinary.
`class`: I invariant, E external quirk, WJ workaround justification, N narration.
Line numbers are where each unit starts at the audited revision.

### pupkeep

Pools: S=0 T=1349 O=2267; drawn S=0 T=10 O=20.

| ID | stratum | file:line | class | why this class |
|---|---|---|---|---|
| `PU-03c9dfbc` | O | `web/meals.js:60` | I | defines the return shape and the rule that `today` is derived locally, not taken from the response |
| `PU-088ae9e6` | O | `src/server/reminders/appointment-schedule.ts:1` | I | module header enumerating the atomicity and "never stored" rules; one paragraph inside it justifies best-effort retirement, but the primary assertion is the rule set |
| `PU-1075ede1` | O | `src/shared/training.ts:63` | I | defines the no-op condition a refusal checks |
| `PU-10c8f894` | T | `src/server/notifications/outbox.ts:37` | I | defines the retry schedule the constant encodes (first delay, doubling, cap) |
| `PU-11ebe87d` | T | `src/server/app.ts:597` | WJ | justifies swallowing the archive failure ("a failure is not fatal ... the next boot retries"); the shape is an error path, not the feature |
| `PU-120b4a65` | O | `src/shared/domain.ts:151` | I | states the id-stability contract and who depends on it |
| `PU-2350ecce` | T | `src/server/agent/growth-tools.ts:95` | WJ | justifies the narrow catch ("must repeat, not retry blindly; anything else ... surfaces") |
| `PU-23ee5b94` | O | `test/launcher.test.ts:21` | WJ | the double exists so stop() does not wait out a 3 s escalation — a test workaround for real behaviour |
| `PU-2632e0da` | O | `src/launcher/main.ts:403` | I | states the precondition the guard encodes (a cloudflare start already started the tunnel) |
| `PU-2acc1a74` | O | `web/store.js:1` | I | states the module's architectural constraints: no framework, no build step, no offline writes |
| `PU-304acc39` | T | `src/server/domain/household.ts:42` | I | documents the error's meaning and the caller's remedy |
| `PU-3fc1ed4e` | O | `src/server/domain/walks.ts:157` | WJ | justifies the redundant validation ("backstop, not the primary check ... fails boot") |
| `PU-4110ca09` | O | `web/views/pup.js:286` | I | states the condition under which a same-revision update is still applied |
| `PU-6ff40e07` | T | `test/profile.test.ts:245` | N | narrates the test scenario (a clock correction) rather than stating a product rule |
| `PU-843aca7d` | O | `src/server/agent/state.ts:118` | WJ | justifies macrotask-over-microtask by the queueing hazard it avoids |
| `PU-954c7a2a` | O | `test/approvals.test.ts:69` | N | restates what the fixture literal means |
| `PU-9805b3e7` | O | `web/style.css:1224` | I | states the no-colour-only rule the CSS implements |
| `PU-9ca87f27` | O | `src/server/domain/calendar.ts:390` | I | contract of a union variant: what the "stale" answer carries and why the record travels with it |
| `PU-9eb5abe0` | O | `src/server/http.ts:1505` | I | states the wire contract: one 200 for both terminal kinds, `replayed` as the flag |
| `PU-b38f59fd` | O | `test/feeding.test.ts:193` | I | states a non-invariant that must hold: append order is not chronological |
| `PU-b95bedf9` | T | `src/server/domain/feeding.ts:392` | I | states the archive contracts: one commit, nothing dropped, idempotent, retry-safe |
| `PU-cb876781` | T | `src/server/json-file.ts:28` | N | restates what the exported helper does |
| `PU-cef2958e` | O | `web/views/pup.js:430` | WJ | justifies the pending-key design by the failure it survives (the request may have committed) |
| `PU-dc30b534` | T | `src/server/http.ts:1368` | I | rule about the actionId namespace and what it prevents |
| `PU-de1fa789` | O | `src/shared/domain.ts:660` | I | field contract: which kinds carry it and what it names |
| `PU-e410e60c` | O | `src/shared/domain.ts:696` | I | field contract: present exactly when the status is confirmed |
| `PU-e652686c` | O | `src/shared/growth-trend.ts:335` | WJ | justifies the single text rendering by the copy/headline drift a second one causes |
| `PU-eff963ad` | T | `test/showers.test.ts:197` | N | states the premise of the assertion rather than a product rule |
| `PU-f7fb2a8f` | T | `test/pwa.test.ts:980` | N | section banner plus a description of how the test harness works |
| `PU-fad94a3c` | O | `test/termux-scripts.test.ts:523` | E | the code's shape follows from dpkg prompting with nobody at the phone — an environment/tool constraint |

### analytics-agent

Pools: S=63 T=310 O=589; drawn S=10 T=10 O=10.

| ID | stratum | file:line | class | why this class |
|---|---|---|---|---|
| `AA-0836fb1e` | S | `analytics-agent/tests/test_agent_components.py:166` | E | bare `# type: ignore[attr-defined]` — a checker directive with no reason stated |
| `AA-09804fe9` | S | `analytics-agent/tests/test_agent_components.py:848` | I | states the contract the test pins: .env resolves from the project root |
| `AA-1016b5b2` | O | `analytics-agent/app/agent/state.py:30` | N | restates what the two state fields hold |
| `AA-119e1f7b` | O | `analytics-agent/app/manager/graph.py:145` | N | one-line restatement of the class name |
| `AA-170a75f7` | O | `analytics-agent/app/config.py:127` | E | the option exists because of external model families and gateway billing; the "keeps its exact previous request shape" clause is rationale, not the subject |
| `AA-267147b5` | T | `analytics-agent/tests/test_agent_components.py:294` | E | justifies the assertion by the external llama.cpp launch flag (--reasoning on) |
| `AA-27e22087` | T | `analytics-agent/app/manager/graph.py:331` | WJ | justifies degrading instead of failing the run ("instead of failing the run — the report stays achievable") |
| `AA-37066582` | T | `analytics-agent/app/manager/entrypoint.py:168` | I | API contract: additive, keyword-only, fail-open, identical with no sink |
| `AA-45bf5851` | S | `analytics-agent/tests/test_agent_components.py:93` | I | states the property under test: a search-only failure completes schema-only |
| `AA-4bfe6d80` | S | `analytics-agent/tests/test_tools.py:91` | I | states the property under test: non-SQL failures keep the generic message |
| `AA-4e45e6f1` | T | `analytics-agent/tests/test_agent.py:301` | I | states the retry accounting the assertion pins (discovery once, retry to SQL) |
| `AA-52a0e270` | O | `analytics-agent/tests/test_agent_components.py:326` | I | states the rule behind the assertion: the local path is unauthenticated by design |
| `AA-58a9ac2b` | T | `analytics-agent/tests/test_metadata_database.py:1` | N | module docstring describing the file and how it skips |
| `AA-71dd9538` | S | `analytics-agent/tests/test_agent_components.py:960` | E | bare `# type: ignore[no-untyped-def]` on a stub method |
| `AA-74d929df` | T | `analytics-agent/tests/test_manager_graph.py:477` | I | names the property: every call is attributed, zero unattributed |
| `AA-7ce54b2f` | O | `analytics-agent/tests/test_web_app.py:1` | I | scope boundary: what the suite pins and what it does not prove |
| `AA-a2bbe955` | O | `analytics-agent/app/manager/state.py:1` | N | describes what the module holds |
| `AA-a5f79d2e` | T | `analytics-agent/app/manager/graph.py:551` | I | routing rules: transient failure retries; a completed or violating report ends the run |
| `AA-af6c81f7` | S | `analytics-agent/tests/test_agent_components.py:139` | E | bare `# type: ignore[no-untyped-def]` on a stub function |
| `AA-b0ac9938` | T | `analytics-agent/tests/test_mcp_concurrency.py:192` | E | the stub blocks on purpose to mimic external ONNX inference cost |
| `AA-c27338ce` | S | `analytics-agent/tests/test_metadata_tools.py:190` | E | bare `# type: ignore[assignment]` on a monkeypatched private function |
| `AA-ca4ae95c` | O | `analytics-agent/tests/test_agent.py:451` | I | states the sequence-number invariant the assertion pins |
| `AA-d2c217a8` | O | `analytics-agent/tests/test_agent_components.py:783` | I | states what the config must contain when tracing is enabled |
| `AA-db6408c4` | S | `analytics-agent/tests/test_agent_components.py:235` | E | bare `# type: ignore[no-untyped-def]` on a stub method |
| `AA-decf0e2b` | T | `analytics-agent/tests/test_mcp_concurrency.py:138` | I | states the property under test: the seeding client honours DB_POOL_MAX_SIZE |
| `AA-e15a794e` | T | `analytics-agent/app/agent/capabilities.py:44` | N | one-line restatement of the protocol's name |
| `AA-e6736fb5` | O | `analytics-agent/tests/test_manager_progress.py:459` | I | states the rule the test pins: a nested producer cannot relabel its own event |
| `AA-e7a055ae` | S | `analytics-agent/tests/test_agent_components.py:952` | I | states the property at the public seam: status, answer and error unaffected |
| `AA-ed590d74` | S | `analytics-agent/tests/test_middleware.py:73` | E | bare `# noqa: RUF001` on a non-ASCII literal |
| `AA-ef86bd6c` | O | `analytics-agent/tests/test_web_app.py:547` | N | section banner |
