// Pins native-web-search's script lookup, and guards the bug in it.
//
// Before this test, resolveScriptPath probed `here/../../skills/...` — `here`
// is the extensions dir (`.pi/extensions`), so that resolved to `<repo>/skills`,
// but the script actually lives at `<repo>/.pi/skills`, so the candidate could
// never exist and the failure message advertised a path that cannot. The `.pi`
// is the whole reason a git-sourced pi package is discoverable at all.
//
// The candidate list is derived by `scriptCandidates(here, cwd)`, so the test
// can pin it (and the `.pi` fix) against fixture paths without depending on
// where this file happens to live on disk.
//
// It also covers the vendored script itself (`search.mjs`): provider resolution,
// the Go endpoint, the session headers and the temperature rule. The script
// exports `__test__` and guards its `main()`, so importing it here does not run
// a search.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { __test__ } from "../../native-web-search.ts";
import { __test__ as script } from "../../../skills/native-web-search/search.mjs";

const { resolveScriptPath, scriptCandidates, resolveProvider, resolveModel, buildSearchArgs } = __test__;
const {
	normalizeProvider,
	pickProvider,
	defaultModelId,
	defaultBaseUrl,
	supportsTemperature,
	opencodeGoHeaders,
	buildAnthropicHeaders,
	buildAnthropicRequest,
	resolveApiKey,
} = script;

function restoreEnv(saved: string | undefined): void {
	if (saved === undefined) delete process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	else process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = saved;
}

