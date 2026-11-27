"""Core hook rule evaluation engine."""

from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING, Any

from orchestrator_guard.policy import PolicyConfig, load_policy
from orchestrator_guard.state import (
    SessionState,
    get_state_dir,
    locked_session_state,
    prune_stale_session_files,
)
from orchestrator_guard.telemetry import append_telemetry, log_error

if TYPE_CHECKING:
    from orchestrator_guard.classifier import ClassifierFn


def get_guard_mode() -> str:
    raw = os.environ.get("ORCHESTRATOR_HOOKS", "enforce").strip().lower()
    if raw in ("off", "warn", "enforce"):
        return raw
    return "enforce"


def _actor_role(payload: dict[str, Any]) -> str:
    return "subagent" if payload.get("agentId") else "parent"


def handle_event(
    event: str,
    payload: dict[str, Any],
    *,
    config: PolicyConfig | None = None,
    classifier: ClassifierFn | None = None,
) -> dict[str, Any]:
    start = time.perf_counter()
    guard_mode = get_guard_mode()
    session_id = str(payload.get("sessionId") or "default")
    actor_role = _actor_role(payload)
    tool_name = payload.get("toolName")

    if guard_mode == "off":
        append_telemetry(
            session_id=session_id,
            event=event,
            actor_role=actor_role,
            mode="off",
            tool=tool_name,
            decision="allow",
            rule="guard_off",
            counters={},
            latency_ms=(time.perf_counter() - start) * 1000.0,
        )
        return {}

    raw_cwd = payload.get("cwd")
    cfg = config or load_policy(cwd=raw_cwd if isinstance(raw_cwd, (str, os.PathLike)) else None)
    output: dict[str, Any] = {}
    decision = "allow"
    rule = "pass"
    mode_snapshot = cfg.default_mode
    counters_snapshot: dict[str, Any] = {}

    with locked_session_state(
        session_id,
        default_mode=cfg.default_mode,
        default_budget=cfg.budget_for_mode(cfg.default_mode),
        on_corrupt=lambda exc: log_error(f"{event}:corrupt_state", exc),
    ) as state:
        if event == "userPromptSubmitted":
            output, decision, rule = _handle_user_prompt(payload, state, cfg, classifier, actor_role)
        elif event == "preToolUse":
            output, decision, rule = _handle_pre_tool_use(payload, state, cfg, guard_mode, actor_role)
        elif event == "postToolUse":
            output, decision, rule = _handle_post_tool_use(payload, state, cfg, actor_role)
        elif event == "subagentStart":
            output, decision, rule = _handle_subagent_start(payload, state)
        elif event == "subagentStop":
            output, decision, rule = _handle_subagent_stop(payload, state, cfg)
        elif event == "agentStop":
            output, decision, rule = _handle_agent_stop(payload, state, cfg, guard_mode, actor_role)
        else:
            decision, rule = "allow", f"observe:{event}"

        mode_snapshot = state.mode
        counters_snapshot = state.counters_snapshot()

    if event == "userPromptSubmitted" and actor_role == "parent":
        prune_stale_session_files(get_state_dir(), current_session_id=session_id)

    append_telemetry(
        session_id=session_id,
        event=event,
        actor_role=actor_role,
        mode=mode_snapshot,
        tool=tool_name,
        decision=decision,
        rule=rule,
        counters=counters_snapshot,
        latency_ms=(time.perf_counter() - start) * 1000.0,
    )
    return output


def _event_timestamp_ms(payload: dict[str, Any]) -> float:
    raw = payload.get("timestamp")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    return time.time() * 1000.0


