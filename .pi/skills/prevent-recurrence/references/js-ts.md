# JS/TS adapter

Recipes for the levels a JavaScript or TypeScript repository can enforce, for the
process in [../SKILL.md](../SKILL.md). Every command below was run on 2026-11-20
against two scratch projects — one for the lint recipes, one for the dependency
boundaries — with the versions stated at the end; the results are the exit codes
shown. Nothing here is added to this repository: the scratch projects installed
their own dev dependencies under `/tmp`, and the harness still consumes no npm
packages.

Order matters. Try a stock ESLint rule the project already configures before
`no-restricted-*`, a parameterized `no-restricted-*` rule before a local rule,
and a local rule before a new tool. A dependency direction belongs to
dependency-cruiser (or the boundaries plugin the project already runs), not to a
hand-written test over today's files. A tool the project does not already run is
a design decision, named in the report with its cost — not something this
adapter installs for you.

## `no-restricted-imports`: ban a module and name the replacement

Use when the class is "this module or member must not be imported", and the
import line alone proves it. It matches the **specifier string** — no
resolution, no `paths` from `tsconfig.json`, no type information — so a relative
import needs its own entry. An entry matches the exact specifier it names:
banning `@app/legacy-http` does not cover `@app/legacy-http/sub`, which needs its
own entry or the `patterns` group below.

```js
// eslint.config.js
export default [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // One module: the message names the replacement.
          paths: [
            {
              name: "@app/legacy-http",
              message:
                "Use @app/http (it sets the timeout and records the retry), not @app/legacy-http.",
            },
          ],
          // A family, when the replacement is one module for all of them.
          patterns: [
            {
              group: ["@app/legacy-*"],
              message:
                "Use @app/http (it sets the timeout and records the retry), not a legacy client.",
            },
          ],
        },
      ],
    },
  },
];
```

Bad (`examples/zero-code/bad-import.ts`):

```ts
import { fetchJson } from "@app/legacy-http";

export const body = fetchJson("/orders");
```

Good (`examples/zero-code/good-import.ts`):

```ts
import { fetchJson } from "@app/http";

export const body = fetchJson("/orders", { timeoutMs: 2000 });
```

```bash
npx eslint examples/zero-code/bad-import.ts    # exit 1
npx eslint examples/zero-code/good-import.ts   # exit 0
```

The bad run names the replacement:

```text
/home/.../examples/zero-code/bad-import.ts
  1:1  error  '@app/legacy-http' import is restricted from being used. Use @app/http (it sets the timeout and records the retry), not @app/legacy-http  no-restricted-imports

✖ 1 problem (1 error, 0 warnings)
```

The `patterns` form produces the same shape with `by a pattern` after
"restricted from being used" (verified, exit 1). A ban with no `message` is not
accepted by this skill: ESLint then prints only the banned specifier, which
tells the next agent what not to do but not what to do instead.

What it sees, verified on ESLint 10.15.0:

| Form | Flagged |
|---|---|
| `import { fetchJson } from "@app/legacy-http"` | yes, exit 1 |
| `import type { fetchJson } from "@app/legacy-http"` | yes, exit 1 |
| `export type Fetcher = import("@app/legacy-http").fetchJson` | **no**, exit 0 |

The inline `import("…")` type is not executed and not resolved, so it is not
covered — the same "for accidental use, not a security boundary" caveat the
Python adapter records for `importlib.import_module`. Add the type form as a
`no-restricted-syntax` selector if the class must include it.

## `no-restricted-syntax`: ban a form, not a module

Use when the wrong form is locally recognizable but no import line distinguishes
it: a call with a missing argument, a constructor standing in for an injected
service, a library's one unsafe overload. The selector is an esquery selector,
so it matches syntax, not meaning — it cannot see types or anything in another
file.

```js
// eslint.config.js
export default [
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Take the time from clock.now() in src/clock.ts (tests replace it), not new Date().",
        },
      ],
    },
  },
];
```

Bad (`examples/zero-code/bad-syntax.ts`) and good
(`examples/zero-code/good-syntax.ts`):

```ts
export const at = new Date();
```

```ts
import { clock } from "@app/clock";

export const at = clock.now();
```

```bash
npx eslint examples/zero-code/bad-syntax.ts    # exit 1
npx eslint examples/zero-code/good-syntax.ts   # exit 0
```

```text
/home/.../examples/zero-code/bad-syntax.ts
  1:19  error  Take the time from clock.now() in src/clock.ts (tests replace it), not new Date()  no-restricted-syntax

✖ 1 problem (1 error, 0 warnings)
```

