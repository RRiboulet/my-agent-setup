#!/usr/bin/env node

// VENDORED, NOT OURS.
// search.mjs — Copyright (c) mitsuhiko and contributors
// https://github.com/mitsuhiko/agent-stuff (skills/native-web-search/search.mjs)
// Licensed under the Apache License, Version 2.0.
// Upstream: mitsupi v1.6.0, commit 0865c84.
//
// LOCAL PATCHES, most of the file: provider support beyond upstream's
// `openai-codex` and `anthropic`, plus a test seam. In short:
//   - `openrouter` via its `web` plugin, with `runOpenRouterSearch`,
//     `defaultModelId` and `defaultBaseUrl` added;
//   - `pickProvider` extended with the openrouter credential and
//     `PI_WEB_SEARCH_PROVIDER`, and made to reject an unrecognized explicit
//     provider instead of silently falling through to another plan;
//   - `normalizeProvider`, `buildAnthropicHeaders`, `runAnthropicSearch` and
//     `resolveApiKey` modified (exact-id matching, a testable request builder);
//   - a direct-invocation guard and a `__test__` export at the bottom, so
//     importing the module for tests does not run a search.
//   - 2026-10: the direct `anthropic` path moved to `web_search_20260318` with
//     `allowed_callers: ["direct"]` (see ANTHROPIC_WEB_SEARCH_TOOL). Default
//     `anthropic` model is now `claude-haiku-5-5`.
//   - 2026-11: `brave` added as a provider value and made the first choice when
//     a Brave key resolves (`BRAVE_API_KEY`, else the `brave`/`brave-search`
//     entry in auth.json), with the native chain above as the fallback on any
//     failure when a native credential is configured; with none, the error
//     names both the Brave failure and the missing credential. No local quota,
//     counter or audit log: the account settings are
//     the only limit. `resolveBraveApiKey`, `runBraveSearch`,
//     `renderBraveResults`, `sanitizeField`, `describeBraveFailure`,
//     `pickNativeProvider`, `runNativeProvider` and `runSearch` added.
//   - 2026-11: `opencode-go` removed. The Go plan's Anthropic models accept the
//     `web_search` tool definition but silently answer from memory — a live
//     probe returns "I can't run a live web search", and an explicit
//     `tool_choice` is rejected with "the web_search hosted tool isn't
//     available on OpenCode's models". OpenRouter is the native default again.
// The body is indented with spaces; upstream uses tabs, so a plain diff against
// upstream is not meaningful — compare with `diff -w`. See the LOCAL PATCH
// hunks listed in SKILL.md beside this file.
//
// Verified against upstream 0865c84: no upstream function was removed.

import { existsSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_DEFAULT_COUNT = 5;

function parseArgs(argv) {
    const out = {
        provider: undefined,
        model: undefined,
        purpose: "general research support",
        timeoutMs: 120000,
        json: false,
        help: false,
        query: "",
    };

    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            out.help = true;
            continue;
        }
        if (arg === "--json") {
            out.json = true;
            continue;
        }
        if (arg === "--provider") {
            out.provider = argv[++i];
            continue;
        }
        if (arg.startsWith("--provider=")) {
            out.provider = arg.slice("--provider=".length);
            continue;
        }
        if (arg === "--model") {
            out.model = argv[++i];
            continue;
        }
        if (arg.startsWith("--model=")) {
            out.model = arg.slice("--model=".length);
            continue;
        }
        if (arg === "--purpose") {
            out.purpose = argv[++i] || out.purpose;
            continue;
        }
        if (arg.startsWith("--purpose=")) {
            out.purpose = arg.slice("--purpose=".length) || out.purpose;
            continue;
        }
        if (arg === "--timeout") {
            out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
            continue;
        }
        if (arg.startsWith("--timeout=")) {
            out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
            continue;
        }
        positional.push(arg);
    }

    out.query = positional.join(" ").trim();
    return out;
}