def _handle_user_prompt(
    payload: dict[str, Any],
    state: SessionState,
    cfg: PolicyConfig,
    classifier: ClassifierFn | None,
    actor_role: str = "parent",
) -> tuple[dict[str, Any], str, str]:
    if actor_role == "subagent":
        return {}, "allow", "subagent_exempt"
    prompt = str(payload.get("prompt") or "")
    sentinel = cfg.stop_block_sentinel
    is_stop_continuation = bool(
        state.pending_stop_block and sentinel and prompt.lstrip().startswith(sentinel)
    )
    state.pending_stop_block = False
    if is_stop_continuation:
        return {}, "allow", "stop_block_continuation"

    if classifier is None:
        from orchestrator_guard.classifier import classify_turn

        classifier = classify_turn
    from orchestrator_guard.write_delegation_guard import (
        DEFAULT_MODEL_PATTERNS,
        prompt_mentions_model,
    )

    turn_policy = classifier(prompt, state, cfg)
    model_patterns = (
        DEFAULT_MODEL_PATTERNS if cfg.model_mention_patterns is None else cfg.model_mention_patterns
    )
    state.turn_index += 1
    state.mode = turn_policy.mode
    state.discovery_budget = turn_policy.discovery_budget
    state.discovery_count = 0
    state.direct_bypass = turn_policy.direct_bypass
    state.pending_warnings.clear()
    state.edited_files_this_turn.clear()
    state.prompt_has_model_mention = prompt_mentions_model(prompt, model_patterns)
    state.steer_counts.clear()
    state.escalation_unlocked = False

    return {"additionalContext": turn_policy.directive}, "allow", turn_policy.matched_rule


def _apply_violation(
    *,
    guard_mode: str,
    state: SessionState,
    tool_call_id: str | None,
    rule: str,
    reason: str,
) -> tuple[dict[str, Any], str, str]:
    if guard_mode == "warn":
        if tool_call_id:
            key = str(tool_call_id)
        else:
            state.warning_seq += 1
            key = f"warn-{state.turn_index}-{state.warning_seq}"
        state.pending_warnings[key] = reason
        return {}, "warn", rule
    return {"permissionDecision": "deny", "permissionDecisionReason": reason}, "deny", rule


