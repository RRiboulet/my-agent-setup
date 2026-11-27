# Standards baseline

Apply these only on top of the repository's documented standards. A documented repo rule always wins; where it endorses something below, suppress the smell. Every item here is a labelled judgement call ("possible Feature Envy"), never a hard violation. Skip anything a formatter, linter, or type checker already enforces.

## Code smells

From Martin Fowler, *Refactoring*, chapter 3. Each entry is what it is, then how to fix it.

- **Mysterious Name**: a name that does not reveal what the thing does or holds. Rename it; if no honest name comes, the design is murky.
- **Duplicated Code**: the same logic shape in more than one hunk or file. Extract the shared shape and call it from both.
- **Feature Envy**: a function that reaches into another object's data more than its own. Move it next to the data.
- **Data Clumps**: the same few fields or parameters keep travelling together. Bundle them into one type.
- **Primitive Obsession**: a primitive or string standing in for a domain concept. Give the concept its own small type.
- **Repeated Switches**: the same `switch` or `if` cascade on the same type in several places. Use polymorphism or one shared map.
- **Shotgun Surgery**: one logical change forces scattered edits across many files. Gather what changes together.
- **Divergent Change**: one module edited for several unrelated reasons. Split it so each part changes for one reason.
- **Speculative Generality**: abstractions, parameters, or hooks for needs the spec does not have. Delete them.
- **Message Chains**: long `a.b().c().d()` navigation the caller should not depend on. Hide the walk behind one call.
- **Middle Man**: a class or function that mostly delegates onward. Cut it and call the real target.
- **Refused Bequest**: a subclass that ignores or overrides most of what it inherits. Use composition instead.

## Subtraction

- Dead code, unused parameters, stale feature flags, or redundant validation the change could have removed.
- Guards, parsers, or validators beyond what the spec demands.
- A bigger diff than the problem needs. Prefer the smallest change that solves it.

## Comments and prose

- **Remove** comments that narrate what the next line obviously does, restate the name, or log the change history ("added X", "fixed bug").
- **Keep** comments that explain *why*: a non-obvious constraint, a workaround with its upstream reference, an invariant, units, or a security or performance reason.
- If a comment claims a constraint ("must be called before X"), prefer encoding it in types, assertions, or tests, and keep the comment only if that is impractical.
- Docs and messages should be plain and specific: no filler, hype, or vague claims ("robust", "seamless", "comprehensive") without evidence.
