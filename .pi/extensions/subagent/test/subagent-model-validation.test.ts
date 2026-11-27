// Pre-spawn (provider, model) and credential validation for the `subagent` tool.
//
// Risk covered: passing an unknown model or a provider with no configured
// credentials used to spawn a detached tmux session that immediately exited
// with the opaque "Child Pi exited before reporting a result". Failing fast at
// the tool boundary prevents orphan run dirs and tmux spawns and surfaces an
// actionable error, while remaining safe when test doubles omit `modelRegistry`
// or auth methods.

import assert from "node:assert/strict";
import { test } from "node:test";

import { withHarness } from "./lifecycle-harness.ts";

test("subagent rejects an unknown explicit model before spawning tmux", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: () => undefined,
		};

		await assert.rejects(
			() => h.call("subagent", { task: "check model", provider: "anthropic", model: "no-such-model" }),
			/anthropic\/no-such-model/,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
		assert.match((await h.call("subagent_status", {})).text, /No subagent runs/);
	});
});

test("subagent rejects missing credentials via getApiKeyAndHeaders before spawning tmux", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			getApiKeyAndHeaders: async (model: { provider: string }) => ({
				ok: false,
				error: `No API key found for "${model.provider}"`,
			}),
		};

		await assert.rejects(
			() => h.call("subagent", { task: "check auth", provider: "anthropic", model: "claude-sonnet-4-5" }),
			/anthropic\/claude-sonnet-4-5.*No API key found/i,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
		assert.match((await h.call("subagent_status", {})).text, /No subagent runs/);
	});
});

test("subagent rejects missing credentials via getApiKeyForProvider before spawning tmux", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			getApiKeyForProvider: async () => undefined,
		};

		await assert.rejects(
			() => h.call("subagent", { task: "check auth", provider: "openai", model: "gpt-5" }),
			/No credentials configured.*openai/i,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
	});
});

test("subagent allows no-auth local providers and minimal mocked registries without auth methods", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
		};
		const local = await h.call("subagent", { task: "local provider", provider: "ollama", model: "llama3" });
		assert.match(local.text, /started/);

		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
		};
		const minimal = await h.call("subagent", { task: "minimal registry", provider: "openrouter", model: "x/y" });
		assert.match(minimal.text, /started/);

		h.ctx.modelRegistry = {};
		const inherited = await h.call("subagent", { task: "inherited without methods" });
		assert.match(inherited.text, /started/);
	});
});

test("subagent tasks plan rejects invalid model or auth on any step before creating plan or spawning step 1", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => (id === "missing-model" ? undefined : { provider, id }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		};

		await assert.rejects(
			() =>
				h.call("subagent", {
					tasks: [
						{ id: "ok-step", task: "valid", provider: "openrouter", model: "valid-model" },
						{ id: "bad-step", task: "invalid", provider: "openrouter", model: "missing-model" },
					],
				}),
			/openrouter\/missing-model/,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
		assert.deepEqual(await h.readPlans(), []);
		assert.match((await h.call("subagent_status", {})).text, /No subagent runs/);
	});
});

test("subagent rejects unconfigured built-in provider when hasConfiguredAuth is false even if getApiKeyAndHeaders returns ok: true", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => false,
			getApiKeyAndHeaders: async () => ({ ok: true, headers: undefined }),
		};

		await assert.rejects(
			() => h.call("subagent", { task: "check pi 1.6.0 built-in auth", provider: "openai", model: "gpt-5" }),
			/No credentials configured.*openai/i,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
		assert.match((await h.call("subagent_status", {})).text, /No subagent runs/);
	});
});

test("subagent rejects configured provider whose getApiKeyAndHeaders fails (e.g. expired token) before spawning tmux", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "expired token" }),
		};

		await assert.rejects(
			() => h.call("subagent", { task: "check expired token", provider: "anthropic", model: "claude-sonnet-4-5" }),
			/anthropic\/claude-sonnet-4-5.*expired token/i,
		);

		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 0);
		assert.match((await h.call("subagent_status", {})).text, /No subagent runs/);
	});
});

test("subagent succeeds when hasConfiguredAuth is true and getApiKeyAndHeaders returns ok: true with apiKey", async () => {
	await withHarness(undefined, async (h) => {
		h.ctx.modelRegistry = {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-123" }),
		};

		const started = await h.call("subagent", {
			task: "check configured provider",
			provider: "openrouter",
			model: "anthropic/claude-sonnet-4-5",
		});
		assert.match(started.text, /started/);
		assert.equal(h.execCalls.filter((call) => call.args.includes("new-session")).length, 1);
	});
});
