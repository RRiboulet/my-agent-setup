---
name: architect
description: "Design the shape of a change before coding: sketch two distinct interfaces, cut pass-throughs, keep one owner per state. Use when: designing a module or feature, reshaping a boundary, or choosing between abstractions."
---

# Architect

Settle the shape of a change before writing code so complexity shrinks instead of spreading. The output is a sketch — types, seams, and state ownership — not a working implementation.

## 1. Map what the change touches

- Trace every caller, data store, and module boundary the change crosses, and name what the code will do differently that the request does not spell out.
- If the change alters a public contract, schema, persistence format, or cross-service boundary, load the `blast-radius` skill before sketching: a shape chosen without knowing consumers is a guess.
- If the goal itself is still unsettled, load the `in-your-own-words` skill first.

## 2. Sketch two distinct shapes

Draw **two genuinely different designs** — different ownership, types, or seams, not minor renamings of the same idea. For each, write only:

- Public types or signatures callers see.
- Which module owns each piece of mutable state.
- What disappears or simplifies.

Prefer the shape that hides more behavior behind a smaller interface — capability concentrated in one place beats the same capability spread across layers. That interface is also the seam where tests belong (when you later load the `tdd` skill). Prefer the design where a change that looks right from one file is right for the whole repository.

## 3. Apply the boundary tests

Evaluate both shapes against four rules:

- **Deletion test**: imagine deleting each proposed wrapper, helper, or layer. If complexity drops, it is a pass-through — cut it. If it reappears at every call site, it was earning its keep.
- **Single owner**: each mutable state has one owner; each task has one supported way.
- **Minimal caller knowledge**: callers talk to one small entry point and never need internal rules to use it correctly.
- **Replace, do not layer**: prefer migrating callers and deleting the old path over adding compatibility shims. One adapter is a hypothetical seam; two make it real.

## 4. Pick or escalate

- Pick the simpler shape and explain in 2–4 lines why the alternative lost.
- If both shapes carry real product or irreversible architectural tradeoffs, load the `grilling` skill to settle the decision with the user before coding.

## 5. When the sketch keeps costing

If building against the sketch keeps producing friction, redesign the boundary instead of adding another guard. Watch for a pattern:

- The same workaround appearing across unrelated code.
- Edge cases piling up, each needing its own branch.
- Escape hatches (`any`, casts, optional fields always set in practice) or new locks where state was meant to be unshared.
- Callers needing to know internal rules.

Throw out the sketch and re-sketch from the new constraints, subtracting before adding.

## Hand back

- **The shape**, in the calling code's terms: usage first, then public types and signatures (or a module map for large changes).
- **Why the alternative lost**, in 2–4 lines.
- **What is unproven**, and which load-bearing assumption would sink it.
- **The next step**: load the `tdd` skill for the first behavior, or run `/implement` when the work spans several units.
