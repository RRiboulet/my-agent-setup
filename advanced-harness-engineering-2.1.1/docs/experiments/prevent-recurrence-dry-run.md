# prevent-recurrence dry run

A manual run of the skill's process on a fixture correction, recorded because the
skill's judgement cannot be unit-tested. This is ticket 03's dry run; the first
real conversion is `analytics-agent` (ticket 07).

Date: 2026-11-20. Fixture: `/tmp/prevent-recurrence-dry-run`, a scratch git
repository outside this checkout.

## The fixture

The class: outbound HTTP is imported from `app.legacy_http` instead of the
retry-aware `app.http.fetch`.

The fixture records three occurrences in `docs/recurrences.md` — `app/reporting.py`
on 2026-11-05, `app/billing.py` on 2026-11-18, and `app/shipping.py` on
2026-11-20 — so the class has repeated. The first two are already fixed at the
bad revision; the third is the correction being handled. The evidence file is
part of the fixture, so the *dates and review comments are simulated*; the code,
the commands and the exit codes are real.

| Revision | SHA | What it is |
|---|---|---|
| bad | `00bff57` | `app/shipping.py` imports `app.legacy_http.fetch`; no rule exists yet |
| good | `a9d2836` (`HEAD`) | `app/shipping.py` uses `app.http.fetch`; `TID251` bans the legacy import; the proof file and the table row are added |

The fixture already had Ruff in its development environment, as a Python project
with a lint gate does. It was installed in the fixture's `.venv`
(`python3 -m venv .venv && .venv/bin/pip install ruff==0.17.6`); it is not a
dependency of this repository and nothing in this change's gate runs it.

## 1. Trigger and inputs

- Input: the current correction, plus `docs/recurrences.md` naming the two
  earlier ones. A review comment or a fix commit would be the normal evidence;
  the fixture stands in for both.
- Class in one sentence: **outbound HTTP uses `app.legacy_http.fetch` instead of
  the retry-aware `app.http.fetch`.**
- Repeat confirmed: three occurrences of the same class in 15 days. Proceed.
- The cause is visible in the bad line, so no `diagnosing-bugs` pass was needed.
  In a real run with an unconfirmed cause, the check would be encoding a guess.

## 2. Level: lint, and why not higher

- **Architecture — not available.** Deleting `app.legacy_http` or making it
  unimportable is the right end state, but the module is still the client used by
  an unmerged export branch; removing it in this correction would break that
  branch, and hiding it is a repository-wide change, not a fix for this class.
- **Type — not available.** Python has no compile-time import ban, the project
  has no type-check gate, and a `Protocol` or a newtype cannot reject an import
  statement. The bad state is the import itself.
- **Lint — chosen.** The offending line alone proves the violation: the review
  question is "could a reviewer decide from `from app.legacy_http import fetch`
  that this is wrong, with nothing run?" Yes. Ruff is already the project's
  linter, and `TID251` is a stock rule, so this is configuration, not a new tool
  or a local AST rule.
- **Test — not needed.** The legacy client works, so there is no failing behavior
  to pin; a test would have to assert the import, which is a lint with extra
  steps.
- **Prose — not chosen.** A check decides this class; there is no judgement call.

Existing tool first: `TID251` (stock Ruff rule, parameterized) before an ast-grep
rule or a project test. No tool was added to the fixture beyond the Ruff it
already used.

## 3. The check

The good revision adds this to `pyproject.toml`:

```toml
[tool.ruff.lint]
extend-select = ["TID251"]

[tool.ruff.lint.flake8-tidy-imports.banned-api]
"app.legacy_http".msg = "Use app.http.fetch (it sets the timeout and records the retry), not app.legacy_http."
```

The `msg` names the replacement, not just the ban. The rule is added by the fix
revision, which matters for the proof: checking out `00bff57` on its own would
run a configuration with no ban and pass for the wrong reason. The bad run below
carries the fixed `pyproject.toml` into a worktree of the bad revision.

## 4. Proof at both revisions

Good, from the fixture root at `a9d2836`:

```bash
$ .venv/bin/ruff check --select TID251 app/
All checks passed!
$ echo $?
0
```

Bad, in a scratch worktree of `00bff57` with the fixed config:

```bash
$ git worktree add /tmp/bad-check 00bff57
$ cp pyproject.toml /tmp/bad-check/
$ (cd /tmp/bad-check && /tmp/prevent-recurrence-dry-run/.venv/bin/ruff check --select TID251 app/)
TID251 `app.legacy_http` is banned: Use app.http.fetch (it sets the timeout and records the retry), not app.legacy_http.
 --> app/shipping.py:1:1
  |
1 | from app.legacy_http import fetch
  | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

Found 1 error.
$ echo $?
1
```

Both runs use the same enforcer command, `.venv/bin/ruff check --select TID251
app/`. The only difference is which tree it runs in; the config comes from the
fixed revision in both.

The proof file, `docs/proof/legacy-http.md`:

````markdown
# Proof: outbound HTTP uses app.http.fetch

Class: outbound HTTP is imported from `app.legacy_http` instead of the
retry-aware `app.http`.

