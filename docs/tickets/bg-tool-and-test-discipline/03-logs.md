# 03: Read a job's output

**Blocked by:** 01
Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (behaviour 4, *Design decisions* on the log cap).

## What to build

`bg logs <id>` returns the tail of a job's combined stdout and stderr, truncated
with the repository's existing tail-truncation limits and the usual notice, plus
a marker when the log hit its size cap. Asking for a running job's logs returns
what exists so far.

## Scope

Owns a log-reading module, **log-cap enforcement**, and its test file. Touches
the tool's dispatch map by adding exactly one case, and extends the watcher's
poll with the cap check — that is the only watcher edit in the batch, so no
other ticket may touch it. Do not edit the spawn, store, or another ticket's
modules.

Implements: tail-by-lines and tail-by-bytes through the exported truncation
helpers, the cap marker, and the "still running, partial output" case.

The cap itself is yours and was unowned until now: ticket 01 found that a plain
log file cannot cap itself and a capped pipe reader would defeat detachment, so
the watcher's existing poll is where it belongs — truncate from the front and
append the marker once, idempotently. The spec constraint "log storage must be
bounded" is satisfied by this ticket, not by 04-06.

## Acceptance criteria

- [ ] A job writing 5 000 lines returns the tail with the truncation notice, not
      the whole log.
- [ ] Output is combined stdout and stderr in write order.
- [ ] A log that hit the cap says so.
- [ ] Logs for a running job return partial output rather than an error.
- [ ] Logs for an unknown job id is a clear error, not a crash.

## Validation

`node --test .pi/extensions/subagent/test/bg-logs.test.ts`, then the full suite
once before your final commit.
