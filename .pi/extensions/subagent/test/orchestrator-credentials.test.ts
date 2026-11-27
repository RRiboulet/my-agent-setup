import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PROVIDER_ENV_VARS,
	authSourceFromRegistry,
	credentialFix,
	providerEnvVar,
} from "../../orchestrator/credentials.ts";

test("authSourceFromRegistry returns configured registry status and prefers it over env vars", () => {
	const registry = {
		getProviderAuthStatus: () => ({ configured: true, source: "auth.json", label: "stored-key" }),
	};
	const auth = authSourceFromRegistry(registry, { OPENROUTER_API_KEY: "env-key" });
	assert.deepEqual(auth("openrouter"), {
		configured: true,
		source: "auth.json",
		label: "stored-key",
	});
});

test("authSourceFromRegistry falls back to live env vars when registry is unconfigured or throws", () => {
	const unconfigured = authSourceFromRegistry(
		{ getProviderAuthStatus: () => ({ configured: false }) },
		{ OPENCODE_API_KEY: "secret" },
	);
	assert.deepEqual(unconfigured("opencode-go"), {
		configured: true,
		source: "environment",
		label: "OPENCODE_API_KEY",
	});
	assert.deepEqual(unconfigured("opencode"), {
		configured: true,
		source: "environment",
		label: "OPENCODE_API_KEY",
	});

	const throwing = authSourceFromRegistry(
		{
			getProviderAuthStatus: () => {
				throw new Error("boom");
			},
		},
		{ CUSTOM_PROVIDER_API_KEY: "token" },
	);
	assert.deepEqual(throwing("custom-provider"), {
		configured: true,
		source: "environment",
		label: "CUSTOM_PROVIDER_API_KEY",
	});

	const noMethod = authSourceFromRegistry({}, { OPENROUTER_API_KEY: "or-key" });
	assert.deepEqual(noMethod("openrouter"), {
		configured: true,
		source: "environment",
		label: "OPENROUTER_API_KEY",
	});
});

test("authSourceFromRegistry treats missing credentials and blank env vars accurately", () => {
	const missing = authSourceFromRegistry(
		{ getProviderAuthStatus: () => ({ configured: false }) },
		{ OPENROUTER_API_KEY: "   " },
	);
	assert.deepEqual(missing("openrouter"), { configured: false });

	const unknown = authSourceFromRegistry(
		{
			getProviderAuthStatus: () => {
				throw new Error("unavailable");
			},
		},
		{},
	);
	assert.equal(unknown("openrouter"), undefined);
	assert.equal(authSourceFromRegistry({}, {})("openrouter"), undefined);
});

test("PROVIDER_ENV_VARS and providerEnvVar resolve known and custom providers", () => {
	assert.equal(PROVIDER_ENV_VARS["opencode-go"], "OPENCODE_API_KEY");
	assert.equal(providerEnvVar("openrouter"), "OPENROUTER_API_KEY");
	assert.equal(providerEnvVar("opencode"), "OPENCODE_API_KEY");
	assert.equal(providerEnvVar("opencode-go"), "OPENCODE_API_KEY");
	assert.equal(providerEnvVar("my-custom.provider"), "MY_CUSTOM_PROVIDER_API_KEY");
});

test("credentialFix names the resolved env var, /login, and auth.json", () => {
	const known = credentialFix("opencode-go");
	assert.match(known, /set OPENCODE_API_KEY/);
	assert.match(known, /run \/login for opencode-go/);
	assert.match(known, /auth\.json/);

	const unknown = credentialFix("acme-ai");
	assert.match(unknown, /set ACME_AI_API_KEY/);
	assert.match(unknown, /run \/login for acme-ai/);
	assert.match(unknown, /auth\.json/);
});
