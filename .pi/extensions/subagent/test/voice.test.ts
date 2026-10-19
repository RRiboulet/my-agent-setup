// Behaviour of the voice extension: config resolution, the recorder command
// builders and state machine in recorder.ts, and the factory's registration
// surface in index.ts.
//
// Everything runs against fakes: a scripted runner instead of ssh, a fake
// clock (or node's mock timers) instead of wall time, and temp directories
// instead of $HOME and the phone. No test touches the network or the phone.
// The strict-ESM load guard for the modules themselves lives in
// extension-load.test.ts.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	CONFIG_BASENAME,
	DEFAULT_CONFIG,
	DEFAULT_RECORDER_PATH,
	MAX_SECONDS_DEFAULT,
	VOICE_ENV,
	loadConfig,
} from "../../voice/config.ts";
import {
	CLEANUP_BUDGET_MS,
	FETCH_BUDGET_MS,
	RECORDING_ID_PATTERN,
	Recorder,
	SHUTDOWN_BUDGET_MS,
	START_SETTLE_BUDGET_MS,
	STOP_GRACE_SECONDS,
	buildCleanupCommand,
	buildFetchCommand,
	buildStartCommand,
	buildStopCommand,
	localRecordingPath,
	newRecordingId,
	remoteRecordingPath,
	type Clock,
	type RecorderStatus,
	type Run,
	type RunResult,
} from "../../voice/recorder.ts";
import {
	MAX_UPLOAD_BYTES,
	TranscribeError,
	resolveApiKey,
	transcribeAudio,
	type TranscribeRequest,
} from "../../voice/transcribe.ts";
import { createVoiceExtension, formatElapsed, statusText } from "../../voice/index.ts";
import { MAX_SSH_STDERR_BYTES, MAX_SSH_STDOUT_BYTES, makeSshRun } from "../../voice/transport.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

const ID = "0123456789abcdef0123456789abcdef";
const AUDIO = Buffer.from("fake-m4a-bytes");

// ---------------------------------------------------------------------------
// Fake clock: deterministic timers and `now`, advanceable by the test.
// ---------------------------------------------------------------------------

interface FakeClock {
	clock: Clock;
	/** Move time forward, firing timers in due order and flushing microtasks. */
	advance(ms: number): Promise<void>;
	/** Timers still armed; the leak assertion for shutdown. */
	pending(): number;
}

async function flush(): Promise<void> {
	// Real macrotask turns, not just microtasks: fs promises complete on the
	// threadpool, and `mock.timers` does not patch setImmediate.
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Yield real macrotasks until `done()` or a real-time deadline. A fixed
 * number of flushes is not enough: 200 flushes run in ~2ms, and an fs
 * completion under load can easily take longer than that. `performance.now`
 * is real time in every test here — the fake clock and `mock.timers` never
 * touch it — so this bounds waiting without depending on wall-clock timers. */
async function flushUntil(done: () => boolean, budgetMs = 5_000): Promise<boolean> {
	const deadline = performance.now() + budgetMs;
	while (!done() && performance.now() < deadline) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	return done();
}

function makeFakeClock(start = 0): FakeClock {
	let now = start;
	let nextHandle = 1;
	const timers = new Map<number, { at: number; fn: () => void; interval?: number }>();
	const clock: Clock = {
		now: () => now,
		setInterval: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, { at: now + ms, fn, interval: ms });
			return handle;
		},
		clearInterval: (handle) => void timers.delete(handle as number),
		setTimeout: (fn, ms) => {
			const handle = nextHandle++;
			timers.set(handle, { at: now + ms, fn });
			return handle;
		},
		clearTimeout: (handle) => void timers.delete(handle as number),
	};
	async function advance(ms: number): Promise<void> {
		const target = now + ms;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			const [handle, timer] = due;
			now = timer.at;
			if (timer.interval !== undefined) timer.at = now + timer.interval;
			else timers.delete(handle);
			timer.fn();
			await flush();
		}
		now = target;
		await flush();
	}
	return { clock, advance, pending: () => timers.size };
}

/** Advance the fake clock until `promise` settles, so budgeted cleanup paths
 * (which only progress when their timers fire) can finish. Each step yields to
 * the real event loop: the recorder's fs work (writeFile, rm) completes on the
 * macrotask queue, which microtasks alone never drain. The loop is bounded by
 * real time, not iterations — fs latency, not fake time, is the variable. */
async function settleWithClock(clock: FakeClock, promise: Promise<unknown>): Promise<void> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const deadline = performance.now() + 5_000;
	while (!settled && performance.now() < deadline) {
		await clock.advance(250);
	}
	assert.ok(settled, "the promise did not settle within 5s of real time");
	await promise;
}

// ---------------------------------------------------------------------------
// Scripted runner and harness
// ---------------------------------------------------------------------------

interface RunCall {
	command: string;
	signal: AbortSignal;
}

interface RunnerSpy {
	run: Run;
	calls: RunCall[];
	commands(): string[];
}

function scriptedRunner(respond: (call: RunCall, index: number) => RunResult | Promise<RunResult>): RunnerSpy {
	const calls: RunCall[] = [];
	const run: Run = async (command, signal) => {
		const call = { command, signal };
		calls.push(call);
		return await respond(call, calls.length - 1);
	};
	return { run, calls, commands: () => calls.map((call) => call.command) };
}

function result(stdout: Buffer | string = "", code = 0, stderr = ""): RunResult {
	return { code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr };
}

/** A promise that hangs until its signal aborts — the phone with no network,
 * or an upload endpoint that never answers. */
function pendingOnAbort<T = RunResult>(signal: AbortSignal): Promise<T> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
}

interface Harness {
	recorder: Recorder;
	clock: FakeClock;
	runner: RunnerSpy;
	statuses: RecorderStatus[];
	delivered: { localPath: string; signal: AbortSignal }[];
	tmpDir: string;
	cleanup(): Promise<void>;
}

async function makeHarness(options: {
	respond: (call: RunCall, index: number) => RunResult | Promise<RunResult>;
	deliver?: (localPath: string, signal: AbortSignal) => Promise<void>;
	config?: { recorderPath?: string; maxSeconds?: number; bitrateKbps?: number; keepAudio?: boolean };
	cleanupBudgetMs?: number;
}): Promise<Harness> {
	const tmpDir = await mkdtemp(path.join(tmpdir(), "voice-test-"));
	const clock = makeFakeClock();
	const statuses: RecorderStatus[] = [];
	const delivered: { localPath: string; signal: AbortSignal }[] = [];
	const runner = scriptedRunner(options.respond);
	const recorder = new Recorder({
		run: runner.run,
		status: (status) => statuses.push({ ...status }),
		deliver: async (localPath, signal) => {
			delivered.push({ localPath, signal });
			if (options.deliver) await options.deliver(localPath, signal);
		},
		config: {
			recorderPath: DEFAULT_RECORDER_PATH,
			maxSeconds: 60,
			keepAudio: false,
			...options.config,
		},
		clock: clock.clock,
		tmpDir,
		...(options.cleanupBudgetMs !== undefined ? { cleanupBudgetMs: options.cleanupBudgetMs } : {}),
	});
	return { recorder, clock, runner, statuses, delivered, tmpDir, cleanup: () => rm(tmpDir, { recursive: true, force: true }) };
}

const phases = (statuses: RecorderStatus[]): string[] => statuses.map((status) => status.phase);

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

test("buildStartCommand pins the remote template", () => {
	assert.equal(
		buildStartCommand({ id: ID, maxSeconds: 120 }),
		`mkdir -p "$HOME/.pi-voice" && ${DEFAULT_RECORDER_PATH} -f "$HOME/.pi-voice/${ID}.m4a" -l 120 -e aac`,
	);
});

test("buildStartCommand appends the bitrate flag only when set", () => {
	assert.equal(
		buildStartCommand({ id: ID, maxSeconds: 45, bitrateKbps: 32 }),
		`mkdir -p "$HOME/.pi-voice" && ${DEFAULT_RECORDER_PATH} -f "$HOME/.pi-voice/${ID}.m4a" -l 45 -e aac -b 32`,
	);
});

test("command builders refuse anything that could not be a recording id", () => {
	for (const id of ["", "abc", ID.toUpperCase(), `${ID}; rm -rf ~`, `$(touch /tmp/pwned)${ID.slice(0, 8)}`]) {
		assert.throws(() => remoteRecordingPath(id), /refusing recording id/);
		assert.throws(() => buildStartCommand({ id, maxSeconds: 60 }), /refusing recording id/);
		assert.throws(() => buildFetchCommand(id), /refusing recording id/);
		assert.throws(() => buildCleanupCommand(id), /refusing recording id/);
		assert.throws(() => localRecordingPath(id), /refusing recording id/);
	}
});

test("command builders refuse a recorder path that is not a safe absolute path", () => {
	for (const recorderPath of [
		"",
		"relative/path",
		"/bin/evil; rm -rf ~",
		"/bin/evil$(touch /tmp/pwned)",
		"/bin/evil`touch /tmp/pwned`",
		"/bin/evil | cat",
		"/bin/evil && cat",
		"/bin/evil'\"",
		"/bin/evil ",
		" /leading-space",
	]) {
		assert.throws(() => buildStartCommand({ id: ID, maxSeconds: 60, recorderPath }), /refusing recorder path/);
		assert.throws(() => buildStopCommand(recorderPath), /refusing recorder path/);
	}
});

test("buildStartCommand refuses out-of-range seconds and bad bitrates", () => {
	for (const maxSeconds of [0, -1, 901, 1.5, Number.NaN]) {
		assert.throws(() => buildStartCommand({ id: ID, maxSeconds }), /refusing -l/);
	}
	for (const bitrateKbps of [0, -8, 1.5]) {
		assert.throws(() => buildStartCommand({ id: ID, maxSeconds: 60, bitrateKbps }), /refusing -b/);
	}
});

test("stop, fetch and cleanup pin their templates", () => {
	assert.equal(buildStopCommand(), `${DEFAULT_RECORDER_PATH} -q`);
	assert.equal(buildFetchCommand(ID), `cat -- "$HOME/.pi-voice/${ID}.m4a"`);
	assert.equal(buildCleanupCommand(ID), `rm -f -- "$HOME/.pi-voice/${ID}.m4a"`);
	assert.equal(remoteRecordingPath(ID), `$HOME/.pi-voice/${ID}.m4a`);
	assert.equal(localRecordingPath(ID, "/tmp/x"), `/tmp/x/pi-voice-${ID}.m4a`);
});

