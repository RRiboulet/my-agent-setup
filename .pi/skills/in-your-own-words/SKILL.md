---
name: in-your-own-words
description: "Play back the user's goal, the observable success condition, scope, and risky assumptions before starting non-trivial work, so the right problem gets solved. Use when: a request changes behavior, spans several files or messages, is ambiguous, involves state transitions, retries, or migrations; before writing a spec, tickets, or a review; or when the user asks you to restate what they want."
---

<!-- Adapted from RRiboulet/agent-coding-skills; MIT notices for the underlying
     material are in licenses/. -->

# In your own words

The most expensive failure is correctly implementing the wrong interpretation. Play the task back before acting on it.

Skip this for trivial, unambiguous edits (a typo, a rename, a one-line config value).

## Write the playback

First read what the request depends on: earlier messages, the linked issue or spec, the code it names. Then write at most about ten plain lines:

1. **Goal.** What the user is trying to achieve and why. Name the problem, not only the solution they asked for.
2. **Done when.** The observable success condition: what someone can run, see, or measure afterwards.
3. **Out of scope.** What you will deliberately leave alone.
4. **Assumptions.** Each interpretation you chose that could change the implementation. Mark the risky ones.
5. **Touches.** The components or behaviors you expect to change.

## Then decide

- Every assumption is low risk and reversible: state them and proceed.
- An assumption could change behavior, persisted data, security, a public interface, or scope: ask before building on it. One focused question per risky assumption, each with your recommended answer.
- Never ask for a fact you can get by reading code, docs, or running a command. Facts are your job; decisions are the user's.
- The request is really several tasks: say so and propose an order.

The playback is the reference a review and `prove-it-works` check the result against, so keep it visible in the conversation or the spec.
