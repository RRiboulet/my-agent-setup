#!/usr/bin/env python3
"""Fail-open Copilot CLI hook entrypoint for orchestrator-guard."""

from __future__ import annotations

import json
import os
import sys

# Ensure sibling package imports work regardless of current working directory.
_HOOKS_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
if _HOOKS_ROOT not in sys.path:
    sys.path.insert(0, _HOOKS_ROOT)

from orchestrator_guard.engine import handle_event  # noqa: E402


def main() -> int:
    event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            raise ValueError(f"Expected JSON object on stdin, got {type(payload).__name__}")
        result = handle_event(event, payload)
        if result:
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    except Exception as exc:
        from orchestrator_guard.telemetry import log_error

        log_error(event, exc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
