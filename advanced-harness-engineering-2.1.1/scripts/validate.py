#!/usr/bin/env python3
"""Check that every skill follows the repository's portability conventions.

Standard library only. Exits non-zero and lists every problem found.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILLS = REPO / "skills"
EXTENSIONS = REPO / "extensions"
AGENTS = REPO / "agents"
HOOKS = REPO / "hooks"
GUARD_POLICY = REPO / "orchestrator_guard" / "policy.json"
PLUGIN_MANIFEST = REPO / ".claude-plugin" / "plugin.json"
PACKAGE_JSON = REPO / "package.json"
SNIPPET = REPO / "instructions" / "AGENTS.md"
README = REPO / "README.md"

ALLOWED_KEYS = {"name", "description", "disable-model-invocation", "license"}
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
LOAD_RE = re.compile(r"[Ll]oad the `([^`]+)` skill")
SLASH_RE = re.compile(r"`/([a-z0-9-]+)`")
BARE_RE = re.compile(r"`([a-z0-9-]+)`")
LINK_RE = re.compile(r"\]\(([^)\s]+)\)")
MAX_BODY_LINES = 500
MAX_DESCRIPTION = 1024

# Harness-specific tools, paths, or upstream-only skills that would not exist elsewhere.
BANNED = [
    (re.compile(r"\b(Skill|Task|Agent) tool\b"), "harness-specific tool name"),
    (re.compile(r"AskUserQuestion|TodoWrite|ExitPlanMode"), "harness-specific tool name"),
    (re.compile(r"CLAUDE\.md|\.claude/|\.cursor/|agent-transcripts"), "harness-specific path"),
    (re.compile(r"setup-matt-pocock-skills|poteto-mode|\bunslop\b|playbook"), "upstream-only reference"),
]


class Skill:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.name = path.name
        self.meta: dict[str, object] = {}
        self.body = ""


def parse_scalar(raw: str) -> object:
    raw = raw.strip()
    if raw in ("true", "false"):
        return raw == "true"
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        return raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1].replace("''", "'")
    return raw


def parse_frontmatter(text: str, where: str, errors: list[str]) -> tuple[dict[str, object], str]:
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        errors.append(f"{where}: missing YAML frontmatter")
        return {}, text
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        errors.append(f"{where}: unterminated YAML frontmatter")
        return {}, text
    meta: dict[str, object] = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if not match or match.group(2).strip() in ("", "|", ">", "|-", ">-"):
            errors.append(f"{where}: frontmatter must use single-line 'key: value' entries: {line!r}")
            continue
        key, value = match.group(1), match.group(2)
        if key in meta:
            errors.append(f"{where}: duplicate frontmatter key {key!r}")
        meta[key] = parse_scalar(value)
    return meta, "\n".join(lines[end + 1 :])


def parse_simple_yaml(text: str) -> dict[str, dict[str, object]]:
    """Parse a two-level mapping such as agents/openai.yaml."""
    data: dict[str, dict[str, object]] = {}
    section = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        top = re.match(r"^([A-Za-z0-9_-]+):\s*$", line)
        child = re.match(r"^\s{2}([A-Za-z0-9_-]+):\s*(.+)$", line)
        if top:
            section = top.group(1)
            data[section] = {}
        elif child and section is not None:
            data[section][child.group(1)] = parse_scalar(child.group(2))
        else:
            raise ValueError(f"unsupported line {line!r}")
    return data


def load_skills(errors: list[str]) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    for path in sorted(p for p in SKILLS.iterdir() if p.is_dir()):
        skill_md = path / "SKILL.md"
        if not skill_md.is_file():
            errors.append(f"skills/{path.name}: missing SKILL.md")
            continue
        skill = Skill(path)
        skill.meta, skill.body = parse_frontmatter(
            skill_md.read_text(encoding="utf-8"), f"skills/{path.name}/SKILL.md", errors
        )
        skills[skill.name] = skill
    return skills


def user_invoked(skill: Skill) -> bool:
    return skill.meta.get("disable-model-invocation") is True


def check_frontmatter(skill: Skill, errors: list[str]) -> None:
    where = f"skills/{skill.name}/SKILL.md"
    meta = skill.meta
    for key in sorted(set(meta) - ALLOWED_KEYS):
        errors.append(f"{where}: frontmatter key {key!r} is not portable (allowed: {sorted(ALLOWED_KEYS)})")
    name = meta.get("name")
    if name != skill.name:
        errors.append(f"{where}: name {name!r} must match folder {skill.name!r}")
    if not NAME_RE.match(skill.name) or len(skill.name) > 64:
        errors.append(f"{where}: folder name must be 1-64 lowercase letters, digits, single hyphens")
    description = meta.get("description")
    if not isinstance(description, str) or not description.strip():
        errors.append(f"{where}: description is required")
        return
    if len(description) > MAX_DESCRIPTION:
        errors.append(f"{where}: description is {len(description)} chars (max {MAX_DESCRIPTION})")
    if "<" in description or ">" in description:
        errors.append(f"{where}: description must not contain angle brackets")
    if "disable-model-invocation" in meta and meta["disable-model-invocation"] is not True:
        errors.append(f"{where}: set disable-model-invocation to true or omit it")
    if "license" in meta:
        lic = meta["license"]
        if not isinstance(lic, str) or not lic.strip():
            errors.append(f"{where}: license must be a non-empty string when present")
    has_triggers = "Use when" in description
    if user_invoked(skill) and has_triggers:
        errors.append(f"{where}: user-invoked description is human-facing; drop the 'Use when' triggers")
    if not user_invoked(skill) and not has_triggers:
        errors.append(f"{where}: model-invoked description needs 'Use when:' triggers")
    body_lines = skill.body.count("\n") + 1
    if body_lines > MAX_BODY_LINES:
        errors.append(f"{where}: body has {body_lines} lines (max {MAX_BODY_LINES}); move detail to references/")


def check_openai_yaml(skill: Skill, errors: list[str]) -> None:
    path = skill.path / "agents" / "openai.yaml"
    where = f"skills/{skill.name}/agents/openai.yaml"
    if not path.is_file():
        errors.append(f"{where}: missing")
        return
    try:
        data = parse_simple_yaml(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        errors.append(f"{where}: {exc}")
        return
    interface = data.get("interface", {})
    for key in ("display_name", "short_description"):
        if not isinstance(interface.get(key), str) or not interface.get(key):
            errors.append(f"{where}: interface.{key} is required")
    implicit = data.get("policy", {}).get("allow_implicit_invocation", True)
    if user_invoked(skill) and implicit is not False:
        errors.append(f"{where}: user-invoked skill needs policy.allow_implicit_invocation: false")
    if not user_invoked(skill) and implicit is False:
        errors.append(f"{where}: model-invoked skill must not disable implicit invocation")


def check_references(skill: Skill, skills: dict[str, Skill], errors: list[str]) -> None:
    for md in sorted(skill.path.rglob("*.md")):
        where = md.relative_to(REPO).as_posix()
        text = md.read_text(encoding="utf-8")
        for target in LOAD_RE.findall(text):
            if target not in skills:
                errors.append(f"{where}: loads unknown skill {target!r}")
            elif user_invoked(skills[target]):
                errors.append(f"{where}: loads user-invoked skill {target!r}; tell the user to run /{target} instead")
            elif target == skill.name:
                errors.append(f"{where}: loads itself")
        if not user_invoked(skill):
            for target in BARE_RE.findall(text):
                if target in skills and user_invoked(skills[target]):
                    errors.append(f"{where}: refers to user-invoked skill as `{target}`; write `/{target}` and tell the user to run it")
        for target in SLASH_RE.findall(text):
            if target in skills and not user_invoked(skills[target]):
                errors.append(f"{where}: /{target} is model-invoked; write 'load the `{target}` skill'")
        for pattern, label in BANNED:
            for match in pattern.finditer(text):
                errors.append(f"{where}: {label}: {match.group(0)!r}")


def check_scripts(skill: Skill, errors: list[str]) -> None:
    scripts = skill.path / "scripts"
    if not scripts.is_dir():
        return
    for path in sorted(scripts.iterdir()):
        if path.suffix == ".sh" and not os.access(path, os.X_OK):
            errors.append(f"{path.relative_to(REPO).as_posix()}: not executable")


def check_links(errors: list[str]) -> None:
    for md in sorted(REPO.rglob("*.md")):
        if ".git" in md.parts:
            continue
        text = md.read_text(encoding="utf-8")
        text = re.sub(r"```.*?```", "", text, flags=re.S)
        for target in LINK_RE.findall(text):
            if re.match(r"^[a-z]+:", target) or target.startswith("#"):
                continue
            path = target.split("#", 1)[0]
            if path and not (md.parent / path).exists():
                errors.append(f"{md.relative_to(REPO).as_posix()}: broken link {target!r}")


def check_coverage(skills: dict[str, Skill], errors: list[str]) -> None:
    for doc in (SNIPPET, README):
        if not doc.is_file():
            errors.append(f"{doc.relative_to(REPO).as_posix()}: missing")
            continue
        text = doc.read_text(encoding="utf-8")
        if doc == SNIPPET:
            for target in BARE_RE.findall(text):
                if target in skills and user_invoked(skills[target]):
                    errors.append(f"instructions/AGENTS.md: write user-invoked `{target}` as `/{target}`")
        for name, skill in skills.items():
            token = f"`/{name}`" if user_invoked(skill) else f"`{name}`"
            if token not in text:
                errors.append(f"{doc.relative_to(REPO).as_posix()}: does not mention {token}")


def check_extensions(errors: list[str]) -> int:
    if not EXTENSIONS.is_dir():
        return 0
    count = 0
    for path in sorted(p for p in EXTENSIONS.iterdir() if p.is_dir()):
        count += 1
        if not any((path / entry).is_file() for entry in ("extension.mjs", "extension.cjs", "extension.js")):
            errors.append(f"extensions/{path.name}: missing extension.mjs, extension.cjs, or extension.js")
    return count


def check_agents(errors: list[str]) -> int:
    if not AGENTS.is_dir():
        return 0
    count = 0
    for path in sorted(AGENTS.glob("*.agent.md")):
        count += 1
        where = f"agents/{path.name}"
        meta, _ = parse_frontmatter(path.read_text(encoding="utf-8"), where, errors)
        stem = path.name[: -len(".agent.md")]
        name = meta.get("name")
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{where}: name is required")
        elif name != stem:
            errors.append(f"{where}: name {name!r} must match filename stem {stem!r}")
        description = meta.get("description")
        if not isinstance(description, str) or not description.strip():
            errors.append(f"{where}: description is required")
        for key in ("user-invocable", "disable-model-invocation"):
            if key in meta and not isinstance(meta[key], bool):
                errors.append(f"{where}: {key} must be a boolean")
    return count


def check_hooks(errors: list[str]) -> int:
    if not HOOKS.is_dir():
        return 0
    count = 0
    for path in sorted(HOOKS.glob("*.json")):
        count += 1
        where = f"hooks/{path.name}"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{where}: invalid JSON ({exc})")
            continue
        if not isinstance(data, dict):
            errors.append(f"{where}: must be a JSON object")
            continue
        version = data.get("version")
        if not isinstance(version, int) or isinstance(version, bool):
            errors.append(f"{where}: integer 'version' is required")
        if not isinstance(data.get("hooks"), dict):
            errors.append(f"{where}: 'hooks' object is required")
    return count


def check_guard_policy(errors: list[str]) -> None:
    where = "orchestrator_guard/policy.json"
    if not GUARD_POLICY.is_file():
        errors.append(f"{where}: missing")
        return
    try:
        data = json.loads(GUARD_POLICY.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{where}: invalid JSON ({exc})")
        return
    if not isinstance(data, dict):
        errors.append(f"{where}: must be a JSON object")


def check_plugin_manifest(errors: list[str]) -> None:
    where = ".claude-plugin/plugin.json"
    if not PLUGIN_MANIFEST.is_file():
        errors.append(f"{where}: missing")
        return
    try:
        data = json.loads(PLUGIN_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{where}: invalid JSON ({exc})")
        return
    if not isinstance(data, dict):
        errors.append(f"{where}: must be a JSON object")
        return
    for key in ("name", "description"):
        val = data.get(key)
        if not isinstance(val, str) or not val.strip():
            errors.append(f"{where}: {key!r} must be a non-empty string")
    for key, val in data.items():
        if key in ("name", "version", "description"):
            continue
        items = val if isinstance(val, list) else [val]
        for item in items:
            if isinstance(item, str) and item.startswith("./"):
                if not (REPO / item).exists():
                    errors.append(f"{where}: {key} path {item!r} does not exist")


def check_package_manifest(skills: dict[str, Skill], errors: list[str]) -> None:
    where = "package.json"
    if not PACKAGE_JSON.is_file():
        errors.append(f"{where}: missing")
        return
    try:
        data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{where}: invalid JSON ({exc})")
        return
    if not isinstance(data, dict):
        errors.append(f"{where}: must be a JSON object")
        return
    pi = data.get("pi")
    if not isinstance(pi, dict):
        errors.append(f"{where}: 'pi' object is required")
        return

    listed_skills: set[str] = set()
    for field in ("skills", "extensions"):
        entries = pi.get(field)
        if not isinstance(entries, list):
            errors.append(f"{where}: pi.{field} must be a list")
            continue
        for entry in entries:
            if not isinstance(entry, str) or not entry.strip():
                errors.append(f"{where}: pi.{field} contains an invalid path {entry!r}")
                continue
            if not (REPO / entry).exists():
                errors.append(f"{where}: pi.{field} path {entry!r} does not exist")
            elif field == "skills":
                listed_skills.add(Path(entry).as_posix().rstrip("/"))

    for skill_dir in sorted(p for p in SKILLS.iterdir() if p.is_dir()):
        rel = f"skills/{skill_dir.name}"
        if rel not in listed_skills:
            errors.append(f"{where}: skill directory {rel!r} is missing from pi.skills")


def main() -> int:
    errors: list[str] = []
    skills = load_skills(errors)
    for skill in skills.values():
        check_frontmatter(skill, errors)
        check_openai_yaml(skill, errors)
        check_references(skill, skills, errors)
        check_scripts(skill, errors)
    ext_count = check_extensions(errors)
    agent_count = check_agents(errors)
    hook_count = check_hooks(errors)
    check_guard_policy(errors)
    check_plugin_manifest(errors)
    check_package_manifest(skills, errors)
    check_links(errors)
    check_coverage(skills, errors)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(f"\n{len(errors)} problem(s) found", file=sys.stderr)
        return 1
    user = sum(user_invoked(s) for s in skills.values())
    print(
        f"ok: {len(skills)} skills ({len(skills) - user} model-invoked, {user} user-invoked), "
        f"{ext_count} extensions, {agent_count} agents, {hook_count} hooks"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
