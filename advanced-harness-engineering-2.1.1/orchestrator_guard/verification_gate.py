"""Pure verification-gate helpers for post-edit tests, code review, and commit/PR checks."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Sequence
from typing import Any

from orchestrator_guard.write_delegation_guard import count_edit_changed_lines

DEFAULT_TEST_EXTENSIONS: tuple[str, ...] = (
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".go",
    ".rs",
    ".rb",
    ".java",
)
DEFAULT_REVIEW_EXTENSIONS: tuple[str, ...] = (
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".mjs",
    ".cjs",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".tf",
    ".sql",
    ".sh",
    ".json",
    ".yml",
    ".yaml",
)
DEFAULT_EXEMPT_EXTENSIONS: tuple[str, ...] = (".md", ".txt")

DEFAULT_VERIFY_INCLUDE_PATTERNS: tuple[str, ...] = (
    r"^pytest$",
    r"^ruff$",
    r"^unittest$",
    r"(?:^|/)run_[A-Za-z0-9_-]*tests\.sh$",
    r"(?:^|/)run_specific_test_file\.sh$",
    r"(?:^|/)tests/test-isolated-[A-Za-z0-9_-]+\.sh$",
    r"^mypy$",
    r"^vitest$",
    r"^jest$",
    r"^eslint$",
    r"^tsc$",
    r"(?:^|/)scripts/test\.sh$",
)
DEFAULT_VERIFY_EXCLUDE_PATTERNS: tuple[str, ...] = (
    r"test-local-[A-Za-z0-9_-]*\.sh\b",
    r"\buvicorn\b",
    r"\b--watch\b",
)

_DISALLOWED_SHELL_SUBSTRINGS: tuple[str, ...] = ("$(", "`", "<(", ">(")
_SHELL_PUNCT_CHARS: frozenset[str] = frozenset("();<>|&\n\r")
_COMMENT_PRECEDING_CHARS: frozenset[str] = frozenset(" \t\n\r;&|()")
_EXIT_CODE_MARKER_RE = re.compile(r"<shellId:\s*\S+\s+completed with exit code\s+(-?\d+)>\s*$")
_SHELL_ID_RE = re.compile(r"<(?:command\b[^<>]*\b)?shellId:\s*([^\s>]+)")
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")
_GIT_COMMIT_NON_COMMITTING_FLAGS: frozenset[str] = frozenset(
    {"--dry-run", "--help", "-h", "--short", "--porcelain", "--long"}
)
_PYTHON_SIMPLE_FLAGS: frozenset[str] = frozenset(
    {"-u", "-B", "-E", "-I", "-O", "-OO", "-P", "-q", "-s", "-S", "-v", "-x"}
)
_PYTHON_VALUE_FLAGS: frozenset[str] = frozenset({"-W", "-X", "--check-hash-based-pycs"})
_ENV_BOOL_FLAGS: frozenset[str] = frozenset({"-i", "-0", "--ignore-environment", "--null", "-v", "--debug"})
_ENV_VALUE_FLAGS: frozenset[str] = frozenset({"-u", "--unset", "-C", "--chdir"})
_TIMEOUT_BOOL_FLAGS: frozenset[str] = frozenset({"--preserve-status", "--foreground", "-v", "--verbose"})
_TIMEOUT_VALUE_FLAGS: frozenset[str] = frozenset({"-k", "--kill-after", "-s", "--signal"})


def _normalized_extensions(raw: Any, default: tuple[str, ...]) -> set[str]:
    items = default if raw is None else raw
    return {str(ext).lower() for ext in items}


def classify_file_for_gates(path: str, file_rules: dict[str, Any]) -> tuple[bool, bool]:
    """Return ``(arms_tests_gate, counts_for_review_gate)`` for a modified file path."""
    rules = file_rules if isinstance(file_rules, dict) else {}
    exempt_exts = _normalized_extensions(rules.get("exempt_extensions"), DEFAULT_EXEMPT_EXTENSIONS)
    test_exts = _normalized_extensions(rules.get("test_extensions"), DEFAULT_TEST_EXTENSIONS)
    review_exts = _normalized_extensions(rules.get("review_extensions"), DEFAULT_REVIEW_EXTENSIONS)

    _, suffix = os.path.splitext(str(path or ""))
    suffix = suffix.lower()
    if suffix in exempt_exts:
        return False, False
    return suffix in test_exts, suffix in review_exts


def count_changed_lines(tool_name: str, tool_args: dict[str, Any]) -> int:
    """Count changed lines for ``create`` and ``edit`` tool invocations."""
    args = tool_args if isinstance(tool_args, dict) else {}
    if tool_name == "create":
        raw_text = args.get("file_text")
        text = "" if raw_text is None else str(raw_text)
        if not text:
            return 0
        return max(1, len(text.splitlines()))

    if tool_name == "edit":
        raw_old = args.get("old_str")
        raw_new = args.get("new_str")
        return count_edit_changed_lines(
            "" if raw_old is None else str(raw_old),
            "" if raw_new is None else str(raw_new),
        )

    return 0


def _matches_any_pattern(text: str, patterns: Sequence[Any]) -> bool:
    for raw_pattern in patterns:
        try:
            if re.search(str(raw_pattern), text):
                return True
        except re.error:
            continue
    return False


def _strip_unquoted_shell_comment(command: str) -> str:
    """Strip POSIX bash unquoted `#...` comments while preserving quoted `#` and mid-word `#`."""
    out: list[str] = []
    in_single = False
    in_double = False
    at_word_start = True
    i = 0
    n = len(command)
    while i < n:
        ch = command[i]
        if in_single:
            out.append(ch)
            if ch == "'":
                in_single = False
            i += 1
            continue
        if in_double:
            if ch == "\\" and i + 1 < n:
                out.append(command[i : i + 2])
                i += 2
                continue
            out.append(ch)
            if ch == '"':
                in_double = False
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            out.append(command[i : i + 2])
            at_word_start = command[i + 1] in ("\n", "\r")
            i += 2
            continue
        if ch == "'":
            in_single = True
            at_word_start = False
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            in_double = True
            at_word_start = False
            out.append(ch)
            i += 1
            continue
        if ch == "#" and at_word_start:
            while i < n and command[i] not in ("\n", "\r"):
                i += 1
            continue
        out.append(ch)
        at_word_start = ch in _COMMENT_PRECEDING_CHARS
        i += 1
    return "".join(out)


def _tokenize_shell_preserving_quoted_newlines(command: str) -> list[str] | None:
    if not command or not str(command).strip():
        return None
    for marker in _DISALLOWED_SHELL_SUBSTRINGS:
        if marker in command:
            return None
    import shlex

    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n\r")
        lexer.whitespace = " \t"
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return None


def _split_and_segments(tokens: list[str], *, allow_fd_dup: bool = True) -> list[list[str]] | None:
    """Split tokens on ``&&``; allow only safe ``2>&1`` / ``1>&2`` fd duplication if enabled."""
    segments: list[list[str]] = []
    current: list[str] = []
    idx = 0
    n = len(tokens)
    while idx < n:
        tok = tokens[idx]
        if tok == "&&":
            if not current:
                return None
            segments.append(current)
            current = []
            idx += 1
            continue
        if (
            allow_fd_dup
            and idx + 2 < n
            and tok in ("1", "2")
            and tokens[idx + 1] == ">&"
            and tokens[idx + 2] in ("1", "2")
            and tok != tokens[idx + 2]
        ):
            idx += 3
            continue
        if set(tok).issubset(_SHELL_PUNCT_CHARS):
            return None
        current.append(tok)
        idx += 1
    if not current:
        return None
    segments.append(current)
    return segments


def _extract_executable_candidate(segment: list[str]) -> str:
    """Resolve wrapper prefixes (ENV=val, env, timeout, poetry run, python -m, bash/sh)."""
    idx = 0
    while idx < len(segment) and _ENV_ASSIGN_RE.match(segment[idx]):
        idx += 1
    if idx >= len(segment):
        return ""

    head = segment[idx]
    rest = segment[idx + 1 :]
    base = os.path.basename(head)

    if base == "env":
        r_idx = 0
        while r_idx < len(rest):
            arg = rest[r_idx]
            if arg == "--":
                r_idx += 1
                break
            if arg in _ENV_BOOL_FLAGS:
                r_idx += 1
                continue
            if arg in _ENV_VALUE_FLAGS:
                r_idx += 2
                continue
            if arg.startswith(("--unset=", "--chdir=")):
                r_idx += 1
                continue
            if arg.startswith("-"):
                return head
            if _ENV_ASSIGN_RE.match(arg):
                r_idx += 1
                continue
            break
        return _extract_executable_candidate(rest[r_idx:])

    if base == "timeout":
        r_idx = 0
        while r_idx < len(rest):
            arg = rest[r_idx]
            if arg == "--":
                r_idx += 1
                break
            if arg in _TIMEOUT_BOOL_FLAGS:
                r_idx += 1
                continue
            if arg in _TIMEOUT_VALUE_FLAGS:
                r_idx += 2
                continue
            if arg.startswith(("--kill-after=", "--signal=")):
                r_idx += 1
                continue
            if len(arg) > 2 and arg[:2] in ("-k", "-s"):
                r_idx += 1
                continue
            if arg.startswith("-"):
                return head
            break
        if r_idx >= len(rest):
            return head
        r_idx += 1
        return _extract_executable_candidate(rest[r_idx:])

    if base == "poetry" and len(rest) >= 2 and rest[0] == "run":
        return _extract_executable_candidate(rest[1:])

    if base in ("python", "python3") or head.endswith(("/python", "/python3")):
        r_idx = 0
        while r_idx < len(rest):
            arg = rest[r_idx]
            if arg == "--":
                r_idx += 1
                return rest[r_idx] if r_idx < len(rest) else head
            if arg == "-m":
                return rest[r_idx + 1] if r_idx + 1 < len(rest) else head
            if arg.startswith("-m") and len(arg) > 2:
                return arg[2:]
            if arg in _PYTHON_SIMPLE_FLAGS:
                r_idx += 1
                continue
            if arg in _PYTHON_VALUE_FLAGS:
                r_idx += 2
                continue
            if arg.startswith(("-W", "-X")) and len(arg) > 2:
                r_idx += 1
                continue
            if arg.startswith("--check-hash-based-pycs="):
                r_idx += 1
                continue
            if arg.startswith("-"):
                return head
            return arg
        return head

    if base in ("bash", "sh"):
        r_idx = 0
        while r_idx < len(rest):
            arg = rest[r_idx]
            if arg == "--":
                r_idx += 1
                return rest[r_idx] if r_idx < len(rest) else head
            if arg == "-c" or arg == "--command" or (
                arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:]
            ):
                return head
            if arg == "-o":
                r_idx += 2
                continue
            if arg.startswith("-"):
                r_idx += 1
                continue
            return arg
        return head

    return head


def is_verification_command(command: str, verify_config: dict[str, Any]) -> bool:
    """Return True only when ``command`` actually executes an allowed verification tool without masking failures."""
    stripped = _strip_unquoted_shell_comment(command)
    tokens = _tokenize_shell_preserving_quoted_newlines(stripped)
    if not tokens:
        return False

    cfg = verify_config if isinstance(verify_config, dict) else {}
    raw_exclude = cfg.get("exclude_patterns")
    raw_include = cfg.get("include_patterns")
    exclude_patterns = DEFAULT_VERIFY_EXCLUDE_PATTERNS if raw_exclude is None else raw_exclude
    include_patterns = DEFAULT_VERIFY_INCLUDE_PATTERNS if raw_include is None else raw_include

    if _matches_any_pattern(stripped, exclude_patterns):
        return False

    # Split only on `&&` so exit-0 proves every segment succeeded; reject `;`, `||`, `|`, `&`, file redirections.
    segments = _split_and_segments(tokens, allow_fd_dup=True)
    if not segments:
        return False

    for seg in segments:
        candidate = _extract_executable_candidate(seg)
        if not candidate:
            continue
        base_name = os.path.basename(candidate)
        if _matches_any_pattern(candidate, include_patterns) or _matches_any_pattern(base_name, include_patterns):
            return True
    return False


def extract_shell_id_from_result(result: Any) -> str:
    """Extract a running or async ``shellId`` from a tool result dictionary."""
    if not isinstance(result, dict):
        return ""
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        raw_id = structured.get("shellId")
        if raw_id is not None and str(raw_id).strip():
            return str(raw_id).strip()
    for key in ("content", "textResultForLlm"):
        raw_text = result.get(key)
        if isinstance(raw_text, str) and raw_text:
            match = _SHELL_ID_RE.search(raw_text)
            if match:
                return match.group(1)
    return ""


def command_runs_git_commit(
    command: str,
    *,
    git_allowed_global_flags: Sequence[str] = ("--no-pager",),
) -> bool:
    """Return True when ``command`` runs a committing ``git commit`` (standalone or ``&&``-chained)."""
    stripped = _strip_unquoted_shell_comment(command)
    tokens = _tokenize_shell_preserving_quoted_newlines(stripped)
    if not tokens:
        return False
    segments = _split_and_segments(tokens, allow_fd_dup=True)
    if not segments:
        return False

    allowed_global = set(git_allowed_global_flags)
    for seg in segments:
        idx = 0
        while idx < len(seg) and _ENV_ASSIGN_RE.match(seg[idx]):
            idx += 1
        if idx >= len(seg) or seg[idx] != "git":
            continue
        idx += 1
        while idx < len(seg) and seg[idx].startswith("-"):
            if seg[idx] not in allowed_global:
                idx = len(seg)
                break
            idx += 1
        if idx >= len(seg) or seg[idx] != "commit":
            continue
        rest = seg[idx + 1 :]
        if any(arg in _GIT_COMMIT_NON_COMMITTING_FLAGS for arg in rest):
            continue
        return True
    return False


def extract_bash_exit_code_from_post_tool(tool_result: dict[str, Any] | None) -> int | None:
    """Extract integer exit code from ``postToolUse`` ``toolResult``, or ``None`` if still running/absent."""
    if not isinstance(tool_result, dict):
        return None

    shell_exec = tool_result.get("shellExecution")
    if isinstance(shell_exec, dict) and "exitCode" in shell_exec:
        exit_code = shell_exec.get("exitCode")
        if isinstance(exit_code, int) and not isinstance(exit_code, bool):
            return exit_code

    text = str(tool_result.get("textResultForLlm") or "")
    match = _EXIT_CODE_MARKER_RE.search(text)
    if match:
        return int(match.group(1))

    return None


def is_bash_exit_zero_from_post_tool(tool_result: dict[str, Any] | None) -> bool:
    """Verify exact exit code 0 from ``postToolUse`` ``toolResult`` (never trust ``resultType`` alone)."""
    return extract_bash_exit_code_from_post_tool(tool_result) == 0


def parse_commit_or_pr_command(
    command: str,
    *,
    git_allowed_global_flags: Sequence[str] = ("--no-pager",),
) -> tuple[bool, str | None]:
    """Identify simple ``git commit``, ``git push``, or ``gh pr create`` commands via strict shlex parsing.

    Quoted newlines inside `-m` / `--body` arguments are allowed, while unquoted newlines,
    compound operators, pipes, redirections, and substitutions are rejected.
    """
    tokens = _tokenize_shell_preserving_quoted_newlines(command)
    if not tokens:
        return False, None
    for tok in tokens:
        if set(tok).issubset(_SHELL_PUNCT_CHARS):
            return False, None

    allowed_global = set(git_allowed_global_flags)
    head = tokens[0]
    if head == "git":
        idx = 1
        while idx < len(tokens) and tokens[idx].startswith("-"):
            if tokens[idx] not in allowed_global:
                return False, None
            idx += 1
        if idx >= len(tokens):
            return False, None
        subcmd = tokens[idx]
        rest = tokens[idx + 1 :]
        if subcmd == "commit":
            if any(arg in _GIT_COMMIT_NON_COMMITTING_FLAGS for arg in rest):
                return False, None
            return True, "git_commit"
        if subcmd == "push":
            return True, "git_push"
        return False, None

    if head == "gh" and len(tokens) >= 3 and tokens[1] == "pr" and tokens[2] == "create":
        return True, "gh_pr_create"

    return False, None


def _parse_timestamp_ms(raw: Any) -> float | None:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        text = raw.strip()
        try:
            return float(text)
        except ValueError:
            pass
        from datetime import datetime

        try:
            iso = text[:-1] + "+00:00" if text.endswith("Z") else text
            return datetime.fromisoformat(iso).timestamp() * 1000.0
        except ValueError:
            return None
    return None


def _parse_arguments(raw_args: Any) -> dict[str, Any]:
    if isinstance(raw_args, dict):
        return dict(raw_args)
    if isinstance(raw_args, str) and raw_args.strip():
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _build_transcript_action(
    *,
    agent_id: str,
    tool_call_id: str,
    entry: dict[str, Any],
    data: dict[str, Any],
    start_info: dict[str, Any],
) -> dict[str, Any]:
    tool_name = str(start_info.get("tool_name") or data.get("toolName") or "")
    if "arguments" in start_info:
        arguments = dict(start_info["arguments"])
    else:
        arguments = _parse_arguments(data.get("arguments"))

    shell_exec = data.get("shellExecution")
    raw_exit = shell_exec.get("exitCode") if isinstance(shell_exec, dict) else None
    exit_code = raw_exit if (isinstance(raw_exit, int) and not isinstance(raw_exit, bool)) else None

    raw_edits = data.get("fileEdits")
    file_edits = [item for item in raw_edits if isinstance(item, dict)] if isinstance(raw_edits, list) else []
    shell_id = extract_shell_id_from_result(data.get("result")) if exit_code is None else ""

    return {
        "agent_id": agent_id,
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "success": bool(data.get("success", False)),
        "exit_code": exit_code,
        "file_edits": file_edits,
        "shell_id": shell_id,
        "started_at": start_info.get("started_at"),
        "completed_at": _parse_timestamp_ms(entry.get("timestamp") or data.get("timestamp")),
        "start_seq": start_info.get("start_seq"),
    }


def extract_subagent_actions_from_transcript(
    transcript_path: str | os.PathLike[str] | None,
    agent_id: str,
    processed_tool_call_ids: set[str],
) -> list[dict[str, Any]]:
    """Extract ordered, deduplicated tool execution records for ``agent_id`` from a JSONL transcript."""
    if not transcript_path or not agent_id:
        return []

    path = os.fspath(transcript_path)
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            raw_lines = fh.read().splitlines()
    except OSError:
        return []

    starts: dict[str, dict[str, Any]] = {}
    seen_complete_ids: set[str] = set()
    actions: list[dict[str, Any]] = []

    for line in raw_lines:
        if '"tool.execution_' not in line:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict) or entry.get("agentId") != agent_id:
            continue

        event_type = entry.get("type")
        raw_data = entry.get("data")
        data = raw_data if isinstance(raw_data, dict) else entry
        tool_call_id = data.get("toolCallId")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            continue

        if event_type == "tool.execution_start":
            starts[tool_call_id] = {
                "tool_name": str(data.get("toolName") or ""),
                "arguments": _parse_arguments(data.get("arguments")),
                "started_at": _parse_timestamp_ms(entry.get("timestamp") or data.get("timestamp")),
                "start_seq": len(starts),
            }
        elif event_type == "tool.execution_complete":
            if tool_call_id in processed_tool_call_ids or tool_call_id in seen_complete_ids:
                continue
            seen_complete_ids.add(tool_call_id)
            start_info = starts.get(tool_call_id, {})
            actions.append(
                _build_transcript_action(
                    agent_id=agent_id,
                    tool_call_id=tool_call_id,
                    entry=entry,
                    data=data,
                    start_info=start_info,
                )
            )

    return actions


def consume_transcript_actions(
    transcript_path: str | os.PathLike[str] | None,
    *,
    start_offset: int,
    pending_starts: dict[str, dict[str, Any]],
    processed_tool_call_ids: set[str],
) -> tuple[list[dict[str, Any]], int]:
    """Incrementally consume subagent tool executions from ``start_offset`` in a JSONL transcript."""
    offset = max(0, int(start_offset))
    if not transcript_path:
        return [], offset

    path = os.fspath(transcript_path)
    try:
        if not os.path.isfile(path):
            return [], offset
        file_size = os.path.getsize(path)
    except OSError:
        return [], offset

    if file_size < offset:
        offset = 0
        pending_starts.clear()

    try:
        with open(path, "rb") as fh:
            fh.seek(offset)
            chunk = fh.read()
    except OSError:
        return [], offset

    if not chunk:
        return [], offset

    cursor = offset
    seen_complete_ids: set[str] = set()
    actions: list[dict[str, Any]] = []

    for raw_line in chunk.splitlines(keepends=True):
        line_len = len(raw_line)
        ends_with_nl = raw_line.endswith(b"\n")
        if b'"tool.execution_' not in raw_line:
            if ends_with_nl:
                cursor += line_len
                continue
            try:
                json.loads(raw_line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                break
            cursor += line_len
            continue

        stripped = raw_line.decode("utf-8", errors="replace").strip()
        try:
            entry = json.loads(stripped)
        except json.JSONDecodeError:
            if not ends_with_nl:
                break
            cursor += line_len
            continue

        line_start_offset = cursor
        cursor += line_len
        if not isinstance(entry, dict):
            continue

        raw_agent_id = entry.get("agentId")
        if not isinstance(raw_agent_id, str) or not raw_agent_id.strip():
            continue

        event_type = entry.get("type")
        raw_data = entry.get("data")
        data = raw_data if isinstance(raw_data, dict) else entry
        tool_call_id = data.get("toolCallId")
        if not isinstance(tool_call_id, str) or not tool_call_id:
            continue

        if event_type == "tool.execution_start":
            pending_starts[tool_call_id] = {
                "tool_name": str(data.get("toolName") or ""),
                "arguments": _parse_arguments(data.get("arguments")),
                "started_at": _parse_timestamp_ms(entry.get("timestamp") or data.get("timestamp")),
                "start_seq": line_start_offset,
            }
            while len(pending_starts) > 200:
                pending_starts.pop(next(iter(pending_starts)))
        elif event_type == "tool.execution_complete":
            if tool_call_id in processed_tool_call_ids or tool_call_id in seen_complete_ids:
                continue
            seen_complete_ids.add(tool_call_id)
            start_info = pending_starts.pop(tool_call_id, {})
            actions.append(
                _build_transcript_action(
                    agent_id=raw_agent_id,
                    tool_call_id=tool_call_id,
                    entry=entry,
                    data=data,
                    start_info=start_info,
                )
            )

    return actions, cursor


def compute_net_review_dirty_lines(
    review_dirty_files: Sequence[str],
    cwd: str | os.PathLike[str] | None,
    fallback_file_lines: dict[str, int],
) -> int:
    """Compute net changed lines across ``review_dirty_files`` against git ``HEAD``, falling back cleanly."""
    if not review_dirty_files:
        return 0

    fallback_sum = sum(fallback_file_lines.values())
    cwd_str = os.fspath(cwd).strip() if isinstance(cwd, (str, os.PathLike)) else ""
    if (
        not cwd_str
        or not os.path.isdir(cwd_str)
        or not any(
            os.path.exists(p if os.path.isabs(p) else os.path.join(cwd_str, p))
            for p in review_dirty_files
        )
    ):
        return fallback_sum

    import subprocess

    try:
        root_proc = subprocess.run(
            ["git", "-C", cwd_str, "rev-parse", "--show-toplevel"],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return fallback_sum

    if root_proc.returncode != 0 or not root_proc.stdout.strip():
        return fallback_sum

    repo_root = os.path.realpath(root_proc.stdout.strip())
    inside_items: dict[str, tuple[str, int]] = {}  # repo_rel_posix -> (real_path, max_fallback_lines)
    outside_total = 0

    for orig_p in review_dirty_files:
        abs_p = orig_p if os.path.isabs(orig_p) else os.path.join(cwd_str, orig_p)
        real_p = os.path.realpath(abs_p)
        try:
            in_repo = os.path.commonpath([repo_root, real_p]) == repo_root and real_p != repo_root
        except ValueError:
            in_repo = False
        if in_repo:
            rel_p = os.path.relpath(real_p, repo_root).replace(os.sep, "/")
            fb_lines = fallback_file_lines.get(orig_p, 0)
            prev = inside_items.get(rel_p)
            if prev is None:
                inside_items[rel_p] = (real_p, fb_lines)
            else:
                inside_items[rel_p] = (prev[0], max(prev[1], fb_lines))
        else:
            outside_total += fallback_file_lines.get(orig_p, 0)

    if not inside_items:
        return outside_total

    rel_paths = list(inside_items.keys())
    try:
        diff_proc = subprocess.run(
            [
                "git",
                "-C",
                repo_root,
                "-c",
                "core.quotepath=false",
                "diff",
                "--no-renames",
                "--numstat",
                "HEAD",
                "--",
                *rel_paths,
            ],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return fallback_sum

    if diff_proc.returncode != 0:
        return fallback_sum

    diff_counts: dict[str, int] = {}
    for line in diff_proc.stdout.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        added_s, deleted_s, rel_path = parts
        fb_lines = inside_items[rel_path][1] if rel_path in inside_items else 0
        if added_s == "-" or deleted_s == "-":
            diff_counts[rel_path] = fb_lines
        else:
            try:
                diff_counts[rel_path] = max(int(added_s), int(deleted_s))
            except ValueError:
                diff_counts[rel_path] = fb_lines

    missing_rels = [rel_p for rel_p in inside_items if rel_p not in diff_counts]
    untracked_set: set[str] = set()
    ls_failed = False
    if missing_rels:
        try:
            ls_proc = subprocess.run(
                [
                    "git",
                    "-C",
                    repo_root,
                    "-c",
                    "core.quotepath=false",
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "--",
                    *missing_rels,
                ],
                text=True,
                capture_output=True,
                timeout=2,
                check=False,
            )
            if ls_proc.returncode == 0:
                untracked_set = {ln for ln in ls_proc.stdout.splitlines() if ln}
            else:
                ls_failed = True
        except (OSError, subprocess.SubprocessError):
            ls_failed = True

    total = outside_total
    for rel_p, (real_p, fb_lines) in inside_items.items():
        if rel_p in diff_counts:
            total += diff_counts[rel_p]
        elif ls_failed:
            total += fb_lines
        elif rel_p in untracked_set:
            if os.path.isfile(real_p):
                try:
                    with open(real_p, encoding="utf-8", errors="replace") as fh:
                        text = fh.read()
                    total += len(text.splitlines()) if text else 0
                except OSError:
                    total += fb_lines
            else:
                total += fb_lines
        else:
            # Tracked and clean vs HEAD (e.g. edited then reverted)
            total += 0

    return total


def missing_verification_checks(
    *,
    tests_required: bool,
    tests_verified: bool,
    review_required: bool,
    review_verified: bool,
) -> list[str]:
    """Return missing verification check names in deterministic order."""
    missing: list[str] = []
    if tests_required and not tests_verified:
        missing.append("tests")
    if review_required and not review_verified:
        missing.append("code-review")
    return missing


def format_gate_block_reason(
    missing: Sequence[str],
    *,
    sentinel: str | None = None,
    context: str = "commit/PR",
) -> str:
    """Format an actionable block reason specifying exactly which verification checks are missing."""
    if not missing:
        return ""

    descriptions: list[str] = []
    for item in missing:
        if item == "tests":
            descriptions.append(
                "tests/lint via a `general-purpose` subagent "
                "(`task` running the repository's test or lint commands "
                "(e.g., pytest, ruff, jest, or a repo test script))"
            )
        elif item == "code-review":
            descriptions.append("code review via a `code-review` subagent (`task`)")
        else:
            descriptions.append(str(item))

    if len(descriptions) == 1:
        summary = descriptions[0]
    elif len(descriptions) == 2:
        summary = f"{descriptions[0]} and {descriptions[1]}"
    else:
        summary = ", ".join(descriptions[:-1]) + f", and {descriptions[-1]}"

    message = f"Verification gate blocked {context}: missing {summary}."
    if sentinel:
        return f"{sentinel} {message}"
    return message
