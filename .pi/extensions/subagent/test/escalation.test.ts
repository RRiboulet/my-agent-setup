// The child→parent escalation channel (`escalation.ts`): the request and reply
// files, their atomicity, bounds, expiry, replay and the child's wait.
//
// Risk covered: this is a file protocol across two processes AND two builds. A
// partial write read as a request, an expired request delivered late, or a
// replay handled twice all produce the same class of bug — a child receives an
// answer nobody gave, or the parent acts on a decision that was never made — and
// none of them is visible from a passing round trip.

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import {
	DEFAULT_QUESTION_GRACE_MS,
	DEFAULT_QUESTION_TIMEOUT_MS,
	ESCALATION_DIR,
	HEARTBEAT_FILE,
	MAX_OPTIONS,
	MAX_TEXT_CHARS,
	clearEscalationHeartbeat,
	consumeEscalationExchange,
	escalationDir,
	isValidRequestId,
	listEscalationRequests,
	readEscalationHeartbeat,
	readEscalationReply,
	readEscalationRequest,
	replyPath,
	requestPath,
	touchEscalationHeartbeat,
	validateEscalationReply,
	validateEscalationRequest,
	waitForEscalationReply,
	writeEscalationReply,
	writeEscalationRequest,
	type EscalationRequest,
} from "../escalation.ts";
import { withTempAgentDir } from "./helpers.ts";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const REQUEST_ID = "ask-0000000000000001";

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		id: REQUEST_ID,
		runId: RUN_ID,
		kind: "question",
		text: "Postgres or SQLite for the new store?",
		options: ["postgres", "sqlite"],
		askedAt: 1_700_000_000_000,
		deadlineAt: 1_700_000_300_000,
		...overrides,
	};
}

function reply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		id: REQUEST_ID,
		runId: RUN_ID,
		answer: "postgres",
		answeredAt: 1_700_000_100_000,
		...overrides,
	};
}

test("the channel lives inside the run dir, one file per request id", () => {
	const dir = escalationDir("/tmp/run");
	assert.equal(dir, path.join("/tmp/run", ESCALATION_DIR));
	assert.equal(requestPath(dir, REQUEST_ID), path.join(dir, `${REQUEST_ID}.request.json`));
	assert.equal(replyPath(dir, REQUEST_ID), path.join(dir, `${REQUEST_ID}.reply.json`));
});

test("a request id is a filename, so it must be safe as one", () => {
	assert.equal(isValidRequestId("ask-0000000000000001"), true);
	assert.equal(isValidRequestId("a1b2c3d4"), true);
	for (const id of ["", "..", "../../etc/passwd", "a/b", "a b", "short", `${"a".repeat(65)}`, ".hidden1"]) {
		assert.equal(isValidRequestId(id), false, `${JSON.stringify(id)} must not be accepted`);
	}
});

test("a written request round-trips through the file reader", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		const request: EscalationRequest = {
			version: 1,
			id: REQUEST_ID,
			runId: RUN_ID,
			kind: "question",
			text: "Which database?",
			options: ["postgres", "sqlite"],
			askedAt: 1_700_000_000_000,
			deadlineAt: 1_700_000_300_000,
		};
		await writeEscalationRequest(dir, request);
		const read = await readEscalationRequest(requestPath(dir, REQUEST_ID), { runId: RUN_ID });
		assert.equal(read.ok, true);
		assert.deepEqual(read.ok === true && read.value, request);
		// Atomicity is observable: the write left no temp file behind, and the
		// directory holds exactly the request.
		assert.deepEqual(await readdir(dir), [`${REQUEST_ID}.request.json`]);
	});
});

test("a partial write is never read as a valid request", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await mkdir(dir, { recursive: true });
		// A non-atomic writer caught mid-write: the shape is unusable, and the
		// parent must not surface half a question.
		await writeFile(requestPath(dir, REQUEST_ID), JSON.stringify(question()).slice(0, 40), "utf8");
		const partial = await readEscalationRequest(requestPath(dir, REQUEST_ID), { runId: RUN_ID });
		assert.equal(partial.ok, false);
		assert.equal(partial.ok === false && partial.reason, "invalid");

		// A leftover temp file from a crashed atomic write is not a request: it does
		// not carry the suffix, so it is neither listed nor read.
		const tempName = `${REQUEST_ID}.request.json.1234.dead-beef.tmp`;
		await writeFile(path.join(dir, tempName), `${JSON.stringify(question())}\n`, "utf8");
		assert.deepEqual(await listEscalationRequests(dir), [{ id: REQUEST_ID, file: requestPath(dir, REQUEST_ID) }]);
	});
});