test("newRecordingId is 32 lowercase hex characters and unique", () => {
	const first = newRecordingId();
	const second = newRecordingId();
	assert.match(first, RECORDING_ID_PATTERN);
	assert.match(second, RECORDING_ID_PATTERN);
	assert.notEqual(first, second);
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** PI_VOICE_* values set in the calling shell must not leak into a test. */
function clearVoiceEnv(): Record<string, undefined> {
	return Object.fromEntries(Object.values(VOICE_ENV).map((key) => [key, undefined]));
}

test("config defaults apply when no file exists", async () => {
	await withTempAgentDir(async () => {
		await withEnv(clearVoiceEnv(), async () => {
			const warns: string[] = [];
			const config = loadConfig({ warn: (message) => warns.push(message) });
			assert.deepEqual(config, DEFAULT_CONFIG);
			assert.deepEqual(warns, []);
		});
	});
});

test("file values override defaults and baseUrl is normalised", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(
				path.join(agentDir, CONFIG_BASENAME),
				JSON.stringify({
					sshTarget: "pixel",
					recorderPath: "/opt/rec",
					maxSeconds: 300,
					bitrateKbps: 32,
					keepAudio: true,
					autoSubmit: true,
					baseUrl: "https://stt.example/v1/",
					model: "whisper-1",
					apiKey: "sk-test",
					language: "en",
					prompt: "pi",
					timeoutMs: 90_000,
				}),
			);
			const config = loadConfig({ warn: () => {} });
			assert.equal(config.sshTarget, "pixel");
			assert.equal(config.recorderPath, "/opt/rec");
			assert.equal(config.maxSeconds, 300);
			assert.equal(config.bitrateKbps, 32);
			assert.equal(config.keepAudio, true);
			assert.equal(config.autoSubmit, true);
			assert.equal(config.baseUrl, "https://stt.example/v1");
			assert.equal(config.model, "whisper-1");
			assert.equal(config.apiKey, "sk-test");
			assert.equal(config.language, "en");
			assert.equal(config.prompt, "pi");
			assert.equal(config.timeoutMs, 90_000);
		});
	});
});

test("numeric fields are clamped and rounded", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify({ maxSeconds: 10_000, timeoutMs: 100 }));
			let config = loadConfig({ warn: () => {} });
			assert.equal(config.maxSeconds, 900);
			assert.equal(config.timeoutMs, 5_000);

			await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify({ maxSeconds: 0, timeoutMs: 999_999_999 }));
			config = loadConfig({ warn: () => {} });
			assert.equal(config.maxSeconds, 1);
			assert.equal(config.timeoutMs, 300_000);
		});
	});
});

test("a bad bitrate is warned about and ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify({ bitrateKbps: -4 }));
			const warns: string[] = [];
			const config = loadConfig({ warn: (message) => warns.push(message) });
			assert.equal(config.bitrateKbps, undefined);
			assert.equal(warns.length, 1);
			assert.match(warns[0], /bitrateKbps/);
		});
	});
});

test("an sshTarget starting with a dash is warned about and ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify({ sshTarget: "-oProxyCommand=evil" }));
			const warns: string[] = [];
			const config = loadConfig({ warn: (message) => warns.push(message) });
			assert.equal(config.sshTarget, DEFAULT_CONFIG.sshTarget);
			assert.equal(warns.length, 1);
			assert.match(warns[0], /sshTarget/);
			assert.match(warns[0], /start with/);
		});
	});
});

test("a recorderPath that is not a safe absolute path is warned about and ignored", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify({ recorderPath: "/bin/evil; rm -rf ~" }));
			const warns: string[] = [];
			const config = loadConfig({ warn: (message) => warns.push(message) });
			assert.equal(config.recorderPath, DEFAULT_RECORDER_PATH);
			assert.equal(warns.length, 1);
			assert.match(warns[0], /recorderPath/);
		});
	});
});

test("a dash-leading sshTarget from the env is warned about and ignored", async () => {
	await withTempAgentDir(async () => {
		await withEnv(
			{ ...clearVoiceEnv(), [VOICE_ENV.sshTarget]: "-oProxyCommand=evil" },
			async () => {
				const warns: string[] = [];
				const config = loadConfig({ warn: (message) => warns.push(message) });
				assert.equal(config.sshTarget, DEFAULT_CONFIG.sshTarget);
				assert.equal(warns.length, 1);
				assert.match(warns[0], /PI_VOICE_SSH_TARGET/);
			},
		);
	});
});

test("an unsafe recorderPath from the env is warned about and ignored", async () => {
	await withTempAgentDir(async () => {
		await withEnv(
			{ ...clearVoiceEnv(), [VOICE_ENV.recorderPath]: "/bin/evil$(touch /tmp/pwned)" },
			async () => {
				const warns: string[] = [];
				const config = loadConfig({ warn: (message) => warns.push(message) });
				assert.equal(config.recorderPath, DEFAULT_RECORDER_PATH);
				assert.equal(warns.length, 1);
				assert.match(warns[0], /PI_VOICE_RECORDER_PATH/);
			},
		);
	});
});

test("a valid non-default recorderPath from the env survives, trimmed", async () => {
	await withTempAgentDir(async () => {
		await withEnv(
			{ ...clearVoiceEnv(), [VOICE_ENV.recorderPath]: " /opt/rec/bin/rec " },
			async () => {
				const warns: string[] = [];
				const config = loadConfig({ warn: (message) => warns.push(message) });
				assert.equal(config.recorderPath, "/opt/rec/bin/rec");
				assert.deepEqual(warns, []);
			},
		);
	});
});

test("a warning quotes the offending env value so control characters cannot forge log lines", async () => {
	await withTempAgentDir(async () => {
		await withEnv(
			{ ...clearVoiceEnv(), [VOICE_ENV.sshTarget]: "-evil\nvoice: recording ok" },
			async () => {
				const warns: string[] = [];
				loadConfig({ warn: (message) => warns.push(message) });
				assert.equal(warns.length, 1);
				assert.equal(warns[0].includes("\n"), false, "the newline must be escaped, not emitted raw");
				assert.match(warns[0], /\\n/);
			},
		);
	});
});

test("malformed config warns once and keeps defaults", async () => {
	await withTempAgentDir(async (agentDir) => {
		await withEnv(clearVoiceEnv(), async () => {
			await writeFile(path.join(agentDir, CONFIG_BASENAME), "{ nope");
			const warns: string[] = [];
			const config = loadConfig({ warn: (message) => warns.push(message) });
			assert.deepEqual(config, DEFAULT_CONFIG);
			assert.equal(warns.length, 1);
			assert.match(warns[0], /malformed/);

			await writeFile(path.join(agentDir, CONFIG_BASENAME), "[]");
			const shapeWarns: string[] = [];
			loadConfig({ warn: (message) => shapeWarns.push(message) });
			assert.equal(shapeWarns.length, 1);
			assert.match(shapeWarns[0], /expected a JSON object/);
		});
	});
});

test("env overrides the file", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeFile(
			path.join(agentDir, CONFIG_BASENAME),
			JSON.stringify({ sshTarget: "file-phone", maxSeconds: 100, keepAudio: false, autoSubmit: true }),
		);
		await withEnv(
			{
				[VOICE_ENV.sshTarget]: "env-phone",
				[VOICE_ENV.maxSeconds]: "45",
				[VOICE_ENV.keepAudio]: "true",
				[VOICE_ENV.autoSubmit]: "0",
				[VOICE_ENV.bitrateKbps]: "24",
				[VOICE_ENV.baseUrl]: "https://stt.example/v2///",
			},
			async () => {
				const config = loadConfig({ warn: () => {} });
				assert.equal(config.sshTarget, "env-phone");
				assert.equal(config.maxSeconds, 45);
				assert.equal(config.keepAudio, true);
				assert.equal(config.autoSubmit, false);
				assert.equal(config.bitrateKbps, 24);
				assert.equal(config.baseUrl, "https://stt.example/v2");
			},
		);
	});
});

test("invalid env values are ignored rather than guessed", async () => {
	await withTempAgentDir(async () => {
		await withEnv(
			{
				...clearVoiceEnv(),
				[VOICE_ENV.maxSeconds]: "soon",
				[VOICE_ENV.keepAudio]: "maybe",
				[VOICE_ENV.bitrateKbps]: "-2",
			},
			async () => {
				const warns: string[] = [];
				const config = loadConfig({ warn: (message) => warns.push(message) });
				assert.equal(config.maxSeconds, MAX_SECONDS_DEFAULT);
				assert.equal(config.keepAudio, false);
				assert.equal(config.bitrateKbps, undefined);
				assert.equal(warns.length, 1);
				assert.match(warns[0], /PI_VOICE_BITRATE_KBPS/);
			},
		);
	});
});

// ---------------------------------------------------------------------------
// Recorder state machine
// ---------------------------------------------------------------------------

test("start runs the pinned command and reports starting then recording", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		assert.equal(harness.runner.calls.length, 1);
		assert.match(
			harness.runner.calls[0].command,
			/^mkdir -p "\$HOME\/\.pi-voice" && .*termux-microphone-record -f "\$HOME\/\.pi-voice\/[a-f0-9]{32}\.m4a" -l 60 -e aac$/,
		);
		assert.deepEqual(phases(harness.statuses), ["starting", "recording"]);
		assert.equal(harness.statuses[1].elapsedSeconds, 0);
		assert.equal(harness.recorder.phase(), "recording");
	} finally {
		await harness.cleanup();
	}
});

test("bitrateKbps reaches the start command as -b", async () => {
	const harness = await makeHarness({ respond: () => result(), config: { bitrateKbps: 32 } });
	try {
		await harness.recorder.start();
		assert.match(harness.runner.commands()[0], / -l 60 -e aac -b 32$/);
	} finally {
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await harness.cleanup();
	}
});

