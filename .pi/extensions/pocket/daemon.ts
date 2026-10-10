// pocket — the gateway daemon
//
// This process is the phone-facing half of the setup, and the only half a phone
// ever talks to. It binds a port, holds the credentials, speaks a small JSON API
// plus one Server-Sent-Events stream per session, and holds nothing that matters:
// every durable fact lives in the registry, the journals and pi's own session
// files, so this process can be killed, upgraded or restarted without a client
// noticing beyond one reconnect.
//
// Two things here are security boundaries rather than plumbing, and they run
// before authentication on purpose:
//
//   1. the Host header is checked, because a daemon bound to loopback and reached
//      through a DNS rebinding attack is a request to 127.0.0.1 carrying the
//      attacker's site name, and the same-origin guarantees the browser relies on
//      then stop applying;
//   2. cross-origin writes are refused, because the phone client is same-origin
//      and anything else is a page on the internet trying to use the session.
//
// Everything the daemon sends leaves through `maskValue`, so a token or a private
// key that shows up in tool output does not leave the machine behind it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPocketConfig, checkAccessibleHost, effectiveToken, paths, type PocketConfig } from "./config.ts";
import { SessionStore, PocketConfigError, assertSafeSessionId } from "./store.ts";
import { SessionJournal } from "./journal.ts";
import { Supervisor } from "./supervisor.ts";
import { AuthStore, maskValue, AuthError, type DeviceRecord } from "./auth.ts";

interface Caller {
	kind: "local" | "master" | "device";
	device?: DeviceRecord | undefined;
}

interface RequestContext {
	req: IncomingMessage;
	res: ServerResponse;
	/** Captured path segments, e.g. `id`. */
	params: Record<string, string>;
	query: URLSearchParams;
	config: PocketConfig;
	store: SessionStore;
	supervisor: Supervisor;
	auth: AuthStore;
	caller: Caller | undefined;
	/** Reads and parses the JSON body. An empty body is an empty object. */
	body: () => Promise<Record<string, unknown>>;
}

type RouteHandler = (context: RequestContext) => Promise<unknown>;

type RouteOptions = {
	/** False for the endpoints that must work without a credential. */
	authenticate?: boolean;
	/** False when the response body is the secret being handed over. */
	mask?: boolean;
};

interface Route {
	method: string;
	/** Path template; `:name` captures exactly one segment. */
	pattern: string;
	handler: RouteHandler;
	/** False for the endpoints that must work without a credential. */
	authenticate: boolean;
	/**
	 * False for the one response that must carry a secret through intact.
	 * Everything else is masked on the way out, on the principle that tool
	 * output reaching a phone should never contain a token it could replay.
	 */
	mask: boolean;
}

interface Dependencies {
	config: PocketConfig;
	store: SessionStore;
	supervisor: Supervisor;
	auth: AuthStore;
	onLog: (line: string) => void;
	/** Where the phone client's static files live: next to this module. */
	clientDir: string;
}

export interface DaemonHandle {
	server: Server;
	config: PocketConfig;
	supervisor: Supervisor;
	/** The port actually bound: the resolution of a port 0 request. */
	port: number;
	close: () => Promise<void>;
}

export interface StartOptions {
	config?: PocketConfig | undefined;
	log?: ((line: string) => void) | undefined;
	/** Spawn a child for every session at boot. This is the durable default. */
	revive?: boolean | undefined;
}

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export async function startDaemon(options: StartOptions = {}): Promise<DaemonHandle> {
	const config = options.config ?? readPocketConfig();
	checkAccessibleHost(config);
	const onLog = options.log ?? ((line: string) => process.stderr.write(line));
	const deps: Dependencies = {
		config,
		store: new SessionStore(config.dataRoot),
		supervisor: new Supervisor(
			new SessionStore(config.dataRoot),
			new SessionJournal(config.dataRoot, config.journalMax),
			config,
			onLog,
		),
		auth: new AuthStore(config.dataRoot),
		onLog,
		clientDir: join(fileURLToPath(import.meta.url), "..", "client"),
	};
	const routes = buildRoutes();

	// Open sockets are tracked so a shutdown can cut the SSE streams too: without
	// it, `server.close()` waits for every long-lived stream to end on its own.
	const openSockets = new Set<Socket>();
	const bound = await new Promise<Server>((resolveListen, rejectListen) => {
		const server = createServer((req, res) => {
			void dispatch(req, res, routes, deps);
		});
		server.on("connection", (socket) => {
			openSockets.add(socket);
			socket.on("close", () => openSockets.delete(socket));
		});
		server.once("error", rejectListen);
		server.listen(config.port, config.host, () => {
			server.removeListener("error", rejectListen);
			resolveListen(server);
		});
	});
	const address = bound.address();
	const port = typeof address === "object" && address !== null ? address.port : config.port;
	onLog(`[pocket] gateway on http://${config.host}:${port} (data ${config.dataRoot})\n`);

	if (options.revive !== false) {
		// Order matters: bind the port first, so a phone polling during boot gets
		// an answer, then bring the conversations back.
		const revived = await deps.supervisor.reviveAll();
		for (const id of revived.attached) onLog(`[pocket] resumed ${id}\n`);
		for (const failure of revived.failed) onLog(`[pocket] ${failure.id} did not resume: ${failure.error}\n`);
	}

	return {
		server: bound,
		config,
		supervisor: deps.supervisor,
		port,
		close: async () => {
			await deps.supervisor.shutdown();
			for (const socket of openSockets) socket.destroy();
			await new Promise<void>((resolveClose) => bound.close(() => resolveClose()));
		},
	};
}

