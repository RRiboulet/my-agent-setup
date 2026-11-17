# 05: One message per settle

**Blocked by:** 01
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (behaviour 6, *Design decisions* on coalescing).

## What to build

When jobs finish, the agent is told once, not once per job. Three jobs finishing
inside the debounce window produce a single message naming all three — id, first
line of the command, exit code, duration, log path. While the agent is streaming
it is delivered as a steer; when the agent is idle it starts a turn.

## Scope

Owns a notify module and its test file, and fills in the completion hook point
the watcher already exposes in ticket 01 (one call site, no restructuring).

## Acceptance criteria

- [ ] Three jobs finishing within one window produce exactly one message naming
      all three, with exit codes and durations.
- [ ] Jobs finishing in separate windows produce separate messages.
- [ ] A job that finishes while the agent is streaming is delivered as a steer;
      one that finishes while the agent is idle triggers a turn.
- [ ] The message carries the job's age, so a stale completion is recognisable.
- [ ] No message is emitted when nothing finished.

## Validation

`node --test .pi/extensions/subagent/test/bg-notify.test.ts` (messages captured
at the fake API's `sendMessage`, not by watching a terminal), then the full suite
once before your final commit.
