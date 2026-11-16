// Behaviour pin for the `bg` tool's completion notifications (ticket 05).
//
// Risk covered: the tool exists to encourage parallel work, so the notification
// path is where noise multiplies. A per-job message turns a five-job fan-out into
// five interruptions; a message that names only the last job loses the other
// four; a steer while idle is a message nobody ever reads; and a timer that
// outlives its session either sends into a dead one or hangs the suite.
//
// Two seams, deliberately:
//
//   - The REAL extension factory through `withBgHarness`, driving real detached
//     jobs and asserting on the fake API's `sendMessage` record. This is where
//     "exactly one message for three jobs" is observable without a terminal, and
//     the timings are real: the watcher's 500ms poll decides when a job settles,
//     and `BG_NOTIFY_DEBOUNCE_MS` decides when the window closes.
//   - The notify module directly, with an injected clock and a short window, for
//     the facts a live run cannot produce reliably — a flush that lands long
//     after the job finished (so age and duration differ), a repeated settle, a
//     shutdown before the window closes, and a window that never opened.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	BG_NOTIFY_DEBOUNCE_MS,
	BG_NOTIFY_MESSAGE_TYPE,
	createBgNotifier,
	formatSettledNotice,
	type BgNotifier,
} from "../../bg/notify.ts";
import type { BgJobRecord } from "../../bg/store.ts";
import { withBgHarness, type BgMessage } from "./bg-harness.ts";
import { waitFor } from "./helpers.ts";

/** Longer than one settle window, so a second message would certainly have arrived. */
const PAST_WINDOW_MS = BG_NOTIFY_DEBOUNCE_MS + 400;

function textOf(entry: BgMessage): string {
	const content = entry.message.content;
	assert.equal(typeof content, "string", "the completion message must be text");
	return content as string;
}

function jobOf(result: { details: Record<string, unknown>; text: string }): { id: string; logPath: string } {
	const job = result.details.job as { id?: string; logPath?: string } | undefined;
	assert.ok(job?.id, `the result must carry the job: ${result.text}`);
	return { id: job.id, logPath: job.logPath as string };
}

/** A record that finished for real, so only the notifier's own logic is under test. */
function settledRecord(overrides: Partial<BgJobRecord> = {}): BgJobRecord {
	const startedAt = 1_000_000;
	return {
		id: "aaaa1111",
		sessionId: "bg-notify-unit",
		pid: null,
		pgid: null,
		command: "node --test .pi/extensions/subagent/test/*.test.ts",
		cwd: "/repo",
		logPath: "/agent/bg-jobs/bg-notify-unit/aaaa1111/output.log",
		state: "exited",
		exitCode: 0,
		startedAt,
		finishedAt: startedAt + 5_000,
		...overrides,
	};
}

interface FakePi {
	pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => () => void; sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => void };
	messages: BgMessage[];
	/** Fire a session event, handing the notifier the context pi would. */
	emit: (event: string) => void;
	setIdle: (idle: boolean) => void;
}

/** Only what the notifier touches: `on` and `sendMessage`. */
function fakePi(): FakePi {
	const messages: BgMessage[] = [];
	const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
	let idle = true;
	const ctx = {
		isIdle: () => idle,
	};
	return {
		pi: {
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => undefined;
			},
			sendMessage: (message, options) => {
				messages.push({ message, options });
			},
		},
		messages,
		emit: (event) => {
			for (const handler of handlers.get(event) ?? []) handler({}, ctx);
		},
		setIdle: (value) => {
			idle = value;
		},
	};
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("three jobs finishing in one window produce exactly one message naming all three", async () => {
	await withBgHarness(async (h) => {
		// Same exit moment, different exit codes and durations: a per-job flush would
		// produce three messages, and a message that only kept the last job would
		// still pass a "some message exists" assertion. Both are ruled out by
		// checking the count AND every id in the one message.
		const commands = ["sleep 0.1; exit 0", "sleep 0.1; exit 3", "sleep 0.1; exit 42"];
		const started = [];
		for (const command of commands) started.push(jobOf(await h.call({ action: "start", command })));

		await waitFor(() => h.messages.length > 0, 20_000);
		// Well past the window: a second or third message would have arrived by now.
		await sleep(PAST_WINDOW_MS);

		assert.equal(h.messages.length, 1, `exactly one message per settle window, got ${h.messages.length}: ${h.messages.map(textOf).join("\n---\n")}`);
		const content = textOf(h.messages[0]!);
		assert.match(content, /3 background jobs finished\./, content);

		const expected = [
			{ id: started[0]!.id, exit: 0 },
			{ id: started[1]!.id, exit: 3 },
			{ id: started[2]!.id, exit: 42 },
		];
		for (const { id, exit } of expected) {
			// id, exit code, runtime, age and log path — every fact the acceptance
			// criteria name, on one line each.
			assert.match(
				content,
				new RegExp(`${id} · exit ${exit} · ran \\d+s · job age \\d+s`),
				`the message must name ${id} with its exit code and timings:\n${content}`,
			);
			assert.ok(content.includes(`command: ${commands[expected.findIndex((entry) => entry.id === id)]}`), `the message must show the command's first line:\n${content}`);
		}
		for (const { logPath } of started) {
			assert.ok(content.includes(logPath), `the message must point at the log ${logPath}:\n${content}`);
		}
		assert.equal(h.messages[0]!.message.customType, BG_NOTIFY_MESSAGE_TYPE);

		// The machine-readable half carries the same facts, so a renderer or the
		// agent can use them without parsing prose.
		const details = h.messages[0]!.message.details as { jobs: { id: string; exitCode: number; durationMs: number; ageMs: number }[] };
		assert.deepEqual(
			details.jobs.map((job) => [job.id, job.exitCode]),
			expected.map((entry) => [entry.id, entry.exit]),
		);
		assert.ok(details.jobs.every((job) => job.durationMs >= 0 && job.ageMs >= 0));
	});
});