// --- dispatch ---------------------------------------------------------------

async function dispatch(
	req: IncomingMessage,
	res: ServerResponse,
	routes: Route[],
	deps: Dependencies,
): Promise<void> {
	const started = Date.now();
	const sendJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		writeJson(res, status, body, headers);
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	try {
		// The two checks that must not depend on being logged in.
		if (!hostAllowed(req.headers.host, deps.config)) {
			sendJson(421, { error: "unknown host: refusing to answer" });
			return;
		}
		if (!originAllowed(req, url)) {
			sendJson(403, { error: "cross-origin write refused" });
			return;
		}

		const route = routes.find((entry) => entry.method === (req.method ?? "GET") && matchPattern(entry.pattern, url.pathname) !== undefined);
		if (!route) {
			await serveClient(res, url.pathname, deps);
			return;
		}

		const caller = await authenticate(req, url, deps);
		if (route.authenticate && caller === undefined) {
			res.setHeader("WWW-Authenticate", "Bearer");
			sendJson(401, { error: "a bearer token is required; pair a device first" });
			return;
		}

		let cachedBody: Record<string, unknown> | undefined;
		const context: RequestContext = {
			req,
			res,
			params: matchPattern(route.pattern, url.pathname) ?? {},
			query: url.searchParams,
			config: deps.config,
			store: deps.store,
			supervisor: deps.supervisor,
			auth: deps.auth,
			caller,
			body: async () => {
				cachedBody ??= await readJsonBody(req);
				return cachedBody;
			},
		};
		const body = await route.handler(context);
		// An SSE handler has already written its response and returns nothing.
		if (res.headersSent) return;
		sendJson(body === undefined ? 204 : 200, body === undefined ? null : route.mask ? maskValue(body) : body);
	} catch (error) {
		const status = error instanceof PocketConfigError ? 400 : error instanceof AuthError ? (error.status as number) : 500;
		const message = error instanceof Error ? error.message : String(error);
		if (status >= 500) deps.onLog(`[pocket] ${req.method} ${url.pathname}: ${message}\n`);
		if (!res.headersSent) sendJson(status, maskValue({ error: message }));
	} finally {
		deps.onLog(`[pocket] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms\n`);
	}
}

/**
 * Answer only for a name we are willing to answer to.
 *
 * Without this, a daemon bound to 127.0.0.1 can be driven by a hostile page: the
 * browser is pointed at the attacker's domain, that domain resolves to
 * 127.0.0.1, and the request arrives here carrying the attacker's Host header
 * while the browser believes it is same-origin. Refusing unknown hosts costs one
 * comparison and closes that whole attack path.
 */