test("the timer reports whole seconds while recording", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		await harness.clock.advance(500); // still second 0
		assert.equal(harness.statuses.filter((status) => status.phase === "recording").length, 1);
		await harness.clock.advance(600); // t=1.1s
		assert.equal(harness.statuses.filter((status) => status.phase === "recording").at(-1)?.elapsedSeconds, 1);
		await harness.clock.advance(2_000); // t=3.1s
		assert.equal(harness.statuses.filter((status) => status.phase === "recording").at(-1)?.elapsedSeconds, 3);
	} finally {
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await harness.cleanup();
	}
});

test("a second start is refused while recording", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		await harness.recorder.start();
		assert.equal(harness.runner.calls.length, 1);
		assert.equal(harness.recorder.phase(), "recording");
	} finally {
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await harness.cleanup();
	}
});

test("a second start is refused while the first is starting", async () => {
	const harness = await makeHarness({ respond: (call) => pendingOnAbort(call.signal) });
	try {
		const first = harness.recorder.start();
		await flush();
		assert.equal(harness.recorder.phase(), "starting");
		await harness.recorder.start();
		assert.equal(harness.runner.calls.length, 1);

		await settleWithClock(harness.clock, harness.recorder.cancel());
		await first;
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.calls[0].signal.aborted, true);
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("a start that hits an in-progress recording is distinct and never sends -q", async () => {
	const harness = await makeHarness({ respond: () => result("", 1, "Recording already in progress!") });
	try {
		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "error");
		const last = harness.statuses.at(-1);
		assert.equal(last?.failure, "already-recording");
		assert.match(last?.message ?? "", /\/voice cancel/);
		assert.equal(harness.runner.commands().some((command) => command.includes("-q")), false);

		// The hint's action works: an explicit cancel stops the orphan recording
		// and sweeps our side.
		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.commands().some((command) => command.includes("-q")), true);
		assert.equal(harness.runner.commands().some((command) => command.includes("rm -f")), true);
	} finally {
		await harness.cleanup();
	}
});

test("a generic start failure reports the exit and stderr", async () => {
	const harness = await makeHarness({ respond: () => result("", 1, "boom\nextra") });
	try {
		await harness.recorder.start();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "start-failed");
		assert.match(last?.message ?? "", /exit 1/);
		assert.match(last?.message ?? "", /boom/);
	} finally {
		await harness.cleanup();
	}
});

test("a start whose ssh cannot be spawned reports the cause, not a bare 'did not run'", async () => {
	const harness = await makeHarness({
		respond: () => {
			throw new Error("spawn ssh ENOENT");
		},
	});
	try {
		await harness.recorder.start();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "start-failed");
		// The failure text still says what happened, and now why: the thrown
		// cause is reported instead of collapsed into "did not run".
		assert.match(last?.message ?? "", /did not run/);
		assert.match(last?.message ?? "", /spawn ssh ENOENT/);
	} finally {
		await harness.cleanup();
	}
});

test("a failed start is retryable from the error phase", async () => {
	const harness = await makeHarness({
		respond: (_call, index) => (index === 0 ? result("", 1, "boom") : result()),
	});
	try {
		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "error");

		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "recording");
		assert.equal(harness.runner.calls.length, 2);
		assert.equal(phases(harness.statuses).at(-1), "recording");
	} finally {
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await harness.cleanup();
	}
});

test("a builder refusal on a directly-built Recorder lands in error, not a wedged phase, and cancel still reaches idle", async () => {
	// loadConfig degrades a bad recorderPath, so this exercises the
	// defense-in-depth assert that only a direct Recorder construction reaches.
	const harness = await makeHarness({ respond: () => result(), config: { recorderPath: "/bin/evil; rm -rf ~" } });
	try {
		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "error", "the refusal must be retryable, not stuck in starting");
		assert.equal(harness.statuses.at(-1)?.failure, "start-failed");
		assert.match(harness.statuses.at(-1)?.message ?? "", /building the start command failed/);
		assert.equal(harness.runner.calls.length, 0, "no ssh command may be issued for a refused path");

		// The stop builder refuses too; cancel must still sweep and reach idle.
		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.clock.pending(), 0);
	} finally {
		await harness.cleanup();
	}
});

test("stop fetches the audio, writes it 0600, cleans the phone, delivers, then drops the local copy", async () => {
	const reads: Buffer[] = [];
	const modes: number[] = [];
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) return result("Recording finished: /data/data/com.termux/files/home/.pi-voice/x.m4a");
			if (call.command.startsWith("cat ")) return result(AUDIO);
			return result();
		},
		deliver: async (localPath) => {
			reads.push(await readFile(localPath));
			modes.push((await stat(localPath)).mode & 0o777);
		},
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();

		assert.equal(harness.delivered.length, 1);
		const localPath = harness.delivered[0].localPath;
		assert.equal(path.dirname(localPath), harness.tmpDir);
		assert.match(path.basename(localPath), /^pi-voice-[a-f0-9]{32}\.m4a$/);
		assert.deepEqual(reads, [AUDIO]);
		assert.deepEqual(modes, [0o600]);

		const commands = harness.runner.commands();
		assert.match(commands[0], /termux-microphone-record -f "\$HOME\/\.pi-voice\/[a-f0-9]{32}\.m4a"/);
		assert.equal(commands[1], buildStopCommand());
		assert.match(commands[2], /^cat -- "\$HOME\/\.pi-voice\//);
		assert.match(commands[3], /^rm -f -- "\$HOME\/\.pi-voice\//);
		assert.deepEqual(phases(harness.statuses), ["starting", "recording", "stopping", "fetching", "transcribing", "idle"]);
		assert.equal(harness.statuses.at(-1)?.localPath, undefined);
		await assert.rejects(stat(localPath), /ENOENT/);
	} finally {
		await harness.cleanup();
	}
});

test("a failing local delete is swallowed: stop still reaches idle", async () => {
	// `deliver` turns the fetched file into a directory, so the recorder's own
	// rm(localPath, { force: true }) fails with EISDIR. The delete is
	// best-effort, so the cycle must finish rather than wedge in `transcribing`.
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		deliver: async (localPath) => {
			await rm(localPath, { force: true });
			await mkdir(localPath);
		},
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(phases(harness.statuses).at(-1), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("a failing local delete is swallowed: cancel during transcribing still reaches idle", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		deliver: async (localPath, signal) => {
			await rm(localPath, { force: true });
			await mkdir(localPath);
			await pendingOnAbort(signal);
		},
	});
	try {
		await harness.recorder.start();
		const stopping = harness.recorder.stop();
		await waitFor(() => harness.recorder.phase() === "transcribing");
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await stopping;
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("keepAudio keeps the local file and reports it on the idle status", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		config: { keepAudio: true },
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "idle");
		assert.equal(last?.localPath, harness.delivered[0].localPath);
		assert.equal((await readFile(last?.localPath as string)).length, AUDIO.length);
	} finally {
		await harness.cleanup();
	}
});

test("a stop on an already-expired recording tolerates 'No recording to stop'", async () => {
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) return result("No recording to stop", 1);
			if (call.command.startsWith("cat ")) return result(AUDIO);
			return result();
		},
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.delivered.length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("the local timer auto-stops at maxSeconds + grace and collects the audio", async () => {
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) return result("No recording to stop", 1);
			if (call.command.startsWith("cat ")) return result(AUDIO);
			return result();
		},
		config: { maxSeconds: 5 },
	});
	try {
		await harness.recorder.start();
		await harness.clock.advance(7_000);
		assert.equal(harness.runner.commands().some((command) => command.includes("-q")), false, "stop must not fire before maxSeconds + grace");
		await harness.clock.advance(1_000); // elapsed 8 = 5 + STOP_GRACE_SECONDS
		await waitFor(() => harness.recorder.phase() === "idle");

		assert.equal(harness.delivered.length, 1);
		const commands = harness.runner.commands();
		assert.equal(commands.some((command) => command.includes("-q")), true);
		assert.equal(commands.some((command) => command.startsWith("cat ")), true);
		assert.deepEqual(
			harness.statuses.filter((status) => status.phase === "recording").map((status) => status.elapsedSeconds),
			[0, 1, 2, 3, 4, 5, 6, 7, 8],
		);
		assert.deepEqual(phases(harness.statuses).slice(-4), ["stopping", "fetching", "transcribing", "idle"]);
		assert.equal(STOP_GRACE_SECONDS, 3);
	} finally {
		await harness.cleanup();
	}
});

test("an empty fetch is a failure, not a transcription of silence", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result("") : result()),
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "empty-recording");
		assert.equal(harness.delivered.length, 0);
		assert.equal(harness.runner.commands().some((command) => command.includes("rm -f")), false);
	} finally {
		await harness.cleanup();
	}
});

test("a failed fetch keeps the remote copy for another attempt", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result("", 1, "cat: no such file") : result()),
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "fetch-failed");
		assert.match(last?.message ?? "", /cat: no such file/);
		assert.equal(harness.delivered.length, 0);
		assert.equal(harness.runner.commands().some((command) => command.includes("rm -f")), false);
	} finally {
		await harness.cleanup();
	}
});

test("a stalled fetch times out at FETCH_BUDGET_MS and keeps the remote copy", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? pendingOnAbort(call.signal) : result()),
	});
	try {
		await harness.recorder.start();
		const stopping = harness.recorder.stop();
		await waitFor(() => harness.recorder.phase() === "fetching");

		await harness.clock.advance(FETCH_BUDGET_MS - 1);
		assert.equal(harness.recorder.phase(), "fetching", "the fetch must not time out before its budget");
		await settleWithClock(harness.clock, stopping);
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "fetch-failed");
		assert.match(last?.message ?? "", /timed out after/);
		assert.equal(harness.delivered.length, 0);
		assert.equal(harness.runner.commands().some((command) => command.includes("rm -f")), false, "a failed fetch keeps the remote copy");
		const fetchCall = harness.runner.calls.find((call) => call.command.startsWith("cat "));
		assert.equal(fetchCall?.signal.aborted, true, "the timeout must kill the stalled ssh");
		assert.equal(harness.clock.pending(), 0, "the fetch budget timer must be cleared");
	} finally {
		await harness.cleanup();
	}
});

