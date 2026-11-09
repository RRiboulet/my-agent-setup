---
name: blast-radius
description: "Find what a change could break beyond its own diff, and prove the one fact it is safe because of by running real code. Use when: a change crosses a module boundary; alters a public function, type, API, schema, wire format, config key, or environment variable; touches persistence, caching, queues, retries, or concurrency; is expected to touch more than about five files; or the user asks 'what could this break' or for the blast radius. Skip for localized edits."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# Blast radius

Find what a change breaks somewhere else before it ships. Run it before editing to bound the work, or on a finished diff you do not trust yet.

Listing callers is not the job; a search does that in seconds. The job is the breakage a symbol search will not show, backed by proof rather than a convincing writeup. A writeup that sounds right reads the same whether or not it is true.

## Steps

1. **Pin the change.** Name the symbols, contracts, and behaviors it adds, changes, or removes, including what the code will now do differently that the diff does not spell out.
2. **Find the one fact it is safe because of.** Most risky-looking changes are safe because of a single fact, such as "this only drops cache entries that are already expired" or "every caller already passes a non-empty list". Find it. If it holds, most risks clear at once. Spend your effort here, not on a long list of maybes.
3. **Look where search stops.** Check each item that applies:
   - Callers and consumers in other packages, services, scripts, notebooks, and tests.
   - Public types, API contracts, CLI flags, and the error types callers branch on.
   - Persisted state: database columns, migrations, caches, files or messages written by an older version.
   - Wire formats: JSON shapes, events, and anything another service or language reads.
   - Config, environment variables, feature flags, and defaults.
   - Timing: ordering, concurrency, retries, teardown, lazy evaluation.
   - Dependencies: read the library source at its pinned version when behavior depends on it.
   - Operations: logs and metrics others alert on, rollout order, rollback.
4. **Rate each risk honestly.** For each: how it breaks, `file:line`, likelihood, and cost. Keep confirmed risks; list what you checked and cleared separately. A search that finds nothing is a valid answer. Never invent a caller or an API.
5. **Prove the one fact.** Write a small script or test that calls the real code and fails loudly if you are wrong. Run it and keep the output.

## How sure are you

Push each load-bearing fact as far down this ladder as is cheap, and say where it stopped:

1. **Asserted.** Worthless on its own.
2. **Pointed at.** A real `file:line`, or the library's source.
3. **Reasoned.** You walked the failure path step by step and it cannot reach.
4. **Ran.** A script or test against the real code.
5. **Reproduced.** Observed in the running system.

## Hand back

- **What changes**, including the non-obvious part.
- **Safe because**: the fact, the ladder level reached, and the proof, or "unproven".
- **Risks**: how each breaks, `file:line`, likelihood and cost, how to check.
- **Cleared**: what you checked and why it is fine.
- **Files**: likely to change, and inspected but not expected to change.
- **Validation**: the cheapest commands or tests that would catch the real bug, including any script you wrote.

Strip secrets and private data before the writeup goes anywhere shared.