function usage() {
    return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider brave|openrouter|openai-codex|anthropic] [--model <id>] [--json]

Brave is used whenever a Brave key is configured; the native chain runs when it
is not, and takes over (with the reason in the result) when Brave fails and a
native credential is configured. With no native credential, a Brave failure
fails with both reasons instead of a bare "Could not determine provider".

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider openai-codex
  node search.mjs "vite 7 breaking changes" --provider openrouter --json`;
}

function readJson(path, fallback = {}) {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return fallback;
    }
}

function writeJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config) {
    if (typeof config !== "string" || !config) return undefined;
    if (config.startsWith("!")) {
        try {
            const out = execSync(config.slice(1), {
                encoding: "utf8",
                timeout: 10000,
                stdio: ["ignore", "pipe", "ignore"],
            }).trim();
            return out || undefined;
        } catch {
            return undefined;
        }
    }
    return process.env[config] || config;
}

function getAgentDir() {
    const configured = process.env.PI_CODING_AGENT_DIR;
    if (!configured) return join(homedir(), ".pi", "agent");
    if (configured === "~") return homedir();
    if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
    return configured;
}

// Brave is the one credential resolved here rather than through
// `resolveApiKey`: auth.json stores it as `{type:"str", key:"..."}` rather than
// as an OAuth or API-key entry, and the native chain has no Brave provider to
// hand it to. Precedence stays in this one place — env first, then auth.json —
// and `resolveConfigValue` handles env-var/`!command` indirection exactly as it
// does for every other credential below.
function resolveBraveApiKey(auth) {
    const env = process.env.BRAVE_API_KEY?.trim();
    if (env) return env;

    const entry = auth?.brave ?? auth?.["brave-search"];
    if (!entry) return undefined;
    const key = resolveConfigValue(entry.key);
    return key?.trim() || undefined;
}

function normalizeProvider(provider) {
    if (!provider) return undefined;
    const p = String(provider).toLowerCase().trim();
    // Exact provider ids first, so a composite string cannot be captured by a
    // substring meant for a different provider.
    if (p === "brave" || p === "brave-search") return "brave";
    if (p === "openrouter") return "openrouter";
    if (p === "openai-codex" || p === "openai" || p === "codex") return "openai-codex";
    if (p === "anthropic") return "anthropic";
    // `opencode-go` was removed as a provider. Reject any composite id that still
    // carries that name before the model-shaped substring rules below, so
    // `opencode-go/claude-haiku-5-5` cannot be captured by `claude` and quietly
    // spend the direct Anthropic plan's budget instead of failing.
    if (p.includes("opencode")) return undefined;
    // Then model-shaped strings (`claude-haiku-5-5`, `openai/gpt-4o-mini:online`).
    if (p.includes("brave")) return "brave";
    if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
    if (p.includes("openrouter") || p.includes("sonar")) return "openrouter";
    if (p.includes("codex") || p.startsWith("openai")) return "openai-codex";
    return undefined;
}

// Brave is the first choice whenever a key resolves; this is the native chain
// on its own, and also what a Brave failure falls back to. A `brave` value in
// settings is ignored here rather than returned: this function cannot serve it,
// and falling through to a real native credential beats looping back to Brave.
function pickNativeProvider(settings, auth, authPath) {
    // settings.defaultProvider may name an unrelated pi provider (a local model
    // server, say), so an unknown value is ignored rather than fatal.
    const fromSettings = normalizeProvider(settings?.defaultProvider);
    if (fromSettings && fromSettings !== "brave") return fromSettings;

    // OpenRouter first: its `web` plugin is the native chain's default, and a
    // machine that kept an OpenRouter credential around should spend it before
    // any other native provider.
    if (auth?.openrouter) return "openrouter";
    if (auth?.["openai-codex"]) return "openai-codex";
    if (auth?.anthropic) return "anthropic";

    // Name both the cause and the fix: this is also the error a Brave failure
    // reaches when no native credential exists, and the old "Could not
    // determine provider" told the user neither.
    const where = authPath || "auth.json";
    throw new Error(
        `Could not determine a native web-search provider: no openrouter, openai-codex or anthropic credential is configured in ${where}. ` +
            `Add an \`openrouter\` entry to ${where}, or pass --provider openrouter|openai-codex|anthropic.`,
    );
}

