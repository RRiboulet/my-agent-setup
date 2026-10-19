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

import { parseShortcutIds } from "./shortcut.ts";

export const CONFIG_BASENAME = "voice.json";

/** The recorder inside Termux, pinned as verified 2026-10-15. */
export const DEFAULT_RECORDER_PATH = "/data/data/com.termux/files/usr/bin/termux-microphone-record";

/** The recorder path reaches the phone inside a shell string, so pin its shape:
 * an absolute path of alphanumerics, slashes, dots, underscores and hyphens —
 * nothing a shell could interpret. */
export const RECORDER_PATH_PATTERN = /^\/[a-zA-Z0-9/_.-]+$/;

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

/**
 * The default shortcut(s), as pi key ids. `ctrl+shift+r` is only distinct from
 * `ctrl+r` under the Kitty keyboard protocol, so it never fires on a legacy
 * terminal — including the phone's. `alt+r` is the legacy-expressible fallback
 * (Termux sends ESC + r) and needs no Kitty negotiation, so it is what makes
 * the toggle reachable from the phone's soft keyboard. Both are bound on every
 * terminal; neither is reserved, so neither shadows a built-in editor action.
 */
export const DEFAULT_SHORTCUTS: readonly string[] = ["ctrl+shift+r", "alt+r"];

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
	/** Pi key ids that toggle the recorder; empty disables the shortcut. */
	shortcut: string[];
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
	// A fresh array, not the shared `DEFAULT_SHORTCUTS`: `loadConfig` shallow-
	// copies `DEFAULT_CONFIG`, so a shared reference would be one mutation away
	// from changing every later run.
	shortcut: [...DEFAULT_SHORTCUTS],
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
	shortcut: "PI_VOICE_SHORTCUT",
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

/** A warning sink; the loader's `warn` and the config parser's are the same shape. */
type Warn = (message: string) => void;

/**
 * A layer has nothing to say about a field, so the value already there stands.
 * Distinct from `undefined`, which is a real value that clears an optional field
 * (a file `bitrateKbps: null`). The previous twin blocks encoded the same
 * distinction as "only assign when set", one `if` at a time.
 */
const LEAVE = Symbol("leave");

/** One field's two readings: a typed voice.json value, and an env string. */
interface FieldSpec {
	readonly key: keyof VoiceConfig;
	readonly env: string;
	fromFile(value: unknown, warn: Warn): unknown;
	fromEnv(value: string | undefined, warn: Warn): unknown;
}

/** The shape a recorder path must have, as a sentence for warning/error text. */
export const RECORDER_PATH_EXPECTATION = "an absolute path with only alphanumerics, '/', '_', '.' and '-'";

/** A missing, empty or non-string value leaves the field alone. Used for both
 * required fields (which keep their default) and optional ones (which stay
 * absent, so the defaults still compare equal). */
function stringField(key: keyof VoiceConfig, env: string): FieldSpec {
	const read = (value: unknown): unknown => str(value) ?? LEAVE;
	return { key, env, fromFile: read, fromEnv: read };
}

/** A trimmed string that must satisfy `pattern`, or the field warns and keeps
 * its previous value. Both layers quote the offending value: an env value can
 * carry newlines and control characters, which would otherwise forge log lines. */
function patternField(key: keyof VoiceConfig, env: string, pattern: RegExp, expectation: string): FieldSpec {
	const check = (raw: string, label: string, warn: Warn): unknown => {
		if (pattern.test(raw)) return raw;
		warn(`voice: ignoring ${label}: expected ${expectation}`);
		return LEAVE;
	};
	return {
		key,
		env,
		fromFile: (value, warn) => {
			const raw = str(value);
			return raw === undefined ? LEAVE : check(raw, `${key} ${JSON.stringify(raw)}`, warn);
		},
		fromEnv: (value, warn) => {
			const raw = str(value);
			return raw === undefined ? LEAVE : check(raw, `${env}=${JSON.stringify(raw)}`, warn);
		},
	};
}

/** As {@link stringField}, with trailing slashes stripped so the endpoint join
 * never produces a double slash. */
function baseUrlField(key: keyof VoiceConfig, env: string): FieldSpec {
	const read = (value: unknown): unknown => {
		const raw = str(value);
		return raw === undefined ? LEAVE : stripTrailingSlashes(raw);
	};
	return { key, env, fromFile: read, fromEnv: read };
}

/** A JSON boolean in the file; `parseEnvBool` for the env, where values are
 * strings and "false" must not read as present-means-on. */
function boolField(key: keyof VoiceConfig, env: string): FieldSpec {
	return {
		key,
		env,
		fromFile: (value) => (typeof value === "boolean" ? value : LEAVE),
		fromEnv: (value) => parseEnvBool(value) ?? LEAVE,
	};
}

/** An integer clamped to [min, max] and rounded, from either layer. */
function intField(key: keyof VoiceConfig, env: string, min: number, max: number): FieldSpec {
	const coerce = (value: number): number => Math.round(Math.min(max, Math.max(min, value)));
	return {
		key,
		env,
		fromFile: (value) => (typeof value === "number" && Number.isFinite(value) ? coerce(value) : LEAVE),
		fromEnv: (value) => {
			const parsed = parseEnvInt(value);
			return parsed === undefined ? LEAVE : coerce(parsed);
		},
	};
}

