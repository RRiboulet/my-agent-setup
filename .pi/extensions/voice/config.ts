/**
 * Configuration for the voice extension: dictation with the phone as the
 * microphone (`/voice` starts `termux-microphone-record` over ssh, stops it,
 * fetches the audio, and hands it to transcription).
 *
 * Resolution order, later wins:
 *   1. DEFAULTS
 *   2. ~/.pi/agent/voice.json
 *   3. environment (PI_VOICE_*)
 *
 * The file is optional and every field degrades to its default, so a machine
 * that never writes one still works. A malformed file warns once and is
 * ignored rather than throwing: `/voice` is registered unconditionally, and a
 * bad config must not take the command away.
 *
 * The ssh target is a host alias from ~/.ssh/config, not a URL. The recorder
 * path is absolute on purpose — the non-interactive ssh PATH does not include
 * Termux's `usr/bin`, so a bare `termux-microphone-record` fails there.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_BASENAME = "voice.json";

/** The recorder inside Termux, pinned as verified 2026-10-15. */
export const DEFAULT_RECORDER_PATH = "/data/data/com.termux/files/usr/bin/termux-microphone-record";

/** Local capture cap. The plan's bound: long enough for a dictation, short
 * enough that a forgotten recording cannot fill the phone. Never 0 — the
 * recorder treats `-l <= 0` as "unlimited". */
export const MAX_SECONDS_MIN = 1;
export const MAX_SECONDS_MAX = 900;
export const MAX_SECONDS_DEFAULT = 120;

/** Upload timeout bounds for the transcription POST. */
export const TIMEOUT_MIN_MS = 5_000;
export const TIMEOUT_MAX_MS = 300_000;
export const TIMEOUT_DEFAULT_MS = 60_000;

export interface VoiceConfig {
	/** ssh host alias for the phone (user@host or an entry in ~/.ssh/config). */
	sshTarget: string;
	/** Absolute path to termux-microphone-record on the phone. */
	recorderPath: string;
	/** Recording cap in seconds, passed to the phone as `-l`. Clamped [1, 900]. */
	maxSeconds: number;
	/** Optional encoder bitrate in kbps (`-b`). Unset means the device default. */
	bitrateKbps?: number;
	/** Keep the local m4a after a successful transcription (debugging). */
	keepAudio: boolean;
	/** Submit the transcript as a prompt instead of pasting it at the cursor. */
	autoSubmit: boolean;
	/** OpenAI-compatible API root, no trailing slash. */
	baseUrl: string;
	/** Transcription model. */
	model: string;
	/** Explicit API key; the environment and the model registry are fallbacks. */
	apiKey?: string;
	/** Optional language hint for transcription. */
	language?: string;
	/** Optional prompt (vocabulary/style) for transcription. */
	prompt?: string;
	/** Upload timeout in milliseconds. Clamped [5000, 300000]. */
	timeoutMs: number;
}

export const DEFAULT_CONFIG: VoiceConfig = {
	sshTarget: "phone",
	recorderPath: DEFAULT_RECORDER_PATH,
	maxSeconds: MAX_SECONDS_DEFAULT,
	keepAudio: false,
	autoSubmit: false,
	baseUrl: "https://api.openai.com/v1",
	model: "gpt-4o-transcribe",
	timeoutMs: TIMEOUT_DEFAULT_MS,
};

/** Environment overrides, one per field. Values win over the file. */
export const VOICE_ENV = {
	sshTarget: "PI_VOICE_SSH_TARGET",
	recorderPath: "PI_VOICE_RECORDER_PATH",
	maxSeconds: "PI_VOICE_MAX_SECONDS",
	bitrateKbps: "PI_VOICE_BITRATE_KBPS",
	keepAudio: "PI_VOICE_KEEP_AUDIO",
	autoSubmit: "PI_VOICE_AUTO_SUBMIT",
	baseUrl: "PI_VOICE_BASE_URL",
	model: "PI_VOICE_MODEL",
	apiKey: "PI_VOICE_API_KEY",
	language: "PI_VOICE_LANGUAGE",
	prompt: "PI_VOICE_PROMPT",
	timeoutMs: "PI_VOICE_TIMEOUT_MS",
} as const;

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), CONFIG_BASENAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** API roots are joined with "/audio/transcriptions", so a trailing slash
 * would produce a double slash. Normalise once here. */
function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

/**
 * Read the config file. A missing file is the normal first-run state and stays
 * silent; a file that exists but cannot be parsed is a config the owner meant
 * to apply and did not, so it warns once rather than vanishing.
 */
export function readConfigFile(path: string, warn?: (message: string) => void): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) {
			warn?.(`voice: ignoring ${path}: expected a JSON object`);
			return {};
		}
		return parsed;
	} catch (error) {
		warn?.(`voice: ignoring malformed ${path}: ${(error as Error).message}`);
		return {};
	}
}

