"""Subprocess contract tests for the Copilot CLI orchestrator hook control plane.

Run: python3 -m unittest discover -s .github/orchestrator_guard/tests -v
"""

import json
import os
import subprocess
import time
import unittest
from pathlib import Path

from _helpers import DEFAULT_POLICY, HOOK_CLI, HookSubprocessTestCase


class TestTurnClassificationAndTelemetry(HookSubprocessTestCase):
    def test_classifies_all_six_modes_and_returns_concise_directive_and_telemetry(self) -> None:
        cases = [
            ("Run /security-review for auth token leaks", "security"),
            ("Please review my branch diff before merge", "review"),
            ("Debug why pytest fails with KeyError in service", "debug"),
            ("Implement a new endpoint for shift backfill", "implement"),
            ("Fix typo in README header", "quick-fix"),
            ("How does the master scheduler trigger ETL lambdas?", "qa"),
        ]
        for idx, (prompt, expected_mode) in enumerate(cases):
            with self.subTest(expected_mode=expected_mode):
                session_id = f"sess-cls-{idx}"
                proc, out = self.run_hook(
                    "userPromptSubmitted",
                    {
                        "sessionId": session_id,
                        "timestamp": 1795533952000 + idx,
                        "cwd": "/repo",
                        "prompt": prompt,
                    },
                )
                self.assertEqual(proc.returncode, 0, msg=proc.stderr)
                ctx = out.get("additionalContext", "")
                self.assertTrue(ctx, "Expected non-empty additionalContext routing directive")
                lines = [ln for ln in ctx.strip().splitlines() if ln.strip()]
                self.assertLessEqual(len(lines), 3, f"Directive should be 2-3 lines, got: {lines}")
                self.assertIn(expected_mode, ctx.lower())

        events = self.read_telemetry()
        self.assertEqual(len(events), len(cases))
        for rec, (_, expected_mode) in zip(events, cases):
            for key in (
                "timestamp",
                "session_id",
                "event",
                "actor_role",
                "mode",
                "tool",
                "decision",
                "rule",
                "counters",
                "latency_ms",
            ):
                self.assertIn(key, rec)
            self.assertEqual(rec["event"], "userPromptSubmitted")
            self.assertEqual(rec["actor_role"], "parent")
            self.assertEqual(rec["mode"], expected_mode)
            self.assertEqual(rec["decision"], "allow")

    def test_synthetic_stop_block_continuation_preserves_turn_mode_and_counters(self) -> None:
        session_id = "sess-stop-cont"
        proc, _ = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1795533952000,
                "cwd": "/repo",
                "prompt": "Implement pagination for app",
            },
        )
        self.assertEqual(proc.returncode, 0)

        # Arm verification gate and trigger agentStop block so pending_stop_block=True
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1795533952500,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/app.py", "old_str": "a", "new_str": "b"},
                "toolResult": {"resultType": "success"},
            },
        )
        _, stop_out = self.run_hook(
            "agentStop",
            {
                "sessionId": session_id,
                "timestamp": 1795533952800,
                "cwd": "/repo",
                "stop_hook_active": False,
            },
        )
        self.assertEqual(stop_out.get("decision"), "block")

        # Simulate a synthetic continuation prompt emitted by Copilot CLI after agentStop block
        proc2, out2 = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1795533953000,
                "cwd": "/repo",
                "prompt": (
                    "[orchestrator-guard:verify-required] "
                    "Run pytest in a general-purpose subagent before finishing."
                ),
            },
        )
        self.assertEqual(proc2.returncode, 0)
        self.assertEqual(out2, {})

        events = self.read_telemetry()
        self.assertEqual(events[-1]["mode"], "implement")
        self.assertEqual(events[-1]["rule"], "stop_block_continuation")

    def test_manual_prompt_starting_with_sentinel_without_pending_stop_block_is_normal_turn(self) -> None:
        session_id = "sess-manual-sentinel"
        proc, out = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1795533953500,
                "cwd": "/repo",
                "prompt": "[orchestrator-guard:verify-required] Implement caching for users",
            },
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("implement", out.get("additionalContext", "").lower())
        last_ev = self.read_telemetry()[-1]
        self.assertEqual(last_ev["mode"], "implement")
        self.assertEqual(last_ev["rule"], "heuristic:implement")

    def test_implement_takes_precedence_over_quick_fix(self) -> None:
        proc, _ = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": "sess-prec",
                "timestamp": 1795533954000,
                "cwd": "/repo",
                "prompt": "Implement the auth refactor and fix a typo in README",
            },
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(self.read_telemetry()[-1]["mode"], "implement")


