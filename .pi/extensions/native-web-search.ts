// Native web search extension.
//
// Exposes the `native-web-search` skill script as:
//   - the `web_search` tool (callable by the model)
//   - the `/web-search <query>` command (manual invocation)
//
// The script itself is the single source of truth for provider selection,
// credential resolution and native web-search calls; this extension only
// builds arguments and renders the result. That keeps the skill usable
// standalone from the shell with identical behaviour.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const SCRIPT_ENV_VAR = "PI_NATIVE_WEB_SEARCH_SCRIPT";
const PROVIDER_ENV_VAR = "PI_WEB_SEARCH_PROVIDER";
const MODEL_ENV_VAR = "PI_WEB_SEARCH_MODEL";
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface WebSearchInput {
	query: string;
	purpose?: string;
	provider?: "opencode-go" | "openrouter" | "openai-codex" | "anthropic";
	model?: string;
	timeout_ms?: number;
}

// The candidate order matters: the extension's own dir first (a script tucked
// next to the extension), then the skill relative to the repo/package root
// (here is `.pi/extensions`, so `.pi/skills` sits two levels up), then the same
// relative to cwd. Candidates are quoted in the failure message, so a path that
// can never exist is worse than useless — it advertises a lie. The second
// candidate is `here/../../.pi/skills/...`, never `here/../../skills/...`:
// `.pi` is the whole reason a git-sourced pi package is discoverable at all.
function scriptCandidates(here: string, cwd: string): string[] {
	return [
		join(here, "search.mjs"),
		join(here, "..", "..", ".pi", "skills", "native-web-search", "search.mjs"),
		join(cwd, ".pi", "skills", "native-web-search", "search.mjs"),
	];
}

function resolveScriptPath(): string {
	const configured = process.env[SCRIPT_ENV_VAR];
	if (configured) {
		return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
	}

	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = scriptCandidates(here, process.cwd());

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		`Could not locate search.mjs. Set ${SCRIPT_ENV_VAR} to its absolute path. Looked in:\n- ${candidates.join("\n- ")}`,
	);
}

function clampTimeout(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(Math.floor(value), 1_000), MAX_TIMEOUT_MS);
}

/**
 * Provider precedence is the script's: this forwards only an explicitly
 * requested provider. Leaving it undefined makes `runSearch` omit --provider, so
 * the script applies `PI_WEB_SEARCH_PROVIDER`, then `defaultProvider` in
 * settings.json, then the first credential in auth.json (preferring
 * opencode-go). Reading the env var here too would double-handle it and make the
 * script's own order and error message unreachable.
 */
function resolveProvider(requested: WebSearchInput["provider"]): string | undefined {
	return requested?.trim() || undefined;
}

/** Model precedence: explicit argument > env override > script default for the provider. */
function resolveModel(requested: string | undefined): string | undefined {
	return requested?.trim() || process.env[MODEL_ENV_VAR]?.trim() || undefined;
}

interface SearchArgs {
	script: string;
	query: string;
	purpose?: string;
	provider?: string;
	model?: string;
	timeoutMs: number;
}

/**
 * Pure argv builder, so the seam that decides whether --provider is sent is
 * testable. --provider is omitted when nothing explicit was requested, which is
 * what lets the script resolve settings.defaultProvider/auth.json itself.
 */
function buildSearchArgs({ script, query, purpose, provider, model, timeoutMs }: SearchArgs): string[] {
	const args = [script, query, "--json", "--timeout", String(timeoutMs)];
	if (provider) args.push("--provider", provider);
	if (purpose?.trim()) args.push("--purpose", purpose.trim());
	if (model) args.push("--model", model);
	return args;
}

interface SearchResult {
	provider: string;
	model: string;
	query: string;
	purpose: string;
	result: string;
}

