# /btw Cache Parity Invariants

This document states the exact invariants that make the `/btw` side request reuse the main conversation's prompt cache. If any invariant is violated, the provider re-bills the full context (~590k–800k+ tokens on a warm session).

## Operational notes (not cache invariants)

- **Socket path length** — The per-session socket is `<agent dir>/tmux-btw-<full session id>.sock` (36-char id). tmux rejects unix socket paths past ~104 bytes, so a very long `PI_AGENT_DIR` breaks the panel with a confusing create error. Same exposure as the subagent socket (pre-existing pattern).
- **`resetPanel` clobbers a sibling's live panel** — Replacing unconditionally kills whatever is on the socket without an owner check, so a second pi's `/btw` for the same session id replaces its panel mid-answer. Deliberate: same session id means same user, and the owner-pid discipline guards reaping/shutdown, not replacement. The answer-file appender does check ownership and stops instead of interleaving.

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
   - A raw `modelRegistry.streamSimple` call skips the SDK's per-request client identity, so `runBtwRequest` adds the headers itself. Since pi 1.4.0 that identity lives in pi-ai (`pi-ai/dist/utils/identity.js`), and pi-coding-agent only decides whether the attribution is on at all (`dist/core/client-identity.js`). pi-ai derives `x-opencode-session` from the request's own `sessionId` — which this request already carries — so the header is set here as well, and the routing does not depend on that staying true.  
   - The telemetry attribution headers (OpenRouter / NVIDIA NIM) the main loop sends are reproduced too, gated on install telemetry the same way pi's `isInstallTelemetryEnabled` does (`PI_TELEMETRY` wins, then the settings flag). Cloudflare has no header of its own any more: pi 1.4.0 gives every provider its detailed `User-Agent` from the identity instead of the old `pi-coding-agent` one, so there is nothing left to mirror.

4. **Thinking level mirrored correctly**  
   The session's thinking level is forwarded as `reasoning`.  
   - `"off"` must be dropped to `undefined` — the literal string `"off"` makes the Anthropic adapter enable a 1024-token thinking budget the main request lacks.  
   - `reasoningOption()` handles this mapping.  
   - The level is the **resolved** session level (pi's `getThinkingLevel()`), not the projection's: `buildSessionContext` reads `"off"` when the branch carries no `thinking_level_change` entry, while the main request resolves through settings. A diverging `reasoning` can pin a different cache lineage.

4b. **Thinking budgets mirrored**  
   The main loop forwards `thinkingBudgets` from settings so the provider maps the thinking level through the same tables. Without them the side request would fall back to default budgets, which can differ on a setup with custom budgets.

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
- **Extension `before_provider_headers` handlers do not run** — pi's main path assembles headers through `transformHeaders` → the extension `before_provider_headers` event. `streamSimple` never runs that chain, so no handler fires on a side request — including the opencode-go provider's. `runBtwRequest` supplies the opencode session headers itself; any *other* extension that adds a routing-relevant header would break cache parity on side requests only.

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

Runtime smoke check: the answer footer prints `cache read N`. When an answer reports `cache read 0`, a warning is also notified (implementation in `appendFooter`) — but only when `input` is large enough that a cache read was clearly expected (≥ 20,000 tokens). A short session, or the first question after an idle gap, cold-starts with a small `input` that the footer already shows, and warning those would train the user to distrust the warning.