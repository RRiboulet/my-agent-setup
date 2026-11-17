# 06: Trust the state after a restart

**Blocked by:** 01
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (behaviour 7, *Design decisions* on retention).

## What to build

On session start the tool trusts nothing it did not observe: a job recorded as
running whose process is gone is repaired to `exited`; a still-live job started
by this session is adopted and still notifies on completion; job directories past
the retention window are removed.

## Scope

Owns a repair module and its test file. Touches the session-start handler in the
extension factory by adding one call. Uses the store's listing and the watcher's
record-based adoption — do not edit another ticket's module.

## Acceptance criteria

- [ ] Metadata claiming a dead pid is repaired to `exited` on session start.
- [ ] A live job is adopted and its completion still produces a notification.
- [ ] A job directory older than the retention window is removed; a younger one
      is kept.
- [ ] Repair is idempotent: running it twice changes nothing the second time.
- [ ] Repair never throws on a corrupt or half-written metadata file; it reports
      and moves on.

## Validation

`node --test .pi/extensions/subagent/test/bg-repair.test.ts` — spawn a real
process for the live case and use a recorded-but-dead pid for the repair case.
Then the full suite once before your final commit.
