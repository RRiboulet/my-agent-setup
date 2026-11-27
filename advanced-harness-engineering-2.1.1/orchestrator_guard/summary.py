#!/usr/bin/env python3
"""Telemetry summary CLI for orchestrator-guard JSONL event logs (AC-12 / RB-14)."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path
from typing import Any

_HOOKS_ROOT = Path(__file__).resolve().parent.parent
if str(_HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HOOKS_ROOT))

from orchestrator_guard.state import get_state_dir  # noqa: E402


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    rank = max(0, min(len(sorted_vals) - 1, math.ceil((pct / 100.0) * len(sorted_vals)) - 1))
    return sorted_vals[rank]


def summarize_log(log_path: Path, *, session_filter: str | None = None) -> dict[str, Any]:
    decisions: Counter[str] = Counter()
    denials_by_rule: Counter[str] = Counter()
    turn_modes: Counter[str] = Counter()
    events_by_mode: Counter[str] = Counter()
    sessions: set[str] = set()
    latencies: list[float] = []
    malformed_lines = 0
    total = 0

    if log_path.exists():
        if not log_path.is_file():
            raise ValueError(f"Telemetry log path is not a regular file: {log_path}")
        for raw in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                rec = json.loads(stripped)
            except json.JSONDecodeError:
                malformed_lines += 1
                continue
            if not isinstance(rec, dict):
                malformed_lines += 1
                continue

            sid = str(rec.get("session_id") or "")
            if session_filter is not None and sid != session_filter:
                continue

            total += 1
            if sid:
                sessions.add(sid)

            decision = str(rec.get("decision") or "allow")
            decisions[decision] += 1

            rule = str(rec.get("rule") or "unknown")
            if decision == "deny":
                denials_by_rule[rule] += 1

            mode = str(rec.get("mode") or "unknown")
            events_by_mode[mode] += 1
            if (
                rec.get("event") == "userPromptSubmitted"
                and rec.get("actor_role") != "subagent"
                and rule not in ("stop_block_continuation", "subagent_exempt")
            ):
                turn_modes[mode] += 1

            lat = rec.get("latency_ms")
            if isinstance(lat, (int, float)) and not isinstance(lat, bool):
                lat_f = float(lat)
                if math.isfinite(lat_f):
                    latencies.append(lat_f)

    latencies.sort()
    avg_lat = round(sum(latencies) / len(latencies), 2) if latencies else 0.0
    p50_lat = round(_percentile(latencies, 50.0), 2)
    p95_lat = round(_percentile(latencies, 95.0), 2)
    max_lat = round(latencies[-1], 2) if latencies else 0.0

    decision_counts = {
        "allow": decisions.get("allow", 0),
        "deny": decisions.get("deny", 0),
        "warn": decisions.get("warn", 0),
    }
    for key, val in decisions.items():
        if key not in decision_counts:
            decision_counts[key] = val

    denial_rate = round((decision_counts["deny"] / total) * 100.0, 2) if total else 0.0

    return {
        "log_path": str(log_path),
        "session_filter": session_filter,
        "total_invocations": total,
        "sessions": len(sessions),
        "malformed_lines": malformed_lines,
        "decisions": decision_counts,
        "denial_rate_pct": denial_rate,
        "denials_by_rule": dict(denials_by_rule.most_common()),
        "turn_modes": dict(turn_modes.most_common()),
        "events_by_mode": dict(events_by_mode.most_common()),
        "latency_ms": {
            "avg": avg_lat,
            "p50": p50_lat,
            "p95": p95_lat,
            "max": max_lat,
        },
    }


def format_text(summary: dict[str, Any]) -> str:
    decisions = summary["decisions"]
    lat = summary["latency_ms"]
    decision_parts = [f"{k}={v}" for k, v in decisions.items()]
    lines = [
        f"Telemetry log: {summary['log_path']}",
        (
            f"Total invocations: {summary['total_invocations']} "
            f"(sessions: {summary['sessions']}, malformed: {summary['malformed_lines']})"
        ),
        f"Decisions: {' '.join(decision_parts)} (denial rate: {summary['denial_rate_pct']}%)",
        f"Latency (ms): avg={lat['avg']} p50={lat['p50']} p95={lat['p95']} max={lat['max']}",
        "Denials by rule:",
    ]
    if summary["denials_by_rule"]:
        for rule, count in summary["denials_by_rule"].items():
            lines.append(f"  - {rule}: {count}")
    else:
        lines.append("  (none)")

    lines.append("Turn-mode distribution:")
    if summary["turn_modes"]:
        for mode, count in summary["turn_modes"].items():
            lines.append(f"  - {mode}: {count}")
    else:
        lines.append("  (none)")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Summarize orchestrator-guard JSONL hook telemetry.")
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="Path to events.jsonl (default: $ORCHESTRATOR_HOOKS_STATE_DIR/events.jsonl).",
    )
    parser.add_argument(
        "--session",
        default=None,
        help="Filter telemetry to a single session_id.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output machine-readable JSON instead of text.",
    )
    args = parser.parse_args(argv)

    log_path = args.log if args.log is not None else (get_state_dir() / "events.jsonl")
    try:
        summary = summarize_log(log_path, session_filter=args.session)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False, allow_nan=False))
    else:
        print(format_text(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