async function runSearch(input: WebSearchInput, signal?: AbortSignal): Promise<SearchResult> {
	const query = input.query?.trim();
	if (!query) {
		throw new Error("web_search requires a non-empty query");
	}

	const script = resolveScriptPath();
	const timeoutMs = clampTimeout(input.timeout_ms);

	const args = buildSearchArgs({
		script,
		query,
		purpose: input.purpose,
		provider: resolveProvider(input.provider),
		model: resolveModel(input.model),
		timeoutMs,
	});

	const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
		(resolvePromise, rejectPromise) => {
			const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });

			let out = "";
			let err = "";
			child.stdout.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				err += chunk.toString();
			});

			const onAbort = () => child.kill("SIGTERM");
			signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				signal?.removeEventListener("abort", onAbort);
				rejectPromise(error);
			});

			child.on("close", (exitCode) => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) {
					rejectPromise(new Error("web_search cancelled"));
					return;
				}
				resolvePromise({ stdout: out, stderr: err, code: exitCode });
			});
		},
	);

	if (code !== 0) {
		const detail = (stderr || stdout).trim();
		throw new Error(`web_search failed (exit ${code}): ${detail || "no output"}`);
	}

	try {
		const parsed = JSON.parse(stdout) as SearchResult;
		if (typeof parsed.result !== "string" || parsed.result.trim() === "") {
			throw new Error("empty result");
		}
		return parsed;
	} catch (error) {
		const detail = (stderr || stdout).trim();
		throw new Error(
			`Could not parse web_search output: ${(error as Error).message}${detail ? `\n${detail}` : ""}`,
		);
	}
}

function formatResult(search: SearchResult): string {
	return [
		`Provider: ${search.provider} (model: ${search.model})`,
		`Query: ${search.query}`,
		"",
		search.result,
	].join("\n");
}

/** Parse `/web-search "<query>" [--purpose "<text>"] [--provider <p>] [--model <id>]` */
function parseCommandArgs(raw: string): WebSearchInput {
	const positional: string[] = [];
	const input: WebSearchInput = { query: "" };

	const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const value = token.replace(/^["']|["']$/g, "");

		if (value.startsWith("--purpose=")) input.purpose = value.slice("--purpose=".length);
		else if (value === "--purpose") input.purpose = tokens[++i]?.replace(/^["']|["']$/g, "");
		else if (value.startsWith("--provider=")) input.provider = value.slice("--provider=".length) as WebSearchInput["provider"];
		else if (value === "--provider") input.provider = tokens[++i] as WebSearchInput["provider"];
		else if (value.startsWith("--model=")) input.model = value.slice("--model=".length);
		else if (value === "--model") input.model = tokens[++i];
		else positional.push(value);
	}

	input.query = positional.join(" ").trim();
	return input;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the internet with a fast, web-enabled model. Returns a concise research summary (3-7 findings) " +
			"with full canonical source URLs, tailored to a stated purpose. Uses opencode-go by default; pass provider " +
			"to use OpenRouter, openai-codex or anthropic instead. Use for current facts, documentation, release notes, and any " +
			"question that needs external information.",
		promptSnippet: "Search the internet and return a concise summary with full source URLs",
		promptGuidelines: [
			"Use web_search when the answer depends on information outside the repo, on current versions, or on external documentation.",
			"Pass a concrete purpose to web_search so the summary is scoped to what you actually need.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search the internet for" }),
			purpose: Type.Optional(
				Type.String({ description: "Why the information is needed, so the summary is scoped" }),
			),
			provider: Type.Optional(
				StringEnum(["opencode-go", "openrouter", "openai-codex", "anthropic"] as const, {
					description: `Search provider; unset resolves settings.defaultProvider, then the first auth.json credential (preferring ${DEFAULT_PROVIDER}); override globally with ${PROVIDER_ENV_VAR}`,
				}),
			),
			model: Type.Optional(
				Type.String({ description: `Override the fast model used for the search (global default via ${MODEL_ENV_VAR})` }),
			),
			timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 120000)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			onUpdate?.({
				content: [{ type: "text", text: `Searching: ${params.query}` }],
				details: { query: params.query, status: "searching" },
			});

			const search = await runSearch(params, signal);

			return {
				content: [{ type: "text", text: formatResult(search) }],
				details: {
					query: search.query,
					provider: search.provider,
					model: search.model,
					status: "done",
				},
			};
		},
	});

	pi.registerCommand("web-search", {
		description: 'Run a native web search (/web-search "<query>" [--purpose "<why>"])',
		handler: async (args, ctx) => {
			const input = parseCommandArgs(args ?? "");
			if (!input.query) {
				if (ctx.hasUI) {
					ctx.ui.notify('Usage: /web-search "<query>" [--purpose "<why>"]', "info");
				}
				return;
			}

			if (ctx.hasUI) ctx.ui.setStatus("web-search", `searching: ${input.query}`);
			try {
				const search = await runSearch(input, ctx.signal);
				await pi.sendUserMessage(
					`Native web search result for "${search.query}" (${search.provider}/${search.model}):\n\n${search.result}`,
				);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`web-search failed: ${(error as Error).message}`, "error");
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("web-search", undefined);
			}
		},
	});
}

export const __test__ = {
	resolveScriptPath,
	scriptCandidates,
	resolveProvider,
	resolveModel,
	buildSearchArgs,
};