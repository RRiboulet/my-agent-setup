"""Pure-logic parent write boundaries, task model-routing guard, and steer escalation."""

from __future__ import annotations

import os
import re
from collections.abc import Sequence
from typing import Any

DEFAULT_MODEL_PATTERNS: tuple[str, ...] = (
    r"\bopus\b",
    r"\bsonnet\b",
    r"\bhaiku\b",
    r"\bneon\b",
    r"\bhydrogen\b",
    r"\bdeepseek\b",
    r"\bgpt\d*[a-z]?\b",
    r"\bmodel\b",
)


def normalize_path(raw_path: os.PathLike[str] | str, cwd: os.PathLike[str] | str | None = None) -> str:
    """Normalize a path against optional `cwd`, returning '' for blank input."""
    if not isinstance(raw_path, (str, os.PathLike)):
        return ""
    cleaned = os.fspath(raw_path).strip()
    if not cleaned:
        return ""
    cwd_str = os.fspath(cwd).strip() if isinstance(cwd, (str, os.PathLike)) else ""
    if not os.path.isabs(cleaned) and cwd_str:
        cleaned = os.path.join(cwd_str, cleaned)
    return os.path.normpath(cleaned)


def count_edit_changed_lines(old_str: str, new_str: str) -> int:
    """Count changed lines using SequenceMatcher opcodes over splitlines."""
    import difflib

    matcher = difflib.SequenceMatcher(None, old_str.splitlines(), new_str.splitlines())
    total = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            total += max(i2 - i1, j2 - j1)
    return total


def prompt_mentions_model(
    prompt: str,
    model_patterns: Sequence[str] = DEFAULT_MODEL_PATTERNS,
) -> bool:
    """Return True if any case-insensitive regex in `model_patterns` matches `prompt`."""
    if not prompt:
        return False
    return any(re.search(pattern, prompt, re.IGNORECASE) is not None for pattern in model_patterns)


def evaluate_parent_write(
    tool_name: str,
    tool_args: dict[str, Any],
    *,
    cwd: os.PathLike[str] | str | None,
    viewed_files: set[str],
    edited_files_this_turn: set[str],
    escalation_unlocked: bool,
    max_edit_lines: int = 20,
    max_edited_files_per_turn: int = 1,
) -> tuple[bool, str, str]:
    """Evaluate RB-5/RB-8 parent write guardrails, returning (allowed, rule, reason)."""
    if tool_name not in ("edit", "create"):
        return True, "pass", ""

    if escalation_unlocked:
        return True, "write_escalation_unlocked", ""

    if tool_name == "create":
        return (
            False,
            "parent_create_denied",
            "Parent `create` calls are denied. Delegate file creation to `general-purpose` via `task`.",
        )

    args = tool_args or {}
    path = normalize_path(str(args.get("path") or ""), cwd)
    if not path or path not in viewed_files:
        return (
            False,
            "parent_edit_unviewed_file",
            "Parent `edit` requires reading the target file via `view` first, "
            "or delegating the change to `general-purpose` via `task`.",
        )

    if path not in edited_files_this_turn and len(edited_files_this_turn) >= max_edited_files_per_turn:
        return (
            False,
            "parent_edit_multi_file",
            f"Parent `edit` is limited to {max_edited_files_per_turn} distinct file(s) per turn. "
            "Delegate multi-file edits to `general-purpose` via `task`.",
        )

    changed = count_edit_changed_lines(str(args.get("old_str") or ""), str(args.get("new_str") or ""))
    if changed > max_edit_lines:
        return (
            False,
            "parent_edit_too_large",
            f"Parent `edit` changes {changed} lines (limit {max_edit_lines}). "
            "Delegate larger edits to `general-purpose` via `task`.",
        )

    return True, "parent_edit_surgical_allowed", ""


def evaluate_parent_task(
    tool_args: dict[str, Any],
    *,
    prompt_has_model_mention: bool,
) -> tuple[bool, str, str]:
    """Evaluate RB-7 parent `task` explicit model-override guard."""
    args = tool_args or {}
    raw_model = args.get("model")
    has_explicit_model = bool(raw_model.strip()) if isinstance(raw_model, str) else bool(raw_model)
    if has_explicit_model and not prompt_has_model_mention:
        return (
            False,
            "task_explicit_model_denied",
            "Do not pass an explicit `model` on `task` unless the user prompt names a model or tier. "
            "Retry omitting `model` so `/subagents` routing applies.",
        )
    return True, "task_allowed", ""


def record_write_agent_steer(
    steer_counts: dict[str, int],
    tool_args: dict[str, Any],
    *,
    unlock_threshold: int = 2,
) -> tuple[bool, list[str]]:
    """Increment per-worker steer counts and return (unlocked_now, reached_worker_ids)."""
    args = tool_args or {}
    targets: list[str] = []
    seen: set[str] = set()

    agent_id = args.get("agent_id")
    if isinstance(agent_id, str) and agent_id.strip():
        wid = agent_id.strip()
        seen.add(wid)
        targets.append(wid)

    raw_ids = args.get("agent_ids")
    if isinstance(raw_ids, (list, tuple)):
        for item in raw_ids:
            if isinstance(item, str) and item.strip():
                wid = item.strip()
                if wid not in seen:
                    seen.add(wid)
                    targets.append(wid)

    reached_worker_ids: list[str] = []
    for wid in targets:
        steer_counts[wid] = steer_counts.get(wid, 0) + 1
        if steer_counts[wid] >= unlock_threshold:
            reached_worker_ids.append(wid)

    return len(reached_worker_ids) > 0, reached_worker_ids
