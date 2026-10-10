// pocket — configuration
//
// Everything the daemon needs is read from PI_POCKET_* environment variables at
// construction time, and nothing else. The extension that spawns the daemon and
// the daemon itself both go through `readPocketConfig`, so a setting cannot mean
// one thing in the TUI and another in the process that actually binds a port.
//
// The one rule worth stating up front, because it is the difference between a
// private tool and an internet-exposed shell: binding to anything but loopback
// without a token is refused (checkAccessibleHost below). A prompt-injecting
// agent session behind an unauthenticated HTTP endpoint is a remote shell for
// whoever finds the port, so the daemon fails loudly instead of guessing.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_PI_BIN = "pi";

/** Directory name under the agent dir. Everything durable lives here. */
export const DATA_DIR_NAME = "pocket";
export const DAEMON_LOG_NAME = "daemon.log";
export const PID_FILE_NAME = "daemon.pid";
export const PORT_FILE_NAME = "daemon.port";
export const TOKEN_FILE_NAME = "daemon.token";

/** Session registry file, inside DATA_DIR_NAME. */
export const REGISTRY_FILE_NAME = "sessions.json";
/** One directory per live session: pi's own session file lives in it. */
export const SESSIONS_DIR_NAME = "sessions";
/** Replay buffers, one JSONL per session. */
export const JOURNAL_DIR_NAME = "journal";
/** Paired devices, one line per phone: labels, hashes, revocations. */
export const DEVICES_FILE_NAME = "devices.json";
/** The one-time pairing code awaiting exchange for a device token. */
export const PAIRING_FILE_NAME = "pairing.json";

export const DEFAULT_JOURNAL_MAX = 2000;
export const DEFAULT_RESPAWN_MAX = 3;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

export interface PocketConfig {
	/** Root of the agent's own state: sessions, cache, the pocket tree. */
	agentDir: string;
	/** Host the gateway binds. Loopback unless you know what you are doing. */
	host: string;
	port: number;
	/**
	 * Bearer token required for every request. Always set by the extension when
	 * it spawns a daemon (see index.ts); only a hand-started daemon may run
	 * without one, and only on loopback.
	 */
	token: string | undefined;
	/** The `pi` binary the gateway spawns per session. Overridden in tests. */
	piBin: string;
	/** <agentDir>/pocket */
	dataRoot: string;
	/** ntfy.sh topic (or any ntfy-compatible server) for push notifications. */
	ntfyTopic: string | undefined;
	ntfyServer: string;
	/** Records kept per session in the replay journal before the oldest are cut. */
	journalMax: number;
	/** Consecutive respawn attempts for a child that died on its own. */
	respawnMax: number;
	/** How long an unanswered RPC request may wait before it is given up on. */
	requestTimeoutMs: number;
}

function readString(name: string): string | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** A configured-but-empty value means "not configured" for secrets and hosts. */
function emptyIsUndefined(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function readInt(name: string, fallback: number): number {
	const raw = readString(name);
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		console.error(`[pocket] ${name}="${raw}" is not a non-negative whole number; using ${fallback}.`);
		return fallback;
	}
	return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
	const raw = readString(name)?.toLowerCase();
	if (raw === undefined) return fallback;
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * The agent dir: PI_CODING_AGENT_DIR when set, else ~/.pi/agent. This is the
 * same variable pi itself reads, so the daemon's tree is the one the user
 * already backs up rather than a second location.
 */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured;
	return path.join(homedir(), ".pi", "agent");
}

