"""Unit tests for the pure-logic write, task-model, and steer-escalation guard.

Run: python3 -m unittest discover -s .github/orchestrator_guard/tests -p "test_write_delegation_guard.py" -v
"""

import sys
import unittest
from pathlib import Path

PACKAGE_PARENT = Path(__file__).resolve().parents[2]
if str(PACKAGE_PARENT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_PARENT))

from orchestrator_guard.write_delegation_guard import (  # noqa: E402
    DEFAULT_MODEL_PATTERNS,
    count_edit_changed_lines,
    evaluate_parent_task,
    evaluate_parent_write,
    normalize_path,
    prompt_mentions_model,
    record_write_agent_steer,
)


class TestNormalizePath(unittest.TestCase):
    def test_empty_and_blank_return_empty_string(self) -> None:
        self.assertEqual(normalize_path("", "/repo"), "")
        self.assertEqual(normalize_path("   \t ", "/repo"), "")
        self.assertEqual(normalize_path("", None), "")

    def test_relative_and_absolute_paths_match_with_cwd(self) -> None:
        self.assertEqual(normalize_path("a.py", "/repo"), "/repo/a.py")
        self.assertEqual(normalize_path("/repo/a.py", "/repo"), "/repo/a.py")
        self.assertEqual(normalize_path("./sub/../a.py", "/repo/"), "/repo/a.py")
        self.assertEqual(normalize_path("/repo//sub/../a.py", "/repo"), "/repo/a.py")

    def test_absolute_path_ignores_different_cwd(self) -> None:
        self.assertEqual(normalize_path("/other/b.py", "/repo"), "/other/b.py")

    def test_relative_path_without_cwd_collapses_dots(self) -> None:
        self.assertEqual(normalize_path("./pkg//mod.py", None), "pkg/mod.py")

    def test_accepts_path_cwd(self) -> None:
        self.assertEqual(normalize_path("rel.py", Path("/repo")), "/repo/rel.py")


class TestCountEditChangedLines(unittest.TestCase):
    def test_identical_strings_return_zero(self) -> None:
        self.assertEqual(count_edit_changed_lines("a\nb\nc", "a\nb\nc"), 0)
        self.assertEqual(count_edit_changed_lines("", ""), 0)

    def test_single_line_edit_with_unchanged_context(self) -> None:
        old_str = "def f():\n    x = 1\n    return x\n"
        new_str = "def f():\n    x = 2\n    return x\n"
        self.assertEqual(count_edit_changed_lines(old_str, new_str), 1)

    def test_twenty_line_replacement_returns_twenty(self) -> None:
        old_str = "\n".join(f"old_{i}" for i in range(20))
        new_str = "\n".join(f"new_{i}" for i in range(20))
        self.assertEqual(count_edit_changed_lines(old_str, new_str), 20)

    def test_twenty_one_line_replacement_and_addition(self) -> None:
        old_21 = "\n".join(f"old_{i}" for i in range(21))
        new_21 = "\n".join(f"new_{i}" for i in range(21))
        self.assertEqual(count_edit_changed_lines(old_21, new_21), 21)

        old_ctx = "header\nfooter"
        new_added = "header\n" + "\n".join(f"add_{i}" for i in range(21)) + "\nfooter"
        self.assertEqual(count_edit_changed_lines(old_ctx, new_added), 21)

    def test_deletion_counts_removed_lines(self) -> None:
        old_str = "a\nb\nc\nd"
        new_str = "a\nd"
        self.assertEqual(count_edit_changed_lines(old_str, new_str), 2)


class TestPromptMentionsModel(unittest.TestCase):
    def test_matches_default_model_and_tier_words(self) -> None:
        positives = [
            "Please use claude-opus-5.5 for this",
            "Switch to Sonnet if needed",
            "Try haiku for speed",
            "Route to neon",
            "Use hydrogen here",
            "Run deepseek on this",
            "Test with gpt-6",
            "Pick the best model",
            "Compare model options side by side",
        ]
        for prompt in positives:
            with self.subTest(prompt=prompt):
                self.assertTrue(prompt_mentions_model(prompt, DEFAULT_MODEL_PATTERNS))

    def test_does_not_match_partial_or_unrelated_words(self) -> None:
        negatives = [
            "",
            "Switch to debug mode now",
            "Update user modes and remodeling flow",
            "Implement pagination for app",
            "Check egyptian history",
        ]
        for prompt in negatives:
            with self.subTest(prompt=prompt):
                self.assertFalse(prompt_mentions_model(prompt, DEFAULT_MODEL_PATTERNS))

    def test_supports_custom_patterns_case_insensitively(self) -> None:
        self.assertTrue(prompt_mentions_model("Use TITAN tier", [r"\btitan\b"]))
        self.assertFalse(prompt_mentions_model("Use titan tier", []))


