---
status: done
blocked-by: []
---

# 04: Default subagent wait and status to compact report-first summaries

**Spec:** ../../2026-11-27-pi-orchestration-parity-and-token-efficiency.md
**Blocked by:** None (can start immediately)
**Status:** done

## What to build
Prevent settled subagent runs from dumping dead tmux scrollback and multi-kilobyte raw output into the frontier parent context by defaulting `subagent_wait` and `subagent_status` to concise report-first summaries:

1. Update settled run formatting for both `subagent_wait` (across single-ID, multi-ID, and plan wait modes) and `subagent_status` to return a concise structured summary by default: run status, role, model, token/cost usage, the parsed `subagent-report` envelope digest (or a bounded fallback tail when unstructured), and pointers to the persisted `report.md` and transcript artifacts.
2. Omit dead tmux panes and multi-kilobyte raw output from settled summaries by default, while preserving verbatim parity between single-ID `subagent_wait` and `subagent_status` outputs and keeping live or timed-out run pane previews intact.
3. Add explicit `includeOutput: true` and `includePane: true` opt-in parameters to `subagent_wait` and `subagent_status` so callers can request raw output or pane capture on demand.

## Scope
Summary formatting and tool parameters for `subagent_wait` and `subagent_status`, plus unit tests for settled, live, and timed-out summary behaviors. Leaves worker startup flags (`03`) and parent delegation hooks (`05`–`07`) unchanged.

## Acceptance criteria
- [x] Settled runs returned by `subagent_wait` (`{id}`, `{ids}`, and `{plan}`) and `subagent_status` default to concise structured summaries containing status, role/model/usage, parsed `subagent-report` digest or bounded fallback tail, and `report.md`/transcript pointers.
- [x] Dead tmux panes and full raw child output are excluded from settled run summaries by default.
- [x] Single-ID `subagent_wait` and `subagent_status` produce verbatim-equivalent settled summaries, while live and timed-out runs retain pane visibility.
- [x] Passing `includeOutput: true` or `includePane: true` restores raw output or tmux pane capture on demand.

## Validation
Unit tests for `subagent_wait` and `subagent_status` verify default report-first output across `{id}`, `{ids}`, and `{plan}` modes, verbatim parity between single-ID wait and status, preserved pane output for live/timed-out runs, and opt-in `includeOutput` / `includePane` expansion. Covers `RB-5`.
