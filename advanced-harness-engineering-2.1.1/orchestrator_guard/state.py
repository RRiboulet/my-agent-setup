"""Advisory-locked per-session JSON state persistence."""

from __future__ import annotations

import fcntl
import json
import os
import time
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, Iterator

DEFAULT_STATE_DIR = Path("/tmp/copilot-orchestrator-hooks")
_SAFE_ID_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
_MAX_ACTIVE_SUBAGENTS = 32
_MAX_VIEWED_FILES = 200


def get_state_dir() -> Path:
    return Path(os.environ.get("ORCHESTRATOR_HOOKS_STATE_DIR") or DEFAULT_STATE_DIR)


def _safe_session_filename(session_id: str) -> str:
    raw = session_id or "default"
    cleaned = "".join(ch if ch in _SAFE_ID_CHARS else "_" for ch in raw[:128])
    return cleaned or "default"


def _recent_unique(items: Any, limit: int) -> list[str]:
    if not items:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for raw in reversed(items):
        s = str(raw)
        if s not in seen:
            seen.add(s)
            out.append(s)
            if len(out) >= limit:
                break
    out.reverse()
    return out


class SessionState:
    __slots__ = (
        "active_subagents",
        "direct_bypass",
        "discovery_budget",
        "discovery_count",
        "edited_files_this_turn",
        "escalation_unlocked",
        "last_any_edit_seq",
        "last_py_edit_seq",
        "last_py_edit_ts",
        "last_review_edit_ts",
        "mode",
        "pending_stop_block",
        "pending_subagent_shells",
        "pending_transcript_starts",
        "pending_warnings",
        "processed_transcript_tool_calls",
        "prompt_has_model_mention",
        "review_dirty_file_lines",
        "review_dirty_files",
        "review_dirty_lines",
        "review_required",
        "review_verified",
        "session_id",
        "steer_counts",
        "subagent_start_ts",
        "tests_required",
        "tests_verified",
        "transcript_offset",
        "transcript_path",
        "turn_index",
        "viewed_files",
        "warning_seq",
    )

    def __init__(
        self,
        session_id: str,
        turn_index: int = 0,
        mode: str = "qa",
        discovery_budget: int = 8,
        discovery_count: int = 0,
        direct_bypass: bool = False,
        pending_stop_block: bool = False,
        warning_seq: int = 0,
        pending_warnings: dict[str, str] | None = None,
        viewed_files: list[str] | None = None,
        edited_files_this_turn: list[str] | None = None,
        prompt_has_model_mention: bool = False,
        steer_counts: dict[str, int] | None = None,
        escalation_unlocked: bool = False,
        active_subagents: dict[str, str] | None = None,
        subagent_start_ts: dict[str, float] | None = None,
        processed_transcript_tool_calls: list[str] | None = None,
        transcript_path: str = "",
        transcript_offset: int = 0,
        pending_transcript_starts: dict[str, dict[str, Any]] | None = None,
        pending_subagent_shells: dict[str, dict[str, Any]] | None = None,
        last_py_edit_ts: float = 0.0,
        last_review_edit_ts: float = 0.0,
        last_py_edit_seq: int = -1,
        last_any_edit_seq: int = -1,
        tests_required: bool = False,
        tests_verified: bool = True,
        review_dirty_files: list[str] | None = None,
        review_dirty_file_lines: dict[str, int] | None = None,
        review_dirty_lines: int = 0,
        review_required: bool = False,
        review_verified: bool = True,
    ) -> None:
        self.session_id = session_id
        self.turn_index = turn_index
        self.mode = mode
        self.discovery_budget = discovery_budget
        self.discovery_count = discovery_count
        self.direct_bypass = direct_bypass
        self.pending_stop_block = pending_stop_block
        self.warning_seq = warning_seq
        self.pending_warnings = {} if pending_warnings is None else pending_warnings
        self.viewed_files = [] if viewed_files is None else viewed_files
        self.edited_files_this_turn = [] if edited_files_this_turn is None else edited_files_this_turn
        self.prompt_has_model_mention = prompt_has_model_mention
        self.steer_counts = {} if steer_counts is None else steer_counts
        self.escalation_unlocked = escalation_unlocked
        self.active_subagents = {} if active_subagents is None else active_subagents
        self.subagent_start_ts = {} if subagent_start_ts is None else subagent_start_ts
        self.processed_transcript_tool_calls = (
            [] if processed_transcript_tool_calls is None else processed_transcript_tool_calls
        )
        self.transcript_path = transcript_path
        self.transcript_offset = transcript_offset
        self.pending_transcript_starts = (
            {} if pending_transcript_starts is None else pending_transcript_starts
        )
        self.pending_subagent_shells = {} if pending_subagent_shells is None else pending_subagent_shells
        self.last_py_edit_ts = last_py_edit_ts
        self.last_review_edit_ts = last_review_edit_ts
        self.last_py_edit_seq = last_py_edit_seq
        self.last_any_edit_seq = last_any_edit_seq
        self.tests_required = tests_required
        self.tests_verified = tests_verified
        self.review_dirty_files = [] if review_dirty_files is None else review_dirty_files
        self.review_dirty_file_lines = {} if review_dirty_file_lines is None else review_dirty_file_lines
        self.review_dirty_lines = review_dirty_lines
        self.review_required = review_required
        self.review_verified = review_verified

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SessionState):
            return NotImplemented
        return all(getattr(self, slot) == getattr(other, slot) for slot in self.__slots__)

    def __repr__(self) -> str:
        fields = ", ".join(f"{slot}={getattr(self, slot)!r}" for slot in self.__slots__)
        return f"SessionState({fields})"

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "turn_index": self.turn_index,
            "mode": self.mode,
            "discovery_budget": self.discovery_budget,
            "discovery_count": self.discovery_count,
            "direct_bypass": self.direct_bypass,
            "pending_stop_block": self.pending_stop_block,
            "warning_seq": self.warning_seq,
            "pending_warnings": dict(self.pending_warnings),
            "viewed_files": _recent_unique(self.viewed_files, _MAX_VIEWED_FILES),
            "edited_files_this_turn": list(self.edited_files_this_turn),
            "prompt_has_model_mention": self.prompt_has_model_mention,
            "steer_counts": dict(self.steer_counts),
            "escalation_unlocked": self.escalation_unlocked,
            "active_subagents": dict(list(self.active_subagents.items())[-_MAX_ACTIVE_SUBAGENTS:]),
            "subagent_start_ts": dict(list(self.subagent_start_ts.items())[-_MAX_ACTIVE_SUBAGENTS:]),
            "processed_transcript_tool_calls": list(self.processed_transcript_tool_calls[-200:]),
            "transcript_path": self.transcript_path,
            "transcript_offset": self.transcript_offset,
            "pending_transcript_starts": {
                str(k): dict(v) for k, v in list(self.pending_transcript_starts.items())[-200:]
            },
            "pending_subagent_shells": {
                str(k): dict(v) for k, v in list(self.pending_subagent_shells.items())[-64:]
            },
            "last_py_edit_ts": self.last_py_edit_ts,
            "last_review_edit_ts": self.last_review_edit_ts,
            "last_py_edit_seq": self.last_py_edit_seq,
            "last_any_edit_seq": self.last_any_edit_seq,
            "tests_required": self.tests_required,
            "tests_verified": self.tests_verified,
            "review_dirty_files": list(self.review_dirty_files),
            "review_dirty_file_lines": {str(k): int(v) for k, v in self.review_dirty_file_lines.items()},
            "review_dirty_lines": self.review_dirty_lines,
            "review_required": self.review_required,
            "review_verified": self.review_verified,
        }

    @classmethod
    def from_dict(
        cls,
        session_id: str,
        data: dict[str, Any],
        *,
        default_mode: str = "qa",
        default_budget: int = 8,
    ) -> SessionState:
        if not isinstance(data, dict):
            raise ValueError(f"Expected dict for session state, got {type(data).__name__}")
        raw_warnings = data.get("pending_warnings") or {}
        if not isinstance(raw_warnings, dict):
            raise ValueError("Expected dict for pending_warnings")
        raw_steers = data.get("steer_counts") or {}
        if not isinstance(raw_steers, dict):
            raise ValueError("Expected dict for steer_counts")
        raw_subagents = data.get("active_subagents") or {}
        if not isinstance(raw_subagents, dict):
            raise ValueError("Expected dict for active_subagents")
        raw_sub_ts = data.get("subagent_start_ts") or {}
        if not isinstance(raw_sub_ts, dict):
            raise ValueError("Expected dict for subagent_start_ts")
        raw_starts = data.get("pending_transcript_starts") or {}
        if not isinstance(raw_starts, dict):
            raise ValueError("Expected dict for pending_transcript_starts")
        raw_shells = data.get("pending_subagent_shells") or {}
        if not isinstance(raw_shells, dict):
            raise ValueError("Expected dict for pending_subagent_shells")
        raw_file_lines = data.get("review_dirty_file_lines") or {}
        if not isinstance(raw_file_lines, dict):
            raise ValueError("Expected dict for review_dirty_file_lines")
        processed_calls = [str(tid) for tid in (data.get("processed_transcript_tool_calls") or [])][-200:]
        pending_starts = {
            str(k): dict(v) for k, v in raw_starts.items() if isinstance(v, dict)
        }
        while len(pending_starts) > 200:
            pending_starts.pop(next(iter(pending_starts)))
        pending_shells = {
            str(k): dict(v) for k, v in raw_shells.items() if isinstance(v, dict)
        }
        while len(pending_shells) > 64:
            pending_shells.pop(next(iter(pending_shells)))
        return cls(
            session_id=session_id,
            turn_index=int(data.get("turn_index", 0)),
            mode=str(data.get("mode", default_mode)),
            discovery_budget=int(data.get("discovery_budget", default_budget)),
            discovery_count=int(data.get("discovery_count", 0)),
            direct_bypass=bool(data.get("direct_bypass", False)),
            pending_stop_block=bool(data.get("pending_stop_block", False)),
            warning_seq=int(data.get("warning_seq", 0)),
            pending_warnings={str(k): str(v) for k, v in raw_warnings.items()},
            viewed_files=_recent_unique(data.get("viewed_files") or [], _MAX_VIEWED_FILES),
            edited_files_this_turn=[str(p) for p in (data.get("edited_files_this_turn") or [])],
            prompt_has_model_mention=bool(data.get("prompt_has_model_mention", False)),
            steer_counts={str(k): int(v) for k, v in raw_steers.items()},
            escalation_unlocked=bool(data.get("escalation_unlocked", False)),
            active_subagents={
                str(k): str(v) for k, v in list(raw_subagents.items())[-_MAX_ACTIVE_SUBAGENTS:]
            },
            subagent_start_ts={
                str(k): float(v) for k, v in list(raw_sub_ts.items())[-_MAX_ACTIVE_SUBAGENTS:]
            },
            processed_transcript_tool_calls=processed_calls,
            transcript_path=str(data.get("transcript_path") or ""),
            transcript_offset=max(0, int(data.get("transcript_offset", 0))),
            pending_transcript_starts=pending_starts,
            pending_subagent_shells=pending_shells,
            last_py_edit_ts=float(data.get("last_py_edit_ts", 0.0)),
            last_review_edit_ts=float(data.get("last_review_edit_ts", 0.0)),
            last_py_edit_seq=int(
                -1 if data.get("last_py_edit_seq") is None else data["last_py_edit_seq"]
            ),
            last_any_edit_seq=int(
                -1 if data.get("last_any_edit_seq") is None else data["last_any_edit_seq"]
            ),
            tests_required=bool(data.get("tests_required", False)),
            tests_verified=bool(data.get("tests_verified", True)),
            review_dirty_files=[str(p) for p in (data.get("review_dirty_files") or [])],
            review_dirty_file_lines={str(k): int(v) for k, v in raw_file_lines.items()},
            review_dirty_lines=int(data.get("review_dirty_lines", 0)),
            review_required=bool(data.get("review_required", False)),
            review_verified=bool(data.get("review_verified", True)),
        )

    def counters_snapshot(self) -> dict[str, Any]:
        return {
            "turn_index": self.turn_index,
            "discovery_count": self.discovery_count,
            "discovery_budget": self.discovery_budget,
            "direct_bypass": self.direct_bypass,
            "escalation_unlocked": self.escalation_unlocked,
            "tests_required": self.tests_required,
            "tests_verified": self.tests_verified,
            "review_required": self.review_required,
            "review_verified": self.review_verified,
        }