class TestEvaluateParentWrite(unittest.TestCase):
    def test_other_tools_pass_even_when_escalation_unlocked(self) -> None:
        for unlocked in (False, True):
            allowed, rule, reason = evaluate_parent_write(
                "view",
                {"path": "a.py"},
                cwd="/repo",
                viewed_files=set(),
                edited_files_this_turn=set(),
                escalation_unlocked=unlocked,
            )
            self.assertEqual((allowed, rule, reason), (True, "pass", ""))

    def test_create_is_denied_unless_escalation_unlocked(self) -> None:
        allowed, rule, reason = evaluate_parent_write(
            "create",
            {"path": "/repo/new.py", "file_text": "x = 1"},
            cwd="/repo",
            viewed_files={"/repo/new.py"},
            edited_files_this_turn=set(),
            escalation_unlocked=False,
        )
        self.assertFalse(allowed)
        self.assertEqual(rule, "parent_create_denied")
        self.assertIn("general-purpose", reason)

        allowed_u, rule_u, reason_u = evaluate_parent_write(
            "create",
            {"path": "/repo/new.py", "file_text": "x = 1"},
            cwd="/repo",
            viewed_files=set(),
            edited_files_this_turn=set(),
            escalation_unlocked=True,
        )
        self.assertEqual((allowed_u, rule_u, reason_u), (True, "write_escalation_unlocked", ""))

    def test_edit_unviewed_or_blank_path_is_denied(self) -> None:
        for raw_path in ("", "a.py"):
            with self.subTest(raw_path=raw_path):
                allowed, rule, reason = evaluate_parent_write(
                    "edit",
                    {"path": raw_path, "old_str": "a", "new_str": "b"},
                    cwd="/repo",
                    viewed_files={"/repo/other.py"},
                    edited_files_this_turn=set(),
                    escalation_unlocked=False,
                )
                self.assertFalse(allowed)
                self.assertEqual(rule, "parent_edit_unviewed_file")
                self.assertIn("view", reason)
                self.assertIn("general-purpose", reason)

    def test_edit_surgical_within_limit_and_same_file_second_edit_allowed(self) -> None:
        old_20 = "\n".join(f"old_{i}" for i in range(20))
        new_20 = "\n".join(f"new_{i}" for i in range(20))
        allowed, rule, reason = evaluate_parent_write(
            "edit",
            {"path": "a.py", "old_str": old_20, "new_str": new_20},
            cwd="/repo",
            viewed_files={"/repo/a.py"},
            edited_files_this_turn=set(),
            escalation_unlocked=False,
        )
        self.assertEqual((allowed, rule, reason), (True, "parent_edit_surgical_allowed", ""))

        allowed_again, rule_again, reason_again = evaluate_parent_write(
            "edit",
            {"path": "/repo/sub/../a.py", "old_str": "x = 1", "new_str": "x = 2"},
            cwd="/repo",
            viewed_files={"/repo/a.py"},
            edited_files_this_turn={"/repo/a.py"},
            escalation_unlocked=False,
        )
        self.assertEqual((allowed_again, rule_again, reason_again), (True, "parent_edit_surgical_allowed", ""))

    def test_edit_multi_file_is_denied(self) -> None:
        allowed, rule, reason = evaluate_parent_write(
            "edit",
            {"path": "b.py", "old_str": "x = 1", "new_str": "x = 2"},
            cwd="/repo",
            viewed_files={"/repo/a.py", "/repo/b.py"},
            edited_files_this_turn={"/repo/a.py"},
            escalation_unlocked=False,
        )
        self.assertFalse(allowed)
        self.assertEqual(rule, "parent_edit_multi_file")
        self.assertIn("general-purpose", reason)

    def test_edit_too_large_is_denied(self) -> None:
        old_21 = "\n".join(f"old_{i}" for i in range(21))
        new_21 = "\n".join(f"new_{i}" for i in range(21))
        allowed, rule, reason = evaluate_parent_write(
            "edit",
            {"path": "/repo/a.py", "old_str": old_21, "new_str": new_21},
            cwd="/repo",
            viewed_files={"/repo/a.py"},
            edited_files_this_turn=set(),
            escalation_unlocked=False,
            max_edit_lines=20,
        )
        self.assertFalse(allowed)
        self.assertEqual(rule, "parent_edit_too_large")
        self.assertIn("21", reason)
        self.assertIn("20", reason)
        self.assertIn("general-purpose", reason)

    def test_escalation_unlock_bypasses_all_edit_restrictions(self) -> None:
        old_25 = "\n".join(f"old_{i}" for i in range(25))
        new_25 = "\n".join(f"new_{i}" for i in range(25))
        allowed, rule, reason = evaluate_parent_write(
            "edit",
            {"path": "/repo/unviewed.py", "old_str": old_25, "new_str": new_25},
            cwd="/repo",
            viewed_files=set(),
            edited_files_this_turn={"/repo/a.py"},
            escalation_unlocked=True,
        )
        self.assertEqual((allowed, rule, reason), (True, "write_escalation_unlocked", ""))


