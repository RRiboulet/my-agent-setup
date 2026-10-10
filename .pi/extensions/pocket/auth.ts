// pocket — pairing, device credentials, and the secret masker
//
// A gateway surfaced to a phone is a gateway to every project on the machine,
// so it gets a credential rather than proximity. Three implementations of this
// idea were read before writing ours (collie's pairing codes, Codeman's single-use
// QR token, pi-web's decision to have none at all and inherit its caller's), and
// the shape below is the smallest one that satisfies the cases a phone actually
// hits:
//
//   - the phone has no way to type a long secret, so the operator types a short
//     one-time code instead and trades it for a long random token;
//   - a phone can be lost, so a device is revocable by name and the store keeps
//     only a hash, which means a leaked devices.json is not a leaked token;
//   - the operator is not the only source of secrets in a session — tool output
//     is — so `mask` runs on everything that leaves the machine, not just on
//     what the operator typed.
//
// Loopback is still the default bind and no other host is reachable without a
// token (config.ts enforces that), so the token protects the phone-facing case,
// not a local one.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { paths } from "./config.ts";

export interface DeviceRecord {
	id: string;
	label: string;
	createdAt: string;
	expiresAt?: string | undefined;
	lastSeenAt?: string | undefined;
	/** Only a hash is ever written to disk. */
	tokenHash: string;
}

interface DeviceFile {
	version: 1;
	devices: DeviceRecord[];
}

interface PairingFile {
	code: string;
	expiresAt: string;
	attempts: number;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1: no transcription ambiguity
const CODE_LENGTH = 8;
const MAX_PAIRING_ATTEMPTS = 5;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;

export class AuthError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

function generateCode(): string {
	const bytes = randomBytes(CODE_LENGTH);
	let code = "";
	for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
	return code;
}

interface RateEntry {
	count: number;
	resetAt: number;
}

export class AuthStore {
	/** Bad pairing attempts per client address. Deliberately in-memory: its job is to slow a stranger, not to survive a reboot. */
	private readonly rate = new Map<string, RateEntry>();

	readonly dataRoot: string;

	constructor(dataRoot: string) {
		this.dataRoot = dataRoot;
	}

	// --- pairing ----------------------------------------------------------

	/** Mint a fresh one-time code, replacing any previous one. */
	async startPairing(ttlMs = PAIRING_TTL_MS): Promise<{ code: string; expiresAt: string }> {
		const code = generateCode();
		const expiresAt = new Date(Date.now() + ttlMs).toISOString();
		await this.writePairing({ code, expiresAt, attempts: 0 });
		return { code, expiresAt };
	}

	async pairingState(): Promise<{ pending: boolean; expiresAt: string | null; attempts: number }> {
		const file = await this.readPairing();
		return {
			pending: file !== undefined && Date.parse(file.expiresAt) > Date.now(),
			expiresAt: file?.expiresAt ?? null,
			attempts: file?.attempts ?? 0,
		};
	}

	/**
	 * Trade a one-time code for a device token.
	 *
	 * The code is consumed by the exchange: a second use of the same code fails,
	 * which is what makes an overheard code useless after the phone has paired.
	 */
	async pair(code: string, label: string, clientAddress: string, now = Date.now()): Promise<{ token: string; device: DeviceRecord }> {
		this.consumeRate(clientAddress, now);
		const file = await this.readPairing();
		const trimmed = code.trim().toUpperCase();
		if (!file || Date.parse(file.expiresAt) <= now) {
			throw new AuthError("no pairing code is active", 404);
		}
		if (file.attempts >= MAX_PAIRING_ATTEMPTS) {
			throw new AuthError("pairing code has been invalidated by too many wrong attempts", 429);
		}
		if (!constantTimeEqual(trimmed, file.code)) {
			await this.writePairing({ ...file, attempts: file.attempts + 1 });
			throw new AuthError(`${MAX_PAIRING_ATTEMPTS - file.attempts - 1} attempt(s) left before the code is invalidated`, 401);
		}
		// Clear the code before issuing anything: if the process dies between the
		// two writes, the operator must mint a new code rather than half-pairing.
		await this.writePairing({ ...file, code: "", expiresAt: new Date(now).toISOString(), attempts: 0 });

		const token = generateToken();
		const device: DeviceRecord = {
			id: `d-${randomBytes(4).toString("hex")}`,
			label: label.trim() === "" ? "unnamed device" : label.trim(),
			createdAt: new Date(now).toISOString(),
			lastSeenAt: new Date(now).toISOString(),
			tokenHash: hashToken(token),
		};
		await this.mutateDevices((devices) => {
			devices.push(device);
		});
		return { token, device };
	}

	// --- device credentials ----------------------------------------------