def _handle_pre_tool_use(
    payload: dict[str, Any],
    state: SessionState,
    cfg: PolicyConfig,
    guard_mode: str,
    actor_role: str,
) -> tuple[dict[str, Any], str, str]:
    if actor_role == "subagent":
        return {}, "allow", "subagent_exempt"
    if state.direct_bypass:
        return {}, "allow", "direct_bypass"

    tool_name = str(payload.get("toolName") or "")
    tool_call_id = payload.get("toolCallId")
    tool_args = payload.get("toolArgs") or {}
    raw_cwd = payload.get("cwd")
    cwd: os.PathLike[str] | str | None = raw_cwd if isinstance(raw_cwd, (str, os.PathLike)) else None

    if tool_name in cfg.discovery_tools:
        budget = cfg.budget_for_mode(state.mode)
        state.discovery_budget = budget
        if state.discovery_count >= budget:
            reason = (
                f"Direct discovery budget exhausted ({state.discovery_count}/{budget} in '{state.mode}' mode). "
                "Delegate broader codebase discovery to the `explore` subagent via `task`."
            )
            if guard_mode == "warn":
                state.discovery_count += 1
            return _apply_violation(
                guard_mode=guard_mode,
                state=state,
                tool_call_id=tool_call_id,
                rule="discovery_budget_exceeded",
                reason=reason,
            )
        state.discovery_count += 1
        return {}, "allow", "discovery_within_budget"

    if tool_name in ("edit", "create"):
        from orchestrator_guard.write_delegation_guard import (
            evaluate_parent_write,
            normalize_path,
        )

        allowed, rule, reason = evaluate_parent_write(
            tool_name,
            tool_args,
            cwd=cwd,
            viewed_files=set(state.viewed_files),
            edited_files_this_turn=set(state.edited_files_this_turn),
            escalation_unlocked=state.escalation_unlocked,
            max_edit_lines=cfg.max_edit_lines,
            max_edited_files_per_turn=cfg.max_edited_files_per_turn,
        )
        if not allowed:
            return _apply_violation(
                guard_mode=guard_mode,
                state=state,
                tool_call_id=tool_call_id,
                rule=rule,
                reason=reason,
            )
        # Reserve the target file on preToolUse so parallel edits to a 2nd file are blocked immediately.
        norm_path = normalize_path(str(tool_args.get("path") or ""), cwd)
        if norm_path and norm_path not in state.edited_files_this_turn:
            state.edited_files_this_turn.append(norm_path)
        return {}, "allow", rule

    if tool_name == "task":
        from orchestrator_guard.write_delegation_guard import evaluate_parent_task

        allowed, rule, reason = evaluate_parent_task(
            tool_args,
            prompt_has_model_mention=state.prompt_has_model_mention,
        )
        if not allowed:
            return _apply_violation(
                guard_mode=guard_mode,
                state=state,
                tool_call_id=tool_call_id,
                rule=rule,
                reason=reason,
            )
        return {}, "allow", rule

    if tool_name == "bash":
        from orchestrator_guard.verification_gate import (
            format_gate_block_reason,
            missing_verification_checks,
            parse_commit_or_pr_command,
        )

        command = str(tool_args.get("command") or "")
        git_global_flags = tuple(cfg.bash_read_only_allowlist.get("git_allowed_global_flags", ("--no-pager",)))
        is_commit_or_pr, gate_kind = parse_commit_or_pr_command(
            command,
            git_allowed_global_flags=git_global_flags,
        )
        if is_commit_or_pr:
            missing = missing_verification_checks(
                tests_required=state.tests_required,
                tests_verified=state.tests_verified,
                review_required=state.review_required,
                review_verified=state.review_verified,
            )
            if missing:
                reason = format_gate_block_reason(missing, context=gate_kind or "commit/PR")
                return _apply_violation(
                    guard_mode=guard_mode,
                    state=state,
                    tool_call_id=tool_call_id,
                    rule="verification_gate_blocked",
                    reason=reason,
                )
            return {}, "allow", "commit_pr_gate_passed"

        from orchestrator_guard.shell_guard import is_read_only_bash_allowed

        allowed, detail = is_read_only_bash_allowed(command, cfg.bash_read_only_allowlist)
        if not allowed:
            reason = (
                f"Parent `bash` is restricted to short read-only inspection commands ({detail}). "
                "Delegate tests, linters, builds, scripts, or mutating commands to `general-purpose` via `task`."
            )
            return _apply_violation(
                guard_mode=guard_mode,
                state=state,
                tool_call_id=tool_call_id,
                rule="bash_not_read_only",
                reason=reason,
            )
        return {}, "allow", "bash_read_only_allowed"

    return {}, "allow", "pass"


def _refresh_review_gate(
    state: SessionState,
    cfg: PolicyConfig,
    cwd: os.PathLike[str] | str | None,
) -> bool:
    from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

    cwd_str = os.fspath(cwd) if isinstance(cwd, (str, os.PathLike)) else None
    state.review_dirty_lines = compute_net_review_dirty_lines(
        state.review_dirty_files,
        cwd_str,
        state.review_dirty_file_lines,
    )
    if (
        len(state.review_dirty_files) >= cfg.review_threshold_files
        or state.review_dirty_lines >= cfg.review_threshold_lines
    ):
        state.review_required = True
        state.review_verified = False
        return True
    else:
        state.review_required = False
        state.review_verified = True
        return False