test("jobs finishing in separate windows produce separate messages", async () => {
	await withBgHarness(async (h) => {
		const first = jobOf(await h.call({ action: "start", command: "sleep 0.1; exit 1" }));
		await waitFor(() => h.messages.length >= 1, 20_000);
		const firstContent = textOf(h.messages[0]!);
		assert.match(firstContent, /1 background job finished\./, firstContent);
		assert.ok(firstContent.includes(first.id), firstContent);

		// Not started until the first window has closed, so this one cannot be
		// folded into it.
		const second = jobOf(await h.call({ action: "start", command: "sleep 0.1; exit 2" }));
		assert.ok(!second.id.includes(first.id));

		await waitFor(() => h.messages.length >= 2, 20_000);
		await sleep(PAST_WINDOW_MS);

		assert.equal(h.messages.length, 2, `two windows, two messages: ${h.messages.map(textOf).join("\n---\n")}`);
		const secondContent = textOf(h.messages[1]!);
		assert.ok(secondContent.includes(second.id), secondContent);
		assert.ok(!secondContent.includes(first.id), `the second message must not re-report the first job:\n${secondContent}`);
		assert.match(secondContent, /exit 2/);
		assert.ok(!firstContent.includes(second.id), "the first message cannot know about a job started after it");
	});
});

test("a completion steers a streaming agent and starts a turn for an idle one", async () => {
	await withBgHarness(async (h) => {
		// Idle first: the agent must be woken, or nothing ever reads the message.
		assert.equal(h.isIdle(), true);
		jobOf(await h.call({ action: "start", command: "sleep 0.1; exit 0" }));
		await waitFor(() => h.messages.length >= 1, 20_000);
		assert.deepEqual(h.messages[0]!.options, { triggerTurn: true }, "an idle session needs a turn to see the message");

		// Then streaming: a steer, which the running turn picks up after its current
		// tool calls. A triggerTurn here would queue a second turn behind the first.
		h.setIdle(false);
		assert.equal(h.isIdle(), false);
		jobOf(await h.call({ action: "start", command: "sleep 0.1; exit 4" }));
		await waitFor(() => h.messages.length >= 2, 20_000);
		assert.deepEqual(h.messages[1]!.options, { deliverAs: "steer" }, "a streaming session gets the message as a steer");
		assert.match(textOf(h.messages[1]!), /exit 4/);
	});
});

test("nothing finished means no message at all", async () => {
	// A job still running when the test ends: no settle, so no window, so nothing.
	await withBgHarness(async (h) => {
		jobOf(await h.call({ action: "start", command: "sleep 30" }));
		await sleep(PAST_WINDOW_MS);
		assert.deepEqual(h.messages, [], "a running job must not be announced as finished");
	});

	// A job that never started: it is never watched, so it never settles either.
	const missingCwd = path.join(tmpdir(), "bg-notify-no-such-directory");
	await withBgHarness(
		async (h) => {
			const result = await h.call({ action: "start", command: "echo hello" });
			assert.match(result.text, /^Error: /, result.text);
			await sleep(PAST_WINDOW_MS);
			assert.deepEqual(h.messages, [], "a failed-to-start job must not be announced");
		},
		{ cwd: missingCwd },
	);
});