function pickProvider(argProvider, settings, auth) {
    const forced = normalizeProvider(argProvider);
    if (forced) return forced;
    // An explicit provider that cannot be mapped is a typo, not a reason to
    // fall through to whatever credential happens to exist: silently spending
    // another plan's budget is worse than failing.
    if (argProvider && String(argProvider).trim()) {
        throw new Error(`Unknown provider '${argProvider}'. Use brave|openrouter|openai-codex|anthropic`);
    }

    const fromEnv = normalizeProvider(process.env.PI_WEB_SEARCH_PROVIDER);
    if (fromEnv) return fromEnv;
    if (process.env.PI_WEB_SEARCH_PROVIDER && String(process.env.PI_WEB_SEARCH_PROVIDER).trim()) {
        throw new Error(
            `Unknown provider in PI_WEB_SEARCH_PROVIDER: '${process.env.PI_WEB_SEARCH_PROVIDER}'. Use brave|openrouter|openai-codex|anthropic`,
        );
    }

    // Brave is first choice whenever a key is configured. There is no local
    // quota to consult: the account's own limit lives in Brave's dashboard, and
    // a 429 falls through to the native chain instead of being pre-empted here.
    if (resolveBraveApiKey(auth)) return "brave";

    return pickNativeProvider(settings, auth);
}

function decodeJwtAccountId(jwt) {
    if (!jwt || typeof jwt !== "string") return undefined;
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch {
        return undefined;
    }
}

function findPiExecutable() {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
    if (result.status !== 0) return undefined;
    const first = result.stdout
        .split(/\r?\n/)
        .map((x) => x.trim())
        .find(Boolean);
    return first || undefined;
}

