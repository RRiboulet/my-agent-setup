"""Declarative policy configuration loader."""

from __future__ import annotations

import json
import os
from typing import Any

DEFAULT_POLICY_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), "policy.json")


class PolicyConfig:
    __slots__ = (
        "bash_read_only_allowlist",
        "classifier_rules",
        "default_mode",
        "direct_prefix",
        "discovery_budgets",
        "discovery_tools",
        "max_edit_lines",
        "max_edited_files_per_turn",
        "mode_directives",
        "model_mention_patterns",
        "review_threshold_files",
        "review_threshold_lines",
        "steer_unlock_threshold",
        "stop_block_sentinel",
        "verification_commands",
        "verification_file_rules",
        "version",
    )

    def __init__(
        self,
        version: int,
        default_mode: str,
        direct_prefix: str,
        stop_block_sentinel: str,
        discovery_tools: tuple[str, ...],
        discovery_budgets: dict[str, int],
        mode_directives: dict[str, str],
        classifier_rules: tuple[dict[str, Any], ...],
        bash_read_only_allowlist: dict[str, Any] | None = None,
        max_edit_lines: int = 20,
        max_edited_files_per_turn: int = 1,
        model_mention_patterns: tuple[str, ...] | None = None,
        steer_unlock_threshold: int = 2,
        verification_file_rules: dict[str, Any] | None = None,
        review_threshold_files: int = 2,
        review_threshold_lines: int = 50,
        verification_commands: dict[str, Any] | None = None,
    ) -> None:
        object.__setattr__(self, "version", version)
        object.__setattr__(self, "default_mode", default_mode)
        object.__setattr__(self, "direct_prefix", direct_prefix)
        object.__setattr__(self, "stop_block_sentinel", stop_block_sentinel)
        object.__setattr__(self, "discovery_tools", discovery_tools)
        object.__setattr__(self, "discovery_budgets", discovery_budgets)
        object.__setattr__(self, "mode_directives", mode_directives)
        object.__setattr__(self, "classifier_rules", classifier_rules)
        object.__setattr__(
            self,
            "bash_read_only_allowlist",
            {} if bash_read_only_allowlist is None else bash_read_only_allowlist,
        )
        object.__setattr__(self, "max_edit_lines", max_edit_lines)
        object.__setattr__(self, "max_edited_files_per_turn", max_edited_files_per_turn)
        object.__setattr__(self, "model_mention_patterns", model_mention_patterns)
        object.__setattr__(self, "steer_unlock_threshold", steer_unlock_threshold)
        object.__setattr__(
            self,
            "verification_file_rules",
            {} if verification_file_rules is None else verification_file_rules,
        )
        object.__setattr__(self, "review_threshold_files", review_threshold_files)
        object.__setattr__(self, "review_threshold_lines", review_threshold_lines)
        object.__setattr__(
            self,
            "verification_commands",
            {} if verification_commands is None else verification_commands,
        )

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("PolicyConfig is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("PolicyConfig is immutable")

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, PolicyConfig):
            return NotImplemented
        return all(getattr(self, slot) == getattr(other, slot) for slot in self.__slots__)

    def __repr__(self) -> str:
        fields = ", ".join(f"{slot}={getattr(self, slot)!r}" for slot in self.__slots__)
        return f"PolicyConfig({fields})"

    def budget_for_mode(self, mode: str) -> int:
        if mode in self.discovery_budgets:
            return int(self.discovery_budgets[mode])
        return int(self.discovery_budgets.get(self.default_mode, 4))


def load_policy(
    policy_path: os.PathLike[str] | str | None = None,
    cwd: os.PathLike[str] | str | None = None,
) -> PolicyConfig:
    env_policy = os.environ.get("ORCHESTRATOR_HOOKS_POLICY")
    if policy_path:
        raw_path = os.fspath(policy_path)
    elif env_policy:
        raw_path = env_policy
    else:
        cwd_str = os.fspath(cwd).strip() if isinstance(cwd, (str, os.PathLike)) else ""
        cwd_policy = (
            os.path.join(cwd_str, ".github", "orchestrator-guard.policy.json")
            if cwd_str
            else ""
        )
        raw_path = cwd_policy if cwd_policy and os.path.isfile(cwd_policy) else DEFAULT_POLICY_PATH
    with open(raw_path, encoding="utf-8") as fh:
        data = json.load(fh)
    write_limits = data.get("parent_write_limits") or {}
    verification = data.get("verification") or {}
    return PolicyConfig(
        version=int(data.get("version", 1)),
        default_mode=str(data.get("default_mode", "qa")),
        direct_prefix=str(data.get("direct_prefix", "!direct")),
        stop_block_sentinel=str(data.get("stop_block_sentinel", "[orchestrator-guard:verify-required]")),
        discovery_tools=tuple(data.get("discovery_tools", ("view", "grep", "glob"))),
        discovery_budgets={k: int(v) for k, v in data.get("discovery_budgets", {}).items()},
        mode_directives={k: str(v) for k, v in data.get("mode_directives", {}).items()},
        classifier_rules=tuple(data.get("classifier_rules", ())),
        bash_read_only_allowlist=dict(data.get("bash_read_only_allowlist", {})),
        max_edit_lines=int(write_limits.get("max_edit_lines", 20)),
        max_edited_files_per_turn=int(write_limits.get("max_edited_files_per_turn", 1)),
        model_mention_patterns=(
            tuple(data["model_mention_patterns"]) if "model_mention_patterns" in data else None
        ),
        steer_unlock_threshold=int(data.get("steer_unlock_threshold", 2)),
        verification_file_rules=dict(verification.get("file_rules") or {}),
        review_threshold_files=int(verification.get("review_threshold_files", 2)),
        review_threshold_lines=int(verification.get("review_threshold_lines", 50)),
        verification_commands=dict(verification.get("verify_commands") or {}),
    )
