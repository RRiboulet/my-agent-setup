// Vendored from https://github.com/mitsuhiko/agent-stuff (extensions/subagent.ts)
// Upstream: mitsupi v1.6.0, commit 0865c84.
//
// Local patches on top of upstream:
//  1. Non-blocking / concurrent: the `subagent` tool launches a child Pi process
//     in its own detached tmux session and returns immediately instead of
//     awaiting completion. Runs are no longer serialized. A bounded number of
//     children run concurrently (PI_SUBAGENT_MAX_CONCURRENT, default 4); excess
//     requests are queued and started automatically as slots free up.
//  2. Background completion watcher: a per-run timer polls the child's atomic
//     `result.json` and pane output, persists run state, and (optionally) pushes
//     a follow-up custom message into the main session so the main agent learns
//     that a subagent finished without ever having been blocked by it.
//  3. Status tooling: `subagent_status` (list/inspect runs), `subagent_cancel`
//     (kill a run), and `subagent_wait` (explicitly block until selected runs
//     finish) let the main agent collect results on demand.
//  4. OpenRouter default: the child provider defaults to OpenRouter (with parent
//     inheritance and explicit overrides preserved), so children work in the
//     same provider setup as the parent session. Model defaults to the parent model id.
//  5. Run state is persisted under <agentDir>/tmux-subagents/<session-id>/
//     runs.json and incomplete runs are resumed after a reload.
//  6. Lifecycle: finished runs auto-reap their tmux sessions
//     (PI_SUBAGENT_AUTO_REAP, default true; PI_SUBAGENT_REAP_DELAY_MS), old run
//     directories are garbage-collected (PI_SUBAGENT_GC_DAYS, default 7), and
//     `subagent_clean` reaps/deletes finished artifacts on demand.
//  7. Cost/usage: child session JSONL is parsed to report tokens, turns, and
//     cost per run in `subagent_status`, notifications, and the dashboard.
//  8. `/subagents` dashboard: live overlay listing runs with pane/output
//     preview, cancel, and attach-command copy.
//  9. Testability: a `__test__` export block at the end of this file exposes
//     the module-private helpers so test/*.test.ts can cover them. It is not
//     used by the extension at runtime, but it IS load-bearing for the test
//     suite -- do not drop it when re-vendoring. test/export.test.ts asserts
//     it is still present.
// 10. Shutdown stops the watcher: a `shuttingDown` flag in the factory closure
//     is set by `session_shutdown` and checked both at `watchTick` entry and
//     just before it re-arms its 500ms timer (plus in `scheduleWatch` and
//     `scheduleReap`). Without it, a tick already in flight when shutdown
//     cleared the timer map re-armed a timer that nothing would ever clear, so
//     the parent kept polling tmux via `pi.exec` after shutdown and kept the
//     event loop alive (which is why the tests used to need
//     `--test-force-exit`). The flag is per factory invocation, so it is false
//     again on the next extension load; `loadPersistedRuns` still re-arms
//     watchers for `running` runs.
// 11. Liveness: the child writes a throttled activity snapshot to
//     `<runDir>/activity.json` (see activity.ts) and the watcher reads it on
//     every tick, so `subagent_status` can report a live phase
//     (starting/active/waiting/done) with the current scope and tool. The
//     snapshot path is derived from the result path the child already receives,
//     so no extra environment variable is needed. It is diagnostic only:
//     completion, cancellation and failure never depend on it.
//
// The child reporter (CHILD_ENV) still reports completion the same way; patch 11
// only adds the activity snapshot to it.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createActivityRecorder,
	getActivityFilePath,
	readActivityFile,
	type SubagentActivityPhase,
	type SubagentActivityScope,
} from "./activity.ts";
import { formatUsage, readSessionUsage, type RunUsage } from "./usage.ts";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
const RUNS_DIR = "tmux-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MAX_CONCURRENT = 4;
const GC_DAYS = 7;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const RESULT_MESSAGE_TYPE = "subagent-result";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface ChildResult {
	version: 1;
	status: "completed" | "failed";
	output: string;
	error?: string;
	stopReason?: string;
	sessionFile?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	finishedAt: number;
}

interface RunActivity {
	phase: SubagentActivityPhase;
	scope?: SubagentActivityScope;
	toolName?: string;
	sequence: number;
	updatedAt: number;
}

