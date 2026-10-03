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