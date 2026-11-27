"""Strict shlex-based read-only shell allowlist for the parent orchestrator."""

from __future__ import annotations

from typing import Any

_DISALLOWED_SUBSTRINGS = ("$(", "`", "\n", "\r", "<(", ">(")
_SHELL_PUNCT_CHARS = frozenset("();<>|&")


def _tokenize(command: str) -> list[str] | None:
    if not command or not command.strip():
        return None
    for marker in _DISALLOWED_SUBSTRINGS:
        if marker in command:
            return None
    import shlex

    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.commenters = ""
        return list(lexer)
    except ValueError:
        return None


def _split_pipeline(tokens: list[str]) -> list[list[str]] | None:
    segments: list[list[str]] = []
    current: list[str] = []
    for tok in tokens:
        if tok == "|":
            if not current:
                return None
            segments.append(current)
            current = []
        elif set(tok).issubset(_SHELL_PUNCT_CHARS):
            return None
        else:
            current.append(tok)
    if not current:
        return None
    segments.append(current)
    return segments


def _is_allowed_git(segment: list[str], allowlist: dict[str, Any]) -> bool:
    allowed_global = set(allowlist.get("git_allowed_global_flags", ("--no-pager",)))
    allowed_subcommands = set(allowlist.get("git_subcommands", ()))
    branch_ro_flags = set(allowlist.get("git_branch_read_only_flags", ()))

    idx = 1
    while idx < len(segment) and segment[idx].startswith("-"):
        if segment[idx] not in allowed_global:
            return False
        idx += 1

    if idx >= len(segment):
        return False

    subcmd = segment[idx]
    if subcmd not in allowed_subcommands:
        return False

    rest = segment[idx + 1 :]
    if subcmd == "branch":
        return all(arg in branch_ro_flags for arg in rest)

    for arg in rest:
        if arg == "--output" or arg.startswith("--output="):
            return False

    return True


def is_read_only_bash_allowed(command: str, allowlist: dict[str, Any]) -> tuple[bool, str]:
    """Return (allowed, detail) for a parent `bash` command against the declarative allowlist."""
    tokens = _tokenize(command)
    if not tokens:
        return False, "empty, malformed, or contains shell substitution/newline"

    segments = _split_pipeline(tokens)
    if not segments:
        return False, "contains disallowed compound operator or redirection"

    primary = segments[0]
    allowed_cmds = set(allowlist.get("commands", ()))
    safe_pipes = set(allowlist.get("safe_pipe_commands", ()))

    head_cmd = primary[0]
    if head_cmd == "git":
        if not _is_allowed_git(primary, allowlist):
            return False, "git command is not in the read-only allowlist"
    elif head_cmd not in allowed_cmds:
        return False, f"command '{head_cmd}' is not in the read-only allowlist"

    for pipe_seg in segments[1:]:
        if pipe_seg[0] not in safe_pipes:
            return False, f"pipe target '{pipe_seg[0]}' is not in the safe read-only pipe allowlist"

    return True, "read_only_allowlist"