The owner module (`src/clock.ts` above) is the one place allowed to break the
rule. Scope that exemption by path in the config rather than by an
`eslint-disable` comment, and say in the comment why the path is the owner:

```js
{
  // The owner module is the one place allowed to read wall-clock time.
  files: ["src/clock.ts"],
  rules: { "no-restricted-syntax": "off" },
}
```

That is not the suppression the skill forbids — it is the same "one owner"
shape as the architecture rung. An `eslint-disable` comment in the owner would
be indistinguishable from a suppression and would hide the next finding there.

A selector that only names the rule (`no-console: "error"`) is a coarse gate; add
the fix-naming message at the config layer, or write the local rule below when
the message has to be assembled.

## A local flat-config rule when the message must name the canonical file

Use when the parameterized rules are not enough: the message must name the
canonical module or symbol, or the fix is a suggestion a developer applies from
the editor. This is still the lint rung — the offending line proves the
violation — but the repository's own vocabulary is in the diagnostic.

The rule is one file, exported as an ESLint rule object. `meta.messages` holds
every string so nothing is assembled inline, `meta.hasSuggestions` is required
whenever `suggest` is returned, and `meta.schema` declares the options the rule
accepts (none here).

```js
// rules/no-direct-env-token.js
const CANONICAL_FILE = "src/config/db.ts";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "Read DATABASE_URL through src/config/db.ts, not process.env" },
    schema: [],
    hasSuggestions: true,
    messages: {
      direct:
        "Read DATABASE_URL through databaseUrl() in src/config/db.ts (it trims the pooling suffix and fails fast when the variable is missing), not process.env.",
      useAccessor: "Replace with databaseUrl(), imported from src/config/db.ts.",
    },
  },
  create(context) {
    // The canonical module is the one place allowed to read the variable.
    if (context.filename.replace(/\\/g, "/").endsWith(CANONICAL_FILE)) return {};

    const isProcessEnv = (node) =>
      node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      node.object.object.type === "Identifier" &&
      node.object.object.name === "process" &&
      node.object.property.type === "Identifier" &&
      node.object.property.name === "env";

    return {
      MemberExpression(node) {
        if (!isProcessEnv(node)) return;
        if (node.property.type !== "Identifier" || node.property.name !== "DATABASE_URL") return;
        context.report({
          node,
          messageId: "direct",
          suggest: [
            { messageId: "useAccessor", fix: (fixer) => fixer.replaceText(node, "databaseUrl()") },
          ],
        });
      },
    };
  },
};

export default rule;
```

Wired into a flat config under a plugin name — the report then reads
`local/no-direct-env-token`:

```js
// eslint.config.js
import noDirectEnvToken from "./rules/no-direct-env-token.js";

export default [
  {
    files: ["**/*.ts"],
    plugins: { local: { rules: { "no-direct-env-token": noDirectEnvToken } } },
    rules: { "local/no-direct-env-token": "error" },
  },
];
```

Bad (`examples/local-rule/bad-env.ts`) and good
(`examples/local-rule/good-env.ts`):

```ts
export const url = process.env.DATABASE_URL;
```

```ts
import { databaseUrl } from "@app/config/db";

export const url = databaseUrl();
```

```bash
npx eslint examples/local-rule/bad-env.ts    # exit 1
npx eslint examples/local-rule/good-env.ts   # exit 0
```

```text
/home/.../examples/local-rule/bad-env.ts
  1:20  error  Read DATABASE_URL through databaseUrl() in src/config/db.ts (it trims the pooling suffix and fails fast when the variable is missing), not process.env  local/no-direct-env-token

✖ 1 problem (1 error, 0 warnings)
```

The suggestion is in the machine-readable report, which is what an editor
applies:

```bash
npx eslint --format json examples/local-rule/bad-env.ts   # exit 1
```

The message object, abridged to the fields that matter (one entry of the file's
`messages` array):

```json
{
  "ruleId": "local/no-direct-env-token",
  "suggestions": [
    {
      "messageId": "useAccessor",
      "fix": { "range": [19, 43], "text": "databaseUrl()" },
      "desc": "Replace with databaseUrl(), imported from src/config/db.ts."
    }
  ]
}
```

Three limits, each verified:

- **Drop `hasSuggestions: true` and ESLint 10 exits 2**, not 1, with
  `Error: Rules with suggestions must set the meta.hasSuggestions property to true`.
  A crash is not a diagnostic: the rule must declare it.