interface RunRecord {
	id: string;
	task: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	tmuxSession: string;
	tmuxTarget: string;
	attachCommand: string;
	captureCommand: string;
	killCommand: string;
	runDir: string;
	resultPath: string;
	trusted: boolean;
	status: RunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	pane?: string;
	output?: string;
	error?: string;
	sessionFile?: string;
	usage?: RunUsage;
	/** Latest child activity snapshot, reduced to what the parent needs. */
	activity?: RunActivity;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function readIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	return !/^(0|false|no|off)$/i.test(raw);
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function tmuxSocketPath(): string {
	return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
	return `pi-agent-${sessionId}`;
}

function currentTmuxSocket(): string | undefined {
	const socket = process.env.TMUX?.split(",", 1)[0]?.trim();
	return socket || undefined;
}

function attachFlagValue(argv: string[]): string | undefined {
	const flag = `--${ATTACH_FLAG}`;
	for (let index = 2; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") break;
		if (argument === flag) {
			const value = argv[index + 1];
			return !value || value.startsWith("--") ? "" : value;
		}
		if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
	}
	return undefined;
}

function tmuxCommandPrefix(): string {
	return `tmux -S ${shellQuote(tmuxSocketPath())}`;
}

function tmuxArgs(...args: string[]): string[] {
	return ["-S", tmuxSocketPath(), ...args];
}

function updateTmuxCommands(run: RunRecord): void {
	const tmux = tmuxCommandPrefix();
	run.attachCommand = `pi --${ATTACH_FLAG} ${shellQuote(run.id)}`;
	run.captureCommand = `${tmux} capture-pane -p -J -t ${shellQuote(run.tmuxTarget)}`;
	run.killCommand = `${tmux} kill-session -t ${shellQuote(run.tmuxSession)}`;
}

function attachToSubagentAndExit(rawTarget: string): never {
	const target = rawTarget.trim();
	if (!target) {
		console.error(`Error: --${ATTACH_FLAG} requires the session id printed by the subagent tool.`);
		process.exit(2);
	}

	let socket = tmuxSocketPath();
	let session: string;
	if (target.startsWith("v1.")) {
		// Keep attachment working for sessions started before session-id targets.
		try {
			const legacy = JSON.parse(Buffer.from(target.slice(3), "base64url").toString("utf8")) as {
				s?: unknown;
				p?: unknown;
			};
			if (typeof legacy.s !== "string" || !legacy.s || typeof legacy.p !== "string" || !legacy.p) {
				throw new Error("missing tmux session or socket");
			}
			session = legacy.s;
			socket = legacy.p;
		} catch (error) {
			console.error(`Error: invalid legacy subagent target: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(2);
		}
	} else {
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target)) {
			console.error(`Error: invalid subagent session id: ${target}`);
			process.exit(2);
		}
		session = tmuxSessionName(target);
	}

	const sameServer = currentTmuxSocket() === socket;
	const args = ["-S", socket, sameServer ? "switch-client" : "attach-session", "-t", session];
	const env = { ...process.env };
	if (!sameServer) {
		delete env.TMUX;
		delete env.TMUX_PANE;
	}
	const result = spawnSync("tmux", args, { stdio: "inherit", env });
	if (result.error) console.error(`Failed to run tmux: ${result.error.message}`);
	process.exit(result.status ?? 1);
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return [process.execPath];
	}

	return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistant(ctx: ExtensionContext): Record<string, unknown> | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown>;
		if (message.role === "assistant") return message;
	}
	return undefined;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string, runId: string): void {
	let reported = false;

	// Liveness snapshot (local patch 11). The path is derived from the result
	// path the child was already given, so nothing new crosses the environment
	// boundary. A recorder failure must never affect the run, so every handler
	// only awaits the recorder and swallows its errors.
	const recorder = createActivityRecorder({
		filePath: getActivityFilePath(path.dirname(resultPath)),
		childId: runId,
		write: writeJsonAtomic,
		onError: (error) => {
			console.error(`[tmux-subagent] activity write failed: ${error instanceof Error ? error.message : String(error)}`);
		},
	});

	const report = async (ctx: ExtensionContext, fallbackError?: string): Promise<void> => {
		if (reported) return;
		reported = true;

		const assistant = findLastAssistant(ctx);
		const stopReason = typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
		const assistantError = typeof assistant?.errorMessage === "string" ? assistant.errorMessage : undefined;
		const failed = !assistant || stopReason === "error" || stopReason === "aborted" || Boolean(fallbackError);
		const output = assistant ? textFromAssistant(assistant) : "";
		const result: ChildResult = {
			version: 1,
			status: failed ? "failed" : "completed",
			output,
			error: fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
		};

		try {
			await writeJsonAtomic(resultPath, result);
		} catch (error) {
			console.error(`[tmux-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	pi.on("session_start", () => recorder.sessionStart());
	pi.on("input", () => recorder.input());
	pi.on("before_provider_request", () => recorder.providerRequest());
	pi.on("after_provider_response", () => recorder.providerResponse());
	pi.on("message_update", () => recorder.messageUpdate());
	pi.on("tool_execution_start", (event) => recorder.toolStart(event.toolName));
	pi.on("tool_execution_update", (event) => recorder.toolUpdate(event.toolName));
	pi.on("tool_execution_end", (event) => recorder.toolEnd(event.toolName));

	// agent_settled was added after older peer type declarations but is present
	// in the Pi runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		// Flush the terminal snapshot first: the parent treats result.json as the
		// completion signal, so the "done" phase must be on disk before it lands.
		await recorder.settled().catch(() => undefined);
		await report(ctx);
		ctx.shutdown();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!reported) await recorder.shutdown().catch(() => undefined);
		if (!reported) await report(ctx, "Subagent session shut down before the task settled.");
	});
}

function trimPane(output: string): string {
	const lines = output.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
	while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
	return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(startedAt: number | undefined, finishedAt = Date.now()): string | undefined {
	if (startedAt === undefined) return undefined;
	const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function truncateToolText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function isTerminal(status: RunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent wait aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent wait aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function validateCwd(cwd: string): Promise<void> {
	let info;
	try {
		info = await stat(cwd);
	} catch {
		throw new Error(`Subagent working directory does not exist: ${cwd}`);
	}
	if (!info.isDirectory()) throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
	const relative = path.relative(base, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveModel(
	ctx: ExtensionContext,
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): { provider: string; model: string } {
	const envProvider = process.env.PI_SUBAGENT_PROVIDER?.trim();
	const envModel = process.env.PI_SUBAGENT_MODEL?.trim();
	const explicitProvider = providerOverride?.trim() || envProvider;
	const explicitModel = modelOverride?.trim() || envModel;

	let provider = explicitProvider || ctx.model?.provider || DEFAULT_PROVIDER;
	let model = explicitModel || ctx.model?.id || process.env.PI_MODEL?.trim() || "";

	// Accept the canonical `openrouter/<id>` form for explicit overrides, but
	// never split inherited model ids whose slash belongs to the id itself
	// (OpenRouter's `deepseek/...`, `openai/...` style ids).
	const openRouterPrefix = `${DEFAULT_PROVIDER}/`;
	if (explicitModel && !explicitProvider && explicitModel.startsWith(openRouterPrefix)) {
		provider = DEFAULT_PROVIDER;
		model = explicitModel.slice(openRouterPrefix.length);
	} else if (explicitModel && explicitProvider === DEFAULT_PROVIDER && model.startsWith(openRouterPrefix)) {
		model = model.slice(openRouterPrefix.length);
	}

	if (!provider) provider = DEFAULT_PROVIDER;
	if (!model) throw new Error("No model is active. Pass both provider and model to the subagent tool.");
	return { provider, model };
}

function formatActivity(activity: RunActivity | undefined): string | undefined {
	if (!activity) return undefined;
	const parts = [activity.phase];
	if (activity.scope) parts.push(activity.scope);
	if (activity.toolName) parts.push(`(${activity.toolName})`);
	return parts.join(" ");
}

function runSummary(run: RunRecord, options: { pane?: boolean; output?: boolean } = {}): string {
	const duration = formatDuration(run.startedAt, run.finishedAt);
	const usage = formatUsage(run.usage);
	// Activity describes what the child is doing right now, so it is only
	// meaningful while the run is live; a settled run has its own status.
	const activity = isTerminal(run.status) ? undefined : formatActivity(run.activity);
	const lines = [
		`${run.id}  ${run.status}${duration ? ` · ${duration}` : ""}${usage ? ` · ${usage}` : ""}`,
		`  task: ${run.task.split("\n", 1)[0]?.slice(0, 100) ?? run.task}`,
		`  model: ${run.provider}/${run.model} (${run.thinking})`,
	];
	if (activity) lines.push(`  activity: ${activity}`);
	lines.push(`  tmux: ${run.tmuxSession}`, `  attach: ${run.attachCommand}`);
	if (run.sessionFile) lines.push(`  child session: ${run.sessionFile}`);
	if (options.pane && run.pane) lines.push("", run.pane);
	if (options.output && run.output) lines.push("", run.output);
	if (run.error && !(options.output && run.output?.includes(run.error))) lines.push("", `Error: ${run.error}`);
	return lines.join("\n");
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ATTACH_FLAG, {
		description: "Attach using the child session id printed by the subagent tool",
		type: "string",
	});
	const attachTarget = attachFlagValue(process.argv);
	if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

	if (process.env[CHILD_ENV] === "1") {
		const resultPath = process.env[RESULT_ENV];
		if (!resultPath) {
			console.error(`[tmux-subagent] ${RESULT_ENV} is required in child mode.`);
			return;
		}
		// The run id is the run directory name: <agentDir>/tmux-subagents/<session>/<run>/result.json.
		registerChildReporter(pi, resultPath, path.basename(path.dirname(resultPath)));
		return;
	}

	const maxConcurrent = readIntEnv("PI_SUBAGENT_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
	const notifyOnCompletion = readBooleanEnv("PI_SUBAGENT_NOTIFY", true);
	const killOnShutdown = readBooleanEnv("PI_SUBAGENT_KILL_ON_SHUTDOWN", false);
	const autoReap = readBooleanEnv("PI_SUBAGENT_AUTO_REAP", true);
	const reapDelayMs = readNonNegativeIntEnv("PI_SUBAGENT_REAP_DELAY_MS", 0);
	const gcDays = readNonNegativeIntEnv("PI_SUBAGENT_GC_DAYS", GC_DAYS);

	const runs = new Map<string, RunRecord>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// The last activity string written to runs.json, so a chatty child does not
	// rewrite the index when nothing visible changed.
	const activitySignatures = new Map<string, string>();
	const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Set by session_shutdown. The watcher deletes its own timer from the map at
	// the start of a tick and re-arms one at the end, so a tick already in flight
	// when shutdown clears the map would otherwise re-arm a timer nothing will
	// ever clear again. The flag lives in the factory closure, so it starts false
	// again for every fresh extension load.
	let shuttingDown = false;
	let sessionId = "";
	let sessionRunsDir = "";
	let runsIndexPath = "";
	let persistChain: Promise<void> = Promise.resolve();

	const persist = (): Promise<void> => {
		if (!runsIndexPath) return Promise.resolve();
		const snapshot = `${JSON.stringify([...runs.values()], null, 2)}\n`;
		persistChain = persistChain
			.then(() => writeFile(runsIndexPath, snapshot, { encoding: "utf8", mode: 0o600 }))
			.catch((error) => {
				console.error(`[tmux-subagent] Failed to persist runs: ${error instanceof Error ? error.message : String(error)}`);
			});
		return persistChain;
	};

	const activeCount = (): number => {
		let count = 0;
		for (const run of runs.values()) {
			if (run.status === "running") count++;
		}
		return count;
	};

	const clearTimer = (runId: string): void => {
		const timer = timers.get(runId);
		if (timer) clearTimeout(timer);
		timers.delete(runId);
	};

	const killTmuxSession = async (run: RunRecord): Promise<void> => {
		await pi.exec("tmux", tmuxArgs("kill-session", "-t", run.tmuxSession)).catch(() => undefined);
	};

	const reapSession = async (run: RunRecord): Promise<void> => {
		reapTimers.delete(run.id);
		if (!autoReap) return;
		if (run.status === "running" || run.status === "queued") return;
		await killTmuxSession(run);
	};

	const scheduleReap = (run: RunRecord): void => {
		if (!autoReap || shuttingDown) return;
		const existing = reapTimers.get(run.id);
		if (existing) clearTimeout(existing);
		if (reapDelayMs <= 0) {
			void reapSession(run);
			return;
		}
		const timer = setTimeout(() => {
			void reapSession(run);
		}, reapDelayMs);
		reapTimers.set(run.id, timer);
	};

	const notifyCompletion = async (run: RunRecord): Promise<void> => {
		if (!notifyOnCompletion) return;
		const label = run.status === "completed" ? "finished" : run.status;
		const usage = formatUsage(run.usage);
		const text = [
			`Subagent ${run.id} ${label}.`,
			`Task: ${run.task.split("\n", 1)[0]?.slice(0, 140) ?? run.task}`,
			`Status: ${run.status}${usage ? ` · ${usage}` : ""}${run.error ? ` — ${run.error}` : ""}`,
			`Inspect the result with subagent_status (id ${run.id}).`,
		].join("\n");
		try {
			await pi.sendMessage(
				{
					customType: RESULT_MESSAGE_TYPE,
					content: text,
					display: true,
					details: { id: run.id, status: run.status, error: run.error },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			// The session may be shutting down; state is still on disk.
			console.error(`[tmux-subagent] Failed to notify about ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const finalizeRun = async (run: RunRecord, result: ChildResult): Promise<void> => {
		run.status = result.status === "completed" ? "completed" : "failed";
		run.finishedAt = result.finishedAt || Date.now();
		run.sessionFile = result.sessionFile;
		run.provider = result.provider ?? run.provider;
		run.model = result.model ?? run.model;
		run.thinking = result.thinking ?? run.thinking;
		let output = result.output.trim();
		if (result.status === "failed" && result.error?.trim()) {
			output += `${output ? "\n\n" : ""}Error: ${result.error.trim()}`;
			run.error = result.error.trim();
		}
		run.output = truncateToolText(output || "(no text output)");
		run.usage = (await readSessionUsage(run.sessionFile)) ?? run.usage;
		await persist();
		await notifyCompletion(run);
		scheduleReap(run);
		void drainQueue();
	};

	const markRunFailed = async (run: RunRecord, message: string): Promise<void> => {
		clearTimer(run.id);
		run.status = "failed";
		run.error = message;
		run.finishedAt = Date.now();
		await persist();
		await notifyCompletion(run);
		scheduleReap(run);
	};

	const readChildResult = async (run: RunRecord): Promise<ChildResult | undefined> => {
		try {
			return JSON.parse(await readFile(run.resultPath, "utf8")) as ChildResult;
		} catch {
			return undefined;
		}
	};

	const watchTick = async (run: RunRecord): Promise<void> => {
		timers.delete(run.id);
		if (shuttingDown) return;
		if (isTerminal(run.status)) return;

		try {
			const result = await readChildResult(run);
			if (result) {
				await finalizeRun(run, result);
				return;
			}

			// Liveness (local patch 11): the child's activity snapshot is advisory.
			// A missing, malformed or mismatched file simply means "not observed".
			const activity = await readActivityFile(getActivityFilePath(run.runDir), run.id);
			if (activity.ok) {
				const observed = activity.activity;
				// Never regress: a stale snapshot from an earlier write, or one
				// that survived a reload, must not overwrite newer state.
				if (observed.sequence > (run.activity?.sequence ?? -1)) {
					run.activity = {
						phase: observed.phase,
						scope: observed.activeScope,
						toolName: observed.toolName,
						sequence: observed.sequence,
						updatedAt: observed.updatedAt,
					};
					// Persist only what the summary actually renders, so a chatty
					// child does not rewrite runs.json twice a second.
					const signature = formatActivity(run.activity) ?? "";
					if (signature !== activitySignatures.get(run.id)) {
						activitySignatures.set(run.id, signature);
						await persist();
					}
				}
			}

			const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", run.tmuxTarget), {
				timeout: 5_000,
			});
			if (paneResult.code === 0) {
				const pane = trimPane(paneResult.stdout);
				if (pane && pane !== run.pane) {
					run.pane = pane;
					await persist();
				}
			}

			const dead = await pi.exec("tmux", tmuxArgs("display-message", "-p", "-t", run.tmuxTarget, "#{pane_dead}"));
			if (dead.code === 0 && dead.stdout.trim() === "1") {
				await abortableDelay(100, undefined);
				const late = await readChildResult(run);
				if (late) {
					await finalizeRun(run, late);
					return;
				}
				const reason = run.pane
					? `Child Pi exited before reporting a result.\n\n${run.pane}\n\nInspect: ${run.captureCommand}`
					: `Child Pi exited before reporting a result. Inspect: ${run.captureCommand}`;
				await markRunFailed(run, reason);
				void drainQueue();
				return;
			}
		} catch (error) {
			// Transient tmux/exec errors are retried; only unexpected ones surface.
			if (isTerminal(run.status)) return;
			console.error(`[tmux-subagent] watch error for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (shuttingDown) return;
		const timer = setTimeout(() => {
			void watchTick(run);
		}, POLL_INTERVAL_MS);
		timers.set(run.id, timer);
	};

	const scheduleWatch = (run: RunRecord): void => {
		if (shuttingDown || timers.has(run.id)) return;
		const timer = setTimeout(() => {
			void watchTick(run);
		}, POLL_INTERVAL_MS);
		timers.set(run.id, timer);
	};

	const launchRun = async (run: RunRecord): Promise<void> => {
		try {
			const tmuxVersion = await pi.exec("tmux", ["-V"], { timeout: 5_000 });
			if (tmuxVersion.code !== 0) {
				throw new Error(`tmux is required for subagents: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
			}

			const created = await pi.exec("tmux", tmuxArgs("new-session", "-d", "-s", run.tmuxSession, "-n", "pi", "-c", run.cwd));
			if (created.code !== 0) {
				throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
			}

			const remain = await pi.exec(
				"tmux",
				tmuxArgs("set-window-option", "-t", `${run.tmuxSession}:0`, "remain-on-exit", "on"),
			);
			if (remain.code !== 0) throw new Error(remain.stderr.trim() || "Failed to set remain-on-exit.");

			const promptPath = path.join(run.runDir, "task.md");
			const sessionDir = path.join(run.runDir, "session");
			const piArgs = [
				...getPiInvocationParts(),
				"--provider",
				run.provider,
				"--model",
				run.model,
				"--thinking",
				run.thinking,
				"--session-dir",
				sessionDir,
				"--session-id",
				run.id,
				"--name",
				run.tmuxSession,
				run.trusted ? "--approve" : "--no-approve",
				"--extension",
				EXTENSION_PATH,
				`@${promptPath}`,
			];
			const childCommand = [
				"exec env",
				`${CHILD_ENV}=1`,
				`${RESULT_ENV}=${shellQuote(run.resultPath)}`,
				piArgs.map(shellQuote).join(" "),
			].join(" ");

			const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "-l", "--", childCommand));
			if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi.");
			const entered = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "Enter"));
			if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child command.");

			run.status = "running";
			run.startedAt = Date.now();
			await persist();
			scheduleWatch(run);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await pi.exec("tmux", tmuxArgs("kill-session", "-t", run.tmuxSession)).catch(() => undefined);
			await markRunFailed(run, message);
		}
	};

	const drainQueue = async (): Promise<void> => {
		while (activeCount() < maxConcurrent) {
			const next = [...runs.values()].find((run) => run.status === "queued");
			if (!next) return;
			next.status = "running";
			next.startedAt = Date.now();
			await persist();
			await launchRun(next);
		}
	};

	const startRun = async (run: RunRecord): Promise<void> => {
		runs.set(run.id, run);
		await persist();
		await drainQueue();
	};

	const loadPersistedRuns = async (): Promise<void> => {
		if (!runsIndexPath) return;
		let parsed: RunRecord[];
		try {
			parsed = JSON.parse(await readFile(runsIndexPath, "utf8")) as RunRecord[];
		} catch {
			return;
		}
		for (const run of parsed) {
			if (!run?.id) continue;
			updateTmuxCommands(run);
			runs.set(run.id, run);
			if (run.status === "running") scheduleWatch(run);
		}
		await drainQueue();
	};

	const gcRunDirectories = async (): Promise<void> => {
		if (gcDays <= 0) return;
		const root = path.join(getAgentDir(), RUNS_DIR);
		let entries: Dirent[];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			return;
		}
		const cutoff = Date.now() - gcDays * 24 * 60 * 60 * 1000;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === sessionId) continue;
			const dir = path.join(root, entry.name);
			try {
				const info = await stat(dir);
				if (info.mtimeMs < cutoff) await rm(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	};

	const ensureSessionPaths = async (ctx: ExtensionContext): Promise<void> => {
		if (runsIndexPath) return;
		sessionId = ctx.sessionManager.getSessionId();
		sessionRunsDir = path.join(getAgentDir(), RUNS_DIR, sessionId);
		runsIndexPath = path.join(sessionRunsDir, "runs.json");
		await mkdir(sessionRunsDir, { recursive: true, mode: 0o700 });
		await loadPersistedRuns();
		void gcRunDirectories();
	};

	pi.on("session_start", async (_event, ctx) => {
		await ensureSessionPaths(ctx);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		for (const timer of reapTimers.values()) clearTimeout(timer);
		reapTimers.clear();
		for (const run of runs.values()) {
			if (killOnShutdown && (run.status === "running" || run.status === "queued")) {
				run.status = "cancelled";
				run.finishedAt = Date.now();
				await killTmuxSession(run);
				continue;
			}
			if (autoReap && isTerminal(run.status)) await killTmuxSession(run);
		}
		await persist();
	});

	pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as { status?: string } | undefined;
		const icon =
			details?.status === "completed" ? theme.fg("success", "✓") : details?.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "●");
		return new Text(`${icon} ${String(message.content)}`, 0, 0);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Start a delegated task in a separate interactive Pi process inside a detached tmux session and return immediately. The main agent is not blocked and may start more subagents or keep working. Runs execute concurrently (bounded by PI_SUBAGENT_MAX_CONCURRENT, default 4); extra runs are queued. Children inherit the current provider/model/thinking, defaulting the provider to OpenRouter. Use subagent_status to inspect progress and results, subagent_wait to block for completion, and subagent_cancel to stop a run. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
		promptSnippet: "Start a delegated, non-blocking, tmux-backed Pi subagent",
		promptGuidelines: [
			"Use subagent to delegate an isolated task without blocking: it returns immediately, so start several when useful and keep working.",
			"Call subagent_status with the printed id to read a subagent's output; call subagent_wait only when you deliberately need to block until runs finish.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The complete task for the child Pi process" }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current project." })),
			provider: Type.Optional(Type.String({ description: "Provider override. Defaults to the current provider, then OpenRouter." })),
			model: Type.Optional(
				Type.String({ description: "Model id override. Defaults to the current model." }),
			),
			thinking: Type.Optional(
				StringEnum(THINKING_LEVELS, {
					description: "Thinking level override. Defaults to the current thinking level.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.task.trim()) throw new Error("Subagent task must not be empty.");
			if (signal?.aborted) throw new Error("Subagent aborted.");
			await ensureSessionPaths(ctx);

			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			await validateCwd(cwd);

			const selectedModel = resolveModel(ctx, params.provider, params.model);
			const thinking = params.thinking ?? pi.getThinkingLevel();
			const id = randomUUID();
			const runDir = path.join(sessionRunsDir, id);
			const resultPath = path.join(runDir, "result.json");
			const tmuxSession = tmuxSessionName(id);
			const run: RunRecord = {
				id,
				task: params.task,
				cwd,
				provider: selectedModel.provider,
				model: selectedModel.model,
				thinking,
				tmuxSession,
				tmuxTarget: `${tmuxSession}:0.0`,
				attachCommand: "",
				captureCommand: "",
				killCommand: "",
				runDir,
				resultPath,
				trusted: false,
				status: "queued",
				createdAt: Date.now(),
			};
			run.trusted = isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted();
			updateTmuxCommands(run);

			await mkdir(runDir, { recursive: true, mode: 0o700 });
			await mkdir(path.join(runDir, "session"), { recursive: true, mode: 0o700 });
			await writeFile(path.join(runDir, "task.md"), `# Delegated task\n\n${params.task}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});

			await startRun(run);

			const queued = run.status === "queued";
			const text = [
				queued ? `Subagent ${id} queued (${activeCount()}/${maxConcurrent} running).` : `Subagent ${id} started.`,
				`Model: ${run.provider}/${run.model} (${run.thinking})`,
				`tmux: ${run.tmuxSession}`,
				`Attach: ${run.attachCommand}`,
				`Capture: ${run.captureCommand}`,
				`Status: call subagent_status with id ${id}`,
			].join("\n");
			return { content: [{ type: "text", text }], details: run };
		},

		renderCall(args, theme) {
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const run = result.details as RunRecord | undefined;
			if (!run) {
				const content = result.content.find((part) => part.type === "text");
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(run.tmuxSession))}`;
			text += theme.fg("muted", ` · ${run.status}`);
			text += `\n  ${theme.fg("accent", run.attachCommand)}`;
			text += `\n  ${theme.fg("dim", `${run.provider}/${run.model} (${run.thinking})`)}`;
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"List subagent runs started in this session or inspect one by id. Returns status, model, tmux attach command, the child's live activity phase (starting/active/waiting/done) with its current scope and tool while running, latest pane output while running, and the final output once finished. Non-blocking.",
		promptSnippet: "Inspect non-blocking subagent runs and their output",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Run id to inspect. Omit to list all runs in this session." })),
			include_output: Type.Optional(Type.Boolean({ description: "Include full stored output for finished runs. Defaults to false." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const includeOutput = params.include_output ?? false;
			const runsArray = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
			if (params.id) {
				const run = runs.get(params.id.trim());
				if (!run) throw new Error(`Unknown subagent run: ${params.id}`);
				return {
					content: [{ type: "text", text: runSummary(run, { pane: true, output: true }) }],
					details: { runs: [run] },
				};
			}
			if (runsArray.length === 0) {
				return { content: [{ type: "text", text: "No subagent runs in this session." }], details: { runs: [] } };
			}
			const text = runsArray
				.map((run) =>
					runSummary(run, { pane: run.status === "running", output: includeOutput || !isTerminal(run.status) }),
				)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { runs: runsArray } };
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description: "Cancel a subagent run by id: kill its tmux session and mark it cancelled.",
		promptSnippet: "Cancel a running non-blocking subagent",
		parameters: Type.Object({
			id: Type.String({ description: "Run id to cancel." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const id = params.id.trim();
			const run = runs.get(id);
			if (!run) throw new Error(`Unknown subagent run: ${id}`);
			if (isTerminal(run.status)) {
				return { content: [{ type: "text", text: `Subagent ${id} is already ${run.status}.` }], details: run };
			}
			clearTimer(run.id);
			await pi.exec("tmux", tmuxArgs("kill-session", "-t", run.tmuxSession)).catch(() => undefined);
			run.status = "cancelled";
			run.finishedAt = Date.now();
			await persist();
			void drainQueue();
			return { content: [{ type: "text", text: `Subagent ${id} cancelled.` }], details: run };
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent Wait",
		description:
			"Block until the given subagent runs finish (or all incomplete runs when no ids are given), then return their outputs. Use only when you deliberately need to wait; otherwise use subagent_status.",
		promptSnippet: "Block until selected non-blocking subagents finish",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Run ids to wait for. Defaults to all incomplete runs." })),
			timeout_seconds: Type.Optional(Type.Number({ description: "Maximum seconds to wait. Defaults to 1800." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const timeoutMs = (params.timeout_seconds ?? 1800) * 1000;
			const targets = params.ids?.length
				? params.ids.map((id) => {
						const run = runs.get(id.trim());
						if (!run) throw new Error(`Unknown subagent run: ${id}`);
						return run;
					})
				: [...runs.values()].filter((run) => !isTerminal(run.status));
			if (targets.length === 0) {
				return { content: [{ type: "text", text: "No incomplete subagent runs to wait for." }], details: { runs: [] } };
			}

			const deadline = Date.now() + timeoutMs;
			while (targets.some((run) => !isTerminal(run.status))) {
				if (signal?.aborted) throw new Error("Subagent wait aborted.");
				if (Date.now() >= deadline) {
					const pending = targets.filter((run) => !isTerminal(run.status)).map((run) => run.id);
					throw new Error(`Timed out waiting for: ${pending.join(", ")}`);
				}
				await abortableDelay(POLL_INTERVAL_MS, signal);
			}

			const text = targets.map((run) => runSummary(run, { output: true })).join("\n\n");
			return { content: [{ type: "text", text }], details: { runs: targets } };
		},
	});

	pi.registerTool({
		name: "subagent_clean",
		label: "Subagent Clean",
		description:
			"Reap finished subagent artifacts: kill leftover tmux sessions and optionally delete persisted run directories. Use when completed runs accumulate.",
		promptSnippet: "Clean up finished subagent tmux sessions and run directories",
		parameters: Type.Object({
			all_sessions: Type.Optional(
				Type.Boolean({ description: "Also scan runs persisted by other sessions on disk. Defaults to false." }),
			),
			delete_files: Type.Optional(
				Type.Boolean({ description: "Delete persisted run directories for cleaned runs. Defaults to false." }),
			),
			older_than_hours: Type.Optional(
				Type.Number({ description: "Only clean runs finished longer ago than this. Defaults to 0 (all finished runs)." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const deleteFiles = params.delete_files ?? false;
			const cutoff = Date.now() - (params.older_than_hours ?? 0) * 3_600_000;

			const targets: RunRecord[] = [];
			if (params.all_sessions) {
				const root = path.join(getAgentDir(), RUNS_DIR);
				let dirs: Dirent[] = [];
				try {
					dirs = await readdir(root, { withFileTypes: true });
				} catch {
					dirs = [];
				}
				for (const entry of dirs) {
					if (!entry.isDirectory()) continue;
					try {
						const parsed = JSON.parse(await readFile(path.join(root, entry.name, "runs.json"), "utf8")) as RunRecord[];
						targets.push(...parsed.filter((run) => run?.id));
					} catch {
						// No index for this directory.
					}
				}
			} else {
				targets.push(...runs.values());
			}

			let killed = 0;
			let deleted = 0;
			let skipped = 0;
			for (const run of targets) {
				if (!isTerminal(run.status)) {
					skipped++;
					continue;
				}
				if (run.finishedAt && run.finishedAt > cutoff) {
					skipped++;
					continue;
				}
				updateTmuxCommands(run);
				await killTmuxSession(run);
				killed++;
				if (deleteFiles && run.runDir) {
					await rm(run.runDir, { recursive: true, force: true }).catch(() => undefined);
					deleted++;
					if (runs.get(run.id) === run) runs.delete(run.id);
				}
			}
			if (deleteFiles) await persist();
			return {
				content: [{ type: "text", text: `Cleaned ${killed} tmux session(s), deleted ${deleted} run dir(s), skipped ${skipped}.` }],
				details: { killed, deleted, skipped },
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "Live subagent dashboard: view panes/output, cancel runs, copy attach commands",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("The /subagents dashboard requires the interactive TUI.", "warning");
				return;
			}

			const getRuns = (): RunRecord[] => [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
			let selected = 0;
			let detail = false;
			let handle: { requestRender: () => void } | undefined;

			const iconFor = (run: RunRecord, theme: { fg: (color: string, text: string) => string }): string => {
				if (run.status === "completed") return theme.fg("success", "✓");
				if (run.status === "failed") return theme.fg("error", "✗");
				if (run.status === "cancelled") return theme.fg("muted", "⊘");
				if (run.status === "queued") return theme.fg("warning", "◦");
				return theme.fg("warning", "●");
			};

			const render = (width: number, theme: any): string[] => {
				const list = getRuns();
				if (selected >= list.length) selected = Math.max(0, list.length - 1);
				const active = list.filter((run) => !isTerminal(run.status)).length;
				const lines: string[] = [
					`${theme.bold(theme.fg("accent", "Subagents"))}${theme.fg("dim", `  ${active} active / ${list.length} total`)}`,
					"",
				];

				if (list.length === 0) {
					lines.push(theme.fg("dim", "No subagent runs in this session."));
				} else {
					list.forEach((run, index) => {
						const marker = index === selected ? theme.fg("accent", "▶ ") : "  ";
						const duration = formatDuration(run.startedAt, run.finishedAt);
						const meta = [run.status, duration, formatUsage(run.usage)].filter(Boolean).join(" · ");
						lines.push(`${marker}${iconFor(run, theme)} ${run.id.slice(0, 8)}  ${meta}`);
						lines.push(`    ${theme.fg("dim", run.task.split("\n", 1)[0] ?? run.task)}`);
					});
				}

				const current = list[selected];
				if (current) {
					lines.push("");
					lines.push(
						theme.fg(
							"muted",
							`─ ${current.id} ${current.provider}/${current.model}`,
						),
					);
					const body = detail
						? (current.output ?? current.pane ?? "(no output yet)")
						: (current.pane ?? current.output ?? "(no output yet)");
					for (const line of body.split("\n").slice(-(detail ? 30 : 10))) {
						lines.push(theme.fg("dim", line));
					}
				}

				lines.push("");
				lines.push(theme.fg("dim", "↑/↓ select · enter detail · c cancel · a attach · esc close"));
				return lines.map((line) => truncateToWidth(line, width));
			};

			const interval = setInterval(() => handle?.requestRender(), 500);
			try {
				await ctx.ui.custom<null>(
					(tui, theme, _keybindings, done) => {
						handle = tui;
						return {
							render: (width: number) => render(width, theme),
							invalidate: () => undefined,
							handleInput: (data: string) => {
								const list = getRuns();
								if (matchesKey(data, Key.escape)) {
									done(null);
									return;
								}
								if (matchesKey(data, Key.up)) {
									selected = Math.max(0, selected - 1);
									tui.requestRender();
									return;
								}
								if (matchesKey(data, Key.down)) {
									selected = Math.min(Math.max(0, list.length - 1), selected + 1);
									tui.requestRender();
									return;
								}
								if (matchesKey(data, Key.enter)) {
									detail = !detail;
									tui.requestRender();
									return;
								}
								if (data === "c") {
									const run = list[selected];
									if (run && !isTerminal(run.status)) {
										clearTimer(run.id);
										void killTmuxSession(run);
										run.status = "cancelled";
										run.finishedAt = Date.now();
										void persist().then(() => drainQueue());
										ctx.ui.notify(`Cancelled ${run.id}`, "info");
									}
									tui.requestRender();
									return;
								}
								if (data === "a") {
									const run = list[selected];
									if (run) ctx.ui.notify(`Attach: ${run.attachCommand}`, "info");
									tui.requestRender();
								}
							},
						};
					},
					{ overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
				);
			} finally {
				clearInterval(interval);
			}
		},
	});
}

// Internals exposed for unit tests. See local patch 9 in the header comment.
// Nothing here is used by the extension at runtime.
export const __test__ = {
	abortableDelay,
	attachFlagValue,
	findLastAssistant,
	formatDuration,
	isSameOrDescendant,
	isTerminal,
	readBooleanEnv,
	readIntEnv,
	readNonNegativeIntEnv,
	resolveModel,
	runSummary,
	shellQuote,
	textFromAssistant,
	tmuxSessionName,
	tmuxSocketPath,
	trimPane,
	truncateToolText,
	updateTmuxCommands,
	validateCwd,
	writeJsonAtomic,
};

export type { ChildResult, RunRecord, RunStatus };