class TestEvaluateParentTask(unittest.TestCase):
    def test_denies_explicit_model_when_prompt_omits_model(self) -> None:
        allowed, rule, reason = evaluate_parent_task(
            {"agent_type": "explore", "model": "gpt-6", "prompt": "Find routes"},
            prompt_has_model_mention=False,
        )
        self.assertFalse(allowed)
        self.assertEqual(rule, "task_explicit_model_denied")
        self.assertIn("model", reason)
        self.assertIn("/subagents", reason)

    def test_allows_explicit_model_when_prompt_mentions_model(self) -> None:
        allowed, rule, reason = evaluate_parent_task(
            {"agent_type": "explore", "model": "gpt-6", "prompt": "Find routes"},
            prompt_has_model_mention=True,
        )
        self.assertEqual((allowed, rule, reason), (True, "task_allowed", ""))

    def test_allows_when_model_omitted_or_blank(self) -> None:
        for args in (
            {"agent_type": "explore"},
            {"agent_type": "explore", "model": None},
            {"agent_type": "explore", "model": ""},
            {"agent_type": "explore", "model": "   "},
        ):
            with self.subTest(args=args):
                allowed, rule, reason = evaluate_parent_task(args, prompt_has_model_mention=False)
                self.assertEqual((allowed, rule, reason), (True, "task_allowed", ""))


class TestRecordWriteAgentSteer(unittest.TestCase):
    def test_single_agent_id_unlocks_on_second_steer(self) -> None:
        counts: dict[str, int] = {}
        unlocked_1, reached_1 = record_write_agent_steer(counts, {"agent_id": "worker-1", "message": "try again"})
        self.assertFalse(unlocked_1)
        self.assertEqual(reached_1, [])
        self.assertEqual(counts, {"worker-1": 1})

        unlocked_other, reached_other = record_write_agent_steer(
            counts,
            {"agent_id": "worker-2", "message": "status"},
        )
        self.assertFalse(unlocked_other)
        self.assertEqual(reached_other, [])
        self.assertEqual(counts, {"worker-1": 1, "worker-2": 1})

        unlocked_2, reached_2 = record_write_agent_steer(counts, {"agent_id": "worker-1", "message": "wrap up"})
        self.assertTrue(unlocked_2)
        self.assertEqual(reached_2, ["worker-1"])
        self.assertEqual(counts, {"worker-1": 2, "worker-2": 1})

    def test_agent_ids_list_and_ignores_blank_or_missing_targets(self) -> None:
        counts: dict[str, int] = {"w1": 1}
        unlocked, reached = record_write_agent_steer(
            counts,
            {"agent_ids": ["w1", "w2", "", "  ", "w1"], "message": "sync"},
        )
        self.assertTrue(unlocked)
        self.assertEqual(reached, ["w1"])
        self.assertEqual(counts, {"w1": 2, "w2": 1})

        unlocked_empty, reached_empty = record_write_agent_steer(counts, {"scope": "siblings", "message": "hi"})
        self.assertFalse(unlocked_empty)
        self.assertEqual(reached_empty, [])
        self.assertEqual(counts, {"w1": 2, "w2": 1})


if __name__ == "__main__":
    unittest.main()
