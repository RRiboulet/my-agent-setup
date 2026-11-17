# 04: Stop a job

**Blocked by:** 01
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (behaviour 5).

## What to build

`bg kill <id>` terminates the job's process group: SIGTERM first, SIGKILL after a
five-second grace, the same rule the harness already uses for its own commands.
Killing a finished job is a no-op with a clear message, not an error.

## Scope

Owns a kill module and its test file. Uses the signal helper that ticket 01
exported — do not edit the spawn, store, or watcher modules. Touches the tool's
dispatch map by adding exactly one case.

## Acceptance criteria

- [ ] A running job is reported killed and its process is gone within the grace
      period.
- [ ] A command that ignores SIGTERM is still gone after SIGKILL.
- [ ] A child of the job dies with it (process group, not just the direct pid).
- [ ] Killing a finished job is a no-op with a message.
- [ ] Killing twice in a row is safe.
- [ ] The job's recorded state becomes `killed`, not `exited`.

## Validation

`node --test .pi/extensions/subagent/test/bg-kill.test.ts`, then the full suite
once before your final commit. Use real processes: a shell that traps SIGTERM
and sleeps, and one that spawns a grandchild.
