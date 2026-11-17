# 01: A job can be started without blocking

**Blocked by:** None (can start immediately)
**Status:** ready

Spec: `docs/specs/2026-11-16-bg-tool-and-test-discipline.md` (read it first, especially *Design decisions*).

## What to build

The `bg` tool exists and can start a command that outlives the tool call. A
command that sleeps for 30 s returns in under a second with a job id and a log
path; `status` immediately reports it running, and later reports it exited with
its exit code. Nothing in this path waits on the command.

This ticket also lays the foundation the other tickets build on, and the
contracts below are what make them parallelisable. Do not change them without
saying so in your report.

## Scope

Owns (create these; no other ticket edits them):

- the extension factory and tool definition, with a **dispatch map** (one entry
  per action) that later tickets extend with a single case each
- the job record type and its on-disk metadata (atomic write), listing, and
  session-scoped job directory
- the detached spawn (own process group, output piped to the log) and pid
  liveness checks. **Export a signal helper** — later tickets must be able to
  signal a process group without editing this module
- the poll watcher, which must take **job records** (not just pids) so a later
  ticket can adopt a job after a restart, and must expose a completion hook
  point that a later ticket fills with notifications
- the test harness seam: a fake extension API that records `sendMessage` calls
  and registrations, plus a temp agent directory, in a shared helper file
- `bg-start-status.test.ts`

Actions `logs` and `kill` are declared in the tool schema from the start but
return a clean "not implemented yet" error in this ticket; tickets 03 and 04
replace those two cases. Pin only that they fail cleanly and never hang — do not
pin the placeholder text as desired behaviour.

Leaves for later: log reading (03), killing (04), completion notifications (05),
restart repair and pruning (06), docs (07), acceptance numbers (08).

## Acceptance criteria

- [ ] The tool registers with deferred exposure and starts inactive; a test
      asserts the registration metadata (spec behaviour 1).
- [ ] `start` of a 30 s command returns in under 2 s with a job id and log path,
      and `status` reports it running (spec behaviour 2).
- [ ] The job's cwd and session environment match what the built-in bash tool
      would use (spec behaviour 2).
- [ ] `status` with no id lists this session's jobs with state, exit code,
      elapsed, and command; with an id it reports one; a command that cannot
      start is `failed-to-start`, never a phantom running job (spec behaviour 3).
- [ ] The watcher observes running → exited and records the exit code.
- [ ] Failure to spawn leaves no half-written metadata behind.

## Validation

`node --test .pi/extensions/subagent/test/bg-start-status.test.ts`, then the
full suite once before your final commit. Real short shell commands, not mocks —
process-group and pid behaviour is the thing under test.