test("a deliver failure reports the kept audio path", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		deliver: async () => {
			throw new Error("transcription exploded");
		},
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const last = harness.statuses.at(-1);
		assert.equal(last?.phase, "error");
		assert.equal(last?.failure, "deliver-failed");
		assert.match(last?.message ?? "", /transcription exploded/);
		const kept = last?.localPath as string;
		assert.equal(kept, harness.delivered[0].localPath);
		assert.equal((await readFile(kept)).length, AUDIO.length);
	} finally {
		await harness.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Cancel, per phase
// ---------------------------------------------------------------------------

test("cancel during starting waits for the start to settle before stopping, so the phone ends stopped", async () => {
	// Aborting the client does not stop the remote start command. If `-q` is sent
	// before the recorder exists it is a no-op, and the recorder then starts and
	// records until `-l`. Cancel must let the start settle first.
	let release: (() => void) | undefined;
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.startsWith("mkdir")) {
				return new Promise<RunResult>((resolve) => {
					release = () => resolve(result());
				});
			}
			return result();
		},
	});
	try {
		const starting = harness.recorder.start();
		await flush();
		assert.equal(harness.recorder.phase(), "starting");

		const cancelling = harness.recorder.cancel();
		await flush();
		// The start has not settled, so stopping now would race the recorder's launch.
		assert.equal(harness.runner.commands().some((command) => command.includes("-q")), false);
		assert.equal(harness.runner.commands().some((command) => command.includes("rm -f")), false);
		assert.equal(harness.recorder.phase(), "starting");

		assert.ok(release, "the start command was issued");
		release();
		await settleWithClock(harness.clock, cancelling);
		await starting;

		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(phases(harness.statuses).includes("recording"), false, "a cancelled start must not report recording");
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
		assert.equal(harness.clock.pending(), 0);
	} finally {
		await harness.cleanup();
	}
});

test("cancel during starting gives up on a hung start at the budget and still tries -q", async () => {
	// A start whose ssh never answers must not hold cancel open forever; the
	// settle wait is bounded, and the best-effort stop runs afterwards.
	const harness = await makeHarness({ respond: (call) => (call.command.startsWith("mkdir") ? new Promise<RunResult>(() => {}) : result()) });
	try {
		void harness.recorder.start(); // never resolves; the runner ignores abort
		await flush();
		assert.equal(harness.recorder.phase(), "starting");

		const cancelling = harness.recorder.cancel();
		let settled = false;
		void cancelling.then(() => {
			settled = true;
		});
		await harness.clock.advance(START_SETTLE_BUDGET_MS - 1);
		assert.equal(settled, false, "cancel must not give up before the settle budget");
		await settleWithClock(harness.clock, cancelling);
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
		assert.equal(harness.clock.pending(), 0);
	} finally {
		await harness.cleanup();
	}
});

test("shutdown during starting still attempts -q: the settle budget is shorter than the shutdown budget", async () => {
	// shutdown has no later, so a wait that outlasts it would let a session exit
	// leave the phone recording. START_SETTLE_BUDGET_MS must stay below
	// SHUTDOWN_BUDGET_MS so the best-effort -q is spawned before shutdown gives up.
	assert.ok(START_SETTLE_BUDGET_MS < SHUTDOWN_BUDGET_MS, "the settle wait must not outlast shutdown");
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("mkdir") ? new Promise<RunResult>(() => {}) : result()),
	});
	try {
		void harness.recorder.start(); // never resolves; the runner ignores abort
		await flush();
		assert.equal(harness.recorder.phase(), "starting");

		await settleWithClock(harness.clock, harness.recorder.shutdown());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1, "-q must be attempted before shutdown returns");
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("shutdown during starting honors the settle wait instead of aborting the start early", async () => {
	// Aborting kills the ssh client, so an up-front abort would make the start
	// settle for the wrong reason and send -q while the recorder is still
	// launching — the very race this change removes. Shutdown must let the wait run.
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("mkdir") ? pendingOnAbort(call.signal) : result()),
	});
	try {
		void harness.recorder.start();
		await flush();
		const shutting = harness.recorder.shutdown();
		await harness.clock.advance(START_SETTLE_BUDGET_MS - 1);
		assert.equal(harness.runner.commands().some((command) => command.includes("-q")), false, "-q must not be sent before the start settles");

		await settleWithClock(harness.clock, shutting);
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("a start that throws while a cancel waits does not report an error", async () => {
	// During the settle wait the signal is deliberately still live, so a thrown
	// runner would otherwise #fail with 'did not run' and toast an error for a
	// cycle the user already cancelled.
	let fail: (() => void) | undefined;
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.startsWith("mkdir")) {
				return new Promise<RunResult>((_resolve, reject) => {
					fail = () => reject(new Error("ssh spawn ENOENT"));
				});
			}
			return result();
		},
	});
	try {
		const starting = harness.recorder.start();
		await flush();
		const cancelling = harness.recorder.cancel();
		await flush();

		assert.ok(fail, "the start command was issued");
		fail(); // the throw lands while the cancel is parked
		await settleWithClock(harness.clock, cancelling);
		await starting;

		assert.equal(phases(harness.statuses).includes("error"), false, "a cancelled start must not report an error");
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("cancel while recording stops the phone and drops the remote file without fetching", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		const commands = harness.runner.commands();
		assert.equal(commands[1], buildStopCommand());
		assert.match(commands[2], /^rm -f -- "\$HOME\/\.pi-voice\//);
		assert.equal(commands.some((command) => command.startsWith("cat ")), false);
		assert.equal(harness.delivered.length, 0);
		assert.equal(harness.statuses.at(-1)?.phase, "idle");
	} finally {
		await harness.cleanup();
	}
});

test("cancel while stopping aborts the stop and still tries -q and cleanup", async () => {
	let stops = 0;
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) {
				stops += 1;
				return stops === 1 ? pendingOnAbort(call.signal) : result();
			}
			return result();
		},
	});
	try {
		await harness.recorder.start();
		const stopping = harness.recorder.stop();
		await waitFor(() => harness.recorder.phase() === "stopping");

		await settleWithClock(harness.clock, harness.recorder.cancel());
		await stopping;
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(stops, 2, "the aborted stop plus one best-effort stop");
		assert.equal(harness.runner.commands().some((command) => command.startsWith("cat ")), false);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
		assert.equal(harness.delivered.length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("cancel while fetching aborts the fetch, creating no local file and removing the remote original", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? pendingOnAbort(call.signal) : result()),
	});
	try {
		await harness.recorder.start();
		const stopping = harness.recorder.stop();
		await waitFor(() => harness.recorder.phase() === "fetching");

		await settleWithClock(harness.clock, harness.recorder.cancel());
		await stopping;
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.delivered.length, 0);
		assert.deepEqual(await readdir(harness.tmpDir), []);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
		assert.equal(
			harness.runner.commands().filter((command) => command.includes("-q")).length,
			1,
			"only the stop that completed before fetching may have sent -q",
		);
		const fetchCall = harness.runner.calls.find((call) => call.command.startsWith("cat "));
		assert.equal(fetchCall?.signal.aborted, true);
	} finally {
		await harness.cleanup();
	}
});

test("cancel while fetching keeps the local copy when keepAudio is set", async () => {
	// The file is written before the bounded cleanupRemote, so parking there puts
	// the cancel inside the window where the local copy exists while the phase is
	// still `fetching` — the one cancel path that used to drop it unconditionally.
	for (const keepAudio of [false, true]) {
		const harness = await makeHarness({
			respond: (call) => {
				if (call.command.startsWith("cat ")) return result(AUDIO);
				if (call.command.includes("rm -f")) return new Promise<RunResult>(() => {}); // park cleanupRemote
				return result();
			},
			config: { keepAudio },
		});
		try {
			await harness.recorder.start();
			const stopping = harness.recorder.stop();
			await waitFor(async () => harness.recorder.phase() === "fetching" && (await readdir(harness.tmpDir)).length === 1);

			await settleWithClock(harness.clock, harness.recorder.cancel());
			await stopping;
			assert.equal(harness.recorder.phase(), "idle");
			assert.equal(harness.delivered.length, 0, "a cancelled fetch never reaches delivery");
			const files = await readdir(harness.tmpDir);
			const reported = keepAudio ? path.join(harness.tmpDir, files[0]) : undefined;
			assert.equal(
				harness.statuses.at(-1)?.localPath,
				reported,
				"the kept path is reported exactly when the file is there",
			);
			if (keepAudio) {
				assert.equal(files.length, 1, "keepAudio must preserve the local copy across a fetching cancel");
				assert.equal((await readFile(reported as string)).length, AUDIO.length);
			} else {
				assert.deepEqual(files, [], "without keepAudio the local copy is dropped");
			}
		} finally {
			await harness.cleanup();
		}
	}
});

test("cancel while transcribing aborts delivery; keepAudio decides the local copy", async () => {
	for (const keepAudio of [false, true]) {
		const harness = await makeHarness({
			respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
			deliver: async (_localPath, signal) => {
				await pendingOnAbort(signal);
			},
			config: { keepAudio },
		});
		try {
			await harness.recorder.start();
			const stopping = harness.recorder.stop();
			await waitFor(() => harness.recorder.phase() === "transcribing");

			await settleWithClock(harness.clock, harness.recorder.cancel());
			await stopping;
			assert.equal(harness.recorder.phase(), "idle");
			assert.equal(harness.delivered[0].signal.aborted, true);
			const localPath = harness.delivered[0].localPath;
			if (keepAudio) assert.equal((await readFile(localPath)).length, AUDIO.length);
			else await assert.rejects(stat(localPath), /ENOENT/);
			assert.equal(
				harness.statuses.at(-1)?.localPath,
				keepAudio ? localPath : undefined,
				"a cancel that kept the audio must report where it is",
			);
		} finally {
			await harness.cleanup();
		}
	}
});

test("a keepAudio cancel reports the path only when a file is really there", async () => {
	// The negative case: cancelling a recording that was never fetched keeps no
	// file, so the idle status must not name one.
	const harness = await makeHarness({ respond: () => result(), config: { keepAudio: true } });
	try {
		await harness.recorder.start();
		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.statuses.at(-1)?.localPath, undefined, "no fetch means no file to report");
	} finally {
		await harness.cleanup();
	}
});

