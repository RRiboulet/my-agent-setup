# Rule table format and checker contract

The rule table is the single source of truth for the rules a repository enforces
with a check. `AGENTS.md` holds it; there is no parallel JSON registry.

`scripts/rule-table.mjs` validates the table. It is one Node-standard-library
file — no dependencies, no network — and it validates structure and references
only. It never executes a proof command: the project's own gate runs the proofs,
the checker confirms a proof is recorded and still points at something real.

```
node skills/prevent-recurrence/scripts/rule-table.mjs check AGENTS.md
node skills/prevent-recurrence/scripts/rule-table.mjs check --json AGENTS.md
node skills/prevent-recurrence/scripts/rule-table.mjs --help
```

A project that vendors the checker puts this file in its own `tools/` and records
the version or hash it vendored (`version` in `--json` output is the contract
version, not the file hash).

## The table

Exactly one heading, with at most three leading spaces:

```markdown
## Rules and enforcement
```

Under it — blank lines allowed, nothing else in between — a GitHub-flavoured
markdown table with a separator row:

```markdown
| Rule | Level | Enforced by | Proof |
|---|---|---|---|
| A branch descends from origin/dev | test | `node tools/branch-base.mjs` | `tools/branch-base.md` |
| Every rule has an owner | prose | judgment: ownership is a human fact | `tools/owners.md` |
```

The heading is matched literally and case-sensitively. A heading inside a fenced
code block is an example and is ignored; a fence is indented by at most three
spaces, since four make an indented code block in CommonMark.

The separator row must have the same number of cells as the header, and a cell
may be as short as one hyphen (`|-|-|-|-|` is valid). Nothing else may follow the
table before the next heading: a second table is `content-after-table`, and a
first line that looks like a row but lacks its leading pipe is
`row-missing-pipe`. GitHub would drop both silently, so the checker does not.

### Columns

All four are required, in any order. Extra columns are ignored. Column names may
be plain, in code spans, or bold, and are matched case-insensitively.

| Column | Required content | Rejected when |
|---|---|---|
| `Rule` | Free text naming the rule | empty (`empty-rule`); a duplicate of an earlier row (`duplicate-rule`) |
| `Level` | `architecture`, `type`, `lint`, `test`, `prose` | anything else (`unknown-level`) |
| `Enforced by` | the command that fails when the rule is broken, or `judgment: <reason>` for a `prose` row | empty, or a placeholder — `-`, `--`, `—`, `–`, `n/a`, `none`, `TBD`, `TBA` (`empty-enforcer`); a `prose` row without a `judgment:` prefix, or whose reason is empty, shorter than three characters, or itself a placeholder (`prose-without-judgment`) |
| `Proof` | a backticked path, or `bad=<ref> good=<ref>` | empty (`proof-empty`), both forms in one cell (`proof-mixed`), neither form or a pair not written exactly as `bad=<ref> good=<ref>` (`proof-format`), a path that does not exist (`proof-missing`), a malformed ref (`proof-ref-invalid`), a ref git cannot resolve (`proof-ref-missing`) |

Rules are compared for duplicates after trimming, collapsing whitespace, and
case-folding, so `No   Suppression` and `no suppression` are the same rule.
Levels and column names are compared after removing surrounding backticks and
bold markers and lowercasing. `judgment:` is matched case-sensitively, and the
reason after it must be a real answer — `judgment: -`, `judgment: tba` and
`judgment: tbd` are placeholders, not reasons.

A column cell may contain a code span with a pipe in it: a double-backtick span
such as the one in `Double ``a|b`` span` is one cell, not two.

A table with the four columns and zero data rows is valid — a repository may
adopt the heading before it has a rule.

### Proof

Two forms, both non-executable references:

- **A path.** One or more backticked code spans, e.g. `` `tools/proof.md` `` or
  `` `a.md` and `b.md` ``. Every span must exist and be a regular file. Paths resolve from the
  **directory containing the table file**, not the process's working directory.
  For a repository-root `AGENTS.md` that is the repository root; in a linked
  worktree it is the worktree root, never the main checkout.