- **`--fix` never applies a suggestion.** `--fix` on a suggestion-bearing finding
  leaves the file unchanged and still exits 1; `--fix-type suggestion` on its own
  exits 2, because ESLint requires `--fix` or `--fix-dry-run` beside it.
  Suggestions are applied by an editor, so CI cannot rely on the fix landing.
- **A suggestion replaces one node and cannot add an import.** The replacement
  above is only correct after `databaseUrl` is imported, which is why
  `useAccessor` says so in words. When the replacement needs an import, keep the
  suggestion and accept the follow-up, or emit it as a fix on the import line
  too — the API has no "insert import" primitive.

Keep the rule narrow. A local rule that also reports the canonical module, or any
member of a family it was not written for, catches unrelated code; narrow the
selector instead of adding a suppression.

## Dependency direction with dependency-cruiser

Use for the architecture rung: one module tree must not import another. The
offending line cannot prove it on its own — the direction only exists in the pair
— and a test written today does not cover a file added tomorrow, which is what a
contract is for.

```js
// .dependency-cruiser.js
/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "domain must import the port in src/domain/ports.ts, not src/adapters",
      severity: "error",
      comment:
        "Use the port in src/domain/ports.ts (the adapters implement it), not src/adapters directly: the domain must stay testable without a database.",
      from: { path: "^src/domain" },
      to: { path: "^src/adapters" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
```

Bad (`src/domain/user.ts`):

```ts
import { load } from "../adapters/db";

export function nameOf(userId: string): string {
  return load(userId);
}
```

Good (`src/domain/user.ts`, with `src/domain/ports.ts` next to it):

```ts
import type { UserStore } from "./ports";

export function nameOf(store: UserStore, userId: string): string {
  return store.load(userId);
}
```

```bash
npx depcruise src    # exit 1 with the bad domain, exit 0 with the port
```

The failing run:

```text

  error domain must import the port in src/domain/ports.ts, not src/adapters: src/domain/user.ts → src/adapters/db.ts

x 1 dependency violations (1 errors, 0 warnings). 4 modules, 3 dependencies cruised.
```

The pass:

```text
✔ no dependency violations found (4 modules, 3 dependencies cruised)
```

The fix-naming is in the rule **name**, because that is what the console reporter
prints — verified: the default `err` output names the rule and the module pair
and says nothing else. The `comment` is not attached to the violation in `-T
json` either (it is echoed once, in the rule set at
`summary.ruleSetUsed.forbidden[]`), and it reaches the violation only in the HTML
report (`npx depcruise src -T err-html -f report.html`, which contains the comment
and **exits 0** because it wrote a report). So: put the fix in the name, put the
long reason in `comment`, and never use the HTML output as the gate.

`dependency-cruiser` is a separate dependency. If the project already runs
`eslint-plugin-boundaries` or a hand-written layering test, that tool is the
existing-tool answer and this section is the shape to copy rather than a reason
to install a second one. The boundaries-plugin route was not run here and is not
claimed.

## Typed linting through typescript-eslint

Use when the class needs types: the line is legal and locally innocent, and only
the program knows it is wrong. The two that recur most are the ones a syntax rule
cannot see, because a promise is just an expression until its type is known.

```js
// eslint.config.js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The project service builds the program from tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
```

The project-service requirement, in full, because every failure mode here is
confusing:

- `projectService: true` (or `project: "./tsconfig.json"`) is what generates
  type information. **Without it the typed rule throws**, and ESLint exits 2:
  `You have used a rule which requires type information, but don't have
  parserOptions set to generate type information for this file`.
- **Every linted file must be in the tsconfig's `include`** (or in
  `parserOptions.allowDefaultProject`). A file outside it is a parsing error —
  `… was not found by the project service` — and ESLint exits 1, so a config
  file caught in the glob fails the gate for a reason that has nothing to do with
  the rule.
- **The TypeScript version must be inside typescript-eslint's peer range.** With
  `typescript@7.0.2` installed, typescript-eslint 8.73.0 refuses to run: it
  prints `typescript-eslint does not support TS 7.0.` with a link to running it
  on the TS 6 API, and exits 2. The runs below therefore use TypeScript 6.0.3.

Bad (`examples/typed/bad-floating.ts`) and good (`good-floating.ts`):

```ts
import { save } from "@app/save";

export function record(): void {
  save("order");
}
```

