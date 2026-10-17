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
 *   bounded by a budget and abandoned, not awaited, when it overruns, and the
 *   fetch is bounded too (`FETCH_BUDGET_MS`) so a stalled transfer cannot park
 *   the cycle in `fetching`.
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
import { describeError, firstLine } from "./util.ts";

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

/** Bound for the fetch of the recorded m4a. Much larger than the cleanup
 * budgets because a real recording (up to the 25 MB upload cap) crosses the
 * network, but finite because a stalled transfer must not park the cycle in
 * `fetching` until the user cancels. */
export const FETCH_BUDGET_MS = 120_000;

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

/** `#runSafe`'s never-rejecting result: the value, or the thrown cause. */
type RunOutcome = { ok: true; result: RunResult } | { ok: false; error: unknown };

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
		// A cancel in flight owns the phone until its bounded cleanup lands: a
		// start now could be stopped by that cleanup's best-effort `-q`, and the
		// cancel's teardown would wipe the new cycle anyway. Refuse; the caller
		// retries once the cancel has landed.
		if (this.#cancelling) return;
		if (this.#phase !== "idle" && this.#phase !== "error") return;

		const abort = new AbortController();
		const id = newRecordingId();
		this.#abort = abort;
		this.#id = id;
		this.#remotePath = remoteRecordingPath(id);
		this.#localPath = localRecordingPath(id, this.#tmpDir);
		this.#failure = undefined;
		this.#message = undefined;
		this.#setPhase("starting");

		const result = await this.#runStage({
			command: buildStartCommand({
				id,
				maxSeconds: this.#config.maxSeconds,
				...(this.#config.bitrateKbps !== undefined ? { bitrateKbps: this.#config.bitrateKbps } : {}),
				recorderPath: this.#config.recorderPath,
			}),
			signal: abort.signal,
			failure: "start-failed",
			what: "starts the recorder",
		});
		if (result === undefined) return; // the cancel landed or the failure was reported
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
		// Same ownership rule as start(): a cancel already stops the recorder
		// and discards the recording, so a concurrent stop would only add a
		// second `-q` and race the cleanup.
		if (this.#cancelling) return;
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
		const stopped = await this.#runStage({
			command: buildStopCommand(this.#config.recorderPath),
			signal,
			failure: "stop-failed",
			what: "stops the recorder",
		});
		if (stopped === undefined) return;
		const tolerated = /no recording to stop/i.test(combinedOutput(stopped));
		if (stopped.code !== 0 && !tolerated) {
			this.#fail("stop-failed", `stopping the recorder failed (exit ${stopped.code}): ${firstLine(stopped.stderr)}`);
			return;
		}

		this.#setPhase("fetching");
		const fetched = await this.#runStage({
			command: buildFetchCommand(id),
			signal,
			failure: "fetch-failed",
			what: "fetches the recording",
			budgetMs: FETCH_BUDGET_MS,
		});
		if (fetched === undefined) return;
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
			await this.#rmSafe(localPath);
			return;
		}

		await this.#cleanupRemote(id);
		if (signal.aborted) return;

		this.#setPhase("transcribing");
		try {
			await this.#deliver(localPath, signal);
		} catch (error) {
			if (signal.aborted) return;
			// The path travels with the failure status, so a caller can tell the user
			// where the audio is without a field whose lifetime is an ordering
			// contract.
			this.#fail("deliver-failed", `handling the recording failed: ${(error as Error).message}`, localPath);
			return;
		}
		if (signal.aborted) return;

		if (this.#config.keepAudio) this.#finishCycle(localPath);
		else {
			await this.#rmSafe(localPath);
			this.#finishCycle();
		}
	}

	/**
	 * Abort whatever is in flight and leave nothing behind on either side.
	 * This is the one path allowed to issue `-q` for a recording the extension
	 * may not own, because the user asked for it explicitly.
	 *
	 * Per phase: starting/recording/stopping → best-effort `-q` + remote
	 * cleanup, never fetch; fetching → drop the partial local file and the
	 * remote original; transcribing → drop the local copy unless keepAudio.
	 * Idempotent while running, a no-op when already idle. While it runs,
	 * start() and stop() are refused: the cancel owns the phone until its
	 * cleanup has landed.
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
				if (!this.#config.keepAudio) await this.#rmSafe(localPath);
				break;
			case "fetching":
				await this.#rmSafe(localPath);
				await this.#cleanupRemote(id);
				break;
			case "transcribing":
				if (!this.#config.keepAudio) await this.#rmSafe(localPath);
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
		if (!outcome.ok) {
			abort.abort();
			return undefined;
		}
		return outcome.value.ok ? outcome.value.result : undefined;
	}

	/**
	 * A run that never rejects: the result and the thrown cause are both
	 * returned, so the caller can say *why* the command did not run (a missing
	 * `ssh`, a DNS failure, a spawn `ENOENT`) instead of collapsing every cause
	 * into "did not run".
	 */
	async #runSafe(command: string, signal: AbortSignal): Promise<RunOutcome> {
		try {
			return { ok: true, result: await this.#run(command, signal) };
		} catch (error) {
			return { ok: false, error };
		}
	}

	/**
	 * Await one command stage under the guards every stage shares: a cancel wins
	 * over the result, and a thrown runner becomes `failure`, naming the cause.
	 * Returns `undefined` when the caller must stop — the cancel landed, or the
	 * failure was reported here — and the run's result otherwise.
	 *
	 * This is the single place the "cancel owns the outcome" rule is applied to a
	 * command, so a new stage cannot forget the check.
	 */
	async #runStage(args: {
		command: string;
		signal: AbortSignal;
		failure: RecorderFailure;
		/** Completes "the ssh command that …" in the did-not-run message. */
		what: string;
		/** When set, the command is killed after this long and reported as a
		 * timeout. The fetch is the only stage that can wait on a slow network. */
		budgetMs?: number;
	}): Promise<RunResult | undefined> {
		// A budgeted stage gets its own controller, so a timeout can kill the
		// command without aborting the cycle the way a cancel does; the cycle
		// signal is forwarded, so a cancel still ends it. An abort listener added
		// after the signal is already aborted never fires, so forward that case by
		// hand rather than leaving the child running until the budget expires.
		const abort = args.budgetMs === undefined ? undefined : new AbortController();
		const onCycleAbort = () => abort?.abort();
		if (abort) {
			args.signal.addEventListener("abort", onCycleAbort, { once: true });
			if (args.signal.aborted) abort.abort();
		}

		let outcome: RunOutcome | undefined;
		try {
			const run = this.#runSafe(args.command, abort?.signal ?? args.signal);
			if (args.budgetMs === undefined) outcome = await run;
			else {
				const settled = await this.#settleWithin(run, args.budgetMs);
				outcome = settled.ok ? settled.value : undefined;
			}
		} finally {
			if (abort) args.signal.removeEventListener("abort", onCycleAbort);
		}

		if (args.signal.aborted) return undefined;
		if (outcome === undefined) {
			abort?.abort();
			this.#fail(args.failure, `the ssh command that ${args.what} timed out after ${args.budgetMs} ms`);
			return undefined;
		}
		if (!outcome.ok) {
			this.#fail(
				args.failure,
				`the ssh command that ${args.what} did not run: ${firstLine(describeError(outcome.error))}`,
			);
			return undefined;
		}
		return outcome.result;
	}

	/**
	 * Best-effort local delete. A failed unlink (a read-only tmpdir, a path that
	 * is not a file) must never wedge the cycle in a non-idle phase: the
	 * recording is left behind rather than the machine never finishing, which is
	 * how the remote cleanup already behaves.
	 */
	async #rmSafe(path: string | undefined): Promise<void> {
		if (!path) return;
		try {
			await rm(path, { force: true });
		} catch {
			// Intentionally ignored; see above.
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

	/** `keptPath`, when given, rides on this one emitted status — set before
	 * `#fail` so an error carries it, and on `#finishCycle` so the idle notice
	 * can name the audio — rather than living in a field whose value is only
	 * meaningful between two adjacent statements. */
	#fail(failure: RecorderFailure, message: string, keptPath?: string): void {
		this.#failure = failure;
		this.#message = message;
		this.#setPhase("error", keptPath);
	}

	#setPhase(phase: VoicePhase, keptPath?: string): void {
		this.#phase = phase;
		if (phase !== "error") {
			this.#failure = undefined;
			this.#message = undefined;
		}
		this.#emit(keptPath);
	}

	#emit(keptPath?: string): void {
		this.#status(this.#snapshot(keptPath));
	}

	#snapshot(keptPath?: string): RecorderStatus {
		const status: RecorderStatus = { phase: this.#phase };
		if (this.#phase === "recording") status.elapsedSeconds = Math.max(0, this.#lastTickSecond);
		if (this.#failure) status.failure = this.#failure;
		if (this.#message) status.message = this.#message;
		if (keptPath) status.localPath = keptPath;
		return status;
	}

	#finishCycle(keptPath?: string): void {
		this.#clearCycle();
		this.#setPhase("idle", keptPath);
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
