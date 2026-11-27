## Explaining permission requests

Before any tool call that may need my approval (shell commands that are not read-only, file edits, paths or URLs outside the allowed set, MCP tool calls), write a one-line note in plain language right before the call:

> **About to run:** what it does · **Why:** the reason it is needed · **Risk:** none / low / what it changes

Keep it to one line. For a batch of related calls, one note covering the batch is enough. Skip the note for read-only commands that run without asking.

## Coding skills

A shared skill set is installed in this harness's skills directory. When a trigger below applies, load that skill (read its `SKILL.md`) and follow it, without waiting to be asked:

- Trivial, unambiguous edit: make it, then check it. No ceremony.
- Non-trivial, ambiguous, or multi-step request: `in-your-own-words` before building.
- User asks to grill or stress-test a plan, or a plan has several interdependent open decisions: `grilling`.
- Designing a new module, refactoring across boundaries, or repeating workarounds: `architect`.
- Change that crosses a module, service, API, schema, or config boundary: `blast-radius`.
- Bug, failing test, CI failure, crash, flake, or regression: `diagnosing-bugs`.
- New or changed behavior with a testable seam: `tdd`.
- Retries, queues, webhooks, jobs, migrations, or setup scripts: `idempotent-operations`.
- Producing or acting on a performance number: `benchmark-checklist`.
- Long, autonomous, or multi-phase run: `show-me-your-work`.
- Reviewing a diff or finishing a non-trivial change: `review-change`.
- High-risk auth, security, concurrency, redaction, or data-migration change, or user asks to stress-test a diff: `interrogate`.
- Same mistake class corrected twice: `prevent-recurrence`.
- Repeated corrections in a session, tooling/doc drift, or user asks for a retro: `retro`.
- Writing or editing a skill, `AGENTS.md`, or harness instruction files: `writing-for-agents`.
- Before saying work is done: `prove-it-works`.
- Committing current changes: `commit`.
- Updating `CHANGELOG.md` or preparing a release: `update-changelog`.
- GitHub issues, pull requests, CI runs, or releases with `gh`: `github`.
- Isolating a branch or task in a linked git worktree: `worktree`.
- Running commands inside or diagnosing a devcontainer with `devc`: `devcontainer`.
- Interactive CLI needing a persistent TTY over a private tmux socket: `tmux`.
- Caching or refreshing a remote git repository as reference: `librarian`.
- Quick web research with summaries and full source URLs: `native-web-search`.
- Missing, stale, or misconfigured model in the `opencode-go` provider (`pi` harness): `add-model`.

Only the user starts `/to-spec`, `/to-tickets`, `/implement`, `/implement-spec`, `/verify-app`, `/recall`, `/handoff`, and `/teach` (Copilot CLI uses `/name`; `pi` uses `/skill:name`). Suggest them when they fit; never start them yourself.