class TestDiscoveryBudgetAndSubagentScoping(HookSubprocessTestCase):
    def test_discovery_budget_enforced_per_mode_and_resets_on_new_turn(self) -> None:
        budgets = [
            ("Run /security-review for auth", "security", 2),
            ("Review this branch diff", "review", 5),
            ("Debug why pytest crashes", "debug", 5),
            ("Implement new caching layer", "implement", 4),
            ("Fix typo in README", "quick-fix", 4),
            ("How does master scheduler work?", "qa", 8),
        ]
        tools_cycle = ("view", "grep", "glob")

        for idx, (prompt, mode, budget) in enumerate(budgets):
            with self.subTest(mode=mode, budget=budget):
                session_id = f"sess-disc-{idx}"
                self.run_hook(
                    "userPromptSubmitted",
                    {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": prompt},
                )
                for call_n in range(budget):
                    tool = tools_cycle[call_n % len(tools_cycle)]
                    proc, out = self.run_hook(
                        "preToolUse",
                        {
                            "sessionId": session_id,
                            "timestamp": 1001 + call_n,
                            "cwd": "/repo",
                            "toolCallId": f"call_{call_n}",
                            "toolName": tool,
                            "toolArgs": {"pattern": "foo"},
                        },
                    )
                    self.assertEqual(proc.returncode, 0)
                    self.assertEqual(out, {}, f"Call {call_n + 1}/{budget} should be allowed in {mode}")

                # Call budget + 1 must be hard-denied with redirect to explore
                proc, out = self.run_hook(
                    "preToolUse",
                    {
                        "sessionId": session_id,
                        "timestamp": 2000,
                        "cwd": "/repo",
                        "toolCallId": "call_overflow",
                        "toolName": "grep",
                        "toolArgs": {"pattern": "bar"},
                    },
                )
                self.assertEqual(proc.returncode, 0)
                self.assertEqual(out.get("permissionDecision"), "deny")
                self.assertIn("explore", out.get("permissionDecisionReason", "").lower())

                # Subagent call after parent exhaustion must still be allowed
                proc_sub, out_sub = self.run_hook(
                    "preToolUse",
                    {
                        "sessionId": session_id,
                        "timestamp": 2001,
                        "cwd": "/repo",
                        "toolCallId": "call_sub",
                        "toolName": "grep",
                        "toolArgs": {"pattern": "bar"},
                        "agentId": "worker-1",
                        "agentType": "explore",
                        "parentAgentId": session_id,
                    },
                )
                self.assertEqual(proc_sub.returncode, 0)
                self.assertEqual(out_sub, {})

                # Next user turn resets counter
                self.run_hook(
                    "userPromptSubmitted",
                    {"sessionId": session_id, "timestamp": 3000, "cwd": "/repo", "prompt": prompt},
                )
                proc_reset, out_reset = self.run_hook(
                    "preToolUse",
                    {
                        "sessionId": session_id,
                        "timestamp": 3001,
                        "cwd": "/repo",
                        "toolCallId": "call_reset",
                        "toolName": "view",
                        "toolArgs": {"path": "/repo/README.md"},
                    },
                )
                self.assertEqual(proc_reset.returncode, 0)
                self.assertEqual(out_reset, {})

    def test_stop_block_continuation_does_not_reset_discovery_count(self) -> None:
        session_id = "sess-stop-disc"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Run /security-review"},
        )
        for i in range(2):
            _, out = self.run_hook(
                "preToolUse",
                {"sessionId": session_id, "timestamp": 1001 + i, "cwd": "/repo", "toolName": "view", "toolArgs": {}},
            )
            self.assertEqual(out, {})

        # Arm pending_stop_block via .py edit + agentStop block
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/a.py", "old_str": "1", "new_str": "2"},
                "toolResult": {"resultType": "success"},
            },
        )
        _, stop_out = self.run_hook(
            "agentStop",
            {"sessionId": session_id, "timestamp": 1008, "cwd": "/repo", "stop_hook_active": False},
        )
        self.assertEqual(stop_out.get("decision"), "block")

        # Continuation prompt must NOT reset discovery_count
        self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1010,
                "cwd": "/repo",
                "prompt": "[orchestrator-guard:verify-required] Run checks",
            },
        )
        _, out = self.run_hook(
            "preToolUse",
            {"sessionId": session_id, "timestamp": 1011, "cwd": "/repo", "toolName": "grep", "toolArgs": {}},
        )
        self.assertEqual(out.get("permissionDecision"), "deny")

    def test_subagent_user_prompt_and_agent_stop_are_exempt_without_mutating_parent_state(self) -> None:
        session_id = "sess-sub-exempt"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Implement auth"},
        )
        self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolName": "edit",
                "toolArgs": {"path": "/repo/auth.py", "old_str": "1", "new_str": "2"},
                "toolResult": {"resultType": "success"},
            },
        )
        before_state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))

        # Defensive subagent userPromptSubmitted & agentStop must be pure no-ops
        _, out_prompt = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1002,
                "cwd": "/repo",
                "prompt": "!direct bypass",
                "agentId": "worker-1",
                "agentType": "general-purpose",
            },
        )
        _, out_stop = self.run_hook(
            "agentStop",
            {
                "sessionId": session_id,
                "timestamp": 1003,
                "cwd": "/repo",
                "stop_hook_active": False,
                "agentId": "worker-1",
                "agentType": "general-purpose",
            },
        )
        self.assertEqual(out_prompt, {})
        self.assertEqual(out_stop, {})
        after_state = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(after_state, before_state)
        events = self.read_telemetry()
        self.assertEqual(events[-2]["rule"], "subagent_exempt")
        self.assertEqual(events[-1]["rule"], "subagent_exempt")