function collectModuleCandidates(fileName = "index.js", envVarName = "PI_AI_MODULE_PATH") {
    const candidates = new Set();

    const add = (p) => {
        if (!p) return;
        const abs = isAbsolute(p) ? p : resolve(p);
        candidates.add(abs);
    };

    if (envVarName && process.env[envVarName]) add(process.env[envVarName]);

    const cwd = process.cwd();
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    for (const start of [cwd, scriptDir]) {
        let dir = start;
        for (let i = 0; i < 8; i++) {
            add(join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
            add(join(dir, "packages", "ai", "dist", fileName));
            add(join(dir, "ai", "dist", fileName));
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }

    const piExec = findPiExecutable();
    if (piExec) {
        try {
            const piReal = realpathSync(piExec);
            const piDir = dirname(piReal);
            add(join(piDir, "..", "..", "ai", "dist", fileName));
            add(join(piDir, "..", "..", "pi-ai", "dist", fileName));
            add(join(piDir, "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
            add(join(piDir, "..", "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
        } catch {
            // ignore
        }
    }

    add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", fileName));

    return Array.from(candidates);
}

async function loadPiAi() {
    const tried = [];

    try {
        return await import("@earendil-works/pi-ai");
    } catch (err) {
        tried.push(`@earendil-works/pi-ai (${err?.code || err?.message || "not found"})`);
    }

    for (const candidate of collectModuleCandidates("index.js", "PI_AI_MODULE_PATH")) {
        if (!existsSync(candidate)) continue;
        try {
            return await import(pathToFileURL(candidate).href);
        } catch (err) {
            tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
        }
    }

    throw new Error(
        `Could not load @earendil-works/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
    );
}

async function loadPiAiOAuth(piAi) {
    if (typeof piAi?.getOAuthApiKey === "function") {
        return { getOAuthApiKey: piAi.getOAuthApiKey.bind(piAi) };
    }

    const tried = [];

    try {
        const oauth = await import("@earendil-works/pi-ai/oauth");
        if (typeof oauth.getOAuthApiKey === "function") {
            return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
        }
        tried.push("@earendil-works/pi-ai/oauth (missing getOAuthApiKey export)");
    } catch (err) {
        tried.push(`@earendil-works/pi-ai/oauth (${err?.code || err?.message || "not found"})`);
    }

    for (const candidate of collectModuleCandidates("oauth.js", "PI_AI_OAUTH_MODULE_PATH")) {
        if (!existsSync(candidate)) continue;
        try {
            const oauth = await import(pathToFileURL(candidate).href);
            if (typeof oauth.getOAuthApiKey === "function") {
                return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
            }
            tried.push(`${candidate} (missing getOAuthApiKey export)`);
        } catch (err) {
            tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
        }
    }

    return {
        getOAuthApiKey: undefined,
        error: `Could not load getOAuthApiKey. Set PI_AI_OAUTH_MODULE_PATH to pi-ai dist/oauth.js.\nTried:\n- ${tried.join("\n- ")}`,
    };
}

function parseExpiryTimestamp(expires) {
    if (typeof expires === "number" && Number.isFinite(expires)) {
        if (expires <= 0) return undefined;
        return expires < 1_000_000_000_000 ? expires * 1000 : expires;
    }

    if (typeof expires === "string") {
        const trimmed = expires.trim();
        if (!trimmed) return undefined;

        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
            return parseExpiryTimestamp(numeric);
        }

        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) return parsed;
    }

    return undefined;
}

function getCachedOAuthAccess(entry, now = Date.now()) {
    if (!entry || typeof entry !== "object") return undefined;

    const apiKey = resolveConfigValue(entry.access);
    if (!apiKey) return undefined;

    const expiresAt = parseExpiryTimestamp(entry.expires);
    if (!expiresAt) return undefined;

    if (now + 30_000 >= expiresAt) return undefined;

    return {
        apiKey,
        accountId: entry.accountId,
    };
}

function defaultModelId(provider) {
    if (provider === "openrouter") return "openai/gpt-4o-mini:online";
    if (provider === "openai-codex") return "gpt-5.4-mini";
    // Direct Anthropic API: cheapest web-search-capable model as of 2026-10.
    return "claude-haiku-5-5";
}

function defaultBaseUrl(provider) {
    if (provider === "openrouter") return "https://openrouter.ai/api/v1";
    if (provider === "openai-codex") return "https://chatgpt.com/backend-api";
    return "https://api.anthropic.com";
}

// The direct Anthropic API uses `web_search_20260318` with
// `allowed_callers: ["direct"]` to force direct invocation regardless of the
// model's code-execution capabilities — without that pin, `_20260209` and later
// default to `["code_execution_20260120"]`, which not every model supports.
const ANTHROPIC_WEB_SEARCH_TOOL = {
    type: "web_search_20260318",
    name: "web_search",
    max_uses: 5,
    allowed_callers: ["direct"],
};

// Newer Anthropic-protocol models reject `temperature` as deprecated. Add a
// model id here when one starts rejecting it; omitting it is always safe
// because the API default applies.
const MODELS_WITHOUT_TEMPERATURE = new Set(["claude-haiku-5-5"]);
function supportsTemperature(model) {
    return !MODELS_WITHOUT_TEMPERATURE.has(String(model || "").trim());
}

function pickFastModel(provider, requestedModel, piAi) {
    const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
    const baseUrl = defaultBaseUrl(provider);

    // OpenRouter model ids for native web search (":online" suffix, Perplexity
    // Sonar) are not part of the pi-ai catalogue, so resolve them directly and
    // never fall back to a catalogue heuristic that would lose web access.
    if (provider === "openrouter") {
        const preferred = ["openai/gpt-4o-mini:online", "google/gemini-2.5-flash:online", "perplexity/sonar"];
        const known = models.find((m) => m.id === "perplexity/sonar");
        const id = requestedModel || preferred[0];
        return { id, baseUrl: known?.baseUrl ?? baseUrl };
    }

    if (!Array.isArray(models) || models.length === 0) {
        if (requestedModel) return { id: requestedModel, baseUrl };
        return { id: defaultModelId(provider), baseUrl };
    }

    if (requestedModel) {
        const exact = models.find((m) => m.id === requestedModel);
        if (exact) return exact;
        return { ...models[0], id: requestedModel };
    }

    const preferredIds =
        provider === "openai-codex"
            ? ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.1", "gpt-5.1-codex-mini"]
            : ["claude-haiku-5-5", "claude-haiku-4-5", "claude-3-5-haiku-latest"];

    for (const id of preferredIds) {
        const found = models.find((m) => m.id === id);
        if (found) return found;
    }

    const heuristic = models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id));
    return heuristic || models[0];
}

async function resolveApiKey(provider, auth, authPath, piAi) {
    const entry = auth?.[provider];
    if (!entry) {
        throw new Error(`No credentials for provider '${provider}' in ${authPath}`);
    }

    const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

    if (inferredType === "api_key") {
        const key = resolveConfigValue(entry.key);
        if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
        return { apiKey: key, accountId: entry.accountId };
    }

    if (inferredType !== "oauth") {
        throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
    }

    const fallbackToken = getCachedOAuthAccess(entry);
    const oauth = await loadPiAiOAuth(piAi);

    if (typeof oauth.getOAuthApiKey !== "function") {
        if (fallbackToken) return fallbackToken;
        throw new Error(oauth.error || "Loaded pi-ai module does not export getOAuthApiKey");
    }

    const oauthCreds = {};
    for (const [k, v] of Object.entries(auth || {})) {
        if (v && (v.type === "oauth" || (v.access && v.refresh && v.expires))) {
            oauthCreds[k] = v;
        }
    }

    let refreshed;
    try {
        refreshed = await oauth.getOAuthApiKey(provider, oauthCreds);
    } catch (err) {
        if (fallbackToken) return fallbackToken;
        throw err;
    }

    if (!refreshed?.apiKey) {
        if (fallbackToken) return fallbackToken;
        throw new Error(`No OAuth credentials available for provider '${provider}'`);
    }

    const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
    auth[provider] = mergedCred;
    writeJson(authPath, auth);

    return {
        apiKey: refreshed.apiKey,
        accountId: mergedCred.accountId,
    };
}

function buildUserPrompt(query, purpose) {
    return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
    return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
    const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
}

function extractEventData(chunk) {
    const payload = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
    if (!payload || payload === "[DONE]") return null;
    return payload;
}

async function runCodexSearch({ model, apiKey, accountId, query, purpose, timeoutMs, baseUrl }) {
    const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
    if (!tokenAccountId) {
        throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
    }

    const body = {
        model,
        store: false,
        stream: true,
        instructions: buildSystemPrompt(),
        input: [{ role: "user", content: buildUserPrompt(query, purpose) }],
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
    };

    const endpoint = resolveCodexUrl(baseUrl);
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "chatgpt-account-id": tokenAccountId,
            "content-type": "application/json",
            accept: "text/event-stream",
            "OpenAI-Beta": "responses=experimental",
            originator: "pi-native-web-search-skill",
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Codex request failed (${res.status}): ${detail}`);
    }
    if (!res.body) {
        throw new Error("Codex response had no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let fallbackText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf("\n\n");

            const data = extractEventData(chunk);
            if (!data) continue;

            let event;
            try {
                event = JSON.parse(data);
            } catch {
                continue;
            }

            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                text += event.delta;
            }

            if (event.type === "response.output_item.done" && event.item?.type === "message") {
                const parts = Array.isArray(event.item?.content) ? event.item.content : [];
                const full = parts
                    .filter((p) => p.type === "output_text" && typeof p.text === "string")
                    .map((p) => p.text)
                    .join("\n");
                if (full) fallbackText = full;
            }

            if (event.type === "error") {
                throw new Error(event.message || "Codex stream failed");
            }

            if (event.type === "response.failed") {
                throw new Error(event.response?.error?.message || "Codex response failed");
            }
        }
    }

    const finalText = (text || fallbackText || "").trim();
    if (!finalText) {
        throw new Error("Codex returned an empty response");
    }
    return finalText;
}

async function runOpenRouterSearch({ model, apiKey, baseUrl, query, purpose, timeoutMs }) {
    const url = `${String(baseUrl || defaultBaseUrl("openrouter")).replace(/\/+$/, "")}/chat/completions`;
    const body = {
        model,
        temperature: 0,
        max_tokens: 1800,
        messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserPrompt(query, purpose) },
        ],
        // OpenRouter native web search plugin. Requires a web-enabled model
        // (e.g. ":online" suffixed ids or Perplexity Sonar).
        plugins: [{ id: "web", max_results: 5 }],
    };

    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
            "HTTP-Referer": "https://github.com/earendil-works/pi",
            "X-Title": "pi native web search",
        },
        body: JSON.stringify(body),
        signal,
    });

    const payload = await res.text();
    if (!res.ok) {
        throw new Error(`OpenRouter request failed (${res.status}): ${payload}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        throw new Error("OpenRouter returned non-JSON response");
    }

    if (parsed?.error?.message) {
        throw new Error(`OpenRouter error: ${parsed.error.message}`);
    }

    const text = (parsed.choices?.[0]?.message?.content ?? "")
        .toString()
        .trim();

    if (!text) {
        throw new Error("OpenRouter returned no text content");
    }

    const citations = Array.isArray(parsed.citations) ? parsed.citations.filter((c) => typeof c === "string") : [];

    return citations.length > 0 ? `${text}\n\nSources:\n${citations.map((c) => `- ${c}`).join("\n")}` : text;
}

function buildAnthropicHeaders(apiKey) {
    const oauthToken = typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
    if (oauthToken) {
        return {
            authorization: `Bearer ${apiKey}`,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05",
            "content-type": "application/json",
            accept: "application/json",
            "x-app": "cli",
            "user-agent": "claude-cli/1.0.72 (external, cli)",
        };
    }
    return {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
        "content-type": "application/json",
        accept: "application/json",
    };
}

// Pure request builder, so tests can pin the endpoint, headers and body without
// a network call. Serves the direct Anthropic API; the caller passes the base
// URL. Uses the newest tool version (`web_search_20260318`).
function buildAnthropicRequest({ model, apiKey, query, purpose, baseUrl }) {
    const body = {
        model,
        max_tokens: 1800,
        system: buildSystemPrompt(),
        tools: [ANTHROPIC_WEB_SEARCH_TOOL],
        messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
    };
    // Omitting temperature is always safe — the API default applies — and
    // `claude-haiku-5-5` rejects it as deprecated.
    if (supportsTemperature(model)) body.temperature = 0;

    return {
        endpoint: `${String(baseUrl || defaultBaseUrl("anthropic")).replace(/\/+$/, "")}/v1/messages`,
        headers: buildAnthropicHeaders(apiKey),
        body,
    };
}

async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs, baseUrl }) {
    const { endpoint, headers, body } = buildAnthropicRequest({
        model,
        apiKey,
        query,
        purpose,
        baseUrl,
    });

    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

    const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    const payload = await res.text();
    if (!res.ok) {
        throw new Error(`Anthropic request failed (${res.status}): ${payload}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        throw new Error("Anthropic returned non-JSON response");
    }

    const text = (parsed.content || [])
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n\n")
        .trim();

    if (!text) {
        throw new Error("Anthropic returned no text content");
    }

    return text;
}