function withEnvVars(vars: Record<string, string | undefined>, run: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(vars)) {
		saved.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		run();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("the extension leaves provider choice to the script when nothing is set", () => {
	// Deliberately NOT a concrete provider: forcing one here would make the
	// script's settings.defaultProvider/auth.json resolution unreachable and
	// break a machine whose only credential is not opencode-go.
	assert.equal(resolveProvider(undefined), undefined);
});

test("the tool omits --provider when none is set and forwards it when it is", () => {
	const base = { script: "/s.mjs", query: "q", timeoutMs: 1000 };
	assert.deepEqual(buildSearchArgs(base), ["/s.mjs", "q", "--json", "--timeout", "1000"]);
	assert.deepEqual(
		buildSearchArgs({ ...base, provider: "anthropic", purpose: "why", model: "m" }),
		["/s.mjs", "q", "--json", "--timeout", "1000", "--provider", "anthropic", "--purpose", "why", "--model", "m"],
	);
});

test("no model is sent unless explicitly requested, so the script default applies", () => {
	withEnvVars({ PI_WEB_SEARCH_MODEL: undefined }, () => {
		assert.equal(resolveModel(undefined), undefined);
	});
	withEnvVars({ PI_WEB_SEARCH_MODEL: "claude-haiku-5-5" }, () => {
		assert.equal(resolveModel(undefined), "claude-haiku-5-5");
		assert.equal(resolveModel("openai/gpt-4o-mini:online"), "openai/gpt-4o-mini:online");
	});
});

// --- the script itself: provider resolution, endpoint and request shape ---

test("normalizeProvider matches exact provider ids before substrings", () => {
	assert.equal(normalizeProvider("opencode-go"), "opencode-go");
	assert.equal(normalizeProvider("opencode"), "opencode-go");
	assert.equal(normalizeProvider("openrouter"), "openrouter");
	assert.equal(normalizeProvider("openai"), "openai-codex");
	assert.equal(normalizeProvider("anthropic"), "anthropic");
	assert.equal(normalizeProvider("claude-haiku-5-5"), "anthropic");
	assert.equal(normalizeProvider("nope"), undefined);
});

test("pickProvider follows flag > env > settings > auth, preferring opencode-go", () => {
	const opencode = { type: "api_key", key: "a" };
	const openrouter = { type: "api_key", key: "b" };
	withEnvVars({ OPENCODE_API_KEY: undefined, PI_WEB_SEARCH_PROVIDER: undefined }, () => {
		assert.equal(pickProvider(undefined, {}, { "opencode-go": opencode, openrouter }), "opencode-go");
		assert.equal(pickProvider(undefined, {}, { openrouter }), "openrouter");
		assert.equal(pickProvider("anthropic", { defaultProvider: "openrouter" }, { openrouter }), "anthropic");
		assert.equal(pickProvider(undefined, { defaultProvider: "openai-codex" }, { openrouter }), "openai-codex");
	});
	withEnvVars({ PI_WEB_SEARCH_PROVIDER: "anthropic", OPENCODE_API_KEY: undefined }, () => {
		assert.equal(pickProvider(undefined, { defaultProvider: "openrouter" }, { openrouter }), "anthropic");
	});
	withEnvVars({ PI_WEB_SEARCH_PROVIDER: undefined, OPENCODE_API_KEY: "env-key" }, () => {
		assert.equal(pickProvider(undefined, {}, { openrouter }), "opencode-go");
	});
});

test("pickProvider rejects an unrecognized provider instead of silently falling through", () => {
	withEnvVars({ OPENCODE_API_KEY: undefined, PI_WEB_SEARCH_PROVIDER: undefined }, () => {
		assert.throws(() => pickProvider("opnrouter", {}, { openrouter: { type: "api_key", key: "b" } }), /Unknown provider/);
	});
	withEnvVars({ PI_WEB_SEARCH_PROVIDER: "opnrouter", OPENCODE_API_KEY: undefined }, () => {
		assert.throws(() => pickProvider(undefined, {}, {}), /PI_WEB_SEARCH_PROVIDER/);
	});
});

test("the Go plan's search model, endpoint and temperature rule are pinned", () => {
	assert.equal(defaultModelId("opencode-go"), "claude-haiku-5-5");
	assert.equal(defaultBaseUrl("opencode-go"), "https://opencode.ai/zen/go");
	assert.equal(supportsTemperature("claude-haiku-5-5"), false);
	assert.equal(supportsTemperature("claude-haiku-4-5"), true);
});

test("opencodeGoHeaders sends the two session headers the Go API requires", () => {
	const headers = opencodeGoHeaders();
	assert.match(headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
	assert.equal(headers["x-opencode-client"], "pi-native-web-search");
});

test("the Go request carries the session headers and omits temperature", () => {
	const { endpoint, headers, body } = buildAnthropicRequest({
		model: "claude-haiku-5-5",
		apiKey: "test-key",
		query: "q",
		purpose: "p",
		baseUrl: defaultBaseUrl("opencode-go"),
		extraHeaders: opencodeGoHeaders(),
		omitTemperature: true,
	});
	assert.equal(endpoint, "https://opencode.ai/zen/go/v1/messages");
	assert.equal(headers["x-opencode-client"], "pi-native-web-search");
	assert.match(headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
	assert.equal(headers["x-api-key"], "test-key");
	assert.equal(body.model, "claude-haiku-5-5");
	assert.equal("temperature" in body, false);
	assert.equal(body.tools[0].type, "web_search_20250305");
});

test("temperature is omitted for the whole Go path and kept for the direct default", () => {
	const goBody = (model) =>
		buildAnthropicRequest({
			model,
			apiKey: "k",
			query: "q",
			purpose: "p",
			baseUrl: defaultBaseUrl("opencode-go"),
			omitTemperature: true,
		}).body;
	// The search model and a non-search Go model alike: the endpoint rejected
	// temperature for the search model, so omitting it for all of them is safe.
	assert.equal("temperature" in goBody("claude-haiku-5-5"), false);
	assert.equal("temperature" in goBody("qwen3.8-max"), false);

	const directDefault = buildAnthropicRequest({ model: "claude-haiku-4-5", apiKey: "k", query: "q", purpose: "p" }).body;
	assert.equal(directDefault.temperature, 0);
	// A model known to reject temperature omits it on the direct API too.
	const directNew = buildAnthropicRequest({ model: "claude-haiku-5-5", apiKey: "k", query: "q", purpose: "p" }).body;
	assert.equal("temperature" in directNew, false);
});

test("provider headers cannot clobber authentication", () => {
	const evil = { "x-api-key": "evil", authorization: "Bearer evil" };
	assert.equal(buildAnthropicHeaders("real-key", evil)["x-api-key"], "real-key");
	assert.equal(buildAnthropicHeaders("sk-ant-oat-real", evil).authorization, "Bearer sk-ant-oat-real");
});

test("the API key resolves from auth.json before OPENCODE_API_KEY", async () => {
	const saved = process.env.OPENCODE_API_KEY;
	process.env.OPENCODE_API_KEY = "env-key";
	try {
		assert.equal((await resolveApiKey("opencode-go", {}, "/nonexistent/auth.json", {})).apiKey, "env-key");
		assert.equal(
			(
				await resolveApiKey(
					"opencode-go",
					{ "opencode-go": { type: "api_key", key: "auth-key" } },
					"/nonexistent/auth.json",
					{},
				)
			).apiKey,
			"auth-key",
		);
	} finally {
		if (saved === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = saved;
	}
});

test("the script still runs when invoked through a symlink", () => {
	const root = mkdtempSync(join(tmpdir(), "nws-link-"));
	try {
		const link = join(root, "search.mjs");
		symlinkSync(new URL("../../../skills/native-web-search/search.mjs", import.meta.url), link);
		const result = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
		// The guard compares both the literal and the realpath entry, so a symlinked
		// install still reaches main() instead of importing silently and exiting 0
		// with no output.
		assert.equal(result.status, 0);
		assert.match(result.stderr, /Usage:/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the candidate list pins the repo and installed-package layouts", () => {
	const here = join("proj", ".pi", "extensions");
	const cwd = join("proj");
	// Candidates 2 and 3 coincide here because cwd === the repo root: candidate
	// 2 is the repo/package-root `.pi/skills` and candidate 3 reaches the same
	// path via cwd. That collision is deliberate and pinned, not something to
	// dedupe away — candidate 3 is load-bearing for agent-dir installs.
	assert.deepEqual(scriptCandidates(here, cwd), [
		join("proj", ".pi", "extensions", "search.mjs"),
		join("proj", ".pi", "skills", "native-web-search", "search.mjs"),
		join("proj", ".pi", "skills", "native-web-search", "search.mjs"),
	]);
	// The whole point of the fix: every skills candidate carries `.pi`. A
	// regression back to `<root>/skills/...` (which can never exist, because
	// dot-prefixed dirs are the pi package layout) fails this assertion.
	for (const candidate of scriptCandidates(here, cwd)) {
		if (candidate.includes(`${sep}skills${sep}`)) {
			assert.ok(candidate.includes(`${sep}.pi${sep}skills${sep}`),
				`candidate must reference .pi/skills, not bare skills: ${candidate}`);
		}
	}
});

test("the skill resolves from the repo layout on a fixture tree", () => {
	const root = mkdtempSync(join(tmpdir(), "nws-test-"));
	try {
		// A real tree: the extension dir has no co-located script; the skill lives
		// in `.pi/skills/native-web-search/` at the repo root.
		mkdirSync(join(root, ".pi", "skills", "native-web-search"), { recursive: true });
		writeFileSync(join(root, ".pi", "skills", "native-web-search", "search.mjs"), "// fixture\n");

		const here = join(root, ".pi", "extensions");
		const found = scriptCandidates(here, root).find((candidate) => existsSync(candidate));
		assert.equal(found, join(root, ".pi", "skills", "native-web-search", "search.mjs"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("PI_NATIVE_WEB_SEARCH_SCRIPT is honoured verbatim when absolute", () => {
	const saved = process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	const custom = resolve("/", "some", "custom", "search.mjs");
	process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = custom;
	try {
		assert.equal(resolveScriptPath(), custom);
	} finally {
		restoreEnv(saved);
	}
});

test("a relative PI_NATIVE_WEB_SEARCH_SCRIPT resolves against cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "nws-env-"));
	const saved = process.env.PI_NATIVE_WEB_SEARCH_SCRIPT;
	const oldCwd = process.cwd();
	try {
		process.chdir(root);
		process.env.PI_NATIVE_WEB_SEARCH_SCRIPT = "custom/search.mjs";
		assert.equal(resolveScriptPath(), resolve(root, "custom", "search.mjs"));
	} finally {
		process.chdir(oldCwd);
		restoreEnv(saved);
		rmSync(root, { recursive: true, force: true });
	}
});