	/** Look a device up by bearer token. Timing-safe on the hash comparison. */
	async deviceForToken(token: string): Promise<DeviceRecord | undefined> {
		const devices = await this.readDevices();
		const incoming = hashToken(token);
		let matched: DeviceRecord | undefined;
		for (const device of devices) {
			if (constantTimeEqual(device.tokenHash, incoming)) {
				matched = device;
				break;
			}
		}
		if (!matched) return undefined;
		if (matched.expiresAt && Date.parse(matched.expiresAt) <= Date.now()) return undefined;
		return matched;
	}

	async touchDevice(id: string, now = Date.now()): Promise<void> {
		const stamp = new Date(now).toISOString();
		await this.mutateDevices((devices) => {
			const device = devices.find((entry) => entry.id === id);
			if (device) device.lastSeenAt = stamp;
		});
	}

	async listDevices(): Promise<Array<Omit<DeviceRecord, "tokenHash">>> {
		return (await this.readDevices()).map(publicDevice);
	}

	async revokeDevice(id: string): Promise<boolean> {
		let removed = false;
		await this.mutateDevices((devices) => {
			const next = devices.filter((device) => device.id !== id);
			removed = next.length !== devices.length;
			devices.length = 0;
			devices.push(...next);
		});
		return removed;
	}

	// --- rate limiting ----------------------------------------------------

	/** Throws 429 once a single address has burned through RATE_MAX_ATTEMPTS. */
	private consumeRate(address: string, now: number): void {
		const existing = this.rate.get(address);
		if (!existing || existing.resetAt <= now) {
			this.rate.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
			return;
		}
		existing.count += 1;
		if (existing.count > RATE_MAX_ATTEMPTS) {
			throw new AuthError(`too many attempts; retry in ${Math.ceil((existing.resetAt - now) / 1000)}s`, 429);
		}
	}

	// --- storage ----------------------------------------------------------

	private pairingPath(): string {
		return paths.pairing(this.dataRoot);
	}

	private devicesPath(): string {
		return paths.devices(this.dataRoot);
	}

	private async readPairing(): Promise<PairingFile | undefined> {
		try {
			const parsed = JSON.parse(await readFile(this.pairingPath(), "utf8")) as PairingFile;
			return typeof parsed.code === "string" ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private async writePairing(file: PairingFile): Promise<void> {
		await this.writeJson(this.pairingPath(), file);
	}

	private async readDevices(): Promise<DeviceRecord[]> {
		try {
			const parsed = JSON.parse(await readFile(this.devicesPath(), "utf8")) as DeviceFile;
			return Array.isArray(parsed.devices) ? parsed.devices : [];
		} catch {
			return [];
		}
	}

	private async mutateDevices(change: (devices: DeviceRecord[]) => void): Promise<void> {
		const devices = await this.readDevices();
		change(devices);
		await this.writeJson(this.devicesPath(), { version: 1 as const, devices });
	}

	private async writeJson(file: string, value: unknown): Promise<void> {
		await mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
		await rename(temporary, file);
	}
}

function publicDevice(device: DeviceRecord): Omit<DeviceRecord, "tokenHash"> {
	const { tokenHash: _hash, ...rest } = device;
	return rest;
}

/** Compares two secrets without leaking where they differ. */
function constantTimeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

// --- what leaves the machine --------------------------------------------

/**
 * Redact credential-shaped strings from anything the gateway is about to send.
 *
 * This is not the auth boundary — the token is — and it does not need to be
 * perfect to be worth having: session transcripts routinely contain the token,
 * the private key, or the API key the agent was asked to debug, and a phone that
 * syncs its clipboard to a cloud backup will happily keep them forever.
 */
export function mask(text: string): string {
	let out = text;
	// PEM blocks: keep a shape marker instead of the body.
	out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "«private key redacted»");
	// JWTs: three base64url segments separated by dots.
	out = out.replace(/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, "«jwt redacted»");
	// Vendor-prefixed keys, long enough to be real but not so long that a hash matches.
	out = out.replace(/\b(?:sk|pk|rk|api|key|token|secret|bearer)[-_][A-Za-z0-9]{16,}\b/g, (match) => `«${match.slice(0, 2)}…redacted»`);
	out = out.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, (match) => `«${match.slice(0, 3)}…redacted»`);
	out = out.replace(/\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9]{16,}\b/g, "«github token redacted»");
	out = out.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "«slack token redacted»");
	// Authorization headers and their values.
	out = out.replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;}]{6,}/gi, "$1«redacted»");
	// Long high-entropy blobs: a 32+ character base64hex run is almost never prose.
	out = out.replace(/\b[A-Za-z0-9_-]{40,}={0,2}\b/g, "«secret redacted»");
	return out;
}

/** Mask every string in a JSON-serialisable value, leaving structure intact. */
export function maskValue<T>(value: T): T {
	if (typeof value === "string") return mask(value) as T;
	if (Array.isArray(value)) return value.map((entry) => maskValue(entry)) as T;
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = typeof entry === "string" ? mask(entry) : maskValue(entry);
		}
		return out as T;
	}
	return value;
}
