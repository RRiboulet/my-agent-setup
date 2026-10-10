// pocket — the pi extension entry point
//
// The extension is the operator-facing half: a `/pocket` command set that starts
// the gateway, mints pairing codes for a phone, and reports on the sessions the
// daemon is holding. It deliberately contains no durability of its own — every
// durable fact lives in the daemon's data directory — because pi can be restarted,
// upgraded, or killed from under it without any session losing its conversation.
//
// The daemon is a child of this process but not a *dependent* of it: it is spawned
// detached, with its own stdio pointed at the daemon log, so closing the laptop
// or quitting pi leaves the agent sessions running. That is the one design
// decision the whole setup rests on: a session that stops when the client stops is
// not a durable session, it is a remote desktop.
//
// Ports and tokens are read from the files the daemon writes, not guessed, so two
// terminals and a phone all end up talking to the same gateway.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readPocketConfig, DEFAULT_PORT, paths, DEFAULT_HOST, generateToken, effectiveToken } from "./config.ts";

interface CommandContext {
	ui: {
		notify: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

/** What `/pocket` prints, and what the phone is told to open. */
interface GatewayInfo {
	url: string;
	token: string | undefined;
	pid: number | undefined;
	dataRoot: string;
}

export default function pocketExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pocket", {
		description: "Run agent sessions from a phone: serve, pair, sessions, new, attach, detach",
		handler: async (args: string, ctx: unknown) => {
			const context = ctx as CommandContext;
			const [command, ...rest] = args.trim().split(/\s+/).filter((part) => part !== "");
			try {
				switch (command ?? "status") {
					case "serve":
						return await serve(context);
					case "stop":
						return await stop(context);
					case "pair":
						return await pair(context);
					case "devices":
						return await devices(context);
					case "revoke":
						return await revoke(context, rest[0] ?? "");
					case "sessions":
						return await listSessions(context);
					case "new":
						return await createSession(context, rest);
					case "attach":
						return await sessionAction(context, "start", rest[0] ?? "");
					case "detach":
						return await sessionAction(context, "stop", rest[0] ?? "");
					case "url":
						return showUrl(context);
					case "status":
					case "":
						return await status(context);
					default:
						context.ui.notify(`unknown /pocket command: ${command}`, "error");
				}
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

/* --- the gateway --------------------------------------------------------- */

async function serve(context: CommandContext): Promise<void> {
	const config = readPocketConfig();
	const running = gatewayInfo(config);
	if (running.pid !== undefined && processAlive(running.pid)) {
		context.ui.notify(`gateway already running (pid ${running.pid}) at ${running.url}`, "warning");
		await printHandoff(context, running);
		return;
	}

	const daemonFile = join(import.meta.dirname, "daemon.ts");
	if (!existsSync(daemonFile)) {
		context.ui.notify(`daemon not found at ${daemonFile}`, "error");
		return;
	}
	mkdirSync(config.dataRoot, { recursive: true });
	const logFile = paths.daemonLog(config.dataRoot);
	// The operator token is minted once and written with 0600. Minting it fresh on
	// every serve would work for a paired phone — that uses its own device
	// token — but the second `/pocket serve` would leave a daemon whose operator
	// credential nobody holds any more.
	const token = effectiveToken(config.token) ?? loadOrCreateOperatorToken(config.dataRoot);

	const child: ChildProcess = spawn(process.execPath, [daemonFile], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		cwd: config.agentDir,
		env: { ...process.env, PI_POCKET_TOKEN: token, PI_POCKET_HOST: config.host, PI_POCKET_PORT: String(config.port) },
	});
	child.unref();
	if (child.pid === undefined) {
		context.ui.notify(`gateway could not be started; see ${logFile}`, "error");
		return;
	}

	// Wait for the pid file, not the child handle: the file is written after the
	// port is bound and every session revived, which is the point at which the
	// gateway can actually answer a phone.
	for (let attempt = 1; attempt <= 100; attempt += 1) {
		await sleep(100);
		const info = gatewayInfo(config);
		if (info.pid !== undefined && processAlive(info.pid)) break;
	}
	const started = gatewayInfo(config);
	if (started.pid === undefined || !processAlive(started.pid)) {
		// The log is the only place that knows *why*: two daemons on one port is
		// the common case, and its message says "EADDRINUSE" where a bare "did
		// not start" leaves the operator guessing.
		context.ui.notify(`gateway did not start; see ${logFile}` + (lastLogLine(logFile) ?? ""), "error");
		return;
	}
	context.ui.notify(`gateway listening at ${started.url} (pid ${started.pid})`);
	await printHandoff(context, started);
}

async function stop(context: CommandContext): Promise<void> {
	const config = readPocketConfig();
	const info = gatewayInfo(config);
	if (info.pid === undefined || !processAlive(info.pid)) {
		context.ui.notify("gateway is not running");
		return;
	}
	// SIGTERM, not SIGKILL: the daemon's handler stops its sessions cleanly, and
	// pi's own session files are left in a resumable state either way.
	process.kill(info.pid, "SIGTERM");
	context.ui.notify(`gateway (pid ${info.pid}) asked to stop; sessions resume on the next serve`);
}

async function pair(context: CommandContext): Promise<void> {
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	const response = await fetch(`${gateway.url}/api/pairing`, {
		method: "POST",
		headers: authHeaders(gateway),
	});
	if (!response.ok) {
		context.ui.notify(`could not mint a pairing code: ${await response.text()}`, "error");
		return;
	}
	const { code, expiresAt } = (await response.json()) as { code: string; expiresAt: string };
	context.ui.notify(
		`pairing code ${code} — valid until ${new Date(expiresAt).toLocaleTimeString()}. Enter it on the phone at ${gateway.url}`,
	);
}

async function devices(context: CommandContext): Promise<void> {
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	const response = await fetch(`${gateway.url}/api/devices`, { headers: authHeaders(gateway) });
	if (!response.ok) {
		context.ui.notify(`could not list devices: ${await response.text()}`, "error");
		return;
	}
	const devices = (await response.json()) as Array<{ id: string; label: string; createdAt: string }>;
	if (devices.length === 0) {
		context.ui.notify("no phones paired yet — run /pocket pair");
		return;
	}
	for (const device of devices) context.ui.notify(`${device.label} — ${device.id} (paired ${device.createdAt.slice(0, 10)})`);
}

async function revoke(context: CommandContext, id: string): Promise<void> {
	if (id === "") {
		context.ui.notify("usage: /pocket revoke <device id>", "error");
		return;
	}
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	const response = await fetch(`${gateway.url}/api/devices/${encodeURIComponent(id)}`, {
		method: "DELETE",
		headers: authHeaders(gateway),
	});
	if (!response.ok) {
		context.ui.notify(`could not revoke: ${await response.text()}`, "error");
		return;
	}
	context.ui.notify(`revoked ${id}`);
}

async function showUrl(context: CommandContext): Promise<void> {
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	await printHandoff(context, gateway);
}

async function status(context: CommandContext): Promise<void> {
	const config = readPocketConfig();
	const info = gatewayInfo(config);
	if (info.pid === undefined || !processAlive(info.pid)) {
		context.ui.notify(`gateway not running — /pocket serve (would bind ${DEFAULT_HOST}:${config.port})`);
		return;
	}
	const store = await readSessions(config);
	context.ui.notify(
		`gateway pid ${info.pid} at ${info.url}; ${store.length} session(s); data in ${info.dataRoot}`,
	);
}

/* --- sessions ------------------------------------------------------------ */

async function listSessions(context: CommandContext): Promise<void> {
	const config = readPocketConfig();
	const store = await readSessions(config);
	if (store.length === 0) {
		context.ui.notify("no sessions — /pocket new <project directory>");
		return;
	}
	for (const entry of store) {
		context.ui.notify(
			`${entry.id}  ${entry.name || entry.cwd}  ${entry.cwd}${entry.autostart === false ? "  (autostart off)" : ""}`,
		);
	}
}

async function createSession(context: CommandContext, rest: string[]): Promise<void> {
	const flags = new Map<string, string>();
	const positional: string[] = [];
	for (let index = 0; index < rest.length; index += 1) {
		const part = rest[index];
		if (part === "-m" && index + 1 < rest.length) {
			flags.set("model", rest[index + 1]);
			index += 1;
			continue;
		}
		positional.push(part);
	}
	const cwd = positional[0];
	const name = positional.slice(1).join(" ");
	if (cwd === undefined) {
		context.ui.notify("usage: /pocket new <project directory> [name...] [-m provider/model]", "error");
		return;
	}
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	const response = await fetch(`${gateway.url}/api/sessions`, {
		method: "POST",
		headers: { ...authHeaders(gateway), "Content-Type": "application/json" },
		body: JSON.stringify({ cwd, name, model: flags.get("model") }),
	});
	if (!response.ok) {
		context.ui.notify(`could not create the session: ${await response.text()}`, "error");
		return;
	}
	const entry = (await response.json()) as { id: string; name: string; cwd: string };
	context.ui.notify(`created ${entry.id} (${entry.name || entry.cwd}) — open it from the phone`);
}

async function sessionAction(context: CommandContext, action: "start" | "stop", id: string): Promise<void> {
	if (id === "") {
		context.ui.notify(`usage: /pocket ${action} <session id>`, "error");
		return;
	}
	const gateway = await ensureGateway(context);
	if (gateway === undefined) return;
	const response = await fetch(`${gateway.url}/api/sessions/${encodeURIComponent(id)}/${action}`, {
		method: "POST",
		headers: authHeaders(gateway),
	});
	if (!response.ok) {
		context.ui.notify(`could not ${action} ${id}: ${await response.text()}`, "error");
		return;
	}
	const payload = (await response.json()) as { status: { live: boolean } };
	context.ui.notify(`${id} is now ${payload.status.live ? "attached" : "stopped"}`);
}

/* --- the pieces ---------------------------------------------------------- */

/** Where the gateway is, from the files it wrote, plus how to talk to it. */
function gatewayInfo(config: ReturnType<typeof readPocketConfig>): GatewayInfo {
	const port = readNumber(paths.portFile(config.dataRoot));
	const pid = readNumber(paths.pidFile(config.dataRoot));
	// The port file is the authority on the port; fall back to the configured one
	// so the printed URL is still right when the daemon has not started yet.
	const url = `http://${config.host === DEFAULT_HOST ? "127.0.0.1" : config.host}:${port ?? config.port}`;
	return { url, token: config.token, pid, dataRoot: config.dataRoot };
}

/** The last line of a log file, so a failure can carry its own reason. */
function lastLogLine(file: string): string | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		return lines.length === 0 || lines[lines.length - 1].trim() === "" ? undefined : ` — ${lines[lines.length - 1].trim()}`;
	} catch {
		return undefined;
	}
}

function readNumber(file: string): number | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const parsed = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function ensureGateway(context: CommandContext): Promise<GatewayInfo | undefined> {
	const config = readPocketConfig();
	const info = gatewayInfo(config);
	if (info.pid !== undefined && processAlive(info.pid)) return info;
	await serve(context);
	const started = gatewayInfo(config);
	if (started.pid === undefined || !processAlive(started.pid)) return undefined;
	return started;
}

/**
 * The token the extension uses to talk to its own daemon. The daemon only
 * accepts the operator token for pairing and device management, so a request
 * without one is refused with 403 and the operator knows to run `/pocket serve`
 * once.
 */
function authHeaders(info: GatewayInfo): Record<string, string> {
	return info.token === undefined ? {} : { Authorization: `Bearer ${info.token}` };
}

async function printHandoff(context: CommandContext, info: GatewayInfo): Promise<void> {
	context.ui.notify(
		[
			`open ${info.url} on the phone`,
			`data lives in ${info.dataRoot}`,
			info.token === undefined ? "no operator token is set" : "operator token saved to a 0600 file in the data root",
		].join(" · "),
	);
}

async function readSessions(config: ReturnType<typeof readPocketConfig>): Promise<Array<{ id: string; name: string; cwd: string; autostart?: boolean }>> {
	const file = paths.registry(config.dataRoot);
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessions?: Array<{ id: string; name: string; cwd: string; autostart?: boolean }> };
		return parsed.sessions ?? [];
	} catch {
		return [];
	}
}

/**
 * The operator token, minted once per gateway and kept in a 0600 file beside the
 * pid file. Reading it back is what makes a second `/pocket serve` after a
 * reboot talk to the same daemon with the same credentials.
 */
function loadOrCreateOperatorToken(dataRoot: string): string {
	const file = paths.tokenFile(dataRoot);
	try {
		if (existsSync(file)) {
			const existing = readFileSync(file, "utf8").trim();
			if (existing !== "") return existing;
		}
	} catch {
		// fall through and mint a new one
	}
	const token = generateToken();
	try {
		writeFileSync(file, `${token}\n`, { mode: 0o600 });
	} catch {
		// The file is a convenience for the next run; if the data root is not
		// writable the daemon still starts, just with a token that must be read
		// from PI_POCKET_TOKEN.
	}
	return token;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { gatewayInfo };
