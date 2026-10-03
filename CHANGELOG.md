# Changelog

Versions are git tags. This repository is not published to npm.

## v1.0.0 — 2026-10-02

Initial tagged release, tracking pi 1.0.0. Contents:

- `answer` extension (`/answer`) with question extraction.
- `native-web-search` extension and matching skill.
- `todos` extension with file-based todo management.
- `subagent` extension: non-blocking delegation of tasks into detached tmux
  sessions, with status inspection, waiting, and cancellation.

### Unreleased

Maintenance, no behaviour change:

- Fixed `AGENTS.md`, which still documented `./extensions` and `./skills`
  after they moved to `.pi/` in `3b554e9`, and gave a test command that no
  longer existed. Documented the CRLF trap and how to repair it.
- Renormalized line endings to LF across the tree (`.gitattributes` already
  required it; `pi-session.sh` was committed with CRLF in its blob and other
  files were left stale-CRLF in the working tree, invisible to `git status`).
- Added this `CHANGELOG.md`; `AGENTS.md` mandated it but it did not exist.

Features:

- **Subagent context handoff.** New `handoff` parameter on the `subagent` tool:
  - `standalone` (default) — unchanged, a fresh session addressed by
    `--session-dir`/`--session-id`.
  - `lineage` — an empty child session whose v3 header records the parent
    session, so pi shows the relationship without sharing context.
  - `fork` — the child is seeded with the parent's live branch, so it already
    knows the task's background.
- **New `subagent_resume({ id, message })` tool.** Reopens a finished run's
  transcript and appends the follow-up, in a fresh tmux session, tracked as an
  incremented attempt.
- **Fixed child usage double-counting.** A forked child inherits the parent's
  transcript verbatim, so summing the whole file charged the child for its
  parent's turns. Runs now record a `usageFromLine` baseline and only the
  remainder is attributed to the run.
- `subagent_clean --delete_files` now reports how many child transcripts it
  destroyed, since those runs can no longer be resumed.

Fixes to the handoff work, from an adversarial review:

- **`subagent_clean` could destroy a live resumed run's transcript.** A resumed
  run keeps its ancestor's transcript, so deleting the ancestor's run dir pulled
  the file out from under a run that was still going. pi holds the descriptor
  open, so the child kept writing to an unlinked inode and lost every entry
  silently. `subagent_clean` now retains a run dir that still owns a live run's
  session file and names it in its output.
- **Two concurrent resumes could append to one transcript.** A finished run
  stays terminal forever, so nothing stopped both resumes from passing the
  "still running" guard; two pi processes then wrote interleaved branches to one
  JSONL. `subagent_resume` now refuses while another non-terminal run shares the
  session file.
- **`subagent_clean` over-reported destroyed transcripts**, counting any record
  with a `sessionFile` rather than one inside the dir being deleted.
- **A fallback reintroduced the wrong-branch trap**: `fork` mode fell back to
  the reopened parent's `getLeafId()`, which is the file's last entry. Fork now
  takes the leaf from the live `ctx.sessionManager` and fails if there is none.
  This also drops a redundant full re-parse of the parent transcript per call.
- `finalizeRun` no longer erases a recorded `sessionFile` when a child reports
  one that is `undefined`.

Fixes:

- `persist()` wrote `runs.json` with a plain `writeFile`, so a reader could
  catch the file mid-write and fail `JSON.parse`. It now uses the atomic
  temp-file-plus-rename helper that already existed in the same module. This
  made `lifecycle.test.ts` fail roughly 3 runs in 8.
- `pi --session <missing-file>` does not merely start empty — it invents a new
  UUID, silently diverging from the parent transcript. Resume now verifies the
  file exists and fails loudly instead.