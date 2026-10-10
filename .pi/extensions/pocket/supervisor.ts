// pocket — the session supervisor
//
// This is the part that makes the setup durable rather than merely remote.
//
// A session is a conversation, identified by a pocket id, backed by pi's own
// session file on disk and by exactly one live `pi --mode rpc` child at a time.
// The child is expendable: if it dies, the supervisor respawns it and points it
// at the recorded session file, so the conversation continues from where it was.
// If the whole daemon dies, the registry holds the same information, and the next
// daemon re-attaches every session marked autostart — work that was running when
// the machine rebooted starts again.
//
// The client is never a dependency. Nothing here waits for a phone: events go to
// the journal (journal.ts) and to any attached listener, and a client that was
// offline reads them back through the cursor when it returns.

import { PiRpcProcess, type ExtensionUiReply, type ExtensionUiRequest, type RpcEvent } from "./rpc.ts";
import { SessionJournal, capRecord, type JournalRecord } from "./journal.ts";
import { SessionStore, type SessionEntry, type SessionModelRef } from "./store.ts";
import type { PocketConfig } from "./config.ts";

export interface LiveStatus {
	id: string;
	live: boolean;
	busy: boolean;
	pid: number | undefined;
	sessionFile: string | null;
	dialogs: ExtensionUiRequest[];
	respawns: number;
	lastError: string | undefined;
}

interface LiveSession {
	entry: SessionEntry;
	rpc: PiRpcProcess;
	busy: boolean;
	/** Extension dialogs the child is waiting on, keyed by request id. */
	dialogs: Map<string, ExtensionUiRequest>;
	respawns: number;
	/** True while the user asked for a stop: then an exit is expected, not a crash. */
	detaching: boolean;
	/**
	 * Prompt submissions seen recently, keyed by the phone's `(clientId, seq)`.
	 * A prompt the phone sent while it was already out of signal would otherwise
	 * be sent again on reconnect, and an agent that runs twice is worse than
	 * one that ran once.
	 */
	received: Map<string, { disposition: string }>;
	unsubscribe: () => void;
	unsubscribeUi: () => void;
}