test("the message reports the job's own log path, outside the harness", async () => {
	// The log path is not a decoration: it is how the agent reads the output
	// without another tool call. Prove it exists and that the message matches it.
	await withBgHarness(async (h) => {
		const { id, logPath } = jobOf(await h.call({ action: "start", command: "echo notify-proof" }));
		await waitFor(() => h.messages.length >= 1, 20_000);
		assert.equal(logPath, path.join(h.jobDir(id), "output.log"));
		assert.match(textOf(h.messages[0]!), new RegExp(`log: ${logPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(await h.readLog(id), /notify-proof/);
	});
});

test("a late flush reports a job's true age, distinct from its runtime", async () => {
	const fake = fakePi();
	fake.emit("session_start");
	const clock = 1_010_000; // the job finished at 1_005_000: ten seconds of age, five of runtime
	const notifier = createBgNotifier(fake.pi, { debounceMs: 60_000, now: () => clock });

	try {
		notifier.settled(settledRecord());
		assert.equal(notifier.pending(), 1);
		notifier.flush();
		assert.equal(fake.messages.length, 1);
		const content = textOf(fake.messages[0]!);
		assert.match(content, /ran 5s/, content);
		assert.match(content, /job age 10s/, content);
		assert.match(content, /1 background job finished\./, content);
		assert.match(content, /command: node --test/, content);
		const details = fake.messages[0]!.message.details as { jobs: { durationMs: number; ageMs: number }[] };
		assert.equal(details.jobs[0]!.durationMs, 5_000);
		assert.equal(details.jobs[0]!.ageMs, 10_000);
	} finally {
		notifier.stop();
	}
});

test("a job settled twice is named once, and jobs are ordered by when they finished", async () => {
	const fake = fakePi();
	fake.emit("session_start");
	const notifier = createBgNotifier(fake.pi, { debounceMs: 60_000, now: () => 1_020_000 });
	try {
		const later = settledRecord({ id: "bbbb2222", finishedAt: 1_010_000 });
		const earlier = settledRecord({ id: "cccc3333", finishedAt: 1_008_000 });
		notifier.settled(later);
		notifier.settled(earlier);
		notifier.settled(later); // a re-delivered settle must not duplicate the block
		assert.equal(notifier.pending(), 2);
		notifier.flush();

		assert.equal(fake.messages.length, 1);
		const content = textOf(fake.messages[0]!);
		assert.equal(content.split("bbbb2222").length - 1, 1, content);
		assert.equal(content.split("cccc3333").length - 1, 1, content);
		assert.ok(content.indexOf("cccc3333") < content.indexOf("bbbb2222"), `oldest finish first:\n${content}`);
	} finally {
		notifier.stop();
	}
});

test("flush with nothing pending emits nothing, and stop() drops an open window", async () => {
	const fake = fakePi();
	fake.emit("session_start");
	const notifier = createBgNotifier(fake.pi, { debounceMs: 10, now: () => 2_000_000 });
	try {
		notifier.flush();
		assert.deepEqual(fake.messages, [], "an empty window is not a message");

		notifier.settled(settledRecord());
		assert.equal(notifier.pending(), 1);
		notifier.stop();
		assert.equal(notifier.pending(), 0, "stop() drops what was pending");
		// The timer is gone, so it cannot fire into a dead session either.
		await sleep(60);
		assert.deepEqual(fake.messages, [], "nothing is delivered after stop()");

		notifier.settled(settledRecord());
		notifier.flush();
		assert.deepEqual(fake.messages, [], "a settled job after stop() is not announced");
	} finally {
		notifier.stop();
	}
});

test("session_shutdown stops the timer, so a pending window is never delivered", async () => {
	const fake = fakePi();
	fake.emit("session_start");
	const notifier = createBgNotifier(fake.pi, { debounceMs: 30 });
	notifier.settled(settledRecord());
	fake.emit("session_shutdown");
	await sleep(120);
	assert.deepEqual(fake.messages, [], "the window must not close into a shut-down session");
	notifier.stop();
});

test("a settle with no session context at all is still delivered, as an idle turn", async () => {
	// Not the normal path — the watcher only watches jobs after session_start — but
	// the fallback is a decision, so it is pinned: delivering beats dropping.
	const fake = fakePi();
	const notifier = createBgNotifier(fake.pi, { debounceMs: 10 });
	try {
		notifier.settled(settledRecord());
		await waitFor(() => fake.messages.length > 0, 2_000);
		assert.deepEqual(fake.messages[0]!.options, { triggerTurn: true });
	} finally {
		notifier.stop();
	}
});

test("the notice names a job whose exit status was never observed as unknown, not zero", () => {
	// An adopted job has no exit code (see BgJobRecord): reporting 0 would be a
	// confident lie about a failure.
	const content = formatSettledNotice([settledRecord({ exitCode: null })], 1_100_000);
	assert.match(content, /exit unknown/, content);
	assert.doesNotMatch(content, /exit 0/, content);
});
