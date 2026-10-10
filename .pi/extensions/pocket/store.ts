// pocket — the durable session registry
//
// What survives a daemon restart is written here: one record per conversation,
// holding the project directory it runs in, the pi session file to resume, and
// the model it was asked to use. Live state (is the child running, what is it
// doing) deliberately does not belong here — it would be a lie the moment the
// daemon died, which is exactly when a client asks.
//
// The id is a URL path segment later (GET /api/sessions/<id>), so it is generated
// here and checked at read time: `assertSafeSessionId` is what stops a request
// from walking out of the data directory.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { paths } from "./config.ts";

export interface SessionModelRef {
	provider: string;
	id: string;
}

export interface SessionEntry {
	id: string;
	name: string;
	cwd: string;
	/** <dataRoot>/sessions/<id> — where pi writes its session file. */
	sessionDir: string;
	/** Resolved from the child's own get_state after the first start. */
	sessionFile: string | null;
	createdAt: string;
	updatedAt: string;
	model?: SessionModelRef | undefined;
	thinkingLevel?: string | undefined;
	/** Last failure text, so a dead session can explain itself. */
	lastError?: string | undefined;
	/**
	 * Whether the daemon should start this session's child on boot. Default true:
	 * that is what makes a reboot a non-event. Set false for sessions that should
	 * sit idle until asked.
	 */
	autostart?: boolean | undefined;
}

export type SessionPatch = Partial<Pick<SessionEntry, "name" | "sessionFile" | "model" | "thinkingLevel" | "lastError" | "autostart">>;

export interface SessionRegistry {
	version: 1;
	sessions: SessionEntry[];
}

export class PocketConfigError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Ids reach the filesystem (one directory each), so they are checked twice: here and at generation. */
export function assertSafeSessionId(id: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new PocketConfigError(`invalid session id: ${JSON.stringify(id)}`);
	}
	return id;
}

export function generateSessionId(): string {
	return `s-${randomBytes(4).toString("hex")}`;
}

export async function projectDirectory(cwd: string): Promise<string> {
	const resolved = path.resolve(cwd);
	const info = await stat(resolved).catch(() => undefined);
	if (!info?.isDirectory()) throw new PocketConfigError(`not a directory: ${resolved}`);
	return resolved;
}

/** Serializes every mutation: two concurrent creates must not lose one. */
let registryLock: Promise<unknown> = Promise.resolve();

export class SessionStore {
	readonly dataRoot: string;

	constructor(dataRoot: string) {
		this.dataRoot = dataRoot;
	}

	async list(): Promise<SessionEntry[]> {
		return (await this.read()).sessions;
	}

	async get(id: string): Promise<SessionEntry | undefined> {
		assertSafeSessionId(id);
		return (await this.read()).sessions.find((entry) => entry.id === id);
	}

	async create(input: { name: string; cwd: string; model?: SessionModelRef; thinkingLevel?: string }): Promise<SessionEntry> {
		const cwd = await projectDirectory(input.cwd);
		const id = generateSessionId();
		const now = new Date().toISOString();
		const entry: SessionEntry = {
			id,
			name: input.name.trim() === "" ? path.basename(cwd) : input.name.trim(),
			cwd,
			sessionDir: paths.sessionDir(this.dataRoot, id),
			sessionFile: null,
			createdAt: now,
			updatedAt: now,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
		};

		await this.mutate((registry) => {
			registry.sessions.push(entry);
		});
		return entry;
	}

	async update(id: string, patch: SessionPatch): Promise<SessionEntry> {
		assertSafeSessionId(id);
		let updated: SessionEntry | undefined;
		await this.mutate((registry) => {
			const index = registry.sessions.findIndex((entry) => entry.id === id);
			if (index < 0) return;
			const next: SessionEntry = { ...registry.sessions[index], ...patch, updatedAt: new Date().toISOString() };
			registry.sessions.splice(index, 1, next);
			updated = next;
		});
		if (!updated) throw new PocketConfigError(`unknown session: ${id}`);
		return updated;
	}

	async remove(id: string): Promise<void> {
		assertSafeSessionId(id);
		await this.mutate((registry) => {
			registry.sessions = registry.sessions.filter((entry) => entry.id !== id);
		});
	}

	/**
	 * Apply `change` to the parsed registry and persist it atomically. Writes go
	 * to a sibling temporary file and are renamed, so a crash mid-write leaves
	 * the previous registry intact rather than a truncated one.
	 */
	private async mutate(change: (registry: SessionRegistry) => void): Promise<void> {
		const previous = registryLock;
		let release: () => void = () => {};
		registryLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			const registry = await this.read();
			change(registry);
			await this.write(registry);
		} finally {
			release();
		}
	}

	private async read(): Promise<SessionRegistry> {
		const file = paths.registry(this.dataRoot);
		try {
			const parsed = JSON.parse(await readFile(file, "utf8")) as SessionRegistry;
			if (!Array.isArray(parsed.sessions)) throw new Error("registry has no session list");
			return { version: 1, sessions: parsed.sessions };
		} catch {
			return { version: 1, sessions: [] };
		}
	}

	private async write(registry: SessionRegistry): Promise<void> {
		const file = paths.registry(this.dataRoot);
		await mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.tmp`;
		await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
		await rename(temporary, file);
	}
}