/** How many recent prompt submissions a session remembers for replay detection. */
const RECEIVED_LIMIT = 256;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class Supervisor {
	readonly store: SessionStore;
	readonly journal: SessionJournal;
	readonly config: PocketConfig;
	readonly onLog: (line: string) => void;
	private readonly live = new Map<string, LiveSession>();
	private readonly stopped = new Set<string>();
	/** Sessions the daemon intends to keep running across a restart. */
	private readonly autostart: Set<string> = new Set();
	/**
	 * One serialized chain of lifecycle work per session.
	 *
	 * An exit handler respawns, and a respawn can exit while the handler that
	 * spawned it is still writing its journal records. Without the chain the two
	 * interleave, each reading `live` before the other's write, and the session
	 * ends up with a respawn count that means nothing.
	 */
	private readonly chains = new Map<string, Promise<void>>();
	/** Live listeners, in addition to the journal. Used by the SSE stream. */
	private readonly eventListeners = new Map<string, Set<(record: JournalRecord) => void>>();

	constructor(store: SessionStore, journal: SessionJournal, config: PocketConfig, onLog: (line: string) => void = () => {}) {
		this.store = store;
		this.journal = journal;
		this.config = config;
		this.onLog = onLog;
	}

	// --- introspection ----------------------------------------------------

	async status(id: string): Promise<LiveStatus> {
		const session = this.live.get(id);
		const entry = await this.store.get(id);
		return {
			id,
			live: session !== undefined,
			busy: session?.busy ?? false,
			pid: session?.rpc.pid,
			// A live session holds the file it is actually appending to, which is one
			// store write ahead of the registry: prefer it, or a status taken while
			// that write is in flight reports a file the child is no longer using.
			sessionFile: session?.entry.sessionFile ?? entry?.sessionFile ?? null,
			dialogs: session ? [...session.dialogs.values()] : [],
			respawns: session?.respawns ?? 0,
			lastError: entry?.lastError,
		};
	}

	async listStatus(): Promise<LiveStatus[]> {
		const entries = await this.store.list();
		return Promise.all(entries.map((entry) => this.status(entry.id)));
	}

	liveIds(): string[] {
		return [...this.live.keys()];
	}

	// --- lifecycle --------------------------------------------------------

	/**
	 * Attach a session: spawn its child if it is not running, then return its
	 * status. Attaching is idempotent — a second phone, or a second request from
	 * the same phone, reuses the child that is already there.
	 */
	async attach(id: string): Promise<LiveStatus> {
		const existing = this.live.get(id);
		if (existing) return this.status(id);

		const entry = await this.store.get(id);
		if (!entry) throw new Error(`unknown session: ${id}`);

		this.stopped.delete(id);
		// `spawn` is synchronous and `live` is written before any await, so an
		// exit that lands while rememberSessionFile is still reading state finds
		// this session in the map and respawns into it, rather than into a slot
		// that attach has not filled yet.
		const session = this.spawn(entry);
		this.live.set(id, session);

		// The child is the only authority on where its own conversation lives:
		// it names the file after our session id but prefixes a timestamp, and
		// appends to an existing file when one is present. Record what it says.
		void this.rememberSessionFile(session);
		this.onLog(`[pocket] session ${id} attached (pid ${session.rpc.pid ?? "?"}${entry.sessionFile ? ", resumed" : ""})\n`);

		// A restart is invisible in the transcript unless something says so: a
		// client that reconnects needs to know the run it left behind is not the
		// run that continues.
		await this.record(id, "gateway_event", {
			event: entry.sessionFile ? "session_resumed" : "session_started",
			pid: session.rpc.pid ?? null,
		});

		return this.status(id);
	}

	private spawn(entry: SessionEntry): LiveSession {
		const session: LiveSession = {
			entry,
			busy: false,
			dialogs: new Map(),
			received: new Map(),
			respawns: 0,
			detaching: false,
			rpc: undefined as unknown as PiRpcProcess,
			unsubscribe: () => {},
			unsubscribeUi: () => {},
		};
		session.rpc = new PiRpcProcess({
			piBin: this.config.piBin,
			cwd: entry.cwd,
			sessionDir: entry.sessionDir,
			sessionId: entry.id,
			sessionPath: entry.sessionFile ?? undefined,
			model: entry.model,
			thinkingLevel: entry.thinkingLevel,
			requestTimeoutMs: this.config.requestTimeoutMs,
			onStderr: (chunk) => this.onLog(`[pocket:${entry.id}] ${chunk}`),
		});
		this.wire(session);
		return session;
	}

	private wire(session: LiveSession): void {
		session.unsubscribe = session.rpc.subscribe((event) => {
			this.handleEvent(session, event);
		});
		session.unsubscribeUi = session.rpc.onExtensionUi((request) => {
			// Dialog requests are journaled: a phone that reconnects mid-question
			// must still be able to answer it, and the answer has to reach the
			// same request id the child is blocking on.
			if (isDialogMethod(request.method)) session.dialogs.set(request.id, request);
			void this.record(session.entry.id, "extension_ui", { request: capRecord(request) });
		});

		// The child died. What happens next is the whole durability story:
		// a child that was asked to stop stays stopped, and anything else is
		// respawned against the recorded session file, up to the configured
		// number of consecutive attempts.
		//
		// The work goes through the session's chain rather than straight into
		// handleExit: a respawn that dies on its own, while the exit handler that
		// spawned it is still journaling, would otherwise interleave with it.
		session.rpc.waitForExit().then(({ code, signal, error }) => {
			void this.chain(session.entry.id, () => this.handleExit(session, { code, signal, error }));
		});
	}

	private async handleEvent(session: LiveSession, event: RpcEvent): Promise<void> {
		if (event.type === "agent_start") session.busy = true;
		if (event.type === "agent_settled") {
			session.busy = false;
			await this.notifySettled(session, event);
		}
		await this.record(session.entry.id, "pi_event", { event: capRecord(event) });
	}

	private async notifySettled(session: LiveSession, event: RpcEvent): Promise<void> {
		if (!this.config.ntfyTopic) return;
		const aborted = event.aborted === true;
		await this.push(session.entry.name, aborted ? "Run aborted" : "Finished — needs you", `pocket session ${session.entry.id}`);
	}

	/** Push a notification, when a topic is configured. Never throws at a session. */
	private async push(title: string, body: string, tags: string): Promise<void> {
		const topic = this.config.ntfyTopic;
		if (!topic) return;
		try {
			const endpoint = `${this.config.ntfyServer.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
			await fetch(endpoint, {
				method: "POST",
				headers: { Title: title, Tags: tags, Priority: "default" },
				body,
			});
		} catch (error) {
			this.onLog(`[pocket] ntfy push failed: ${describeError(error)}\n`);
		}
	}

	private async handleExit(session: LiveSession, info: { code: number | null; signal: NodeJS.Signals | null; error?: string }): Promise<void> {
		const { entry } = session;
		session.unsubscribe();
		session.unsubscribeUi();
		if (this.live.get(entry.id) === session) this.live.delete(entry.id);
		await this.record(entry.id, "gateway_event", {
			event: "child_exited",
			code: info.code,
			signal: info.signal ?? null,
			// A child that never started (a pi path that is not there) has an error
			// rather than an exit status; without it, a session that will never run
			// looks like a session that crashed.
			error: info.error ?? null,
		});

		if (session.detaching) {
			this.stopped.add(entry.id);
			this.onLog(`[pocket] session ${entry.id} stopped\n`);
			return;
		}

		// Unexpected exit: respawn and resume, unless the attempts ran out.
		const respawns = session.respawns + 1;
		if (respawns > this.config.respawnMax) {
			const cause = info.error ? ` (${info.error})` : `code ${info.code}, signal ${info.signal ?? "none"}`;
			await this.store.update(entry.id, {
				lastError: `child exited ${cause} ${this.config.respawnMax} times; giving up`,
			});
			this.onLog(`[pocket] session ${entry.id}: giving up after ${respawns - 1} respawns\n`);
			return;
		}
		this.onLog(`[pocket] session ${entry.id}: child exited (code ${info.code}), respawning ${respawns}/${this.config.respawnMax}\n`);
		await this.record(entry.id, "gateway_event", { event: "child_respawn", attempt: respawns });
		try {
			const replacement = this.spawn(entry);
			replacement.respawns = respawns;
			this.live.set(entry.id, replacement);
			await this.store.update(entry.id, { lastError: undefined });
			void this.rememberSessionFile(replacement);
		} catch (error) {
			await this.store.update(entry.id, { lastError: describeError(error) });
		}
	}

	/**
	 * Serialize one session's lifecycle work.
	 *
	 * A rejected chain is cleared rather than propagated: the next exit must still
	 * be handled, or one bad write to the store would leave a session that never
	 * respawns again.
	 */
	private chain(id: string, task: () => Promise<void>): Promise<void> {
		const previous = this.chains.get(id) ?? Promise.resolve();
		const next = previous.then(task, task).catch((error) => {
			this.onLog(`[pocket] session ${id}: lifecycle error: ${describeError(error)}\n`);
		});
		this.chains.set(id, next);
		return next;
	}

	/** Read the child's own session file path once, and keep it in the registry. */
	private async rememberSessionFile(session: LiveSession): Promise<void> {
		try {
			const state = await session.rpc.getState();
			if (typeof state.sessionFile === "string" && state.sessionFile !== "") {
				session.entry = { ...session.entry, sessionFile: state.sessionFile };
				await this.store.update(session.entry.id, { sessionFile: state.sessionFile, lastError: undefined });
			}
		} catch (error) {
			// Losing this once is not fatal: the respawn path re-reads it from
			// the registry, and a spawn without it simply starts a new file.
			this.onLog(`[pocket] session ${session.entry.id}: could not read session file: ${describeError(error)}\n`);
		}
	}

	/** Stop a session's child. The conversation stays on disk. */
	async detach(id: string): Promise<void> {
		const session = this.live.get(id);
		if (!session) return;
		session.detaching = true;
		this.stopped.add(id);
		this.autostart.delete(id);
		await session.rpc.stop();
		// The exit handler does the rest; if the child is already gone it has.
		if (this.live.get(id) === session) this.live.delete(id);
	}

	/**
	 * Detach a session for good: stop its child and stop wanting it back.
	 * Used by the UI's stop button, and by a session whose respawn budget ran out.
	 */
	async park(id: string): Promise<void> {
		await this.detach(id);
		await this.store.update(id, { autostart: false });
	}

	/**
	 * Attach everything that wants to be running. Called at daemon boot: the point
	 * is that a session which was running when the machine went down comes back
	 * without anyone asking for it.
	 */
	async reviveAll(): Promise<{ attached: string[]; failed: Array<{ id: string; error: string }> }> {
		const attached: string[] = [];
		const failed: Array<{ id: string; error: string }> = [];
		const entries = await this.store.list();
		for (const entry of entries) {
			if (entry.autostart === false) continue;
			this.autostart.add(entry.id);
			try {
				await this.attach(entry.id);
				attached.push(entry.id);
			} catch (error) {
				failed.push({ id: entry.id, error: describeError(error) });
				await this.store.update(entry.id, { lastError: describeError(error) });
			}
		}
		return { attached, failed };
	}

	/** Stop every child, e.g. for a clean daemon shutdown. */
	async shutdown(): Promise<void> {
		for (const id of [...this.live.keys()]) await this.detach(id);
	}

	// --- commands ---------------------------------------------------------

	private async require(id: string): Promise<LiveSession> {
		await this.attach(id);
		const session = this.live.get(id);
		if (!session) throw new Error(`session ${id} is not attached`);
		return session;
	}

	/**
	 * Send a prompt, or record why it could not be sent.
	 *
	 * The failure is journaled as well as thrown: a phone that sends a prompt and
	 * gets nothing back has to be able to find out on its next reconnect whether
	 * the message ever reached the agent, and a caller that only sees a rejection
	 * tells it nothing.
	 */
	async prompt(id: string, message: string, options: { idempotencyKey?: string } = {}): Promise<{ disposition: string }> {
		try {
			const session = await this.require(id);
			const key = options.idempotencyKey;
			if (key !== undefined) {
				const seen = session.received.get(key);
				// Replayed: the phone already has this answer, and answering again would
				// run the prompt a second time.
				if (seen) return seen;
				if (session.received.size >= RECEIVED_LIMIT) {
					const oldest = session.received.keys().next().value;
					if (typeof oldest === "string") session.received.delete(oldest);
				}
				session.received.set(key, { disposition: "pending" });
			}
			const data = (await session.rpc.request<{ disposition?: string }>({ type: "prompt", message })) ?? {};
			const result = { disposition: typeof data.disposition === "string" ? data.disposition : "started" };
			if (key !== undefined) session.received.set(key, result);
			return result;
		} catch (error) {
			await this.record(id, "gateway_event", { event: "prompt_failed", error: describeError(error) });
			throw error;
		}
	}

	async steer(id: string, message: string): Promise<void> {
		const session = await this.require(id);
		await session.rpc.request({ type: "steer", message });
	}

	async followUp(id: string, message: string): Promise<void> {
		const session = await this.require(id);
		await session.rpc.request({ type: "follow_up", message });
	}

	async abort(id: string): Promise<void> {
		const session = await this.require(id);
		await session.rpc.request({ type: "abort" });
	}

	async setModel(id: string, model: SessionModelRef): Promise<void> {
		const session = await this.require(id);
		const entry = await this.store.update(id, { model });
		session.entry = entry;
		await session.rpc.request({ type: "set_model", provider: model.provider, model: model.id });
	}

	async answerDialog(id: string, requestId: string, reply: ExtensionUiReply): Promise<void> {
		const session = this.live.get(id);
		if (!session) throw new Error(`session ${id} is not attached`);
		session.rpc.respondExtensionUi(requestId, reply);
		session.dialogs.delete(requestId);
		await this.record(id, "gateway_event", { event: "dialog_answered", requestId });
	}

	/** Full conversation history, used on first connect and after a journal reset. */
	async messages(id: string): Promise<Array<Record<string, any>>> {
		const session = await this.require(id);
		return session.rpc.getMessages();
	}

	// --- journal plumbing -------------------------------------------------

	private async record(id: string, kind: string, payload: Record<string, unknown>): Promise<JournalRecord> {
		const entry = await this.journal.append(id, { kind, ...payload });
		const listeners = this.eventListeners.get(id);
		if (listeners) {
			for (const listener of [...listeners]) {
				try {
					listener(entry);
				} catch (error) {
					// A listener that throws must not take the session with it: the
					// journal already has the record, and one broken socket should
					// not stop the agent.
					this.onLog(`[pocket] session ${id}: listener error: ${describeError(error)}\n`);
				}
			}
		}
		return entry;
	}

	/**
	 * Observe a session's records as they are journaled. The listener fires for
	 * every record the session produces, so a connected phone and the journal stay
	 * interchangeable: one is the live view, the other the replay.
	 */
	subscribe(id: string, listener: (record: JournalRecord) => void): () => void {
		let listeners = this.eventListeners.get(id);
		if (!listeners) {
			listeners = new Set();
			this.eventListeners.set(id, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners && listeners.size === 0) this.eventListeners.delete(id);
		};
	}

	async journalFor(id: string, after: number) {
		return this.journal.readSince(id, after);
	}

	async latestSeq(id: string): Promise<number> {
		return this.journal.latestSeq(id);
	}

	/** Forget a session's replay buffer, e.g. when the session is deleted. */
	async dropJournal(id: string): Promise<void> {
		await this.journal.drop(id);
	}
}

/** pi's dialog methods block until answered; the fire-and-forget ones do not. */
function isDialogMethod(method: string): boolean {
	return method === "select" || method === "confirm" || method === "input" || method === "editor";
}