test("cancel from a deliver-failed error with keepAudio reports the kept path", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		deliver: async () => {
			throw new Error("transcription exploded");
		},
		config: { keepAudio: true },
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const kept = harness.statuses.at(-1)?.localPath as string;
		assert.equal(harness.statuses.at(-1)?.failure, "deliver-failed");

		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.statuses.at(-1)?.localPath, kept, "the error state's kept file is still named after the cancel");
	} finally {
		await harness.cleanup();
	}
});

test("cancel while idle is a no-op", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.cancel();
		assert.equal(harness.runner.calls.length, 0);
		assert.deepEqual(harness.statuses, []);
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("a second cancel while one is running joins it", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		const first = harness.recorder.cancel();
		const second = harness.recorder.cancel();
		assert.equal(first, second);
		await settleWithClock(harness.clock, first);
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
	} finally {
		await harness.cleanup();
	}
});

test("cancel after a deliver failure discards the kept audio when keepAudio is off", async () => {
	const harness = await makeHarness({
		respond: (call) => (call.command.startsWith("cat ") ? result(AUDIO) : result()),
		deliver: async () => {
			throw new Error("nope");
		},
	});
	try {
		await harness.recorder.start();
		await harness.recorder.stop();
		const kept = harness.statuses.at(-1)?.localPath as string;
		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.equal(harness.recorder.phase(), "idle");
		await assert.rejects(stat(kept), /ENOENT/);
	} finally {
		await harness.cleanup();
	}
});

test("a start while a cancel is in flight is refused, and the retry works once it lands", async () => {
	// The phone's recorder is device-global: a start during the cancel's
	// best-effort `-q` could be stopped by that same `-q`, and the cancel's
	// teardown would wipe the new cycle anyway. Refuse instead of racing.
	const harness = await makeHarness({
		respond: (call, index) => {
			if (index === 0) return result("", 1, "Recording already in progress!");
			if (call.command.includes("-q")) return new Promise<RunResult>(() => {}); // cancel parks on its budget
			return result();
		},
		cleanupBudgetMs: 50,
	});
	try {
		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "error");

		const cancelling = harness.recorder.cancel();
		await flush();
		assert.equal(harness.recorder.phase(), "error", "cancel does not change the phase while it runs");

		await harness.recorder.start();
		assert.equal(harness.recorder.phase(), "error", "a start during the cancel must be refused");
		assert.equal(harness.runner.commands().filter((command) => command.startsWith("mkdir")).length, 1);

		await settleWithClock(harness.clock, cancelling);
		assert.equal(harness.recorder.phase(), "idle");

		await harness.recorder.start(); // the retry lands once the cancel is done
		assert.equal(harness.recorder.phase(), "recording");
		assert.equal(harness.runner.commands().filter((command) => command.startsWith("mkdir")).length, 2);
	} finally {
		await settleWithClock(harness.clock, harness.recorder.cancel());
		await harness.cleanup();
	}
});

test("a stop while a cancel is in flight is refused", async () => {
	let stops = 0;
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) {
				stops += 1;
				// The cancel's best-effort stop parks on its budget; a second
				// stop (only possible without the guard) answers immediately.
				if (stops === 1) return new Promise<RunResult>(() => {});
				return result("No recording to stop");
			}
			return result();
		},
		cleanupBudgetMs: 50,
	});
	try {
		await harness.recorder.start();
		const cancelling = harness.recorder.cancel();
		await flush();
		assert.equal(harness.recorder.phase(), "recording", "cancel does not change the phase while it runs");

		await harness.recorder.stop();
		assert.equal(harness.recorder.phase(), "recording", "a stop during the cancel must be refused");
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);

		await settleWithClock(harness.clock, cancelling);
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("a start that succeeds exactly as cancel lands must not report recording", async () => {
	// The start's ssh resolves only after the cancel has aborted it; the
	// post-await check is what keeps the cancel the winner.
	let release: (() => void) | undefined;
	const harness = await makeHarness({
		respond: (call) =>
			call.command.startsWith("mkdir")
				? new Promise<RunResult>((resolve) => {
						release = () => resolve(result());
					})
				: result(),
	});
	try {
		const starting = harness.recorder.start();
		await flush();
		assert.equal(harness.recorder.phase(), "starting");

		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.ok(release, "the start command was issued");
		release();
		await starting;

		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(phases(harness.statuses).includes("recording"), false);
		assert.equal(harness.clock.pending(), 0, "no recording interval may be left behind");
	} finally {
		await harness.cleanup();
	}
});

test("a stop that succeeds exactly as cancel lands must not fetch", async () => {
	// The stop's own `-q` resolves only after a cancel aborted the cycle;
	// fetching then would transcribe a recording the user cancelled.
	let release: (() => void) | undefined;
	const harness = await makeHarness({
		respond: (call) => {
			if (call.command.includes("-q")) {
				if (!release) {
					return new Promise<RunResult>((resolve) => {
						release = () => resolve(result());
					});
				}
				return result("No recording to stop");
			}
			return result();
		},
	});
	try {
		await harness.recorder.start();
		const stopping = harness.recorder.stop();
		await flush();
		assert.equal(harness.recorder.phase(), "stopping");

		await settleWithClock(harness.clock, harness.recorder.cancel());
		assert.ok(release, "the stop command was issued");
		release();
		await stopping;

		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.commands().some((command) => command.startsWith("cat ")), false);
		assert.equal(harness.delivered.length, 0);
	} finally {
		await harness.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test("shutdown with a stuck runner returns within budget, clears the timer, and reports idle", async () => {
	const harness = await makeHarness({ respond: () => new Promise<RunResult>(() => {}) });
	try {
		void harness.recorder.start(); // never resolves; the runner ignores abort
		await flush();
		assert.equal(harness.recorder.phase(), "starting");

		await settleWithClock(harness.clock, harness.recorder.shutdown());
		await harness.clock.advance(10_000); // let the abandoned cancel chain finish
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.clock.pending(), 0, "no timer may survive shutdown");
		assert.equal(harness.statuses.at(-1)?.phase, "idle");
	} finally {
		await harness.cleanup();
	}
});

test("shutdown while recording stops the phone and cleans up", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		await harness.recorder.start();
		await settleWithClock(harness.clock, harness.recorder.shutdown());
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.runner.commands().filter((command) => command.includes("-q")).length, 1);
		assert.equal(harness.runner.commands().filter((command) => command.includes("rm -f")).length, 1);
		assert.equal(harness.clock.pending(), 0);
	} finally {
		await harness.cleanup();
	}
});

test("shutdown is idempotent", async () => {
	const harness = await makeHarness({ respond: () => result() });
	try {
		const first = harness.recorder.shutdown();
		const second = harness.recorder.shutdown();
		assert.equal(first, second);
		await settleWithClock(harness.clock, first);
		assert.equal(harness.recorder.phase(), "idle");
	} finally {
		await harness.cleanup();
	}
});

test("shutdown during a cleanup that overruns its budget still reports idle", async () => {
	// A cancel path whose best-effort stop never answers and whose remote
	// cleanup never answers must not hold the shutdown open.
	const never = () => new Promise<RunResult>(() => {});
	const harness = await makeHarness({ respond: never });
	try {
		void harness.recorder.start(); // never resolves; the runner ignores abort
		await flush();
		assert.equal(harness.recorder.phase(), "starting");
		const starting = harness.recorder.start(); // no-op while starting
		void starting;
		await settleWithClock(harness.clock, harness.recorder.shutdown());
		await harness.clock.advance(20_000);
		assert.equal(harness.recorder.phase(), "idle");
		assert.equal(harness.clock.pending(), 0);
	} finally {
		await harness.cleanup();
	}
});

test("the recorder runs on node's mock timers, not just the injected clock", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	const tmpDir = await mkdtemp(path.join(tmpdir(), "voice-test-"));
	const commands: string[] = [];
	const statuses: RecorderStatus[] = [];
	const recorder = new Recorder({
		run: async (command) => {
			commands.push(command);
			return command.startsWith("cat ") ? result(AUDIO) : result();
		},
		status: (status) => statuses.push({ ...status }),
		deliver: async () => {},
		config: { recorderPath: DEFAULT_RECORDER_PATH, maxSeconds: 3, keepAudio: false },
		tmpDir,
	});
	try {
		await recorder.start();
		t.mock.timers.tick(1_000);
		t.mock.timers.tick(1_000);
		t.mock.timers.tick(1_000); // elapsed 3
		t.mock.timers.tick(3_000); // elapsed 6 = 3 + STOP_GRACE_SECONDS
		// The stop chain does two real-fs round trips (writeFile, rm), and the
		// mocked timers do not help those land. Yield real macrotask turns
		// (setImmediate is not mocked) until the chain finishes.
		await flushUntil(() => recorder.phase() === "idle");
		assert.equal(recorder.phase(), "idle");
		assert.equal(commands.some((command) => command.includes("-q")), true);
		assert.deepEqual(phases(statuses).slice(-2), ["transcribing", "idle"]);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// ssh runner (index.ts)
// ---------------------------------------------------------------------------

/** Put a script named `ssh` first on PATH, exercising the real spawn, stdio
 * and close bookkeeping in makeSshRun without a phone. */
async function withFakeSsh(scriptBody: string, fn: (capture: string) => Promise<void>): Promise<void> {
	const bin = await mkdtemp(path.join(tmpdir(), "voice-ssh-"));
	const capture = path.join(bin, "args.txt");
	const script = path.join(bin, "ssh");
	await writeFile(script, scriptBody);
	await chmod(script, 0o755);
	try {
		await withEnv({ PATH: `${bin}:${process.env.PATH}`, SSH_CAPTURE: capture }, () => fn(capture));
	} finally {
		await rm(bin, { recursive: true, force: true });
	}
}

test("makeSshRun passes the target and command, preserves binary stdout, and reports stderr and the exit", async () => {
	await withFakeSsh(
		[
			"#!/bin/sh",
			`printf '%s\\n' "$@" > "$SSH_CAPTURE"`,
			`printf '\\000\\001fake-m4a'`,
			`printf 'warn' >&2`,
			`exit "\${SSH_EXIT:-0}"`,
			"",
		].join("\n"),
		async (capture) => {
			const run = makeSshRun("phone");
			const done = await run("echo $HOME", new AbortController().signal);
			assert.equal(done.code, 0);
			assert.deepEqual(done.stdout, Buffer.concat([Buffer.from([0, 1]), Buffer.from("fake-m4a")]));
			assert.equal(done.stderr, "warn");
			assert.equal(await readFile(capture, "utf8"), "phone\necho $HOME\n");

			await withEnv({ SSH_EXIT: "3" }, async () => {
				const failed = await run("false", new AbortController().signal);
				assert.equal(failed.code, 3);
			});
		},
	);
});

test("makeSshRun kills the child when the signal aborts and resolves with -1", async () => {
	await withFakeSsh("#!/bin/sh\nexec sleep 30\n", async () => {
		const controller = new AbortController();
		const started = makeSshRun("phone")("record", controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 100)); // let the child spawn
		controller.abort();
		const killed = await started;
		assert.equal(killed.code, -1);
	});
});

test("makeSshRun refuses to start when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(makeSshRun("phone")("true", controller.signal), /aborted/);
});

