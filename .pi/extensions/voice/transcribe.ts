/**
 * Transcription for the voice extension: upload the fetched m4a to an
 * OpenAI-compatible `/audio/transcriptions` endpoint and return the text.
 *
 * Two policies shape this file:
 *
 * - The key decides the route. An explicit `apiKey` always wins (config.ts
 *   folds PI_VOICE_API_KEY into that field). The ambient OpenAI fallbacks —
 *   `OPENAI_API_KEY`, the model registry's OpenAI key — are only consulted
 *   when `baseUrl` is the OpenAI default, so one provider's credential is
 *   never sent to another endpoint. A custom endpoint without an explicit
 *   key is called unauthenticated: self-hosted servers commonly need none,
 *   and a cloud one answers 401 in plain words.
 * - The upload is the one place the extension can be billed twice. A 400
 *   that names `response_format` gets exactly one retry with `text` (some
 *   compatible servers reject `json`); nothing else is retried.
 *
 * The audio arrives as a Buffer and leaves as a Blob, so nothing here touches
 * the filesystem and the whole module is testable with a fake fetch. Failures
 * are TranscribeErrors tagged with `failure`, so the caller only has to catch.
 */

import { DEFAULT_CONFIG, type VoiceConfig } from "./config.ts";
import { describeError, firstLine } from "./util.ts";

/** OpenAI's documented upload cap for /audio/transcriptions. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The default baseUrl; only this endpoint gets the ambient-key fallbacks. */
export const OPENAI_DEFAULT_BASE_URL = DEFAULT_CONFIG.baseUrl;

export type TranscribeFailure = "too-large" | "network" | "http" | "empty";

export class TranscribeError extends Error {
	readonly failure: TranscribeFailure;
	/** HTTP status, when the failure came from a response. */
	readonly status?: number;

	constructor(failure: TranscribeFailure, message: string, options: { status?: number; cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "TranscribeError";
		this.failure = failure;
		if (options.status !== undefined) this.status = options.status;
	}
}

export interface ModelRegistryLike {
	getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface ResolveApiKeyOptions {
	config: Pick<VoiceConfig, "apiKey" | "baseUrl">;
	env?: NodeJS.ProcessEnv;
	modelRegistry?: ModelRegistryLike;
}

/**
 * Resolve the bearer token for the transcription POST. `config.apiKey`
 * already covers voice.json and PI_VOICE_API_KEY. OPENAI_API_KEY and the
 * registry's OpenAI key are fallbacks for the OpenAI default baseUrl only.
 */
export async function resolveApiKey(options: ResolveApiKeyOptions): Promise<string | undefined> {
	const { apiKey, baseUrl } = options.config;
	if (apiKey) return apiKey;
	if (baseUrl !== OPENAI_DEFAULT_BASE_URL) return undefined;
	const env = options.env ?? process.env;
	const fromEnv = env.OPENAI_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const key = await options.modelRegistry?.getApiKeyForProvider("openai");
		return key?.trim() || undefined;
	} catch {
		// A registry that cannot answer counts as no key; the request either
		// proceeds unauthenticated or fails with the API's own 401 message.
		return undefined;
	}
}

export interface TranscribeRequest {
	audio: Buffer;
	/** Multipart filename; its extension is what tells the API the format. */
	fileName: string;
	config: Pick<VoiceConfig, "baseUrl" | "model" | "language" | "prompt" | "timeoutMs">;
	apiKey?: string;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
}

/** Reject locally what the API would reject only after a full upload. */
export function assertUploadSize(bytes: number): void {
	if (bytes > MAX_UPLOAD_BYTES) {
		throw new TranscribeError(
			"too-large",
			`refusing to upload ${bytes} bytes: /audio/transcriptions accepts at most ${MAX_UPLOAD_BYTES} (25 MB)`,
		);
	}
}

function buildFormData(request: TranscribeRequest, responseFormat: "json" | "text"): FormData {
	const config = request.config;
	const form = new FormData();
	form.append("file", new Blob([request.audio], { type: "audio/mp4" }), request.fileName);
	form.append("model", config.model);
	form.append("response_format", responseFormat);
	if (config.language) form.append("language", config.language);
	if (config.prompt) form.append("prompt", config.prompt);
	return form;
}

interface PostOutcome {
	status: number;
	ok: boolean;
	statusText: string;
	body: string;
}

/** One attempt either produced a response or a failure, never both. */
type PostAttempt = { ok: true; outcome: PostOutcome } | { ok: false; failure: TranscribeError };

async function postOnce(
	endpoint: string,
	request: TranscribeRequest,
	responseFormat: "json" | "text",
): Promise<PostAttempt> {
	const timeout = AbortSignal.timeout(request.config.timeoutMs);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	try {
		const response = await (request.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers: request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : undefined,
			body: buildFormData(request, responseFormat),
			signal,
		});
		let body = "";
		try {
			body = await response.text();
		} catch (error) {
			// A body read that fails for any reason other than the abort is
			// reported through the status below; the abort is classified next.
			if (signal.aborted) throw error;
		}
		return { ok: true, outcome: { status: response.status, ok: response.ok, statusText: response.statusText, body } };
	} catch (error) {
		if (request.signal?.aborted) {
			return {
				ok: false,
				failure: new TranscribeError("network", "the transcription request was cancelled", { cause: error }),
			};
		}
		if (timeout.aborted) {
			return {
				ok: false,
				failure: new TranscribeError(
					"network",
					`the transcription request timed out after ${request.config.timeoutMs} ms`,
					{ cause: error },
				),
			};
		}
		return {
			ok: false,
			failure: new TranscribeError("network", `the transcription request failed: ${firstLine(describeError(error))}`, {
				cause: error,
			}),
		};
	}
}

function httpFailure(outcome: PostOutcome): TranscribeError {
	const detail = firstLine(outcome.body).slice(0, 200) || outcome.statusText || "no response body";
	return new TranscribeError("http", `the transcription API answered HTTP ${outcome.status}: ${detail}`, {
		status: outcome.status,
	});
}

function extractText(body: string, responseFormat: "json" | "text"): string {
	if (responseFormat === "text") return body.trim();
	try {
		const parsed = JSON.parse(body) as { text?: unknown };
		return typeof parsed.text === "string" ? parsed.text.trim() : "";
	} catch {
		return "";
	}
}

function transcriptOrThrow(outcome: PostOutcome, responseFormat: "json" | "text"): string {
	const text = extractText(outcome.body, responseFormat);
	if (text) return text;
	const detail = firstLine(outcome.body).slice(0, 200);
	throw new TranscribeError("empty", `the transcription API returned no text${detail ? `: ${detail}` : ""}`);
}

/**
 * POST the recording and return the transcript. The first attempt sends
 * `response_format: json`; exactly one retry with `text` follows a 400 that
 * names it. Every other failure is thrown as a TranscribeError.
 */
export async function transcribeAudio(request: TranscribeRequest): Promise<string> {
	assertUploadSize(request.audio.length);
	const endpoint = `${request.config.baseUrl}/audio/transcriptions`;

	const first = await postOnce(endpoint, request, "json");
	if (!first.ok) throw first.failure;
	if (first.outcome.ok) return transcriptOrThrow(first.outcome, "json");

	if (first.outcome.status === 400 && /response_format/.test(first.outcome.body)) {
		const retry = await postOnce(endpoint, request, "text");
		if (!retry.ok) throw retry.failure;
		if (retry.outcome.ok) return transcriptOrThrow(retry.outcome, "text");
		throw httpFailure(retry.outcome);
	}
	throw httpFailure(first.outcome);
}