// One line per field: a hostile result must not be able to forge a sibling
// `--- Result N ---` block (or anything else) by embedding newlines in a title,
// link or snippet.
function sanitizeField(value) {
    return String(value ?? "")
        .replace(/[\r\n]+/g, " ")
        .trim();
}

function renderBraveResults(results) {
    const lines = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i] || {};
        lines.push(`--- Result ${i + 1} ---`);
        lines.push(`Title: ${sanitizeField(r.title)}`);
        lines.push(`Link: ${sanitizeField(r.url)}`);
        const age = sanitizeField(r.age ?? r.page_age);
        if (age) lines.push(`Age: ${age}`);
        lines.push(`Snippet: ${sanitizeField(r.description)}`);
        lines.push("");
    }
    return lines.join("\n").trim();
}

// A short, controlled reason string: `describeBraveFailure` turns it into the
// one line that heads a fallback result, so no response body or stack trace can
// leak into the output.
function braveFailure(reason, status) {
    const err = new Error(`Brave search failed: ${reason}`);
    err.braveReason = reason;
    if (status) err.braveStatus = status;
    return err;
}

function describeBraveFailure(err) {
    if (err?.braveStatus) return `HTTP ${err.braveStatus}`;
    if (err?.braveReason) return err.braveReason;
    return "request failed";
}