- Bad revision `00bff57`: `.venv/bin/ruff check --select TID251 app/` → exit 1
- Good revision `HEAD`: `.venv/bin/ruff check --select TID251 app/` → exit 0

The bad run used the fixed revision's `pyproject.toml` in a scratch worktree of
`00bff57`, because the rule did not exist at the bad revision. Reproduce:

```bash
git worktree add /tmp/bad-check 00bff57
cp pyproject.toml /tmp/bad-check/
(cd /tmp/bad-check && /tmp/prevent-recurrence-dry-run/.venv/bin/ruff check --select TID251 app/)  # exit 1
.venv/bin/ruff check --select TID251 app/                                                       # exit 0
```

Environment: ruff 0.17.6 in the fixture's `.venv`; Ruff is a fixture dependency,
not a dependency of the harness repository.
````

The proof file says `HEAD` rather than its own SHA because it is committed in the
good revision and cannot contain that commit's SHA. `a9d2836` was `HEAD` at the
run. A real conversion whose proof lands in a later commit should name the fixed
SHA instead; if the proof and the fix land together, say that the good revision
is the commit carrying the proof.

## 5. Ratchet

None. The third occurrence was the only remaining violation, so the fix removes
it and the check exits 0 at the good revision. If other modules still imported
the legacy client, the proof and the report would name a baseline path and the
count it started at, and the baseline could only shrink.

## 6. Table row

`AGENTS.md` in the fixture gained one row under `## Rules and enforcement`:

```markdown
| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| Outbound HTTP uses app.http.fetch, never app.legacy_http | lint | `.venv/bin/ruff check --select TID251 app/` | `docs/proof/legacy-http.md` |
```

The rule names the class, the enforcer is the command that fails, and the proof
is a path that exists. There is no prose row, because the rule is enforced.

## 7. Checker

The fixture vendors the checker, because a project's gate cannot call a path into
the harness:

```bash
cp <skill>/scripts/rule-table.mjs tools/rule-table.mjs
sha256sum tools/rule-table.mjs
# 9ab0994ddab7d256f654791fb6d89a8f315d577b092ceae83a82887d90645822
```

`tools/rule-table.version` records the contract version and hash:

```text
contract-version: 1
sha256: 9ab0994ddab7d256f654791fb6d89a8f315d577b092ceae83a82887d90645822
source: advanced-harness-engineering .pi/skills/prevent-recurrence/scripts/rule-table.mjs
```

Run from the fixture root:

```bash
$ node tools/rule-table.mjs check AGENTS.md
AGENTS.md: 1 rule row valid
$ echo $?
0
```

`--json` confirms the row and the mode:

```json
{
  "checker": "rule-table",
  "version": 1,
  "path": "/tmp/prevent-recurrence-dry-run/AGENTS.md",
  "ok": true,
  "git": true,
  "rows": [
    {
      "row": 1,
      "line": 7,
      "rule": "Outbound HTTP uses app.http.fetch, never app.legacy_http",
      "level": "lint",
      "enforcedBy": "`.venv/bin/ruff check --select TID251 app/`",
      "proof": "`docs/proof/legacy-http.md`"
    }
  ],
  "violations": [],
  "summary": { "rows": 1, "violations": 0 }
}
```

## 8. The report the skill hands back

```text
Rule: outbound HTTP uses app.http.fetch, never app.legacy_http
Evidence: 2026-11-05 app/reporting.py (PR 41); 2026-11-18 app/billing.py (PR 57);
          2026-11-20 app/shipping.py
Level: lint
Why not higher: architecture — deleting the legacy client would break the
  unmerged export branch that still uses it; type — Python has no compile-time
  import ban and the project has no type-check gate
Check: pyproject.toml TID251 ban — `.venv/bin/ruff check --select TID251 app/`
Proof: 00bff57 → exit 1; a9d2836 (HEAD) → exit 0 (file: docs/proof/legacy-http.md)
Ratchet: none: the third occurrence was the only remaining violation
Table row: AGENTS.md line 7
Checker: node tools/rule-table.mjs check AGENTS.md → exit 0
Open work: Ruff 0.17.6 lives in the fixture's .venv, not in the harness; the
  legacy module stays for the export branch; no suppression was added
```

## What this proves, and what it does not

It proves the process is executable: a real enforcer exits 1 at the recorded bad
revision and 0 at the fixed one, both commands and exit codes are written down, a
row validates against the checker, and the checker exits 0. The level decision
was made against the ladder and the lint-locality test, not picked first.

It does not prove the judgement quality. The fixture's repeat evidence is
simulated, the class was chosen to have a clean lint, and `TID251` is the easy
case: a stock rule, a one-line message, no baseline. The first real conversion
is a semantic Python bug where the honest answer may be a test or a type; that is
the test this dry run cannot provide. It is also not a benchmark: no timing
claim is made, and the load average at the end was `0.40 0.54 0.50`.

The checker is static. It validated the row's shape and the proof file's
existence; it did not rerun Ruff. The two commands above are the evidence, and a
reviewer should rerun them.
