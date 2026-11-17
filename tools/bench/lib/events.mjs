// Parse and summarise the JSONL event stream produced by `pi --mode json`.
//
// The stream carries one session header plus session events, and every event is
// one JSON object on its own line. Only a few record types matter for a
// benchmark; the deltas (`message_update`, `toolcall_delta`, ...) are ignored on
// purpose because a run emits thousands of them and none carries a metric that
// `message_end`/`turn_end` does not.

/** Split a JSONL stream into records, keeping the line number in the error. */
export function parseJsonl(text) {
  const records = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return records;
}

/**
 * Parse a stream whose last line may have been cut off by a timeout kill. The
 * records before the cut are still the run's data; returning none of them
 * because of one missing brace would throw away the slowest cells.
 */
export function parseJsonlTolerant(text) {
  try {
    return { records: parseJsonl(text), truncated: false, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const lines = text.split("\n");
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    lines.pop();
    try {
      return { records: parseJsonl(lines.join("\n")), truncated: true, error };
    } catch {
      return { records: [], truncated: true, error };
    }
  }
}

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");

/**
 * Summarise one run. Tool calls and tool results are counted from
 * `message_end`: the assistant message carries the `toolCall` blocks, and the
 * toolResult message carries `durationMs`, `toolName` and `isError`.
 */
export function summarizeEvents(records) {
  const toolCalls = [];
  const toolResults = [];
  const toolDurations = Object.create(null);
  let tokens = 0;
  let cost = 0;
  let assistantMessages = 0;
  let turns = 0;
  let errors = 0;
  let aborted = false;
  let finalAnswer = "";

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (record.type === "turn_end") {
      turns++;
      continue;
    }
    if (record.type === "agent_settled") {
      aborted = Boolean(record.aborted);
      continue;
    }
    if (record.type !== "message_end") continue;

    const message = record.message;
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant") {
      assistantMessages++;
      const usage = message.usage ?? {};
      const total = Number(usage.totalTokens ?? 0);
      if (Number.isFinite(total)) tokens += total;
      const totalCost = Number(usage.cost?.total ?? 0);
      if (Number.isFinite(totalCost)) cost += totalCost;

      for (const block of message.content ?? []) {
        if (block?.type === "toolCall") {
          toolCalls.push({ name: block.name, arguments: block.arguments });
        }
      }
      const text = textOf(message);
      if (text.trim()) finalAnswer = text;
      continue;
    }

    if (message.role === "toolResult") {
      const durationMs = Number(message.durationMs ?? 0);
      const toolName = message.toolName ?? "unknown";
      const isError = Boolean(message.isError);
      toolResults.push({ toolName, durationMs, isError });
      toolDurations[toolName] = (toolDurations[toolName] ?? 0) + durationMs;
      if (isError) errors++;
    }
  }

  const toolCallsByName = Object.create(null);
  for (const call of toolCalls) toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;

  return {
    toolCalls,
    toolCallCount: toolCalls.length,
    toolCallsByName,
    toolResults,
    toolResultCount: toolResults.length,
    toolDurations,
    toolTimeMs: toolResults.reduce((sum, result) => sum + result.durationMs, 0),
    longestToolMs: toolResults.reduce((max, result) => Math.max(max, result.durationMs), 0),
    tokens,
    cost,
    assistantMessages,
    turns,
    errors,
    aborted,
    finalAnswer,
  };
}
