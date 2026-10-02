// Behaviour tests for the vendored /answer extension's question extraction.
//
// The extension used to call `complete()` from pi-ai, an export pi 1.0 removed;
// jiti's CJS interop deferred the failure to the moment /answer ran. Extraction
// now goes through `ctx.modelRegistry.streamSimple()`, so these tests drive it
// with a fake ModelRegistry that returns a canned event stream, exactly the way
// the runtime would.
//
// Risk covered: a nested model call that does not resolve to a final
// AssistantMessage, or that loses the aborted/error stop reasons, silently
// breaks /answer with no other signal.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { extractQuestions } from "../../answer.ts";

const MODEL = { provider: "openrouter", id: "test/model", api: "openai-completions" };

function assistantMessage(stopReason: string, text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "openrouter",
		model: "test/model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

/** A ModelRegistry whose streamSimple replays `deltas` and then terminates the stream. */
function fakeRegistry(deltas: string[], final: AssistantMessage) {
	const calls: unknown[] = [];
	return {
		calls,
		registry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			streamSimple: (model: unknown, context: unknown, options: unknown) => {
				calls.push({ model, context, options });
				const stream = createAssistantMessageEventStream();
				const message = assistantMessage(final.stopReason, "", final.errorMessage);
				for (const delta of deltas) {
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
				}
				// The runtime terminates a successful stream with "done".
				if (final.stopReason === "stop") {
					stream.push({ type: "done", reason: "stop", message: final });
				} else {
					stream.push({ type: "error", reason: final.stopReason, error: final });
				}
				return stream;
			},
		},
	};
}

async function run(deltas: string[], final: AssistantMessage) {
	const { registry, calls } = fakeRegistry(deltas, final);
	const outcome = await extractQuestions(MODEL as never, registry as never, "some assistant text", new AbortController().signal);
	return { outcome, calls };
}

test("extractQuestions parses questions from a streamed answer", async () => {
	const json = '{"questions":[{"question":"Which database?","context":"MySQL and PostgreSQL only."},{"question":"TypeScript or JavaScript?"}]}';
	const { outcome, calls } = await run([json.slice(0, 40), json.slice(40)], assistantMessage("stop", json));

	assert.deepEqual(outcome, {
		status: "ok",
		result: {
			questions: [
				{ question: "Which database?", context: "MySQL and PostgreSQL only." },
				{ question: "TypeScript or JavaScript?" },
			],
		},
	});

	// The nested call must go through streamSimple with the session model,
	// the extraction system prompt and the loader's abort signal.
	assert.equal(calls.length, 1);
	const call = calls[0] as { model: unknown; context: { systemPrompt: string; messages: { role: string }[] }; options: { apiKey?: string } };
	assert.equal(call.model, MODEL);
	assert.match(call.context.systemPrompt, /question extractor/);
	assert.deepEqual(
		call.context.messages.map((m) => m.role),
		["user"],
	);
	assert.equal(call.options.apiKey, "test-key");
});

test("extractQuestions repairs a JSON response wrapped in a code fence", async () => {
	const json = '```json\n{"questions":[{"question":"Ship it?"}]}\n```';
	const { outcome } = await run([json], assistantMessage("stop", json));

	assert.deepEqual(outcome, { status: "ok", result: { questions: [{ question: "Ship it?" }] } });
});

test("extractQuestions reports an aborted stream as cancelled", async () => {
	const { outcome } = await run(["partial"], assistantMessage("aborted", "partial"));

	assert.deepEqual(outcome, { status: "cancelled" });
});

test("extractQuestions surfaces the error message of a failed stream", async () => {
	const { outcome } = await run([], assistantMessage("error", "", "429 rate limited"));

	assert.deepEqual(outcome, { status: "error", message: "429 rate limited" });
});

test("extractQuestions reports invalid JSON", async () => {
	const { outcome } = await run(["not json at all"], assistantMessage("stop", "not json at all"));

	assert.deepEqual(outcome, { status: "error", message: "question extraction returned invalid JSON" });
});

test("extractQuestions reports missing credentials without calling the model", async () => {
	let called = false;
	const registry = {
		getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key for provider: openrouter" }),
		streamSimple: () => {
			called = true;
			return createAssistantMessageEventStream();
		},
	};

	const outcome = await extractQuestions(MODEL as never, registry as never, "text", new AbortController().signal);

	assert.deepEqual(outcome, { status: "error", message: "No API key for provider: openrouter" });
	assert.equal(called, false);
});