// The numbered list below records the patches applied on top of the vendored
// upstream. Items marked "Pruned" are HISTORY, not current behaviour: the code
// they describe is gone and nothing below should reintroduce it.
//
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
//  3. Status tooling: `subagent_status` (list/inspect runs) and
//     `subagent_cancel` (kill a run) let the main agent collect results on
//     demand. There is deliberately no blocking `wait`: the widget shows a human
//     the same thing, and a tool the model polls is cheaper than one that blocks
//     a turn open. Pruned for the first iteration.
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
//     preview, cancel, and attach-command copy. Pruned for the first iteration:
//     it was never covered by a test (the harness stubs `registerCommand`) and
//     patch 14's widget covers the same ground live.
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
// 12. Context handoff (see handoff.ts): the `subagent` tool gains a `handoff`
//     parameter (`standalone` | `lineage` | `fork`) and a `subagent_resume`
//     tool. The child argv is built by `buildChildPiArgs`, which never emits
//     `--session` together with `--session-id` because pi hard-exits on the
//     combination. `fork` writes the parent's LIVE branch rather than using
//     `SessionManager.forkFrom`, which copies every entry and would therefore
//     adopt the source file's last line as the active branch. Runs carry a
//     `usageFromLine` baseline so inherited turns are not billed to the child.
//     `subagent_clean` retains a run dir that still owns a live run's session
//     file, because a resumed run keeps its ancestor's transcript.
// 13. Turn-level interrupt (see interrupt.ts): `subagent_interrupt({ id })`
//     sends Escape (`app.interrupt`) to the child's pane, which aborts the
//     in-flight turn but leaves the child alive at its prompt. The child then
//     writes `<runDir>/interrupt.json` on `turn_end`/`agent_settled` instead of
//     a failed `result.json`, and skips `ctx.shutdown()`, so the run can be
//     steered instead of being destroyed. `RunStatus` gains `"interrupted"`,
//     which is terminal for wait/clean/status but NOT for `holdsChild` — the
//     child process, its tmux session and its transcript all survive, so the
//     watcher keeps polling for a later `result.json`. Two rules follow from
//     that and are easy to undo by accident: nothing may spawn a second pi
//     process on a transcript a live child still holds (`subagent_resume`
//     refuses while `holdsChild`), and nothing may leave an idle child
//     unreferenced forever (shutdown reaps it; the transcript survives, so the
//     run stays resumable).
// 14. Status classifier and live widget (see status.ts and widget.ts):
//     `observeStatus`/`classifyStatus`/`advanceStatusState` turn the activity
//     snapshot the parent already reads into a display status — starting,
//     active, waiting, stalled — with the monotonicity guard that makes an
//     out-of-order or clock-skewed snapshot harmless. The widget itself is pi's
//     native `ctx.ui.setWidget(..., { placement: "aboveEditor" })`, installed
//     lazily while a run is live and cleared when the last one finishes, and
//     guarded on `ctx.mode === "tui"` because RPC forwards only string arrays.
//     Two policies are deliberately NOT the reference's: the stall threshold is
//     ours and generous (PI_SUBAGENT_STALL_SECONDS, default 180) because our
//     children shut themselves down at `agent_settled` and a long silent tool is
//     not a hung child; and a stall or recovery never wakes the parent, because
//     that would duplicate notifyCompletion. The classifier is display-only — it
//     cannot finish, fail or interrupt anything — and `interrupted` is
//     authoritative over it.
// 15. Lazy tool exposure (see resolveManagementExposure and
//     registerManagementTools): the five management tools — status, cancel,
//     interrupt, resume, clean — are registered at `session_start` with pi's
//     `exposure: "codemode"` when `codemode` or `tool_search` is active, so their
//     descriptions, schemas, snippets and guidelines stop riding along on requests
//     that never use them. `subagent` itself stays declared: it is the entry point,
//     and a model that cannot start a run has no reason to search for the tools
//     that manage one. Registration is deferred because pi's getActiveTools() and
//     getSettings() throw during extension load, so the question cannot be asked
//     earlier — and re-registering later would NOT work, because pi declares the
//     ACTIVE set and a tool activated on registration stays active.
//
// The child reporter (CHILD_ENV) still reports completion the same way; patch 11
// only adds the activity snapshot to it, and patch 13 only diverts the aborted
// settle onto the marker.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildChildPiArgs,
	countSessionLines,
	forkLiveBranch,
	requireExistingSession,
	seedLineageSession,
	usesSessionFile,
	type LaunchMode,
	type ParentBranchEntry,
} from "./handoff.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	getAgentDir,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createInterruptMarkerWriter,
	getInterruptFilePath,
	readInterruptMarker,
	type SubagentInterruptMarker,
} from "./interrupt.ts";
import {
	advanceStatusState,
	classifyStatus,
	createStatusState,
	DEFAULT_STALL_AFTER_MS,
	DEFAULT_TOOL_STALL_AFTER_MS,
	observationFromActivity,
	observeStatus,
	withRunStatus,
	type LiveRunStatus,
	type StatusObservation,
	type StatusSnapshot,
	type SubagentStatusState,
} from "./status.ts";
import { createStatusWidget, type StatusRow } from "./widget.ts";
import {
	createActivityRecorder,
	getActivityFilePath,
	readActivityFile,
	type ActivityReadResult,
	type SubagentActivityPhase,
	type SubagentActivityScope,
} from "./activity.ts";
import { formatUsage, readSessionUsage, type RunUsage } from "./usage.ts";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
/** Marker path the child writes when a turn was interrupted (local patch 13). */
const INTERRUPT_ENV = "PI_TMUX_SUBAGENT_INTERRUPT";
const RUNS_DIR = "tmux-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MAX_CONCURRENT = 4;
const GC_DAYS = 7;
/** Default grace period for confirming an interrupt before reporting "requested". */
const DEFAULT_INTERRUPT_CONFIRM_MS = 3_000;
/** Default silence, in seconds, before a run is called stalled (local patch 14). */
const DEFAULT_STALL_SECONDS = DEFAULT_STALL_AFTER_MS / 1000;
/** Same, for a run inside a tool call, which is silent by construction. */
const DEFAULT_TOOL_STALL_SECONDS = DEFAULT_TOOL_STALL_AFTER_MS / 1000;
/** How often the live widget re-renders when nothing else asks it to. */
const WIDGET_TICK_MS = 1_000;
/** Widget key, so pi can replace and clear our widget without touching others. */
const WIDGET_KEY = "subagent-status";

/** How many consecutive unclassifiable tmux failures mean the child is gone. */
const MAX_TRANSIENT_TMUX_FAILURES = 3;
/** Poll cadence while waiting for a child to confirm an interrupt. */
const INTERRUPT_POLL_MS = 100;
/**
 * pi treats two Escapes within this window on an idle child as its
 * "double escape action" (the session tree by default), so the extension must
 * never send two of its own inside it.
 */
const DOUBLE_ESCAPE_WINDOW_MS = 500;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Selectable handoff modes for the `subagent` tool; `resume` is not selectable. */
const HANDOFF_MODES = ["standalone", "lineage", "fork"] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);
const RESULT_MESSAGE_TYPE = "subagent-result";

type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

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
	/**
	 * How this run was launched. `standalone` is the default and the only mode
	 * that predates context handoff; the others address an existing session
	 * file. Persisted, so a reload can still resume a run.
	 */
	mode?: LaunchMode;
	/** For a resumed run, the run id this attempt continues directly. */
	resumeOf?: string;
	/** 1 for a fresh run; incremented on each resume. */
	attempt?: number;
	/**
	 * Leading lines of `sessionFile` inherited from the parent run rather than
	 * produced by this run. Used as the usage baseline so a fork or a resume
	 * is not charged for context it did not generate.
	 */
	usageFromLine?: number;
	/** Latest child activity snapshot, reduced to what the parent needs. */
	activity?: RunActivity;
	/**
	 * When Escape was last sent to this run's pane, before the child confirmed an
	 * aborted turn. Cleared once the marker lands (local patch 13).
	 */
	interruptRequestedAt?: number;
	/** When the child last settled an aborted turn. */
	interruptedAt?: number;
	/** Aborted turns this run has settled, taken from the child's marker. */
	interrupts?: number;
}

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Read a positive integer from the environment.
 *
 * Strict on purpose: `parseInt` would happily read the "3" out of "3m" and the "1"
 * out of "1e9", and a threshold silently shortened by a typo is worse than one
 * that was ignored (the default is the documented behaviour).
 */
function readIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
		// Say so rather than silently running on the default: a typo in a
		// threshold is exactly the case where silence is expensive.
		console.error(`[tmux-subagent] ${name}="${raw}" is not a positive whole number; using ${fallback}.`);
		return fallback;
	}
	return Number.parseInt(raw, 10);
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

/**
 * Materialise the child's session file for a handoff mode and record how many
 * leading lines the run inherited.
 *
 * Called at tool-call time rather than at launch: a queued run's parent keeps
 * talking while it waits, so snapshotting on dequeue would hand over a branch
 * that has already moved on. `usageFromLine` becomes the usage baseline, so
 * inherited turns are never charged to the child.
 */
async function prepareHandoffSession(run: RunRecord, ctx: ExtensionContext): Promise<void> {
	// `resume` never reaches here: the `subagent` tool's enum excludes it and
	// `subagent_resume` handles its own baseline. See subagent_resume.
	const mode = run.mode ?? "standalone";
	if (!usesSessionFile(mode)) return;

	const parentFile = ctx.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("The parent session has no session file to hand off from.");
	const target = path.join(run.runDir, "session", `${mode}.jsonl`);

	if (mode === "lineage") {
		await seedLineageSession({ sessionFile: target, id: run.id, cwd: run.cwd, parentSession: parentFile });
		run.sessionFile = target;
		run.usageFromLine = 1; // header only
		return;
	}

	// `fork`: snapshot the parent's live branch. getBranch() returns
	// ancestors-first with the leaf last, which is exactly the order pi adopts
	// as the active branch on load. See handoff.ts for why forkFrom is not
	// used here.
	//
	// The live manager is used rather than re-opening the file: its leaf is the
	// pointer the user is actually on, and pi appends synchronously, so there is
	// nothing on disk that ctx does not already have. Falling back to the
	// reopened manager's leaf would silently reintroduce the wrong-branch trap,
	// because that value is just the file's last line.
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) throw new Error("The parent session has no active branch to fork.");
	const branch = ctx.sessionManager.getBranch(leafId) as unknown as ParentBranchEntry[];
	if (branch.length === 0) throw new Error("The parent session has no conversation to fork.");
	const forked = await forkLiveBranch({ sessionFile: target, branch, id: run.id, cwd: run.cwd, parentSession: parentFile });
	run.sessionFile = forked.sessionFile;
	run.usageFromLine = 1 + forked.inheritedEntries; // header + inherited entries
}

/**
 * True when `run`'s run directory still contains the session file of some other
 * run that is still in flight.
 *
 * `subagent_resume` allocates a fresh run dir but keeps the ancestor's
 * transcript, so the file outliving its own directory is normal, and deleting
 * that directory is destructive to whoever still holds it.
 */