def _record_file_mutation(
    state: SessionState,
    cfg: PolicyConfig,
    tool_name: str,
    tool_args: dict[str, Any],
    cwd: os.PathLike[str] | str | None,
    *,
    event_ts: float,
    paths_override: list[str] | None = None,
    defer_net_recalc: bool = False,
) -> bool:
    """Update dirty verification state after a successful edit/create. Returns True if any gate armed."""
    from orchestrator_guard.verification_gate import (
        classify_file_for_gates,
        count_changed_lines,
    )
    from orchestrator_guard.write_delegation_guard import normalize_path

    raw_paths = paths_override if paths_override else [str((tool_args or {}).get("path") or "")]
    norm_paths: list[str] = []
    for raw_p in raw_paths:
        np = normalize_path(raw_p, cwd)
        if np and np not in norm_paths:
            norm_paths.append(np)
    if not norm_paths:
        return False

    armed = False
    reviewable_paths: list[str] = []
    for norm_path in norm_paths:
        arms_tests, counts_for_review = classify_file_for_gates(norm_path, cfg.verification_file_rules)
        if arms_tests:
            state.tests_required = True
            state.tests_verified = False
            state.last_py_edit_ts = max(state.last_py_edit_ts, event_ts)
            armed = True
        if counts_for_review:
            reviewable_paths.append(norm_path)
            if norm_path not in state.review_dirty_files:
                state.review_dirty_files.append(norm_path)
            state.last_review_edit_ts = max(state.last_review_edit_ts, event_ts)

    if reviewable_paths:
        changed = count_changed_lines(tool_name, tool_args)
        primary = reviewable_paths[0]
        if tool_name == "create":
            state.review_dirty_file_lines[primary] = changed
        else:
            state.review_dirty_file_lines[primary] = state.review_dirty_file_lines.get(primary, 0) + changed
        if not defer_net_recalc and _refresh_review_gate(state, cfg, cwd):
            armed = True

    return armed


def _reset_verification_state(state: SessionState) -> None:
    state.tests_required = False
    state.tests_verified = True
    state.review_dirty_files.clear()
    state.review_dirty_file_lines.clear()
    state.review_dirty_lines = 0
    state.review_required = False
    state.review_verified = True
    state.last_py_edit_ts = 0.0
    state.last_review_edit_ts = 0.0
    state.last_py_edit_seq = -1
    state.last_any_edit_seq = -1


def _record_pending_subagent_shell(
    state: SessionState,
    *,
    agent_id: str,
    shell_id: str,
    command: str,
    started_at: float | None,
    start_seq: int | None,
) -> None:
    if not agent_id or not shell_id or not command:
        return
    key = f"{agent_id}:{shell_id}"
    state.pending_subagent_shells[key] = {
        "command": command,
        "started_at": started_at,
        "start_seq": start_seq,
    }
    while len(state.pending_subagent_shells) > 64:
        state.pending_subagent_shells.pop(next(iter(state.pending_subagent_shells)))


def _evaluate_subagent_shell_completion(
    state: SessionState,
    cfg: PolicyConfig,
    *,
    command: str,
    started_at: float | None,
    start_seq: int | None,
    last_py_edit_start_seq: int,
    last_any_edit_start_seq: int = -1,
) -> bool:
    from orchestrator_guard.verification_gate import (
        command_runs_git_commit,
        is_verification_command,
    )

    def _started_after_edit(
        started_at: float | None,
        start_seq: int | None,
        edit_ts: float,
        edit_seq: int,
    ) -> bool:
        if started_at is not None and edit_ts > 0.0 and float(started_at) < edit_ts:
            return False
        if edit_seq >= 0 and isinstance(start_seq, int) and start_seq <= edit_seq:
            return False
        return True

    if is_verification_command(command, cfg.verification_commands) and state.tests_required:
        if _started_after_edit(started_at, start_seq, state.last_py_edit_ts, last_py_edit_start_seq):
            state.tests_verified = True

    git_global_flags = tuple(cfg.bash_read_only_allowlist.get("git_allowed_global_flags", ("--no-pager",)))
    if command_runs_git_commit(command, git_allowed_global_flags=git_global_flags):
        latest_edit_ts = max(state.last_py_edit_ts, state.last_review_edit_ts)
        if _started_after_edit(started_at, start_seq, latest_edit_ts, last_any_edit_start_seq):
            _reset_verification_state(state)
            return True
    return False