```ts
import { save } from "@app/save";

export async function record(): Promise<void> {
  await save("order");
}
```

Bad (`examples/typed/bad-misused.ts`) and good (`good-misused.ts`):

```ts
import { save } from "@app/save";

export async function markAll(ids: string[]): Promise<void> {
  ids.forEach(async (id) => {
    await save(id);
  });
  await save("done");
}
```

```ts
import { save } from "@app/save";

export async function markAll(ids: string[]): Promise<void> {
  for (const id of ids) {
    await save(id);
  }
  await save("done");
}
```

```bash
npx eslint examples/typed/bad-floating.ts    # exit 1
npx eslint examples/typed/good-floating.ts   # exit 0
npx eslint examples/typed/bad-misused.ts     # exit 1
npx eslint examples/typed/good-misused.ts    # exit 0
```

```text
/home/.../examples/typed/bad-floating.ts
  4:3  error  Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the `void` operator  @typescript-eslint/no-floating-promises
```

```text
/home/.../examples/typed/bad-misused.ts
  4:15  error  Promise returned in function argument where a void return was expected  @typescript-eslint/no-misused-promises
```

`void save("order")` passes `no-floating-promises` (verified, exit 0), but the
`void` operator is an acknowledgement, not a fix: the rejection is still
unhandled. Prefer `await` inside an async function or `.catch()` at the edge, and
treat a `void` as a suppression that has to say why.

