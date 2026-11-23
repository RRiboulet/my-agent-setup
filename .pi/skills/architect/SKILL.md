---
name: architect
description: "Settle a change's shape before code: sketch two distinct designs, test them on deletion and single-owner, then pick or escalate. Use when: designing a module or feature; reshaping a boundary; workarounds keep returning; or two abstractions compete."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Architect

Settle the shape of a change before code, so complexity shrinks instead of spreading. The output is a sketch — types, seams, and who owns what — not a working implementation.

## Map what the change touches

Trace every caller, data store, and module boundary the change crosses, and name what the code will do differently that the request does not spell out.

If it alters a public contract, schema, persisted format, or cross-service boundary, load `blast-radius` before sketching: a shape chosen without knowing the consumers is a guess. This skill begins once the goal is settled — `in-your-own-words` plays the goal back, and the question left open here is how to shape it.

## Sketch two distinct shapes

Two genuinely different designs: different ownership, different seams, different types. Not one idea with its name changed. The second one is the point, because the first is whatever the nearest example already suggested.

For each, write only:

- The public types or signatures a caller sees.
- Which module owns each piece of mutable state.
- What disappears, or gets simpler.

Prefer the shape that hides more behaviour behind a smaller interface — capability concentrated in one place beats the same capability spread across layers. That interface is also the seam: the place where behaviour can be altered without editing there, which is the same boundary `tdd` will put its tests on.

Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repository.

## Apply the boundary tests

- **Deletion test.** Imagine deleting each proposed wrapper, helper, and layer in turn. If complexity drops, it was a pass-through: cut it. If it reappears at every call site, it was earning its keep.
- **Single owner.** Each piece of mutable state has one owner, and each task has one supported way to be done.
- **Minimal caller knowledge.** Callers go through one small entry point; they never need the internals' rules to use it correctly.
- **Replace, do not layer.** Prefer migrating callers and deleting the old path over adding a compatibility shim. One adapter is a hypothetical seam; two make it real.

## Pick or escalate

Pick the simpler shape and say in two to four lines why the other lost. That rationale is a deliverable as much as the sketch is: it is what a later reader checks the code against.

If both shapes carry real product or irreversible architectural tradeoffs, the decision is the user's. Load `grilling` and settle it with them before coding, rather than choosing quietly and building on a guess.

## When the sketch keeps costing

If building against the sketch keeps producing friction, redesign the boundary instead of adding another guard. The signal is a pattern, not one instance:

- The same shape of workaround appearing across unrelated code.
- Edge case after edge case, each needing its own branch.
- Escape hatches to make it compile: `any`, casts, optional fields always set in practice.
- A "we need a lock" reflex where the sketch said the state was not shared.
- Callers having to know the abstraction's internal rules to use it.

A few edge cases condemn nothing, and complexity in the data is not complexity in the design: a genuinely hard problem stays hard. When the pattern is real, throw the sketch out and sketch again from the new constraints as if they had been day-one assumptions. Subtract before adding, so the second sketch is smaller than the first before it grows.

## Hand back

- **The shape**, in the calling code's terms: usage first, then the types derived from it. One file of types and signatures for a small change; a module map for a large one.
- **Why the alternative lost**, in two to four lines.
- **What is unproven**, and which load-bearing assumption would sink it.
- **The next step**: `tdd` for the first behavior, `implement` when the work spans several units.