function runDirOwnsLiveTranscript(run: RunRecord, runs: Map<string, RunRecord>): boolean {
	if (!run.runDir) return false;
	for (const other of runs.values()) {
		if (other.id === run.id) continue;
		// holdsChild, not !isTerminal: an interrupted run's child is still alive
		// and still holds its transcript open, so its run dir is just as load
		// bearing as a running one's.
		if (!holdsChild(other.status)) continue;
		if (!other.sessionFile) continue;
		if (isSameOrDescendant(run.runDir, other.sessionFile)) return true;
	}
	return false;
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

function registerChildReporter(pi: ExtensionAPI, resultPath: string, runId: string, interruptPath: string | undefined): void {
	let reported = false;
	// The aborted turn currently in flight, latched by `turn_end` and consumed by
	// `agent_settled`. `agent_settled` carries no payload and fires for aborted
	// runs too, so the outcome has to be remembered across the two events.
	let abortedTurn: { turnIndex?: number; stopReason?: string } | undefined;

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

	// Written only on an aborted settle, so a run that is never interrupted never
	// has the file and the parent keeps seeing a plain running child. A child
	// launched without the env var (an older parent, a stripped environment) keeps
	// the previous behaviour of reporting an abort as a failed result, which is
	// strictly better than writing a marker nobody will read.
	const interruptWriter = interruptPath
		? createInterruptMarkerWriter({
				filePath: interruptPath,
				runId,
				write: writeJsonAtomic,
				onError: (error) => {
					console.error(
						`[tmux-subagent] interrupt marker write failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			})
		: undefined;

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

	// Turn-level interrupt (local patch 13). An aborted turn is not a failed run:
	// the child survives at its prompt with its session file intact, so reporting
	// a failure and shutting down — the behaviour below — would throw away a run
	// the user only wanted to steer. Latch the outcome here because `turn_end`
	// carries it and `agent_settled` does not.
	pi.on("turn_end", (event) => {
		if (event.outcome !== "aborted") return;
		// `message` is an AgentMessage union; only the assistant member carries a
		// stopReason, so it is read through a narrowing shape rather than a cast.
		const stopReason = (event.message as { stopReason?: unknown } | undefined)?.stopReason;
		abortedTurn = {
			...(typeof event.turnIndex === "number" ? { turnIndex: event.turnIndex } : {}),
			...(typeof stopReason === "string" ? { stopReason } : {}),
		};
	});

	// agent_settled was added after older peer type declarations but is present
	// in the Pi runtime this extension targets.
	(
		pi.on as unknown as (
			event: "agent_settled",
			handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
		) => void
	)("agent_settled", async (_event, ctx) => {
		if (abortedTurn && interruptWriter) {
			const aborted = abortedTurn;
			abortedTurn = undefined;
			// The child lives on, so the snapshot must not claim a terminal "done"
			// phase: "waiting" is what the parent should see while the prompt is
			// idle. The recorder forces a write on a phase change, and the marker is
			// only written after this await returns, so the parent cannot see the
			// interrupt before the phase it belongs to. (It may still render the
			// previous `active` phase for one tick, since the watcher reads
			// activity.json first; that is a display detail, not a wrong status.)
			await recorder.agentEnd().catch(() => undefined);
			await interruptWriter?.mark(aborted);
			// Deliberately no report and no ctx.shutdown(): the parent learns about
			// the interrupt from the marker and keeps watching for a later result.
			// A child with no marker path falls through to the report below, because
			// it cannot be steered and must not go silent.
			return;
		}
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

/** "3s" for a 3000ms window, "0s" when confirming is disabled, "not waiting" for a negative one. */
function formatConfirmWindow(ms: number): string {
	if (ms <= 0) return "time (confirmation is disabled)";
	return `${Math.round(ms / 1000)}s`;
}

/**
 * True when a tmux call failed because its target is gone, rather than for a
 * transient reason. `pane_dead` cannot report this case: it needs a live pane to
 * ask, so a session killed by hand (a natural response to a wedged subagent)
 * otherwise leaves the watcher polling a target that cannot exist.
 */
function isMissingTmuxTarget(result: { code: number; stdout: string; stderr: string }): boolean {
	if (result.code === 0) return false;
	return /can't find|no such (?:pane|window|session|target)|unknown session|server (?:exited|not found|terminated)/i.test(
		`${result.stderr}\n${result.stdout}`,
	);
}

/** The parse error behind an unusable snapshot, if it has one worth showing. */
function describeSnapshotError(snapshot: StatusSnapshot): string | null {
	if (snapshot.snapshotState !== "invalid" || !snapshot.snapshotError) return null;
	const detail = snapshot.snapshotError.replace(/^activity is not valid JSON: /, "").replace(/\s+/g, " ").trim();
	if (!detail) return "invalid snapshot";
	return detail.length <= 40 ? `invalid snapshot: ${detail}` : `invalid snapshot: ${detail.slice(0, 39)}…`;
}

/**
 * The kind-specific qualifier on a widget row.
 *
 * Durations come first and the label second ("active 45s (bash)") because the
 * duration describes the PHASE while a tool name describes what is happening
 * inside it — they are not the same span, and pairing them the other way round
 * implies the tool has been running for the whole phase.
 */
function statusDetail(snapshot: StatusSnapshot): string {
	switch (snapshot.kind) {
		case "active": {
			const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
			const label = snapshot.toolName ?? snapshot.activeScope;
			return label ? `active${duration} (${label})` : `active${duration}`;
		}
		case "waiting": {
			const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
			return `${snapshot.statusLabel ?? "waiting"}${duration}`;
		}
		case "stalled": {
			// Whichever clock applies, it measures the SILENCE: an unreadable file
			// has been a problem for snapshotProblemText, a valid-but-frozen one for
			// quietDurationText. Falling back to the run's age would overstate the
			// stall by everything the run did before it wedged.
			const duration = snapshot.quietDurationText ?? snapshot.snapshotProblemText;
			// The reason is worth showing, because the responses differ: "no
			// activity" means a wedged child, "wrong activity id" means a mismatched
			// snapshot, and an unreadable file is usually a corrupt or truncated one.
			const reason = snapshot.statusLabel ?? describeSnapshotError(snapshot);
			return `stalled${duration ? ` ${duration}` : ""}${reason ? ` (${reason})` : ""}`;
		}
		case "queued":
			return "queued for a slot";
		case "interrupted":
			return "interrupted";
		default:
			return "starting";
	}
}

/** Feed the classifier from the activity read: the snapshot, or why there is none. */
// Feed the classifier from the activity read: the snapshot, or why there is none.
function observationFromRead(read: ActivityReadResult): StatusObservation {
	if (!read.ok) return { snapshot: read.reason, snapshotError: read.error };
	const snapshot = read.activity;
	return observationFromActivity({
		phase: snapshot.phase,
		updatedAt: snapshot.updatedAt,
		sequence: snapshot.sequence,
		scope: snapshot.activeScope,
		toolName: snapshot.toolName,
		activeSince: snapshot.activeSince,
		waitingSince: snapshot.waitingSince,
		latestEvent: snapshot.latestEvent,
	});
}

/**
 * The exposure to register the management tools with, or undefined for `direct`.
 *
 * `undefined` means "declare them as usual", which is always correct — a tool the
 * model cannot find is worse than one it pays for — so this can only ever lose the
 * saving, never a capability.
 */
function resolveManagementExposure(activeTools: readonly string[]): ToolExposure | undefined {
	// `getActiveTools()` is the RESOLVED set: settings layers, `--tools` and
	// `/tools` have all been applied by the time this runs, and only a genuinely
	// active tool can reach the model on demand. Reading the settings layer as well
	// would hide the tools in exactly the case where `--tools` switched codemode off.
	return activeTools.some((name) => name === "codemode" || name === "tool_search") ? "codemode" : undefined;
}

/**
 * Run `callback` every `intervalMs`, returning the function that stops it.
 *
 * `unref` matters: a widget ticker must never be the reason a session's event loop
 * stays alive (local patch 10). Module level and dependency-free so the mechanism
 * can be tested without a terminal, a tmux server or a run.
 */
function startRepeatingRefresh(callback: () => void, intervalMs: number): () => void {
	const timer = setInterval(callback, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

function isTerminal(status: RunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/**
 * True when a run's child process may still exist, and therefore owns a tmux
 * session, a concurrency slot and an open session file.
 *
 * This is deliberately not `!isTerminal`. `interrupted` is terminal — the run
 * will produce no further result of its own accord, and `subagent_clean` skips
 * it — but its child is still sitting at a prompt with its transcript intact, so
 * anything that would destroy or free that child must consult this predicate
 * instead: auto-reap, shutdown reaping, the concurrency gate,
 * `subagent_resume` (which refuses while a child is alive, and would otherwise
 * open a second writer on the same file), and `subagent_cancel`.
 */
function holdsChild(status: RunStatus): boolean {
	return status === "queued" || status === "running" || status === "interrupted";
}

/**
 * A delay that gives up when its tool call is cancelled.
 *
 * The only cancellable caller left is the interrupt confirmation poll; the
 * removed blocking wait was the other one. Callers that do not care pass no
 * signal and simply get a sleep.
 */
async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Subagent polling aborted.");
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new Error("Subagent polling aborted."));
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
	// Activity describes what the child is doing right now. An interrupted run is
	// terminal for waiting but its child is alive at its prompt, so it still has a
	// live phase worth reporting. A queued run never has one (nothing has started),
	// so this is false for it as well.
	const activity = holdsChild(run.status) ? formatActivity(run.activity) : undefined;
	const lines = [
		`${run.id}  ${run.status}${duration ? ` · ${duration}` : ""}${usage ? ` · ${usage}` : ""}`,
		`  task: ${run.task.split("\n", 1)[0]?.slice(0, 100) ?? run.task}`,
		`  model: ${run.provider}/${run.model} (${run.thinking})`,
	];
	if (activity) lines.push(`  activity: ${activity}`);
	lines.push(`  tmux: ${run.tmuxSession}`, `  attach: ${run.attachCommand}`);
	if (run.sessionFile) lines.push(`  child session: ${run.sessionFile}`);
	if (run.status === "interrupted") {
		// The child can be driven again after an interrupt, so "idle at its prompt"
		// is a claim about now, not about the run: read it off the live activity
		// phase rather than off the status, which stays interrupted either way.
		const workingAgain = run.activity?.phase === "active";
		lines.push(
			`  interrupt: turn aborted${run.interruptedAt ? ` at ${new Date(run.interruptedAt).toISOString()}` : ""}` +
				`${(run.interrupts ?? 0) > 1 ? ` (${run.interrupts} so far)` : ""}. ` +
				(workingAgain
					? `The child has been driven again and is working; interrupt it again or let it finish.`
					: `The child is idle at its prompt with its transcript intact: attach to steer it, or cancel it to release its slot.`),
		);
	} else if (run.interruptRequestedAt) {
		lines.push(
			`  interrupt: Escape sent at ${new Date(run.interruptRequestedAt).toISOString()}, not confirmed yet. ` +
				`The child may have been idle already; subagent_status will show it once the turn aborts.`,
		);
	}
	if (run.mode && run.mode !== "standalone") lines.push(`  handoff: ${run.mode}`);
	if (run.resumeOf) lines.push(`  resumed from: ${run.resumeOf}`);
	if (run.attempt && run.attempt > 1) lines.push(`  attempt: ${run.attempt}`);
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
		registerChildReporter(pi, resultPath, path.basename(path.dirname(resultPath)), process.env[INTERRUPT_ENV]?.trim() || undefined);
		return;
	}

	const maxConcurrent = readIntEnv("PI_SUBAGENT_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT);
	const notifyOnCompletion = readBooleanEnv("PI_SUBAGENT_NOTIFY", true);
	const killOnShutdown = readBooleanEnv("PI_SUBAGENT_KILL_ON_SHUTDOWN", false);
	const autoReap = readBooleanEnv("PI_SUBAGENT_AUTO_REAP", true);
	const reapDelayMs = readNonNegativeIntEnv("PI_SUBAGENT_REAP_DELAY_MS", 0);
	const gcDays = readNonNegativeIntEnv("PI_SUBAGENT_GC_DAYS", GC_DAYS);
	// How long subagent_interrupt waits for the child to confirm the interrupt
	// before reporting "requested" instead of "interrupted".
	const interruptConfirmMs = readNonNegativeIntEnv("PI_SUBAGENT_INTERRUPT_CONFIRM_MS", DEFAULT_INTERRUPT_CONFIRM_MS);
	// How long a run may go without a usable activity snapshot before the widget
	// calls it stalled. Deliberately generous: our children shut down at
	// `agent_settled`, so silence is usually a long tool, not a hung child.
	const stallAfterMs = readIntEnv("PI_SUBAGENT_STALL_SECONDS", DEFAULT_STALL_SECONDS) * 1000;
	// A tool call produces no events while it prints nothing, so it needs a much
	// longer leash than a streaming or waiting child.
	const toolStallAfterMs = readIntEnv("PI_SUBAGENT_TOOL_STALL_SECONDS", DEFAULT_TOOL_STALL_SECONDS) * 1000;

	const runs = new Map<string, RunRecord>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	// The last activity string written to runs.json, so a chatty child does not
	// rewrite the index when nothing visible changed.
	const activitySignatures = new Map<string, string>();
	const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Consecutive ticks on which tmux could not be reached at all. One success
	 * clears it, so only a sustained outage ever counts.
	 */
	const tmuxFailures = new Map<string, number>();
	// Per-run classifier state (local patch 14). Pure state, kept here because it
	// is derived from run.activity and thrown away with the run.
	const statusStates = new Map<string, SubagentStatusState>();
	// The TUI driving our widget, captured when pi installs it. Only ever set in
	// TUI mode: RPC drops component factories, so there is no TUI to poke there.
	let widgetTui: { requestRender: () => void } | undefined;
	// Stopping the ticker, not the timer handle: see startRepeatingRefresh.
	let widgetTimer: (() => void) | undefined;
	// The context that owns the widget. Held so the ticker can clear the widget
	// when the last run finishes; TUI-only, and dropped at shutdown.
	let statusUi: ExtensionContext | undefined;
	let widgetInstalled = false;

	const countTmuxFailure = (run: RunRecord): number => {
		const next = (tmuxFailures.get(run.id) ?? 0) + 1;
		tmuxFailures.set(run.id, next);
		return next;
	};
	const clearTmuxFailures = (run: RunRecord): void => {
		tmuxFailures.delete(run.id);
	};
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
		const snapshot = [...runs.values()];
		persistChain = persistChain
			.then(() => writeJsonAtomic(runsIndexPath, snapshot))
			.catch((error) => {
				console.error(`[tmux-subagent] Failed to persist runs: ${error instanceof Error ? error.message : String(error)}`);
			});
		return persistChain;
	};

	const activeCount = (): number => {
		let count = 0;
		for (const run of runs.values()) {
			// An interrupted run still holds a child process, so it keeps its slot.
			// `queued` is excluded because drainQueue gates on this number.
			if (run.status === "running" || run.status === "interrupted") count++;
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
		// holdsChild, not an isTerminal check: an interrupted run is terminal but
		// its child is alive, and reaping it would destroy the only handle on a
		// resumable session. It is released by subagent_cancel instead.
		if (holdsChild(run.status)) return;
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
			`Collect the result with subagent_status({ id: "${run.id}" }).`,
		].join("\n");
		try {
			// Deliberately no `triggerTurn` and no `deliverAs`. Both make pi take the
			// turn: `triggerTurn` starts one outright, and while the session is
			// streaming `deliverAs: "followUp"` queues ANOTHER one via agent.followUp.
			// Either way a finishing subagent interrupts whatever the main agent was
			// doing and re-sends the whole conversation to say "done".
			//
			// With neither, pi appends the message to the transcript (idle) or queues
			// it as a pending custom message flushed at the end of the current turn
			// (streaming). It still lands in context, so the model learns of it the
			// next time it acts, and the live widget is what tells the human meanwhile.
			await pi.sendMessage({
				customType: RESULT_MESSAGE_TYPE,
				content: text,
				display: true,
				details: { id: run.id, status: run.status, error: run.error },
			});
		} catch (error) {
			// The session may be shutting down; state is still on disk.
			console.error(`[tmux-subagent] Failed to notify about ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const finalizeRun = async (run: RunRecord, result: ChildResult): Promise<void> => {
		run.status = result.status === "completed" ? "completed" : "failed";
		run.finishedAt = result.finishedAt || Date.now();
		// The run is over one way or another, so an outstanding Escape is no longer
		// news; leaving it would make subagent_status report a pending interrupt on
		// a finished run.
		run.interruptRequestedAt = undefined;
		// The child reports the path it actually opened. Keep the one we already
		// recorded when it does not: a result without sessionFile must not erase
		// the pointer subagent_resume depends on.
		run.sessionFile = result.sessionFile ?? run.sessionFile;
		run.provider = result.provider ?? run.provider;
		run.model = result.model ?? run.model;
		run.thinking = result.thinking ?? run.thinking;
		let output = result.output.trim();
		if (result.status === "failed" && result.error?.trim()) {
			output += `${output ? "\n\n" : ""}Error: ${result.error.trim()}`;
			run.error = result.error.trim();
		}
		run.output = truncateToolText(output || "(no text output)");
		run.usage = (await readSessionUsage(run.sessionFile, { fromLine: run.usageFromLine ?? 0 })) ?? run.usage;
		await persist();
		// After the notification: a display problem must never be able to swallow
		// the completion message, which is how the main agent learns the run ended.
		await notifyCompletion(run);
		refreshStatusWidget();
		scheduleReap(run);
		void drainQueue();
	};

	const markRunFailed = async (run: RunRecord, message: string): Promise<void> => {
		clearTimer(run.id);
		run.status = "failed";
		run.interruptRequestedAt = undefined;
		run.error = message;
		run.finishedAt = Date.now();
		await persist();
		// After the notification: a display problem must never be able to swallow
		// the completion message, which is how the main agent learns the run ended.
		await notifyCompletion(run);
		refreshStatusWidget();
		scheduleReap(run);
	};

	const readChildResult = async (run: RunRecord): Promise<ChildResult | undefined> => {
		try {
			return JSON.parse(await readFile(run.resultPath, "utf8")) as ChildResult;
		} catch {
			return undefined;
		}
	};

// --- Lazy tool exposure (local patch 15) -------------------------------------
//
// The management tools (status, cancel, interrupt, resume, clean) cost a request
// nothing when they are not used: their descriptions, parameter schemas, prompt
// snippets and guidelines are declared to the model on every call. pi already has
// a mechanism for that — a tool with `exposure: "codemode"` is never activated
// (`_isActivatedOnRegistration` requires a declarable exposure), so it is never
// declared, while remaining callable from a codemode script or after
// `tool_search` loads it.
//
// Registration is therefore DEFERRED to `session_start`, and that is forced, not
// chosen: pi's `getActiveTools()` and `getSettings()` throw during extension load
// ("Extension runtime not initialized"), so "is codemode available?" cannot be
// asked until the runtime binds. Registering at load and re-registering with a
// different exposure does NOT work — the declared set is built from the ACTIVE
// set (`_applyToolLoadout`), and a tool activated on registration stays active.
//
// Nothing can call a tool before the session starts, so deferring costs nothing.

/** Register the management tools, hidden if pi can reach them another way. */
const registerManagementTools = (): void => {
	let exposure: ToolExposure | undefined;
	try {
		exposure = resolveManagementExposure(pi.getActiveTools());
	} catch (error) {
		// Not worth failing a session over: without an answer the tools are simply
		// declared, which is always correct.
		console.error(`[tmux-subagent] could not resolve tool exposure: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const tool of managementToolDefinitions) {
		pi.registerTool(exposure ? { ...tool, exposure } : tool);
	}
};;

// --- Live widget (local patch 14) ---------------------------------------------
//
// The classifier is display-only, so none of this decides anything about a run:
// `advanceStatusState`'s transition is deliberately ignored here. A caller that
// must REACT to a stall would use it; this one must not, because waking the
// parent would duplicate notifyCompletion and spam the main session with
// something the user is already watching below the editor.

/**
 * Runs with liveness worth showing: anything whose child may still exist.
 *
 * Interrupted runs sort last. They are long-lived by design — one holds its slot
 * until it is cancelled — so ordering purely by age lets a few of them occupy
 * every row and pushes a run the user just started into the "+N more" line.
 * Otherwise oldest first, which is creation order.
 */
const liveRuns = (): RunRecord[] =>
	[...runs.values()]
		.filter((run) => holdsChild(run.status))
		.sort((a, b) => {
			// Interrupted last: a positive value puts `a` after `b`.
			const settled = Number(a.status === "interrupted") - Number(b.status === "interrupted");
			return settled !== 0 ? settled : a.createdAt - b.createdAt;
		});

const statusStateFor = (run: RunRecord): SubagentStatusState => {
	const runStatus = run.status as LiveRunStatus;
	const existing = statusStates.get(run.id);
	if (!existing) {
		// A queued run has no startedAt yet, so its clock starts when it was asked
		// for: the widget then shows how long it has been waiting for a slot.
		return createStatusState({ runStatus, startTimeMs: run.startedAt ?? run.createdAt, stallAfterMs, toolStallAfterMs });
	}
	// A run's elapsed time means what subagent_status says it means:
	// time since it STARTED. While it was queued there was nothing to time, so the
	// clock is re-based when it finally starts — otherwise the widget would count
	// the queue wait forever and two surfaces would disagree on one number.
	if (existing.runStatus === "queued" && runStatus !== "queued" && run.startedAt !== undefined) {
		return withRunStatus({ ...existing, startTimeMs: run.startedAt }, runStatus);
	}
	return withRunStatus(existing, runStatus);
};

const statusRows = (now: number): StatusRow[] =>
	liveRuns().map((run) => {
		// classifyStatus, not advanceStatusState: the stored state is already
		// advanced by refreshStatusWidget, and rendering must not move it.
		const snapshot = classifyStatus(statusStates.get(run.id) ?? statusStateFor(run), now);
		return {
			id: run.id.slice(0, 8),
			task: run.task,
			kind: snapshot.kind,
			elapsedText: snapshot.elapsedText,
			detail: statusDetail(snapshot),
		};
	});

/** Fold one observation into a run's classifier state and refresh the widget. */
const observeRunStatus = (run: RunRecord, observation: StatusObservation): void => {
	statusStates.set(run.id, observeStatus(statusStateFor(run), observation, Date.now()));
	refreshStatusWidget();
};

const clearWidget = (): void => {
	widgetTui = undefined;
	if (!widgetInstalled) return;
	widgetInstalled = false;
	statusUi?.ui.setWidget(WIDGET_KEY, undefined);
};

/**
 * Start the render ticker, once there is something to show.
 *
 * The 500ms watcher already re-renders for a running child, but a watcher's tmux
 * calls can take seconds when tmux is slow, a QUEUED run has no watcher at all,
 * and elapsed times keep moving when nothing else happens — so the widget needs a
 * tick of its own. It is stopped as soon as no run is live, which keeps an idle
 * session's event loop empty (local patch 10).
 */
const startWidgetTimer = (): void => {
	// Only TUI can render this, and installWidget is a no-op elsewhere, so a
	// ticker in RPC or print would be a timer that re-renders nothing.
	if (widgetTimer || shuttingDown || statusUi?.mode !== "tui") return;
	widgetTimer = startRepeatingRefresh(() => refreshStatusWidget(), WIDGET_TICK_MS);
};

const stopWidgetTimer = (): void => {
	widgetTimer?.();
	widgetTimer = undefined;
};

/** Advance every live run's classifier and re-render the widget. */
const refreshStatusWidget = (now = Date.now()): void => {
	// Nothing below this line can be seen in RPC, print or json, and the classifier
	// state it maintains would be dead weight there.
	if (shuttingDown || statusUi?.mode !== "tui") return;

	for (const [runId] of statusStates) {
		const run = runs.get(runId);
		if (run && holdsChild(run.status)) continue;
		// A finished run has no liveness left to classify, and keeping its state
		// would let a future run inherit its history.
		statusStates.delete(runId);
	}
	const live = liveRuns();
	for (const run of live) {
		statusStates.set(run.id, advanceStatusState(statusStateFor(run), now).nextState);
	}

	// Nothing to show: take the widget down rather than leaving an empty strip
	// above the editor. Installed lazily, so an idle session never calls
	// setWidget at all.
	if (live.length === 0) {
		stopWidgetTimer();
		clearWidget();
		return;
	}
	if (!widgetInstalled) installWidget();
	startWidgetTimer();
	widgetTui?.requestRender();
};

/**
 * Install the widget component.
 *
 * Guarded on `ctx.mode`, not `ctx.hasUI`: RPC reports hasUI too but forwards only
 * string arrays and silently drops a component factory, so installing one there
 * would show a widget that can never update. print and json no-op the UI anyway.
 */
const installWidget = (): void => {
	if (!statusUi || statusUi.mode !== "tui" || widgetInstalled) return;
	statusUi.ui.setWidget(
		WIDGET_KEY,
		createStatusWidget({
			getRows: () => statusRows(Date.now()),
			onCreate: (tui) => {
				widgetTui = tui;
			},
		}),
		{ placement: "aboveEditor" },
	);
	widgetInstalled = true;
};

	/**
	 * Fold a child-written interrupt marker into the run.
	 *
	 * Returns true when the record changed. Counters are raised monotonically and
	 * the timestamp only moves forward, so a marker that was already recorded
	 * (the watcher and the tool's confirmation poll both read the same file)
	 * cannot rewind or double-count the run. `runId` validation is what makes a
	 * leftover marker from an earlier attempt harmless, but it cannot make an
	 * *older* marker for this same run harmless — that is the caller's job, via
	 * the `since` baseline.
	 */
const noteInterrupt = async (
		run: RunRecord,
		marker: SubagentInterruptMarker,
		since?: { interrupts: number; at: number },
	): Promise<boolean> => {
		// A marker that lands after the run was finalized must not resurrect it as
		// interrupted: the watcher has already stopped, so nothing would ever move
		// it on from there.
		if (isTerminal(run.status) && run.status !== "interrupted") return false;
		// Stale by the caller's reckoning: this is the marker from an earlier
		// interrupt that is still sitting in the run dir.
		if (since && marker.interrupts <= since.interrupts && marker.interruptedAt <= since.at) return false;
		const interrupts = Math.max(run.interrupts ?? 0, marker.interrupts);
		const interruptedAt = Math.max(run.interruptedAt ?? 0, marker.interruptedAt);
		if (run.status === "interrupted" && interrupts === run.interrupts && interruptedAt === run.interruptedAt) return false;
		run.status = "interrupted";
		run.interrupts = interrupts;
		run.interruptedAt = interruptedAt;
		// The request has been honoured; keeping it would make subagent_status
		// report an unconfirmed interrupt for a run that is known to be stopped.
		run.interruptRequestedAt = undefined;
		// No finishedAt: the child is still running, so the elapsed time shown by
		// formatDuration must keep counting rather than freezing.
		await persist();
		// `interrupted` is a status the widget renders, and noteInterrupt is the
		// only writer of it — without this the strip keeps claiming the run is
		// active for up to a tick after the tool reported it stopped.
		refreshStatusWidget();
		return true;
	};

	/** What the confirmation poll saw. */
	type InterruptConfirmation =
		| { state: "confirmed"; marker: SubagentInterruptMarker }
		| { state: "stale"; marker: SubagentInterruptMarker }
		| { state: "unconfirmed"; aborted: boolean };

	/**
	 * Poll for a marker NEWER than `since`, for at most `timeoutMs`.
	 *
	 * The marker file is never deleted, so it survives the whole run. Without the
	 * baseline a second interrupt would be "confirmed" instantly by the first
	 * interrupt's marker, while the child kept streaming — the tool would then
	 * report a stop that never happened.
	 */
	const awaitInterruptMarker = async (
		run: RunRecord,
		since: { interrupts: number; at: number },
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<InterruptConfirmation> => {
		const deadline = Date.now() + timeoutMs;
		// A marker that is valid but not newer than the baseline is the previous
		// interrupt's: it is worth reporting as stale rather than as silence.
		let stale: SubagentInterruptMarker | undefined;
		for (;;) {
			const marker = await readInterruptMarker(getInterruptFilePath(run.runDir), run.id);
			if (marker.ok) {
				const folded = await noteInterrupt(run, marker.marker, since);
				if (folded) return { state: "confirmed", marker: marker.marker };
				stale = marker.marker;
			}
			if (Date.now() >= deadline) return stale ? { state: "stale", marker: stale } : { state: "unconfirmed", aborted: false };
			if (signal?.aborted) return { state: "unconfirmed", aborted: true };
			await abortableDelay(INTERRUPT_POLL_MS, signal).catch(() => undefined);
		}
	};

	/**
	 * The child is gone: either its pane died, the tmux target no longer exists,
	 * or tmux cannot be reached at all. `unreachable` marks the last case, which
	 * says nothing about the child, so it must not be reported as an exit.
	 *
	 * Gives a result that raced in a moment earlier the last word before failing.
	 */
	const finalizeMissingChild = async (run: RunRecord, unreachable = false): Promise<void> => {
		tmuxFailures.delete(run.id);
		await abortableDelay(100, undefined);
		const late = await readChildResult(run);
		if (late) {
			await finalizeRun(run, late);
			return;
		}
		const reason = unreachable
			? `Child Pi could not be reached over tmux for ${MAX_TRANSIENT_TMUX_FAILURES} consecutive checks, so its state is unknown. Inspect: ${run.captureCommand}`
			: run.pane
				? `Child Pi exited before reporting a result.\n\n${run.pane}\n\nInspect: ${run.captureCommand}`
				: `Child Pi exited before reporting a result. Inspect: ${run.captureCommand}`;
		await markRunFailed(run, reason);
		void drainQueue();
	};

	const watchTick = async (run: RunRecord): Promise<void> => {
		timers.delete(run.id);
		if (shuttingDown) return;
		// An interrupted run is terminal for every consumer, but its child is alive
		// and may still finish, so the watcher keeps polling for a result.json. Every
		// other terminal status has nothing left to observe.
		if (isTerminal(run.status) && !holdsChild(run.status)) return;

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
				const clearedRequest =
					run.interruptRequestedAt !== undefined && observed.updatedAt > run.interruptRequestedAt;
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
					// A request the child plainly ignored: an activity snapshot newer
					// than the Escape proves the child kept (or resumed) working after
					// it. Otherwise the run advertises "not confirmed yet" for an Escape
					// that is now ancient, and subagent_interrupt's double-escape guard
					// reasons from a stale timestamp.
					if (clearedRequest) run.interruptRequestedAt = undefined;
					// Persist only what the summary actually renders, so a chatty
					// child does not rewrite runs.json twice a second.
					const signature = formatActivity(run.activity) ?? "";
					if (signature !== activitySignatures.get(run.id) || clearedRequest) {
						activitySignatures.set(run.id, signature);
						await persist();
					}
				}
			}
			// Its own try: a display problem must not be able to skip the interrupt
			// marker or the liveness checks that follow.
			try {
				observeRunStatus(run, observationFromRead(activity));
			} catch (error) {
				console.error(`[tmux-subagent] status update failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
			}

			// Turn-level interrupt (local patch 13). The child writes this marker on
			// an aborted settle instead of a result, so it is the only evidence that
			// the run was steered rather than finished. It is read after result.json
			// so a child that was interrupted and then completed still finalizes.
			// Read on every tick, including for an already-interrupted run: a child
			// that is driven again can be interrupted a second time, and noteInterrupt
			// makes a repeat read of the same marker a no-op.
			const marker = await readInterruptMarker(getInterruptFilePath(run.runDir), run.id);
			if (marker.ok) await noteInterrupt(run, marker.marker);

			const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", run.tmuxTarget), {
				timeout: 5_000,
			});
			if (paneResult.code === 0) {
				clearTmuxFailures(run);
				const pane = trimPane(paneResult.stdout);
				if (pane && pane !== run.pane) {
					run.pane = pane;
					await persist();
				}
			} else if (isMissingTmuxTarget(paneResult)) {
				// The session or pane is gone (killed by hand, or the tmux server
				// died). Treating that as "still running" re-armed this tick forever
				// and reported a child that no longer exists as interrupted.
				await finalizeMissingChild(run);
				return;
			}

			const dead = await pi.exec("tmux", tmuxArgs("display-message", "-p", "-t", run.tmuxTarget, "#{pane_dead}"));
			if (dead.code === 0) {
				clearTmuxFailures(run);
				if (dead.stdout.trim() === "1") {
					await finalizeMissingChild(run);
					return;
				}
			} else if (isMissingTmuxTarget(dead)) {
				await finalizeMissingChild(run);
				return;
			} else if (paneResult.code !== 0 && countTmuxFailure(run) >= MAX_TRANSIENT_TMUX_FAILURES) {
				// Neither tmux call could reach the target and neither said why (an
				// unreachable socket, a permission error, an unrecognised message).
				// Polling that forever is what stranded runs before; failing a healthy
				// child on the first hiccup would be worse. So it takes BOTH calls to
				// fail, MAX_TRANSIENT_TMUX_FAILURES ticks running.
				await finalizeMissingChild(run, true);
				return;
			}
		} catch (error) {
			// Transient tmux/exec errors are retried; only unexpected ones surface.
			// An interrupted run must not bail here: its child is still alive and
			// the watcher is the only thing that can still finalize it.
			if (isTerminal(run.status) && !holdsChild(run.status)) return;
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
			const piArgs = buildChildPiArgs({
				mode: run.mode ?? "standalone",
				invocation: getPiInvocationParts(),
				provider: run.provider,
				model: run.model,
				thinking: run.thinking,
				sessionDir: path.join(run.runDir, "session"),
				sessionFile: run.sessionFile,
				sessionId: run.id,
				tmuxSession: run.tmuxSession,
				trusted: run.trusted,
				extensionPath: EXTENSION_PATH,
				promptPath,
			});
			const childCommand = [
				"exec env",
				`${CHILD_ENV}=1`,
				`${RESULT_ENV}=${shellQuote(run.resultPath)}`,
				`${INTERRUPT_ENV}=${shellQuote(getInterruptFilePath(run.runDir))}`,
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
		// Show the run in the widget now rather than up to 500ms later on the first
		// watcher tick: "I started something" deserves an immediate answer.
		refreshStatusWidget();
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
			// An interrupted run keeps its watcher across a reload, otherwise a
			// result.json written after the reload could never finalize it.
			if (run.status === "running" || run.status === "interrupted") scheduleWatch(run);
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
		registerManagementTools();
		// Remember where the widget would live, but do not install it yet: pi
		// re-arms this extension on reload, and an idle session must not leave an
		// empty strip above the editor. The first live run installs it.
		if (ctx.mode === "tui") statusUi = ctx;
		refreshStatusWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		for (const timer of reapTimers.values()) clearTimeout(timer);
		reapTimers.clear();
		// The widget and its ticker are parent-session furniture: both must go when
		// the session does, or the ticker keeps the event loop alive (local patch 10).
		stopWidgetTimer();
		clearWidget();
		statusStates.clear();
		statusUi = undefined;
		for (const run of runs.values()) {
			if (killOnShutdown && holdsChild(run.status)) {
				run.status = "cancelled";
				run.finishedAt = Date.now();
				await killTmuxSession(run);
				continue;
			}
			// An interrupted child is reaped here even though holdsChild says it is
			// alive: an idle child at an abandoned prompt would otherwise outlive the
			// parent with no tool left that can reach it. Killing the tmux session
			// keeps the transcript, so the run stays resumable — exactly like the
			// auto-reap of a completed run.
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
			"Start a delegated task in a separate interactive Pi process inside a detached tmux session and return immediately. The main agent is not blocked and may start more subagents or keep working. Runs execute concurrently (bounded by PI_SUBAGENT_MAX_CONCURRENT, default 4); extra runs are queued. Children inherit the current provider/model/thinking, defaulting the provider to OpenRouter. Use subagent_status to inspect progress and collect results (subagent_status({ id }) returns that run's output once it finishes), subagent_interrupt to abort a run's current turn while keeping its child alive, and subagent_cancel to stop a run outright. There is no blocking wait: poll subagent_status. The other subagent tools (cancel, interrupt, resume, clean) are not declared while `codemode` or `tool_search` is active — call `tool_search` (or `tools.<name>(...)` in codemode) to reach them. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
		promptSnippet: "Start a delegated, non-blocking, tmux-backed Pi subagent",
		promptGuidelines: [
			"Use subagent to delegate an isolated task without blocking: it returns immediately, so start several when useful and keep working.",
			"Collect a finished run's output with subagent_status({ id }); there is no blocking wait, so poll it rather than blocking the turn.",
			"cancel, interrupt, resume and clean are not declared while codemode or tool_search is active: reach them with tool_search, or tools.<name>(...) in a codemode script.",
			"To stop a run that is going the wrong way, prefer subagent_interrupt (keeps the child and its transcript, then attach to steer it) over subagent_cancel (throws the run away). An interrupted run still occupies a concurrency slot until it is cancelled, so cancel the ones you are done with.",
			"subagent_resume needs a run whose child is really gone: cancel or finish it first, or attach to an interrupted run and type the follow-up there.",
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
			handoff: Type.Optional(
				StringEnum(HANDOFF_MODES, {
					description:
						"Context handoff for the child. 'standalone' (default) starts with no context. 'lineage' links the child to this session via its header but shares no context. 'fork' seeds the child with this conversation's live branch, so it already knows the task's background; the child's own usage is then counted separately from the inherited turns.",
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
			const mode = (params.handoff ?? "standalone") as LaunchMode;
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
				mode,
				attempt: 1,
			};
			run.trusted = isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted();
			updateTmuxCommands(run);

			await mkdir(runDir, { recursive: true, mode: 0o700 });
			await mkdir(path.join(runDir, "session"), { recursive: true, mode: 0o700 });
			await writeFile(path.join(runDir, "task.md"), `# Delegated task\n\n${params.task}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});

			// Snapshot the handoff now, while the parent's branch is the one the
			// user just asked about, rather than at launch once the run is dequeued.
			if (usesSessionFile(mode)) {
				await prepareHandoffSession(run, ctx);
			}

			await startRun(run);

			const queued = run.status === "queued";
			const text = [
				queued
					? `Subagent ${id} queued (${activeCount()}/${maxConcurrent} active; an interrupted run counts as active until it is cancelled).`
					: `Subagent ${id} started.`,
				`Model: ${run.provider}/${run.model} (${run.thinking})`,
				`tmux: ${run.tmuxSession}`,
				`Attach: ${run.attachCommand}`,
				`Capture: ${run.captureCommand}`,
				`Status: call subagent_status({ id: "${id}" }) to collect the result`,
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

	// The management tools, registered by `registerManagementTools` once the
	// runtime is bound and their exposure is known. `subagent` above is not: it is
	// the entry point, and it stays declared.
	const managementToolDefinitions: ToolDefinition[] = [
	{
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Collect a subagent result, or list this session's runs. With an id: that run's status, model, tmux attach command, its final output once finished and its latest pane output while running. Without an id: every run's status, duration and usage. There is no blocking wait, so poll this instead. Non-blocking.",
		promptSnippet: "Inspect non-blocking subagent runs and their output",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Run id to inspect. Omit to list all runs in this session." })),
			include_output: Type.Optional(
				Type.Boolean({
					description:
						"List view only. Include each finished run's full output. Defaults to false, because a list of many runs would otherwise carry every answer at once; inspecting a single id always returns its output.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const includeOutput = params.include_output ?? false;
			const runsArray = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
			if (params.id) {
				const run = runs.get(params.id.trim());
				if (!run) throw new Error(`Unknown subagent run: ${params.id}`);
				// This is the ONLY way to collect a result now that there is no blocking
				// wait, so the obvious call has to be the right one: `include_output`
				// is a LIST-view control and never suppresses the output here.
				//
				// The pane is included either way. For a live run it is the only view of
				// the child there is, and for a finished one it is usually the answer —
				// so gating it behind the flag would make `include_output: true` return
				// strictly less than the default call.
				return {
					content: [{ type: "text", text: runSummary(run, { pane: true, output: true }) }],
					details: { runs: [run] },
				};
			}
			if (runsArray.length === 0) {
				return { content: [{ type: "text", text: "No subagent runs in this session." }], details: { runs: [] } };
			}
			const text = runsArray
				.map((run) => {
					// An interrupted run has no final output yet but its pane is the
					// only view of the child's prompt, so it is shown like a live run.
					const live = run.status === "running" || run.status === "interrupted";
					return runSummary(run, { pane: live, output: includeOutput || live });
				})
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { runs: runsArray } };
		},
	},

	{
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
			// An interrupted run is terminal but still owns a live child, so cancel
			// must keep working for it: cancelling is how an interrupted child is
			// finally released.
			if (isTerminal(run.status) && !holdsChild(run.status)) {
				return { content: [{ type: "text", text: `Subagent ${id} is already ${run.status}.` }], details: run };
			}
			clearTimer(run.id);
			run.interruptRequestedAt = undefined;
			await pi.exec("tmux", tmuxArgs("kill-session", "-t", run.tmuxSession)).catch(() => undefined);
			run.status = "cancelled";
			run.finishedAt = Date.now();
			await persist();
			refreshStatusWidget();
			void drainQueue();
			return { content: [{ type: "text", text: `Subagent ${id} cancelled.` }], details: run };
		},
	},

	{
		name: "subagent_interrupt",
		label: "Subagent Interrupt",
		description:
			"Abort a subagent's current turn without killing it: sends Escape (pi's app.interrupt) to the child's pane, so the in-flight provider call and tool loop stop and the child sits idle at its prompt with its transcript and tmux session intact. The run becomes `interrupted` — still holding its concurrency slot and its tmux session until you subagent_cancel it. Use this to stop a run that is going the wrong way, then attach to steer it; use subagent_cancel when the run is simply unwanted. Note that subagent_resume is refused while the child is alive, because a second pi process would append to a transcript the child still holds. Returns as soon as the child confirms the aborted turn (default 3s), otherwise reports the request as sent but unconfirmed.",
		promptSnippet: "Abort a running subagent's turn while keeping the child alive",
		parameters: Type.Object({
			id: Type.String({ description: "Run id to interrupt." }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const id = params.id.trim();
			const run = runs.get(id);
			if (!run) throw new Error(`Unknown subagent run: ${id}`);
			if (run.status === "queued") {
				throw new Error(
					`Subagent ${id} has not started yet, so there is no turn to interrupt. ` +
						`Use subagent_cancel to drop it from the queue.`,
				);
			}
			// isTerminal && !holdsChild: a completed, failed or cancelled run has no
			// child left to steer. An interrupted one does, so Escape is sent again
			// (the child may have been typed into and started working again).
			if (isTerminal(run.status) && !holdsChild(run.status)) {
				return { content: [{ type: "text", text: `Subagent ${id} is already ${run.status}.` }], details: run };
			}

			// A second Escape within the double-escape window is not a second abort:
			// on an idle child pi treats two Escapes inside 500ms as the "double
			// escape action" and opens the tree selector (settings-manager.js
			// getDoubleEscapeAction defaults to "tree"), which blocks the child's
			// prompt without touching the turn.
			const lastRequest = run.interruptRequestedAt ?? 0;
			if (Date.now() - lastRequest < DOUBLE_ESCAPE_WINDOW_MS) {
				return {
					content: [
						{
							type: "text",
							text:
								`An interrupt for subagent ${id} was sent ${Math.round((Date.now() - lastRequest) / 100) * 100}ms ago and has not been confirmed yet; ` +
								`sending another Escape now would be read by the child as a double escape and open its tree selector. ` +
								`Check subagent_status first.`,
						},
					],
					details: run,
				};
			}

			// The marker file is never deleted, so the confirmation poll must ignore
			// anything already accounted for before this Escape.
			const baseline = { interrupts: run.interrupts ?? 0, at: run.interruptedAt ?? 0 };

			run.interruptRequestedAt = Date.now();
			await persist();

			// Escape, never C-c: `app.clear` is C-c and pressing it twice within
			// 500ms quits the child, which would throw the transcript away. `-l`
			// would send the literal word instead of the key, and a second
			// `send-keys Enter` would submit whatever the child had typed.
			const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "Escape"));
			if (sent.code !== 0) {
				run.interruptRequestedAt = undefined;
				await persist();
				throw new Error(sent.stderr.trim() || `Failed to send Escape to subagent ${id}.`);
			}

			// Escape is asynchronous: the child has to abort its provider stream and
			// settle before it can write the marker. Give it a moment to confirm so
			// the caller gets a definitive answer, then fall back to "requested" and
			// let subagent_status observe the marker later. A cancelled tool call is
			// reported the same way rather than thrown: the key was already sent, and
			// the tool's own cancellation says nothing about whether it landed.
			const outcome = await awaitInterruptMarker(run, baseline, interruptConfirmMs, signal);

			const lines =
				outcome.state === "confirmed"
					? [
							`Subagent ${id} interrupted.`,
							"The child aborted its current turn and is idle at its prompt; its session file is intact.",
							`Next: attach (${run.attachCommand}) to steer it, or subagent_cancel to stop it. It still holds its concurrency slot until then.`,
						]
					: outcome.state === "stale"
						? [
								`Escape sent to subagent ${id}, but no new interrupt was reported: the only marker present is the one from the previous interrupt${outcome.marker.interruptedAt ? ` at ${new Date(outcome.marker.interruptedAt).toISOString()}` : ""}.`,
								"The child either was idle (Escape does nothing then) or has not aborted yet. Attach to see, and use subagent_cancel to stop it.",
							]
						: [
								`Escape sent to subagent ${id}, but it did not confirm an interrupt within ${formatConfirmWindow(interruptConfirmMs)} (status is still ${run.status})${outcome.aborted ? ", and this tool call was cancelled" : ""}.`,
								"The child was probably already idle — Escape does nothing while it waits at its prompt — or it is stuck somewhere Escape does not reach. Attach with ${run.attachCommand} to look, and use subagent_cancel to stop it.",
							];
			return { content: [{ type: "text", text: lines.join("\n") }], details: run };
		},
	},

	{
		name: "subagent_resume",
		label: "Subagent Resume",
		description:
			"Continue a finished subagent conversation by id with a follow-up message. The child's existing session file is reopened and appended to, so it keeps its full prior context and the run is tracked as a new attempt with a fresh tmux session. Unlike a fork, no context is copied: this is the same child session, continued. Refused while the original child is still alive (running, queued or interrupted), because a second pi process appending to the same transcript would interleave branches — cancel the live run first, or attach to it and type the follow-up there.",
		promptSnippet: "Continue a finished subagent conversation with a follow-up message",
		parameters: Type.Object({
			id: Type.String({ description: "Run id to resume." }),
			message: Type.String({ description: "Follow-up instructions for the child." }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			await ensureSessionPaths(ctx);
			const message = params.message.trim();
			if (!message) throw new Error("Resume message must not be empty.");
			const previous = runs.get(params.id.trim());
			if (!previous) throw new Error(`Unknown subagent run: ${params.id.trim()}`);
			// holdsChild, not !isTerminal. Resume opens a SECOND pi process on the
			// transcript, so it is only safe once the first one is gone: an
			// interrupted run still has a live child holding that file open, and two
			// appenders interleave branches and scramble usage baselines. That is
			// exactly the trap the guard below protects against for two resumes, and
			// it is why an interrupted run is steered by attaching, not by resuming.
			if (holdsChild(previous.status)) {
				return {
					content: [
						{
							type: "text",
							text:
								`Subagent ${previous.id} still has a live child (${previous.status}); a second pi process would append to the same transcript. ` +
								`Attach (${previous.attachCommand}) and type the follow-up there, or subagent_cancel the run first and then resume it.`,
						},
					],
					details: previous,
				};
			}

			// The transcript outlives the tmux session, so the conversation is
			// still there. If it is not, fail loudly instead of letting pi
			// silently open an empty session.
			const sessionFile = requireExistingSession(previous.sessionFile, previous.id);

			// A finished run stays terminal forever, so nothing stops two resumes
			// of the same transcript from both passing the guard above. Two pi
			// processes appending to one JSONL produce interleaved branches and
			// scrambled usage baselines, so refuse while one is still in flight.
			const concurrent = [...runs.values()].find(
				(candidate) =>
					candidate.id !== previous.id && holdsChild(candidate.status) && candidate.sessionFile === sessionFile,
			);
			if (concurrent) {
				throw new Error(
					`Run ${concurrent.id} is already using this session file (${concurrent.status}). ` +
						`Wait for it to finish, or resume it instead of ${previous.id}.`,
				);
			}

			const id = randomUUID();
			const runDir = path.join(sessionRunsDir, id);
			const tmuxSession = tmuxSessionName(id);
			const run: RunRecord = {
				...previous,
				id,
				// The follow-up becomes this attempt's task; the original stays on the
				// ancestor record, which `resumeOf` points at. Appending instead
				// would grow the field without bound across attempts.
				task: message,
				tmuxSession,
				tmuxTarget: `${tmuxSession}:0.0`,
				attachCommand: "",
				captureCommand: "",
				killCommand: "",
				runDir,
				resultPath: path.join(runDir, "result.json"),
				status: "queued",
				createdAt: Date.now(),
				startedAt: undefined,
				finishedAt: undefined,
				pane: undefined,
				output: undefined,
				error: undefined,
				usage: undefined,
				activity: undefined,
				// Interrupt history belongs to the run that owns it: a fresh child was
				// never sent an Escape, and inheriting the counters would make
				// subagent_status report an interrupt for an attempt that had none.
				interrupts: undefined,
				interruptedAt: undefined,
				interruptRequestedAt: undefined,
				mode: "resume",
				resumeOf: previous.id,
				attempt: (previous.attempt ?? 1) + 1,
				sessionFile,
			};
			updateTmuxCommands(run);

			await mkdir(runDir, { recursive: true, mode: 0o700 });
			await mkdir(path.join(runDir, "session"), { recursive: true, mode: 0o700 });
			await writeFile(path.join(runDir, "task.md"), `# Delegated task\n\n${message}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			// Only the child's new turns are charged to this attempt.
			run.usageFromLine = await countSessionLines(sessionFile);

			await startRun(run);

			const lines = [
				`Resumed subagent ${previous.id} as ${id} (attempt ${run.attempt}).`,
				`Follow-up: ${message.split("\n", 1)[0] ?? message}`,
				`Session: ${sessionFile}`,
				`Attach: ${run.attachCommand}`,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: run };
		},
	},

	{
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
			let deletedTranscripts = 0;
			const retained: string[] = [];
			for (const run of targets) {
				// holdsChild, not !isTerminal: cleaning up must never kill an
				// interrupted run's child, which still holds the resumable session.
				if (holdsChild(run.status)) {
					skipped++;
					continue;
				}
				if (run.finishedAt && run.finishedAt > cutoff) {
					skipped++;
					continue;
				}
				// A resumed run keeps its transcript in its ANCESTOR's run dir, so
				// deleting that dir would pull the file out from under a run that
				// may still be running. pi holds the descriptor open, so the child
				// would keep writing to an unlinked inode and lose every entry
				// silently. Leave the dir alone and say so.
				if (deleteFiles && run.runDir && runDirOwnsLiveTranscript(run, runs)) {
					retained.push(run.id);
					skipped++;
					continue;
				}
				updateTmuxCommands(run);
				await killTmuxSession(run);
				killed++;
				if (deleteFiles && run.runDir) {
					// Auto-reap only kills tmux, so the transcript normally
					// outlives the run and stays resumable. Deleting the run dir
					// destroys it, so say so rather than losing a conversation
					// the user may still want to resume.
					if (run.sessionFile && existsSync(run.sessionFile) && isSameOrDescendant(run.runDir, run.sessionFile)) {
						deletedTranscripts++;
					}
					await rm(run.runDir, { recursive: true, force: true }).catch(() => undefined);
					deleted++;
					if (runs.get(run.id) === run) runs.delete(run.id);
				}
			}
			if (deleteFiles) await persist();
			const summary = [`Cleaned ${killed} tmux session(s), deleted ${deleted} run dir(s), skipped ${skipped}.`];
			if (deleteFiles && deletedTranscripts > 0) {
				summary.push(
					`Also deleted ${deletedTranscripts} child session transcript(s); those runs can no longer be resumed.`,
				);
			}
			if (retained.length > 0) {
				summary.push(
					`Kept ${retained.length} run dir(s) that still hold the session file of a live run: ${retained.join(", ")}.`,
				);
			}
			return {
				content: [{ type: "text", text: summary.join("\n") }],
				details: { killed, deleted, skipped, deletedTranscripts },
			};
		},
	},
	];
}

// Internals exposed for unit tests. See local patch 9 in the header comment.
// Nothing here is used by the extension at runtime.
export const __test__ = {
	abortableDelay,
	attachFlagValue,
	findLastAssistant,
	formatDuration,
	holdsChild,
	isMissingTmuxTarget,
	isSameOrDescendant,
	isTerminal,
	readBooleanEnv,
	readIntEnv,
	readNonNegativeIntEnv,
	resolveManagementExposure,
	resolveModel,
	runDirOwnsLiveTranscript,
	runSummary,
	shellQuote,
	startRepeatingRefresh,
	statusDetail,
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