def prune_stale_session_files(
    state_dir: Path,
    *,
    current_session_id: str,
    max_age_seconds: float = 7 * 86400,
) -> int:
    """Remove stale session ``*.json`` and ``*.lock`` files older than ``max_age_seconds``."""
    if not state_dir.exists() or not state_dir.is_dir():
        return 0
    current_safe = _safe_session_filename(current_session_id)
    protected = {f"{current_safe}.json", f"{current_safe}.lock"}
    cutoff = time.time() - max_age_seconds
    removed = 0
    pruned_stems: set[str] = set()
    try:
        entries = list(state_dir.iterdir())
    except OSError:
        return 0

    for entry in entries:
        name = entry.name
        if name in protected or not name.endswith(".json"):
            continue
        stem = name[:-5]
        lock_path = state_dir / f"{stem}.lock"
        try:
            if not entry.is_file():
                continue
            if entry.stat().st_mtime >= cutoff:
                continue
            if lock_path.exists():
                with open(lock_path, "r", encoding="utf-8") as lock_fh:
                    fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    try:
                        if entry.is_file() and entry.stat().st_mtime < cutoff:
                            entry.unlink()
                            removed += 1
                            pruned_stems.add(stem)
                    finally:
                        fcntl.flock(lock_fh, fcntl.LOCK_UN)
            else:
                entry.unlink()
                removed += 1
                pruned_stems.add(stem)
        except OSError:
            continue

    for entry in entries:
        name = entry.name
        if name in protected or not name.endswith(".lock"):
            continue
        stem = name[:-5]
        json_path = state_dir / f"{stem}.json"
        if json_path.exists():
            continue
        try:
            if not entry.is_file():
                continue
            if stem not in pruned_stems and entry.stat().st_mtime >= cutoff:
                continue
            with open(entry, "r", encoding="utf-8") as lock_fh:
                fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    if json_path.exists():
                        continue
                    st_fd = os.fstat(lock_fh.fileno())
                    st_path = os.stat(entry)
                    if st_fd.st_ino != st_path.st_ino or st_fd.st_dev != st_path.st_dev:
                        continue
                    entry.unlink()
                    removed += 1
                finally:
                    fcntl.flock(lock_fh, fcntl.LOCK_UN)
        except OSError:
            continue

    return removed


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    target = os.fspath(path)
    pid = os.getpid()
    fd: int | None = None
    tmp_path = ""
    for attempt in range(16):
        candidate = f"{target}.tmp.{pid}.{time.time_ns() + attempt}"
        try:
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            tmp_path = candidate
            break
        except FileExistsError:
            continue
    if fd is None:
        raise FileExistsError(f"Failed to create unique temp file for {target}")
    try:
        fh = os.fdopen(fd, "w", encoding="utf-8")
    except Exception:
        os.close(fd)
        with suppress(OSError):
            os.unlink(tmp_path)
        raise
    try:
        with fh:
            fh.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp_path, target)
    except Exception:
        with suppress(OSError):
            os.unlink(tmp_path)
        raise


