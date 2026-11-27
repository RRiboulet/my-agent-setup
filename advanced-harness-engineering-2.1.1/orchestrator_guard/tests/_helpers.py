"""Shared subprocess test harness for orchestrator_guard contract tests."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK_CLI = Path(__file__).resolve().parents[1] / "cli.py"
DEFAULT_POLICY = Path(__file__).resolve().parents[1] / "policy.json"


class HookSubprocessTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="orch-guard-test-")
        self.state_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_hook(
        self,
        event: str,
        payload: dict | str,
        *,
        env_overrides: dict[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict]:
        env = os.environ.copy()
        env["ORCHESTRATOR_HOOKS_STATE_DIR"] = str(self.state_dir)
        env.pop("ORCHESTRATOR_HOOKS", None)
        env.pop("ORCHESTRATOR_HOOKS_POLICY", None)
        if env_overrides:
            env.update(env_overrides)

        stdin_text = payload if isinstance(payload, str) else json.dumps(payload)
        proc = subprocess.run(
            [sys.executable, str(HOOK_CLI), event],
            input=stdin_text,
            text=True,
            capture_output=True,
            env=env,
            timeout=10,
            check=False,
        )
        stdout = proc.stdout.strip()
        parsed = json.loads(stdout) if stdout else {}
        return proc, parsed

    def read_telemetry(self) -> list[dict]:
        log_path = self.state_dir / "events.jsonl"
        if not log_path.exists():
            return []
        return [
            json.loads(line)
            for line in log_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
