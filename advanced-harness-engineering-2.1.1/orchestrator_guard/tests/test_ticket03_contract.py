"""Subprocess contract tests for Ticket #03 (AC-3, AC-5, AC-7, AC-8)."""

from __future__ import annotations

import json
import unittest

from _helpers import DEFAULT_POLICY, HookSubprocessTestCase


class TestTicket03WriteDelegationContract(HookSubprocessTestCase):
    def test_parent_create_denied_but_subagent_create_and_edit_allowed(self) -> None:
        session_id = "t03-create"
        _, out_parent = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "toolCallId": "c1",
                "toolName": "create",
                "toolArgs": {"path": "/repo/new.py", "file_text": "x = 1\n"},
            },
        )
        self.assertEqual(out_parent.get("permissionDecision"), "deny")
        self.assertIn("general-purpose", out_parent.get("permissionDecisionReason", "").lower())

        for tool, args in (
            ("create", {"path": "/repo/new.py", "file_text": "x = 1\n"}),
            ("edit", {"path": "/repo/unviewed.py", "old_str": "a", "new_str": "b"}),
        ):
            _, out_sub = self.run_hook(
                "preToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1001,
                    "cwd": "/repo",
                    "toolCallId": f"sub-{tool}",
                    "toolName": tool,
                    "toolArgs": args,
                    "agentId": "worker-gp",
                    "agentType": "general-purpose",
                },
            )
            self.assertEqual(out_sub, {})

    def test_parent_edit_requires_view_single_file_and_line_limit(self) -> None:
        session_id = "t03-edit-rules"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Fix a typo"},
        )

        # Unviewed file -> denied
        _, out_unviewed = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolCallId": "e1",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "a", "new_str": "b"},
            },
        )
        self.assertEqual(out_unviewed.get("permissionDecision"), "deny")

        # View two files
        for path in ("/repo/a.py", "/repo/b.py"):
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1002,
                    "cwd": "/repo",
                    "toolName": "view",
                    "toolArgs": {"path": path},
                    "toolResult": {"resultType": "success", "textResultForLlm": "ok"},
                },
            )

        # Oversized edit (21 changed lines) -> denied
        big_new = "\n".join(f"line_{i}" for i in range(21))
        _, out_big = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1003,
                "cwd": "/repo",
                "toolCallId": "e2",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "old", "new_str": big_new},
            },
        )
        self.assertEqual(out_big.get("permissionDecision"), "deny")

        # Small surgical edit (<= 20 lines) on viewed a.py -> allowed
        _, out_ok = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1004,
                "cwd": "/repo",
                "toolCallId": "e3",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "old", "new_str": "new"},
            },
        )
        self.assertEqual(out_ok, {})
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "toolCallId": "e3",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "old", "new_str": "new"},
                "toolResult": {"resultType": "success", "textResultForLlm": "updated"},
            },
        )

        # Second distinct file in the same turn -> denied
        _, out_second = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1006,
                "cwd": "/repo",
                "toolCallId": "e4",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/b.py", "old_str": "x", "new_str": "y"},
            },
        )
        self.assertEqual(out_second.get("permissionDecision"), "deny")
        self.assertIn("general-purpose", out_second.get("permissionDecisionReason", "").lower())

    def test_task_explicit_model_override_guard(self) -> None:
        session_id = "t03-task-model"
        # Prompt without model mention
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Refactor router.py"},
        )
        _, out_denied = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolCallId": "t1",
                "toolName": "task",
                "toolArgs": {
                    "agent_type": "general-purpose",
                    "name": "w1",
                    "description": "refactor",
                    "prompt": "do it",
                    "model": "claude-opus-5.5",
                },
            },
        )
        self.assertEqual(out_denied.get("permissionDecision"), "deny")
        self.assertIn("model", out_denied.get("permissionDecisionReason", "").lower())

        # Omitting model -> allowed
        _, out_omitted = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "toolCallId": "t2",
                "toolName": "task",
                "toolArgs": {
                    "agent_type": "general-purpose",
                    "name": "w2",
                    "description": "refactor",
                    "prompt": "do it",
                },
            },
        )
        self.assertEqual(out_omitted, {})

        # Prompt explicitly naming a model -> explicit model allowed
        self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 2000,
                "cwd": "/repo",
                "prompt": "Use opus for this refactor",
            },
        )
        _, out_explicit_ok = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 2001,
                "cwd": "/repo",
                "toolCallId": "t3",
                "toolName": "task",
                "toolArgs": {
                    "agent_type": "general-purpose",
                    "name": "w3",
                    "description": "refactor",
                    "prompt": "do it",
                    "model": "claude-opus-5.5",
                },
            },
        )
        self.assertEqual(out_explicit_ok, {})

    def test_two_write_agent_steers_unlock_parent_edits_and_reset_next_turn(self) -> None:
        session_id = "t03-steer-unlock"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Implement feature X"},
        )

        # 1st steer does NOT unlock
        _, post1 = self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolCallId": "wa1",
                "toolName": "write_agent",
                "toolArgs": {"agent_id": "worker-stuck", "message": "Try again"},
                "toolResult": {"resultType": "success", "textResultForLlm": "Message delivered"},
            },
        )
        self.assertEqual(post1, {})

        _, still_denied = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "toolName": "create",
                "toolArgs": {"path": "/repo/x.py", "file_text": "a = 1\n"},
            },
        )
        self.assertEqual(still_denied.get("permissionDecision"), "deny")

        # 2nd steer to the SAME worker unlocks parent editing with explanatory note
        _, post2 = self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1003,
                "cwd": "/repo",
                "toolCallId": "wa2",
                "toolName": "write_agent",
                "toolArgs": {"agent_id": "worker-stuck", "message": "Still wrong"},
                "toolResult": {"resultType": "success", "textResultForLlm": "Message delivered"},
            },
        )
        self.assertIn("unlocked", post2.get("additionalContext", "").lower())

        # Now parent create and oversized/unviewed edits are allowed this turn
        _, unlocked_create = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1004,
                "cwd": "/repo",
                "toolName": "create",
                "toolArgs": {"path": "/repo/x.py", "file_text": "a = 1\n"},
            },
        )
        self.assertEqual(unlocked_create, {})

        # Next user prompt resets escalation unlock
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 2000, "cwd": "/repo", "prompt": "Next task"},
        )
        _, locked_again = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 2001,
                "cwd": "/repo",
                "toolName": "create",
                "toolArgs": {"path": "/repo/y.py", "file_text": "b = 2\n"},
            },
        )
        self.assertEqual(locked_again.get("permissionDecision"), "deny")

    def test_parallel_parent_edits_to_second_file_blocked_at_pre_tool_use(self) -> None:
        session_id = "t03-parallel-edit"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Fix typo"},
        )
        for p in ("/repo/a.py", "/repo/b.py"):
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1001,
                    "cwd": "/repo",
                    "toolName": "view",
                    "toolArgs": {"path": p},
                    "toolResult": {"resultType": "success"},
                },
            )
        # Parallel preToolUse calls before either postToolUse runs
        _, out1 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "toolCallId": "pe1",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "a", "new_str": "b"},
            },
        )
        _, out2 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "toolCallId": "pe2",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/b.py", "old_str": "c", "new_str": "d"},
            },
        )
        self.assertEqual(out1, {})
        self.assertEqual(out2.get("permissionDecision"), "deny")

    def test_direct_bypass_allows_create_and_explicit_model_and_empty_patterns_override_works(self) -> None:
        session_id = "t03-direct-and-empty-pat"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "!direct make file"},
        )
        _, out_create = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolName": "create",
                "toolArgs": {"path": "/repo/new.py", "file_text": "x = 1\n"},
            },
        )
        _, out_task = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "toolName": "task",
                "toolArgs": {"agent_type": "explore", "model": "claude-opus-5.5"},
            },
        )
        self.assertEqual(out_create, {})
        self.assertEqual(out_task, {})

        # Explicit empty model_mention_patterns in policy disables prompt-based model exceptions
        custom_pol = json.loads(DEFAULT_POLICY.read_text(encoding="utf-8"))
        custom_pol["model_mention_patterns"] = []
        pol_path = self.state_dir / "no-model-mentions.json"
        pol_path.write_text(json.dumps(custom_pol), encoding="utf-8")
        env = {"ORCHESTRATOR_HOOKS_POLICY": str(pol_path)}

        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 2000, "cwd": "/repo", "prompt": "Use opus for this"},
            env_overrides=env,
        )
        _, out_denied = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 2001,
                "cwd": "/repo",
                "toolName": "task",
                "toolArgs": {"agent_type": "explore", "model": "claude-opus-5.5"},
            },
            env_overrides=env,
        )
        self.assertEqual(out_denied.get("permissionDecision"), "deny")


if __name__ == "__main__":
    unittest.main()
