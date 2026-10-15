/**
 * The recording side of the voice extension: pure command builders for the
 * phone-side recorder, and a state machine that drives them.
 *
 * Everything hard about this file comes from the recorder being on the other
 * end of an ssh connection:
 *
 * - `termux-microphone-record` is **device-global**. A second start fails with
 *   "Recording already in progress!", and any `-q` stops whatever is recording
 *   — including a recording this extension did not start. So the state machine
 *   never issues `-q` as a repair for an unexpected state; only `/voice cancel`
 *   (an explicit user action) does, as a best-effort cleanup.
 * - Started processes survive a dropped ssh connection, so cancel and shutdown
 *   clean up the remote file themselves instead of trusting the phone.
 * - `ssh` may hang indefinitely (network gone), so every cleanup call is
 *   bounded by a budget and abandoned, not awaited, when it overruns.
 *
 * The runner is injected so the whole machine is testable without a phone:
 *
 *     run(command, signal) => { code, stdout: Buffer, stderr }
 *
 * stdin is unused and stdout is a Buffer because the fetch command streams the
 * m4a through it. Text callers decode it explicitly (`stdout.toString("utf8")`).
 *
 * State (one in-flight operation at a time):
 *
 *     idle → starting → recording → stopping → fetching → transcribing → idle
 *                                       ↳ error (failure + message)
 *
 * `deliver` is the hand-off point: the recorder has fetched the audio to a
 * local temp file and asks the caller to do something with it (transcribe and
 * paste, in index.ts). The recorder reports phase "transcribing" while the
 * promise is pending, so `/voice cancel` can abort it through the same signal.
 */

import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_RECORDER_PATH, MAX_SECONDS_MAX, MAX_SECONDS_MIN, type VoiceConfig } from "./config.ts";

/** Remote staging directory. Kept out of the shell's cwd: `$HOME` expands on
 * the phone, and the directory is created by the start command itself. */
export const REMOTE_VOICE_DIR = "$HOME/.pi-voice";

/** Recording ids are the only variable part of the remote command, so pin
 * their shape: 128 bits of lowercase hex, nothing a shell could interpret. */
export const RECORDING_ID_PATTERN = /^[a-f0-9]{32}$/;

/** The phone stops on its own at `-l` seconds. The local timer stops at
 * `maxSeconds + STOP_GRACE_SECONDS` so the phone's own expiry is the one that
 * fires when both are healthy, and its "No recording to stop" is the normal
 * case rather than a race. */
export const STOP_GRACE_SECONDS = 3;

/** Bound for one cleanup call (stop/rm over ssh) before it is abandoned. */
export const CLEANUP_BUDGET_MS = 2_000;

/** Bound for the whole `session_shutdown` cleanup. Pi awaits shutdown handlers
 * with no timeout of its own, so the recorder must bound itself. */
export const SHUTDOWN_BUDGET_MS = 2_500;

export type VoicePhase = "idle" | "starting" | "recording" | "stopping" | "fetching" | "transcribing" | "error";

export type RecorderFailure =
	| "already-recording"
	| "start-failed"
	| "stop-failed"
	| "fetch-failed"
	| "empty-recording"
	| "deliver-failed";

/** Emitted on every transition and on each whole-second tick while recording. */
export interface RecorderStatus {
	phase: VoicePhase;
	/** Whole seconds since recording began; present only while recording. */
	elapsedSeconds?: number;
	failure?: RecorderFailure;
	message?: string;
	/** Local audio intentionally kept on disk (deliver failure, keepAudio). */
	localPath?: string;
}

export interface RunResult {
	code: number;
	stdout: Buffer;
	stderr: string;
}

export type Run = (command: string, signal: AbortSignal) => Promise<RunResult>;