class TestParentReadOnlyShellGuard(HookSubprocessTestCase):
    def test_allows_configured_read_only_commands(self) -> None:
        allowed = [
            "git status",
            "git status --short",
            "git --no-pager diff --stat",
            "git log --oneline -10",
            "git branch",
            "git branch -a",
            "git branch --show-current",
            "git show HEAD --stat",
            "ls -la",
            "wc -l pyproject.toml",
            "git log --oneline -20 | head -5",
            "git diff --stat | cat",
        ]
        for idx, cmd in enumerate(allowed):
            with self.subTest(command=cmd):
                proc, out = self.run_hook(
                    "preToolUse",
                    {
                        "sessionId": "sess-bash-allow",
                        "timestamp": 1000 + idx,
                        "cwd": "/repo",
                        "toolCallId": f"call_ok_{idx}",
                        "toolName": "bash",
                        "toolArgs": {"command": cmd, "description": "inspect"},
                    },
                )
                self.assertEqual(proc.returncode, 0)
                self.assertEqual(out, {}, f"Expected allow for: {cmd}")

    def test_denies_disallowed_scripts_and_compound_bypasses(self) -> None:
        denied = [
            "pytest",
            "poetry run pytest tests/",
            "ruff check .",
            "poetry install",
            "terraform plan",
            "./run_unit_tests.sh",
            "./test-local-accounts.sh",
            "./deploy.sh",
            "git status && pytest",
            "git status; echo pwned",
            "git status || pytest",
            "git log $(whoami)",
            "git log `id`",
            "git status > /tmp/out.txt",
            "git status &>/dev/null",
            "git status &>>/dev/null",
            "git status >|/dev/null",
            "git status <>/dev/null",
            "git status 2>|/dev/null",
            "git status x#; echo pwned",
            "ls | sh",
            "git status\npytest",
            "git branch -D feature",
            "git branch new-branch",
            "git -c core.pager=sh log",
            "git checkout main",
        ]
        for idx, cmd in enumerate(denied):
            with self.subTest(command=cmd):
                proc, out = self.run_hook(
                    "preToolUse",
                    {
                        "sessionId": "sess-bash-deny",
                        "timestamp": 2000 + idx,
                        "cwd": "/repo",
                        "toolCallId": f"call_bad_{idx}",
                        "toolName": "bash",
                        "toolArgs": {"command": cmd, "description": "run"},
                    },
                )
                self.assertEqual(proc.returncode, 0)
                self.assertEqual(out.get("permissionDecision"), "deny", f"Expected deny for: {cmd}")
                self.assertIn("general-purpose", out.get("permissionDecisionReason", "").lower())

    def test_subagent_bash_is_exempt(self) -> None:
        proc, out = self.run_hook(
            "preToolUse",
            {
                "sessionId": "sess-bash-sub",
                "timestamp": 3000,
                "cwd": "/repo",
                "toolCallId": "call_sub_pytest",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest", "description": "run tests"},
                "agentId": "worker-gp",
                "agentType": "general-purpose",
                "parentAgentId": "sess-bash-sub",
            },
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out, {})