test("makeSshRun refuses a target that starts with a dash (ssh option injection)", () => {
	for (const target of ["-oProxyCommand=evil", "-o", "-v", "--"]) {
		assert.throws(() => makeSshRun(target), /refusing ssh target/);
	}
});

test("the ssh stdout cap sits above the upload cap so assertUploadSize still explains an oversized recording", () => {
	assert.ok(MAX_SSH_STDOUT_BYTES > MAX_UPLOAD_BYTES, "the slack must be positive, not a fixed value to restate");
});

test("makeSshRun passes output at the cap through", async () => {
	await withFakeSsh("#!/bin/sh\nprintf '12345'\n", async () => {
		const done = await makeSshRun("phone", 5)("cat", new AbortController().signal);
		assert.equal(done.code, 0);
		assert.equal(done.stdout.toString("utf8"), "12345");
	});
});

test("makeSshRun kills a child that streams past the cap and reports the overflow", async () => {
	await withFakeSsh("#!/bin/sh\nprintf 'warning: phone says hi\\n' >&2\nhead -c 100000 /dev/zero\n", async () => {
		const done = await makeSshRun("phone", 1_000)("cat big", new AbortController().signal);
		assert.equal(done.code, -1, "a killed stream is a failed command, not a rejection");
		assert.equal(done.stdout.length, 0, "the partial buffer must be released, not returned");
		assert.match(done.stderr, /^voice: the ssh command produced more than 1000 bytes of stdout; killed/);
		assert.match(done.stderr, /warning: phone says hi/, "earlier stderr diagnostics must survive");
	});
});

test("makeSshRun retains only the head of a runaway stderr", async () => {
	await withFakeSsh("#!/bin/sh\nhead -c 200000 /dev/zero >&2\nprintf 'ok'\n", async () => {
		const done = await makeSshRun("phone", 1_000_000)("cmd", new AbortController().signal);
		assert.equal(done.code, 0, "a chatty stderr is not a failed command");
		assert.equal(done.stdout.toString("utf8"), "ok");
		assert.equal(done.stderr.length, MAX_SSH_STDERR_BYTES, "stderr must be truncated at the cap, not buffered whole");
	});
});

// ---------------------------------------------------------------------------
// Factory registration (index.ts)
// ---------------------------------------------------------------------------

interface CapturedCommand {
	name?: string;
	description?: string;
	handler(args: string, ctx: unknown): Promise<void>;
}

interface CapturedShortcut {
	id: string;
	description?: string;
	handler(ctx: unknown): void | Promise<void>;
}

interface Capture {
	command?: CapturedCommand;
	shortcut?: CapturedShortcut;
	shutdown: boolean;
	sent: Array<{ content: unknown; options: unknown }>;
}

async function loadFactory(): Promise<(pi: unknown) => void> {
	const specifier = new URL("../../voice/index.ts", import.meta.url).href;
	const module = (await import(specifier)) as { default?: unknown };
	assert.equal(typeof module.default, "function", "voice/index.ts must export a default extension factory");
	return module.default as (pi: unknown) => void;
}

function captureFactory(factory: (pi: unknown) => void): Capture {
	const capture: Capture = { shutdown: false, sent: [] };
	factory({
		registerCommand: (name: string, options: Omit<CapturedCommand, "name">) => {
			capture.command = { name, ...options };
		},
		registerShortcut: (id: string, options: Omit<CapturedShortcut, "id">) => {
			capture.shortcut = { id, ...options };
		},
		on: (event: string) => {
			if (event === "session_shutdown") capture.shutdown = true;
		},
		sendUserMessage: (content: unknown, options?: unknown) => {
			capture.sent.push({ content, options });
		},
	});
	return capture;
}

test("the factory registers /voice, ctrl+shift+r and a shutdown handler", async () => {
	await withTempAgentDir(async () => {
		const capture = captureFactory(await loadFactory());
		assert.equal(capture.command?.name, "voice");
		assert.match(capture.command?.description ?? "", /\/voice cancel/);
		assert.equal(capture.shortcut?.id, "ctrl+shift+r");
		assert.equal(capture.shutdown, true);

		// /voice cancel while idle and an unknown argument must not touch ssh.
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { setStatus: () => {}, notify: (message: string) => notices.push(message) } };
		await capture.command?.handler("cancel", ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /nothing to cancel/);
		await capture.command?.handler("bogus", ctx);
		assert.match(notices[1], /usage/);
	});
});

test("status text formats the recording timer and clears on idle", () => {
	assert.equal(statusText({ phase: "recording", elapsedSeconds: 5 }), "● rec 0:05");
	assert.equal(statusText({ phase: "recording", elapsedSeconds: 61 }), "● rec 1:01");
	assert.equal(statusText({ phase: "starting" }), "starting…");
	assert.equal(statusText({ phase: "transcribing" }), "transcribing…");
	assert.equal(statusText({ phase: "idle" }), undefined);
	assert.equal(statusText({ phase: "error", failure: "start-failed", message: "x" }), undefined);
	assert.equal(formatElapsed(0), "0:00");
	assert.equal(formatElapsed(72), "1:12");
});

// ---------------------------------------------------------------------------
// Transcription (transcribe.ts)
// ---------------------------------------------------------------------------

interface FetchCall {
	url: string;
	init: RequestInit;
}

interface FetchSpy {
	fetch: typeof fetch;
	calls: FetchCall[];
}

function scriptedFetch(respond: (call: FetchCall, index: number) => Response | Promise<Response>): FetchSpy {
	const calls: FetchCall[] = [];
	const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
		const call = { url: String(input), init };
		calls.push(call);
		return await respond(call, calls.length - 1);
	};
	return { fetch: fetchImpl as typeof fetch, calls };
}

function jsonResponse(text: string, status = 200): Response {
	return new Response(JSON.stringify({ text }), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that never answers until its signal aborts. */
function pendingOnAbortFetch(call: FetchCall): Promise<Response> {
	return pendingOnAbort<Response>(call.init.signal as AbortSignal);
}

const TRANSCRIBE_CONFIG = { baseUrl: "https://stt.example/v1", model: "whisper-large", timeoutMs: 5_000 };
const TRANSCRIBE_AUDIO = Buffer.from("fake-m4a-bytes");

async function callTranscribe(spy: FetchSpy, overrides: Partial<TranscribeRequest> = {}): Promise<string> {
	return transcribeAudio({
		audio: TRANSCRIBE_AUDIO,
		fileName: "pi-voice-0123456789abcdef0123456789abcdef.m4a",
		config: TRANSCRIBE_CONFIG,
		fetch: spy.fetch,
		...overrides,
	});
}

test("transcribeAudio posts multipart to {baseUrl}/audio/transcriptions with the key", async () => {
	const spy = scriptedFetch(() => jsonResponse("hello world"));
	const text = await callTranscribe(spy, {
		apiKey: "sk-test",
		config: { ...TRANSCRIBE_CONFIG, language: "en", prompt: "pi, agent" },
	});
	assert.equal(text, "hello world");
	assert.equal(spy.calls.length, 1);
	const { url, init } = spy.calls[0];
	assert.equal(url, "https://stt.example/v1/audio/transcriptions");
	assert.equal(init.method, "POST");
	assert.deepEqual(init.headers, { authorization: "Bearer sk-test" });
	const form = await new Response(init.body as FormData).formData();
	assert.equal(form.get("model"), "whisper-large");
	assert.equal(form.get("response_format"), "json");
	assert.equal(form.get("language"), "en");
	assert.equal(form.get("prompt"), "pi, agent");
	const file = form.get("file") as File;
	assert.equal(file.name, "pi-voice-0123456789abcdef0123456789abcdef.m4a");
	assert.equal(Buffer.from(await file.arrayBuffer()).toString("utf8"), "fake-m4a-bytes");
});

test("language and prompt are omitted when unset, and no key means no Authorization header", async () => {
	const spy = scriptedFetch(() => jsonResponse("ok"));
	await callTranscribe(spy);
	const form = await new Response(spy.calls[0].init.body as FormData).formData();
	assert.equal(form.get("language"), null);
	assert.equal(form.get("prompt"), null);
	assert.equal(spy.calls[0].init.headers, undefined);
});

test("resolveApiKey prefers the explicit key and falls back to ambient OpenAI keys only on the default endpoint", async () => {
	const registryReturning = (key: string | undefined) => ({ getApiKeyForProvider: async () => key });

	const explicit = { ...DEFAULT_CONFIG, apiKey: "sk-config" };
	assert.equal(
		await resolveApiKey({ config: explicit, env: { OPENAI_API_KEY: "sk-env" }, modelRegistry: registryReturning("sk-registry") }),
		"sk-config",
	);

	const plain = { ...DEFAULT_CONFIG };
	assert.equal(
		await resolveApiKey({ config: plain, env: { OPENAI_API_KEY: "sk-env" }, modelRegistry: registryReturning("sk-registry") }),
		"sk-env",
	);
	assert.equal(await resolveApiKey({ config: plain, env: {}, modelRegistry: registryReturning("sk-registry") }), "sk-registry");
	assert.equal(await resolveApiKey({ config: plain, env: {}, modelRegistry: registryReturning(undefined) }), undefined);

	const custom = { ...DEFAULT_CONFIG, baseUrl: "https://stt.internal/v1" };
	assert.equal(
		await resolveApiKey({ config: custom, env: { OPENAI_API_KEY: "sk-env" }, modelRegistry: registryReturning("sk-registry") }),
		undefined,
		"an ambient OpenAI key must not leak to a custom endpoint",
	);
	assert.equal(await resolveApiKey({ config: { ...custom, apiKey: "sk-explicit" } }), "sk-explicit");
});

test("a registry that throws counts as no key", async () => {
	const plain = { ...DEFAULT_CONFIG };
	assert.equal(
		await resolveApiKey({
			config: plain,
			env: {},
			modelRegistry: {
				getApiKeyForProvider: async () => {
					throw new Error("no registry");
				},
			},
		}),
		undefined,
	);
});

test("a non-2xx answer is a typed http error with the status and the first body line", async () => {
	const spy = scriptedFetch(() => new Response("Incorrect API key provided\nsecond line", { status: 401 }));
	await assert.rejects(callTranscribe(spy, { apiKey: "sk-bad" }), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "http");
		assert.equal(error.status, 401);
		assert.match(error.message, /HTTP 401/);
		assert.match(error.message, /Incorrect API key provided/);
		assert.doesNotMatch(error.message, /second line/);
		return true;
	});
});