export function readPocketConfig(env: NodeJS.ProcessEnv = process.env): PocketConfig {
	const agentDir = defaultAgentDir(env);
	return {
		agentDir,
		host: readString("PI_POCKET_HOST") ?? DEFAULT_HOST,
		port: readInt("PI_POCKET_PORT", DEFAULT_PORT),
		// An empty PI_POCKET_TOKEN is read as "no token", not as "the token is
		// the empty string": the latter would satisfy checkAccessibleHost while
		// authenticating nobody, which is the worse of the two mistakes.
		token: emptyIsUndefined(readString("PI_POCKET_TOKEN")),
		piBin: readString("PI_POCKET_PI_BIN") ?? DEFAULT_PI_BIN,
		dataRoot: path.join(agentDir, DATA_DIR_NAME),
		ntfyTopic: readString("PI_POCKET_NTFY_TOPIC"),
		ntfyServer: readString("PI_POCKET_NTFY_SERVER") ?? DEFAULT_NTFY_SERVER,
		journalMax: readInt("PI_POCKET_JOURNAL_MAX", DEFAULT_JOURNAL_MAX),
		respawnMax: readInt("PI_POCKET_RESPAWN_MAX", DEFAULT_RESPAWN_MAX),
		requestTimeoutMs: readInt("PI_POCKET_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
	};
}

/** Paths inside the data root, so no caller has to know the layout. */
export const paths = {
	registry: (dataRoot: string) => path.join(dataRoot, REGISTRY_FILE_NAME),
	sessionsDir: (dataRoot: string) => path.join(dataRoot, SESSIONS_DIR_NAME),
	sessionDir: (dataRoot: string, sessionId: string) => path.join(dataRoot, SESSIONS_DIR_NAME, sessionId),
	journalDir: (dataRoot: string) => path.join(dataRoot, JOURNAL_DIR_NAME),
	journalFile: (dataRoot: string, sessionId: string) => path.join(dataRoot, JOURNAL_DIR_NAME, `${sessionId}.jsonl`),
	devices: (dataRoot: string) => path.join(dataRoot, DEVICES_FILE_NAME),
	pairing: (dataRoot: string) => path.join(dataRoot, PAIRING_FILE_NAME),
	pidFile: (dataRoot: string) => path.join(dataRoot, PID_FILE_NAME),
	portFile: (dataRoot: string) => path.join(dataRoot, PORT_FILE_NAME),
	tokenFile: (dataRoot: string) => path.join(dataRoot, TOKEN_FILE_NAME),
	daemonLog: (dataRoot: string) => path.join(dataRoot, DAEMON_LOG_NAME),
} as const;

/**
 * True for a host only the local machine can reach. "0.0.0.0" is NOT
 * loopback: it means every interface, which is exactly the case that needs a
 * token, so it is reported as remote.
 */
export function isLoopbackHost(host: string): boolean {
	const normalized = host.replace(/^\[|\]$/g, "");
	if (normalized === "::1") return true;
	if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
	if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
	return false;
}

export class PocketConfigError extends Error {}

/**
 * Refuse the one configuration that turns the gateway into a public shell: a
 * non-loopback bind with no token. Everything else is allowed, including a
 * non-loopback bind WITH a token (Tailscale, a LAN, an SSH tunnel), which is
 * the documented way to reach this from a phone.
 */
/**
 * The token that actually authenticates.
 *
 * An empty string is the absence of a token, not a credential, so it collapses
 * to undefined here rather than at every branch that asks whether one is set.
 * This matters at the environment boundary, where `PI_POCKET_TOKEN=` is a line
 * someone typed meaning "no token", and it matters again for a caller that
 * builds a config object directly.
 */
export function effectiveToken(token: string | undefined): string | undefined {
	return token !== undefined && token !== "" ? token : undefined;
}

export function checkAccessibleHost(config: { host: string; token: string | undefined }): void {
	if (effectiveToken(config.token) !== undefined) return;
	if (isLoopbackHost(config.host)) return;
	throw new PocketConfigError(
		`pocket refuses to bind ${config.host} without a token: set PI_POCKET_TOKEN (or PI_POCKET_HOST=${DEFAULT_HOST} for loopback).`,
	);
}

/** A fresh token, used when the extension starts a daemon nobody configured. */
export function generateToken(): string {
	return randomBytes(24).toString("base64url");
}

export { readBoolean as readBooleanEnv };