class TestModesOverridesConcurrencyAndFailOpen(HookSubprocessTestCase):
    def test_guard_mode_off_allows_everything(self) -> None:
        proc, out = self.run_hook(
            "preToolUse",
            {
                "sessionId": "sess-off",
                "timestamp": 1000,
                "cwd": "/repo",
                "toolCallId": "call_off",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest"},
            },
            env_overrides={"ORCHESTRATOR_HOOKS": "off"},
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out, {})
        events = self.read_telemetry()
        self.assertEqual(events[-1]["decision"], "allow")
        self.assertEqual(events[-1]["rule"], "guard_off")

    def test_guard_mode_warn_allows_and_injects_post_tool_additional_context(self) -> None:
        session_id = "sess-warn"
        proc_pre, out_pre = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "toolCallId": "call_warn_1",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest"},
            },
            env_overrides={"ORCHESTRATOR_HOOKS": "warn"},
        )
        self.assertEqual(proc_pre.returncode, 0)
        self.assertEqual(out_pre, {})

        # Subagent postToolUse must NOT consume the parent's pending warning
        proc_sub_post, out_sub_post = self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1004,
                "cwd": "/repo",
                "toolName": "bash",
                "agentId": "worker-1",
                "agentType": "general-purpose",
            },
            env_overrides={"ORCHESTRATOR_HOOKS": "warn"},
        )
        self.assertEqual(proc_sub_post.returncode, 0)
        self.assertEqual(out_sub_post, {})

        proc_post, out_post = self.run_hook(
            "postToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1005,
                "cwd": "/repo",
                "toolCallId": "call_warn_1",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest"},
                "toolResult": {"resultType": "success", "textResultForLlm": "1 passed"},
            },
            env_overrides={"ORCHESTRATOR_HOOKS": "warn"},
        )
        self.assertEqual(proc_post.returncode, 0)
        ctx = out_post.get("additionalContext", "")
        self.assertIn("general-purpose", ctx.lower())

        events = self.read_telemetry()
        self.assertEqual(events[0]["decision"], "warn")
        self.assertEqual(events[0]["rule"], "bash_not_read_only")

    def test_direct_prefix_bypasses_single_turn_and_resets_next_turn(self) -> None:
        session_id = "sess-direct"
        _, out_prompt = self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "prompt": "!direct run pytest directly this once",
            },
        )
        self.assertIn("!direct", out_prompt.get("additionalContext", ""))

        # Allowed during !direct turn
        _, out_bash = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1001,
                "cwd": "/repo",
                "toolCallId": "call_d1",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest"},
            },
        )
        self.assertEqual(out_bash, {})

        # Next normal turn re-enables enforcement
        self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_id,
                "timestamp": 2000,
                "cwd": "/repo",
                "prompt": "Now check tests again",
            },
        )
        _, out_bash2 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 2001,
                "cwd": "/repo",
                "toolCallId": "call_d2",
                "toolName": "bash",
                "toolArgs": {"command": "poetry run pytest"},
            },
        )
        self.assertEqual(out_bash2.get("permissionDecision"), "deny")

    def test_declarative_policy_override_changes_budget_and_allowlist_without_code_change(self) -> None:
        custom_policy = json.loads(DEFAULT_POLICY.read_text(encoding="utf-8"))
        custom_policy["discovery_budgets"]["qa"] = 1
        custom_policy["bash_read_only_allowlist"]["commands"].append("pwd")
        policy_file = self.state_dir / "custom-policy.json"
        policy_file.write_text(json.dumps(custom_policy), encoding="utf-8")
        env = {"ORCHESTRATOR_HOOKS_POLICY": str(policy_file)}

        session_id = "sess-custom-policy"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Explain architecture"},
            env_overrides=env,
        )
        _, out1 = self.run_hook(
            "preToolUse",
            {"sessionId": session_id, "timestamp": 1001, "cwd": "/repo", "toolName": "view", "toolArgs": {}},
            env_overrides=env,
        )
        self.assertEqual(out1, {})
        _, out2 = self.run_hook(
            "preToolUse",
            {"sessionId": session_id, "timestamp": 1002, "cwd": "/repo", "toolName": "view", "toolArgs": {}},
            env_overrides=env,
        )
        self.assertEqual(out2.get("permissionDecision"), "deny")

        _, out_pwd = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1003,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "pwd"},
            },
            env_overrides=env,
        )
        self.assertEqual(out_pwd, {})

    def test_cwd_policy_auto_discovery_and_env_override(self) -> None:
        project_dir = self.state_dir / "project"
        project_policy_dir = project_dir / ".github"
        project_policy_dir.mkdir(parents=True)

        cwd_policy = json.loads(DEFAULT_POLICY.read_text(encoding="utf-8"))
        cwd_policy["discovery_budgets"]["qa"] = 1
        (project_policy_dir / "orchestrator-guard.policy.json").write_text(
            json.dumps(cwd_policy),
            encoding="utf-8",
        )

        # Without ORCHESTRATOR_HOOKS_POLICY, load_policy(cwd=Path(...)) loads the override too
        import sys
        from unittest import mock

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard.policy import load_policy

        env_without_override = {k: v for k, v in os.environ.items() if k != "ORCHESTRATOR_HOOKS_POLICY"}
        with mock.patch.dict(os.environ, env_without_override, clear=True):
            loaded_from_path = load_policy(cwd=project_dir)
        self.assertEqual(loaded_from_path.budget_for_mode("qa"), 1)

        # Without ORCHESTRATOR_HOOKS_POLICY, <cwd>/.github/orchestrator-guard.policy.json applies
        session_cwd = "sess-cwd-autodiscover"
        self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_cwd,
                "timestamp": 1000,
                "cwd": str(project_dir),
                "prompt": "Explain architecture",
            },
        )
        _, out1 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_cwd,
                "timestamp": 1001,
                "cwd": str(project_dir),
                "toolName": "view",
                "toolArgs": {},
            },
        )
        self.assertEqual(out1, {})
        _, out2 = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_cwd,
                "timestamp": 1002,
                "cwd": str(project_dir),
                "toolName": "view",
                "toolArgs": {},
            },
        )
        self.assertEqual(out2.get("permissionDecision"), "deny")

        # ORCHESTRATOR_HOOKS_POLICY overrides <cwd>/.github/orchestrator-guard.policy.json
        env_policy = json.loads(DEFAULT_POLICY.read_text(encoding="utf-8"))
        env_policy["discovery_budgets"]["qa"] = 3
        override_file = self.state_dir / "override-policy.json"
        override_file.write_text(json.dumps(env_policy), encoding="utf-8")
        env = {"ORCHESTRATOR_HOOKS_POLICY": str(override_file)}

        session_env = "sess-env-override-cwd"
        self.run_hook(
            "userPromptSubmitted",
            {
                "sessionId": session_env,
                "timestamp": 2000,
                "cwd": str(project_dir),
                "prompt": "Explain architecture",
            },
            env_overrides=env,
        )
        for idx in range(2):
            _, out_ok = self.run_hook(
                "preToolUse",
                {
                    "sessionId": session_env,
                    "timestamp": 2001 + idx,
                    "cwd": str(project_dir),
                    "toolName": "view",
                    "toolArgs": {},
                },
                env_overrides=env,
            )
            self.assertEqual(out_ok, {})

    def test_concurrent_subprocesses_preserve_exact_discovery_budget_under_flock(self) -> None:
        from concurrent.futures import ThreadPoolExecutor

        session_id = "sess-concurrent"
        self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "How does ETL work?"},
        )

        def call_view(idx: int) -> dict:
            proc, out = self.run_hook(
                "preToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1001 + idx,
                    "cwd": "/repo",
                    "toolCallId": f"call_conc_{idx}",
                    "toolName": "view",
                    "toolArgs": {"path": f"/repo/file_{idx}.py"},
                },
            )
            self.assertEqual(proc.returncode, 0)
            return out

        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(call_view, range(12)))

        allowed = sum(1 for r in results if not r)
        denied = sum(1 for r in results if r.get("permissionDecision") == "deny")
        self.assertEqual(allowed, 8)
        self.assertEqual(denied, 4)

        # Persisted state and telemetry must be valid JSON without corruption
        state_data = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(state_data["discovery_count"], 8)
        events = self.read_telemetry()
        self.assertEqual(len(events), 13)  # 1 userPromptSubmitted + 12 preToolUse

    def test_fail_open_on_malformed_stdin_and_corrupt_policy(self) -> None:
        proc_bad_json, out_bad_json = self.run_hook("preToolUse", "{not valid json")
        self.assertEqual(proc_bad_json.returncode, 0)
        self.assertEqual(out_bad_json, {})

        bad_policy = self.state_dir / "broken.json"
        bad_policy.write_text("{corrupt", encoding="utf-8")
        proc_bad_pol, out_bad_pol = self.run_hook(
            "preToolUse",
            {
                "sessionId": "sess-err",
                "timestamp": 1000,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "pytest"},
            },
            env_overrides={"ORCHESTRATOR_HOOKS_POLICY": str(bad_policy)},
        )
        self.assertEqual(proc_bad_pol.returncode, 0)
        self.assertEqual(out_bad_pol, {})

        err_log = (self.state_dir / "errors.log").read_text(encoding="utf-8")
        self.assertIn("preToolUse", err_log)

    def test_corrupt_state_file_self_heals_instead_of_permanently_disabling_guard(self) -> None:
        session_id = "sess-corrupt-state"
        (self.state_dir / f"{session_id}.json").write_text("{corrupt json", encoding="utf-8")

        proc, out = self.run_hook(
            "preToolUse",
            {
                "sessionId": session_id,
                "timestamp": 1000,
                "cwd": "/repo",
                "toolName": "bash",
                "toolArgs": {"command": "pytest"},
            },
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out.get("permissionDecision"), "deny")
        # State file must now be valid JSON again
        repaired = json.loads((self.state_dir / f"{session_id}.json").read_text(encoding="utf-8"))
        self.assertEqual(repaired["session_id"], session_id)

    def test_fresh_session_honors_policy_default_mode_before_first_prompt(self) -> None:
        custom_policy = json.loads(DEFAULT_POLICY.read_text(encoding="utf-8"))
        custom_policy["default_mode"] = "security"
        policy_file = self.state_dir / "security-default.json"
        policy_file.write_text(json.dumps(custom_policy), encoding="utf-8")
        env = {"ORCHESTRATOR_HOOKS_POLICY": str(policy_file)}

        for i in range(2):
            _, out = self.run_hook(
                "preToolUse",
                {
                    "sessionId": "sess-def-sec",
                    "timestamp": 1000 + i,
                    "cwd": "/repo",
                    "toolName": "view",
                    "toolArgs": {},
                },
                env_overrides=env,
            )
            self.assertEqual(out, {})
        _, out3 = self.run_hook(
            "preToolUse",
            {"sessionId": "sess-def-sec", "timestamp": 1003, "cwd": "/repo", "toolName": "view", "toolArgs": {}},
            env_overrides=env,
        )
        self.assertEqual(out3.get("permissionDecision"), "deny")

    def test_hook_manifest_wires_all_six_events_with_copilot_hook_dir(self) -> None:
        manifest_path = HOOK_CLI.parents[1] / "hooks" / "orchestrator-guard.json"
        self.assertTrue(manifest_path.exists(), f"Missing hook manifest: {manifest_path}")
        self.assertEqual(
            [p.name for p in manifest_path.parent.iterdir()],
            ["orchestrator-guard.json"],
            "Directory .github/hooks/ must contain only orchestrator-guard.json",
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest.get("version"), 1)
        hooks = manifest.get("hooks", {})
        expected_events = {
            "userPromptSubmitted",
            "preToolUse",
            "postToolUse",
            "subagentStart",
            "subagentStop",
            "agentStop",
        }
        self.assertTrue(expected_events.issubset(hooks.keys()))

        # Execute the preToolUse command via bash with COPILOT_HOOK_DIR exactly as Copilot CLI does
        cmd = hooks["preToolUse"][0]["bash"]
        env = os.environ.copy()
        env["COPILOT_HOOK_DIR"] = str(manifest_path.parent)
        env["ORCHESTRATOR_HOOKS_STATE_DIR"] = str(self.state_dir)
        env.pop("ORCHESTRATOR_HOOKS", None)
        proc = subprocess.run(
            ["bash", "-c", cmd],
            input=json.dumps(
                {
                    "sessionId": "sess-manifest",
                    "timestamp": 1000,
                    "cwd": "/repo",
                    "toolName": "bash",
                    "toolArgs": {"command": "pytest"},
                }
            ),
            text=True,
            capture_output=True,
            env=env,
            timeout=10,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out.get("permissionDecision"), "deny")

    def test_stale_session_files_pruned_on_user_prompt_submitted(self) -> None:
        import fcntl

        old_ts = time.time() - (8 * 86400)
        stale_json = self.state_dir / "old-session.json"
        stale_lock = self.state_dir / "old-session.lock"
        fresh_json = self.state_dir / "recent-session.json"
        fresh_with_old_lock = self.state_dir / "long-active-session.json"
        old_lock_for_fresh = self.state_dir / "long-active-session.lock"
        locked_orphan_lock = self.state_dir / "locked-orphan.lock"
        non_session = self.state_dir / "keep-notes.txt"
        current_id = "active-session"
        cur_json = self.state_dir / f"{current_id}.json"
        cur_lock = self.state_dir / f"{current_id}.lock"

        for f in (
            stale_json,
            stale_lock,
            fresh_json,
            fresh_with_old_lock,
            old_lock_for_fresh,
            locked_orphan_lock,
            non_session,
            cur_json,
            cur_lock,
        ):
            f.write_text("{}", encoding="utf-8")
        for f in (stale_json, stale_lock, old_lock_for_fresh, locked_orphan_lock, non_session, cur_json, cur_lock):
            os.utime(f, (old_ts, old_ts))

        with open(locked_orphan_lock, "r+", encoding="utf-8") as held_fh:
            fcntl.flock(held_fh, fcntl.LOCK_EX)
            try:
                proc, _ = self.run_hook(
                    "userPromptSubmitted",
                    {"sessionId": current_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Hello"},
                )
            finally:
                fcntl.flock(held_fh, fcntl.LOCK_UN)

        self.assertEqual(proc.returncode, 0)
        self.assertFalse(stale_json.exists())
        self.assertFalse(stale_lock.exists())
        self.assertTrue(fresh_json.exists())
        self.assertTrue(fresh_with_old_lock.exists())
        self.assertTrue(old_lock_for_fresh.exists(), "Active session's old .lock must NOT be unlinked")
        self.assertTrue(locked_orphan_lock.exists(), "Flock-held .lock must NOT be unlinked")
        self.assertTrue(non_session.exists())
        self.assertTrue(cur_json.exists())
        self.assertTrue(cur_lock.exists())

    def test_locked_session_state_revalidates_unlinked_lock_inode(self) -> None:
        import fcntl
        import sys
        import threading

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard.state import locked_session_state

        session_id = "sess-inode-reval"
        lock_path = self.state_dir / f"{session_id}.lock"
        with locked_session_state(session_id, state_dir=self.state_dir) as st:
            st.turn_index = 1

        orig_inode = lock_path.stat().st_ino
        entered = threading.Event()
        release = threading.Event()

        def holder() -> None:
            with locked_session_state(session_id, state_dir=self.state_dir) as st:
                entered.set()
                release.wait(timeout=5)
                replacement = self.state_dir / f"{session_id}.lock.new"
                replacement.write_text("", encoding="utf-8")
                os.replace(replacement, lock_path)
                st.turn_index = 2

        t = threading.Thread(target=holder)
        t.start()
        self.assertTrue(entered.wait(timeout=5))

        def delayed_release() -> None:
            time.sleep(0.05)
            release.set()

        threading.Thread(target=delayed_release).start()
        with locked_session_state(session_id, state_dir=self.state_dir) as st2:
            self.assertEqual(st2.turn_index, 2)
            self.assertNotEqual(lock_path.stat().st_ino, orig_inode)
            with open(lock_path, "r", encoding="utf-8") as probe_fh:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(probe_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        t.join(timeout=5)

    def test_open_locked_for_append_revalidates_inode_and_size_after_rotation(self) -> None:
        import sys

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard.telemetry import _open_locked_for_append

        log_path = self.state_dir / "rot.jsonl"
        log_path.write_text("x" * 100, encoding="utf-8")
        old_ino = log_path.stat().st_ino

        fh = _open_locked_for_append(log_path, max_bytes=50)
        try:
            st_fd = os.fstat(fh.fileno())
            st_path = os.stat(log_path)
            self.assertEqual((st_fd.st_dev, st_fd.st_ino), (st_path.st_dev, st_path.st_ino))
            self.assertNotEqual(st_fd.st_ino, old_ino)
            self.assertLess(st_fd.st_size, 50)
            fh.write('{"ok":true}\n')
            fh.flush()
        finally:
            import fcntl

            try:
                fcntl.flock(fh, fcntl.LOCK_UN)
            finally:
                fh.close()

        backup_path = self.state_dir / "rot.jsonl.1"
        self.assertEqual(backup_path.read_text(encoding="utf-8"), "x" * 100)
        self.assertEqual(log_path.read_text(encoding="utf-8"), '{"ok":true}\n')

    def test_telemetry_and_error_log_rotation_under_flock(self) -> None:
        env = {
            "ORCHESTRATOR_HOOKS_MAX_LOG_BYTES": "350",
            "ORCHESTRATOR_HOOKS_MAX_ERROR_LOG_BYTES": "250",
        }
        for idx in range(5):
            proc, _ = self.run_hook(
                "preToolUse",
                {
                    "sessionId": "sess-rotate",
                    "timestamp": 1000 + idx,
                    "cwd": "/repo",
                    "toolName": "view",
                    "toolArgs": {"path": f"/repo/f{idx}.py"},
                },
                env_overrides=env,
            )
            self.assertEqual(proc.returncode, 0)

        events_log = self.state_dir / "events.jsonl"
        events_backup = self.state_dir / "events.jsonl.1"
        self.assertTrue(events_log.exists())
        self.assertTrue(events_backup.exists())
        # Both files must contain valid JSONL lines
        for path in (events_log, events_backup):
            lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
            self.assertGreaterEqual(len(lines), 1)
            for ln in lines:
                json.loads(ln)

        # Trigger error log rotation via malformed stdin across multiple calls
        for _ in range(4):
            proc, _ = self.run_hook("preToolUse", "{bad-json", env_overrides=env)
            self.assertEqual(proc.returncode, 0)

        err_log = self.state_dir / "errors.log"
        err_backup = self.state_dir / "errors.log.1"
        self.assertTrue(err_log.exists())
        self.assertTrue(err_backup.exists())

    def test_hook_manifest_uses_python_s_and_tool_matchers(self) -> None:
        import re

        manifest_path = HOOK_CLI.parents[1] / "hooks" / "orchestrator-guard.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        hooks = manifest["hooks"]
        expected_events = (
            "userPromptSubmitted",
            "preToolUse",
            "postToolUse",
            "subagentStart",
            "subagentStop",
            "agentStop",
        )
        for event in expected_events:
            entries = hooks[event]
            self.assertEqual(len(entries), 1)
            self.assertTrue(
                entries[0]["bash"].startswith("python3 -S "),
                f"{event} command should use python3 -S: {entries[0]['bash']}",
            )
            self.assertEqual(entries[0]["timeoutSec"], 5)
            self.assertIn("${CLAUDE_PLUGIN_ROOT:-$COPILOT_HOOK_DIR/..}", entries[0]["bash"])

        pre_matcher = hooks["preToolUse"][0].get("matcher")
        post_matcher = hooks["postToolUse"][0].get("matcher")
        self.assertEqual(pre_matcher, "view|grep|glob|edit|create|task|bash")
        self.assertEqual(post_matcher, "view|grep|glob|edit|create|task|bash|write_agent|read_bash")

        pre_guarded = ("view", "grep", "glob", "edit", "create", "task", "bash")
        post_guarded = (*pre_guarded, "write_agent", "read_bash")
        unguarded = ("sql", "ask_user", "skill", "read_agent", "github-mcp-server-list_issues")

        for tool in pre_guarded:
            self.assertIsNotNone(re.fullmatch(pre_matcher, tool), f"preToolUse should match {tool}")
        for tool in (*unguarded, "write_agent", "read_bash"):
            self.assertIsNone(re.fullmatch(pre_matcher, tool), f"preToolUse should not match {tool}")

        for tool in post_guarded:
            self.assertIsNotNone(re.fullmatch(post_matcher, tool), f"postToolUse should match {tool}")
        for tool in unguarded:
            self.assertIsNone(re.fullmatch(post_matcher, tool), f"postToolUse should not match {tool}")

    def test_dirty_check_skips_state_rewrite_on_noop_events_and_writes_compact_json(self) -> None:
        session_id = "sess-dirty-check"
        proc, _ = self.run_hook(
            "userPromptSubmitted",
            {"sessionId": session_id, "timestamp": 1000, "cwd": "/repo", "prompt": "Explain foo"},
        )
        self.assertEqual(proc.returncode, 0)

        state_path = self.state_dir / f"{session_id}.json"
        raw = state_path.read_text(encoding="utf-8")
        self.assertNotIn("\n", raw.strip())
        self.assertEqual(raw, json.dumps(json.loads(raw), ensure_ascii=False, separators=(",", ":")))

        st_before = state_path.stat()
        noop_calls = [
            (
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1001,
                    "cwd": "/repo",
                    "toolName": "grep",
                    "toolArgs": {"pattern": "foo"},
                    "toolResult": {"resultType": "success"},
                },
            ),
            (
                "preToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 1002,
                    "cwd": "/repo",
                    "toolName": "bash",
                    "toolArgs": {"command": "pytest"},
                    "agentId": "worker-1",
                },
            ),
            (
                "agentStop",
                {"sessionId": session_id, "timestamp": 1003, "cwd": "/repo", "stop_hook_active": False},
            ),
            (
                "subagentStop",
                {
                    "sessionId": session_id,
                    "timestamp": 1004,
                    "cwd": "/repo",
                    "agentId": "worker-1",
                    "agentType": "explore",
                },
            ),
        ]
        for ev, pl in noop_calls:
            p, _ = self.run_hook(ev, pl)
            self.assertEqual(p.returncode, 0)

        st_after = state_path.stat()
        self.assertEqual(st_after.st_ino, st_before.st_ino)
        self.assertEqual(st_after.st_mtime_ns, st_before.st_mtime_ns)

        # Mutating event (view increments discovery_count) updates state file
        self.run_hook(
            "preToolUse",
            {"sessionId": session_id, "timestamp": 1005, "cwd": "/repo", "toolName": "view", "toolArgs": {}},
        )
        self.assertEqual(json.loads(state_path.read_text(encoding="utf-8"))["discovery_count"], 1)

    def test_terminal_subagent_stop_prunes_and_state_caps_subagents_and_viewed_files(self) -> None:
        import sys

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard.state import SessionState

        session_id = "sess-prune-cap"
        for i in range(35):
            self.run_hook(
                "subagentStart",
                {
                    "sessionId": session_id,
                    "timestamp": 1000 + i,
                    "cwd": "/repo",
                    "agentId": f"agent-{i}",
                    "agentType": "explore",
                },
            )

        state_path = self.state_dir / f"{session_id}.json"
        mid = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertEqual(len(mid["active_subagents"]), 32)
        self.assertEqual(len(mid["subagent_start_ts"]), 32)
        self.assertNotIn("agent-0", mid["active_subagents"])
        self.assertNotIn("agent-2", mid["active_subagents"])
        self.assertIn("agent-3", mid["active_subagents"])
        self.assertIn("agent-34", mid["active_subagents"])

        # Terminal stopReason prunes agent-34; end_turn keeps agent-33
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 2000,
                "cwd": "/repo",
                "agentId": "agent-34",
                "stopReason": "cancelled",
            },
        )
        self.run_hook(
            "subagentStop",
            {
                "sessionId": session_id,
                "timestamp": 2001,
                "cwd": "/repo",
                "agentId": "agent-33",
                "stopReason": "end_turn",
            },
        )
        after = json.loads(state_path.read_text(encoding="utf-8"))
        self.assertNotIn("agent-34", after["active_subagents"])
        self.assertNotIn("agent-34", after["subagent_start_ts"])
        self.assertIn("agent-33", after["active_subagents"])
        self.assertIn("agent-33", after["subagent_start_ts"])

        # viewed_files caps at 200 unique entries and keeps re-viewed files recent
        # Pre-seed 205 entries, then run subprocess view calls to verify from_dict/to_dict + recency
        seeded = json.loads(state_path.read_text(encoding="utf-8"))
        seeded["viewed_files"] = [f"/repo/f{i}.py" for i in range(205)]
        state_path.write_text(json.dumps(seeded, separators=(",", ":")), encoding="utf-8")

        # Re-view f5 (currently oldest surviving after 0..4 drop), then view f999 -> f5 survives, f6 evicted
        for idx, name in enumerate(("f5", "f999")):
            self.run_hook(
                "postToolUse",
                {
                    "sessionId": session_id,
                    "timestamp": 4000 + idx,
                    "cwd": "/repo",
                    "toolName": "view",
                    "toolArgs": {"path": f"/repo/{name}.py"},
                    "toolResult": {"resultType": "success"},
                },
            )
        vf_state = json.loads(state_path.read_text(encoding="utf-8"))["viewed_files"]
        self.assertEqual(len(vf_state), 200)
        self.assertIn("/repo/f5.py", vf_state)
        self.assertIn("/repo/f999.py", vf_state)
        self.assertNotIn("/repo/f6.py", vf_state)
        self.assertEqual(vf_state[-2:], ["/repo/f5.py", "/repo/f999.py"])

        # Legacy SessionState without review_dirty_file_lines loads cleanly
        legacy = SessionState.from_dict("legacy", {"session_id": "legacy"})
        self.assertEqual(legacy.review_dirty_file_lines, {})

    def test_lightweight_config_immutability_and_lazy_imports_on_hot_events(self) -> None:
        import sys

        hooks_root = str(HOOK_CLI.parents[1])
        if hooks_root not in sys.path:
            sys.path.insert(0, hooks_root)
        from orchestrator_guard.classifier import TurnPolicy
        from orchestrator_guard.policy import load_policy

        cfg = load_policy()
        self.assertEqual(cfg, load_policy())
        self.assertIn("PolicyConfig(", repr(cfg))
        with self.assertRaises(AttributeError):
            cfg.default_mode = "implement"  # type: ignore[misc]

        tp = TurnPolicy("qa", 8, False, "default:qa", "dir")
        self.assertEqual(tp, TurnPolicy("qa", 8, False, "default:qa", "dir"))
        self.assertIn("TurnPolicy(", repr(tp))
        with self.assertRaises(AttributeError):
            tp.mode = "debug"  # type: ignore[misc]

        # Run cli.py with -S and check sys.modules after preToolUse(view)
        probe = (
            "import json, os, sys; "
            f"sys.path.insert(0, {hooks_root!r}); "
            "from orchestrator_guard.engine import handle_event; "
            "handle_event('preToolUse', {'sessionId': 'lazy-1', 'toolName': 'view', 'toolArgs': {'path': 'a.py'}}); "
            "handle_event('subagentStart', {'sessionId': 'lazy-1', 'agentId': 'a1', 'agentType': 'explore'}); "
            "bad = [m for m in ('dataclasses', 'inspect', 'tempfile', 'traceback', 'difflib', 'shlex', "
            "'subprocess', 'datetime', 'orchestrator_guard.classifier', 'orchestrator_guard.shell_guard', "
            "'orchestrator_guard.write_delegation_guard', 'orchestrator_guard.verification_gate') "
            "if m in sys.modules]; "
            "print(json.dumps(bad))"
        )
        env = os.environ.copy()
        env["ORCHESTRATOR_HOOKS_STATE_DIR"] = str(self.state_dir)
        proc = subprocess.run(
            ["python3", "-S", "-c", probe],
            text=True,
            capture_output=True,
            env=env,
            timeout=10,
            check=True,
        )
        self.assertEqual(json.loads(proc.stdout.strip()), [])


if __name__ == "__main__":
    unittest.main()
