---
name: diagnosing-bugs
description: "Diagnosis discipline for bugs, failing tests, CI failures, crashes, flaky behavior, and performance regressions: build a tight red-capable feedback loop first, reproduce and minimise, test ranked hypotheses, then fix the root cause with a regression test. Use when: something is broken, throwing, failing, flaky, or slow; the user says diagnose or debug this; or an earlier fix attempt did not work."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Diagnosing bugs

Goal: a confirmed root cause and a fix at that cause, not a patched symptom. Skip a phase only when you can say why.

If the repository has a glossary, architecture notes, or ADRs for the area, read them first.

## Redact

You will show commands, outputs, and captured artifacts. Replace every secret with `<REDACTED>` first. Keep credentials in environment variables rather than in commands you show. Quote only the lines of a captured request or log that carry the signal.

## Phase 1: Build a feedback loop

**This is the skill.** With a tight pass/fail signal that goes red on *this* bug, bisection, hypothesis testing, and instrumentation are mechanical. Without one, reading code will not save you. Spend disproportionate effort here.

Ways to build one, roughly in order:

1. A failing test at whatever seam reaches the bug: unit, integration, or end to end.
2. An HTTP script against a running dev server.
3. A CLI invocation on a fixture input, diffing output against a known-good snapshot.
4. A headless browser script that drives the UI and asserts on DOM, console, or network.
5. A replay of a captured request, payload, or event log through the code path in isolation.
6. A throwaway harness that runs a minimal subset of the system with one function call.
7. A property or fuzz loop over many random inputs, for "sometimes wrong" bugs.
8. A bisection harness for "it used to work": automate the check so `git bisect run` can drive it.
9. A differential loop: the same input through old and new versions, or two configs, then diff.
10. Last resort, a human-in-the-loop script: copy and edit [scripts/hitl-loop.template.sh](scripts/hitl-loop.template.sh) so a person's clicks still produce structured output.

**Tighten it.** Make it faster (narrow the scope, skip unrelated setup), sharper (assert the specific symptom, not "didn't crash"), and deterministic (pin time, seed randomness, isolate the filesystem and network).

**Non-deterministic bugs.** Aim for a higher reproduction rate, not a clean repro: loop the trigger, parallelise, add stress, narrow timing windows. A 50% flake is debuggable; 1% is not.

**Cannot build a loop?** Stop and say so. List what you tried. Ask for access to an environment that reproduces it, a redacted captured artifact (logs, HAR, core dump, recording), or permission to add temporary instrumentation. Do not proceed on hypotheses alone.

**Done when** you can name one command, already run with its output shown, that is:

- [ ] **Red-capable**: drives the real code path and asserts the user's exact symptom.
- [ ] **Deterministic**: same verdict every run, or a pinned high rate for flaky bugs.
- [ ] **Fast**: seconds, not minutes.
- [ ] **Agent-runnable**: runs unattended, or through the human-in-the-loop script.

If you catch yourself building a theory before this command exists, stop. Jumping to a hypothesis is the failure this skill prevents.

## Phase 2: Reproduce and minimise

- [ ] The loop shows the failure the **user** described, not a nearby different one. Wrong bug, wrong fix.
- [ ] It reproduces across runs, or at a debuggable rate.
- [ ] You captured the exact symptom: error, wrong output, or timing.

Then shrink the scenario. Cut inputs, callers, config, data, and steps one at a time, re-running after each cut. Done when every remaining element is load-bearing. A minimal repro shrinks the hypothesis space and becomes the regression test.

## Phase 3: Hypothesise

Write 3 to 5 ranked, falsifiable hypotheses before testing any of them. A single hypothesis anchors on the first plausible idea.

> If X is the cause, then changing Y will make the bug disappear, and changing Z will make it worse.

A hypothesis without a prediction is a vibe; sharpen or drop it. Show the ranked list to the user if they are present, since domain knowledge often re-ranks it instantly, but do not block on a reply.

Ask *why* at each step until the answer is a wrong decision in the code, not a consequence of an earlier one. When something fails only after a restart, suspect persisted state first: config, caches, lock files, serialized data.

## Phase 4: Instrument

Each probe tests one prediction. Change one variable at a time.

1. Prefer a debugger or REPL; one breakpoint beats ten log lines.
2. Otherwise add targeted logs at the boundaries that separate hypotheses. Never "log everything and grep".
3. Tag every temporary log with a unique prefix such as `[DEBUG-a4f2]` so cleanup is one search.

For performance regressions, measure instead of logging: take a baseline with a timing harness or profiler, then bisect. Load the `benchmark-checklist` skill before trusting or reporting a number.

## Phase 5: Fix at the root cause

The root cause is the first place the system did something it should not, or failed to handle a state it should handle. Decide whether the triggering state is legitimate:

- **Legitimate state**: the code that broke on it is the root cause; handle the state there.
- **State that should never exist**: a check where it surfaced hides the bug. Find what produced it.

Guards, retries, sleeps, swallowed exceptions, clamped values, and special-casing the test input are the usual ways to hide a bug. A workaround that needs a paragraph of comment to justify it means the code is wrong.

Write the regression test before the fix, at a **correct seam**: one where the test exercises the real bug pattern as it happens at the call site. If only a too-shallow seam exists, note that as a finding rather than writing a test that gives false confidence. Then:

1. Turn the minimised repro into a failing test at that seam and watch it fail.
2. Apply the smallest fix at the root cause.
3. Watch the test pass, then re-run the original, un-minimised Phase 1 loop.
4. Search for the same faulty pattern elsewhere and fix every instance.

## Phase 6: Clean up

- [ ] The original repro no longer reproduces.
- [ ] The regression test passes, or the missing seam is documented.
- [ ] All tagged debug instrumentation is removed (search for the prefix).
- [ ] Throwaway harnesses are deleted or moved somewhere clearly marked.
- [ ] The confirmed hypothesis is stated in the commit or PR message.
- [ ] If the deciding fact took a deep dig, propose the cheap, always-on signal (log, metric, assertion) that would have shown it at first look.

## Stuck

After a few disciplined attempts without a confirmed cause, stop. Report what you ruled out, the remaining hypotheses, and the evidence. Do not ship a guess, and revert failed experiments rather than stacking them.