function braveSignal(timeoutMs, signal) {
    const timeout =
        typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    // A caller's signal (there is none from the CLI, but the function takes one)
    // must still cancel the request, and the timeout must still fire.
    if (timeout && signal && typeof AbortSignal.any === "function") return AbortSignal.any([timeout, signal]);
    return signal || timeout;
}

async function runBraveSearch({ apiKey, query, timeoutMs, signal, fetchImpl = fetch }) {
    const params = new URLSearchParams({ q: query, count: String(BRAVE_DEFAULT_COUNT) });

    let res;
    try {
        res = await fetchImpl(`${BRAVE_ENDPOINT}?${params.toString()}`, {
            headers: {
                accept: "application/json",
                "X-Subscription-Token": apiKey,
            },
            signal: braveSignal(timeoutMs, signal),
        });
    } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        throw braveFailure(timedOut ? "timed out" : "network error");
    }

    // No response body in the message: it can be long, and a 422 body is not
    // something a model should be reading.
    if (!res.ok) throw braveFailure(`HTTP ${res.status}`, res.status);

    let data;
    try {
        data = await res.json();
    } catch {
        throw braveFailure("non-JSON response");
    }

    const results = Array.isArray(data?.web?.results) ? data.web.results : [];
    if (results.length === 0) throw braveFailure("no results");

    return renderBraveResults(results);
}

