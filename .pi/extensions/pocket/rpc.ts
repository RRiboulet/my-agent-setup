// pocket — the RPC client for one pi child process
//
// Each durable session is one `pi --mode rpc` child. This module is the only
// place that speaks its protocol, and the framing detail in it is the one the
// pi docs call out explicitly: records are separated by LF and NOTHING else.
// Node's `readline` also splits on U+2028 and U+2029, which are legal inside a
// JSON string, so a transcript containing one would be torn into two invalid
// records. `splitFrames` below therefore splits on "\n" only.
//
// The child is a normal subprocess: the daemon owns its stdin and stdout, and
// everything durable lives in pi's own session file (see supervisor.ts), so a
// child can be killed and respawned without losing the conversation.

import { spawn, type ChildProcess } from "node:child_process";
import { spawnArgs } from "./spawn-args.ts";

export type RpcCommand = { type: string; id?: string } & Record<string, unknown>;

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export type RpcEvent = { type: string } & Record<string, unknown>;

export interface ExtensionUiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: string;
	[key: string]: unknown;
}

export type ExtensionUiReply =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true };

export interface PiRpcOptions {
	piBin: string;
	cwd: string;
	sessionDir: string;
	/** Stable id for the conversation; pi names its session file after it. */
	sessionId: string;
	/** Resume an existing session file. Omit to start a new conversation. */
	sessionPath?: string | undefined;
	/** Model pattern as the CLI takes it: "provider/id" or ":<thinking>". */
	model?: string | undefined;
	thinkingLevel?: string | undefined;
	requestTimeoutMs?: number;
	onStderr?: (line: string) => void;
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout | undefined;
}

let nextSequence = 0;

/**
 * Split a byte-for-byte accumulated stream on LF, tolerating CRLF.
 *
 * Exported for the tests because this is the one place a subtle protocol bug
 * could hide: a client that also split on U+2028 would mis-frame perfectly valid
 * records, and only when a transcript happened to contain one.
 */
export function splitFrames(chunk: string, carry: string): { frames: string[]; carry: string } {
	const buffer = carry + chunk;
	const frames: string[] = [];
	let start = 0;
	for (;;) {
		const index = buffer.indexOf("\n", start);
		if (index < 0) break;
		const line = buffer.slice(start, index);
		// A blank line is not a frame: the child emits these on start-up, and
		// every consumer of this function would otherwise re-implement the same
		// "skip whitespace" check before parsing.
		if (line.trim() !== "") frames.push(line.endsWith("\r") ? line.slice(0, -1) : line);
		start = index + 1;
	}
	return { frames, carry: buffer.slice(start) };
}