function hostAllowed(host: string | undefined, config: PocketConfig): boolean {
	if (host === undefined) return true; // HTTP/1.0 from a local tool: no browser involved
	const hostname = host.replace(/^\[/, "").replace(/\].*$/, "").replace(/:\d+$/, "").toLowerCase();
	if (hostname === "") return false;
	if (hostname === config.host.toLowerCase()) return true;
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function originAllowed(req: IncomingMessage, url: URL): boolean {
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD") return true;
	const origin = req.headers.origin;
	if (origin === undefined) return true; // not a browser: curl, the CLI, the extension
	try {
		return new URL(origin).host === url.host;
	} catch {
		return false;
	}
}

async function authenticate(req: IncomingMessage, url: URL, deps: Dependencies): Promise<Caller | undefined> {
	// Pairing is open on purpose: it is how a phone acquires its first
	// credential, and the code it needs was shown only to the operator.
	if (req.method === "POST" && url.pathname === "/api/pair") return undefined;

	const header = req.headers.authorization;
	const token = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;

	const configured = effectiveToken(deps.config.token);
	if (configured === undefined) {
		// No configured token means a loopback-only daemon: a request that
		// arrived is by definition local, and checkAccessibleHost already refused
		// any non-loopback bind in this configuration.
		return { kind: "local" };
	}
	if (token === undefined) return undefined;
	if (token === configured) return { kind: "master" };
	const device = await deps.auth.deviceForToken(token);
	if (device === undefined) return undefined;
	void deps.auth.touchDevice(device.id);
	return { kind: "device", device };
}

// --- routes -----------------------------------------------------------------

function buildRoutes(): Route[] {
	const route = (method: string, pattern: string, handler: RouteHandler, options: RouteOptions = {}): Route => ({
		method,
		pattern,
		handler,
		authenticate: options.authenticate ?? true,
		mask: options.mask ?? true,
	});

	const sessionIdOf = (context: RequestContext): string => assertSafeSessionId(context.params.id ?? "");
	const messageOf = (context: RequestContext, payload: Record<string, unknown>): string => {
		const text = payload.message;
		if (typeof text !== "string" || text.trim() === "") throw new PocketConfigError("message must be a non-empty string");
		return text;
	};
	const modelOf = (value: unknown): { provider: string; id: string } => {
		if (typeof value !== "string" || !value.includes("/")) throw new PocketConfigError(`model must look like "<provider>/<id>", got ${JSON.stringify(value)}`);
		const index = value.indexOf("/");
		return { provider: value.slice(0, index), id: value.slice(index + 1) };
	};
	/**
	 * The phone's dedup key for a submission. A prompt sent from a phone that was
	 * already out of signal must not be sent twice on reconnect, so the client
	 * numbers its submissions and the supervisor remembers the last few.
	 */
	const submissionKey = (context: RequestContext): string | undefined => {
		const clientId = context.query.get("clientId");
		const seq = context.query.get("seq");
		return clientId === null || seq === null ? undefined : `${clientId}#${seq}`;
	};
	const requireMaster = (context: RequestContext): void => {
		if (context.caller?.kind !== "master") throw new AuthError("the operator token is required for this", 403);
	};

	return [
		route("GET", "/api/health", () => ({ ok: true, now: new Date().toISOString() }), { authenticate: false }),
		route("GET", "/api/config", (context) => ({
			// What the client needs before it has a token: whether it must pair,
			// whether the gateway can push, and where its own conversation files
			// live. No token, no path outside the agent dir, nothing else.
			agentDir: context.config.agentDir,
			piBin: context.config.piBin,
			journalMax: context.config.journalMax,
			push: context.config.ntfyTopic !== undefined,
			tokenRequired: effectiveToken(context.config.token) !== undefined,
		}), { authenticate: false }),

		route("POST", "/api/pair", async (context) => {
			const body = await context.body();
			const code = typeof body.code === "string" ? body.code : "";
			const label = typeof body.label === "string" ? body.label : "phone";
			const { token, device } = await context.auth.pair(code, label, context.req.socket.remoteAddress ?? "unknown");
			// The one response that must not be masked: this body *is* the bearer
			// token, and masking it would hand the phone "«secret redacted»" as its
			// credential. The code in the request is the guard.
			return { token, device: publicDevice(device) };
		}, { authenticate: false, mask: false }),
		route("GET", "/api/pairing", async (context) => {
			requireMaster(context);
			return context.auth.pairingState();
		}),
		route("POST", "/api/pairing", async (context) => {
			requireMaster(context);
			return context.auth.startPairing();
		}),
		route("GET", "/api/devices", async (context) => {
			requireMaster(context);
			return context.auth.listDevices();
		}),
		route("DELETE", "/api/devices/:id", async (context) => {
			requireMaster(context);
			const id = context.params.id ?? "";
			if (!(await context.auth.revokeDevice(id))) throw new PocketConfigError(`unknown device: ${id}`);
			return { revoked: id };
		}),

		route("GET", "/api/state", async (context) => {
			const entries = await context.store.list();
			const statuses = await context.supervisor.listStatus();
			return {
				sessions: entries.map((entry) => ({
					...entry,
					status: statuses.find((status) => status.id === entry.id),
				})),
			};
		}),

		route("POST", "/api/sessions", async (context) => {
			const body = await context.body();
			const cwd = typeof body.cwd === "string" ? body.cwd : "";
			const name = typeof body.name === "string" ? body.name : "";
			const model = body.model === undefined ? undefined : modelOf(body.model);
			const thinking = typeof body.thinking === "string" ? body.thinking : undefined;
			const entry = await context.store.create({ name, cwd, model, thinkingLevel: thinking });
			// Attach immediately: a session that exists but has no child is something
			// nobody asked for, and the next request would attach it anyway.
			try {
				await context.supervisor.attach(entry.id);
			} catch (error) {
				await context.store.update(entry.id, { lastError: error instanceof Error ? error.message : String(error) });
			}
			return { ...entry, status: await context.supervisor.status(entry.id) };
		}),
		route("GET", "/api/sessions", async (context) => context.store.list()),

		route("GET", "/api/sessions/:id", async (context) => {
			const id = sessionIdOf(context);
			const [entry, status] = await Promise.all([context.store.get(id), context.supervisor.status(id)]);
			if (entry === undefined) throw new PocketConfigError(`unknown session: ${id}`);
			return { entry, status, cursor: await context.supervisor.latestSeq(id) };
		}),
		route("DELETE", "/api/sessions/:id", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.detach(id);
			await context.supervisor.dropJournal(id);
			await context.store.remove(id);
			return { deleted: id };
		}),

		route("POST", "/api/sessions/:id/prompt", async (context) => {
			const id = sessionIdOf(context);
			const body = await context.body();
			const result = await context.supervisor.prompt(id, messageOf(context, body), { idempotencyKey: submissionKey(context) });
			return { ...result, status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/steer", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.steer(id, messageOf(context, await context.body()));
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/follow-up", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.followUp(id, messageOf(context, await context.body()));
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/abort", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.abort(id);
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/start", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.attach(id);
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/stop", async (context) => {
			const id = sessionIdOf(context);
			await context.supervisor.detach(id);
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/rename", async (context) => {
			const id = sessionIdOf(context);
			const body = await context.body();
			if (typeof body.name !== "string") throw new PocketConfigError("name must be a string");
			return context.store.update(id, { name: body.name });
		}),
		route("POST", "/api/sessions/:id/model", async (context) => {
			const id = sessionIdOf(context);
			const body = await context.body();
			await context.supervisor.setModel(id, modelOf(body.model));
			return { status: await context.supervisor.status(id) };
		}),
		route("POST", "/api/sessions/:id/answer/:requestId", async (context) => {
			const id = sessionIdOf(context);
			const requestId = context.params.requestId ?? "";
			const body = await context.body();
			await context.supervisor.answerDialog(id, requestId, answerFrom(body));
			return { status: await context.supervisor.status(id) };
		}),

		route("GET", "/api/sessions/:id/messages", async (context) => {
			const id = sessionIdOf(context);
			const limit = Number.parseInt(context.query.get("limit") ?? "0", 10);
			const messages = await context.supervisor.messages(id);
			return Number.isFinite(limit) && limit > 0 ? messages.slice(-limit) : messages;
		}),
		route("GET", "/api/sessions/:id/events", async (context) => {
			const id = sessionIdOf(context);
			const raw = context.query.get("cursor");
			const cursor = raw === null ? -1 : Number.parseInt(raw, 10);
			await streamEvents(context, id, Number.isFinite(cursor) ? cursor : -1);
		}),
	];
}

function publicDevice(device: DeviceRecord): Omit<DeviceRecord, "tokenHash"> {
	const { tokenHash: _hash, ...rest } = device;
	return rest;
}

/** Translate a phone's answer into the reply shape the pi child expects. */
function answerFrom(body: Record<string, unknown>): { value: string } | { confirmed: boolean } | { cancelled: true } {
	if (body.cancelled === true) return { cancelled: true };
	if (typeof body.confirmed === "boolean") return { confirmed: body.confirmed };
	if (typeof body.value === "string") return { value: body.value };
	throw new PocketConfigError("an answer needs value, confirmed, or cancelled");
}

// --- server-sent events -----------------------------------------------------

/**
 * One long-lived response per session.
 *
 * On connect the client states the last record it saw. If that cursor is still
 * inside the journal, the stream replays from it and the phone misses nothing; if
 * it aged out or the daemon restarted underneath it, the stream opens with a
 * `reset` record that tells the client to re-read history rather than patch a
 * partial view. After that it is journaled records as they happen.
 */
async function streamEvents(context: RequestContext, sessionId: string, after: number): Promise<void> {
	const { res, supervisor } = context;
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write("retry: 2000\n\n");

	const send = (record: JournalRecord): void => {
		if (res.writableEnded) return;
		res.write(`event: record\ndata: ${JSON.stringify(maskValue(record))}\n\n`);
	};

	if (after >= 0) {
		const replay = await supervisor.journalFor(sessionId, after);
		if (replay.reset) res.write(`event: reset\ndata: ${JSON.stringify({ cursor: replay.cursor })}\n\n`);
		for (const record of replay.records) send(record);
	} else {
		// No cursor: this client has not loaded the session yet, so tell it where
		// to start rather than replaying a buffer it may already have.
		res.write(`event: reset\ndata: ${JSON.stringify({ cursor: await supervisor.latestSeq(sessionId) })}\n\n`);
	}

	const unsubscribe = supervisor.subscribe(sessionId, (record) => send(record));
	const heartbeat = setInterval(() => {
		// A comment line: idle connections are dropped by phones and proxies
		// alike, and the client reconnects on its own retry timer either way.
		if (!res.writableEnded) res.write(": keep-alive\n\n");
	}, HEARTBEAT_MS);

	await new Promise<void>((resolve) => {
		let done = false;
		const stop = (): void => {
			if (done) return;
			done = true;
			clearInterval(heartbeat);
			unsubscribe();
			resolve();
		};
		context.req.on("close", stop);
		context.req.on("error", stop);
		res.on("close", stop);
		res.on("error", stop);
	});
}

// --- the phone client -------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
};