test("a rejecting fetch is a typed network error carrying the cause", async () => {
	const spy = scriptedFetch(() => {
		throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
	});
	await assert.rejects(callTranscribe(spy), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "network");
		assert.match(error.message, /fetch failed/);
		assert.match(error.message, /ECONNREFUSED/);
		return true;
	});
});

test("a 200 without usable text is a typed empty error", async () => {
	const bodies = [jsonResponse(""), new Response("", { status: 200 }), new Response("server says hi", { status: 200 })];
	for (const body of bodies) {
		const spy = scriptedFetch(() => body);
		await assert.rejects(callTranscribe(spy), (error: unknown) => {
			assert.ok(error instanceof TranscribeError);
			assert.equal(error.failure, "empty");
			return true;
		});
	}
});

test("a 400 naming response_format gets exactly one retry with text", async () => {
	const spy = scriptedFetch((_call, index) =>
		index === 0
			? new Response("Unsupported parameter: 'response_format'", { status: 400 })
			: new Response("retried transcript", { status: 200, headers: { "content-type": "text/plain" } }),
	);
	const text = await callTranscribe(spy, { apiKey: "sk-test" });
	assert.equal(text, "retried transcript");
	assert.equal(spy.calls.length, 2);
	const first = await new Response(spy.calls[0].init.body as FormData).formData();
	const second = await new Response(spy.calls[1].init.body as FormData).formData();
	assert.equal(first.get("response_format"), "json");
	assert.equal(second.get("response_format"), "text");
	assert.deepEqual(spy.calls[1].init.headers, { authorization: "Bearer sk-test" });
});

test("a 400 that does not name response_format is not retried", async () => {
	const spy = scriptedFetch(() => new Response("Bad request: audio too short", { status: 400 }));
	await assert.rejects(callTranscribe(spy), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "http");
		assert.equal(error.status, 400);
		return true;
	});
	assert.equal(spy.calls.length, 1);
});

test("a non-400 failure that mentions response_format is not retried", async () => {
	const spy = scriptedFetch(() => new Response("server lost response_format", { status: 500 }));
	await assert.rejects(callTranscribe(spy), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "http");
		assert.equal(error.status, 500);
		return true;
	});
	assert.equal(spy.calls.length, 1, "only a 400 justifies the re-upload");
});

test("a retry that fails as well is reported, not repeated again", async () => {
	const spy = scriptedFetch((_call, index) =>
		new Response(index === 0 ? "response_format unsupported" : "still bad", { status: 400 }),
	);
	await assert.rejects(callTranscribe(spy), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "http");
		assert.equal(error.status, 400);
		assert.match(error.message, /still bad/);
		return true;
	});
	assert.equal(spy.calls.length, 2);
});

test("an oversized recording is refused before any upload", async () => {
	const spy = scriptedFetch(() => jsonResponse("never"));
	await assert.rejects(callTranscribe(spy, { audio: Buffer.alloc(MAX_UPLOAD_BYTES + 1) }), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "too-large");
		return true;
	});
	assert.equal(spy.calls.length, 0);
});

test("a recording of exactly the 25 MB cap is still uploaded", async () => {
	const spy = scriptedFetch(() => jsonResponse("boundary"));
	const text = await callTranscribe(spy, { audio: Buffer.alloc(MAX_UPLOAD_BYTES) });
	assert.equal(text, "boundary");
	assert.equal(spy.calls.length, 1, "the cap is inclusive: /audio/transcriptions accepts 'at most' 25 MB");
});

test("an upload that outruns the timeout fails as a typed network error", async () => {
	const spy = scriptedFetch((call) => pendingOnAbortFetch(call));
	await assert.rejects(callTranscribe(spy, { config: { ...TRANSCRIBE_CONFIG, timeoutMs: 20 } }), (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "network");
		assert.match(error.message, /timed out after 20 ms/);
		return true;
	});
});

test("aborting the caller signal cancels the request", async () => {
	const spy = scriptedFetch((call) => pendingOnAbortFetch(call));
	const controller = new AbortController();
	const pending = callTranscribe(spy, { signal: controller.signal });
	await flush();
	controller.abort();
	await assert.rejects(pending, (error: unknown) => {
		assert.ok(error instanceof TranscribeError);
		assert.equal(error.failure, "network");
		assert.match(error.message, /cancelled/);
		return true;
	});
});

// ---------------------------------------------------------------------------
// End-to-end wiring: recorder → transcription → editor (index.ts)
// ---------------------------------------------------------------------------

interface FlowHarness {
	command: CapturedCommand;
	statuses: Array<string | undefined>;
	/** The status key of every setStatus call, so a rename cannot ship unseen. */
	statusKeys: string[];
	notices: string[];
	pasted: Array<{ raw: string; expanded: string; marker: string | null }>;
	sent: Array<{ content: unknown; options: unknown }>;
	runner: RunnerSpy;
	fetchCalls: FetchCall[];
	tmpDir: string;
	ctx: {
		hasUI: boolean;
		isIdle(): boolean;
		modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
		ui: {
			setStatus(key: string, text: string | undefined): void;
			notify(message: string, level?: string): void;
			pasteToEditor(text: string): void;
		};
	};
	setIdle(value: boolean): void;
	/** The editor's text as a submit would read it (paste markers expanded). */
	submitEditor(): string;
}

interface FlowOptions {
	/** voice.json contents for this run. */
	file?: Record<string, unknown>;
	/** PI_VOICE_* env for this run (the rest of VOICE_ENV is cleared). */
	env?: Record<string, string | undefined>;
	respond?: (call: RunCall, index: number) => RunResult | Promise<RunResult>;
	respondFetch?: (call: FetchCall, index: number) => Response | Promise<Response>;
	idle?: boolean;
	/** Whether the session has an editor to paste into (default true). */
	hasUI?: boolean;
	/** What ctx.modelRegistry.getApiKeyForProvider("openai") returns. */
	registryKey?: string;
}

async function withFlow(options: FlowOptions, fn: (h: FlowHarness) => Promise<void>): Promise<void> {
	await withTempAgentDir(async (agentDir) => {
		if (options.file) await writeFile(path.join(agentDir, CONFIG_BASENAME), JSON.stringify(options.file));
		// Kill the ambient OPENAI_API_KEY too: on the default endpoint it
		// would shortcut resolveApiKey past the registry fallback that some
		// of these tests pin.
		await withEnv({ ...clearVoiceEnv(), OPENAI_API_KEY: undefined, ...options.env }, async () => {
			const tmpDir = await mkdtemp(path.join(tmpdir(), "voice-flow-"));
			try {
				await fn(makeFlowHarness(options, tmpDir));
			} finally {
				await rm(tmpDir, { recursive: true, force: true });
			}
		});
	});
}

function makeFlowHarness(options: FlowOptions, tmpDir: string): FlowHarness {
	const runner = scriptedRunner(
		options.respond ??
			((call) => {
				if (call.command.startsWith("cat ")) return result(AUDIO);
				if (call.command.includes("-q")) return result("Recording finished: phone-side m4a");
				return result();
			}),
	);
	const fetchSpy = scriptedFetch(options.respondFetch ?? (() => jsonResponse("hello from the phone")));
	const statuses: Array<string | undefined> = [];
	const statusKeys: string[] = [];
	const notices: string[] = [];
	const pasted: FlowHarness["pasted"] = [];
	let idle = options.idle ?? true;
	let editor = "";
	const ctx: FlowHarness["ctx"] = {
		hasUI: options.hasUI ?? true,
		isIdle: () => idle,
		modelRegistry: { getApiKeyForProvider: async () => options.registryKey },
		ui: {
			setStatus: (key, text) => {
				statusKeys.push(key);
				statuses.push(text);
			},
			notify: (message) => notices.push(message),
			pasteToEditor: (text) => {
				// Model pi's editor: a paste over 10 lines or 1000 characters
				// collapses to a marker, and a submit reads the expanded text.
				const collapsed = text.length > 1_000 || text.split("\n").length > 10;
				editor = text;
				pasted.push({ raw: collapsed ? "[paste #1]" : text, expanded: text, marker: collapsed ? "[paste #1]" : null });
			},
		},
	};
	const capture = captureFactory((pi) =>
		createVoiceExtension(pi as Parameters<typeof createVoiceExtension>[0], {
			run: runner.run,
			fetch: fetchSpy.fetch,
			tmpDir,
		}),
	);
	const command = capture.command;
	assert.ok(command, "the factory must register /voice");
	return {
		command,
		statuses,
		statusKeys,
		notices,
		pasted,
		sent: capture.sent,
		runner,
		fetchCalls: fetchSpy.calls,
		tmpDir,
		ctx,
		setIdle: (value) => {
			idle = value;
		},
		submitEditor: () => editor,
	};
}