/** Env booleans are booleans, not merely present: "false" must not flip the
 * switch on, and an unrecognised value is ignored rather than guessed. */
export function parseEnvBool(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
	return undefined;
}

function parseEnvInt(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export interface LoadConfigOptions {
	env?: NodeJS.ProcessEnv;
	path?: string;
	/** Injected by tests so the loader itself is covered without touching $HOME. */
	warn?: (message: string) => void;
}

export function loadConfig(options: LoadConfigOptions = {}): VoiceConfig {
	const env = options.env ?? process.env;
	const path = options.path ?? configPath(env);
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const file = readConfigFile(path, warn);

	const config: VoiceConfig = { ...DEFAULT_CONFIG };

	if (Object.keys(file).length > 0) {
		config.sshTarget = str(file.sshTarget) ?? config.sshTarget;
		config.recorderPath = str(file.recorderPath) ?? config.recorderPath;
		config.maxSeconds = Math.round(num(file.maxSeconds, config.maxSeconds, MAX_SECONDS_MIN, MAX_SECONDS_MAX));
		if ("bitrateKbps" in file) {
			if (file.bitrateKbps === undefined || file.bitrateKbps === null) {
				config.bitrateKbps = undefined;
			} else {
				const bitrate = positiveInt(file.bitrateKbps);
				if (bitrate !== undefined) config.bitrateKbps = bitrate;
				else warn?.(`voice: ignoring bitrateKbps ${JSON.stringify(file.bitrateKbps)}: expected a positive integer`);
			}
		}
		if ("keepAudio" in file) config.keepAudio = bool(file.keepAudio, config.keepAudio);
		if ("autoSubmit" in file) config.autoSubmit = bool(file.autoSubmit, config.autoSubmit);
		const baseUrl = str(file.baseUrl);
		if (baseUrl) config.baseUrl = stripTrailingSlashes(baseUrl);
		config.model = str(file.model) ?? config.model;
		// Optional fields are only assigned when set: `apiKey: undefined` would
		// be an own property, and the defaults would stop comparing equal.
		const fileApiKey = str(file.apiKey);
		if (fileApiKey) config.apiKey = fileApiKey;
		const fileLanguage = str(file.language);
		if (fileLanguage) config.language = fileLanguage;
		const filePrompt = str(file.prompt);
		if (filePrompt) config.prompt = filePrompt;
		config.timeoutMs = Math.round(num(file.timeoutMs, config.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS));
	}

	// Environment wins so a one-off run can be redirected without editing files.
	config.sshTarget = str(env[VOICE_ENV.sshTarget]) ?? config.sshTarget;
	config.recorderPath = str(env[VOICE_ENV.recorderPath]) ?? config.recorderPath;
	const envMax = parseEnvInt(env[VOICE_ENV.maxSeconds]);
	if (envMax !== undefined) config.maxSeconds = Math.round(num(envMax, config.maxSeconds, MAX_SECONDS_MIN, MAX_SECONDS_MAX));
	const envBitrate = parseEnvInt(env[VOICE_ENV.bitrateKbps]);
	if (envBitrate !== undefined) {
		const bitrate = positiveInt(envBitrate);
		if (bitrate !== undefined) config.bitrateKbps = bitrate;
		else warn?.(`voice: ignoring ${VOICE_ENV.bitrateKbps}=${env[VOICE_ENV.bitrateKbps]}: expected a positive integer`);
	}
	const envKeepAudio = parseEnvBool(env[VOICE_ENV.keepAudio]);
	if (envKeepAudio !== undefined) config.keepAudio = envKeepAudio;
	const envAutoSubmit = parseEnvBool(env[VOICE_ENV.autoSubmit]);
	if (envAutoSubmit !== undefined) config.autoSubmit = envAutoSubmit;
	const envBaseUrl = str(env[VOICE_ENV.baseUrl]);
	if (envBaseUrl) config.baseUrl = stripTrailingSlashes(envBaseUrl);
	config.model = str(env[VOICE_ENV.model]) ?? config.model;
	const envApiKey = str(env[VOICE_ENV.apiKey]);
	if (envApiKey) config.apiKey = envApiKey;
	const envLanguage = str(env[VOICE_ENV.language]);
	if (envLanguage) config.language = envLanguage;
	const envPrompt = str(env[VOICE_ENV.prompt]);
	if (envPrompt) config.prompt = envPrompt;
	const envTimeout = parseEnvInt(env[VOICE_ENV.timeoutMs]);
	if (envTimeout !== undefined) config.timeoutMs = Math.round(num(envTimeout, config.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS));

	return config;
}
