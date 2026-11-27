"""Structured JSONL telemetry and fail-open diagnostic error logging."""

from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path
from typing import Any, TextIO

from orchestrator_guard.state import get_state_dir

DEFAULT_MAX_EVENTS_BYTES = 5 * 1024 * 1024
DEFAULT_MAX_ERROR_BYTES = 1024 * 1024


def _max_log_bytes(env_var: str, default: int) -> int:
    raw = os.environ.get(env_var, "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
        return val if val > 0 else default
    except ValueError:
        return default


def _open_locked_for_append(path: Path, max_bytes: int) -> TextIO:
    """Open ``path`` under exclusive flock, rotating to ``.1`` atomically if ``size >= max_bytes``."""
    while True:
        fh = open(path, "a", encoding="utf-8")
        try:
            fcntl.flock(fh, fcntl.LOCK_EX)
            st_fd = os.fstat(fh.fileno())
            try:
                st_path = os.stat(path)
            except FileNotFoundError:
                st_path = None
            if st_path is None or st_fd.st_ino != st_path.st_ino or st_fd.st_dev != st_path.st_dev:
                try:
                    fcntl.flock(fh, fcntl.LOCK_UN)
                finally:
                    fh.close()
                continue
            if st_fd.st_size >= max_bytes:
                backup_path = path.with_name(f"{path.name}.1")
                os.replace(path, backup_path)
                try:
                    fcntl.flock(fh, fcntl.LOCK_UN)
                finally:
                    fh.close()
                continue
            return fh
        except Exception:
            fh.close()
            raise


def append_telemetry(
    *,
    session_id: str,
    event: str,
    actor_role: str,
    mode: str,
    tool: str | None,
    decision: str,
    rule: str,
    counters: dict[str, Any],
    latency_ms: float,
    state_dir: Path | None = None,
) -> None:
    root = state_dir or get_state_dir()
    root.mkdir(parents=True, exist_ok=True)
    log_path = root / "events.jsonl"
    record = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": session_id,
        "event": event,
        "actor_role": actor_role,
        "mode": mode,
        "tool": tool,
        "decision": decision,
        "rule": rule,
        "counters": counters,
        "latency_ms": round(latency_ms, 2),
    }
    line = json.dumps(record, ensure_ascii=False) + "\n"
    max_bytes = _max_log_bytes("ORCHESTRATOR_HOOKS_MAX_LOG_BYTES", DEFAULT_MAX_EVENTS_BYTES)
    fh = _open_locked_for_append(log_path, max_bytes)
    try:
        fh.write(line)
        fh.flush()
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


def log_error(event: str, exc: BaseException, state_dir: Path | None = None) -> None:
    try:
        import traceback

        root = state_dir or get_state_dir()
        root.mkdir(parents=True, exist_ok=True)
        err_path = root / "errors.log"
        entry = (
            f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] event={event} "
            f"error={exc!r}\n{traceback.format_exc()}\n"
        )
        max_bytes = _max_log_bytes("ORCHESTRATOR_HOOKS_MAX_ERROR_LOG_BYTES", DEFAULT_MAX_ERROR_BYTES)
        fh = _open_locked_for_append(err_path, max_bytes)
        try:
            fh.write(entry)
            fh.flush()
        finally:
            try:
                fcntl.flock(fh, fcntl.LOCK_UN)
            finally:
                fh.close()
    except Exception:
        pass