Both rules have a stock message that does not name the replacement, which is why
the Python adapter calls them coarse gates. The replacement for a floating
promise is `await` — that belongs in the rule's config comment and the review,
not the diagnostic. When the class is narrower ("this repository's queue client
must be awaited"), add a local rule that names it.

## oxlint for the inner loop

oxlint is the fast pass a developer runs while editing; it is not the gate. What
it carries, verified on 1.94.0:

| Rule | oxlint 1.94.0 |
|---|---|
| `no-restricted-imports` (same `paths`/`patterns` config, same message) | yes — `paths` and `patterns` both verified, the message rides on `help:` |
| the local flat-config rule above, via `jsPlugins` | yes — the same file, one wrapper |
| `typescript/no-floating-promises`, `typescript/no-misused-promises` | only with `--type-aware` **and** the `oxlint-tsgolint` binary installed |
| `no-restricted-syntax` | **no** — the config is rejected |

The wrapper is the only new file the rule needs; the rule itself is unchanged:

```js
// rules/local.js — the same rule file, as an ESLint plugin object
import noDirectEnvToken from "./no-direct-env-token.js";

export default {
  meta: { name: "local" },
  rules: { "no-direct-env-token": noDirectEnvToken },
};
```

The `.oxlintrc.json` is the ESLint rule set minus the rule oxlint cannot load:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "promise"],
  "jsPlugins": ["./rules/local.js"],
  "rules": {
    "no-restricted-imports": [
      "error",
      {
        "paths": [
          {
            "name": "@app/legacy-http",
            "message": "Use @app/http (it sets the timeout and records the retry), not @app/legacy-http."
          }
        ]
      }
    ],
    "local/no-direct-env-token": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error"
  }
}
```

```bash
npx oxlint examples/zero-code/bad-import.ts        # exit 1
npx oxlint examples/zero-code/good-import.ts       # exit 0
npx oxlint examples/local-rule/bad-env.ts          # exit 1
npx oxlint examples/local-rule/good-env.ts         # exit 0
npx oxlint --type-aware examples/typed/bad-floating.ts   # exit 1
npx oxlint --type-aware examples/typed/good-floating.ts  # exit 0
```

```text
examples/zero-code/bad-import.ts:1:1: error eslint(no-restricted-imports): '@app/legacy-http' import is restricted from being used. help: Use @app/http (it sets the timeout and records the retry), not @app/legacy-http.
examples/local-rule/bad-env.ts:1:20: error local(no-direct-env-token): Read DATABASE_URL through databaseUrl() in src/config/db.ts (it trims the pooling suffix and fails fast when the variable is missing), not process.env.
examples/typed/bad-floating.ts:4:3: error typescript(no-floating-promises): Promises must be awaited, add void operator to ignore. help: The promise must end with a call to .catch, or end with a call to .then with a rejection handler, or be explicitly marked as ignored with the `void` operator.
```

What it cannot yet do, and why that matters for the gate:

- **`no-restricted-syntax` is not implemented in 1.94.0.** Putting it in
  `.oxlintrc.json` makes every oxlint run fail while parsing the config —
  `Rule 'no-restricted-syntax' not found in plugin 'eslint'`, exit 1, including
  for the good file. It fails loudly, which is the right failure, but the
  config cannot be shared verbatim with ESLint. The form ban stays in the ESLint
  pass until oxlint ships the rule; carry the same class with the local-rule
  route in the meantime if it must be fast.
- **The typed rules are silently skipped without `--type-aware`.** With
  `typescript/no-floating-promises` configured and `examples/typed/bad-floating.ts`
  the bad file, `npx oxlint <file>` **exits 0** — no warning, no diagnostic. The
  inner-loop script may omit the flag; the gate may not.
- **`--type-aware` without `oxlint-tsgolint` errors and exits 1**
  (`Failed to find type-aware linter executable… add the tsrs or oxlint-tsgolint
  package`). A missing binary fails the run rather than passing it, which is the
  behaviour to want; pin the package next to oxlint.
- **Suggestions are not surfaced.** The same rule produces its report, and
  `--format json` carries no `suggestions` field, so the editor affordance stays
  an ESLint feature.

The speed case is real — oxlint ran the two file-level recipes with no project
service and no type program — but a rule that exists in ESLint and not oxlint is
a gap in the fast pass, not in the gate. Name which pass each rule lives in, in
the row's `Enforced by` cell, so nobody assumes the inner loop proves the class.
One mechanical detail: oxlint resolves `jsPlugins` relative to the config file,
not to the working directory, so a copy of the config taken somewhere else dies
with `Failed to load JS plugin: ./rules/local.js` and exit 1. Keep the config
next to `rules/`, or give the entry an absolute path.

## Suppression audit

The skill's suppression rule is the same here, with different syntax. Before
writing one, use the ladder: fix the code, narrow the selector, or scope the rule
by path to its owner module. A comment that cannot say why is the same as no
check on that line. When one is genuinely unavoidable it carries the reason, an
expiry date, and the approver's name **on the offending line**.

`eslint-disable` — the unused and the undescribed directive each exit 1, and the
described one is the good revision that must pass:

```ts
// bad: no reason at all
// eslint-disable-next-line no-restricted-syntax
export const at = new Date();
```

```ts
// good: reason, tracking id, expiry, approver — all on the line
// eslint-disable-next-line no-restricted-syntax -- legacy report job, TODO-123, expires 2027-01-01, approved by @ops
export const at = new Date();
```

```bash
npx eslint --report-unused-disable-directives supp-examples/supp-unused.ts   # exit 1, unused directive
npx eslint -c comments.config.js supp-examples/supp-bare.ts                  # exit 1, undescribed
npx eslint -c comments.config.js supp-examples/supp-described.ts             # exit 0
```

The audit pass is its own config here so the plugin can be added without
changing the project's main one; the rule it suppresses is the `no-restricted-syntax`
ban above. `supp-unused.ts` is the case the *core* flag catches — a described
directive left on a line that no longer needs it — while `supp-described.ts` is
the good revision under this config, where the directive is needed and says why:

```js
// comments.config.js
import comments from "@eslint-community/eslint-plugin-eslint-comments";

export default [
  {
    files: ["**/*.ts"],
    plugins: { "eslint-comments": comments },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Take the time from clock.now() in src/clock.ts (tests replace it), not new Date().",
        },
      ],
      "eslint-comments/require-description": "error",
    },
  },
];
```

```text
/home/.../supp-examples/supp-bare.ts
  1:0  error  Unexpected undescribed directive comment. Include descriptions to explain why the comment is necessary  eslint-comments/require-description

✖ 1 problem (1 error, 0 warnings)
```

- `--report-unused-disable-directives` is **core ESLint**, and it is the ratchet
  the skill asks for: a directive that no longer suppresses anything fails the
  gate. `--fix` removes it. Put the flag in the project's lint script, not in a
  remembered extra command.
- `eslint-comments/require-description` (from
  `@eslint-community/eslint-plugin-eslint-comments`, 4.8.1) is what enforces the
  description; core ESLint has no such rule. That is an extra dependency — name
  it in the report if the project does not already run it, or carry the same
  class with a local rule that inspects comments.

`@ts-ignore` and `@ts-expect-error`:

```ts
// bad: @ts-ignore, and no reason
// @ts-ignore
export const answer: number = "42";
```

```ts
// good: the narrower directive, with a description
// @ts-expect-error -- fixture: "42" is deliberately not a number
export const answer: number = "42";
```

```bash
npx eslint examples/suppression/bad-ts-ignore.ts        # exit 1
npx eslint examples/suppression/good-ts-expect-error.ts # exit 0
```

```text
/home/.../examples/suppression/bad-ts-ignore.ts
  1:1  error  Include a description after the "@ts-ignore" directive to explain why the @ts-ignore is necessary. The description must be 10 characters or longer  @typescript-eslint/ban-ts-comment