/** `/voice` to start, then `/voice` to stop and run the whole chain. */
async function voiceCycle(h: FlowHarness): Promise<void> {
	await h.command.handler("", h.ctx);
	await h.command.handler("", h.ctx);
}

test("full flow: /voice twice records, transcribes, and pastes the transcript", async () => {
	await withFlow({ env: { [VOICE_ENV.apiKey]: "sk-flow" } }, async (h) => {
		await voiceCycle(h);

		assert.equal(h.pasted.length, 1);
		assert.equal(h.pasted[0].expanded, "hello from the phone");
		assert.equal(h.pasted[0].marker, null, "a short transcript is pasted verbatim");
		assert.equal(h.sent.length, 0, "autoSubmit is off by default");

		assert.deepEqual(
			h.statuses.filter((text) => text !== undefined && !text.startsWith("● rec")),
			["starting…", "stopping…", "fetching…", "transcribing…"],
		);
		assert.deepEqual([...new Set(h.statusKeys)], ["voice"], "every status write uses the voice key");
		assert.equal(h.statuses.at(-1), undefined, "the status key is cleared at idle");

		const commands = h.runner.commands();
		assert.match(commands[0], /^mkdir -p /);
		assert.equal(commands[1], buildStopCommand());
		assert.match(commands[2], /^cat -- "\$HOME\/\.pi-voice\//);
		assert.match(commands[3], /^rm -f -- "\$HOME\/\.pi-voice\//);

		const { url, init } = h.fetchCalls[0];
		assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
		assert.deepEqual(init.headers, { authorization: "Bearer sk-flow" });
		const form = await new Response(init.body as FormData).formData();
		assert.equal(form.get("model"), "gpt-4o-transcribe");
		assert.equal(form.get("response_format"), "json");
		const file = form.get("file") as File;
		assert.match(file.name, /^pi-voice-[a-f0-9]{32}\.m4a$/, "the multipart filename is the basename, not the temp path");

		assert.deepEqual(await readdir(h.tmpDir), [], "the local recording is dropped after a successful paste");
	});
});

test("autoSubmit while idle sends the transcript as a user message", async () => {
	await withFlow({ file: { autoSubmit: true, apiKey: "sk-flow" } }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 0);
		assert.deepEqual(h.sent, [{ content: "hello from the phone", options: undefined }]);
	});
});

test("autoSubmit while streaming queues the transcript as a follow-up", async () => {
	await withFlow({ file: { autoSubmit: true, apiKey: "sk-flow" }, idle: false }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 0);
		assert.deepEqual(h.sent, [{ content: "hello from the phone", options: { deliverAs: "followUp" } }]);
	});
});

test("without an editor the transcript is submitted, and streaming still queues it", async () => {
	await withFlow({ file: { apiKey: "sk-flow" }, hasUI: false }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 0);
		assert.deepEqual(h.sent, [{ content: "hello from the phone", options: undefined }]);
	});
	await withFlow({ file: { apiKey: "sk-flow" }, hasUI: false, idle: false }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 0);
		assert.deepEqual(h.sent, [{ content: "hello from the phone", options: { deliverAs: "followUp" } }]);
	});
});

test("a transcript starting with / is content, never a dispatched command", async () => {
	await withFlow(
		{
			file: { autoSubmit: true, apiKey: "sk-flow" },
			idle: false,
			respondFetch: () => jsonResponse("/voice this is dictated text"),
		},
		async (h) => {
			await voiceCycle(h);
			assert.equal(h.sent.length, 1);
			assert.equal(h.sent[0].content, "/voice this is dictated text");
			const options = h.sent[0].options as Record<string, unknown> | undefined;
			assert.deepEqual(options, { deliverAs: "followUp" });
			assert.equal(Object.hasOwn(options as object, "expandPromptTemplates"), false);
		},
	);
});

test("a large transcript travels through the editor's paste marker and expands back", async () => {
	const transcript = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join("\n");
	await withFlow({ file: { apiKey: "sk-flow" }, respondFetch: () => jsonResponse(transcript) }, async (h) => {
		h.setIdle(false); // the paste path does not care whether the agent is streaming
		await voiceCycle(h);
		assert.equal(h.pasted.length, 1);
		assert.equal(h.pasted[0].marker, "[paste #1]");
		assert.equal(h.pasted[0].expanded, transcript);
		assert.equal(h.submitEditor(), transcript, "a submit reads the full transcript back");
	});
});

test("the model registry's OpenAI key is the last fallback on the default endpoint", async () => {
	await withFlow({ registryKey: "sk-registry" }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 1);
		assert.deepEqual(h.fetchCalls[0].init.headers, { authorization: "Bearer sk-registry" });
	});
});

test("a custom endpoint never sees an ambient OpenAI key, end to end", async () => {
	await withFlow(
		{
			env: {
				[VOICE_ENV.baseUrl]: "https://stt.example.test/v1",
				OPENAI_API_KEY: "sk-ambient",
			},
		},
		async (h) => {
			await voiceCycle(h);
			assert.equal(h.pasted.length, 1);
			assert.equal(h.fetchCalls[0].url, "https://stt.example.test/v1/audio/transcriptions");
			assert.equal(h.fetchCalls[0].init.headers, undefined, "no ambient key may leave for a custom endpoint");
		},
	);
});

test("cancel while fetching the audio posts nothing and leaves no temp file", async () => {
	await withFlow(
		{
			env: { [VOICE_ENV.apiKey]: "sk-flow" },
			respond: (call) => (call.command.startsWith("cat ") ? pendingOnAbort(call.signal) : result()),
		},
		async (h) => {
			await h.command.handler("", h.ctx);
			const stopping = h.command.handler("", h.ctx);
			await waitFor(() => h.statuses.includes("fetching…"));
			await h.command.handler("cancel", h.ctx);
			await stopping;

			assert.equal(h.fetchCalls.length, 0, "no transcription attempt");
			assert.equal(h.pasted.length + h.sent.length, 0);
			assert.deepEqual(await readdir(h.tmpDir), []);
			assert.equal(h.statuses.at(-1), undefined);
		},
	);
});

test("cancel while transcribing aborts the upload, pastes nothing, and drops the temp file", async () => {
	await withFlow(
		{
			env: { [VOICE_ENV.apiKey]: "sk-flow" },
			respondFetch: (call) => pendingOnAbortFetch(call),
		},
		async (h) => {
			await h.command.handler("", h.ctx);
			const stopping = h.command.handler("", h.ctx);
			await waitFor(() => h.fetchCalls.length === 1);
			assert.equal(h.statuses.includes("transcribing…"), true);
			await h.command.handler("cancel", h.ctx);
			await stopping;

			assert.equal(h.fetchCalls[0].init.signal?.aborted, true, "the upload must be aborted");
			assert.equal(h.pasted.length + h.sent.length, 0);
			assert.deepEqual(await readdir(h.tmpDir), []);
			assert.equal(h.statuses.at(-1), undefined);
		},
	);
});

test("a transcription that resolves exactly as cancel lands must not paste", async () => {
	// The fake fetch ignores the abort and answers with a full response after
	// the cancel: the post-deliver abort check is the only thing keeping this
	// transcript out of the editor, so its removal must fail this test.
	let release: (() => void) | undefined;
	await withFlow(
		{
			env: { [VOICE_ENV.apiKey]: "sk-flow" },
			respondFetch: () =>
				new Promise<Response>((resolve) => {
					release = () => resolve(jsonResponse("too late"));
				}),
		},
		async (h) => {
			await h.command.handler("", h.ctx);
			const stopping = h.command.handler("", h.ctx);
			await waitFor(() => h.fetchCalls.length === 1);
			await h.command.handler("cancel", h.ctx);
			assert.ok(release, "the upload was issued");
			release();
			await stopping;

			assert.equal(h.pasted.length + h.sent.length, 0, "a cancelled recording is never presented");
			assert.deepEqual(await readdir(h.tmpDir), []);
			assert.equal(h.statuses.at(-1), undefined);
		},
	);
});

test("a transcription failure notifies with the kept audio path and leaves the file", async () => {
	await withFlow(
		{ env: { [VOICE_ENV.apiKey]: "sk-flow" }, respondFetch: () => new Response("boom: model exploded", { status: 500 }) },
		async (h) => {
			await voiceCycle(h);
			assert.equal(h.pasted.length + h.sent.length, 0);
			const notice = h.notices.find((message) => message.includes("boom: model exploded"));
			assert.ok(notice, `expected a transcription failure notice, got: ${h.notices.join(" | ")}`);
			assert.match(notice, /audio kept at /);
			const kept = /audio kept at (.+)$/.exec(notice)?.[1];
			assert.ok(kept);
			assert.equal((await stat(kept)).size, AUDIO.length);
			assert.equal(h.statuses.at(-1), undefined);
		},
	);
});

test("a fetched recording over the 25 MB cap fails locally and keeps the audio", async () => {
	const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
	await withFlow(
		{
			env: { [VOICE_ENV.apiKey]: "sk-flow" },
			respond: (call) => {
				if (call.command.startsWith("cat ")) return result(tooBig);
				if (call.command.includes("-q")) return result("Recording finished: phone-side m4a");
				return result();
			},
		},
		async (h) => {
			await voiceCycle(h);
			assert.equal(h.fetchCalls.length, 0, "an oversized recording is never uploaded");
			assert.equal(h.pasted.length + h.sent.length, 0);
			const notice = h.notices.find((message) => message.includes("refusing to upload"));
			assert.ok(notice, `expected a too-large notice, got: ${h.notices.join(" | ")}`);
			assert.match(notice, /audio kept at /);
		},
	);
});

test("keepAudio keeps the audio and tells the user where it is", async () => {
	await withFlow({ file: { keepAudio: true, apiKey: "sk-flow" } }, async (h) => {
		await voiceCycle(h);
		assert.equal(h.pasted.length, 1);
		const notice = h.notices.find((message) => message.includes("audio kept at"));
		assert.ok(notice, `expected a kept-audio notice, got: ${h.notices.join(" | ")}`);
		const kept = /audio kept at (.+)$/.exec(notice)?.[1];
		assert.ok(kept);
		assert.equal((await stat(kept)).size, AUDIO.length);
		assert.deepEqual(await readdir(h.tmpDir), [path.basename(kept)]);
	});
});