export class PiRpcProcess {
	private readonly child: ChildProcess;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: RpcEvent) => void>();
	private readonly uiListeners = new Set<(request: ExtensionUiRequest) => void>();
	private readonly options: Required<Pick<PiRpcOptions, "requestTimeoutMs">> & PiRpcOptions;
	private carry = "";
	private sequence = 0;
	private stderrTail: string[] = [];
	private exitInfo: { code: number | null; signal: NodeJS.Signals | null; error?: string } | undefined;
	private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>;

	constructor(options: PiRpcOptions) {
		this.options = { requestTimeoutMs: 120_000, ...options };
		// The argument list lives in spawn-args.ts so the unit tests can pin it
		// without spawning anything: the flags are the contract with pi, and a
		// typo in one is a child that dies instantly with no session file.
		const args = spawnArgs({
			sessionId: options.sessionId,
			sessionDir: options.sessionDir,
			sessionFile: options.sessionPath,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
		});

		const child = spawn(options.piBin, args, {
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// The daemon is detached from its own TUI; the child must not become
			// a session leader of one, or a phone-mandated restart of the TUI
			// would take the agents down with it.
			detached: false,
		});
		this.child = child;

		this.exitPromise = new Promise((resolve) => {
			let settled = false;
			const settle = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
				if (settled) return;
				settled = true;
				this.exitInfo = { code, signal, error };
				// Every unanswered request fails here: a caller waiting on an
				// aborted child must not hang until its own timeout.
				for (const [, request] of this.pending) {
					if (request.timeout) clearTimeout(request.timeout);
					request.reject(
						new Error(
							`pi rpc process exited before answering (code ${code}, signal ${signal ?? "none"}${error ? `, ${error}` : ""}); stderr: ${this.stderrTail.join(" | ")}`,
						),
					);
				}
				this.pending.clear();
				resolve({ code, signal, error });
			};
			child.on("exit", (code, signal) => settle(code, signal));
			child.on("error", (error) => {
				// A child that could not be spawned at all — a pi path that does not
				// exist, a binary the loader refuses — emits 'error' and never
				// 'exit'. Settling here is what turns that into a respawn instead of
				// a session that hangs on its first request forever.
				this.stderrTail.push(`spawn error: ${error.message}`);
				settle(null, null, error.message);
			});
		});

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));

		// A binary that exits before reading stdin — a child killed while we were
		// mid-write — makes the pipe emit EPIPE. Each write's callback rejects the
		// request it belongs to; without a listener here the same error also reaches
		// the stream as an unhandled 'error' event, which takes the whole daemon
		// with it.
		child.stdin?.on("error", (error: Error) => this.stderrTail.push(`stdin: ${error.message}`));

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			// Keep a short tail for error messages, forward the rest: a child's
			// diagnostics are the only clue when a session will not start.
			this.stderrTail.push(chunk.trim());
			if (this.stderrTail.length > 10) this.stderrTail.shift();
			this.options.onStderr?.(chunk);
		});
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get running(): boolean {
		return this.exitInfo === undefined;
	}

	waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }> {
		return this.exitPromise;
	}

	private handleStdout(chunk: string): void {
		const { frames, carry } = splitFrames(chunk, this.carry);
		this.carry = carry;
		for (const frame of frames) {
			let record: unknown;
			try {
				record = JSON.parse(frame);
			} catch {
				// Malformed records are diagnostics, not protocol: the docs put
				// them on stdout only as parse errors, and there is nothing to
				// correlate them with, so they are reported and dropped.
				this.options.onStderr?.(`unparsable rpc record: ${frame.slice(0, 200)}\n`);
				continue;
			}
			this.handleRecord(record as RpcResponse & RpcEvent & ExtensionUiRequest);
		}
	}

	private handleRecord(record: RpcResponse & RpcEvent & ExtensionUiRequest): void {
		if (record.type === "response") {
			const pending = record.id ? this.pending.get(record.id) : undefined;
			if (!pending) return; // response to a fire-and-forget command
			this.pending.delete(record.id as string);
			if (pending.timeout) clearTimeout(pending.timeout);
			if (record.success) pending.resolve(record.data);
			else pending.reject(new Error(record.error ?? `rpc command ${record.command} failed`));
			return;
		}
		if (record.type === "extension_ui_request") {
			for (const listener of [...this.uiListeners]) listener(record);
			return;
		}
		for (const listener of [...this.listeners]) listener(record);
	}

	/** Every session event, in order, as it arrives. */
	subscribe(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Extension dialogs the child raised, so a phone can answer them. */
	onExtensionUi(listener: (request: ExtensionUiRequest) => void): () => void {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	}

	/** Fire-and-forget: no id, no waiting, no rejection if the child is gone. */
	send(command: RpcCommand): void {
		if (this.exitInfo !== undefined) return;
		this.child.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/**
	 * Send a command and wait for its response.
	 *
	 * The id is ours, not the caller's: several sources (the HTTP handler for a
	 * phone request, the supervisor's own bookkeeping) share one child, and a
	 * caller-supplied id is a collision waiting to happen.
	 */
	request<T = unknown>(command: RpcCommand): Promise<T> {
		if (this.exitInfo !== undefined) {
			return Promise.reject(new Error(`pi rpc process is not running (code ${this.exitInfo.code})`));
		}
		const id = `pocket-${++this.sequence}-${nextSequence++}`;
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`rpc command ${command.type} timed out after ${this.options.requestTimeoutMs}ms`));
			}, this.options.requestTimeoutMs);
			this.pending.set(id, {
				resolve: resolve as (data: unknown) => void,
				reject,
				timeout,
			});
			this.child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	/** Answer an extension dialog raised by the child. */
	respondExtensionUi(id: string, reply: ExtensionUiReply): void {
		this.send({ type: "extension_ui_response", id, ...reply });
	}

	/** Convenience wrappers over the commands the gateway exposes. */
	getState(): Promise<Record<string, any>> {
		return this.request<Record<string, any>>({ type: "get_state" });
	}

	getMessages(): Promise<Array<Record<string, any>>> {
		return this.request<{ messages: Array<Record<string, any>> }>({ type: "get_messages" }).then((data) => data.messages ?? []);
	}

	/** Close stdin, then SIGTERM after the grace period if it will not leave. */
	async stop(graceMs = 3000): Promise<void> {
		if (this.exitInfo !== undefined) return;
		this.child.stdin?.end();
		const exited = await Promise.race([
			this.exitPromise.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
		]);
		if (!exited) this.child.kill("SIGTERM");
	}
}
