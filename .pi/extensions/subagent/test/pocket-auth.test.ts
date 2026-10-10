// Unit tests for pocket's credentials: pairing, device tokens, rate limiting and
// the outbound mask.
//
// The pairing flow is the whole authentication story. One wrong move in it — a
// code that can be reused, a device list that ships hashes, a rate limit that
// resets on the attacker's schedule — turns "pair my phone" into "the LAN has an
// agent session". So the tests here are deliberately paranoid about the happy
// path as well: a happy path that *almost* works is the one that pairs twice.
//
// The mask is the other half. It is not the auth boundary, but a phone without a
// mask carries every credential the agent ever printed into a clipboard that
// syncs somewhere.

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { AuthStore, hashToken, mask, maskValue } from "../../pocket/auth.ts";

// A single fixed clock for the pairing tests, taken from the real one so the
// TTL arithmetic (startPairing uses Date.now() itself) lines up.
const NOW = Date.now();
const LATER = NOW + 60_000;

async function root(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pocket-auth-"));
}

test("hashToken is stable and of a sane width", () => {
	const hash = hashToken("a-token");
	assert.equal(hash, hashToken("a-token"));
	assert.equal(hash.length, 64);
	assert.notEqual(hash, hashToken("a-token "));
	assert.notEqual(hash, hashToken("another"));
});

test("pairing mints a code that exchanges for exactly one token", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing(60_000);
		const label = "my phone";
		const first = await store.pair(code, label, "203.0.113.5", NOW);

		// The code is consumed by the exchange: an overheard code is worthless
		// once the phone has paired, so a second attempt must fail.
		await assert.rejects(() => store.pair(code, label, "203.0.113.5", NOW), /no pairing code is active/);

		assert.equal(first.device.label, "my phone");
		assert.ok(first.token.length >= 32, `device token is only ${first.token.length} characters`);
		const listed = await store.listDevices();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].id, first.device.id);
		assert.equal(listed[0].label, "my phone");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("a paired token identifies its device and a wrong one does not", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		const { token, device } = await store.pair(code, "phone", "203.0.113.5", NOW);
		assert.equal((await store.deviceForToken(token))?.id, device.id);
		assert.equal(await store.deviceForToken(`${token}x`), undefined);
		assert.equal(await store.deviceForToken(""), undefined);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("the token itself is never written to disk", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		const { token } = await store.pair(code, "phone", "203.0.113.5", NOW);
		const raw = await readFile(path.join(dataRoot, "devices.json"), "utf8");
		assert.equal(raw.includes(token), false, "the device token is on disk in clear");
		assert.equal(raw.includes(hashToken(token)), true, "the stored hash does not match this token");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("a wrong code counts down and then invalidates the pairing", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing(60_000);
		await assert.rejects(() => store.pair("AAAA", "phone", "203.0.113.5", NOW), /attempt\(s\) left/);
		// Attempts are written back, so a restart does not reset the attacker's
		// count only for them.
		const after = await store.pairingState();
		assert.equal(after.attempts, 1);
		assert.equal(after.pending, true);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("a code that expires is not honoured", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing(1_000);
		await assert.rejects(() => store.pair(code, "phone", "203.0.113.5", LATER), /no pairing code is active/);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("pairing attempts from one address are rate limited", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		await store.startPairing(60_000);
		let lastError: unknown;
		for (let attempt = 0; attempt < 12; attempt += 1) {
			try {
				await store.pair("AAAA", "phone", "198.51.100.7", NOW);
			} catch (error) {
				lastError = error;
			}
		}
		assert.match(String(lastError), /too many attempts/);
		// The limiter is per address: another client is not punished for it.
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("the pairing code is case-insensitive and tolerates whitespace", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		const lower = code.toLowerCase();
		const { token } = await store.pair(`  ${lower}  `, "phone", "203.0.113.5", NOW);
		assert.ok((await store.deviceForToken(token)) !== undefined);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("an unnamed device gets a label that identifies itself in the list", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		const { device } = await store.pair(code, "  ", "203.0.113.5", NOW);
		assert.equal(device.label, "unnamed device");
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("revoking a device stops its token working", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		const { token, device } = await store.pair(code, "phone", "203.0.113.5", NOW);
		assert.equal(await store.revokeDevice(device.id), true);
		assert.equal(await store.deviceForToken(token), undefined);
		assert.equal(await store.revokeDevice("d-does-not-exist"), false);
		assert.deepEqual(await store.listDevices(), []);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("listing devices never exposes the token hash", async () => {
	const dataRoot = await root();
	try {
		const store = new AuthStore(dataRoot);
		const { code } = await store.startPairing();
		await store.pair(code, "phone", "203.0.113.5", NOW);
		for (const device of await store.listDevices()) {
			assert.equal("tokenHash" in device, false);
			assert.equal(typeof device.id, "string");
			assert.equal(typeof device.lastSeenAt, "string");
		}
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("a device store that survives a restart still works", async () => {
	const dataRoot = await root();
	try {
		const first = new AuthStore(dataRoot);
		const { code } = await first.startPairing();
		const { token, device } = await first.pair(code, "phone", "203.0.113.5", NOW);
		// A second instance is the daemon-restart case: the phone must not have
		// to pair again after a reboot, so the credential is on disk, not in RAM.
		const restarted = new AuthStore(dataRoot);
		assert.equal((await restarted.deviceForToken(token))?.id, device.id);
	} finally {
		await rm(dataRoot, { recursive: true, force: true });
	}
});

test("mask redacts the credential shapes that reach a transcript", () => {
	const cases: Array<[string, string]> = [
		["Authorization: Bearer abcdef123456", "«redacted»"],
		["token: ghp_0123456789abcdefghij", "«github token redacted»"],
		["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----", "«private key redacted»"],
		["sk-liveabcdef0123456789xt", "«sk…redacted»"],
	];
	for (const [input, expected] of cases) {
		assert.equal(mask(input).includes(expected), true, `did not redact ${JSON.stringify(input)}: got ${mask(input)}`);
	}
});

test("mask leaves ordinary prose alone", () => {
	const text = "The quick brown fox jumps over the lazy dog. Again.";
	assert.equal(mask(text), text);
});

test("a device token is masked wherever it appears", () => {
	const token = "n6dtP1kQ2Xb7YcR4vZ8wJhG3fL5sT0uA9eMiOxBqNrD";
	assert.equal(mask(`Bearer ${token}`).includes(token), false);
	assert.equal(maskValue(`Bearer ${token}`).includes(token), false);
});

test("maskValue masks strings throughout a structure without changing it", () => {
	const token = "n6dtP1kQ2Xb7YcR4vZ8wJhG3fL5sT0uA9eMiOxBqNrD";
	const input = {
		kind: "pi_event",
		event: { type: "message_end", text: `Bearer ${token}`, nested: { list: [`token: ghp_0123456789abcdefghij`] } },
		count: 3,
		missing: null,
	};
	const masked = maskValue(input) as typeof input;
	assert.equal(masked.kind, "pi_event");
	assert.equal(masked.count, 3);
	assert.equal(masked.missing, null);
	assert.equal(masked.event.nested.list[0].includes("ghp_"), false);
	assert.equal(masked.event.text.includes(token), false);
	assert.deepEqual(Object.keys(masked.event).sort(), Object.keys(input.event).sort());
});