/**
 * Serve the client for "/" and fall through for unknown paths.
 *
 * Traversal is the only real risk here: a path like `/../sessions.json` is a
 * request for the registry, so the final path is resolved and required to stay
 * inside the client directory before anything is read.
 */
async function serveClient(res: ServerResponse, pathname: string, deps: Dependencies): Promise<void> {
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const candidate = join(deps.clientDir, relative);
	const root = await realpath(deps.clientDir).catch(() => deps.clientDir);
	const resolved = resolve(root, relative);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		writeJson(res, 403, { error: "path outside the client directory" });
		return;
	}
	const info = await stat(resolved).catch(() => undefined);
	if (!info?.isFile()) {
		// Unknown path, no client file: answer 404 rather than falling back to
		// index.html, so a mistaken /api/... call does not render the app.
		writeJson(res, 404, { error: "not found" });
		return;
	}
	const body = await readFile(resolved);
	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream",
		"Content-Length": String(body.length),
		// The client changes with the daemon; never let a phone keep a stale one.
		"Cache-Control": "no-store",
	});
	res.end(body);
}

// --- request plumbing -------------------------------------------------------

function matchPattern(pattern: string, pathname: string): Record<string, string> | undefined {
	const wanted = pattern.split("/").filter(Boolean);
	const actual = pathname.split("/").filter(Boolean);
	if (wanted.length !== actual.length) return undefined;
	const params: Record<string, string> = {};
	for (let index = 0; index < wanted.length; index += 1) {
		const part = wanted[index];
		if (part.startsWith(":")) {
			params[part.slice(1)] = decodeURIComponent(actual[index]);
			continue;
		}
		if (part !== actual[index]) return undefined;
	}
	return params;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new PocketConfigError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
		chunks.push(chunk as Buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new PocketConfigError(`could not parse the request body as JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new PocketConfigError("the request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	if (res.headersSent) return;
	const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(payload.length),
		"Cache-Control": "no-store",
		...headers,
	});
	res.end(payload);
}

// --- running it -------------------------------------------------------------

/** Start the daemon and stay in the foreground. */
export async function runDaemon(): Promise<void> {
	const config = readPocketConfig();
	const dataRoot = config.dataRoot;
	// Written before the port file so the daemon has a directory to put it in:
	// a first-ever boot runs against a data root that does not exist yet, and
	// writeFileSync does not create directories.
	mkdirSync(dataRoot, { recursive: true });
	const onLog = (line: string) => {
		try {
			appendFileSync(paths.daemonLog(dataRoot), line);
		} catch {
			process.stderr.write(line);
		}
	};
	const handle = await startDaemon({ config, log: onLog });
	writeFileSync(paths.portFile(dataRoot), `${handle.port}\n`);
	writeFileSync(paths.pidFile(dataRoot), `${process.pid}\n`);

	const shutdown = (signal: NodeJS.Signals): void => {
		onLog(`[pocket] ${signal} received; stopping sessions\n`);
		void handle.close().then(() => {
			try {
				unlinkSync(paths.pidFile(config.dataRoot));
			} catch {
				// already gone
			}
			process.exit(0);
		});
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

// Only bind a port when this file is the entry point, so importing it in a test
// does not start listening.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) void runDaemon();