/** Injectable time, so tests can run a five-minute timer in microseconds. */
export interface Clock {
	now(): number;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** The default clock is dynamic on purpose: `Date.now` and the global timer
 * functions are looked up on each call, so `node:test`'s mock timers, which
 * patch the globals, actually take effect. */
export const systemClock: Clock = {
	now: () => Date.now(),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------
// Command builders (pure)
// ---------------------------------------------------------------------------

export function newRecordingId(): string {
	return randomBytes(16).toString("hex");
}

function assertRecordingId(id: string): void {
	if (!RECORDING_ID_PATTERN.test(id)) {
		throw new Error(`voice: refusing recording id ${JSON.stringify(id)}: expected 32 lowercase hex characters`);
	}
}

function assertMaxSeconds(maxSeconds: number): void {
	if (!Number.isInteger(maxSeconds) || maxSeconds < MAX_SECONDS_MIN || maxSeconds > MAX_SECONDS_MAX) {
		throw new Error(
			`voice: refusing -l ${JSON.stringify(maxSeconds)}: expected an integer in [${MAX_SECONDS_MIN}, ${MAX_SECONDS_MAX}]`,
		);
	}
}

function assertBitrate(bitrateKbps: number): void {
	if (!Number.isInteger(bitrateKbps) || bitrateKbps <= 0) {
		throw new Error(`voice: refusing -b ${JSON.stringify(bitrateKbps)}: expected a positive integer`);
	}
}

/** `$HOME/.pi-voice/<id>.m4a` on the phone. Quoting is the caller's job. */
export function remoteRecordingPath(id: string): string {
	assertRecordingId(id);
	return `${REMOTE_VOICE_DIR}/${id}.m4a`;
}

/** The local temp file the fetched m4a lands in, mode 0o600. */
export function localRecordingPath(id: string, dir: string = tmpdir()): string {
	assertRecordingId(id);
	return join(dir, `pi-voice-${id}.m4a`);
}

export interface StartCommandOptions {
	id: string;
	maxSeconds: number;
	/** Appended as `-b <kbps>` when set; the device default is left alone. */
	bitrateKbps?: number;
	recorderPath?: string;
}

/**
 * One remote shell string: create the staging directory, then start the
 * recorder with an absolute path (the non-interactive ssh PATH does not
 * include Termux's `usr/bin`). `-l` is always passed as a positive integer:
 * `-l <= 0` means "record forever" and must never reach the phone.
 */
export function buildStartCommand(options: StartCommandOptions): string {
	assertRecordingId(options.id);
	assertMaxSeconds(options.maxSeconds);
	if (options.bitrateKbps !== undefined) assertBitrate(options.bitrateKbps);
	const recorder = options.recorderPath ?? DEFAULT_RECORDER_PATH;
	const args = ["-f", `"${remoteRecordingPath(options.id)}"`, "-l", String(options.maxSeconds), "-e", "aac"];
	if (options.bitrateKbps !== undefined) args.push("-b", String(options.bitrateKbps));
	return `mkdir -p "${REMOTE_VOICE_DIR}" && ${recorder} ${args.join(" ")}`;
}

export function buildStopCommand(recorderPath: string = DEFAULT_RECORDER_PATH): string {
	return `${recorderPath} -q`;
}

export function buildFetchCommand(id: string): string {
	return `cat -- "${remoteRecordingPath(id)}"`;
}

export function buildCleanupCommand(id: string): string {
	return `rm -f -- "${remoteRecordingPath(id)}"`;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface RecorderDeps {
	run: Run;
	status: (status: RecorderStatus) => void;
	/**
	 * Consume the fetched recording. Resolves when the audio has been handled
	 * (e.g. transcribed and pasted); rejects when handling failed. The signal
	 * is aborted by cancel/shutdown and must abort the work it owns.
	 */
	deliver: (localPath: string, signal: AbortSignal) => Promise<void>;
	config: Pick<VoiceConfig, "recorderPath" | "maxSeconds" | "bitrateKbps" | "keepAudio">;
	clock?: Clock;
	tmpDir?: string;
	cleanupBudgetMs?: number;
}

export class Recorder {
	readonly #run: Run;
	readonly #status: (status: RecorderStatus) => void;
	readonly #deliver: (localPath: string, signal: AbortSignal) => Promise<void>;
	readonly #config: RecorderDeps["config"];
	readonly #clock: Clock;
	readonly #tmpDir: string | undefined;
	readonly #cleanupBudgetMs: number;

	#phase: VoicePhase = "idle";
	#abort: AbortController | undefined;
	#timer: unknown;
	#recordingStartedAt = 0;
	#lastTickSecond = -1;
	#id: string | undefined;
	#remotePath: string | undefined;
	#localPath: string | undefined;
	#failure: RecorderFailure | undefined;
	#message: string | undefined;
	#keptPath: string | undefined;
	#cancelling: Promise<void> | undefined;
	#shutdown: Promise<void> | undefined;

	constructor(deps: RecorderDeps) {
		this.#run = deps.run;
		this.#status = deps.status;
		this.#deliver = deps.deliver;
		this.#config = deps.config;
		this.#clock = deps.clock ?? systemClock;
		this.#tmpDir = deps.tmpDir;
		this.#cleanupBudgetMs = deps.cleanupBudgetMs ?? CLEANUP_BUDGET_MS;
	}

	phase(): VoicePhase {
		return this.#phase;
	}

	/**
	 * Begin a recording. Allowed from `idle` and from `error` (a failed start
	 * is retryable); refused while anything is in flight or recording. A start
	 * that fails because the phone is already recording is its own failure —
	 * the message says what to do, and no `-q` is issued.
	 */
	async start(): Promise<void> {
		if (this.#phase !== "idle" && this.#phase !== "error") return;

		const abort = new AbortController();
		const id = newRecordingId();
		this.#abort = abort;
		this.#id = id;
		this.#remotePath = remoteRecordingPath(id);
		this.#localPath = localRecordingPath(id, this.#tmpDir);
		this.#failure = undefined;
		this.#message = undefined;
		this.#keptPath = undefined;
		this.#setPhase("starting");

		const result = await this.#runSafe(
			buildStartCommand({
				id,
				maxSeconds: this.#config.maxSeconds,
				...(this.#config.bitrateKbps !== undefined ? { bitrateKbps: this.#config.bitrateKbps } : {}),
				recorderPath: this.#config.recorderPath,
			}),
			abort.signal,
		);
		if (abort.signal.aborted) return; // a cancel owns the outcome now

		if (!result) {
			this.#fail("start-failed", "the ssh command that starts the recorder did not run");
			return;
		}
		const output = combinedOutput(result);
		if (/already in progress/i.test(output)) {
			this.#fail(
				"already-recording",
				"the phone is already recording (started outside pi); /voice cancel stops and discards it",
			);
			return;
		}
		if (result.code !== 0) {
			this.#fail("start-failed", `starting the recorder failed (exit ${result.code}): ${firstLine(result.stderr)}`);
			return;
		}

		this.#recordingStartedAt = this.#clock.now();
		this.#lastTickSecond = 0;
		this.#setPhase("recording");
		this.#timer = this.#clock.setInterval(() => this.#tick(), 1_000);
	}

	/**
	 * Stop and collect the recording: `-q`, fetch the m4a to a local temp
	 * file (mode 0o600), drop the remote copy, then hand the file to
	 * `deliver`. `No recording to stop` is the expected answer after the
	 * phone's own `-l` expiry and is tolerated; a missing or empty file is
	 * not — it means there is nothing to transcribe.
	 *
	 * The remote copy survives fetch failures and empty recordings (nothing
	 * was collected, so the recording is all that is left); transcription
	 * failures keep the local copy so the audio is not lost.
	 */
	async stop(): Promise<void> {
		if (this.#phase !== "recording") return;
		const signal = this.#abort?.signal;
		if (!signal || !this.#id || !this.#remotePath) {
			this.#fail("stop-failed", "no recording session is active");
			return;
		}
		const id = this.#id;
		const remotePath = this.#remotePath;
		const localPath = this.#localPath as string;

		this.#clearTimer();
		this.#setPhase("stopping");
		const stopped = await this.#runSafe(buildStopCommand(this.#config.recorderPath), signal);
		if (signal.aborted) return;
		if (!stopped) {
			this.#fail("stop-failed", "the ssh command that stops the recorder did not run");
			return;
		}
		const tolerated = /no recording to stop/i.test(combinedOutput(stopped));
		if (stopped.code !== 0 && !tolerated) {
			this.#fail("stop-failed", `stopping the recorder failed (exit ${stopped.code}): ${firstLine(stopped.stderr)}`);
			return;
		}

		this.#setPhase("fetching");
		const fetched = await this.#runSafe(buildFetchCommand(id), signal);
		if (signal.aborted) return;
		if (!fetched) {
			this.#fail("fetch-failed", "the ssh command that fetches the recording did not run");
			return;
		}
		if (fetched.code !== 0) {
			this.#fail("fetch-failed", `fetching the recording failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`);
			return;
		}
		if (fetched.stdout.length === 0) {
			this.#fail("empty-recording", `no audio arrived for ${remotePath}`);
			return;
		}
		try {
			await writeFile(localPath, fetched.stdout, { mode: 0o600 });
		} catch (error) {
			this.#fail("fetch-failed", `writing ${localPath} failed: ${(error as Error).message}`);
			return;
		}
		if (signal.aborted) {
			// A cancel landed while the file was being written; it already
			// swept the directory, so the file we just created would leak.
			await rm(localPath, { force: true });
			return;
		}

		await this.#cleanupRemote(id);
		if (signal.aborted) return;

		this.#setPhase("transcribing");
		try {
			await this.#deliver(localPath, signal);
		} catch (error) {
			if (signal.aborted) return;
			this.#keptPath = localPath;
			this.#fail("deliver-failed", `handling the recording failed: ${(error as Error).message}`);
			this.#keptPath = undefined;
			return;
		}
		if (signal.aborted) return;

		if (this.#config.keepAudio) this.#keptPath = localPath;
		else await rm(localPath, { force: true });
		this.#finishCycle();
	}

	/**
	 * Abort whatever is in flight and leave nothing behind on either side.
	 * This is the one path allowed to issue `-q` for a recording the extension
	 * may not own, because the user asked for it explicitly.
	 *
	 * Per phase: starting/recording/stopping → best-effort `-q` + remote
	 * cleanup, never fetch; fetching → drop the partial local file and the
	 * remote original; transcribing → drop the local copy unless keepAudio.
	 * Idempotent while running, a no-op when already idle.
	 */
	// Not `async`: an async method would wrap the stored promise, and callers
	// joining an in-flight cancel must get the same promise back.
	cancel(): Promise<void> {
		if (this.#phase === "idle") return Promise.resolve();
		if (this.#cancelling) return this.#cancelling;
		const running = this.#doCancel().finally(() => {
			this.#cancelling = undefined;
		});
		this.#cancelling = running;
		return running;
	}

	/**
	 * Bounded cancel for `session_shutdown`: pi awaits shutdown handlers with
	 * no timeout of its own, so this one always returns within
	 * SHUTDOWN_BUDGET_MS, clears the timer, and clears the status. Idempotent.
	 */
	// Not `async`, for the same reason as cancel().
	shutdown(): Promise<void> {
		if (this.#shutdown) return this.#shutdown;
		const running = this.#doShutdown().finally(() => {
			this.#shutdown = undefined;
		});
		this.#shutdown = running;
		return running;
	}

	async #doShutdown(): Promise<void> {
		await this.#settleWithin(this.cancel(), SHUTDOWN_BUDGET_MS);
		this.#clearCycle();
		this.#setPhase("idle");
	}

	async #doCancel(): Promise<void> {
		const phase = this.#phase;
		const id = this.#id;
		const localPath = this.#localPath;
		this.#abort?.abort();
		this.#clearTimer();

		switch (phase) {
			case "starting":
			case "recording":
			case "stopping":
			case "error":
				await this.#bestEffortStop();
				await this.#cleanupRemote(id);
				if (localPath && !this.#config.keepAudio) await rm(localPath, { force: true });
				break;
			case "fetching":
				if (localPath) await rm(localPath, { force: true });
				await this.#cleanupRemote(id);
				break;
			case "transcribing":
				if (localPath && !this.#config.keepAudio) await rm(localPath, { force: true });
				break;
			case "idle":
				break;
		}

		this.#clearCycle();
		this.#setPhase("idle");
	}

	#tick(): void {
		if (this.#phase !== "recording") return;
		const elapsed = Math.floor((this.#clock.now() - this.#recordingStartedAt) / 1_000);
		if (elapsed <= this.#lastTickSecond) return;
		this.#lastTickSecond = elapsed;
		this.#emit();
		if (elapsed >= this.#config.maxSeconds + STOP_GRACE_SECONDS) void this.stop();
	}

	async #bestEffortStop(): Promise<void> {
		await this.#runBounded(buildStopCommand(this.#config.recorderPath), this.#cleanupBudgetMs);
	}

	async #cleanupRemote(id: string | undefined): Promise<void> {
		if (!id) return;
		await this.#runBounded(buildCleanupCommand(id), this.#cleanupBudgetMs);
	}

	/** A run bounded by a budget. On timeout the underlying command is
	 * aborted and abandoned: cleanup must never hang shutdown. */
	async #runBounded(command: string, budgetMs: number): Promise<RunResult | undefined> {
		const abort = new AbortController();
		const outcome = await this.#settleWithin(this.#runSafe(command, abort.signal), budgetMs);
		if (!outcome.ok) abort.abort();
		return outcome.ok ? outcome.value : undefined;
	}

	async #runSafe(command: string, signal: AbortSignal): Promise<RunResult | undefined> {
		try {
			return await this.#run(command, signal);
		} catch {
			return undefined;
		}
	}

	/** Race a promise against a clock timeout. Never rejects: a timeout, a
	 * rejection, and a result are all reported as an outcome. */
	#settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
		return new Promise((resolve) => {
			let settled = false;
			const handle = this.#clock.setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve({ ok: false });
				}
			}, ms);
			promise.then(
				(value) => {
					if (!settled) {
						settled = true;
						this.#clock.clearTimeout(handle);
						resolve({ ok: true, value });
					}
				},
				() => {
					if (!settled) {
						settled = true;
						this.#clock.clearTimeout(handle);
						resolve({ ok: false });
					}
				},
			);
		});
	}

