"""Swappable turn-mode classifier (System-1 router seam)."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from orchestrator_guard.policy import PolicyConfig
    from orchestrator_guard.state import SessionState


class TurnPolicy:
    __slots__ = ("direct_bypass", "directive", "discovery_budget", "matched_rule", "mode")

    def __init__(
        self,
        mode: str,
        discovery_budget: int,
        direct_bypass: bool,
        matched_rule: str,
        directive: str,
    ) -> None:
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "discovery_budget", discovery_budget)
        object.__setattr__(self, "direct_bypass", direct_bypass)
        object.__setattr__(self, "matched_rule", matched_rule)
        object.__setattr__(self, "directive", directive)

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("TurnPolicy is immutable")

    def __delattr__(self, name: str) -> None:
        raise AttributeError("TurnPolicy is immutable")

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, TurnPolicy):
            return NotImplemented
        return all(getattr(self, slot) == getattr(other, slot) for slot in self.__slots__)

    def __repr__(self) -> str:
        fields = ", ".join(f"{slot}={getattr(self, slot)!r}" for slot in self.__slots__)
        return f"TurnPolicy({fields})"


ClassifierFn = Callable[["str", "SessionState", "PolicyConfig"], TurnPolicy]


def classify_turn(
    prompt: str,
    session_state: SessionState,
    config: PolicyConfig,
) -> TurnPolicy:
    """Classify a user prompt into a TurnPolicy using deterministic ordered heuristics.

    Designed as a pure swappable interface so a fast-model router can replace this
    function later without changing hook enforcement.
    """
    stripped = prompt.lstrip()
    prefix = config.direct_prefix
    direct_bypass = False
    effective_prompt = stripped
    if prefix and stripped.startswith(prefix):
        after = stripped[len(prefix) :]
        if after == "" or after[0].isspace():
            direct_bypass = True
            effective_prompt = after.lstrip()

    chosen_mode = config.default_mode
    matched_rule = f"default:{chosen_mode}"

    for rule in config.classifier_rules:
        mode = str(rule.get("mode", config.default_mode))
        for pattern in rule.get("patterns", ()):
            if re.search(pattern, effective_prompt, flags=re.IGNORECASE):
                chosen_mode = mode
                matched_rule = f"heuristic:{mode}"
                break
        if matched_rule != f"default:{config.default_mode}":
            break

    budget = config.budget_for_mode(chosen_mode)
    template = config.mode_directives.get(
        chosen_mode,
        "Mode: {mode} (direct discovery budget: {budget}). Delegate broad work to subagents.",
    )
    directive = template.format(mode=chosen_mode, budget=budget)
    if direct_bypass:
        directive = (
            f"Mode: {chosen_mode} (`{prefix}` bypass active for this turn). "
            "Parent delegation limits are suspended until the next user prompt."
        )

    return TurnPolicy(
        mode=chosen_mode,
        discovery_budget=budget,
        direct_bypass=direct_bypass,
        matched_rule=matched_rule,
        directive=directive,
    )
