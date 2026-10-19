# /btw Cache Parity Invariants

This document states the exact invariants that make the `/btw` side request reuse the main conversation's prompt cache. If any invariant is violated, the provider re-bills the full context (~590k–800k+ tokens on a warm session).

## Invariants

1. **Same context projection**  
   The request uses `buildSessionContext(entries, leafId)` → `convertToLlm()` — the exact projection the main loop sends.  
   - `leafId: null` normalizes to `undefined` ("the current leaf"), never an empty path.
   - No `systemPrompt` or `tools` override is passed — they would prepend a different leading system message and break the cache.

2. **No `toolChoice`**  
   The request deliberately omits `toolChoice`. Setting it (even to `"none"`) invalidates the provider's message-block cache.  
   - Measured on a warm ~800k session: with `toolChoice: "none"` → 808,589 input tokens / 0 cache read; without it → 79 input / 813,184 cache read.  
   - r2b re-check: 955 input / 895,488 cache read.  
   - Continuation after a tool call: 80,073 input / 1,768,704 cache read.  
   - Tools stay declared for prefix parity; the `BTW_INSTRUCTION` user message asks the model not to use them.

3. **Session routing header**  
   `x-opencode-session` (and `x-opencode-client: "pi"`) are sent with the **main** session id.  
   - opencode-go refuses requests without this header (`MissingSessionID`).  
   - It is also what pins the prompt-cache lineage to the main conversation.  
   - A raw `modelRegistry.streamSimple` call skips pi's `mergeProviderAttributionHeaders` transform, so `runBtwRequest` adds the headers itself.

4. **Thinking level mirrored correctly**  
   The session's thinking level is forwarded as `reasoning`.  
   - `"off"` must be dropped to `undefined` — the literal string `"off"` makes the Anthropic adapter enable a 1024-token thinking budget the main request lacks.  
   - `reasoningOption()` handles this mapping.

5. **Image blocking mirrored**  
   When `images.blockImages` is on, the request applies the same `convertToLlmWithBlockImages` filter as the main loop (consecutive placeholders collapse to one).

6. **Tool-call continuation (one retry, same prefix)**  
   If the model calls a tool:
   - The assistant message is kept.
   - A synthetic `toolResult` refusal is appended per call (`TOOL_REFUSAL` text).
   - The request is retried **once** with the **same prefix** (attempt 1's messages unchanged, then the assistant message + tool results).
   - Usage from both attempts is summed.
   - A second tool-calling response is reported with its usage and ignored call count — no loop.

## Caveats (where cache parity cannot hold)

- **`transformContext` divergence** — The agent loop applies extension `context` handlers, the hidden-declarations projection, and (for active `/goal`) a forced system prompt **before** streaming. No extension API runs that chain. The side request matches a session without context-rewriting state; on a session with an active `/goal` the forced system prompt differs at byte 0, so the cache misses and the conversation is re-billed, and goal UI messages the main request strips are visible to the side model.
- **Idle gap** — The provider's cache only stays warm for a few minutes of idle time. The first question after a gap pays full price once (and warms the cache for the next main turn).
- **Provider behavior not publicly documented** — The numbers above are measured against opencode-go (Anthropic-compatible). They depend on internal cache keying that is not guaranteed by any public spec.

## Measured numbers (opencode-go, warm ~800k session)

| Scenario | Input | Cache Read | Output |
|---|---|---|---|
| With `toolChoice: "none"` (broken) | 808,589 | 0 | — |
| Without `toolChoice` (fixed) | 79 | 813,184 | — |
| r2b re-check | 955 | 895,488 | 2,581 |
| Continuation after 1 tool call | 80,073 | 1,768,704 | 7,451 |

## Reproduction

```bash
# 1. Start a pi session and let it accumulate ~800k tokens of context
#    (or copy a warm session file into ~/.pi/agent/sessions/).

# 2. Run a side question:
/btw why does the cache matter?

# 3. Watch the answer footer:
---
input 79 · cache read 813,184 · output 42
```

The `cache read` number must be non-zero and large (hundreds of thousands). If it reads `0`, the cache parity invariants are broken.

## Check that fails loudly if cache-read drops to zero

A structural test in `.pi/extensions/subagent/test/btw-request.test.ts` asserts the request shape:

```typescript
assert.equal(sent.options["toolChoice"], undefined, "tool_choice would invalidate the message cache");
assert.equal(sent.options["sessionId"], SESSION_ID, "session affinity uses the main session id");
const headers = sent.options["headers"] as Record<string, string>;
assert.equal(headers["x-opencode-session"], SESSION_ID, "the request carries the main session id");
assert.deepEqual(
  sent.context.messages.slice(0, -1),
  buildBtwContext(ENTRIES, "cm1", "why?").messages.slice(0, -1),
  "the prefix is the converted projection",
);
```

These assertions fail if:
- `toolChoice` is ever set,
- `x-opencode-session` header is missing or points to the wrong session,
- the context prefix diverges from `convertToLlm(buildSessionContext(...))`.

Runtime smoke check: the answer footer prints `cache read N`. A warning is logged if `N === 0` on a warm session (implementation in `appendFooter` / `runBtwRequest`).