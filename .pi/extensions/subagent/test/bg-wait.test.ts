// Behaviour pin for `bg wait`: the tool call blocks until the job settles, or
// until its bounded timeout says the job is still running.
//
// Risk covered: the action exists because a caller that may not outlive the job
// cannot rely on the completion notification — the watcher timer lives in the
// process that started the job, so a caller that ends its turn first exits, the
// watcher dies, and the job runs on unobserved while the caller believes it will
// be woken. Everything below is a way that fix can fail: a wait that returns
// before the settle (answering "running" for a job that already finished), one
// that returns too late or not at all, one that invents an exit code it never
// observed, and — the subtle one — one that reports the settle AND lets the
// notification deliver the same fact again a second later.
//
// Real detached shell processes through the real extension factory
// (`withBgHarness`): pid liveness, the watcher's settle, the notification window
// and the on-disk record are the behaviour under test, and a mock would only
// assert our beliefs about them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { BG_NOTIFY_DEBOUNCE_MS } from "../../bg/notify.ts";
import { BG_WAIT_MAX_TIMEOUT_MS, resolveWaitTimeout } from "../../bg/wait.ts";
import { withBgHarness, type BgToolResult } from "./bg-harness.ts";
import { waitFor } from "./helpers.ts";

/** Longer than one settle window, so a notice that was going to arrive has arrived. */
const PAST_WINDOW_MS = BG_NOTIFY_DEBOUNCE_MS + 400;

/** Long enough that nothing here can accidentally wait a job out. */
const SLOW_COMMAND = "sleep 30";

function jobOf(result: BgToolResult): Record<string, unknown> {
	const job = result.details.job as Record<string, unknown> | undefined;
	assert.ok(job, `the result must carry the job: ${result.text}`);
	return job;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("wait returns on the settle with the real exit code, duration and log tail", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "echo waited-output; sleep 0.2; exit 7" });
		const id = jobOf(start).id as string;
		const logPath = jobOf(start).logPath as string;

		const result = await h.call({ action: "wait", id });

		assert.doesNotMatch(result.text, /^Error:/, result.text);
		assert.equal(result.details.action, "wait");
		assert.equal(result.details.settled, true, "a terminal record is a settle, not a timeout");
		assert.equal(result.details.timedOut, false);

		const job = jobOf(result);
		assert.equal(job.id, id);
		assert.equal(job.state, "exited");
		assert.equal(job.exitCode, 7, "the exit code the watcher reaped, not an invented one");
		assert.equal(job.logPath, logPath);
		assert.ok(typeof job.elapsedMs === "number" && (job.elapsedMs as number) >= 0, "a duration is reported");

		// The facts in prose, so the model needs no second call: what happened, how
		// long it ran, where the log is, and enough of the log to read.
		assert.match(result.text, new RegExp(`Job ${id}: exited`), result.text);
		assert.match(result.text, /Exit: 7/, result.text);
		assert.ok(result.text.includes(`Log: ${logPath}`), result.text);
		assert.match(result.text, /waited-output/, "the log tail comes with the result");
		assert.equal((result.details.tail as { totalLines: number }).totalLines > 0, true);

		// The record it reported is the record on disk.
		const stored = await h.readJob(id);
		assert.equal(stored.state, "exited");
		assert.equal(stored.exitCode, 7);
	});
});

test("an already-terminal job returns at once with its record", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "exit 3" });
		const id = jobOf(start).id as string;
		await h.waitForJob(id, (job) => job.state === "exited");

		const startedAt = Date.now();
		const result = await h.call({ action: "wait", id });
		const elapsed = Date.now() - startedAt;

		assert.ok(elapsed < 1_000, `a finished job must not be waited out (took ${elapsed}ms)`);
		assert.equal(result.details.settled, true);
		assert.equal(jobOf(result).state, "exited");
		assert.equal(jobOf(result).exitCode, 3);
		assert.match(result.text, /exit 3/);
	});
});

test("a killed job reports killed with an unknown exit code, never zero", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: SLOW_COMMAND });
		const id = jobOf(start).id as string;
		const kill = await h.call({ action: "kill", id });
		assert.equal(kill.details.killed, true, kill.text);

		const result = await h.call({ action: "wait", id });
		assert.doesNotMatch(result.text, /^Error:/, result.text);
		assert.equal(jobOf(result).state, "killed");
		assert.equal(jobOf(result).exitCode, null, "a signal death has no exit status to claim");
		assert.match(result.text, /killed/);
		assert.match(result.text, /Exit: \(killed\)/, "a killed job is described as killed, not given a status");
		// The lie this catches: null coerced to 0 reads as a clean exit.
		assert.doesNotMatch(result.text, /exit 0/);
	});
});

test("a timeout returns the partial state and the log so far, and does not kill the job", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "echo partial-output; sleep 30" });
		const id = jobOf(start).id as string;

		const startedAt = Date.now();
		const result = await h.call({ action: "wait", id, timeoutMs: 800 });
		const elapsed = Date.now() - startedAt;

		assert.doesNotMatch(result.text, /^Error:/, `a timeout is not an error: ${result.text}`);
		assert.equal(result.details.timedOut, true);
		assert.equal(result.details.settled, false);
		assert.ok((result.details.waitedMs as number) >= 700, `the result says how long this call waited: ${String(result.details.waitedMs)}ms`);
		assert.ok(elapsed < 10_000, `a 800ms wait took ${elapsed}ms`);

		const job = jobOf(result);
		assert.equal(job.state, "running", "the record it reports is the running one");
		assert.equal(job.exitCode, null);
		assert.match(result.text, /still running/i);
		assert.match(result.text, /timeoutMs 800/, "the caller is told what the bound was");
		assert.match(result.text, /partial-output/, "the output so far comes with the timeout");

		// Waiting is a question, not an instruction: the job is untouched.
		const stored = await h.readJob(id);
		assert.equal(stored.state, "running", "a timeout must not settle the record");
		process.kill(stored.pid as number, 0);
	});
});