def _record_processed_tool_call(state: SessionState, tool_call_id: str) -> None:
    if tool_call_id and tool_call_id not in state.processed_transcript_tool_calls:
        state.processed_transcript_tool_calls.append(tool_call_id)
        if len(state.processed_transcript_tool_calls) > 200:
            state.processed_transcript_tool_calls = state.processed_transcript_tool_calls[-200:]


def _handle_post_tool_use(
    payload: dict[str, Any],
    state: SessionState,
    cfg: PolicyConfig,
    actor_role: str,
) -> tuple[dict[str, Any], str, str]:
    tool_name = str(payload.get("toolName") or "")
    tool_call_id = payload.get("toolCallId")
    tool_args = payload.get("toolArgs") or {}
    tool_result = payload.get("toolResult") or {}
    result_ok = str(tool_result.get("resultType", "success")).lower() == "success"
    raw_cwd = payload.get("cwd")
    cwd: os.PathLike[str] | str | None = raw_cwd if isinstance(raw_cwd, (str, os.PathLike)) else None
    event_ts = _event_timestamp_ms(payload)

    if actor_role == "subagent":
        agent_id = str(payload.get("agentId") or "")
        if tool_call_id:
            _record_processed_tool_call(state, str(tool_call_id))
        if tool_name in ("edit", "create") and result_ok:
            _record_file_mutation(state, cfg, tool_name, tool_args, cwd, event_ts=event_ts)
        elif tool_name == "bash":
            from orchestrator_guard.verification_gate import (
                extract_bash_exit_code_from_post_tool,
                extract_shell_id_from_result,
            )

            cmd = str(tool_args.get("command") or "")
            exit_code = extract_bash_exit_code_from_post_tool(tool_result)
            if exit_code == 0:
                _evaluate_subagent_shell_completion(
                    state,
                    cfg,
                    command=cmd,
                    started_at=event_ts,
                    start_seq=None,
                    last_py_edit_start_seq=-1,
                    last_any_edit_start_seq=-1,
                )
            elif exit_code is None:
                shell_id = extract_shell_id_from_result(tool_result)
                _record_pending_subagent_shell(
                    state,
                    agent_id=agent_id,
                    shell_id=shell_id,
                    command=cmd,
                    started_at=event_ts,
                    start_seq=None,
                )
        elif tool_name == "read_bash":
            from orchestrator_guard.verification_gate import (
                extract_bash_exit_code_from_post_tool,
            )

            shell_id = str(tool_args.get("shellId") or "")
            exit_code = extract_bash_exit_code_from_post_tool(tool_result)
            if shell_id and exit_code is not None:
                pending = state.pending_subagent_shells.pop(f"{agent_id}:{shell_id}", None)
                if pending is not None and exit_code == 0:
                    _evaluate_subagent_shell_completion(
                        state,
                        cfg,
                        command=str(pending.get("command") or ""),
                        started_at=pending.get("started_at"),
                        start_seq=pending.get("start_seq"),
                        last_py_edit_start_seq=-1,
                        last_any_edit_start_seq=-1,
                    )
        return {}, "allow", "subagent_observed"

    context_notes: list[str] = []
    decision = "allow"
    rule = "pass"

    warning = None
    if tool_call_id and tool_call_id in state.pending_warnings:
        warning = state.pending_warnings.pop(tool_call_id)
    elif state.pending_warnings and not tool_call_id:
        first_key = next(iter(state.pending_warnings))
        warning = state.pending_warnings.pop(first_key)
    if warning:
        context_notes.append(f"[orchestrator-guard warn] {warning}")
        decision = "warn"
        rule = "warn_post_context"

    if tool_name == "view" and result_ok:
        from orchestrator_guard.write_delegation_guard import normalize_path

        norm_path = normalize_path(str(tool_args.get("path") or ""), cwd)
        if norm_path:
            if norm_path in state.viewed_files:
                state.viewed_files.remove(norm_path)
            state.viewed_files.append(norm_path)
            if len(state.viewed_files) > 200:
                state.viewed_files = state.viewed_files[-200:]
    elif tool_name in ("edit", "create") and result_ok:
        from orchestrator_guard.write_delegation_guard import normalize_path

        norm_path = normalize_path(str(tool_args.get("path") or ""), cwd)
        if norm_path and norm_path not in state.edited_files_this_turn:
            state.edited_files_this_turn.append(norm_path)
        if _record_file_mutation(state, cfg, tool_name, tool_args, cwd, event_ts=event_ts):
            from orchestrator_guard.verification_gate import missing_verification_checks

            missing = missing_verification_checks(
                tests_required=state.tests_required,
                tests_verified=state.tests_verified,
                review_required=state.review_required,
                review_verified=state.review_verified,
            )
            if missing:
                context_notes.append(
                    f"[orchestrator-guard reminder] Pending verification before commit/done: {', '.join(missing)}."
                )
    elif tool_name == "write_agent" and result_ok:
        from orchestrator_guard.write_delegation_guard import record_write_agent_steer

        args = tool_args if isinstance(tool_args, dict) else {}
        refresh_ids: list[str] = []
        raw_wid = args.get("agent_id")
        if isinstance(raw_wid, str) and raw_wid.strip():
            refresh_ids.append(raw_wid.strip())
        raw_wids = args.get("agent_ids")
        if isinstance(raw_wids, (list, tuple)):
            for item in raw_wids:
                if isinstance(item, str) and item.strip():
                    refresh_ids.append(item.strip())
        if args.get("scope") == "children":
            refresh_ids.extend(state.active_subagents.keys())
        for wid in refresh_ids:
            state.subagent_start_ts.pop(wid, None)
            state.subagent_start_ts[wid] = event_ts
            if wid in state.active_subagents:
                state.active_subagents[wid] = state.active_subagents.pop(wid)

        unlocked_now, reached = record_write_agent_steer(
            state.steer_counts,
            args,
            unlock_threshold=cfg.steer_unlock_threshold,
        )
        if unlocked_now and not state.escalation_unlocked:
            state.escalation_unlocked = True
            context_notes.append(
                f"[orchestrator-guard] Direct parent editing unlocked for this turn after "
                f"{cfg.steer_unlock_threshold} steers to worker(s) {', '.join(reached)}."
            )
            if rule == "pass":
                rule = "escalation_unlocked"
    elif tool_name == "bash":
        from orchestrator_guard.verification_gate import (
            is_bash_exit_zero_from_post_tool,
            parse_commit_or_pr_command,
        )

        cmd = str(tool_args.get("command") or "")
        git_global_flags = tuple(cfg.bash_read_only_allowlist.get("git_allowed_global_flags", ("--no-pager",)))
        is_commit_or_pr, gate_kind = parse_commit_or_pr_command(
            cmd,
            git_allowed_global_flags=git_global_flags,
        )
        if is_commit_or_pr and gate_kind == "git_commit" and is_bash_exit_zero_from_post_tool(tool_result):
            _reset_verification_state(state)

    if context_notes:
        return {"additionalContext": "\n".join(context_notes)}, decision, rule
    return {}, decision, rule


