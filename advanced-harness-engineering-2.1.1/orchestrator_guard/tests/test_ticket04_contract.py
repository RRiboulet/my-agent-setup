"""Subprocess contract tests for Ticket #04 (AC-9, RB-9, RB-10, RB-11, OA-1..OA-4)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from _helpers import HookSubprocessTestCase


class TestTicket04VerificationGateContract(HookSubprocessTestCase):
    def append_transcript(self, transcript_path: Path, entries: list[dict]) -> None:
        with open(transcript_path, "a", encoding="utf-8") as fh:
            for item in entries:
                fh.write(json.dumps(item) + "\n")
    def test_python_edit_blocks_commit_push_pr_until_subagent_exit_zero_verify(self) -> None:
        session_id = "t04-py-gate"
        transcript = self.state_dir / "transcript.jsonl"

        # Subagent edits a .py file (observed via transcriptPath on subagentStop)
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-1",
                "agentType": "general-purpose",
            },
        )
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "data": {
                        "toolCallId": "tc-edit-1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/app.py", "old_str": "x = 1", "new_str": "x = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "data": {
                        "toolCallId": "tc-edit-1",
                        "success": True,
                        "fileEdits": [{"path": "/repo/app.py", "kind": "edit"}],
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-1",
                "agentType": "general-purpose",
            },
        )

        # git commit, git push, gh pr create all denied stating missing tests
        for cmd in ("git commit -m 'fix'", "git push origin dev", "gh pr create --title t"):
            _, out = self.run_hook(
                "preToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1010,
                    "cwd": "/repo",
                    "toolName": "bash",
                    "toolArgs": {"command": cmd},
                },
            )
            self.assertEqual(out.get("permissionDecision"), "deny", f"Expected block for {cmd}")
            self.assertIn("pytest", out.get("permissionDecisionReason", "").lower())

        # Failing pytest (success=True, exitCode=1) AND test-local-*.sh (exitCode=0) must NOT clear gate
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "tc-fail-pytest",
                        "toolName": "bash",
                        "arguments": {"command": "poetry run pytest"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "tc-fail-pytest",
                        "success": True,
                        "shellExecution": {"exitCode": 1},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "tc-dev-server",
                        "toolName": "bash",
                        "arguments": {"command": "./test-local-accounts.sh"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "tc-dev-server",
                        "success": True,
                        "shellExecution": {"exitCode": 0},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1020,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-2",
                "agentType": "general-purpose",
            },
        )
        _, still_blocked = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1021,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'fix'"},
            },
        )
        self.assertEqual(still_blocked.get("permissionDecision"), "deny")

        # Succeeding pytest (exitCode=0) in subagent clears tests_verified -> commit succeeds
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-3",
                    "data": {
                        "toolCallId": "tc-pass-pytest",
                        "toolName": "bash",
                        "arguments": {"command": "poetry run pytest tests/"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-3",
                    "data": {
                        "toolCallId": "tc-pass-pytest",
                        "success": True,
                        "shellExecution": {"exitCode": 0},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1030,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-3",
                "agentType": "general-purpose",
            },
        )
        _, allowed_commit = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1031,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'fix'"},
            },
        )
        self.assertEqual(allowed_commit, {})

    def test_nontrivial_code_infra_diff_requires_code_review_and_rearms_after_edit(self) -> None:
        session_id = "t04-review-gate"
        transcript = self.state_dir / "transcript-rev.jsonl"

        # Two Terraform files edited (>= 2 code/infra files -> arms review gate, NOT Python tests gate)
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-tf",
                    "data": {
                        "toolCallId": "tf-1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/infra/a.tf", "old_str": "a", "new_str": "b"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-tf",
                    "data": {"toolCallId": "tf-1", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-tf",
                    "data": {
                        "toolCallId": "tf-2",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/infra/b.tf", "old_str": "c", "new_str": "d"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-tf",
                    "data": {"toolCallId": "tf-2", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-tf",
                "agentType": "general-purpose",
            },
        )

        # Blocked specifically for code-review (NOT pytest)
        _, out_block = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git push"},
            },
        )
        self.assertEqual(out_block.get("permissionDecision"), "deny")
        reason = out_block.get("permissionDecisionReason", "").lower()
        self.assertIn("code-review", reason)
        self.assertNotIn("pytest", reason)

        # Correlate subagentStart (agentType=code-review) + subagentStop (even if agentType omitted)
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "agentId": "rev-1",
                "agentType": "code-review",
            },
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1015,
                "cwd": "/repo",
                "agentId": "rev-1",
            },
        )
        _, out_pass = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1016,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git push"},
            },
        )
        self.assertEqual(out_pass, {})

        # Subsequent edit after verification re-arms the review gate
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-tf-2",
                    "data": {
                        "toolCallId": "tf-3",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/infra/a.tf", "old_str": "b", "new_str": "b2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-tf-2",
                    "data": {"toolCallId": "tf-3", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1020,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-tf-2",
                "agentType": "general-purpose",
            },
        )
        _, out_rearmed = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1021,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git push"},
            },
        )
        self.assertEqual(out_rearmed.get("permissionDecision"), "deny")

    def test_docs_only_edits_do_not_arm_gates_and_agent_stop_blocks_once_without_loop(self) -> None:
        session_id = "t04-docs-and-stop"
        # Edit two markdown files (>50 lines) -> exempt
        big_md = "\n".join(f"doc line {i}" for i in range(60))
        for p in ("/repo/README.md", "/repo/NOTES.txt"):
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1000,
                    "cwd": "/repo",
                    "toolName": "create",
                    "toolArgs": {"path": p, "file_text": big_md},
                    "toolResult": {"resultType": "success"},
                },
            )
        _, out_commit = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'docs'"},
            },
        )
        self.assertEqual(out_commit, {})
        _, out_stop_clean = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1002, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(out_stop_clean, {})

        # Parent edits a .py file -> postToolUse emits reminder, agentStop blocks when stop_hook_active=False
        _, post_mut = self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/mod.py", "old_str": "a", "new_str": "b"},
                "toolResult": {"resultType": "success"},
            },
        )
        self.assertIn("tests", post_mut.get("additionalContext", "").lower())

        _, out_stop_block = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1010, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(out_stop_block.get("decision"), "block")
        self.assertIn("[orchestrator-guard:verify-required]", out_stop_block.get("reason", ""))

        # Synthetic continuation prompt preserves state; second agentStop with stop_hook_active=True allows exit
        _, out_cont = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1011,
                "cwd": "/repo",
                "prompt": out_stop_block["reason"],
            },
        )
        self.assertEqual(out_cont, {})

        _, out_stop_loop_guard = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1012, "cwd": "/repo", "stop_hook_active": True},
        )
        self.assertEqual(out_stop_loop_guard, {})

    def test_compound_commit_bypass_still_denied_even_when_gates_clear(self) -> None:
        _, out = self.run_hook(
            "preToolUse",
            {
                "sessionId": "t04-compound-commit",
                "timestamp": 1000,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m ok && pytest"},
            },
        )
        self.assertEqual(out.get("permissionDecision"), "deny")

    def test_false_verify_commands_and_stale_or_failed_reviews_do_not_clear_gates(self) -> None:
        session_id = "t04-strict-verify"
        transcript = self.state_dir / "strict.jsonl"

        # Start a code-review BEFORE any edits occur
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "agentId": "rev-stale",
                "agentType": "code-review",
            },
        )
        # Edit two .py files (arming BOTH tests and code-review)
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-w",
                    "timestamp": 1005,
                    "data": {
                        "toolCallId": "e1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/a.py", "old_str": "a", "new_str": "b"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-w",
                    "timestamp": 1006,
                    "data": {"toolCallId": "e1", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-w",
                    "timestamp": 1007,
                    "data": {
                        "toolCallId": "e2",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/b.py", "old_str": "c", "new_str": "d"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-w",
                    "timestamp": 1008,
                    "data": {"toolCallId": "e2", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1009,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-w",
                "agentType": "general-purpose",
            },
        )

        # Fake/masked verification commands + overlapping stale pytest (started at 1004 < 1008) must NOT clear tests
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-w",
                    "timestamp": 1010,
                    "data": {"toolCallId": "fake1", "toolName": "bash", "arguments": {"command": "cat pytest.ini"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-w",
                    "timestamp": 1011,
                    "data": {"toolCallId": "fake1", "success": True, "shellExecution": {"exitCode": 0}},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-w",
                    "timestamp": 1012,
                    "data": {"toolCallId": "fake2", "toolName": "bash", "arguments": {"command": "pytest || true"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-w",
                    "timestamp": 1013,
                    "data": {"toolCallId": "fake2", "success": True, "shellExecution": {"exitCode": 0}},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-w",
                    "timestamp": 1004,
                    "data": {"toolCallId": "stale-py", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-w",
                    "timestamp": 1014,
                    "data": {"toolCallId": "stale-py", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        # Same agentId multi-turn subagentStop -> must deduplicate e1/e2 and reject fake1/fake2/stale-py
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1015,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-w",
                "agentType": "general-purpose",
            },
        )
        # Stale code-review completing after edits AND failed code-review must NOT clear review_verified
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1016,
                "cwd": "/repo",
                "agentId": "rev-stale",
                "agentType": "code-review",
                "stopReason": "end_turn",
            },
        )
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1017,
                "cwd": "/repo",
                "agentId": "rev-err",
                "agentType": "code-review",
            },
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1018,
                "cwd": "/repo",
                "agentId": "rev-err",
                "agentType": "code-review",
                "stopReason": "error",
            },
        )

        _, blocked = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1020,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'still dirty'"},
            },
        )
        self.assertEqual(blocked.get("permissionDecision"), "deny")
        reason = blocked.get("permissionDecisionReason", "").lower()
        self.assertIn("pytest", reason)
        self.assertIn("code-review", reason)

    def test_multiline_commit_allowed_when_clean_and_dry_run_or_failed_commit_keeps_dirty(self) -> None:
        session_id = "t04-multiline-and-commit-reset"
        # Clean session allows multiline quoted commit & PR create
        for cmd in (
            'git commit -m "feat: title\n\nDetailed body"',
            'gh pr create --title "PR" --body "line1\nline2"',
        ):
            _, out = self.run_hook(
                "preToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1000,
                    "cwd": "/repo",
                    "toolName": "bash",
                    "toolArgs": {"command": cmd},
                },
            )
            self.assertEqual(out, {}, f"Expected allow for multiline command: {cmd!r}")

        # Unquoted newline injection still denied
        _, out_inj = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": 'git commit -m "ok"\npytest'},
            },
        )
        self.assertEqual(out_inj.get("permissionDecision"), "deny")

        # Edit 1 .py file (40 lines) -> dirty; dry-run & exit-1 commit do NOT clear; exit-0 commit DOES clear
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "toolName": "create",
                "toolArgs": {"path": "/repo/x.py", "file_text": "\n".join(f"x{i}=1" for i in range(40))},
                "toolResult": {"resultType": "success"},
            },
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1011,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit --dry-run"},
                "toolResult": {"resultType": "success", "textResultForLlm": "<shellId: 1 completed with exit code 0>"},
            },
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1012,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'fail'"},
                "toolResult": {"resultType": "success", "textResultForLlm": "<shellId: 2 completed with exit code 1>"},
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertEqual(state["review_dirty_lines"], 40)

        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1013,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'ok'"},
                "toolResult": {"resultType": "success", "textResultForLlm": "<shellId: 3 completed with exit code 0>"},
            },
        )
        state_after = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertFalse(state_after["tests_required"])
        self.assertEqual(state_after["review_dirty_lines"], 0)

    def test_stale_stop_block_does_not_swallow_next_direct_prompt_and_logs_unverified_direct(self) -> None:
        session_id = "t04-stale-stop-and-direct"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Run /security-review"},
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "1", "new_str": "2"},
                "toolResult": {"resultType": "success"},
            },
        )
        _, stop1 = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1002, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(stop1.get("decision"), "block")

        # User interrupts and sends a brand new !direct prompt -> MUST NOT be swallowed as stop continuation
        _, prompt_out = self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1005, "cwd": "/repo", "prompt": "!direct explain IIP"},
        )
        self.assertIn("!direct", prompt_out.get("additionalContext", ""))

        # agentStop under !direct allows stop but logs agent_stop_unverified_direct telemetry
        _, stop_direct = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1006, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(stop_direct, {})
        last_ev = self.read_telemetry()[-1]
        self.assertEqual(last_ev["rule"], "agent_stop_unverified_direct")
        self.assertEqual(last_ev["decision"], "warn")

    def test_multi_entry_file_edits_does_not_multiply_review_dirty_lines(self) -> None:
        session_id = "t04-multi-file-edits"
        transcript = self.state_dir / "multi.jsonl"
        block_25 = "\n".join(f"line_{i}" for i in range(25))
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-m",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "m1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/a.tf", "old_str": "old", "new_str": block_25},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-m",
                    "timestamp": 1001,
                    "data": {
                        "toolCallId": "m1",
                        "success": True,
                        "fileEdits": [
                            {"path": "/repo/a.tf", "kind": "edit"},
                            {"path": "/repo/a.tf", "kind": "edit"},
                        ],
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-m",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(state["review_dirty_lines"], 25)
        self.assertFalse(state["review_required"])

    def test_async_subagent_bash_and_read_bash_verification_clearance_and_failure(self) -> None:
        session_id = "t04-async-read-bash"
        transcript = self.state_dir / "async.jsonl"

        # Stale async pytest started BEFORE edit (ts=900)
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 900,
                    "data": {"toolCallId": "b-stale", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 950,
                    "data": {
                        "toolCallId": "b-stale",
                        "success": True,
                        "result": {"content": "<command with shellId: 100 is still running...>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/app.py", "old_str": "a", "new_str": "b"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1005,
                    "data": {"toolCallId": "e1", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-async",
                "agentType": "general-purpose",
            },
        )

        # Completing the stale shell 100 after edit must NOT clear tests_verified
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1008,
                    "data": {"toolCallId": "rb-stale", "toolName": "read_bash", "arguments": {"shellId": "100"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1009,
                    "data": {"toolCallId": "rb-stale", "success": True, "shellExecution": {"exitCode": 0}},
                },
                # Fresh async pytest fails via read_bash exit_code=1 -> popped, must NOT clear
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1010,
                    "data": {
                        "toolCallId": "b-fail",
                        "toolName": "bash",
                        "arguments": {"command": "poetry run pytest tests/"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1015,
                    "data": {
                        "toolCallId": "b-fail",
                        "success": True,
                        "result": {"structuredContent": {"shellId": "149"}},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1020,
                    "data": {"toolCallId": "rb-fail", "toolName": "read_bash", "arguments": {"shellId": "149"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1021,
                    "data": {"toolCallId": "rb-fail", "success": True, "shellExecution": {"exitCode": 1}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1022,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-async",
                "agentType": "general-purpose",
            },
        )
        _, blocked = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1023,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'still blocked'"},
            },
        )
        self.assertEqual(blocked.get("permissionDecision"), "deny")

        # Fresh async pytest: intermediate poll (exit_code=None) keeps shell, final exit_code=0 clears!
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1030,
                    "data": {
                        "toolCallId": "b-ok",
                        "toolName": "bash",
                        "arguments": {"command": "python3 -u -m pytest tests/"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1035,
                    "data": {
                        "toolCallId": "b-ok",
                        "success": True,
                        "result": {"content": "<command with shellId: 150 is still running...>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1040,
                    "data": {"toolCallId": "rb-poll", "toolName": "read_bash", "arguments": {"shellId": "150"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1041,
                    "data": {"toolCallId": "rb-poll", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-async",
                    "timestamp": 1050,
                    "data": {"toolCallId": "rb-ok", "toolName": "read_bash", "arguments": {"shellId": "150"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-async",
                    "timestamp": 1051,
                    "data": {"toolCallId": "rb-ok", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1052,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-async",
                "agentType": "general-purpose",
            },
        )
        _, allowed = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1053,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'verified async'"},
            },
        )
        self.assertEqual(allowed, {})

    def test_multi_turn_write_agent_refreshes_code_review_start_ts(self) -> None:
        session_id = "t04-write-agent-rereview"
        transcript = self.state_dir / "rereview.jsonl"

        # Initial code-review turn
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "agentId": "rev-1",
                "agentType": "code-review",
            },
        )
        self.run_hook(
            "subagentStop",
            {"sessionId": session_id, "timestamp": 1005, "cwd": "/repo", "agentId": "rev-1"},
        )

        # Follow-up edits arm code-review gate at ts=1012
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "timestamp": 1010,
                    "data": {
                        "toolCallId": "e1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/a.tf", "old_str": "a", "new_str": "b"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "timestamp": 1011,
                    "data": {"toolCallId": "e1", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "timestamp": 1011,
                    "data": {
                        "toolCallId": "e2",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/b.tf", "old_str": "c", "new_str": "d"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "timestamp": 1012,
                    "data": {"toolCallId": "e2", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1013,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-1",
                "agentType": "general-purpose",
            },
        )

        # Re-review via write_agent refreshes subagent_start_ts["rev-1"] = 1020
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1020,
                "cwd": "/repo",
                "toolName": "write_agent",
                "toolArgs": {"agent_id": "rev-1", "message": "Re-review after fix"},
                "toolResult": {"resultType": "success"},
            },
        )
        self.run_hook(
            "subagentStop",
            {"sessionId": session_id, "timestamp": 1025, "cwd": "/repo", "agentId": "rev-1"},
        )
        _, allowed = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1026,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git push"},
            },
        )
        self.assertEqual(allowed, {})

        # Also test scope="children" refreshes active code-review worker start_ts
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1030,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/c.tf", "old_str": "x", "new_str": "y"},
                "toolResult": {"resultType": "success"},
            },
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1035,
                "cwd": "/repo",
                "toolName": "write_agent",
                "toolArgs": {"scope": "children", "message": "Check c.tf"},
                "toolResult": {"resultType": "success"},
            },
        )
        self.run_hook(
            "subagentStop",
            {"sessionId": session_id, "timestamp": 1040, "cwd": "/repo", "agentId": "rev-1"},
        )
        _, allowed2 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1041,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git push"},
            },
        )
        self.assertEqual(allowed2, {})

    def test_subagent_git_commit_and_async_git_commit_reset_verification_state(self) -> None:
        session_id = "t04-subagent-commit-reset"
        transcript = self.state_dir / "subcommit.jsonl"

        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/a.py", "old_str": "1", "new_str": "2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c",
                    "timestamp": 1001,
                    "data": {"toolCallId": "e1", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c",
                    "timestamp": 1002,
                    "data": {"toolCallId": "p1", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c",
                    "timestamp": 1003,
                    "data": {"toolCallId": "p1", "success": True, "shellExecution": {"exitCode": 0}},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c",
                    "timestamp": 1004,
                    "data": {
                        "toolCallId": "c1",
                        "toolName": "bash",
                        "arguments": {"command": 'git add a.py && git commit -m "done"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c",
                    "timestamp": 1005,
                    "data": {"toolCallId": "c1", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-c",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertFalse(state["tests_required"])
        self.assertEqual(state["review_dirty_files"], [])
        self.assertEqual(state["review_dirty_lines"], 0)

        # Async git commit via read_bash also resets; dry-run does NOT reset
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c2",
                    "timestamp": 1010,
                    "data": {
                        "toolCallId": "e2",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/b.py", "old_str": "1", "new_str": "2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c2",
                    "timestamp": 1011,
                    "data": {"toolCallId": "e2", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c2",
                    "timestamp": 1012,
                    "data": {
                        "toolCallId": "c-dry",
                        "toolName": "bash",
                        "arguments": {"command": "git commit --dry-run"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c2",
                    "timestamp": 1013,
                    "data": {"toolCallId": "c-dry", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1014,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-c2",
                "agentType": "general-purpose",
            },
        )
        state_mid = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state_mid["tests_required"])

        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c2",
                    "timestamp": 1020,
                    "data": {
                        "toolCallId": "c-async",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "async commit"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c2",
                    "timestamp": 1021,
                    "data": {
                        "toolCallId": "c-async",
                        "success": True,
                        "result": {"structuredContent": {"shellId": "222"}},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-c2",
                    "timestamp": 1022,
                    "data": {"toolCallId": "rb-c", "toolName": "read_bash", "arguments": {"shellId": "222"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-c2",
                    "timestamp": 1023,
                    "data": {"toolCallId": "rb-c", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1024,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-c2",
                "agentType": "general-purpose",
            },
        )
        state_end = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertFalse(state_end["tests_required"])
        self.assertEqual(state_end["review_dirty_files"], [])

    def test_parallel_subagents_incremental_transcript_offset(self) -> None:
        session_id = "t04-parallel-offset"
        transcript = self.state_dir / "parallel.jsonl"

        # Parallel workers: gp-a starts & completes edit, gp-b starts pytest (still running!)
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-a",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "ea",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/p.py", "old_str": "1", "new_str": "2"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-b",
                    "timestamp": 1005,
                    "data": {"toolCallId": "pb", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-a",
                    "timestamp": 1002,
                    "data": {"toolCallId": "ea", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-a",
                "agentType": "general-purpose",
            },
        )
        mid = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(mid["tests_required"])
        self.assertFalse(mid["tests_verified"])
        self.assertIn("pb", mid["pending_transcript_starts"])

        # Now gp-b completes pytest -> consume from offset finds pb in pending_transcript_starts!
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-b",
                    "timestamp": 1010,
                    "data": {"toolCallId": "pb", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1011,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-b",
                "agentType": "general-purpose",
            },
        )
        end = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(end["tests_verified"])
        self.assertEqual(end["pending_transcript_starts"], {})

    def test_subagent_post_tool_text_only_exit_code_and_background_shell_id(self) -> None:
        session_id = "t04-subagent-text-only-exit"
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/app.py", "old_str": "a", "new_str": "b"},
                "toolResult": {"resultType": "success"},
            },
        )

        # Text-only exit code 1 on bash must NOT record pending_subagent_shells or clear tests_verified
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "agentId": "gp-1",
                "agentType": "general-purpose",
                "toolName": "bash",
                "toolArgs": {"command": "pytest"},
                "toolResult": {
                    "resultType": "success",
                    "textResultForLlm": "1 failed\n<shellId: 42 completed with exit code 1>",
                },
            },
        )
        st1 = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(st1["pending_subagent_shells"], {})
        self.assertFalse(st1["tests_verified"])

        # Async background bash with `<command started in background with shellId: fullsuite>` records pending
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "agentId": "gp-1",
                "agentType": "general-purpose",
                "toolName": "bash",
                "toolArgs": {"command": "pytest"},
                "toolResult": {
                    "resultType": "success",
                    "textResultForLlm": "<command started in background with shellId: fullsuite>",
                },
            },
        )
        st2 = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertIn("gp-1:fullsuite", st2["pending_subagent_shells"])

        # Text-only exit code 1 on read_bash pops pending without clearing tests_verified
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1003,
                "cwd": "/repo",
                "agentId": "gp-1",
                "agentType": "general-purpose",
                "toolName": "read_bash",
                "toolArgs": {"shellId": "fullsuite"},
                "toolResult": {
                    "resultType": "success",
                    "textResultForLlm": "failed\n<shellId: fullsuite completed with exit code 1>",
                },
            },
        )
        st3 = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(st3["pending_subagent_shells"], {})
        self.assertFalse(st3["tests_verified"])

        # Text-only exit code 0 on read_bash pops pending AND clears tests_verified
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1004,
                "cwd": "/repo",
                "agentId": "gp-1",
                "agentType": "general-purpose",
                "toolName": "bash",
                "toolArgs": {"command": "pytest"},
                "toolResult": {
                    "resultType": "success",
                    "textResultForLlm": "<command started in background with shellId: fullsuite2>",
                },
            },
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "agentId": "gp-1",
                "agentType": "general-purpose",
                "toolName": "read_bash",
                "toolArgs": {"shellId": "fullsuite2"},
                "toolResult": {
                    "resultType": "success",
                    "textResultForLlm": "5 passed\n<shellId: fullsuite2 completed with exit code 0>",
                },
            },
        )
        st4 = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(st4["pending_subagent_shells"], {})
        self.assertTrue(st4["tests_verified"])

    def test_stale_async_subagent_git_commit_does_not_wipe_newer_edit(self) -> None:
        session_id = "t04-stale-subagent-commit"
        transcript = self.state_dir / "stale-commit.jsonl"

        # Subagent A starts an async git commit at ts=900 BEFORE the edit at ts=1000
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-a",
                    "timestamp": 900,
                    "data": {
                        "toolCallId": "c-stale",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "older work"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-a",
                    "timestamp": 910,
                    "data": {
                        "toolCallId": "c-stale",
                        "success": True,
                        "result": {
                            "textResultForLlm": "<command started in background with shellId: stale-c>"
                        },
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-b",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e-new",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/new.py", "old_str": "x = 1", "new_str": "x = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-b",
                    "timestamp": 1005,
                    "data": {"toolCallId": "e-new", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-b",
                "agentType": "general-purpose",
            },
        )

        # Now stale commit finishes via read_bash at ts=1010 -> MUST NOT reset tests_required or review_dirty_files
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-a",
                    "timestamp": 1009,
                    "data": {"toolCallId": "rb-stale", "toolName": "read_bash", "arguments": {"shellId": "stale-c"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-a",
                    "timestamp": 1010,
                    "data": {"toolCallId": "rb-stale", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1011,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-a",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])
        self.assertEqual(state["review_dirty_files"], ["/repo/new.py"])

        # Also test start_seq fallback when transcript entries lack timestamps on bash start
        seq_sid = "t04-stale-subagent-commit-seq"
        seq_transcript = self.state_dir / "stale-commit-seq.jsonl"
        self.append_transcript(
            seq_transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-s",
                    "data": {
                        "toolCallId": "c-seq-stale",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "older"'},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-s",
                    "data": {
                        "toolCallId": "e-seq-new",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/seq.py", "old_str": "a", "new_str": "b"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-s",
                    "data": {"toolCallId": "e-seq-new", "success": True},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-s",
                    "data": {
                        "toolCallId": "c-seq-stale",
                        "success": True,
                        "shellExecution": {"exitCode": 0},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": seq_sid,
                "timestamp": 2000,
                "cwd": "/repo",
                "transcriptPath": str(seq_transcript),
                "agentId": "gp-s",
                "agentType": "general-purpose",
            },
        )
        seq_state = json.loads((self.state_dir / f"{seq_sid}.json").read_text(encoding="utf-8"))
        self.assertTrue(seq_state["tests_required"])
        self.assertEqual(seq_state["review_dirty_files"], ["/repo/seq.py"])

    def test_timestampless_async_subagent_commit_does_not_wipe_later_stop_edit(self) -> None:
        session_id = "t04-timestampless-async-commit"
        transcript = self.state_dir / "timestampless-async-commit.jsonl"

        # Stop #1: timestamp-less async git commit started before a .py edit
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-a",
                    "data": {
                        "toolCallId": "c-notimestamp",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "older work"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-a",
                    "data": {
                        "toolCallId": "c-notimestamp",
                        "success": True,
                        "result": {
                            "textResultForLlm": "<command started in background with shellId: async-c>"
                        },
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 900,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-a",
                "agentType": "general-purpose",
            },
        )
        st1 = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(st1["pending_subagent_shells"]["gp-a:async-c"]["started_at"], 900.0)

        # Later .py edit recorded at ts=1000
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-b",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e-later",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/later.py", "old_str": "x = 1", "new_str": "x = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-b",
                    "timestamp": 1005,
                    "data": {"toolCallId": "e-later", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-b",
                "agentType": "general-purpose",
            },
        )

        # Stop #2: async commit completes via read_bash -> MUST NOT wipe newer edit's gate
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-a",
                    "data": {
                        "toolCallId": "rb-notimestamp",
                        "toolName": "read_bash",
                        "arguments": {"shellId": "async-c"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-a",
                    "data": {
                        "toolCallId": "rb-notimestamp",
                        "success": True,
                        "shellExecution": {"exitCode": 0},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-a",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])
        self.assertEqual(state["review_dirty_files"], ["/repo/later.py"])

    def test_same_stop_timestampless_async_pytest_before_edit_leaves_unverified(self) -> None:
        session_id = "t04-case1-same-stop-async-pytest"
        transcript = self.state_dir / "case1.jsonl"
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "data": {"toolCallId": "p1", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "data": {
                        "toolCallId": "p1",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p1>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "data": {
                        "toolCallId": "e1",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/app.py", "old_str": "x = 1", "new_str": "x = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "data": {"toolCallId": "e1", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "data": {"toolCallId": "rb1", "toolName": "read_bash", "arguments": {"shellId": "sh-p1"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "data": {"toolCallId": "rb1", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-1",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_same_stop_timestampless_async_commit_before_edit_preserves_dirty_gate(self) -> None:
        session_id = "t04-case2-same-stop-async-commit"
        transcript = self.state_dir / "case2.jsonl"
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "c1",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "old"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "c1",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-c1>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-2",
                    "data": {
                        "toolCallId": "e2",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/mod.py", "old_str": "a = 1", "new_str": "a = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-2",
                    "data": {"toolCallId": "e2", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-2",
                    "data": {"toolCallId": "rb2", "toolName": "read_bash", "arguments": {"shellId": "sh-c1"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-2",
                    "data": {"toolCallId": "rb2", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-2",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])
        self.assertEqual(state["review_dirty_files"], ["/repo/mod.py"])

    def test_cross_stop_timestampless_async_pytest_before_edit_leaves_unverified(self) -> None:
        session_id = "t04-case3-cross-stop-async-pytest"
        transcript = self.state_dir / "case3.jsonl"
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-3",
                    "data": {"toolCallId": "p3", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-3",
                    "data": {
                        "toolCallId": "p3",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p3>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-3",
                    "data": {
                        "toolCallId": "e3",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/svc.py", "old_str": "v = 1", "new_str": "v = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-3",
                    "data": {"toolCallId": "e3", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-3",
                "agentType": "general-purpose",
            },
        )

        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-3",
                    "data": {"toolCallId": "rb3", "toolName": "read_bash", "arguments": {"shellId": "sh-p3"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-3",
                    "data": {"toolCallId": "rb3", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-3",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_mixed_timestamp_async_pytest_without_start_ts_before_edit_leaves_unverified(self) -> None:
        session_id = "t04-case4-mixed-ts-async-pytest"
        transcript = self.state_dir / "case4.jsonl"
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-4",
                    "data": {"toolCallId": "p4", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-4",
                    "timestamp": 950,
                    "data": {
                        "toolCallId": "p4",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p4>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-4",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e4",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/handler.py", "old_str": "h = 1", "new_str": "h = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-4",
                    "timestamp": 1005,
                    "data": {"toolCallId": "e4", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-4",
                    "data": {"toolCallId": "rb4", "toolName": "read_bash", "arguments": {"shellId": "sh-p4"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-4",
                    "data": {"toolCallId": "rb4", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-4",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_timestampless_async_pytest_at_seq0_before_timestamped_edit_leaves_unverified(self) -> None:
        session_id = "t04-timestampless-async-seq0-ts-edit"
        transcript = self.state_dir / "seq0-ts-edit.jsonl"
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-5",
                    "data": {"toolCallId": "p5", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-5",
                    "data": {
                        "toolCallId": "p5",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p5>"},
                    },
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-5",
                    "timestamp": 1005,
                    "data": {
                        "toolCallId": "e5",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/mod5.py", "old_str": "x = 1", "new_str": "x = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-5",
                    "timestamp": 1005,
                    "data": {"toolCallId": "e5", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-5",
                    "data": {"toolCallId": "rb5", "toolName": "read_bash", "arguments": {"shellId": "sh-p5"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-5",
                    "data": {"toolCallId": "rb5", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-5",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_pre_truncation_async_pytest_before_post_truncation_edit_at_offset0_leaves_unverified(self) -> None:
        session_id = "t04-truncation-async-pytest"
        transcript = self.state_dir / "trunc.jsonl"
        self.append_transcript(
            transcript,
            [
                {"type": "user.message", "data": {"content": "x" * 1000}},
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-6",
                    "data": {"toolCallId": "p6", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-6",
                    "data": {
                        "toolCallId": "p6",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p6>"},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-6",
                "agentType": "general-purpose",
            },
        )
        st_pre = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertGreater(st_pre["pending_subagent_shells"]["gp-6:sh-p6"]["start_seq"], 0)

        # Truncate transcript and write a new .py edit at offset 0 followed by read_bash exit 0
        transcript.write_text("", encoding="utf-8")
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-6",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e6",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/mod6.py", "old_str": "a = 1", "new_str": "a = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-6",
                    "timestamp": 1000,
                    "data": {"toolCallId": "e6", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-6",
                    "data": {"toolCallId": "rb6", "toolName": "read_bash", "arguments": {"shellId": "sh-p6"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-6",
                    "data": {"toolCallId": "rb6", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-6",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_pre_switch_timestampless_async_pytest_before_post_switch_edit_at_offset0(self) -> None:
        session_id = "t04-switch-async-pytest"
        t1 = self.state_dir / "t1.jsonl"
        t2 = self.state_dir / "t2.jsonl"
        self.append_transcript(
            t1,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-7",
                    "data": {"toolCallId": "p7", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-7",
                    "data": {
                        "toolCallId": "p7",
                        "success": True,
                        "result": {"textResultForLlm": "<command started in background with shellId: sh-p7>"},
                    },
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "transcriptPath": str(t1),
                "agentId": "gp-7",
                "agentType": "general-purpose",
            },
        )
        st_pre = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(st_pre["pending_subagent_shells"]["gp-7:sh-p7"]["start_seq"], 0)

        self.append_transcript(
            t2,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-7",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "e7",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/mod7.py", "old_str": "a = 1", "new_str": "a = 2"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-7",
                    "timestamp": 1000,
                    "data": {"toolCallId": "e7", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-7",
                    "data": {"toolCallId": "rb7", "toolName": "read_bash", "arguments": {"shellId": "sh-p7"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-7",
                    "data": {"toolCallId": "rb7", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "transcriptPath": str(t2),
                "agentId": "gp-7",
                "agentType": "general-purpose",
            },
        )
        state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(state["tests_required"])
        self.assertFalse(state["tests_verified"])

    def test_net_diff_review_line_counter_in_real_git_repo_and_create_fallback(self) -> None:
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory(prefix="orch-git-netdiff-") as tmp_repo:
            repo = Path(tmp_repo)
            subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(repo), "config", "user.email", "test@example.com"],
                check=True,
                capture_output=True,
            )

            target = repo / "app.py"
            orig_lines = [f"line_{i} = {i}" for i in range(80)]
            target.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "app.py"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "initial"], check=True, capture_output=True)

            session_id = "t04-git-net-diff"
            # a) Edit the same 20-line block 3 times (cumulative 60 >= 50, net = 20 < 50)
            block_v0 = "\n".join(orig_lines[:20])
            for rev in (1, 2, 3):
                prev = block_v0 if rev == 1 else "\n".join(f"line_{i} = {i + (rev - 1) * 100}" for i in range(20))
                curr = "\n".join(f"line_{i} = {i + rev * 100}" for i in range(20))
                target.write_text(target.read_text(encoding="utf-8").replace(prev, curr, 1), encoding="utf-8")
                self.run_hook(
                    "postToolUse",
                    {
                        "sessionId": session_id,
                        "timestamp": 1000 + rev,
                        "cwd": str(repo),
                        "toolName": "edit",
                        "toolArgs": {"path": str(target), "old_str": prev, "new_str": curr},
                        "toolResult": {"resultType": "success"},
                    },
                )
            st_a = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_a["review_dirty_lines"], 20)
            self.assertFalse(st_a["review_required"])

            # b) Add a second disjoint 35-line edit in the same file (net = 55 >= 50)
            old_35 = "\n".join(orig_lines[40:75])
            new_35 = "\n".join(f"line_{i} = {i + 900}" for i in range(40, 75))
            target.write_text(target.read_text(encoding="utf-8").replace(old_35, new_35, 1), encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1010,
                    "cwd": str(repo),
                    "toolName": "edit",
                    "toolArgs": {"path": str(target), "old_str": old_35, "new_str": new_35},
                    "toolResult": {"resultType": "success"},
                },
            )
            st_b = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_b["review_dirty_lines"], 55)
            self.assertTrue(st_b["review_required"])

            # c) Create an untracked 55-line .py file in a fresh session -> 55 lines, review_required True
            sid_c = "t04-git-untracked"
            untracked = repo / "untracked_55.py"
            body_55 = "\n".join(f"u_{i} = {i}" for i in range(55)) + "\n"
            untracked.write_text(body_55, encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": sid_c,
                    "timestamp": 2000,
                    "cwd": str(repo),
                    "toolName": "create",
                    "toolArgs": {"path": str(untracked), "file_text": body_55},
                    "toolResult": {"resultType": "success"},
                },
            )
            st_c = json.loads((self.state_dir / f"{sid_c}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_c["review_dirty_lines"], 55)
            self.assertTrue(st_c["review_required"])

            # d) Revert a single-file 30-line edit back to HEAD -> review_dirty_lines == 0, review_required False
            sid_d = "t04-git-revert"
            subprocess.run(["git", "-C", str(repo), "checkout", "--", "app.py"], check=True, capture_output=True)
            old_30 = "\n".join(orig_lines[:30])
            new_30 = "\n".join(f"line_{i} = {i + 500}" for i in range(30))
            target.write_text(target.read_text(encoding="utf-8").replace(old_30, new_30, 1), encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": sid_d,
                    "timestamp": 3000,
                    "cwd": str(repo),
                    "toolName": "edit",
                    "toolArgs": {"path": str(target), "old_str": old_30, "new_str": new_30},
                    "toolResult": {"resultType": "success"},
                },
            )
            # Revert on disk and apply the reverting edit
            target.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": sid_d,
                    "timestamp": 3001,
                    "cwd": str(repo),
                    "toolName": "edit",
                    "toolArgs": {"path": str(target), "old_str": new_30, "new_str": old_30},
                    "toolResult": {"resultType": "success"},
                },
            )
            st_d = json.loads((self.state_dir / f"{sid_d}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_d["review_dirty_lines"], 0)
            self.assertFalse(st_d["review_required"])

        # Non-git fallback: re-creating the same synthetic path replaces its per-file line count
        sid_nongit = "t04-nongit-recreate"
        for ts, count in ((1000, 30), (1001, 15)):
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": sid_nongit,
                    "timestamp": ts,
                    "cwd": "/repo",
                    "toolName": "create",
                    "toolArgs": {"path": "/repo/gen.py", "file_text": "\n".join(f"x{i}=1" for i in range(count))},
                    "toolResult": {"resultType": "success"},
                },
            )
        st_ng = json.loads((self.state_dir / f"{sid_nongit}.json").read_text(encoding="utf-8"))
        self.assertEqual(st_ng["review_dirty_lines"], 15)
        self.assertFalse(st_ng["review_required"])

    def test_subagent_transcript_multiple_edits_recalculates_net_diff_once(self) -> None:
        import os
        import subprocess
        import sys
        import tempfile
        from unittest import mock

        from _helpers import HOOK_CLI

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard import verification_gate
        from orchestrator_guard.engine import handle_event

        with tempfile.TemporaryDirectory(prefix="orch-sub-netdiff-") as tmp_repo:
            repo = Path(tmp_repo)
            subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(repo), "config", "user.email", "test@example.com"],
                check=True,
                capture_output=True,
            )
            target = repo / "mod.py"
            orig = [f"v_{i} = {i}" for i in range(40)]
            target.write_text("\n".join(orig) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "mod.py"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)

            # Edit the same 20-line block 4 times in transcript (cumulative 80 >= 50, net 20 < 50)
            transcript = self.state_dir / "sub-net.jsonl"
            entries = []
            block_v0 = "\n".join(orig[:20])
            for rev in range(1, 5):
                prev = block_v0 if rev == 1 else "\n".join(f"v_{i} = {i + (rev - 1) * 100}" for i in range(20))
                curr = "\n".join(f"v_{i} = {i + rev * 100}" for i in range(20))
                if rev == 4:
                    target.write_text(target.read_text(encoding="utf-8").replace(block_v0, curr, 1), encoding="utf-8")
                entries.append(
                    {
                        "type": "tool.execution_start",
                        "agentId": "gp-net",
                        "timestamp": 1000 + rev * 2,
                        "data": {
                            "toolCallId": f"e-{rev}",
                            "toolName": "edit",
                            "arguments": {"path": str(target), "old_str": prev, "new_str": curr},
                        },
                    }
                )
                entries.append(
                    {
                        "type": "tool.execution_complete",
                        "agentId": "gp-net",
                        "timestamp": 1001 + rev * 2,
                        "data": {"toolCallId": f"e-{rev}", "success": True},
                    }
                )
            self.append_transcript(transcript, entries)

            session_id = "t04-sub-net-once"
            with (
                mock.patch.dict(os.environ, {"ORCHESTRATOR_HOOKS_STATE_DIR": str(self.state_dir)}),
                mock.patch.object(
                    verification_gate,
                    "compute_net_review_dirty_lines",
                    wraps=verification_gate.compute_net_review_dirty_lines,
                ) as spy,
            ):
                handle_event(
                    "subagentStop",
                    {
                        "sessionId": session_id,
                        "timestamp": 1020,
                        "cwd": str(repo),
                        "transcriptPath": str(transcript),
                        "agentId": "gp-net",
                        "agentType": "general-purpose",
                    },
                )
                self.assertEqual(spy.call_count, 1)

            state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(state["review_dirty_lines"], 20)
            self.assertFalse(state["review_required"])

    def test_exempt_subagent_edit_preserves_verified_review_and_post_commit_state(self) -> None:
        session_id = "t04-exempt-after-review"
        transcript = self.state_dir / "exempt-after-review.jsonl"
        body_55 = "\n".join(f"x_{i} = {i}" for i in range(55))

        # 55-line create of app.py + pytest exit 0 in subagent -> review_required=True, review_verified=False
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "timestamp": 1000,
                    "data": {
                        "toolCallId": "c-app",
                        "toolName": "create",
                        "arguments": {"path": "/repo/app.py", "file_text": body_55},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "timestamp": 1001,
                    "data": {"toolCallId": "c-app", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-1",
                    "timestamp": 1002,
                    "data": {"toolCallId": "t-app", "toolName": "bash", "arguments": {"command": "pytest"}},
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-1",
                    "timestamp": 1003,
                    "data": {"toolCallId": "t-app", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1004,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-1",
                "agentType": "general-purpose",
            },
        )

        # Clean code-review -> review_required=True, review_verified=True
        self.run_hook(
            "subagentStart",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "agentId": "rev-1",
                "agentType": "code-review",
            },
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "agentId": "rev-1",
                "agentType": "code-review",
                "stopReason": "end_turn",
            },
        )
        st_rev = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(st_rev["review_required"])
        self.assertTrue(st_rev["review_verified"])

        # Subagent edits ONLY exempt README.md -> must NOT invalidate review_verified
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-docs",
                    "timestamp": 1010,
                    "data": {
                        "toolCallId": "e-md",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/README.md", "old_str": "old", "new_str": "new"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-docs",
                    "timestamp": 1011,
                    "data": {"toolCallId": "e-md", "success": True},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1012,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-docs",
                "agentType": "general-purpose",
            },
        )
        st_after_md = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertTrue(st_after_md["review_required"])
        self.assertTrue(st_after_md["review_verified"])

        _, commit_out = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1013,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "git commit -m 'docs'"},
            },
        )
        self.assertEqual(commit_out, {})
        _, stop_out = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1014, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(stop_out, {})

        # Pre-commit edit + git commit in same subagentStop transcript keeps post-commit state clean
        self.append_transcript(
            transcript,
            [
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-commit",
                    "timestamp": 1020,
                    "data": {
                        "toolCallId": "e-pre",
                        "toolName": "edit",
                        "arguments": {"path": "/repo/app.py", "old_str": "x_0 = 0", "new_str": "x_0 = 9"},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-commit",
                    "timestamp": 1021,
                    "data": {"toolCallId": "e-pre", "success": True},
                },
                {
                    "type": "tool.execution_start",
                    "agentId": "gp-commit",
                    "timestamp": 1022,
                    "data": {
                        "toolCallId": "c-post",
                        "toolName": "bash",
                        "arguments": {"command": 'git commit -m "done"'},
                    },
                },
                {
                    "type": "tool.execution_complete",
                    "agentId": "gp-commit",
                    "timestamp": 1023,
                    "data": {"toolCallId": "c-post", "success": True, "shellExecution": {"exitCode": 0}},
                },
            ],
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 1024,
                "cwd": "/repo",
                "transcriptPath": str(transcript),
                "agentId": "gp-commit",
                "agentType": "general-purpose",
            },
        )
        st_post_commit = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertFalse(st_post_commit["review_required"])
        self.assertTrue(st_post_commit["review_verified"])
        self.assertEqual(st_post_commit["review_dirty_files"], [])

    def test_single_file_55_line_edit_reverted_to_head_disarms_review_gate(self) -> None:
        import subprocess
        import tempfile

        with tempfile.TemporaryDirectory(prefix="orch-git-revert55-") as tmp_repo:
            repo = Path(tmp_repo)
            subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True, capture_output=True)
            subprocess.run(
                ["git", "-C", str(repo), "config", "user.email", "test@example.com"],
                check=True,
                capture_output=True,
            )
            target = repo / "app.py"
            orig_lines = [f"line_{i} = {i}" for i in range(60)]
            target.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "app.py"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "initial"], check=True, capture_output=True)

            session_id = "t04-revert-55"
            old_55 = "\n".join(orig_lines[:55])
            new_55 = "\n".join(f"line_{i} = {i + 500}" for i in range(55))
            target.write_text(target.read_text(encoding="utf-8").replace(old_55, new_55, 1), encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1000,
                    "cwd": str(repo),
                    "toolName": "edit",
                    "toolArgs": {"path": str(target), "old_str": old_55, "new_str": new_55},
                    "toolResult": {"resultType": "success"},
                },
            )
            st_armed = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_armed["review_dirty_lines"], 55)
            self.assertTrue(st_armed["review_required"])
            self.assertFalse(st_armed["review_verified"])

            # Revert all 55 lines back to HEAD
            target.write_text("\n".join(orig_lines) + "\n", encoding="utf-8")
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1001,
                    "cwd": str(repo),
                    "toolName": "edit",
                    "toolArgs": {"path": str(target), "old_str": new_55, "new_str": old_55},
                    "toolResult": {"resultType": "success"},
                },
            )
            st_reverted = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(st_reverted["review_dirty_lines"], 0)
            self.assertFalse(st_reverted["review_required"])
            self.assertTrue(st_reverted["review_verified"])


if __name__ == "__main__":
    unittest.main()
