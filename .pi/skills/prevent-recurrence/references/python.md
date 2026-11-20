# Python adapter

Recipes for the levels a Python repository can enforce, for the process in
[../SKILL.md](../SKILL.md). Every command below was run on 2026-11-20 against a
scratch project, with the versions stated; the results are the exit codes shown.
None of these tools is added to this repository: the scratch project used a
local venv, and the harness still consumes no Python or npm packages.

Order matters. Try Ruff's stock rules before a custom rule, a custom AST rule
before a new dependency, and a project test when no lint gate exists. A tool the
project does not already run is a design decision, named in the report with its
cost — not something this adapter installs for you.

## Ruff TID251: ban an import and name the replacement

Use when the class is "this module or member must not be used", and the import
line alone proves it. `TID251` is `flake8-tidy-imports`' `banned-api`: it flags
`from app.legacy_http import fetch`, `import app.legacy_http` followed by
attribute access, and every aliased form of them - `import app.legacy_http as
lh`, `from app.legacy_http import fetch as f`, `from app import legacy_http as
lh`, and `from app.legacy_http import *` all exit 1 (verified on Ruff 0.17.6,
one file per form). What it cannot see is indirection: `importlib.import_module`
exits 0, and a re-export is flagged where the re-export happens, not at the
consumers that import it from there. The rule is for accidental use, not a
security boundary.

The `msg` is the check: it names the replacement, so the diagnostic teaches
instead of puzzling.

```toml
# pyproject.toml
[tool.ruff.lint]
extend-select = ["TID251"]

[tool.ruff.lint.flake8-tidy-imports.banned-api]
"app.legacy_http".msg = "Use app.http.fetch (it sets the timeout and records the retry), not app.legacy_http."
```

Bad:

```python
# app/use_legacy.py
from app.legacy_http import fetch
```

Good:

```python
# app/use_new.py
from app.http import fetch
```

```bash
ruff check --select TID251 app/use_legacy.py   # exit 1
ruff check --select TID251 app/use_new.py      # exit 0
```

The bad run names the replacement (code frame trimmed):

```text
TID251 `app.legacy_http` is banned: Use app.http.fetch (it sets the timeout and records the retry), not app.legacy_http.
 --> app/use_legacy.py:1:1
Found 1 error.
```

A ban with no `msg` is not accepted: Ruff prints only the banned name, which
tells the next agent what not to do but not what to do instead. For a member
rather than a module, key the entry the same way (`"app.legacy_http.fetch"`).

## Stock Ruff rules worth selecting before writing a local rule

These are repeat classes common enough that Ruff already owns them. Select them
first; each has a documented message and an editor integration.

```toml
[tool.ruff.lint]
extend-select = ["S110", "BLE001", "B006", "RUF006", "PGH003", "RUF100"]
```

### S110: `try`-`except`-`pass`

Default S110 only flags a **blind** handler (`except:` or `except Exception:`)
whose body is `pass`. A typed `except ValueError: pass` passes by default; set
`[tool.ruff.lint.flake8-bandit] check-typed-exception = true` to include typed
handlers (verified).

Bad:

```python
def parse(raw: str) -> int:
    try:
        return int(raw)
    except Exception:
        pass
```

Good:

```python
import logging

log = logging.getLogger(__name__)


def parse(raw: str) -> int:
    try:
        return int(raw)
    except ValueError:
        log.warning("unparseable payload", exc_info=True)
        return 0
```

```bash
ruff check --select S110 examples/s110_bad.py    # exit 1
ruff check --select S110 examples/s110_good.py   # exit 0
```

The good version still returns a default, but it records why. If returning a
default is wrong, re-raise instead; the point of S110 is that the exception is
not silently discarded.

### BLE001: blind except

Flags `except Exception` / `except BaseException`. A handler that immediately
re-raises (`except Exception: raise`) is **not** flagged (verified): the rule is
about catching blind, not about naming the base class.

Bad:

```python
def handle(request: dict) -> None:
    try:
        process(request)
    except Exception:
        return None
```

Good:

```python
def handle(request: dict) -> None:
    try:
        process(request)
    except ValueError as exc:
        raise InvalidRequest(request) from exc
```

```bash
ruff check --select BLE001 examples/ble001_bad.py    # exit 1
ruff check --select BLE001 examples/ble001_good.py   # exit 0
```