test("the blocking case is bounded: a job that sleeps past a short timeout returns promptly", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "sleep 20" });
		const id = jobOf(start).id as string;

		const startedAt = Date.now();
		const result = await h.call({ action: "wait", id, timeoutMs: 300 });
		const elapsed = Date.now() - startedAt;

		// Prompt, not merely finished: the job runs for 20s, so anything near that
		// means the bound did not apply.
		assert.ok(elapsed < 5_000, `wait returned after ${elapsed}ms for a 300ms timeout`);
		assert.equal(result.details.timedOut, true);
		assert.equal(jobOf(result).state, "running");
	});
});

test("an unknown id is a clear error, not a hang", async () => {
	await withBgHarness(async (h) => {
		const startedAt = Date.now();
		const result = await h.call({ action: "wait", id: "deadbeef" });
		assert.ok(Date.now() - startedAt < 1_000, "an unknown id must not be waited out");
		assert.match(result.text, /^Error: /, result.text);
		assert.match(String(result.details.error), /no job deadbeef/);
	});
});

test("an absurd timeoutMs is refused with a clear message, before anything waits", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "sleep 0.1; exit 0" });
		const id = jobOf(start).id as string;

		for (const [timeoutMs, expected] of [
			[0, /greater than 0/],
			[-5, /greater than 0/],
			[1.5, /whole number/],
			[BG_WAIT_MAX_TIMEOUT_MS + 1, /at most 600000ms/],
			[Number.POSITIVE_INFINITY, /whole number/],
		] as const) {
			const startedAt = Date.now();
			const result = await h.call({ action: "wait", id, timeoutMs });
			assert.ok(Date.now() - startedAt < 1_000, `timeoutMs ${timeoutMs} must be refused, not waited out`);
			assert.match(result.text, /^Error: /, `timeoutMs ${timeoutMs}: ${result.text}`);
			assert.match(String(result.details.error), expected, `timeoutMs ${timeoutMs}: ${String(result.details.error)}`);
		}

		// The default and the ceiling themselves are accepted, not off-by-one
		// refusals. `undefined` is what the schema produces for an omitted field.
		assert.equal(resolveWaitTimeout(undefined), 300_000);
		assert.equal(resolveWaitTimeout(BG_WAIT_MAX_TIMEOUT_MS), BG_WAIT_MAX_TIMEOUT_MS);
	});
});

test("a settle consumed by wait is not delivered again as a notification", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "echo notified-once; exit 0" });
		const id = jobOf(start).id as string;

		const result = await h.call({ action: "wait", id });
		assert.equal(result.details.settled, true, `wait must return the settle: ${result.text}`);
		assert.equal(jobOf(result).exitCode, 0);

		// The notification window is a second wide and the settle may already have
		// been pending when wait answered, so this has to wait the window out: the
		// duplicate being guarded against would arrive here.
		await sleep(PAST_WINDOW_MS);
		assert.deepEqual(h.messages, [], "the agent heard the settle from the tool result, not twice");

		// A second wait is still a complete answer — suppression must not turn the
		// record into a one-shot.
		const again = await h.call({ action: "wait", id });
		assert.equal(jobOf(again).exitCode, 0);
		assert.match(again.text, /exited/);
	});
});

test("a wait that timed out does not suppress the completion that follows", async () => {
	await withBgHarness(async (h) => {
		const start = await h.call({ action: "start", command: "sleep 1; exit 0" });
		const id = jobOf(start).id as string;

		const result = await h.call({ action: "wait", id, timeoutMs: 100 });
		assert.equal(result.details.timedOut, true, result.text);
		assert.equal(jobOf(result).state, "running");

		// Nobody was told how this job ended, so the notice must still come. The
		// job settles within a second and the window closes a second later.
		await waitFor(() => h.messages.length > 0, 20_000);
		await sleep(PAST_WINDOW_MS);
		assert.equal(h.messages.length, 1, `exactly one notice: ${JSON.stringify(h.messages)}`);
		assert.match(String(h.messages[0]!.message.content), new RegExp(id));
	});
});

test("wait names itself in the tool's action enum and schema", async () => {
	await withBgHarness(async (h) => {
		const definition = h.tools.get("bg") as {
			description?: string;
			parameters?: { properties?: Record<string, { enum?: string[] }> };
		};
		assert.match(String(definition.description), /wait/, "tool_search ranks on the description");
		const action = definition.parameters?.properties?.action as { enum?: string[] } | undefined;
		assert.ok(action?.enum?.includes("wait"), `the action enum must offer wait: ${String(action?.enum)}`);
		assert.ok(definition.parameters?.properties?.timeoutMs, "the schema takes a timeout");
		// Deferred registration is not this action's to change.
		const registration = h.registrations.find((entry) => entry.name === "bg");
		assert.equal(registration?.exposure, "deferred");
		assert.equal(registration?.defaultActive, false);
	});
});