/** One or more pi key ids. A string (comma-separated) or an array of strings;
 * each is normalised and validated, and an entry that is not a key id warns and
 * is dropped. A value with no usable entry leaves the field alone, so a typo
 * cannot remove the shortcut. `[]` and `""` are accepted and disable it. */
function shortcutField(key: keyof VoiceConfig, env: string): FieldSpec {
	const read = (value: unknown, label: string, warn: Warn): unknown => {
		if (value === undefined || value === null) return LEAVE;
		// An explicitly empty setting disables the shortcut rather than warning:
		// the owner wrote it on purpose.
		if (typeof value === "string" && value.trim() === "") return [];
		if (Array.isArray(value) && value.length === 0) return [];
		// Any other type is a config mistake, not an empty setting: warn so it
		// cannot vanish silently.
		if (typeof value !== "string" && !Array.isArray(value)) {
			warn(`voice: ignoring ${label}: expected a pi key like "ctrl+shift+r"`);
			return LEAVE;
		}
		const ids = parseShortcutIds(value, label, warn);
		return ids.length > 0 ? ids : LEAVE;
	};
	return {
		key,
		env,
		fromFile: (value, warn) =>
			read(value, `shortcut ${JSON.stringify(value)}`, warn),
		fromEnv: (value, warn) => {
			if (value === undefined || value.trim() === "") return LEAVE;
			return read(value, `${env}=${JSON.stringify(value)}`, warn);
		},
	};
}

/** An optional positive integer. A file `null` clears it; a value that is not a
 * positive integer warns and is ignored. Each layer names the source the reader
 * saw — the JSON key, or the `PI_VOICE_*` variable. */
function bitrateField(key: keyof VoiceConfig, env: string): FieldSpec {
	return {
		key,
		env,
		fromFile: (value, warn) => {
			if (value === undefined) return LEAVE; // key absent: JSON has no `undefined`
			if (value === null) return undefined; // explicit clear
			const bitrate = positiveInt(value);
			if (bitrate !== undefined) return bitrate;
			warn(`voice: ignoring bitrateKbps ${JSON.stringify(value)}: expected a positive integer`);
			return LEAVE;
		},
		fromEnv: (value, warn) => {
			const parsed = parseEnvInt(value);
			if (parsed === undefined) return LEAVE;
			const bitrate = positiveInt(parsed);
			if (bitrate !== undefined) return bitrate;
			warn(`voice: ignoring ${env}=${value}: expected a positive integer`);
			return LEAVE;
		},
	};
}

/** Every configurable field, in the order the two hand-written passes applied
 * them. Adding a field is one entry here, plus its type and default. */
const FIELDS: readonly FieldSpec[] = [
	patternField("sshTarget", VOICE_ENV.sshTarget, /^[^-]/, "a value that does not start with '-'"),
	patternField("recorderPath", VOICE_ENV.recorderPath, RECORDER_PATH_PATTERN, RECORDER_PATH_EXPECTATION),
	intField("maxSeconds", VOICE_ENV.maxSeconds, MAX_SECONDS_MIN, MAX_SECONDS_MAX),
	bitrateField("bitrateKbps", VOICE_ENV.bitrateKbps),
	boolField("keepAudio", VOICE_ENV.keepAudio),
	boolField("autoSubmit", VOICE_ENV.autoSubmit),
	baseUrlField("baseUrl", VOICE_ENV.baseUrl),
	stringField("model", VOICE_ENV.model),
	stringField("apiKey", VOICE_ENV.apiKey),
	stringField("language", VOICE_ENV.language),
	stringField("prompt", VOICE_ENV.prompt),
	intField("timeoutMs", VOICE_ENV.timeoutMs, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
	shortcutField("shortcut", VOICE_ENV.shortcut),
];

export function loadConfig(options: LoadConfigOptions = {}): VoiceConfig {
	const env = options.env ?? process.env;
	const path = options.path ?? configPath(env);
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const file = readConfigFile(path, warn);

	const config: VoiceConfig = { ...DEFAULT_CONFIG };

	// Later layers win: the file first, then the environment. One loop over the
	// field table replaces the twin per-field blocks, so adding a field is one
	// entry there instead of a line in each hand-written pass.
	for (const field of FIELDS) {
		const fromFile = field.fromFile(file[field.key], warn);
		if (fromFile !== LEAVE) (config as Record<string, unknown>)[field.key] = fromFile;
		const fromEnv = field.fromEnv(env[field.env], warn);
		if (fromEnv !== LEAVE) (config as Record<string, unknown>)[field.key] = fromEnv;
	}

	// `shortcut` is the one array field, and the shallow copy above would leave
	// it shared with `DEFAULT_CONFIG`: copy it so a caller's mutation cannot
	// reach the default and, through it, every later run.
	config.shortcut = [...config.shortcut];

	return config;
}