BLE001's stock message does not name the replacement, so it is a coarse gate:
use it to stop swallowing, and add the fix-naming message at the boundary that
knows which specific errors are expected. If the repository already catches a
few known errors at a boundary and lets the rest propagate, BLE001 is the right
selection; if not, fix the handlers before enabling it.

### B006: mutable argument default

Bad:

```python
def append(item, items=[]):
    items.append(item)
    return items
```

Good:

```python
def append(item, items=None):
    items = [] if items is None else items
    items.append(item)
    return items
```

```bash
ruff check --select B006 examples/b006_bad.py    # exit 1
ruff check --select B006 examples/b006_good.py   # exit 0
```

B006 offers an unsafe fix (`--fix --unsafe-fixes`). Read it before applying:
the fix changes `None` handling, and a caller that passed `None` explicitly now
gets a new list instead of a shared one. This is a case where the rule is right
and the automatic fix still needs a human.

### RUF006: `asyncio` dangling task

Bad:

```python
import asyncio


async def main() -> None:
    asyncio.create_task(worker())
```

Good:

```python
import asyncio


async def main() -> None:
    task = asyncio.create_task(worker())
    await task
```

```bash
ruff check --select RUF006 examples/ruf006_bad.py    # exit 1
ruff check --select RUF006 examples/ruf006_good.py   # exit 0
```

The reference must be kept, or the event loop may garbage-collect the task
mid-flight. Storing it in a set and cancelling on shutdown is the other valid
shape; the rule checks the reference, not the shutdown policy.

### PGH003: blanket `type: ignore`

Bad:

```python
def value() -> str:
    return 1  # type: ignore
```

Good:

```python
def value() -> str:
    return 1  # type: ignore[return-value]
```

```bash
ruff check --select PGH003 examples/pgh003_bad.py    # exit 1
ruff check --select PGH003 examples/pgh003_good.py   # exit 0
```

PGH003 does not license adding suppressions; it requires an existing one to name
the error code it silences. A suppression that the skill's own check needs is
still forbidden by [../SKILL.md](../SKILL.md) unless it carries the reason,
expiry, and approver.

### RUF100: unused `noqa`

Bad:

```python
value = 1  # noqa: E501
```

Good:

```python
value = 1
```

```bash
ruff check --select RUF100 examples/ruf100_bad.py    # exit 1
ruff check --select RUF100 examples/ruf100_good.py   # exit 0
```

`ruff check --select RUF100 --fix` removes the unused directive. RUF100 is how a
ratchet keeps its suppressions honest: a `noqa` that no longer suppresses
anything should not survive the next change.

## ast-grep: a repo-specific rule with message, note, fix, and a test

Use when the pattern is locally recognizable but no stock rule expresses it: a
call with a particular argument, a decorator paired with a missing setting, a
library's one unsafe overload. This is still lint, not a type or test: the line
proves the violation.

`sgconfig.yml` at the project root:

```yaml
ruleDirs:
  - rules
testConfigs:
  - testDir: rule-tests
```

`rules/legacy-http-fetch.yml`:

```yaml
id: legacy-http-fetch
language: Python
severity: error
message: Use app.http.fetch (it sets the timeout and records the retry), not app.legacy_http.fetch.
note: |
  app.legacy_http predates the retry-aware client: no timeout, no request id.
  app.http.fetch is a drop-in for the same arguments and returns the same shape.
rule:
  pattern: app.legacy_http.fetch($URL)
fix: app.http.fetch($URL)
```

`rule-tests/legacy-http-fetch-test.yml`:

```yaml
id: legacy-http-fetch
valid:
  - app.http.fetch(url)
invalid:
  - app.legacy_http.fetch(url)
```

Bad:

```python
# app/call_legacy.py
import app.legacy_http


def load(url: str) -> str:
    return app.legacy_http.fetch(url)
```

Good:

```python
# app/call_new.py
import app.http


def load(url: str) -> str:
    return app.http.fetch(url)
```

```bash
ast-grep test                                  # exit 0 after the snapshot exists
ast-grep scan app/call_legacy.py               # exit 1
ast-grep scan app/call_new.py                  # exit 0
```

The first `ast-grep test` needs its snapshot baseline; `ast-grep test
--update-all` writes `rule-tests/__snapshots__/legacy-http-fetch-snapshot.yml`,
which records both the finding and the rewrite. Review that file: it is the
expected output, and an empty or wrong snapshot makes the test pass for the wrong
reason. `sg` is the older alias and `sg test` works when the tool's `bin` is on
`PATH`; it prints a deprecation warning and delegates to `ast-grep`, so the
commands here use `ast-grep`.