def _handle_subagent_start(
    payload: dict[str, Any],
    state: SessionState,
) -> tuple[dict[str, Any], str, str]:
    agent_id = str(payload.get("agentId") or "")
    agent_type = str(payload.get("agentType") or payload.get("agentName") or "")
    event_ts = _event_timestamp_ms(payload)
    if agent_id:
        if agent_type:
            state.active_subagents.pop(agent_id, None)
            state.active_subagents[agent_id] = agent_type
        state.subagent_start_ts.pop(agent_id, None)
        state.subagent_start_ts[agent_id] = event_ts
    return {}, "allow", "subagent_started"


def _handle_subagent_stop(
    payload: dict[str, Any],
    state: SessionState,
    cfg: PolicyConfig,
) -> tuple[dict[str, Any], str, str]:
    agent_id = str(payload.get("agentId") or "")
    agent_type = str(
        payload.get("agentType") or payload.get("agentName") or state.active_subagents.get(agent_id) or ""
    )
    raw_cwd = payload.get("cwd")
    cwd: os.PathLike[str] | str | None = raw_cwd if isinstance(raw_cwd, (str, os.PathLike)) else None
    stop_ts = _event_timestamp_ms(payload)
    transcript_path = payload.get("transcriptPath")

    if transcript_path:
        from orchestrator_guard.verification_gate import consume_transcript_actions

        tp_str = str(transcript_path)
        if tp_str != state.transcript_path:
            switched_transcript = bool(state.transcript_path)
            state.transcript_offset = 0
            state.pending_transcript_starts.clear()
            state.transcript_path = tp_str
            state.last_py_edit_seq = -1
            state.last_any_edit_seq = -1
            for entry in state.pending_subagent_shells.values():
                entry["start_seq"] = -1 if switched_transcript else None
        elif state.transcript_offset > 0:
            try:
                if os.path.isfile(tp_str) and os.path.getsize(tp_str) < state.transcript_offset:
                    state.transcript_offset = 0
                    state.pending_transcript_starts.clear()
                    state.last_py_edit_seq = -1
                    state.last_any_edit_seq = -1
                    for entry in state.pending_subagent_shells.values():
                        entry["start_seq"] = -1
            except OSError:
                pass
        prev_offset = state.transcript_offset
        actions, new_offset = consume_transcript_actions(
            tp_str,
            start_offset=state.transcript_offset,
            pending_starts=state.pending_transcript_starts,
            processed_tool_call_ids=set(state.processed_transcript_tool_calls),
        )
        if new_offset < prev_offset:
            state.last_py_edit_seq = -1
            state.last_any_edit_seq = -1
            for entry in state.pending_subagent_shells.values():
                entry["start_seq"] = -1
        state.transcript_offset = new_offset
    else:
        actions = []

    needs_review_recalc = False
    for action in actions:
        tid = action["tool_call_id"]
        _record_processed_tool_call(state, tid)

        act_agent_id = str(action.get("agent_id") or agent_id)
        act_tool = action["tool_name"]
        act_args = action["arguments"]
        act_completed_ts = action.get("completed_at")
        act_started_ts = action.get("started_at")
        act_ts = float(act_completed_ts) if act_completed_ts is not None else stop_ts

        if act_tool in ("edit", "create") and action["success"]:
            from orchestrator_guard.verification_gate import classify_file_for_gates

            file_edits = action["file_edits"]
            override_paths = [str(fe.get("path") or "") for fe in file_edits if str(fe.get("path") or "").strip()]
            checked_paths = override_paths or [str(act_args.get("path") or "")]
            prev_py_ts = state.last_py_edit_ts
            prev_review_ts = state.last_review_edit_ts
            _record_file_mutation(
                state,
                cfg,
                act_tool,
                act_args,
                cwd,
                event_ts=act_ts,
                paths_override=override_paths or None,
                defer_net_recalc=True,
            )
            if any(classify_file_for_gates(p, cfg.verification_file_rules)[1] for p in checked_paths):
                needs_review_recalc = True
            seq = action.get("start_seq")
            if isinstance(seq, int):
                is_py_edit = state.last_py_edit_ts > prev_py_ts or any(
                    classify_file_for_gates(p, cfg.verification_file_rules)[0] for p in checked_paths
                )
                is_any_edit = (
                    is_py_edit
                    or state.last_review_edit_ts > prev_review_ts
                    or any(
                        any(classify_file_for_gates(p, cfg.verification_file_rules))
                        for p in checked_paths
                    )
                )
                if is_py_edit:
                    state.last_py_edit_seq = max(state.last_py_edit_seq, seq)
                if is_any_edit:
                    state.last_any_edit_seq = max(state.last_any_edit_seq, seq)
        elif act_tool == "bash":
            cmd = str(act_args.get("command") or "")
            exit_code = action["exit_code"]
            if exit_code == 0:
                if _evaluate_subagent_shell_completion(
                    state,
                    cfg,
                    command=cmd,
                    started_at=act_started_ts,
                    start_seq=action.get("start_seq"),
                    last_py_edit_start_seq=state.last_py_edit_seq,
                    last_any_edit_start_seq=state.last_any_edit_seq,
                ):
                    needs_review_recalc = False
            elif exit_code is None:
                shell_id = str(action.get("shell_id") or "")
                _record_pending_subagent_shell(
                    state,
                    agent_id=act_agent_id,
                    shell_id=shell_id,
                    command=cmd,
                    started_at=act_started_ts if act_started_ts is not None else act_ts,
                    start_seq=action.get("start_seq"),
                )
        elif act_tool == "read_bash":
            exit_code = action["exit_code"]
            shell_id = str(act_args.get("shellId") or "")
            if shell_id and exit_code is not None:
                pending = state.pending_subagent_shells.pop(f"{act_agent_id}:{shell_id}", None)
                if (
                    pending is not None
                    and exit_code == 0
                    and _evaluate_subagent_shell_completion(
                        state,
                        cfg,
                        command=str(pending.get("command") or ""),
                        started_at=pending.get("started_at"),
                        start_seq=pending.get("start_seq"),
                        last_py_edit_start_seq=state.last_py_edit_seq,
                        last_any_edit_start_seq=state.last_any_edit_seq,
                    )
                ):
                    needs_review_recalc = False

    if needs_review_recalc and state.review_dirty_files:
        _refresh_review_gate(state, cfg, cwd)

    stop_reason = payload.get("stopReason")
    if agent_type == "code-review":
        completed_cleanly = stop_reason is None or str(stop_reason) == "end_turn"
        review_start_ts = state.subagent_start_ts.get(agent_id, stop_ts)
        started_after_edits = review_start_ts >= state.last_review_edit_ts
        if completed_cleanly and started_after_edits:
            state.review_verified = True
            out, decision, rule = {}, "allow", "subagent_code_review_completed"
        else:
            out, decision, rule = {}, "warn", "subagent_code_review_not_counted"
    else:
        out, decision, rule = {}, "allow", "subagent_stopped"

    if agent_id and stop_reason is not None and str(stop_reason) != "end_turn":
        state.active_subagents.pop(agent_id, None)
        state.subagent_start_ts.pop(agent_id, None)

    return out, decision, rule


def _handle_agent_stop(
    payload: dict[str, Any],
    state: SessionState,
    cfg: PolicyConfig,
    guard_mode: str,
    actor_role: str = "parent",
) -> tuple[dict[str, Any], str, str]:
    if actor_role == "subagent":
        return {}, "allow", "subagent_exempt"
    from orchestrator_guard.verification_gate import (
        format_gate_block_reason,
        missing_verification_checks,
    )

    missing = missing_verification_checks(
        tests_required=state.tests_required,
        tests_verified=state.tests_verified,
        review_required=state.review_required,
        review_verified=state.review_verified,
    )
    if not missing:
        return {}, "allow", "agent_stop_clean"

    if state.direct_bypass:
        return {}, "warn", "agent_stop_unverified_direct"

    if bool(payload.get("stop_hook_active", False)):
        return {}, "warn", "agent_stop_loop_guard"

    if guard_mode == "warn":
        return {}, "warn", "agent_stop_unverified"

    state.pending_stop_block = True
    reason = format_gate_block_reason(
        missing,
        sentinel=cfg.stop_block_sentinel,
        context="turn completion",
    )
    return {"decision": "block", "reason": reason}, "deny", "agent_stop_unverified"