- **A snippet pair.** `bad=<ref> good=<ref>`, naming the revision the check fails
  on and the revision it passes on. The cell must hold exactly that — the two
  halves separated by whitespace, nothing before or after — so
  `bad=X,good=Y`, a reversed pair and a pair buried in prose are all
  `proof-format`. Both are required, and a cell may not also carry a backticked
  path: one form per row (`proof-mixed`). When the table's directory is inside a
  git work tree **with history**, each ref is resolved with
  `git rev-parse --verify <ref>^{commit}`; a ref that does not resolve is a
  violation. Without git history — no work tree, or a fresh `git init` with no
  commits — only the format is checked: no whitespace, no `..`, no
  `~ ^ : ? * [ \`, no leading `-`, at most 255 characters.

`--json` reports which mode ran in its `git` field.

## Output

Human output is one line per violation, and exit 1:

```
AGENTS.md:14: row 2: unknown-level: level "review" is not one of architecture, type, lint, test, prose
```

The prefix is the path as you passed it, the line in the file, then the table row
(1-based, data rows only) when the violation belongs to a row. A valid table
prints one line and exits 0:

```
AGENTS.md: 4 rule rows valid
```

Usage errors print to stderr, print no report, and exit 2.

| Exit | Meaning |
|---|---|
| 0 | the table is valid |
| 1 | at least one violation |
| 2 | bad invocation: no command, unknown command or option, missing or unreadable path, a directory |

## `--json`

One JSON object on stdout, nothing else. Same exit codes; a violation still exits
1. The fields are stable and `version` bumps when they change.

```json
{
  "checker": "rule-table",
  "version": 1,
  "path": "/abs/path/AGENTS.md",
  "ok": false,
  "git": true,
  "rows": [
    {
      "row": 2,
      "line": 14,
      "rule": "Public errors carry their cause",
      "level": "review",
      "enforcedBy": "`node tools/errors.mjs`",
      "proof": "`tools/errors.md`"
    }
  ],
  "violations": [
    {
      "code": "unknown-level",
      "row": 2,
      "line": 14,
      "rule": "Public errors carry their cause",
      "message": "level \"review\" is not one of architecture, type, lint, test, prose"
    }
  ],
  "summary": { "rows": 1, "violations": 1 }
}
```

| Field | Meaning |
|---|---|
| `checker` | always `rule-table` |
| `version` | contract version, currently `1` |
| `path` | absolute path of the table file |
| `ok` | `true` when `violations` is empty |
| `git` | `true` when the table's directory is inside a git work tree with history, so snippet refs were resolved; `false` when only their format was checked |
| `rows` | every parsed data row, in file order; `row` is the 1-based table row, `line` the 1-based file line; cell text is verbatim after trimming |
| `violations` | empty, or one object per problem, sorted by line then row |
| `violations[].code` | stable identifier, listed below |
| `violations[].row` | table row, or `null` for a table-level problem |
| `violations[].line` | file line the problem is reported at |
| `violations[].rule` | the row's rule text, or `null` |
| `violations[].message` | the reason, without the file/line prefix |
| `summary` | `{ rows, violations }` counts |

### Violation codes

| Code | Meaning |
|---|---|
| `missing-heading` | no `## Rules and enforcement` heading |
| `duplicate-heading` | a second `## Rules and enforcement` heading |
| `no-table` | the heading is not followed by a table |
| `no-separator` | the header has no `\|---\|` separator row |
| `separator-count` | the separator's cell count differs from the header's |
| `content-after-table` | a second table follows the rule table before the next heading |
| `row-missing-pipe` | a row-like line follows the table without its leading `\|` |
| `missing-column` | a required column is absent from the header |
| `duplicate-column` | a required column appears twice |
| `column-count` | a row's cell count differs from the header's |
| `empty-rule` | the `Rule` cell is empty |
| `duplicate-rule` | the rule repeats an earlier row's |
| `unknown-level` | the level is not one of the five |
| `empty-enforcer` | `Enforced by` is empty or a placeholder |
| `prose-without-judgment` | a `prose` row lacks `judgment: <reason>`, or the reason is a placeholder |
| `proof-empty` | the `Proof` cell is empty |
| `proof-mixed` | the `Proof` cell holds both a backticked path and a `bad=`/`good=` pair |
| `proof-format` | neither a backticked path nor an exact `bad=<ref> good=<ref>` pair |
| `proof-missing` | a referenced proof path does not exist |
| `proof-not-file` | a referenced proof path exists but is not a regular file |
| `proof-ref-invalid` | a ref is not a valid git ref name |
| `proof-ref-missing` | git could not resolve the ref to a commit |

## What this does not check

The checker is static. It does not run the enforcer, so it cannot tell whether
the named command still fails at `bad=` and passes at `good=`, whether the proof
file still describes the current rule, or whether the rule belongs at the level
it claims. Those are the skill's report and the reviewer's job. A stale proof
that still exists passes; that risk is known and accepted.

## Tests

```
node --test skills/prevent-recurrence/scripts/test/*.test.mjs
```