@contextmanager
def locked_session_state(
    session_id: str,
    state_dir: Path | None = None,
    *,
    default_mode: str = "qa",
    default_budget: int = 8,
    on_corrupt: Any = None,
) -> Iterator[SessionState]:
    """Acquire an exclusive flock for `session_id`, yield SessionState, and atomically persist."""
    root = state_dir or get_state_dir()
    root.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_session_filename(session_id)
    state_path = root / f"{safe_name}.json"
    lock_path = root / f"{safe_name}.lock"

    while True:
        lock_fh = open(lock_path, "a+", encoding="utf-8")
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_EX)
        except Exception:
            lock_fh.close()
            raise
        try:
            st_fd = os.fstat(lock_fh.fileno())
            try:
                st_path = os.stat(lock_path) if lock_path.exists() else None
            except FileNotFoundError:
                st_path = None
            if st_path is None or st_fd.st_ino != st_path.st_ino or st_fd.st_dev != st_path.st_dev:
                try:
                    fcntl.flock(lock_fh, fcntl.LOCK_UN)
                finally:
                    lock_fh.close()
                continue
            break
        except Exception:
            try:
                fcntl.flock(lock_fh, fcntl.LOCK_UN)
            finally:
                lock_fh.close()
            raise

    try:
        existed_valid = False
        if state_path.exists():
            try:
                raw = json.loads(state_path.read_text(encoding="utf-8"))
                state = SessionState.from_dict(
                    session_id,
                    raw,
                    default_mode=default_mode,
                    default_budget=default_budget,
                )
                existed_valid = True
            except (json.JSONDecodeError, ValueError, TypeError, AttributeError) as exc:
                if on_corrupt is not None:
                    on_corrupt(exc)
                state = SessionState(
                    session_id=session_id,
                    mode=default_mode,
                    discovery_budget=default_budget,
                )
        else:
            state = SessionState(
                session_id=session_id,
                mode=default_mode,
                discovery_budget=default_budget,
            )
        initial_snapshot = state.to_dict() if existed_valid else None
        yield state
        final_snapshot = state.to_dict()
        if not existed_valid or final_snapshot != initial_snapshot:
            _atomic_write_json(state_path, final_snapshot)
    finally:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)
        finally:
            lock_fh.close()
