---
name: review-change
description: "Review a diff on separate Spec, Correctness, and Standards axes, proving correctness findings with runs or concrete paths. Use when: asked to review a branch, PR, diff, or uncommitted work; or after a non-trivial change before claiming done."
---

# Review a change

Review a diff on three separate axes, so one kind of finding cannot mask another:

- **Spec**: does the change do what was asked, and only that?
- **Correctness**: does it break, regress, or miss an edge case?
- **Standards**: does it follow the repository's documented conventions?

Report findings; do not fix them unless the caller asked you to.

## 1. Pin the diff

- Use the fixed point the user named (commit, branch, tag, `main`, `HEAD~3`). If none and the work is uncommitted, review the working tree against `HEAD`, including untracked files. Otherwise ask.
- Use `git diff <fixed-point>...HEAD` (three dots, against the merge base) plus `git diff HEAD` for uncommitted work, and note `git log <fixed-point>..HEAD --oneline`.
- Confirm the ref resolves and the diff is non-empty before going further.

## 2. Find the references

- **Spec**, in this order: a path or issue the user gave; issue references in commit messages; a spec, ticket, or playback in `docs/`, `specs/`, `.scratch/`, or the conversation. If there is none, the Spec axis reports "no spec available" and judges against the stated request only.
- **Standards**: every file that documents how code should be written, such as `CONTRIBUTING.md`, `CODING_STANDARDS.md`, agent instruction files, ADRs, and lint or format configs. Skip anything tooling already enforces.

## 3. Review each axis in isolation

If your environment can run isolated sub-agents with fresh context, give each axis its own sub-agent in parallel, passing it the diff command, the commit list, and the axis brief below. Otherwise review one axis at a time, re-reading the diff for each and not carrying conclusions across.

**Spec brief.** Report (a) requirements missing or only partly done, (b) behavior nobody asked for (scope creep), and (c) requirements that look implemented but are implemented wrongly. Quote the spec line for each.

**Correctness brief.** Try to break the change: wrong results, unhandled edge cases (empty, null, boundary, duplicate, concurrent, retried), regressions in existing behavior, broken compatibility (public interfaces, persisted data, wire formats, config), error paths, and missing or weak tests. Prove each finding with a run against the real code, such as a failing test, a repro script, or command output that shows the wrong behavior. When a run is impractical, give the concrete failing path step by step with `file:line`. Label anything weaker as "unverified" and keep it separate. Leave out pure style.

**Standards brief.** Report each place the diff breaks a documented standard, citing the file and rule. Then check the smell baseline in [references/smells.md](references/smells.md). Smells are always judgement calls, and a documented repo standard overrides them.

## 4. Report

Present the axes under separate headings. Do not merge or re-rank findings across axes.

```text
## Spec
- <finding> — quoted requirement — where in the diff

## Correctness
- <finding> — proof: <command and output, or failing path with file:line>
Unverified:
- <suspicion> — what would confirm it

## Standards
- <finding> — rule or smell — hunk

Summary: <count per axis>; worst per axis: <one line each, or "none">
```

"No findings" is a valid result for any axis.