// The native chain's one-shot call: resolve the model and credential, then
// dispatch to the provider's runner. Split out of `main` so a Brave failure can
// reach it without re-deriving the provider chain.
async function runNativeProvider(provider, args, { auth, authPath }) {
    const piAi = await loadPiAi();
    const model = pickFastModel(provider, args.model, piAi);
    const { apiKey, accountId } = await resolveApiKey(provider, auth, authPath, piAi);

    const text =
        provider === "openrouter"
            ? await runOpenRouterSearch({
                    model: model.id,
                    apiKey,
                    baseUrl: model.baseUrl,
                    query: args.query,
                    purpose: args.purpose,
                    timeoutMs: args.timeoutMs,
              })
            : provider === "openai-codex"
              ? await runCodexSearch({
                      model: model.id,
                      apiKey,
                      accountId,
                      query: args.query,
                      purpose: args.purpose,
                      timeoutMs: args.timeoutMs,
                      baseUrl: model.baseUrl,
                  })
              : await runAnthropicSearch({
                      model: model.id,
                      apiKey,
                      query: args.query,
                      purpose: args.purpose,
                      timeoutMs: args.timeoutMs,
                      baseUrl: model.baseUrl,
                  });

    return { model: model.id, text };
}

// Brave first when its key resolves, otherwise the native chain. Any Brave
// failure — missing key, 429, 422, network, zero results — falls through to
// that chain and puts one short line saying why at the top of the result. With
// no native credential, the run fails with both the Brave reason and the
// missing credential instead of throwing only the latter.
// There is no counter, lock file or audit log: the account settings are the limit.
// `fetchImpl` and `runNative` are injectable so that fallback is testable
// without a network call or a pi-ai install.
async function runSearch(args, { auth, settings, authPath, fetchImpl = fetch, runNative = runNativeProvider }) {
    const provider = pickProvider(args.provider, settings, auth);

    if (provider !== "brave") {
        const native = await runNative(provider, args, { auth, authPath });
        return { provider, model: native.model, text: native.text };
    }

    const apiKey = resolveBraveApiKey(auth);
    let note;
    if (!apiKey) {
        note = "Brave unavailable (no API key)";
    } else {
        try {
            const text = await runBraveSearch({ apiKey, query: args.query, timeoutMs: args.timeoutMs, fetchImpl });
            return { provider: "brave", model: "brave-search", text };
        } catch (err) {
            note = `Brave unavailable (${describeBraveFailure(err)})`;
        }
    }

    // An explicit `--provider brave` still falls back — the tool must keep
    // working — but through the native chain, never back into Brave.
    let nativeProvider;
    try {
        nativeProvider = pickNativeProvider(settings, auth, authPath);
    } catch (err) {
        // With no native credential the fallback cannot run. Say both why Brave
        // was skipped and what is missing, rather than only the latter.
        throw new Error(`${note}; the native fallback cannot run. ${err?.message || err}`);
    }
    const native = await runNative(nativeProvider, args, { auth, authPath });
    return { provider: nativeProvider, model: native.model, text: `${note}; fell back to native search.\n\n${native.text}` };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.query) {
        console.error(usage());
        process.exit(args.help ? 0 : 1);
    }

    const agentDir = getAgentDir();
    const authPath = join(agentDir, "auth.json");
    const settingsPath = join(agentDir, "settings.json");
    const auth = readJson(authPath, {});
    const settings = readJson(settingsPath, {});

    const { provider, model, text } = await runSearch(args, { auth, settings, authPath });

    if (args.json) {
        console.log(
            JSON.stringify(
                {
                    provider,
                    model,
                    query: args.query,
                    purpose: args.purpose,
                    result: text,
                },
                null,
                2,
            ),
        );
        return;
    }

    console.log(`Provider: ${provider}`);
    console.log(`Model: ${model}`);
    console.log("");
    console.log(text);
}

// Run only when invoked as a script, so a test can import the pure helpers
// below without a search firing. The entry path is compared literally and via
// realpath, because a symlinked install resolves import.meta.url while
// process.argv[1] keeps whatever path was typed (and --preserve-symlinks flips
// that around).
const invokedDirectly = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    const candidates = new Set([pathToFileURL(resolve(entry)).href]);
    try {
        candidates.add(pathToFileURL(realpathSync(entry)).href);
    } catch {
        // A path that cannot be resolved still gets the literal comparison above.
    }
    return candidates.has(import.meta.url);
})();

if (invokedDirectly) {
    main().catch((err) => {
        console.error(`Error: ${err?.message || err}`);
        process.exit(1);
    });
}

export const __test__ = {
    parseArgs,
    normalizeProvider,
    pickProvider,
    pickNativeProvider,
    resolveBraveApiKey,
    sanitizeField,
    renderBraveResults,
    describeBraveFailure,
    runBraveSearch,
    runNativeProvider,
    runSearch,
    defaultModelId,
    defaultBaseUrl,
    supportsTemperature,
    pickFastModel,
    buildAnthropicHeaders,
    buildAnthropicRequest,
    resolveApiKey,
    ANTHROPIC_WEB_SEARCH_TOOL,
};