	#fail(failure: RecorderFailure, message: string): void {
		this.#failure = failure;
		this.#message = message;
		this.#setPhase("error");
	}

	#setPhase(phase: VoicePhase): void {
		this.#phase = phase;
		if (phase !== "error") {
			this.#failure = undefined;
			this.#message = undefined;
		}
		this.#emit();
	}

	#emit(): void {
		this.#status(this.#snapshot());
	}

	#snapshot(): RecorderStatus {
		const status: RecorderStatus = { phase: this.#phase };
		if (this.#phase === "recording") status.elapsedSeconds = Math.max(0, this.#lastTickSecond);
		if (this.#failure) status.failure = this.#failure;
		if (this.#message) status.message = this.#message;
		if (this.#keptPath) status.localPath = this.#keptPath;
		return status;
	}

	#finishCycle(): void {
		this.#clearCycle();
		// #keptPath intentionally survives into the idle event, so a caller can
		// tell the user where the audio is; it must not survive past it.
		this.#setPhase("idle");
		this.#keptPath = undefined;
	}

	#clearCycle(): void {
		this.#clearTimer();
		this.#abort = undefined;
		this.#id = undefined;
		this.#remotePath = undefined;
		this.#localPath = undefined;
		this.#recordingStartedAt = 0;
		this.#lastTickSecond = -1;
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) {
			this.#clock.clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}
}

/** stdout and stderr joined for message matching. The recorder's statuses are
 * printed on whichever stream; the exact one has not been pinned. */
function combinedOutput(result: RunResult): string {
	return `${result.stdout.toString("utf8")}\n${result.stderr}`;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
}
