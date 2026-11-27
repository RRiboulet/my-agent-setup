"""Unit tests for pure verification gate logic (Ticket #04).

Run:
    python3 -m unittest discover -s .github/orchestrator_guard/tests -p "test_verification_gate.py" -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

_HOOKS_ROOT = Path(__file__).resolve().parents[2]
if str(_HOOKS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HOOKS_ROOT))

from orchestrator_guard.verification_gate import (  # noqa: E402
    classify_file_for_gates,
    command_runs_git_commit,
    consume_transcript_actions,
    count_changed_lines,
    extract_bash_exit_code_from_post_tool,
    extract_shell_id_from_result,
    extract_subagent_actions_from_transcript,
    format_gate_block_reason,
    is_bash_exit_zero_from_post_tool,
    is_verification_command,
    missing_verification_checks,
    parse_commit_or_pr_command,
)


class TestClassifyFileForGates(unittest.TestCase):
    def test_default_classification_by_extension(self) -> None:
        cases = [
            ("src/app.py", (True, True)),
            ("SRC/APP.PY", (True, True)),
            ("infra/main.tf", (False, True)),
            ("migrations/001_init.SQL", (False, True)),
            ("scripts/run.sh", (False, True)),
            ("config/settings.json", (False, True)),
            (".github/workflows/ci.yml", (False, True)),
            ("helm/values.YAML", (False, True)),
            ("README.md", (False, False)),
            ("docs/NOTES.TXT", (False, False)),
            ("Makefile", (False, False)),
            (".gitignore", (False, False)),
            ("", (False, False)),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                self.assertEqual(classify_file_for_gates(path, {}), expected)

    def test_exempt_extensions_override_test_and_review(self) -> None:
        rules = {
            "test_extensions": [".py", ".txt"],
            "review_extensions": [".py", ".md", ".txt"],
            "exempt_extensions": [".md", ".txt"],
        }
        self.assertEqual(classify_file_for_gates("notes.md", rules), (False, False))
        self.assertEqual(classify_file_for_gates("notes.txt", rules), (False, False))
        self.assertEqual(classify_file_for_gates("handler.py", rules), (True, True))

    def test_custom_rules_and_explicit_empty_lists(self) -> None:
        rules = {
            "test_extensions": [".ts"],
            "review_extensions": [".ts", ".tsx"],
            "exempt_extensions": [],
        }
        self.assertEqual(classify_file_for_gates("web/index.TS", rules), (True, True))
        self.assertEqual(classify_file_for_gates("web/view.tsx", rules), (False, True))
        self.assertEqual(classify_file_for_gates("app.py", rules), (False, False))
        self.assertEqual(classify_file_for_gates("README.md", rules), (False, False))


class TestCountChangedLines(unittest.TestCase):
    def test_create_counts_lines_and_handles_empty(self) -> None:
        self.assertEqual(count_changed_lines("create", {"file_text": ""}), 0)
        self.assertEqual(count_changed_lines("create", {"file_text": None}), 0)
        self.assertEqual(count_changed_lines("create", {}), 0)
        self.assertEqual(count_changed_lines("create", {"file_text": "x"}), 1)
        self.assertEqual(count_changed_lines("create", {"file_text": "\n"}), 1)
        self.assertEqual(count_changed_lines("create", {"file_text": "a\nb\nc\n"}), 3)

    def test_edit_uses_sequence_matcher_opcodes(self) -> None:
        # Identical text -> 0
        self.assertEqual(
            count_changed_lines("edit", {"old_str": "a\nb\n", "new_str": "a\nb\n"}),
            0,
        )
        # Pure insertion of 3 lines
        self.assertEqual(
            count_changed_lines("edit", {"old_str": "a\nd", "new_str": "a\nb\nc\ne\nd"}),
            3,
        )
        # Pure deletion of 2 lines
        self.assertEqual(
            count_changed_lines("edit", {"old_str": "a\nb\nc\nd", "new_str": "a\nd"}),
            2,
        )
        # Replace 1 line with 4 lines -> max(1, 4) = 4
        self.assertEqual(
            count_changed_lines(
                "edit",
                {"old_str": "x = 1\ny = 2", "new_str": "x = 1\na = 1\nb = 2\nc = 3\nd = 4"},
            ),
            4,
        )

    def test_other_tools_return_zero(self) -> None:
        self.assertEqual(count_changed_lines("view", {"path": "a.py"}), 0)
        self.assertEqual(count_changed_lines("bash", {"command": "pytest"}), 0)


class TestIsVerificationCommand(unittest.TestCase):
    def test_accepts_real_repo_verification_commands(self) -> None:
        valid = [
            "pytest",
            "poetry run pytest tests/",
            "poetry run pytest tests/ 2>&1",
            "ruff check .",
            "ruff check . 2>&1",
            "ruff format --check .",
            "pytest 1>&2",
            "cd /repo && PYTHONPATH=. timeout 600 "
            ".venv/bin/pytest -q tests/isolated/billing",
            "env PYTHONPATH=. .venv/bin/pytest -q tests/",
            "env -i -u FOO --chdir=/repo PYTHONPATH=. python3 -B -O -W ignore -m unittest",
            "python3 -u -m pytest tests/",
            "python3 -m unittest discover -s .github/orchestrator_guard/tests -v",
            "timeout -k 10 120 poetry run pytest -q 2>&1",
            "timeout --preserve-status --signal=TERM 60 pytest",
            "./run_unit_tests.sh",
            "bash run_app_tests.sh",
            "sh -e ./run_unit_tests.sh",
            "./run_specific_test_file.sh tests/test_foo.py",
            "./tests/test-isolated-service.sh",
            "tests/test-isolated-accounts.sh -k auth",
            "pytest # trailing comment",
            'pytest -k "test#1"',
            "pytest -k 'test#1'",
            "pytest -k foo#bar",
            r"pytest \#arg",
        ]
        for cmd in valid:
            with self.subTest(cmd=cmd):
                self.assertTrue(is_verification_command(cmd, {}), f"Expected True for: {cmd}")

    def test_rejects_dev_servers_and_unrelated_commands(self) -> None:
        invalid = [
            "",
            "   ",
            "cat pytest.ini",
            "echo pytest",
            "git diff pytest.ini",
            "grep ruff pyproject.toml",
            "pytest || true",
            "pytest; echo done",
            "pytest > /tmp/out.txt",
            "pytest 2>/tmp/err.txt",
            "pytest 2>&1 >/tmp/out.txt",
            "pytest | cat",
            "pytest &",
            'python3 -c "import pytest"',
            'bash -c "pytest"',
            "true # && pytest",
            "# pytest",
            "true; # && pytest",
            "env -S echo pytest",
            "env --split-string=echo pytest",
            "env --split-string pytest",
            'env -S "pytest && true"',
            "./test-local-accounts.sh",
            "./test-local-service.sh",
            "./test-local-all-apis.sh",
            "poetry run uvicorn app:app --reload",
            "pytest && ./test-local-service.sh",
            "uvicorn main:app & pytest",
            "echo pytest_helper",
            "git status",
            "ls -la",
        ]
        for cmd in invalid:
            with self.subTest(cmd=cmd):
                self.assertFalse(is_verification_command(cmd, {}), f"Expected False for: {cmd}")

    def test_custom_verify_config_patterns(self) -> None:
        cfg = {
            "include_patterns": [r"\bmypy\b"],
            "exclude_patterns": [r"--skip-check"],
        }
        self.assertTrue(is_verification_command("mypy src/", cfg))
        self.assertFalse(is_verification_command("mypy src/ --skip-check", cfg))
        self.assertFalse(is_verification_command("pytest", cfg))


class TestIsBashExitZeroFromPostTool(unittest.TestCase):
    def test_rejects_result_type_success_without_exit_zero_proof(self) -> None:
        # Critical OA-2 regression check: resultType=="success" with exit code 1 or missing marker
        self.assertFalse(is_bash_exit_zero_from_post_tool(None))
        self.assertFalse(is_bash_exit_zero_from_post_tool({"resultType": "success"}))
        self.assertFalse(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "textResultForLlm": "1 failed\n<shellId: 42 completed with exit code 1>",
                }
            )
        )
        self.assertFalse(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "textResultForLlm": (
                        "<shellId: 1 completed with exit code 0>\n"
                        "<shellId: 2 completed with exit code 1>"
                    ),
                }
            )
        )
        self.assertFalse(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "shellExecution": {"exitCode": 1},
                    "textResultForLlm": "<shellId: 9 completed with exit code 0>",
                }
            )
        )
        self.assertFalse(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "shellExecution": {"exitCode": True},
                }
            )
        )

    def test_accepts_explicit_exit_code_zero(self) -> None:
        self.assertTrue(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "textResultForLlm": "5 passed in 0.2s\n<shellId: abc-123 completed with exit code 0>\n",
                }
            )
        )
        self.assertTrue(
            is_bash_exit_zero_from_post_tool(
                {
                    "resultType": "success",
                    "shellExecution": {"exitCode": 0},
                }
            )
        )

    def test_extract_bash_exit_code_from_post_tool(self) -> None:
        self.assertIsNone(extract_bash_exit_code_from_post_tool(None))
        self.assertIsNone(extract_bash_exit_code_from_post_tool({"resultType": "success"}))
        self.assertIsNone(
            extract_bash_exit_code_from_post_tool(
                {
                    "resultType": "success",
                    "textResultForLlm": "<command started in background with shellId: fullsuite>",
                }
            )
        )
        self.assertEqual(
            extract_bash_exit_code_from_post_tool(
                {"resultType": "success", "textResultForLlm": "failed\n<shellId: 42 completed with exit code 1>"}
            ),
            1,
        )
        self.assertEqual(
            extract_bash_exit_code_from_post_tool(
                {
                    "resultType": "success",
                    "textResultForLlm": "ok\n<shellId: fullsuite completed with exit code 0>",
                }
            ),
            0,
        )
        self.assertEqual(
            extract_bash_exit_code_from_post_tool({"shellExecution": {"exitCode": -2}}),
            -2,
        )


class TestParseCommitOrPrCommand(unittest.TestCase):
    def test_matches_commit_push_and_pr_create(self) -> None:
        cases = [
            ('git commit -m "feat: add guard"', (True, "git_commit")),
            ('git commit -m "fix #123"', (True, "git_commit")),
            ("git commit -m 'fix #123'", (True, "git_commit")),
            ('git commit -n -m "msg"', (True, "git_commit")),
            ('git commit --status -m "msg"', (True, "git_commit")),
            ("git --no-pager commit --amend --no-edit", (True, "git_commit")),
            ("git push origin feature/guard", (True, "git_push")),
            ("git --no-pager push -u origin main", (True, "git_push")),
            ('gh pr create --title "Add gate" --body "Details"', (True, "gh_pr_create")),
        ]
        for cmd, expected in cases:
            with self.subTest(cmd=cmd):
                self.assertEqual(parse_commit_or_pr_command(cmd), expected)

    def test_rejects_compound_injection_and_disallowed_flags(self) -> None:
        cases = [
            "",
            "git status",
            "git diff HEAD",
            "git commit --dry-run",
            "git commit --help",
            "git commit -h",
            "git commit --short",
            "git commit --porcelain",
            'git commit --long -m "msg"',
            "gh pr list",
            "gh pr view 42",
            "git -c core.sshCommand=evil push",
            "git -C /tmp commit -m x",
            "git status && git commit -m x",
            "git commit -m x; rm -rf /",
            "git commit -m x | cat",
            "git commit -m x > out.txt",
            "git commit -m $(whoami)",
            "git commit -m `whoami`",
            "git commit -m x <(echo y)",
            "git commit -m x\ngit push",
            'git commit -m "unclosed quote',
        ]
        for cmd in cases:
            with self.subTest(cmd=cmd):
                self.assertEqual(parse_commit_or_pr_command(cmd), (False, None))


class TestExtractSubagentActionsFromTranscript(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="orch-vg-test-")
        self.tmp_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_transcript(self, lines: list[str]) -> Path:
        path = self.tmp_dir / "transcript.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def test_handles_missing_none_unreadable_and_malformed_lines(self) -> None:
        self.assertEqual(extract_subagent_actions_from_transcript(None, "a1", set()), [])
        self.assertEqual(extract_subagent_actions_from_transcript(self.tmp_dir / "missing.jsonl", "a1", set()), [])
        self.assertEqual(extract_subagent_actions_from_transcript(self.tmp_dir, "a1", set()), [])

        path = self._write_transcript(
            [
                "{not valid json",
                json.dumps([1, 2, 3]),
                json.dumps(
                    {
                        "type": "tool.execution_start",
                        "agentId": "a1",
                        "data": {"toolCallId": "tc1", "toolName": "bash", "arguments": {"command": "pytest"}},
                    }
                ),
                json.dumps(
                    {
                        "type": "tool.execution_complete",
                        "agentId": "a1",
                        "data": {
                            "toolCallId": "tc1",
                            "success": True,
                            "shellExecution": {"exitCode": 0},
                        },
                    }
                ),
            ]
        )
        actions = extract_subagent_actions_from_transcript(path, "a1", set())
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["tool_call_id"], "tc1")
        self.assertEqual(actions[0]["exit_code"], 0)

    def test_filters_agent_deduplicates_preserves_order_and_strict_exit_code(self) -> None:
        events = [
            # Other agent must be ignored
            {
                "type": "tool.execution_start",
                "agentId": "other",
                "data": {"toolCallId": "tc-other", "toolName": "bash", "arguments": {"command": "pytest"}},
            },
            {
                "type": "tool.execution_complete",
                "agentId": "other",
                "data": {"toolCallId": "tc-other", "success": True, "shellExecution": {"exitCode": 0}},
            },
            # Already processed tool call must be skipped
            {
                "type": "tool.execution_start",
                "agentId": "worker-1",
                "data": {"toolCallId": "tc-old", "toolName": "edit", "arguments": {"path": "old.py"}},
            },
            {
                "type": "tool.execution_complete",
                "agentId": "worker-1",
                "data": {"toolCallId": "tc-old", "success": True},
            },
            # Start tc-edit and tc-bash, then complete tc-bash (exit 1 despite success=True!), then tc-edit
            {
                "type": "tool.execution_start",
                "agentId": "worker-1",
                "data": {
                    "toolCallId": "tc-edit",
                    "toolName": "edit",
                    "arguments": {"path": "app.py", "old_str": "a", "new_str": "b"},
                },
            },
            {
                "type": "tool.execution_start",
                "agentId": "worker-1",
                "data": {"toolCallId": "tc-bash-fail", "toolName": "bash", "arguments": {"command": "pytest"}},
            },
            {
                "type": "tool.execution_complete",
                "agentId": "worker-1",
                "data": {
                    "toolCallId": "tc-bash-fail",
                    "success": True,
                    "shellExecution": {"exitCode": 1},
                },
            },
            {
                "type": "tool.execution_complete",
                "agentId": "worker-1",
                "data": {
                    "toolCallId": "tc-edit",
                    "success": True,
                    "fileEdits": [{"path": "app.py"}],
                },
            },
            # Bool exitCode or missing shellExecution must yield exit_code=None (never inferred from success)
            {
                "type": "tool.execution_start",
                "agentId": "worker-1",
                "data": {"toolCallId": "tc-bash-bool", "toolName": "bash", "arguments": {"command": "ruff check ."}},
            },
            {
                "type": "tool.execution_complete",
                "agentId": "worker-1",
                "data": {
                    "toolCallId": "tc-bash-bool",
                    "success": True,
                    "shellExecution": {"exitCode": True},
                },
            },
        ]
        path = self._write_transcript([json.dumps(e) for e in events])
        actions = extract_subagent_actions_from_transcript(path, "worker-1", {"tc-old"})

        self.assertEqual([a["tool_call_id"] for a in actions], ["tc-bash-fail", "tc-edit", "tc-bash-bool"])
        self.assertEqual(actions[0]["tool_name"], "bash")
        self.assertTrue(actions[0]["success"])
        self.assertEqual(actions[0]["exit_code"], 1)

        self.assertEqual(actions[1]["tool_name"], "edit")
        self.assertIsNone(actions[1]["exit_code"])
        self.assertEqual(actions[1]["file_edits"], [{"path": "app.py"}])
        self.assertEqual(actions[1]["arguments"]["path"], "app.py")

        self.assertEqual(actions[2]["tool_name"], "bash")
        self.assertTrue(actions[2]["success"])
        self.assertIsNone(actions[2]["exit_code"])


class TestMissingChecksAndFormatting(unittest.TestCase):
    def test_missing_verification_checks_matrix(self) -> None:
        self.assertEqual(
            missing_verification_checks(
                tests_required=False,
                tests_verified=False,
                review_required=False,
                review_verified=False,
            ),
            [],
        )
        self.assertEqual(
            missing_verification_checks(
                tests_required=True,
                tests_verified=False,
                review_required=False,
                review_verified=False,
            ),
            ["tests"],
        )
        self.assertEqual(
            missing_verification_checks(
                tests_required=True,
                tests_verified=True,
                review_required=True,
                review_verified=False,
            ),
            ["code-review"],
        )
        self.assertEqual(
            missing_verification_checks(
                tests_required=True,
                tests_verified=False,
                review_required=True,
                review_verified=False,
            ),
            ["tests", "code-review"],
        )

    def test_format_gate_block_reason(self) -> None:
        self.assertEqual(format_gate_block_reason([]), "")

        tests_only = format_gate_block_reason(["tests"])
        self.assertIn("general-purpose", tests_only)
        self.assertNotIn("code-review", tests_only)

        review_only = format_gate_block_reason(["code-review"], context="completing turn")
        self.assertIn("code-review", review_only)
        self.assertIn("completing turn", review_only)
        self.assertNotIn("general-purpose", review_only)

        both = format_gate_block_reason(
            ["tests", "code-review"],
            sentinel="[orchestrator-guard:verify-required]",
        )
        self.assertTrue(both.startswith("[orchestrator-guard:verify-required] "))
        self.assertIn("general-purpose", both)
        self.assertIn("code-review", both)


class TestCommandRunsGitCommit(unittest.TestCase):
    def test_matches_standalone_and_and_chained_commits(self) -> None:
        positives = [
            'git commit -m "feat: fix"',
            'git commit -m "fix #123"',
            "git commit -m 'fix #123' # trailing comment",
            'git commit -n -m "msg"',
            'git commit --status -m "msg"',
            "git --no-pager commit --amend --no-edit",
            'git add a.py && git commit -m "msg"',
            'cd /repo && git add a.py b.py && git commit -m "msg" 2>&1',
        ]
        for cmd in positives:
            with self.subTest(cmd=cmd):
                self.assertTrue(command_runs_git_commit(cmd))

    def test_rejects_non_committing_and_masking_operators(self) -> None:
        negatives = [
            "",
            "git status",
            "git commit --dry-run",
            "git commit -h",
            "git commit --help",
            "git commit --short",
            "git commit --porcelain",
            'git commit --long -m "msg"',
            "true # && git commit -m x",
            "# git commit -m x",
            'git add a.py; git commit -m "msg"',
            'git commit -m "msg" || true',
            'git commit -m "msg" | cat',
            "echo git commit -m msg",
        ]
        for cmd in negatives:
            with self.subTest(cmd=cmd):
                self.assertFalse(command_runs_git_commit(cmd))


class TestConsumeTranscriptActionsAndShellId(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="orch-inc-test-")
        self.tmp_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_extract_shell_id_from_result(self) -> None:
        self.assertEqual(
            extract_shell_id_from_result({"structuredContent": {"shellId": 149}}),
            "149",
        )
        self.assertEqual(
            extract_shell_id_from_result({"content": "<command with shellId: 149 is still running...>"}),
            "149",
        )
        self.assertEqual(
            extract_shell_id_from_result(
                {"textResultForLlm": "<command started in background with shellId: fullsuite>"}
            ),
            "fullsuite",
        )
        self.assertEqual(
            extract_shell_id_from_result({"textResultForLlm": "<shellId: 42 completed with exit code 0>"}),
            "42",
        )
        self.assertEqual(
            extract_shell_id_from_result({"textResultForLlm": "<shellId: abc-123>"}),
            "abc-123",
        )
        self.assertEqual(extract_shell_id_from_result({}), "")

    def test_incremental_offset_partial_line_and_truncation_reset(self) -> None:
        path = self.tmp_dir / "t.jsonl"
        pending: dict[str, dict] = {}
        processed: set[str] = set()

        line1 = json.dumps(
            {
                "type": "tool.execution_start",
                "agentId": "a1",
                "timestamp": 1000,
                "data": {"toolCallId": "tc1", "toolName": "bash", "arguments": {"command": "pytest"}},
            }
        )
        partial = '{"type":"tool.execution_complete","agentId":"a1","data":{"toolCallId":"tc1"'
        path.write_text(line1 + "\n" + partial, encoding="utf-8")

        actions1, off1 = consume_transcript_actions(
            path, start_offset=0, pending_starts=pending, processed_tool_call_ids=processed
        )
        self.assertEqual(actions1, [])
        self.assertIn("tc1", pending)
        self.assertEqual(off1, len((line1 + "\n").encode("utf-8")))

        # Complete the partial line
        rest = ',"success":true,"shellExecution":{"exitCode":0}}}\n'
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(rest)

        actions2, off2 = consume_transcript_actions(
            path, start_offset=off1, pending_starts=pending, processed_tool_call_ids=processed
        )
        self.assertEqual(len(actions2), 1)
        self.assertEqual(actions2[0]["tool_call_id"], "tc1")
        self.assertEqual(actions2[0]["exit_code"], 0)
        self.assertEqual(pending, {})
        self.assertEqual(off2, path.stat().st_size)

        # Truncate and rewrite smaller file -> cursor resets to 0 automatically
        small_line = json.dumps(
            {
                "type": "tool.execution_complete",
                "agentId": "a2",
                "data": {"toolCallId": "tc2", "toolName": "bash", "arguments": {"command": "ruff check ."}},
            }
        )
        path.write_text(small_line + "\n", encoding="utf-8")
        actions3, off3 = consume_transcript_actions(
            path, start_offset=off2, pending_starts=pending, processed_tool_call_ids=processed
        )
        self.assertEqual(len(actions3), 1)
        self.assertEqual(actions3[0]["agent_id"], "a2")
        self.assertEqual(actions3[0]["tool_call_id"], "tc2")
        self.assertEqual(off3, path.stat().st_size)

    def test_large_35mb_transcript_prefilter_performance(self) -> None:
        path = self.tmp_dir / "large.jsonl"
        filler_line = (b'{"type":"assistant.message","data":{"content":"' + (b"x" * 500) + b'"}}\n')
        # ~35 MB of non-tool transcript events plus 1 subagent tool execution
        with open(path, "wb") as fh:
            fh.write(filler_line * 66000)
            fh.write(
                (
                    json.dumps(
                        {
                            "type": "tool.execution_start",
                            "agentId": "gp-fast",
                            "timestamp": 2000,
                            "data": {"toolCallId": "tc-fast", "toolName": "bash", "arguments": {"command": "pytest"}},
                        }
                    )
                    + "\n"
                ).encode("utf-8")
            )
            fh.write(
                (
                    json.dumps(
                        {
                            "type": "tool.execution_complete",
                            "agentId": "gp-fast",
                            "timestamp": 2001,
                            "data": {"toolCallId": "tc-fast", "success": True, "shellExecution": {"exitCode": 0}},
                        }
                    )
                    + "\n"
                ).encode("utf-8")
            )
        self.assertGreater(path.stat().st_size, 34 * 1024 * 1024)

        pending: dict[str, dict] = {}
        t0 = time.perf_counter()
        actions, new_off = consume_transcript_actions(
            path, start_offset=0, pending_starts=pending, processed_tool_call_ids=set()
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["tool_call_id"], "tc-fast")
        self.assertEqual(new_off, path.stat().st_size)
        self.assertLess(elapsed_ms, 200.0, f"Expected fast pre-filter scan, took {elapsed_ms:.1f} ms")


class TestComputeNetReviewDirtyLines(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="orch-netdiff-")
        self.repo_dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _git(self, *args: str) -> str:
        import subprocess

        proc = subprocess.run(
            ["git", "-C", str(self.repo_dir), *args],
            text=True,
            capture_output=True,
            check=True,
        )
        return proc.stdout

    def test_empty_and_nonexistent_fallback(self) -> None:
        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self.assertEqual(compute_net_review_dirty_lines([], None, {"a.py": 10}), 0)
        self.assertEqual(
            compute_net_review_dirty_lines(["/nonexistent/a.py"], "/nonexistent", {"/nonexistent/a.py": 25}),
            25,
        )

    def test_unborn_head_falls_back_to_fallback_sum(self) -> None:
        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self._git("init")
        f = self.repo_dir / "a.py"
        f.write_text("x = 1\n", encoding="utf-8")
        self.assertEqual(
            compute_net_review_dirty_lines([str(f)], str(self.repo_dir), {str(f): 12}),
            12,
        )

    def test_net_diff_tracked_untracked_reverted_and_outside_repo(self) -> None:
        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self._git("init")
        self._git("config", "user.name", "Test")
        self._git("config", "user.email", "test@example.com")
        mod = self.repo_dir / "mod.py"
        mod.write_text("\n".join(f"line_{i} = {i}" for i in range(60)) + "\n", encoding="utf-8")
        self._git("add", "mod.py")
        self._git("commit", "-m", "init")

        # Modify 20 lines -> net 20 even if fallback accumulated 60
        lines = mod.read_text(encoding="utf-8").splitlines()
        for i in range(20):
            lines[i] = f"line_{i} = {i + 100}"
        mod.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertEqual(
            compute_net_review_dirty_lines([str(mod)], str(self.repo_dir), {str(mod): 60}),
            20,
        )

        # Untracked 15-line file -> net 20 + 15 = 35
        untracked = self.repo_dir / "new.py"
        untracked.write_text("\n".join(f"u_{i} = {i}" for i in range(15)) + "\n", encoding="utf-8")
        self.assertEqual(
            compute_net_review_dirty_lines(
                [str(mod), str(untracked)],
                str(self.repo_dir),
                {str(mod): 60, str(untracked): 15},
            ),
            35,
        )

        # Revert mod.py back to HEAD -> net 0 for mod.py
        self._git("checkout", "--", "mod.py")
        self.assertEqual(
            compute_net_review_dirty_lines([str(mod)], str(self.repo_dir), {str(mod): 60}),
            0,
        )

    def test_renamed_tracked_file_returns_nonzero_net_lines(self) -> None:
        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self._git("init")
        self._git("config", "user.name", "Test")
        self._git("config", "user.email", "test@example.com")
        src_dir = self.repo_dir / "src"
        src_dir.mkdir()
        old_path = src_dir / "old.py"
        orig_lines = [f"v_{i} = {i}" for i in range(30)]
        old_path.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
        self._git("add", "src/old.py")
        self._git("commit", "-m", "init")

        new_path = src_dir / "new.py"
        self._git("mv", "src/old.py", "src/new.py")
        edited_lines = [f"v_{i} = {i + 100}" if i < 25 else f"v_{i} = {i}" for i in range(30)]
        new_path.write_text("\n".join(edited_lines) + "\n", encoding="utf-8")

        net_both = compute_net_review_dirty_lines(
            [str(old_path), str(new_path)],
            str(self.repo_dir),
            {str(old_path): 0, str(new_path): 25},
        )
        self.assertEqual(net_both, 60)

        net_new_only = compute_net_review_dirty_lines(
            [str(new_path)],
            str(self.repo_dir),
            {str(new_path): 25},
        )
        self.assertEqual(net_new_only, 30)

    def test_relative_paths_with_different_process_cwd_use_git_net_diff(self) -> None:
        import os

        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self._git("init")
        self._git("config", "user.name", "Test")
        self._git("config", "user.email", "test@example.com")
        mod = self.repo_dir / "mod.py"
        orig_lines = [f"line_{i} = {i}" for i in range(40)]
        mod.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
        self._git("add", "mod.py")
        self._git("commit", "-m", "init")

        lines = mod.read_text(encoding="utf-8").splitlines()
        for i in range(10):
            lines[i] = f"line_{i} = {i + 500}"
        mod.write_text("\n".join(lines) + "\n", encoding="utf-8")

        with tempfile.TemporaryDirectory(prefix="orch-other-cwd-") as other_cwd:
            prev_cwd = os.getcwd()
            try:
                os.chdir(other_cwd)
                self.assertEqual(
                    compute_net_review_dirty_lines(["mod.py"], str(self.repo_dir), {"mod.py": 99}),
                    10,
                )
            finally:
                os.chdir(prev_cwd)

    def test_symlink_and_canonical_path_counted_once(self) -> None:
        from orchestrator_guard.verification_gate import compute_net_review_dirty_lines

        self._git("init")
        self._git("config", "user.name", "Test")
        self._git("config", "user.email", "test@example.com")
        mod = self.repo_dir / "mod.py"
        orig_lines = [f"line_{i} = {i}" for i in range(40)]
        mod.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
        self._git("add", "mod.py")
        self._git("commit", "-m", "init")

        lines = mod.read_text(encoding="utf-8").splitlines()
        for i in range(12):
            lines[i] = f"line_{i} = {i + 300}"
        mod.write_text("\n".join(lines) + "\n", encoding="utf-8")

        link_mod = self.repo_dir / "link_mod.py"
        link_mod.symlink_to(mod)

        self.assertEqual(
            compute_net_review_dirty_lines(
                [str(mod), str(link_mod)],
                str(self.repo_dir),
                {str(mod): 12, str(link_mod): 12},
            ),
            12,
        )


if __name__ == "__main__":
    unittest.main()