test("a request from another run, or of an unusable shape, is refused", async () => {
	for (const [label, value] of [
		["not an object", []],
		["wrong run", question({ runId: "another-run" })],
		["unknown kind", question({ kind: "decision" })],
		["no deadline on a question", question({ deadlineAt: undefined })],
		["options on a progress update", question({ kind: "progress", options: ["a"] })],
		["an unsafe id", question({ id: "../../escape" })],
		["empty text", question({ text: "   " })],
		["text past the cap", question({ text: "x".repeat(MAX_TEXT_CHARS + 1) })],
		["too many options", question({ options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => `o${index}`) })],
		["a non-string option", question({ options: [1] })],
		["a non-finite askedAt", question({ askedAt: "soon" })],
	] as const) {
		const result = validateEscalationRequest(value, { runId: RUN_ID });
		assert.equal(result.ok, false, `${label} must be rejected`);
	}
	// A newer version with a shape this build understands is ACCEPTED, and the
	// version is quoted only when it explains a rejection.
	const newer = validateEscalationRequest(question({ version: 2 }), { runId: RUN_ID });
	assert.equal(newer.ok, true);
	assert.equal(newer.ok === true && newer.value.version, 2);
	const skewed = validateEscalationRequest(question({ version: 9, text: "" }), { runId: RUN_ID });
	assert.equal(skewed.ok, false);
	assert.match(skewed.ok === false ? (skewed.error ?? "") : "", /version 9.*version 1/);
});

test("a written question over the size bound is refused before it reaches the disk", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await assert.rejects(
			writeEscalationRequest(dir, {
				version: 1,
				id: REQUEST_ID,
				runId: RUN_ID,
				kind: "question",
				text: "x".repeat(MAX_TEXT_CHARS + 1),
				askedAt: Date.now(),
				deadlineAt: Date.now() + 60_000,
			}),
			/unusable escalation request/,
		);
		assert.deepEqual(await listEscalationRequests(dir), []);
	});
});

test("a reply is validated against the request it answers", async () => {
	assert.equal(validateEscalationReply(reply(), { runId: RUN_ID, id: REQUEST_ID }).ok, true);
	for (const [label, value] of [
		["another request id", reply({ id: "ask-0000000000000002" })],
		["another run", reply({ runId: "another-run" })],
		["no answer", reply({ answer: "  " })],
		["an answer past the cap", reply({ answer: "x".repeat(4_001) })],
		["no answeredAt", reply({ answeredAt: undefined })],
	] as const) {
		assert.equal(validateEscalationReply(value, { runId: RUN_ID, id: REQUEST_ID }).ok, false, `${label} must be rejected`);
	}
});

test("the parent's heartbeat is a tick stamp, and clearing it is what a shutdown does", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		assert.equal(await readEscalationHeartbeat(dir), undefined, "no heartbeat before the first tick");
		await touchEscalationHeartbeat(dir);
		const first = await readEscalationHeartbeat(dir);
		assert.ok(first !== undefined, "a tick publishes the heartbeat");
		assert.equal(path.basename(path.join(dir, HEARTBEAT_FILE)), HEARTBEAT_FILE);
		// The heartbeat is not a request, so it never shows up as one.
		assert.deepEqual(await listEscalationRequests(dir), []);
		await clearEscalationHeartbeat(dir);
		assert.equal(await readEscalationHeartbeat(dir), undefined);
	});
});

test("a wait is answered by a reply", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		const deadlineAt = Date.now() + 5_000;
		const pending = waitForEscalationReply({ dir, id: REQUEST_ID, runId: RUN_ID, deadlineAt, pollMs: 10, graceMs: 5_000 });
		await writeEscalationReply(dir, { version: 1, id: REQUEST_ID, runId: RUN_ID, answer: "postgres", answeredAt: Date.now() });
		assert.deepEqual(await pending, { state: "answered", answer: "postgres" });
	});
});

test("a wait past its deadline reports expiry instead of answering", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		// A reply that lands AFTER the deadline is not taken as an in-time answer by
		// the parent's tool (it refuses to write one), but the child must also give
		// up on its own clock, and it must not wait for the heartbeat first.
		const outcome = await waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() - 1,
			pollMs: 10,
			graceMs: 5_000,
		});
		assert.deepEqual(outcome, { state: "expired", deadlineAt: outcome.state === "expired" ? outcome.deadlineAt : 0 });
		assert.equal(outcome.state === "expired" && outcome.deadlineAt <= Date.now(), true);
	});
});

test("a reply that landed before the deadline is still accepted on the poll that follows it", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await writeEscalationReply(dir, { version: 1, id: REQUEST_ID, runId: RUN_ID, answer: "in time", answeredAt: Date.now() - 1 });
		const outcome = await waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() - 1,
			pollMs: 10,
		});
		assert.deepEqual(outcome, { state: "answered", answer: "in time" });
	});
});

