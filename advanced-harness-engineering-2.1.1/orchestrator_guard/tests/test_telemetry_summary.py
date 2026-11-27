"""Subprocess contract tests for the telemetry summary CLI (AC-12 / RB-14)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SUMMARY_CLI = Path(__file__).resolve().parents[1] / "summary.py"


class TestTelemetrySummaryCLI(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="orch-summary-")
        self.state_dir = Path(self._tmp.name)
        self.log_path = self.state_dir / "events.jsonl"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_events(self, events: list[dict | str]) -> None:
        lines = [item if isinstance(item, str) else json.dumps(item) for item in events]
        self.log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _run_summary(
        self,
        args: list[str] | None = None,
        *,
        env_overrides: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["ORCHESTRATOR_HOOKS_STATE_DIR"] = str(self.state_dir)
        if env_overrides:
            env.update(env_overrides)
        return subprocess.run(
            [sys.executable, str(SUMMARY_CLI), *(args or [])],
            text=True,
            capture_output=True,
            env=env,
            timeout=10,
            check=False,
        )

    def test_reports_totals_decisions_denials_by_rule_modes_and_latency(self) -> None:
        self._write_events(
            [
                {
                    "timestamp": "2026-11-24T17:00:00Z",
                    "session_id": "s1",
                    "event": "userPromptSubmitted",
                    "actor_role": "parent",
                    "mode": "implement",
                    "tool": None,
                    "decision": "allow",
                    "rule": "heuristic:implement",
                    "counters": {"turn_index": 1},
                    "latency_ms": 1.2,
                },
                {
                    "timestamp": "2026-11-24T17:00:01Z",
                    "session_id": "s1",
                    "event": "preToolUse",
                    "actor_role": "parent",
                    "mode": "implement",
                    "tool": "bash",
                    "decision": "deny",
                    "rule": "bash_not_read_only",
                    "counters": {"turn_index": 1},
                    "latency_ms": 2.5,
                },
                {
                    "timestamp": "2026-11-24T17:00:02Z",
                    "session_id": "s1",
                    "event": "preToolUse",
                    "actor_role": "parent",
                    "mode": "implement",
                    "tool": "bash",
                    "decision": "deny",
                    "rule": "bash_not_read_only",
                    "counters": {"turn_index": 1},
                    "latency_ms": 1.5,
                },
                {
                    "timestamp": "2026-11-24T17:00:03Z",
                    "session_id": "s1",
                    "event": "preToolUse",
                    "actor_role": "parent",
                    "mode": "implement",
                    "tool": "view",
                    "decision": "deny",
                    "rule": "discovery_budget_exceeded",
                    "counters": {"turn_index": 1},
                    "latency_ms": 3.8,
                },
                {
                    "timestamp": "2026-11-24T17:00:04Z",
                    "session_id": "s2",
                    "event": "userPromptSubmitted",
                    "actor_role": "parent",
                    "mode": "qa",
                    "tool": None,
                    "decision": "allow",
                    "rule": "default:qa",
                    "counters": {"turn_index": 1},
                    "latency_ms": 1.0,
                },
                {
                    "timestamp": "2026-11-24T17:00:05Z",
                    "session_id": "s2",
                    "event": "postToolUse",
                    "actor_role": "parent",
                    "mode": "qa",
                    "tool": "bash",
                    "decision": "warn",
                    "rule": "warn_post_context",
                    "counters": {"turn_index": 1},
                    "latency_ms": 2.0,
                },
                "{corrupt json line",
            ]
        )

        # Human-readable default output (reads from ORCHESTRATOR_HOOKS_STATE_DIR/events.jsonl)
        proc = self._run_summary()
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        out = proc.stdout
        self.assertIn("Total invocations: 6", out)
        self.assertIn("bash_not_read_only", out)
        self.assertIn("discovery_budget_exceeded", out)
        self.assertIn("implement", out)
        self.assertIn("qa", out)

        # Structured JSON output
        proc_json = self._run_summary(["--json"])
        self.assertEqual(proc_json.returncode, 0, msg=proc_json.stderr)
        data = json.loads(proc_json.stdout)
        self.assertEqual(data["total_invocations"], 6)
        self.assertEqual(data["malformed_lines"], 1)
        self.assertEqual(data["sessions"], 2)
        self.assertEqual(data["decisions"], {"allow": 2, "deny": 3, "warn": 1})
        self.assertEqual(
            data["denials_by_rule"],
            {"bash_not_read_only": 2, "discovery_budget_exceeded": 1},
        )
        self.assertEqual(data["turn_modes"], {"implement": 1, "qa": 1})
        self.assertEqual(data["events_by_mode"], {"implement": 4, "qa": 2})
        self.assertAlmostEqual(data["latency_ms"]["avg"], 2.0, places=2)
        self.assertAlmostEqual(data["latency_ms"]["p50"], 1.5, places=2)
        self.assertAlmostEqual(data["latency_ms"]["p95"], 3.8, places=2)
        self.assertAlmostEqual(data["latency_ms"]["max"], 3.8, places=2)

        # Explicit --log overrides ORCHESTRATOR_HOOKS_STATE_DIR, and --session filters accurately
        other_log = self.state_dir / "custom-events.jsonl"
        other_log.write_text(self.log_path.read_text(encoding="utf-8"), encoding="utf-8")
        proc_s2 = self._run_summary(["--log", str(other_log), "--session", "s2", "--json"])
        self.assertEqual(proc_s2.returncode, 0, msg=proc_s2.stderr)
        s2 = json.loads(proc_s2.stdout)
        self.assertEqual(s2["log_path"], str(other_log))
        self.assertEqual(s2["total_invocations"], 2)
        self.assertEqual(s2["decisions"], {"allow": 1, "deny": 0, "warn": 1})
        self.assertEqual(s2["denials_by_rule"], {})
        self.assertEqual(s2["turn_modes"], {"qa": 1})

    def test_handles_edge_cases_nan_latency_stop_continuation_empty_session_and_dir_log(self) -> None:
        self._write_events(
            [
                '{"session_id":"s1","event":"userPromptSubmitted","actor_role":"parent","mode":"debug",'
                '"decision":"allow","rule":"stop_block_continuation","latency_ms":NaN}',
                '{"session_id":"s1","event":"userPromptSubmitted","actor_role":"subagent","mode":"qa",'
                '"decision":"allow","rule":"subagent_exempt","latency_ms":1.0}',
                '{"session_id":"s1","event":"userPromptSubmitted","actor_role":"subagent","mode":"implement",'
                '"decision":"allow","rule":"pass","latency_ms":1.0}',
                '{"session_id":"s1","event":"userPromptSubmitted","actor_role":"parent","mode":"review",'
                '"decision":"allow","rule":"subagent_exempt","latency_ms":1.0}',
                '{"session_id":"s1","event":"preToolUse","mode":"debug","decision":"custom",'
                '"rule":"r1","latency_ms":true}',
                '{"session_id":"s1","event":"preToolUse","mode":"debug","decision":"allow",'
                '"rule":"r2","latency_ms":4.0}',
            ]
        )
        proc = self._run_summary(["--json"])
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        # Strict RFC 8259 check: NaN must never appear in JSON output
        self.assertNotIn("NaN", proc.stdout)
        data = json.loads(proc.stdout)
        self.assertEqual(data["turn_modes"], {})
        self.assertEqual(data["events_by_mode"], {"debug": 3, "qa": 1, "implement": 1, "review": 1})
        self.assertEqual(data["latency_ms"]["avg"], 1.75)
        self.assertEqual(data["decisions"]["custom"], 1)

        proc_text = self._run_summary()
        self.assertEqual(proc_text.returncode, 0)
        self.assertIn("custom=1", proc_text.stdout)

        # --session "" filters to empty session_id (matches 0 records here)
        proc_empty_sid = self._run_summary(["--session", "", "--json"])
        self.assertEqual(proc_empty_sid.returncode, 0)
        self.assertEqual(json.loads(proc_empty_sid.stdout)["total_invocations"], 0)

        # Passing a directory to --log returns clean exit code 2 without raw traceback
        proc_dir = self._run_summary(["--log", str(self.state_dir)])
        self.assertEqual(proc_dir.returncode, 2)
        self.assertIn("not a regular file", proc_dir.stderr)

    def test_missing_log_file_exits_zero_with_empty_summary(self) -> None:
        proc = self._run_summary(["--json"])
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["total_invocations"], 0)
        self.assertEqual(data["decisions"], {"allow": 0, "deny": 0, "warn": 0})
        self.assertEqual(data["denials_by_rule"], {})
        self.assertEqual(data["turn_modes"], {})


if __name__ == "__main__":
    unittest.main()