The `fix` is optional. Include it only when the replacement is mechanical; a
class that needs a judgment call (which retry policy, which tenant filter) keeps
`message` and `note` and drops `fix`.

## import-linter: dependency direction

Use for the architecture level: a module must not import another module. The
line cannot prove it, and a single test does not cover new files; a contract
does.

```toml
# pyproject.toml
[tool.importlinter]
root_packages = ["app"]

[[tool.importlinter.contracts]]
name = "Domain must not import adapters"
type = "forbidden"
source_modules = ["app.domain"]
forbidden_modules = ["app.adapters"]

[[tool.importlinter.contracts]]
name = "The layer order is API > services > domain"
type = "layers"
layers = ["app.api", "app.services", "app.domain"]
```

Bad (`app/domain/user.py`):

```python
from app.adapters.db import load


def name(user_id: str) -> str:
    return load(user_id)
```

Good:

```python
def name(user_id: str) -> str:
    return user_id
```

```bash
lint-imports    # exit 1: "app.domain is not allowed to import app.adapters"
lint-imports    # exit 0 after the domain stops importing the adapter
```

The broken run names the contract and the offending import, which is the
fix-naming a lint message gives. `import-linter` is a separate dependency; if
the project does not already run it, that is a decision for the report, and a
forbidden-imports test or a `tools/check_layers.py` script may be the cheaper
first step.

## A project test when no custom lint exists

Use when the class needs execution: a retry that must not double-charge, an
ordering, a rollback on failure, a semantic relation between input and output.
The test lives at a public seam and fails on the bad behavior, not on a helper
call.

Bad (`app/retry.py` retries a programming error):

```python
import time


def with_retry(call, attempts=3):
    last = None
    for _ in range(attempts):
        try:
            return call()
        except Exception as exc:
            last = exc
            time.sleep(0.01)
    raise last
```

Good (only transient failures are retried):

```python
import time


class TransientError(Exception):
    pass


def with_retry(call, attempts=3):
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except TransientError:
            if attempt == attempts:
                raise
            time.sleep(0.01)
```

The test:

```python
import unittest

from app.retry import with_retry


class RetryPolicyTest(unittest.TestCase):
    def test_a_programming_error_is_not_retried(self):
        calls = []

        def charge():
            calls.append(1)
            raise ValueError("bad request")

        with self.assertRaises(ValueError):
            with_retry(charge)
        self.assertEqual(len(calls), 1, "a ValueError must not be retried")
```

```bash
python3 -m unittest discover -s tests -q    # exit 1 with the bad retry
python3 -m unittest discover -s tests -q    # exit 0 with the good retry
```

With pytest the command is `python -m pytest tests/test_retry.py -q`; use
whichever runner the project already has, and never add one for this. A test at
one seam proves that seam, not the class everywhere: a new module can reintroduce
the swallowed error. Say that in the report, and widen the check only when the
pattern becomes locally recognizable.

## Choosing between them

| Recipe | Level | Use when | Proof |
|---|---|---|---|
| Ruff `TID251` | lint | a module or member must not be imported; the import line proves it | `ruff check --select TID251 <path>` |
| Stock Ruff rule | lint | the class is one Ruff already knows (S110, BLE001, B006, RUF006, PGH003, RUF100) | `ruff check --select <code> <path>` |
| ast-grep rule | lint | locally recognizable, but no stock rule expresses the shape | `ast-grep test`, `ast-grep scan <path>` |
| `import-linter` | architecture | a module must not import another; direction is the rule | `lint-imports` |
| Project test | test | behavior, runtime state, or dataflow decides the class | the project's test command |

A lint message that names only the rule will be worked around. Name the
replacement in the `msg` (TID251), the `message` + `note` (ast-grep), or the
assertion message (test). That naming is part of the check.

## Versions this was verified against

- Ruff 0.17.6 (`TID251`, `S110`, `BLE001`, `B006`, `RUF006`, `PGH003`, `RUF100`)
- ast-grep 0.51.3 (`ast-grep test`, `ast-grep scan`)
- import-linter 2.17 (`lint-imports`)
- Python 3.12.3 (`unittest`)

They were installed in a scratch venv under `/tmp` for verification. This
repository's gate does not run them, and its manifest does not list them.