test("a wait with no parent fails fast instead of hanging to the deadline", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await mkdir(dir, { recursive: true });
		const startedAt = Date.now();
		const outcome = await waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() + 60_000,
			pollMs: 10,
			graceMs: 120,
		});
		assert.equal(outcome.state, "no-parent");
		assert.match(outcome.state === "no-parent" ? outcome.detail : "", /no parent session/);
		assert.ok(Date.now() - startedAt < 5_000, "the grace window, not the deadline, is what ends the wait");
	});
});

test("a parent that stopped ticking is detected from a stale heartbeat", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await touchEscalationHeartbeat(dir);
		// A parent that died a while ago: its last heartbeat is old. (The mtime,
		// not the content, is the signal, so this is exactly what a stopped ticker
		// leaves behind.)
		const stale = (Date.now() - 60_000) / 1000;
		await utimes(path.join(dir, HEARTBEAT_FILE), stale, stale);
		const outcome = await waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() + 60_000,
			pollMs: 10,
			graceMs: 120,
		});
		assert.equal(outcome.state, "no-parent");
		assert.match(outcome.state === "no-parent" ? outcome.detail : "", /stopped answering/);
	});
});

test("a live parent keeps the wait going past the grace window", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		const deadlineAt = Date.now() + 60_000;
		const pending = waitForEscalationReply({ dir, id: REQUEST_ID, runId: RUN_ID, deadlineAt, pollMs: 10, graceMs: 150 });
		// Tick like the parent's watcher does, then answer, well after the grace
		// window would have expired the wait without a heartbeat.
		for (let tick = 0; tick < 8; tick++) {
			await touchEscalationHeartbeat(dir);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		await writeEscalationReply(dir, { version: 1, id: REQUEST_ID, runId: RUN_ID, answer: "still here", answeredAt: Date.now() });
		assert.deepEqual(await pending, { state: "answered", answer: "still here" });
	});
});

test("an aborted tool call ends the wait at once", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		const controller = new AbortController();
		const pending = waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() + 60_000,
			pollMs: 10,
			graceMs: 60_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 30);
		assert.deepEqual(await pending, { state: "aborted" });
		// Already-aborted is the same answer, not a timer that has to fire first.
		const second = new AbortController();
		second.abort();
		const immediate = await waitForEscalationReply({
			dir,
			id: REQUEST_ID,
			runId: RUN_ID,
			deadlineAt: Date.now() + 60_000,
			graceMs: 60_000,
			signal: second.signal,
		});
		assert.deepEqual(immediate, { state: "aborted" });
	});
});

test("consuming an exchange removes both files, so a replay finds nothing", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		await writeEscalationRequest(dir, {
			version: 1,
			id: REQUEST_ID,
			runId: RUN_ID,
			kind: "question",
			text: "Which database?",
			askedAt: Date.now(),
			deadlineAt: Date.now() + 60_000,
		});
		await writeEscalationReply(dir, { version: 1, id: REQUEST_ID, runId: RUN_ID, answer: "postgres", answeredAt: Date.now() });
		await consumeEscalationExchange(dir, REQUEST_ID);
		assert.deepEqual(await listEscalationRequests(dir), []);
		assert.deepEqual(await readEscalationReply(replyPath(dir, REQUEST_ID), { runId: RUN_ID, id: REQUEST_ID }), {
			ok: false,
			reason: "missing",
		});
		// Idempotent: consuming twice is not an error.
		await consumeEscalationExchange(dir, REQUEST_ID);
		assert.deepEqual(await readdir(dir), []);
	});
});

test("the documented defaults describe a bounded wait", () => {
	// The numbers are the contract the parent's message quotes and the child's tool
	// applies; pin them so a change is deliberate.
	assert.equal(DEFAULT_QUESTION_GRACE_MS, 5_000);
	assert.equal(MAX_TEXT_CHARS, 4_000);
	// The child's default deadline must outlast the parent's 500ms tick by a lot,
	// or a healthy parent would look slow.
	assert.equal(DEFAULT_QUESTION_TIMEOUT_MS, 300_000);
});

test("a read of a request file reports a missing file as missing, not as invalid", async () => {
	await withTempAgentDir(async (agentDir) => {
		const dir = escalationDir(path.join(agentDir, "run"));
		assert.deepEqual(await readEscalationRequest(requestPath(dir, REQUEST_ID), { runId: RUN_ID }), {
			ok: false,
			reason: "missing",
		});
		await mkdir(dir, { recursive: true });
		await writeFile(requestPath(dir, REQUEST_ID), "", "utf8");
		const empty = await readEscalationRequest(requestPath(dir, REQUEST_ID), { runId: RUN_ID });
		assert.equal(empty.ok, false);
		assert.equal(empty.ok === false && empty.reason, "invalid");
		// The file is untouched by a read: the child still owns it until it consumes
		// the exchange.
		assert.equal(await readFile(requestPath(dir, REQUEST_ID), "utf8"), "");
	});
});