```

```js
// eslint.config.js
"@typescript-eslint/ban-ts-comment": [
  "error",
  {
    "ts-ignore": "allow-with-description",
    "ts-expect-error": "allow-with-description",
    "ts-nocheck": "allow-with-description",
    minimumDescriptionLength: 10,
  },
],
```

`@ts-expect-error` is already strictly better than `@ts-ignore`: it errors when
the line stops being an error. TypeScript reports that as `TS2578`, which is the
ratchet for this suppression:

```bash
npx tsc --noEmit    # exit 2 while the unused directive is there: TS2578
npx tsc --noEmit    # exit 0 once it is removed
```

`ban-ts-comment` does not license adding suppressions; it requires an existing
one to name itself and say why. A suppression the skill's own check needs is
still forbidden by [../SKILL.md](../SKILL.md).

oxlint reads the same comments, at a different severity — worth knowing, because
the exit code is what CI reads:

```bash
npx oxlint --report-unused-disable-directives <path>                        # warning, exit 0
npx oxlint --report-unused-disable-directives-severity=error <path>         # error, exit 1
npx oxlint --report-unused-disable-directives --deny-warnings <path>        # error, exit 1
```

It also carries `typescript/ban-ts-comment`, which flags a bare `@ts-ignore` and
suggests `@ts-expect-error` — but not by default: with no `.oxlintrc.json` entry
the same file exits 0, and `typescript/ban-ts-comment: "error"` is what makes it
exit 1 with `Use "@ts-expect-error" instead of @ts-ignore` (both observed).
Across the whole tree, `tsc --noEmit` for `TS2578` plus
`--report-unused-disable-directives` for `eslint-disable` is the audit; no extra
tool is needed for either.

## Choosing between them

| Recipe | Level | Use when | Proof |
|---|---|---|---|
| `no-restricted-imports` | lint | a module or member must not be imported; the specifier proves it | `npx eslint <path>` |
| `no-restricted-syntax` | lint | a locally recognizable form must not appear, and no import distinguishes it | `npx eslint <path>` |
| Local flat-config rule | lint | the message must name the canonical file or symbol, or a suggestion is part of the fix | `npx eslint <path>` |
| `dependency-cruiser` | architecture | one module tree must not import another; direction is the rule | `npx depcruise src` |
| typescript-eslint typed rule | lint | the program knows it is wrong and the line does not — floating or misused promises | `npx eslint <path>` |
| oxlint | lint | the same rules, faster, while editing — never the typed gate | `npx oxlint [--type-aware] <path>` |
| Project test | test | behavior, runtime state, or dataflow decides the class | the project's test command |

Levels are the checker's five words — `architecture`, `type`, `lint`, `test`,
`prose` — so a row copied from this table into a target repository's table
validates. The typed-versus-inner-loop distinction belongs in the "Use when"
column, not in the level: only `lint` is a level, and crediting a typed rule to
the syntax pass is exactly the mistake the level column exists to prevent.

A message that names only the rule will be worked around. Name the replacement in
the `message` (`no-restricted-*`), the rule name plus `comment`
(dependency-cruiser), `meta.messages` (local rule), or the assertion message
(test). That naming is part of the check.

## Versions this was verified against

All runs on Node 24.22.2, in two scratch projects under `/tmp`
(`pr-js-ts/lint` for the ESLint, oxlint and suppression recipes;
`pr-js-ts/boundaries` for dependency-cruiser).

- ESLint 10.15.0, `@eslint/js` 10.0.1
- typescript-eslint 8.73.0, TypeScript 6.0.3 (7.0.2 is outside its peer range
  and exits 2)
- `@types/node` 26.6.6 (only so `process.env` is typed in the examples)
- oxlint 1.94.0 with `oxlint-tsgolint` 7.0.2007 for `--type-aware`
- `@eslint-community/eslint-plugin-eslint-comments` 4.8.1
- dependency-cruiser 18.8.0

They were installed in the scratch projects for verification. This repository's
gate does not run them, and its manifest does not list them.
