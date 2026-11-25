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
//     registerManagementTools): the six management tools — status, wait, cancel,
//     interrupt, resume, clean — are registered at `session_start` and again at
//     `before_agent_start` with pi's
//     `exposure: "codemode"` when `codemode` or `tool_search` is active, so their
//     descriptions, schemas, snippets and guidelines stop riding along on requests
//     that never use them. `subagent` itself stays declared: it is the entry point,
//     and a model that cannot start a run has no reason to search for the tools
//     that manage one. Registration is deferred because pi's getActiveTools()
//     throws during extension load, so the question cannot be asked earlier — and
//     re-registering later would NOT work, because pi declares the ACTIVE set and a
//     tool activated on registration stays active. Re-checked before every agent
//     turn, because `/tools` can switch discovery off and strand tools that were
//     registered hidden.
// 16. Bounded list output (see listview.ts): status is the live view, and a
//     model that polls it pays for the list on every turn, so the list view is a
//     per-turn cost rather than an occasional one. It used to render
//     PANE_PREVIEW_LINES of raw pane for EVERY live run (~70 lines at the default
//     concurrency, mostly a TUI redrawing itself). Now the budget is on the LIST,
//     not per run: at most LIST_DETAIL_BUDGET runs get the full block and every
//     other run gets one line — id, status, elapsed, usage — which is what a poll
//     needs to decide what to inspect. A `compact` flag drops the detail blocks
//     entirely. Three rules keep it honest: the budget goes to the runs that hold
//     a pane (`showsPane`, newest first — `queued` has no child and is always the
//     newest, so admitting it would spend the budget on nothing); a row carries
//     the one note that cannot be re-fetched (a failure reason, an interrupted
//     run's attach command); and when `include_output` had to leave an answer out,
//     the reply says so. The single-run path is untouched — it is the collection
//     path, and no flag may make it cheaper. With one or two runs in the session
//     the output is unchanged.
//
// 17. Click-to-open panel (see panel.ts and popup.ts): a click on a live run's widget row
//     opens a tmux popup over pi's client that runs a nested `tmux attach`
//     client against the subagent server. panel.ts builds the argv and the
//     quoting (pure, unit-tested), popup.ts the launcher and the shared
//     window/client probe; `openSubagentPanel` here does the guards and the
//     launch. The guards matter as much as the launch: the run must still
//     show a pane (`showsPane`, so a queued run is told to wait rather than
//     handed a popup with nothing in it) and an interrupted one is still
//     openable; pi must itself be inside tmux, on a server OTHER than the
//     subagent one, and a client viewing pi's pane must exist. All clients are
//     listed and filtered by the pane's window, then the most recently active
//     one is passed as `-c <client>` to display-popup: tmux's own `-t <pane>`
//     client resolution falls back to the most recently active client on the
//     pane's session (not the window), and `list-clients -t <session>` misses a
//     client viewing a grouped session linked to the same window. `-c` also
//     validates the target. Only then is the Escape binding applied and the
//     popup launched detached and unref'd — never awaited, because tmux's
//     display-popup CLI blocks until the popup closes, and never held as a
//     child handle, because that would keep pi alive after the panel closed.
//     The popup command unbinds Escape when it exits: the binding is in the
//     subagent server's root table, so left in place it would swallow Escape for
//     every client of that server for the server's lifetime, including a direct
//     `pi --attach-subagent` session.
// 18. Validated child results (see result.ts): `result.json` is a file protocol
//     spoken across extension versions — a child may run a different build from
//     its parent (trusted-copy resolution, another branch's checkout) — so the
//     watcher validates it instead of casting the parse. Before, a child that
//     renamed `output` made `finalizeRun` throw inside every tick: the error was
//     logged, the tick rescheduled, and the run stayed `running` forever while
//     its result was never consumed. The shape (status, output, the optional
//     strings, finishedAt) is the gate; `version` is advisory and is quoted when
//     a shape failure is likely skew, so a newer protocol version with a
//     compatible shape still reports instead of being thrown away. An unusable
//     read is not failed on sight either: partial writes and transient errnos
//     are retried up to MAX_TRANSIENT_RESULT_FAILURES consecutive ticks, and a
//     good result at any point still wins.
//
// 19. Wait tool (`subagent_wait`): it blocks once until the named run(s) reach
//     a terminal state. With `id` it returns the same record
//     `subagent_status({ id })` returns; with `ids` too, except that a settled
//     run whose child is gone returns its output and no pane — a dead TUI frame
//     at that point, and one per child would recreate the context cost this
//     tool removes. Only a live child (running or interrupted) carries a pane,
//     as in the status list; the record retains the last snapshot, so
//     `subagent_status({ id })` can still show it. On timeout it returns the
//     current record plus the latest pane, never an error (a run still queued
//     is reported as `queued`). It adds NO second poll loop: waiters are
//     resolved by the
//     terminal transitions the existing settle watcher — and cancel, interrupt
//     and shutdown — already drive (`settleWaiters`/`notifyWaiters`), so the
//     500 ms watcher cadence is the only latency. The tool descriptions that
//     used to teach polling now teach "start, then wait once"; `subagent_status`
//     stays for the live "what is it doing right now" question.
//
// 20. Report artifact (see report.ts): every child is asked to end with a
//     fenced `subagent-report` envelope (status/summary/files/commands/
//     unresolved), and the child adds it to `result.json` as the optional
//     `report` field. When a run reports a final answer (completed or failed) the
//     parent writes the child's complete final text to `<runDir>/report.md` and
//     stores a bounded copy (`head`, the
//     envelope fields) plus the path and full byte count in `RunRecord.report`.
//     `output` keeps its exact previous meaning and truncation, so a reader
//     built before the artifact still works. Missing, malformed and skew-shaped
//     reports degrade to the plain text with `degradation` set; none of them can
//     fail a run. The pointer is what `subagent_status` and `runs.json` expose,
//     so the full report is one file read away without parsing a transcript.
//
// 21. Fan-out and dependency plans (see plan.ts, plus `advancePlanForRun`,
//     `reconcileLoadedPlans` and the cancel path here): one `subagent` call can
//     launch several children as a plan with per-step overrides and
//     `dependsOn` edges, sharing the standalone concurrency queue. Plan records
//     are persisted BESIDE the runs (`plans.json`) because one plan owns several
//     runs and outlives each of them. THREE places settle a step, and a fourth
//     invented in passing is how a plan wedges: the existing settle path, the
//     cancel path (a cancel produces no `result.json`, so the finaliser never
//     sees it), and one-shot load reconciliation. `runs.json` and `plans.json`
//     are two renames under one chain, so a crash between them leaves the plan
//     index OLDER than the run index; reconciliation therefore adopts a run the
//     plan has no record of, folds in a settlement the plan missed, and leaves a
//     step alone only while its run is queued/running/interrupted — the
//     statuses whose child can outlive a parent reload and for which the watcher
//     re-arms. Only a step with no live run is reported interrupted, never
//     complete. A plan id resolves through the management tools as well:
//     `subagent_wait({ plan })` (later waves have no run ids to name),
//     `subagent_status({ id })` and `subagent_cancel({ id })`. The status list
//     shows a plan as ONE row with its step runs folded into it, so a ten-step
//     plan cannot spend the list's detail budget ten times.
//
// 22. Typed orchestration events (see `../orchestrator/events.ts`): a run that
//     reports a final answer publishes `orchestrator:run-settled`, and a plan
//     that becomes terminal publishes `orchestrator:plan-settled` once. The
//     bus lives with the settlement gate, which is its first consumer; the
//     publisher is total, so a subscriber cannot affect a run or a plan. The
//     event is published after the state is persisted, so a subscriber that
//     reads `runs.json`/`plans.json` sees the settlement it was told about.
//
// 23. Escalated questions (see escalation.ts): a child can ask its parent a
//     blocking question and receive the answer as its tool result, or send a
//     non-blocking progress update. The channel is a pair of atomic files per
//     request id under `<runDir>/escalation/`, and it is a file protocol across
//     builds like `result.json`/`interrupt.json`, so the shape is the gate and
//     the version is advisory. Three rules carry the feature and are easy to
//     undo by accident:
//       - The child registers `subagent_ask` ONLY in child mode and ONLY when
//         the parent named a channel (`PI_TMUX_SUBAGENT_ESCALATION`), so a
//         parent turn pays nothing for a tool it can never call; a child of an
//         older parent registers nothing and simply cannot ask.
//       - The parent polls the channel from the watcher tick it already runs
//         (no second timer), surfaces a question as a session message and on
//         `RunRecord.pendingRequest`, and refreshes a heartbeat while anything
//         waits. The human gate lives in `subagent_answer` — a normal tool call
//         that uses `ctx.ui.confirm` — never in the tick, which runs mid-run.
//         With no UI the answer is REFUSED and the child times out: a model
//         answering its own child's decision is the failure mode, not the
//         feature.
//       - Every non-answer exit (deadline, no parent, aborted turn) tells the
//         child to report the blocker and its partial result and stop, and it
//         can never hang: the deadline bounds the wait, the parent's heartbeat
//         catches a shut-down parent in seconds, and the tool's own signal ends
//         it at once. A blocked child still holds its concurrency slot, and
//         `subagent_status` says so as "waiting on a question", distinctly from
//         a stalled or interrupted run.
//
// The child reporter (CHILD_ENV) still reports completion the same way; patch 11
// only adds the activity snapshot to it, patch 13 only diverts the aborted
// settle onto the marker, patch 20 adds the report field, patch 22 adds the two
// events, and patch 23 adds the asking tool.

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
	getPiInvocationParts,
	requireExistingSession,
	resolveChildExtensionPath,
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
	clearEscalationHeartbeat,
	consumeEscalationExchange,
	DEFAULT_QUESTION_GRACE_MS,
	DEFAULT_QUESTION_TIMEOUT_MS,
	ESCALATION_VERSION,
	escalationDir,
	listEscalationRequests,
	readEscalationReply,
	readEscalationRequest,
	replyPath,
	touchEscalationHeartbeat,
	waitForEscalationReply,
	writeEscalationReply,
	writeEscalationRequest,
	type EscalationRequest,
	type PendingQuestion,
} from "./escalation.ts";
import {
	advanceStatusState,
	classifyStatus,
	createStatusState,
	DEFAULT_STALL_AFTER_MS,
	DEFAULT_TOOL_STALL_AFTER_MS,
	formatElapsedDuration,
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
import { CHILD_RESULT_VERSION, readChildResultFile, type ChildResult } from "./result.ts";
import {
	buildChildTaskPrompt,
	buildRunReport,
	parseChildReportText,
	readReportHead,
	REPORT_FILE_NAME,
	resolveChildReport,
	writeReportArtifact,
	type ChildReportValidation,
	type ReportHead,
	type RunReport,
} from "./report.ts";
import { renderRunList, runHeadline, type ListRow } from "./listview.ts";
import { buildEscapeBindArgs, buildPanelLaunch } from "./panel.ts";
import {
	buildPlan,
	cancelPlan,
	cancelPlanStep,
	failPlanStep,
	markStepLaunched,
	queuedStopCandidates,
	readyStepIds,
	reconcilePlan,
	settlePlanStep,
	type FailurePolicy,
	type PlanRecord,
	type PlanStepRun,
	type PlanStepSpec,
	type PlanStepState,
} from "./plan.ts";
import { currentTmuxPointer, currentTmuxSocket, defaultPanelLauncher, resolvePaneClient, type PanelLauncher } from "./popup.ts";
import { shellQuote } from "./shell.ts";
import { ORCHESTRATION_EVENTS, publishOrchestrationEvent } from "../orchestrator/events.ts";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_TMUX_SUBAGENT_CHILD";
const RESULT_ENV = "PI_TMUX_SUBAGENT_RESULT";
/** Marker path the child writes when a turn was interrupted (local patch 13). */
const INTERRUPT_ENV = "PI_TMUX_SUBAGENT_INTERRUPT";
/**
 * The escalation channel directory, or nothing (local patch 23).
 *
 * Presence is the handshake: a parent that sets it has a watcher tick that reads
 * requests, so the child registers the asking tool. An older parent does not set
 * it and the child registers nothing — the feature degrades to "a child cannot
 * ask", which is exactly what an older parent can support.
 */
const ESCALATION_ENV = "PI_TMUX_SUBAGENT_ESCALATION";
/** Custom message type for a pending question delivered to the parent session. */
const QUESTION_MESSAGE_TYPE = "subagent-question";
/** Custom message type for a child's non-blocking progress update. */
const PROGRESS_MESSAGE_TYPE = "subagent-progress";
const RUNS_DIR = "tmux-subagents";
const POLL_INTERVAL_MS = 500;
const TMUX_EXEC_TIMEOUT_MS = 5_000;
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
/**
 * Default bound for one `subagent_wait` call (local patch 19).
 *
 * Long enough that a real delegation rarely times out, short enough that a model
 * that mistyped an id is not blocked for a whole session. A timed-out wait is a
 * normal result, never an error.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
/**
 * How long a child's blocking question waits for an answer (local patch 23).
 *
 * Long enough for a human to notice the parent's question, short enough that an
 * unattended parent does not hold a concurrency slot for an hour. Overridable
 * through `PI_SUBAGENT_QUESTION_TIMEOUT_SECONDS`.
 */
const DEFAULT_QUESTION_TIMEOUT_SECONDS = DEFAULT_QUESTION_TIMEOUT_MS / 1000;
/**
 * How long a blocked child accepts parent silence before giving up.
 *
 * The parent rewrites its heartbeat on every 500 ms watcher tick while a request
 * is pending, so this is ten missed ticks: enough not to fire on a slow tick,
 * short enough that a shut-down parent is noticed in seconds.
 */
const DEFAULT_QUESTION_GRACE_SECONDS = DEFAULT_QUESTION_GRACE_MS / 1000;
/** Widget key, so pi can replace and clear our widget without touching others. */
const WIDGET_KEY = "subagent-status";

/** How many consecutive unclassifiable tmux failures mean the child is gone. */
const MAX_TRANSIENT_TMUX_FAILURES = 3;
/**
 * How many consecutive unusable `result.json` reads mean the file will never
 * parse.
 *
 * Not one: a child from another build may publish the file non-atomically, and a
 * read can land mid-write; `EMFILE`, `ESTALE` and a permission blip look the same
 * as bad bytes. Only a run of them distinguishes "caught it in flight" from
 * "this file is unusable", and the same policy already governs tmux failures. A
 * missing file and a usable one both clear the count, so a good result still wins
 * at any point.
 */
const MAX_TRANSIENT_RESULT_FAILURES = 3;
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

/**
 * The `subagent` tool's description, as a value because `prepareLoadout` appends
 * to it when — and only when — the management tools are hidden from the model.
 */
const SUBAGENT_DESCRIPTION =
	"Start a delegated task in a separate interactive Pi process inside a detached tmux session and return immediately. The main agent is not blocked and may start more subagents or keep working. Runs execute concurrently (bounded by PI_SUBAGENT_MAX_CONCURRENT, default 4); extra runs are queued. Children inherit the current provider/model/thinking, defaulting the provider to OpenRouter. Start the run, then wait once: subagent_wait({ id }) blocks until that run settles and returns its record (subagent_wait({ ids }) waits for a fan-out together, and subagent_wait({ plan }) waits for a whole dependency plan). Keep subagent_status for the live 'what is it doing right now' question, subagent_interrupt to abort a run's current turn while keeping its child alive, and subagent_cancel to stop a run outright — or a whole plan when given a plan id. For a fan-out or a dependency plan, pass `tasks` with per-step overrides (task, cwd, provider, model, thinking, handoff, dependsOn, retries), an optional failurePolicy (continue by default, or stop) and retryLimit; the runs share the same concurrency budget and come back in the requested order. A plan is persisted: reload the session and it resumes at the first unfinished step without re-running a completed one. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.";

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
	/**
	 * The child's final report, as the parent could read it (report.ts): a pointer
	 * to the standalone artifact, a bounded copy of its head, and the envelope's
	 * own fields when they parsed. Persisted in `runs.json`, so a consumer that
	 * never opens the artifact still works.
	 */
	report?: RunReport;
	/** The dependency plan this run's step belongs to, if it was a fan-out step. */
	planId?: string;
	/** The step inside that plan this run is one attempt of. */
	stepId?: string;
	/**
	 * Whether this run's child was given an escalation channel (local patch 23).
	 *
	 * Absent or false means the run predates the channel, or was recorded by a
	 * build that did not launch one; the watcher then does not poll a channel
	 * directory that can never hold anything.
	 */
	escalation?: boolean;
	/**
	 * A child's question that still needs a human-confirmed answer.
	 *
	 * Persisted in `runs.json` rather than derived from the channel directory: it
	 * is what `subagent_status` renders as "waiting on a question" (distinctly from
	 * a stalled or interrupted run), what `subagent_answer` finds by request id, and
	 * what survives a reload with the run it belongs to.
	 */
	pendingRequest?: PendingQuestion;
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

// This extension owns its own tmux server: one socket in the agent dir, and the
// reserved `pi-agent-*` session-name space. The vendored tmux skill
// (.pi/skills/tmux/) drives interactive CLIs on a SEPARATE socket under
// PI_TMUX_SOCKET_DIR (default ${TMPDIR:-/tmp}/pi-tmux-sockets) with `pi-<slug>`
// names, and documents this socket and name space as off-limits. Keep the two
// sockets distinct: sharing one would let the skill's `kill-server` take down
// every running child.
function tmuxSocketPath(): string {
	return path.join(getAgentDir(), "tmux-subagents.sock");
}

function tmuxSessionName(sessionId: string): string {
	return `pi-agent-${sessionId}`;
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
}

function attachToSubagentAndExit(rawTarget: string): never {
	const target = rawTarget.trim();
	if (!target) {
		console.error(`Error: --${ATTACH_FLAG} requires the session id printed by the subagent tool.`);
		process.exit(2);
	}

	let socket = tmuxSocketPath();
	let session: string;
	// LEGACY, kept with no expiry gate: session targets recorded before this
	// extension printed session-id targets. No current code path produces a
	// `v1.` blob — attachCommand is always `--attach-subagent <run.id>`, and
	// run.id is a UUID — so this branch only fires on a hand-typed or very old
	// recorded target. Left in place rather than removed because the file stays
	// close to upstream; the cut-off is noted here so a reader does not mistake
	// it for live plumbing.
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
function runDirOwnsLiveTranscript(run: RunRecord, runs: ReadonlyMap<string, RunRecord> | Iterable<RunRecord>): boolean {
	if (!run.runDir) return false;
	const candidates = runs instanceof Map ? runs.values() : runs;
	for (const other of candidates) {
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
	let abortedTurn: { stopReason?: string } | undefined;

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
		// The child parses its own envelope while it still has the text; the
		// parent validates it again (report.ts). Omitted when the child did not
		// end with a usable block — the text is still in `output`, and an older
		// parent ignores the field entirely.
		const parsedReport = parseChildReportText(output);
		const result: ChildResult = {
			version: CHILD_RESULT_VERSION,
			status: failed ? "failed" : "completed",
			output,
			error: fallbackError ?? assistantError ?? (!assistant ? "Subagent exited without an assistant response." : undefined),
			stopReason,
			sessionFile: ctx.sessionManager.getSessionFile(),
			provider: typeof assistant?.provider === "string" ? assistant.provider : ctx.model?.provider,
			model: typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
			thinking: pi.getThinkingLevel(),
			finishedAt: Date.now(),
			...(parsedReport.ok ? { report: parsedReport.report } : {}),
		};

		try {
			// Ownership (the second defence against the nested-pi hijack; the first
			// is the env scrub in the child branch above). result.json belongs to the
			// run's own child, and the record carries the writer's sessionFile, so a
			// record naming a DIFFERENT session was written by someone else — an
			// impostor's finished record must not be replaced. An unusable read
			// (missing, partial, corrupt) is not a finished record, so a good result
			// still publishes over it, and the run's own file is always writable by
			// its child. The one-shot `reported` latch is what makes "overwrite when
			// the session matches" safe: this child reports at most once.
			const existing = await readChildResultFile(resultPath);
			const writer = ctx.sessionManager.getSessionFile();
			if (existing.ok && existing.result.sessionFile !== writer) {
				console.error(
					`[tmux-subagent] ${resultPath} already holds a record from ${existing.result.sessionFile ?? "an unknown session"}; not replacing it with a report from ${writer}`,
				);
				return;
			}
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

/**
 * What a blocked child is told when no answer arrives (local patch 23).
 *
 * The point of the escalation channel is that a decision comes from a HUMAN. A
 * model answering its own child's decision request is the failure this text
 * exists to prevent, so every exit that is not an answer ends the same way: stop,
 * say what blocked you, and leave a readable partial result. The envelope is the
 * one from report.ts, whose `blocked` status is distinct from `failed` because
 * nothing here went wrong — a decision was simply not available.
 */
const ESCALATION_FAILURE_INSTRUCTION =
	"Do not wait again and do not guess an answer yourself." +
	" Report the blocker and everything you did complete, then stop:" +
	' end with a ```subagent-report block whose status is "blocked", and put the open question in `unresolved`.';

/**
 * Register the child's escalation tools (local patch 23).
 *
 * Only ever called in child mode, and only when the parent gave this child a
 * channel (ESCALATION_ENV). Everything it needs — the channel directory, the run
 * id the parent verifies, the deadline and the no-parent grace — is passed in, so
 * this registers nothing on the parent and costs a parent turn nothing.
 *
 * A blocking call here holds the child's TURN, not the parent: the parent keeps
 * whatever it was doing, its watcher delivers the question to the session, and a
 * human-confirmed `subagent_answer` writes the reply this call is polling for. It
 * is the one deliberate exception to "delegation is non-blocking".
 */
function registerChildEscalation(
	pi: ExtensionAPI,
	options: { dir: string; runId: string; timeoutMs: number; graceMs: number },
): void {
	pi.registerTool({
		name: "subagent_ask",
		label: "Subagent Ask",
		description:
			"Ask the parent session a question and WAIT for the answer, or send it a progress update without waiting. A question is delivered to the parent, surfaces to the human there, and comes back as this tool's result — usually the same turn, but a person has to answer it, so it can take a while. A decision is never answered by a model: if no human is available the answer is refused and this call ends with instructions to report the blocker. Call this when the task genuinely cannot continue without a choice or a missing fact; do not use it to ask permission for a step the task already authorises.",
		promptSnippet: "Ask the parent (a human) a blocking question, or send it a progress update",
		parameters: Type.Object({
			question: Type.String({
				description:
					"The question, stated so it can be answered in one or two sentences. With kind 'progress', the update to send instead (no answer comes back).",
			}),
			kind: Type.Optional(
				StringEnum(["question", "progress"] as const, {
					description:
						"'question' (default) blocks until the parent answers. 'progress' is fire-and-forget: it is delivered to the parent session and this call returns at once.",
				}),
			),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Suggested answers shown to the human, e.g. [\"Postgres\", \"SQLite\"]. Optional, and never binding: the human may answer anything. Questions only.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const kind = params.kind === "progress" ? "progress" : "question";
			const text = params.question?.trim() ?? "";
			if (!text) {
				return escalationToolResult(`subagent_ask needs a non-empty question${kind === "progress" ? " (or progress message)" : ""}.`, {
					outcome: "rejected",
				});
			}
			const id = `ask-${randomUUID()}`;
			const askedAt = Date.now();
			const request: EscalationRequest = {
				version: ESCALATION_VERSION,
				id,
				runId: options.runId,
				kind,
				text,
				...(kind === "question" && params.options && params.options.length > 0 ? { options: params.options } : {}),
				askedAt,
				...(kind === "question" ? { deadlineAt: askedAt + options.timeoutMs } : {}),
			};
			try {
				await writeEscalationRequest(options.dir, request);
			} catch (error) {
				// The shape was refused (an oversized question, an unusable id) or the run
				// dir is not writable. Either way the parent will never see it, so saying
				// "sent" would be a lie.
				return escalationToolResult(
					`Could not send this to the parent: ${error instanceof Error ? error.message : String(error)}`,
					{ outcome: "failed", id },
				);
			}
			if (kind === "progress") {
				return escalationToolResult(
					"Progress update delivered to the parent session. It needs no answer: carry on with the task.",
					{ outcome: "delivered", id },
				);
			}

			const outcome = await waitForEscalationReply({
				dir: options.dir,
				id,
				runId: options.runId,
				deadlineAt: request.deadlineAt ?? askedAt,
				signal,
				graceMs: options.graceMs,
			});

			if (outcome.state === "aborted") {
				// The turn is being aborted, so there is nothing to continue with; the
				// request is left in place for the run dir's history rather than consumed.
				throw new Error("subagent_ask was cancelled before the parent answered.");
			}
			if (outcome.state === "answered") {
				// Consumed here, once: the request and reply both go, so a replay of these
				// bytes can never answer this child twice.
				await consumeEscalationExchange(options.dir, id).catch(() => undefined);
				return escalationToolResult(
					`Answer from the parent (confirmed by a human): ${outcome.answer}\n\nContinue with the task, or stop if the answer says so.`,
					{ outcome: "answered", id },
				);
			}
			await consumeEscalationExchange(options.dir, id).catch(() => undefined);
			const why =
				outcome.state === "expired"
					? `No answer arrived within ${Math.round(options.timeoutMs / 1000)}s (the request's deadline).`
					: `No parent session is there to answer: ${outcome.detail}.`;
			return escalationToolResult(`${why} ${ESCALATION_FAILURE_INSTRUCTION}`, { outcome: outcome.state, id });
		},
	});
}

/** One tool result for `subagent_ask`, with a `details` shape that never varies. */
function escalationToolResult(
	text: string,
	details: { outcome: string; id?: string },
): { content: { type: "text"; text: string }[]; details: { outcome: string; id?: string } } {
	return { content: [{ type: "text", text }], details };
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
 * The wait bound for one `subagent_wait` call (local patch 19).
 *
 * A zero or negative bound means "check once and return the current state": a
 * timed-out wait is a result rather than an error, so an unusable number
 * degrades to that instead of throwing or silently waiting out the default.
 */
function resolveWaitTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
	// setTimeout clamps anything above 2^31-1 to 1 ms, which would report a
	// 24-day wait as an instant timeout.
	return Math.min(timeoutMs, 2_147_483_647);
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

/**
 * Whether an interrupt marker is NEWER than the baseline captured just before an
 * Escape was sent.
 *
 * Confirmation is decided by this, never by whether `noteInterrupt` changed the
 * record. The watcher folds the same marker on its 500ms tick, so if it gets
 * there first `noteInterrupt` reports "no change" for an interrupt that
 * genuinely landed — the tool would then call a real stop "stale". A marker that
 * is not newer than the baseline is the PREVIOUS interrupt's, because the marker
 * file is never deleted (local patch 13).
 */
function markerIsNewerThan(marker: SubagentInterruptMarker, since: { interrupts: number; at: number }): boolean {
	return marker.interrupts > since.interrupts || marker.interruptedAt > since.at;
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
		case "question":
			return "waiting on a question";
		default:
			return "starting";
	}
}

/** Feed the classifier from the activity read: the snapshot, or why there is none. */
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
 * True when a run has a pane worth SHOWING: a child that is running, or one that
 * was interrupted and is sitting at its prompt with its transcript intact.
 *
 * Narrower than `holdsChild`, which also counts `queued` — a queued run has no
 * child and therefore no pane, and nothing to show beyond its queue position.
 * The list view's detail budget goes to these runs (local patch 16); `queued`
 * being the newest runs in a session is exactly why admitting it there would
 * hand the budget to the runs with nothing to say.
 */
function showsPane(status: RunStatus): boolean {
	return status === "running" || status === "interrupted";
}

// A module-level binding rather than a direct call so the tests never start a
// real popup (`__test__.setPanelLauncher`, local patch 9). The extension reads
// it at click time, so a test can substitute it without reloading the factory.
// The launcher itself is shared with `/btw` (see popup.ts).
let panelLauncher: PanelLauncher = defaultPanelLauncher;

/** The slice of the extension `openSubagentPanel` needs, so the guards can be tested without a TUI. */
interface OpenPanelDeps {
	/** The context to notify through; undefined outside the TUI. */
	ui: ExtensionContext | undefined;
	getRun: (runId: string) => RunRecord | undefined;
	isShuttingDown: () => boolean;
	exec: ExtensionAPI["exec"];
	launch: PanelLauncher;
}

/**
 * Open a tmux popup attached to a live run's pane (local patch 17).
 *
 * Every guard below exists because the failure it prevents is silent or
 * confusing: a popup over a nonexistent run, a popup with no pane to show, a
 * popup with no attached client to draw over, or a popup that flashes open and
 * immediately closes because the session is gone. The popup itself is launched
 * last and never awaited — it blocks until closed.
 */
async function openSubagentPanel(deps: OpenPanelDeps, runId: string): Promise<void> {
	const ui = deps.ui;
	if (!ui || ui.mode !== "tui" || deps.isShuttingDown()) return;
	const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => ui.ui.notify(message, type);
	const short = runId.slice(0, 8);

	const run = deps.getRun(runId);
	if (!run || !holdsChild(run.status)) {
		// Completed, failed, cancelled or unknown: the child (and its pane) is gone.
		// NOT `isTerminal`, which also counts `interrupted` — that run is sitting at
		// a prompt with a pane, and `showsPane` below admits it.
		notify(`Subagent ${short} is no longer running.`);
		return;
	}
	if (!showsPane(run.status)) {
		// Only `queued` reaches here: it holds a slot but has no child and no pane.
		notify(`Subagent ${short} is still queued for a slot — there is no pane to open yet.`);
		return;
	}

	const outer = currentTmuxPointer();
	if (!outer) {
		notify(`Not running inside tmux. Attach with: ${run.attachCommand}`);
		return;
	}
	const socket = tmuxSocketPath();
	// A pi running inside a subagent pane has currentTmuxSocket() === the subagent
	// socket; the global Escape binding would then land on pi's own server.
	if (outer.socket === socket) {
		notify("The panel is not available from inside a subagent pane.");
		return;
	}

	// The client has to be one actually looking at the pane; popup.ts explains
	// why the window filter, not `-t <session>`, is what finds it.
	const resolved = await resolvePaneClient(deps.exec, outer.socket, outer.pane, { timeoutMs: TMUX_EXEC_TIMEOUT_MS });
	if (resolved.kind === "pane-gone") {
		notify("That tmux pane is gone.");
		return;
	}
	if (resolved.kind === "no-client") {
		notify("No attached tmux client viewing this pane to open the panel in. Attach first, then click again.");
		return;
	}
	const client = resolved.client;

	// Bind only while the server is known to hold the session: the binding is
	// global to the subagent server, and an empty server would exit and drop it.
	const alive = await deps.exec("tmux", tmuxArgs("has-session", "-t", run.tmuxSession), { timeout: TMUX_EXEC_TIMEOUT_MS });
	if (alive.code !== 0) {
		notify(`Subagent ${short} has no live tmux session.`);
		return;
	}

	const bound = await deps.exec("tmux", buildEscapeBindArgs(socket), { timeout: TMUX_EXEC_TIMEOUT_MS });
	if (bound.code !== 0) {
		notify(`Could not set up the panel's Escape binding: ${bound.stderr.trim() || `tmux exited ${bound.code}`}`, "warning");
		return;
	}

	const launch = buildPanelLaunch({ outerSocket: outer.socket, pane: outer.pane, client, socket, session: run.tmuxSession, runId: run.id });
	deps.launch(launch.command, launch.args, { detached: true, stdio: "ignore" }, (message) => {
		ui.ui.notify(`Could not open panel: ${message}`, "error");
	});
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

/**
 * The child's session file, discovering it for a standalone run that never
 * reported one.
 *
 * A standalone child is launched with `--session-dir <runDir>/session
 * --session-id <run id>`, and pi names the file `<timestamp>_<session id>.jsonl`
 * there. The parent does not learn the exact path until the child reports it in
 * `result.json`, so a run stopped before that — cancel, tmux failure — has to
 * find it to report the tokens it burned. The id suffix is tried first so a
 * leftover file from an earlier attempt in the same dir cannot be picked up;
 * the directory otherwise holds exactly one session for a standalone run.
 *
 * Uses the recorded `sessionFile` when there is one, which is also what every
 * non-standalone mode gets: lineage and fork write to a known path, and resume
 * appends to its ancestor's file (whose own session dir is empty).
 */
async function findChildSessionFile(run: RunRecord): Promise<string | undefined> {
	if (run.sessionFile && existsSync(run.sessionFile)) return run.sessionFile;
	if (run.mode && run.mode !== "standalone") return run.sessionFile;
	const dir = path.join(run.runDir, "session");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return run.sessionFile;
	}
	const jsonl = entries.filter((name) => name.endsWith(".jsonl"));
	const match = jsonl.find((name) => name.endsWith(`_${run.id}.jsonl`)) ?? (jsonl.length === 1 ? jsonl[0] : undefined);
	return match ? path.join(dir, match) : run.sessionFile;
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

interface ModelRegistryLike {
	find?: (provider: string, modelId: string) => unknown;
	getApiKeyAndHeaders?: (model: unknown) => Promise<{ ok: boolean; error?: string }>;
	getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	hasConfiguredAuth?: (model: unknown) => boolean;
	getProviderAuthStatus?: (provider: string) => { configured?: boolean } | undefined;
}

function hasExplicitModelOverride(
	providerOverride: string | undefined,
	modelOverride: string | undefined,
): boolean {
	return Boolean(
		providerOverride?.trim() ||
			modelOverride?.trim() ||
			process.env.PI_SUBAGENT_PROVIDER?.trim() ||
			process.env.PI_SUBAGENT_MODEL?.trim(),
	);
}

async function validateModelSelection(
	ctx: ExtensionContext,
	selected: { provider: string; model: string },
	explicitOverride: boolean,
): Promise<void> {
	if (!explicitOverride) return;
	const registry = (ctx as { modelRegistry?: ModelRegistryLike }).modelRegistry;
	if (!registry) return;

	let resolvedModel: unknown;
	if (typeof registry.find === "function") {
		resolvedModel = registry.find(selected.provider, selected.model);
		if (!resolvedModel) {
			throw new Error(
				`Unknown subagent model: ${selected.provider}/${selected.model}. Check the provider and model id.`,
			);
		}
	}

	const hasConfiguredAuthCheck = resolvedModel !== undefined && typeof registry.hasConfiguredAuth === "function";
	const hasProviderAuthStatusCheck = typeof registry.getProviderAuthStatus === "function";
	const hasApiKeyAndHeadersCheck = resolvedModel !== undefined && typeof registry.getApiKeyAndHeaders === "function";

	if (hasConfiguredAuthCheck) {
		if (!registry.hasConfiguredAuth!(resolvedModel)) {
			throw new Error(
				`No credentials configured for subagent provider "${selected.provider}" (model ${selected.provider}/${selected.model}). Configure credentials (for example via /login or provider API key) before launching.`,
			);
		}
	} else if (hasProviderAuthStatusCheck) {
		const status = registry.getProviderAuthStatus!(selected.provider);
		if (status && status.configured === false) {
			throw new Error(
				`No credentials configured for subagent provider "${selected.provider}" (model ${selected.provider}/${selected.model}). Configure credentials (for example via /login or provider API key) before launching.`,
			);
		}
	}

	if (hasApiKeyAndHeadersCheck) {
		const auth = await registry.getApiKeyAndHeaders!(resolvedModel);
		if (auth && auth.ok === false) {
			throw new Error(
				`No credentials configured for subagent model ${selected.provider}/${selected.model}: ${auth.error ?? "missing API key"}. Configure credentials (for example via /login or provider API key) before launching.`,
			);
		}
	}

	if (
		!hasConfiguredAuthCheck &&
		!hasProviderAuthStatusCheck &&
		!hasApiKeyAndHeadersCheck &&
		typeof registry.getApiKeyForProvider === "function"
	) {
		const apiKey = await registry.getApiKeyForProvider(selected.provider);
		if (!apiKey) {
			throw new Error(
				`No credentials configured for subagent provider "${selected.provider}" (model ${selected.provider}/${selected.model}). Configure credentials (for example via /login or provider API key) before launching.`,
			);
		}
	}
}

function formatActivity(activity: RunActivity | undefined): string | undefined {
	if (!activity) return undefined;
	const parts = [activity.phase];
	if (activity.scope) parts.push(activity.scope);
	if (activity.toolName) parts.push(`(${activity.toolName})`);
	return parts.join(" ");
}

/**
 * The list view's projection of a run: id, status, elapsed, usage.
 *
 * Durations and usage are formatted HERE rather than in listview.ts, which stays
 * structural so the budget policy can be tested without a run record.
 */
/** A question that is still waiting for an answer, or nothing once its deadline has passed. */
function liveQuestion(run: RunRecord, now = Date.now()): PendingQuestion | undefined {
	const pending = run.pendingRequest;
	if (!pending || pending.deadlineAt <= now) return undefined;
	return pending;
}

/** A pending question's one-line note, or nothing. */
function pendingQuestionNote(run: RunRecord): string | undefined {
	const pending = liveQuestion(run);
	if (!pending) return undefined;
	const text = oneLineNote(pending.text, 90);
	return text === undefined ? "? waiting on a question" : `? waiting on a question: ${text}`;
}

function listRow(run: RunRecord): ListRow {
	const durationText = formatDuration(run.startedAt, run.finishedAt);
	const usageText = formatUsage(run.usage);
	// The note is what has to survive onto a one-line row, because everything else
	// the full block carries is one `subagent_status({ id })` away. A pending
	// question comes first: it is the only note that needs a HUMAN to act, and a
	// run holding its slot until a deadline is the one thing a row must not hide.
	const note = pendingQuestionNote(run) ?? interruptedAttachNote(run) ?? errorNote(run);
	return {
		id: run.id,
		status: run.status,
		...(durationText === undefined ? {} : { durationText }),
		...(usageText === undefined ? {} : { usageText }),
		createdAt: run.createdAt,
		detailWorthy: showsPane(run.status),
		...(note === undefined ? {} : { note }),
	};
}

/** An interrupted run's route to the child that is still alive, or nothing. */
function interruptedAttachNote(run: RunRecord): string | undefined {
	// Its pane is still the only view of that child, so the block would say the
	// same thing; this is only here for when an interrupted run loses the budget.
	return run.status === "interrupted" ? `attach: ${run.attachCommand}` : undefined;
}

/** A message's first line, clipped to `max` characters, or nothing. */
function oneLineNote(text: string | undefined, max = 60): string | undefined {
	const detail = text?.split("\n", 1)[0]?.trim();
	if (!detail) return undefined;
	return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}

/** A failure reason, clipped to the first line, or nothing. */
function errorNote(run: RunRecord): string | undefined {
	const detail = oneLineNote(run.error);
	return detail === undefined ? undefined : `! ${detail}`;
}

/** How many steps a plan has in each of a few coarse buckets. */
function planProgress(plan: PlanRecord): string {
	const total = plan.steps.length;
	const done = plan.steps.filter((step) => step.status === "completed").length;
	const failed = plan.steps.filter((step) => step.status === "failed").length;
	const cancelled = plan.steps.filter((step) => step.status === "cancelled").length;
	const running = plan.steps.filter((step) => step.status === "running").length;
	const parts = [`${done}/${total} step(s) done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (cancelled > 0) parts.push(`${cancelled} cancelled`);
	return parts.join(" · ");
}

/**
 * The list view's projection of a PLAN — one row, whatever its step count.
 *
 * A plan is one piece of work, so it is one row: a ten-step plan must not spend
 * the list's detail budget ten times (R25). Its step runs are not listed
 * separately either — the plan block names every step's latest run id, so no run
 * becomes unreachable, and `subagent_status({ id })` still takes any of them.
 *
 * The note is what a one-line row has to carry: progress while the plan runs,
 * and the REASON once it is over (a stop reason otherwise reaches nobody — the
 * error is on a run and the reason on the plan).
 */
function planListRow(plan: PlanRecord): ListRow {
	const durationText = formatDuration(plan.createdAt, plan.finishedAt);
	const note = plan.status === "running" ? planProgress(plan) : plan.reason ?? planProgress(plan);
	const firstLine = oneLineNote(note, 100);
	return {
		id: plan.id,
		label: "plan",
		status: plan.status,
		...(durationText === undefined ? {} : { durationText }),
		createdAt: plan.createdAt,
		// A running plan competes with the live runs for the same budget slots;
		// a finished one is a one-liner unless nothing better is on offer.
		detailWorthy: plan.status === "running",
		...(firstLine ? { note: firstLine } : {}),
	};
}

/**
 * The plan in full: every step, its latest run and why it stopped.
 *
 * One block for the whole plan, which is what the detail budget buys: the steps
 * are lines, not rows, so a ten-step plan costs one slot. Each step carries its
 * own error, because a failure reason that lives only on the abandoned run is a
 * reason nobody reads. `runs` is optional and only sharpens a RUNNING step: a
 * queued or interrupted child is a different thing from a working one, and the
 * step's own status cannot say which it is.
 */
function planSummary(plan: PlanRecord, runs?: Map<string, RunRecord>): string {
	const duration = formatDuration(plan.createdAt, plan.finishedAt);
	const lines = [
		`plan ${plan.id}  ${plan.status}${duration ? ` · ${duration}` : ""}`,
		`  policy: ${plan.policy} · ${planProgress(plan)}`,
	];
	if (plan.reason) lines.push(`  reason: ${plan.reason}`);
	for (const [index, step] of plan.steps.entries()) {
		const runId = step.runIds.at(-1);
		const attempt = step.attempts > 1 ? ` · attempt ${step.attempts}/${step.retries + 1}` : "";
		const waits = step.status === "pending" && step.dependsOn.length > 0 ? ` (waits for ${step.dependsOn.join(", ")})` : "";
		const run = runId ? runs?.get(runId) : undefined;
		const runState = step.status === "running" && run && run.status !== "running" ? ` · run ${run.status}` : "";
		const error = oneLineNote(step.error, 120);
		lines.push(
			`  ${index + 1}. ${step.id}  ${step.status}${waits}  ${runId ?? "—"}${attempt}${runState}${error ? ` — ${error}` : ""}`,
		);
	}
	return lines.join("\n");
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
		// The same headline the list view uses for a run without a detail block,
		// shared so the two cannot drift apart (see runHeadline).
		runHeadline({ id: run.id, status: run.status, ...(duration === undefined ? {} : { durationText: duration }), ...(usage === undefined ? {} : { usageText: usage }) }),
		`  task: ${run.task.split("\n", 1)[0]?.slice(0, 100) ?? run.task}`,
		`  model: ${run.provider}/${run.model} (${run.thinking})`,
	];
	if (activity) lines.push(`  activity: ${activity}`);
	const question = liveQuestion(run);
	if (question) {
		// Local patch 23. Deliberately its own line, in front of the interrupt notes:
		// a run blocked on a question is neither stalled nor interrupted, and an
		// operator has to be able to tell "waiting on a human" from "child wedged"
		// from "turn aborted". The request id is what subagent_answer takes.
		const blocks = question.options?.length ? ` · proposed: ${question.options.join(" / ")}` : "";
		lines.push(
			`  question: ${oneLineNote(question.text, 200) ?? "(empty)"}${blocks}`,
			`  waiting on: a human-confirmed answer since ${new Date(question.askedAt).toISOString()}` +
				` (request ${question.id}, deadline ${new Date(question.deadlineAt).toISOString()})`,
		);
	}
	lines.push(`  tmux: ${run.tmuxSession}`, `  attach: ${run.attachCommand}`);
	if (run.sessionFile) lines.push(`  child session: ${run.sessionFile}`);
	if (run.report) {
		// The pointer first: it is what a consumer follows for the complete text.
		// The bounded head already lives in the record; this line only says where
		// the rest is and whether the reader had to degrade.
		lines.push(
			`  report: ${run.report.artifactPath} (${run.report.artifactBytes} bytes${run.report.truncated ? ", bounded copy in this record" : ""})`,
		);
		if (run.report.degradation) lines.push(`  report degraded: ${run.report.degradation}`);
		else if (run.report.status) {
			const firstLine = run.report.summary?.split("\n", 1)[0]?.slice(0, 140);
			lines.push(`  reported: ${run.report.status}${firstLine ? ` — ${firstLine}` : ""}`);
		}
		if (run.report.skew) {
			lines.push(`  report protocol: writer ${run.report.skew.writer}, reader ${run.report.skew.reader}`);
		}
	}
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
		const runId = path.basename(path.dirname(resultPath));
		registerChildReporter(pi, resultPath, runId, process.env[INTERRUPT_ENV]?.trim() || undefined);
		// Escalation (local patch 23). Registered only when the parent named a
		// channel, which is also how a run launched by a build that has none keeps
		// the old behaviour instead of writing requests nobody reads.
		const escalationPath = process.env[ESCALATION_ENV]?.trim();
		if (escalationPath) {
			registerChildEscalation(pi, {
				dir: escalationPath,
				runId,
				timeoutMs: readIntEnv("PI_SUBAGENT_QUESTION_TIMEOUT_SECONDS", DEFAULT_QUESTION_TIMEOUT_SECONDS) * 1000,
				graceMs: readIntEnv("PI_SUBAGENT_QUESTION_GRACE_SECONDS", DEFAULT_QUESTION_GRACE_SECONDS) * 1000,
			});
		}
		// Scrub the child-mode variables out of this process once they are read:
		// every bash-tool subprocess inherits process.env, so a surviving variable
		// makes any `pi` the child runs from a tool re-enter child mode on the SAME
		// result.json and overwrite the run's record with its own answer — recorded
		// as run c2428902-… being reported completed/"ok" by a nested pi spawned
		// from the child's bash tool while the run was still going. The parent's
		// launch path below writes the variables into the tmux command as literals,
		// not by reading the environment, so nothing reads them after this point.
		delete process.env[CHILD_ENV];
		delete process.env[RESULT_ENV];
		delete process.env[INTERRUPT_ENV];
		delete process.env[ESCALATION_ENV];
		// The orchestrator's worker marker is scrubbed at session_start, not here.
		// It is a literal this launcher writes into the child command, and the
		// orchestrator resolves it once at module load to decide whether this
		// process may act at a settlement boundary. Removing it in this factory
		// would depend on the orchestrator having loaded first; session_start runs
		// after every factory, so the marker is read wherever the orchestrator sits
		// in the load order. Leaving it in place would be the same inheritance
		// hazard as the child-mode variables above, with a different consequence: a
		// `pi` launched from this worker's shell would resolve as a worker and skip
		// its own gate and advisor.
		pi.on("session_start", () => {
			delete process.env.PI_ORCHESTRATOR_ROLE;
		});
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
	/**
	 * Runs the queue has ADMITTED (status `running`) but whose child command has
	 * not been submitted yet. A stop-policy abort uses this to tell "reserved a
	 * slot" from "child already working": the former is still abandoned.
	 */
	const launching = new Set<string>();
	/**
	 * Dependency plans, persisted BESIDE the runs they reference.
	 *
	 * The plan is a sibling record (`plans.json` in the same per-session run
	 * directory) rather than a field on a run because one plan owns several runs
	 * and outlives each of them. It reuses the same atomic writer and the same
	 * persist chain as `runs.json`: one lock, one ordering, no second store that
	 * could disagree with the runs it points at.
	 *
	 * Loading a persisted plan does NOT advance it by itself. `reconcileLoadedPlans`
	 * does so once, after the run index is loaded too: a plan is only meaningful
	 * next to the runs it points at.
	 */
	const plans = new Map<string, PlanRecord>();
	/**
	 * Plans whose terminal settlement has already been published (patch 22).
	 *
	 * A plan can be reduced after it is already terminal — a late settlement
	 * records a step without changing the plan — and `applyPlanAdvance` runs for
	 * those too. The set is what makes `orchestrator:plan-settled` mean "this plan
	 * became terminal", not "a reduction touched a terminal plan".
	 */
	const announcedPlans = new Set<string>();
	/**
	 * Runs whose terminal lifecycle event has already been published.
	 *
	 * Every terminal path (a child result, a cancel, an interrupt, a shutdown
	 * kill) reports the same event, and a few of them can observe the same run —
	 * an interrupt marker folded twice, a cancel after an interrupt. The set makes
	 * `orchestrator:run-settled` mean "this run reached a terminal state", once.
	 */
	const announcedRuns = new Set<string>();
	/**
	 * Session files a resume has claimed but not yet registered a run for.
	 *
	 * A resume does I/O (`mkdir`, `countSessionLines`) between the "is another
	 * resume in flight" scan and the new run landing in `runs`, so two calls fired
	 * without awaiting each other could both pass that scan. The claim is added and
	 * removed around that window; once the run is registered the ordinary scan sees
	 * it.
	 */
	const reservedResumes = new Set<string>();
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
	/**
	 * Consecutive ticks whose `result.json` read was unusable. Cleared by a
	 * missing file and by a usable one, so only a sustained run of failures can
	 * fail the run; see MAX_TRANSIENT_RESULT_FAILURES.
	 */
	const resultFailures = new Map<string, number>();
	/**
	 * Escalation requests this parent has already acted on, per run (local patch 23).
	 *
	 * A request file stays on disk until the child consumes the exchange, so without
	 * this every 500 ms tick would deliver the same progress update again and
	 * re-surface the same question. The persisted `run.pendingRequest` covers a
	 * question across a reload; this set is the per-tick memory that makes a replayed
	 * request exactly one delivery.
	 */
	const handledRequests = new Map<string, Set<string>>();
	/**
	 * Resolvers for pending `subagent_wait` calls (local patch 19), keyed by run id.
	 *
	 * The settle watcher is the extension's only poll loop; a wait adds none. These
	 * resolvers are invoked by the terminal transitions that already exist —
	 * `finalizeRun` and `markRunFailed` (both watcher-driven), `subagent_cancel`,
	 * `noteInterrupt` and `session_shutdown` — so a waiter wakes within one 500 ms
	 * tick of the run actually settling. A waiter that never gets a transition is
	 * released by its own timeout instead, which returns the current record.
	 */
	const settleWaiters = new Map<string, Set<(run: RunRecord) => void>>();
	/**
	 * Resolvers for pending `subagent_wait({ plan })` calls, keyed by plan id.
	 *
	 * A plan spans several waves, so its later run ids do not exist when the reply
	 * is written and cannot be named there. The plan id is therefore the handle
	 * that covers the whole thing (finding 3 from ticket 05), and this is where a
	 * waiter on it is held. Resolved by the same place that makes the plan
	 * terminal — `applyPlanAdvance`, the cancel cascade — so no wait adds a timer.
	 */
	const planWaiters = new Map<string, Set<() => void>>();
	/** Set once the persisted plans have been reconciled against the loaded runs. */
	let plansReconciled = false;
	// Released at session end, before kill-on-shutdown flips any status: a waiter
	// pending when the session ends must say "ended", never "settled".
	const endWaiters = new Set<() => void>();
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

	const countResultFailure = (run: RunRecord): number => {
		const next = (resultFailures.get(run.id) ?? 0) + 1;
		resultFailures.set(run.id, next);
		return next;
	};

	/**
	 * Release every `subagent_wait` call registered for `run` (local patch 19).
	 *
	 * Called only where a run REACHES a terminal state, which is the only thing a
	 * waiter is waiting for: the tool reads no status before registering, so
	 * there is no check-to-registration gap to lose a transition in, and one
	 * that is never woken at all is caught by its timeout, which returns the
	 * current record rather than an error.
	 */
	const notifyWaiters = (run: RunRecord): void => {
		const waiters = settleWaiters.get(run.id);
		if (!waiters) return;
		settleWaiters.delete(run.id);
		for (const waiter of waiters) waiter(run);
	};

	/**
	 * Release every `subagent_wait({ plan })` call once the plan is over.
	 *
	 * A plan is over when nothing is running or pending, which only `plan.ts` can
	 * decide; every caller that applies a reduction calls this afterwards. Called
	 * only on a terminal plan: a plan that is still running has nothing to report
	 * yet, and its waiters keep waiting on later waves.
	 */
	const notifyPlanWaiters = (plan: PlanRecord): void => {
		if (plan.status === "running") return;
		const waiters = planWaiters.get(plan.id);
		if (!waiters) return;
		planWaiters.delete(plan.id);
		for (const waiter of waiters) waiter();
	};

	/**
	 * Wait until a plan is terminal, or `timeoutMs` elapses, whichever first.
	 *
	 * The plan-level wait from ticket 05's finding 3: a dependency plan's reply
	 * can only name the first wave's run ids, because later waves do not exist yet,
	 * so the plan id is the only handle that covers the whole graph. One registered
	 * resolver, no poll: `notifyPlanWaiters` releases it from whichever path made
	 * the plan terminal — a settlement, a cancel, a reconciliation at load.
	 *
	 * Same contract as `waitForRunsSettled`: a timeout returns the current state
	 * rather than an error, a session end releases the call early, and an aborted
	 * tool call rejects.
	 */
	const waitForPlanSettled = (
		plan: PlanRecord,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<{ timedOut: boolean; ended: boolean }> =>
		new Promise<{ timedOut: boolean; ended: boolean }>((resolve, reject) => {
			if (plan.status !== "running") return resolve({ timedOut: false, ended: false });
			let settled = false;
			let sawEnded = false;
			const waiter = (): void => finish(false);
			const cleanup = (): void => {
				const set = planWaiters.get(plan.id);
				if (set) {
					set.delete(waiter);
					if (set.size === 0) planWaiters.delete(plan.id);
				}
				endWaiters.delete(end);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => finish(true), Math.max(0, timeoutMs));
			const end = (): void => {
				sawEnded = true;
				finish(false);
			};
			const finish = (timedOut: boolean): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({ timedOut, ended: sawEnded });
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error("Subagent wait aborted."));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			endWaiters.add(end);
			let set = planWaiters.get(plan.id);
			if (!set) {
				set = new Set();
				planWaiters.set(plan.id, set);
			}
			set.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	/**
	 * Wait until every named run is terminal, or `timeoutMs` elapses, whichever
	 * first. Resolves `{ timedOut, ended }`; it never rejects except on tool-call abort.
	 *
	 * One registered waiter per still-live run: whichever settles last releases
	 * the whole call. The filter at entry is the terminal check — the tool makes
	 * no earlier status read to race with, and the registration loop below is
	 * synchronous, so no transition can land between the two.
	 */
	const waitForRunsSettled = (
		targets: RunRecord[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<{ timedOut: boolean; ended: boolean }> =>
		new Promise<{ timedOut: boolean; ended: boolean }>((resolve, reject) => {
			const pending = new Set(targets.filter((run) => !isTerminal(run.status)));
			if (pending.size === 0) return resolve({ timedOut: false, ended: false });
			let settled = false;
			const registered = new Map<string, (run: RunRecord) => void>();
			const cleanup = (): void => {
				for (const [runId, waiter] of registered) {
					const set = settleWaiters.get(runId);
					if (set) {
						set.delete(waiter);
						if (set.size === 0) settleWaiters.delete(runId);
					}
				}
				registered.clear();
				endWaiters.delete(end);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => finish(true), Math.max(0, timeoutMs));
			let sawEnded = false;
			const end = (): void => {
				sawEnded = true;
				finish(false);
			};
			const finish = (timedOut: boolean): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve({ timedOut, ended: sawEnded });
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new Error("Subagent wait aborted."));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			endWaiters.add(end);
			for (const run of pending) {
				const waiter = (): void => {
					pending.delete(run);
					if (pending.size === 0) finish(false);
				};
				let set = settleWaiters.get(run.id);
				if (!set) {
					set = new Set();
					settleWaiters.set(run.id, set);
				}
				set.add(waiter);
				registered.set(run.id, waiter);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	/**
	 * A run that is terminal AND owns no live child has nothing left to settle.
	 *
	 * The watcher checks this at tick entry, but a tick that is already in flight
	 * can be outrun by `subagent_cancel` (whose kill-session exec is awaited) or by
	 * shutdown. Without the same check inside the finalisers, a cancelled run is
	 * flipped back to completed/failed, persisted and announced a second time.
	 */
	const isSettledRun = (run: RunRecord): boolean => isTerminal(run.status) && !holdsChild(run.status);
	// Set by session_shutdown. The watcher deletes its own timer from the map at
	// the start of a tick and re-arms one at the end, so a tick already in flight
	// when shutdown clears the map would otherwise re-arm a timer nothing will
	// ever clear again. The flag lives in the factory closure, so it starts false
	// again for every fresh extension load.
	let shuttingDown = false;
	let sessionId = "";
	let sessionRunsDir = "";
	let runsIndexPath = "";
	let plansIndexPath = "";
	/**
	 * The context the current tool call or session belongs to. Held so a plan
	 * advance triggered by a settlement can prepare a retry's handoff session
	 * without a tool call in scope. Set by `ensureSessionPaths`, which every tool
	 * entry point calls before doing anything else.
	 */
	let sessionContext: ExtensionContext | undefined;
	let persistChain: Promise<void> = Promise.resolve();

	const persist = (): Promise<void> => {
		if (!runsIndexPath) return Promise.resolve();
		const runSnapshot = [...runs.values()];
		const planSnapshot = [...plans.values()];
		persistChain = persistChain
			.then(async () => {
				await writeJsonAtomic(runsIndexPath, runSnapshot);
				if (plansIndexPath) await writeJsonAtomic(plansIndexPath, planSnapshot);
			})
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
		await pi
			.exec("tmux", tmuxArgs("kill-session", "-t", run.tmuxSession), { timeout: TMUX_EXEC_TIMEOUT_MS })
			.catch(() => undefined);
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

	/**
	 * Read the usage a run has burned so far, honouring its inherited-context
	 * baseline.
	 *
	 * Called before a terminal status is persisted by the paths that never receive a
	 * child result — cancel, and a tmux-level failure — so a run that spent real
	 * tokens before it stopped does not report none. `readSessionUsage` already
	 * excludes the lines a fork or resume inherited; a missing or unreadable session
	 * file leaves the field as it was. The `?? run.usage` fallback is a no-op today:
	 * every caller reaches here with `usage` unset (`subagent_resume` clears it on
	 * the new record), so it can neither surface stale data nor erase a value that
	 * a future caller already set.
	 */
	const captureRunUsage = async (run: RunRecord): Promise<void> => {
		const sessionFile = await findChildSessionFile(run);
		run.usage = (await readSessionUsage(sessionFile, { fromLine: run.usageFromLine ?? 0 })) ?? run.usage;
		// Remember a discovered path: it makes the child session visible to
		// subagent_status and subagent_clean, which otherwise would not know one
		// exists until the run reported a result.
		if (sessionFile) run.sessionFile = sessionFile;
	};

	/**
	 * Publish that a run was admitted (ticket 02). One event per run id: plan
	 * retries create new ids and therefore publish their own start. Total by
	 * construction: `publishOrchestrationEvent` never throws and its result is
	 * deliberately ignored.
	 */
	const publishRunStarted = (run: RunRecord): void => {
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runStarted, {
			runId: run.id,
			status: run.status === "running" ? "running" : "queued",
			...(run.planId ? { planId: run.planId } : {}),
			...(run.stepId ? { stepId: run.stepId } : {}),
			at: run.createdAt ?? Date.now(),
		});
	};

	/**
	 * Publish the live runs a reload rebuilt, so a parent that starts after a
	 * restart knows what is in flight before its first settlement. A terminal run
	 * is omitted: it is not live, and its own settlement event already said so.
	 */
	const publishRunsSnapshot = (): void => {
		// `interrupted` is deliberately NOT live here. In-process its settlement
		// event already released the park, and a reloaded parent that treated it as
		// live would park with no wake left: the interrupt marker does not publish
		// again. The run keeps its watcher and can still finalize later; that is a
		// normal `run-settled`, not a reason to wait for this one.
		const live = [...runs.values()]
			.filter((run) => run.status === "queued" || run.status === "running")
			.map((run) => ({ runId: run.id, status: run.status as "queued" | "running" }));
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runsSnapshot, { runs: live, at: Date.now() });
	};

	/**
	 * Publish a run's terminal transition (patch 22, extended by ticket 02).
	 *
	 * Every terminal status is reported — completed, failed, cancelled and
	 * interrupted — because a parked parent is released by whichever one happens
	 * last, not only by a child that reported an answer. Published at most once per
	 * run id: the terminal paths can observe the same run twice (an interrupt
	 * marker folded again, a cancel after an interrupt). Called after `persist`
	 * where the path persists, so a subscriber reading `runs.json` sees the same
	 * status. Total by construction: `publishOrchestrationEvent` never throws and
	 * its result is deliberately ignored.
	 */
	const publishRunSettled = (run: RunRecord): void => {
		if (announcedRuns.has(run.id)) return;
		const status =
			run.status === "completed" || run.status === "failed" || run.status === "cancelled" || run.status === "interrupted"
				? run.status
				: null;
		if (!status) return;
		announcedRuns.add(run.id);
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.runSettled, {
			runId: run.id,
			status,
			...(run.planId ? { planId: run.planId } : {}),
			...(run.stepId ? { stepId: run.stepId } : {}),
			...(run.error ? { error: run.error } : {}),
			finishedAt: run.finishedAt ?? Date.now(),
		});
	};

	/** Publish a plan's terminal transition at most once (patch 22). */
	const publishPlanSettled = (plan: PlanRecord): void => {
		if (plan.status === "running" || announcedPlans.has(plan.id)) return;
		announcedPlans.add(plan.id);
		publishOrchestrationEvent(pi, ORCHESTRATION_EVENTS.planSettled, {
			planId: plan.id,
			status: plan.status === "completed" || plan.status === "failed" ? plan.status : "cancelled",
			...(plan.reason ? { reason: plan.reason } : {}),
			finishedAt: plan.finishedAt ?? Date.now(),
		});
	};

	/**
	 * The terminal tail both finalisers share: read the child's usage, persist,
	 * notify, refresh the widget, schedule the reap. Callers set their
	 * status-specific fields first.
	 *
	 * The notification comes before the display refresh deliberately: a display
	 * problem must never be able to swallow the completion message, which is how
	 * the main agent learns the run ended.
	 */
	const settleRun = async (run: RunRecord): Promise<void> => {
		resultFailures.delete(run.id);
		// The child may have spent real tokens even when it failed at the tmux
		// level; a failure must not report none. See captureRunUsage.
		await captureRunUsage(run);
		await persist();
		publishRunSettled(run);
		await notifyCompletion(run);
		refreshStatusWidget();
		scheduleReap(run);
	};

	/**
	 * Publish a run's complete final text as its standalone report artifact and
	 * build the bounded copy that goes into the run record.
	 *
	 * The head is read back from the file through `readReportHead` rather than
	 * copied from the text in memory: that is the same path a consumer takes, and
	 * it proves a very long report is bounded to a truncation window in the run
	 * index. Any failure here degrades the report; it never fails the run.
	 */
	const publishRunReport = async (
		run: RunRecord,
		text: string,
		parsed: ChildReportValidation,
	): Promise<RunReport> => {
		const artifactPath = path.join(run.runDir, REPORT_FILE_NAME);
		try {
			await writeReportArtifact(artifactPath, text);
			const head = await readReportHead(artifactPath);
			return buildRunReport({ artifactPath, head, parsed });
		} catch (error) {
			// The in-memory text is the only copy left, so keep a bounded head of it
			// and make the broken pointer visible instead of failing the settlement.
			const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			const head: ReportHead = { head: bounded.content, bytes: 0, truncated: bounded.truncated };
			return buildRunReport({
				artifactPath,
				head,
				parsed,
				degradation: `the report artifact could not be written: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	};

	const finalizeRun = async (run: RunRecord, result: ChildResult): Promise<void> => {
		if (isSettledRun(run)) return;
		run.status = result.status === "completed" ? "completed" : "failed";
		run.finishedAt = result.finishedAt || Date.now();
		// The run is over one way or another, so an outstanding Escape is no longer
		// news; leaving it would make subagent_status report a pending interrupt on
		// a finished run. A question goes with it: there is no child left to answer
		// (local patch 23).
		run.interruptRequestedAt = undefined;
		run.pendingRequest = undefined;
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
		const reportText = output || "(no text output)";
		// The artifact holds everything, including what `output` is about to lose to
		// the display cap; the record keeps only a bounded head and the pointer.
		run.report = await publishRunReport(run, reportText, resolveChildReport(result.report, result.output));
		run.output = truncateToolText(reportText);
		await settleRun(run);
		notifyWaiters(run);
		await advancePlanForRun(run);
		void drainQueue();
	};

	const markRunFailed = async (run: RunRecord, message: string): Promise<void> => {
		if (isSettledRun(run)) return;
		clearTimer(run.id);
		// Capture usage (and discover sessionFile) before flipping to "failed", so a
		// persisted/observable "failed" run never lacks usage or its transcript
		// pointer. persist() runs once, inside settleRun, after capture.
		await captureRunUsage(run);
		run.status = "failed";
		run.interruptRequestedAt = undefined;
		run.pendingRequest = undefined;
		run.error = message;
		run.finishedAt = Date.now();
		// A run that failed before its child reported still leaves a readable
		// artifact: the failure text is its complete final report, and the plain
		// text is marked as degraded rather than pretending an envelope existed.
		run.report = await publishRunReport(run, message, resolveChildReport(undefined, ""));
		await settleRun(run);
		notifyWaiters(run);
		await advancePlanForRun(run);
	};

	/**
	 * The failure text for a result file this parent cannot use.
	 *
	 * It does not capture tmux live: `settleRun` reaps the session immediately
	 * (`PI_SUBAGENT_REAP_DELAY_MS` defaults to 0), so by the time a human reads
	 * this the session is usually gone. What survives is the file, the child's
	 * transcript, and the run's retained `pane` snapshot — so the message names
	 * those instead, and `{ pane: true }` appends the last one when the caller's
	 * result no longer renders the pane separately.
	 */
	const unusableResultMessage = (run: RunRecord, detail: string | undefined, options: { pane?: boolean } = {}): string => {
		const lines = [`The child's result file at ${run.resultPath} is unusable: ${detail ?? "unknown reason"}.`];
		if (options.pane && run.pane) lines.push(`Last pane output:\n${run.pane}`);
		lines.push(
			`The run was failed rather than watched forever. Read that file to recover whatever the child wrote` +
				(run.sessionFile ? `, or resume its transcript (${run.sessionFile}) with subagent_resume.` : "."),
		);
		return lines.join("\n\n");
	};

// --- Lazy tool exposure (local patch 15) -------------------------------------
//
// The management tools (status, wait, cancel, interrupt, resume, clean) cost a request
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

/**
 * Register the management tools, hidden if pi can reach them another way.
 *
 * Called at `session_start` and again before every agent turn, because the tool
 * set can change underneath us: `/tools` switching `codemode` off would otherwise
 * strand all six at once — declared-as-codemode, no longer declared, and no
 * longer reachable. Re-registering `direct` re-activates them, since pi activates
 * a tool whose exposure BECOMES declarable and was not activated on registration.
 *
 * The memo is what makes that cheap: the common case is a no-op.
 */
// CLOSURE state, not module state: the factory (`subagentExtension`) opened far
// above and closes at the end of this file, so these reset on every extension
// load. A reload or a session replacement builds a new runtime and re-invokes the
// factory (`createAgentSessionServices` -> `resourceLoader.reload`), so the six
// tools are registered again for the new session. Do NOT hoist them to module
// scope: a module-level memo would survive the load and leave a fresh session
// with no management tools at all. (This block is written without the factory's
// indentation, which is what makes it read as module state; the braces say
// otherwise.)
let appliedManagementExposure: ToolExposure | undefined;
let managementToolsRegistered = false;

const registerManagementTools = (): void => {
	let exposure: ToolExposure | undefined;
	try {
		exposure = resolveManagementExposure(pi.getActiveTools());
	} catch (error) {
		// Not worth failing a session over: without an answer the tools are simply
		// declared, which is always correct.
		console.error(`[tmux-subagent] could not resolve tool exposure: ${error instanceof Error ? error.message : String(error)}`);
	}
	// The first call registers; after that only a changed answer does.
	if (managementToolsRegistered && appliedManagementExposure === exposure) return;
	managementToolsRegistered = true;
	appliedManagementExposure = exposure;
	for (const tool of managementToolDefinitions) {
		pi.registerTool(exposure ? { ...tool, exposure } : tool);
	}
};

// --- Live widget (local patch 14) ---------------------------------------------
//
// The classifier is display-only, so none of this decides anything about a run:
// `advanceStatusState` reports a kind and nothing else. A caller that must REACT
// to a stall would have to derive the edge from `currentKind`; this one must not,
// because waking the parent would duplicate notifyCompletion and spam the main
// session with something the user is already watching below the editor.

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
		// A blocked child (local patch 23) is a kind of its own, not "active with a
		// tool" and not "stalled": its tool is alive and the parent holds the
		// question, so only the run status plus the parent's own record can say why
		// it stopped moving. `interrupted` keeps its authority: an Escape aborts the
		// waiting call, and expected() clears the pending request with it.
		const blocked = run.status === "running" && liveQuestion(run, now) !== undefined;
		return {
			runId: run.id,
			id: run.id.slice(0, 8),
			task: run.task,
			kind: blocked ? "question" : snapshot.kind,
			elapsedText: snapshot.elapsedText,
			detail: blocked ? `waiting on a question ${formatElapsedDuration(now - (liveQuestion(run, now)?.askedAt ?? now))}` : statusDetail(snapshot),
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
			onRowClick: (row) => {
				void openSubagentPanel(
					{
						ui: statusUi,
						getRun: (runId) => runs.get(runId),
						isShuttingDown: () => shuttingDown,
						exec: (command, args, opts) => pi.exec(command, args, { timeout: TMUX_EXEC_TIMEOUT_MS, ...opts }),
						launch: panelLauncher,
					},
					row.runId,
				).catch((error) => {
					// The async guards get no caller to surface a throw, and openSubagentPanel
					// is not allowed to reject into the void.
					statusUi?.ui.notify(`Could not open panel: ${error instanceof Error ? error.message : String(error)}`, "error");
				});
			},		}),
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
		// An Escape aborts the in-flight tool call, so a waiting question belongs to
		// a call that no longer exists: clear it rather than leave subagent_status
		// reporting a blocked run whose child is actually idle at its prompt.
		run.pendingRequest = undefined;
		// No finishedAt: the child is still running, so the elapsed time shown by
		// formatDuration must keep counting rather than freezing.
		await persist();
		// Terminal for wait, and for a parked parent: an interrupt releases the park
		// even though the tmux session may still need a cancel. Announced once per
		// run id, so a marker folded again by the watcher is silent.
		publishRunSettled(run);
		// `interrupted` is a status the widget renders, and noteInterrupt is the
		// only writer of it — without this the strip keeps claiming the run is
		// active for up to a tick after the tool reported it stopped.
		refreshStatusWidget();
		// `interrupted` is terminal for wait too, so a pending subagent_wait on this
		// run must return now rather than wait out its timeout.
		notifyWaiters(run);
		return true;
	};

	/** What the confirmation poll saw. */
	type InterruptConfirmation =
		| { state: "confirmed"; marker: SubagentInterruptMarker }
		| { state: "stale"; marker: SubagentInterruptMarker }
		| { state: "superseded"; marker: SubagentInterruptMarker; runStatus: RunStatus }
		| { state: "unconfirmed"; aborted: boolean };

	/**
	 * Poll for a marker NEWER than `since`, for at most `timeoutMs`.
	 *
	 * The marker file is never deleted, so it survives the whole run. Without the
	 * baseline a second interrupt would be "confirmed" instantly by the first
	 * interrupt's marker, while the child kept streaming — the tool would then
	 * report a stop that never happened.
	 *
	 * Confirmation comes from the marker's freshness (`markerIsNewerThan`), NOT
	 * from `noteInterrupt`'s return value: the watcher folds the same marker on its
	 * own tick, and if it wins the race `noteInterrupt` reports "no change" for an
	 * interrupt that did land. Folding the marker here is still attempted, so a run
	 * that is not already terminal is recorded; the boolean is simply not evidence
	 * of staleness. A run that already ended refuses the fold, and is reported as
	 * `superseded` rather than confirmed — the status stands.
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
				if (markerIsNewerThan(marker.marker, since)) {
					await noteInterrupt(run, marker.marker, since);
					// A newer marker normally confirms — whether or not THIS call folded it,
					// since the watcher may have. `noteInterrupt` refuses a run that is already
					// terminal (completed/failed/cancelled), and then the marker is real while
					// the status stands: claiming "confirmed" would assert a stop that is not
					// the run's state. Report the supersession instead.
					if (run.status === "interrupted") return { state: "confirmed", marker: marker.marker };
					return { state: "superseded", marker: marker.marker, runStatus: run.status };
				}
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
		const late = await readChildResultFile(run.resultPath);
		if (late.ok) {
			await finalizeRun(run, late.result);
			return;
		}
		const reason = unreachable
			? `Child Pi could not be reached over tmux for ${MAX_TRANSIENT_TMUX_FAILURES} consecutive checks, so its state is unknown. Inspect: ${run.captureCommand}`
			: run.pane
				? `Child Pi exited before reporting a result.\n\n${run.pane}\n\nInspect: ${run.captureCommand}`
				: `Child Pi exited before reporting a result. Inspect: ${run.captureCommand}`;
		// A result that is present but unusable is worth saying out loud: it is the
		// difference between "the child died" and "the child reported something this
		// parent could not read".
		// `pane: false`: this branch's reason already carries the pane snapshot.
		await markRunFailed(run, late.reason === "invalid" ? `${reason}\n\n${unusableResultMessage(run, late.error, { pane: false })}` : reason);
		void drainQueue();
	};

	/**
	 * Remember that this tick acted on a request, reporting whether it was the first.
	 *
	 * A request that could not be read is remembered too: it will never become
	 * usable, so retrying it every tick would only repeat the same log line. The set
	 * is capped because its job is deduplicating files that are still on disk; a
	 * consumed exchange cannot be replayed at all, so dropping the oldest entry is
	 * safe long before the cap is reached.
	 */
	const markRequestHandled = (run: RunRecord, id: string): boolean => {
		const handled = handledRequests.get(run.id) ?? new Set<string>();
		handledRequests.set(run.id, handled);
		if (handled.has(id)) return false;
		handled.add(id);
		if (handled.size > 500) {
			const oldest = handled.values().next().value;
			if (oldest !== undefined) handled.delete(oldest);
		}
		return true;
	};

	/**
	 * Read this run's escalation channel — on the watcher tick that already runs.
	 *
	 * This is the whole polling mechanism for escalated questions (R17): the tick
	 * that reads `result.json`, `activity.json` and the interrupt marker reads the
	 * request files too, so the feature starts no timer of its own and shutdown has
	 * nothing extra to clear. The heartbeat is refreshed on the same tick, and only
	 * while something is waiting on it, which is what lets a blocked child notice a
	 * parent that went away instead of sitting on its deadline (R16).
	 *
	 * Nothing user-facing runs here: a question is surfaced as a session message,
	 * never as a dialog, because the tick runs mid-run and prompting from it would
	 * race the TUI (see "The human gate lives in the answering tool", spec).
	 */
	const handleEscalation = async (run: RunRecord): Promise<void> => {
		if (!run.escalation) return;
		const dir = escalationDir(run.runDir);
		// No deadline cleanup here, deliberately. The child expires its own wait and
		// then reports its blocker, which settles the run and clears the question with
		// it; the renderers stop calling an expired question "waiting", and
		// subagent_answer refuses it. Clearing it from the tick instead would race that
		// report and lose the one record a human could still inspect.
		const requests = await listEscalationRequests(dir);
		if (requests.length > 0 || run.pendingRequest) {
			try {
				await touchEscalationHeartbeat(dir);
			} catch (error) {
				// A child will read this as "no parent" eventually; there is nothing else
				// to do about it, and it must not fail the tick.
				console.error(`[tmux-subagent] could not touch the escalation heartbeat for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// Only a live child can be waiting. An interrupted run's question was cleared
		// with the status change, and a settled one has no child left to answer.
		if (run.status !== "running") return;
		for (const entry of requests) {
			const read = await readEscalationRequest(entry.file, { runId: run.id });
			if (!read.ok) {
				markRequestHandled(run, entry.id);
				console.error(
					`[tmux-subagent] ignoring an unusable escalation request ${entry.id} for ${run.id}: ${read.error ?? read.reason}`,
				);
				continue;
			}
			const request = read.value;
			if (!markRequestHandled(run, request.id)) continue;
			// The per-session set is the only thing that dedupes a file the child has not
			// consumed yet, and a reload has no memory of it: a question already pending,
			// or already answered (its reply is on disk, the child has not collected it),
			// must not be surfaced a second time.
			if (run.pendingRequest?.id === request.id) continue;
			if (request.kind === "question") {
				const answered = await readEscalationReply(replyPath(dir, request.id), { runId: run.id, id: request.id });
				if (answered.ok) continue;
			}
			if (request.kind === "progress") {
				await deliverProgressUpdate(run, request);
				// The child never consumes a progress request, so nothing else would: without
				// this a reload re-delivers it, because the handled-set is per process.
				await consumeEscalationExchange(dir, request.id).catch(() => undefined);
				continue;
			}
			// Expired before it was ever surfaced: not delivered, and not answered. The
			// child is told by its own deadline, so answering here would be worse than
			// doing nothing — a late answer is not an answer (R13, R16).
			if ((request.deadlineAt ?? 0) <= Date.now()) continue;
			await surfaceQuestion(run, request);
		}
	};

	/**
	 * Deliver a progress update, without a human gate and without taking a turn.
	 *
	 * Deliberately no `triggerTurn` and no `deliverAs`, for the same reason
	 * `notifyCompletion` has none: an update is information, and a child that sends
	 * one must never pull the parent into a turn to read it.
	 */
	const deliverProgressUpdate = async (run: RunRecord, request: EscalationRequest): Promise<void> => {
		try {
			await pi.sendMessage({
				customType: PROGRESS_MESSAGE_TYPE,
				content: `Subagent ${run.id} progress: ${request.text}`,
				display: true,
				details: { id: run.id, requestId: request.id },
			});
		} catch (error) {
			console.error(`[tmux-subagent] could not deliver progress from ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/**
	 * Surface a pending decision on the run and in the parent session.
	 *
	 * The message DOES wake the parent, unlike every other watcher-driven message:
	 * a question nobody is woken for is a child holding a concurrency slot until its
	 * deadline, and the human who has to answer it never learns it was asked.
	 * `followUp` rather than `steer` so it cannot pre-empt the parent's in-flight
	 * tool calls; `triggerTurn` makes an idle parent read it at once.
	 *
	 * Recording it on the run is what makes it observable: `subagent_status` renders
	 * "waiting on a question" from `pendingRequest`, and `subagent_answer` finds the
	 * request by its id without re-reading the child's files.
	 */
	const surfaceQuestion = async (run: RunRecord, request: EscalationRequest): Promise<void> => {
		run.pendingRequest = {
			id: request.id,
			text: request.text,
			...(request.options === undefined ? {} : { options: request.options }),
			askedAt: request.askedAt,
			deadlineAt: request.deadlineAt ?? Date.now(),
		};
		await persist();
		refreshStatusWidget();
		const lines = [`Subagent ${run.id} is blocked on a question.`, "", request.text];
		if (request.options && request.options.length > 0) lines.push("", `Proposed answers: ${request.options.join(" / ")}`);
		lines.push(
			"",
			`Answer with subagent_answer({ id: "${request.id}", answer: "..." }). That tool asks a human to confirm; a decision is never answered by a model.`,
			`The child waits until ${new Date(run.pendingRequest.deadlineAt).toISOString()}, then reports the blocker and stops.`,
		);
		try {
			await pi.sendMessage(
				{
					customType: QUESTION_MESSAGE_TYPE,
					content: lines.join("\n"),
					display: true,
					details: { id: run.id, requestId: request.id },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (error) {
			// The session may be shutting down; the question is still on the run and the
			// child is still polling, so a lost message degrades to "nobody was woken".
			console.error(`[tmux-subagent] could not surface the question from ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const watchTick = async (run: RunRecord): Promise<void> => {
		timers.delete(run.id);
		if (shuttingDown) return;
		// An interrupted run is terminal for every consumer, but its child is alive
		// and may still finish, so the watcher keeps polling for a result.json. Every
		// other terminal status has nothing left to observe.
		if (isTerminal(run.status) && !holdsChild(run.status)) return;

		try {
			const result = await readChildResultFile(run.resultPath);
			if (result.ok) {
				resultFailures.delete(run.id);
				await finalizeRun(run, result.result);
				return;
			}
			if (result.reason === "invalid") {
				// Retrying ONE bad read forever is the leak this validation exists to
				// close: the tick would throw (or, worse, finalize a run from a shape
				// it misread), log, and reschedule forever. But failing on the first one
				// would kill a healthy child whose file was caught mid-write by a
				// non-atomic writer, or whose read hit a transient errno. So a sustained
				// run of them is required — the same policy as an unreachable tmux.
				// markRunFailed clears the timer and this path returns without
				// `scheduleWatch`, so the watcher stops here.
				if (countResultFailure(run) >= MAX_TRANSIENT_RESULT_FAILURES) {
					// Carry the retained pane (the last watcher capture) into the error.
					// `settleRun` reaps the session immediately, so once this run is
					// terminal the pane snapshot in the record is the only trace of what
					// the child was doing; a fan-out wait no longer renders it separately.
					await markRunFailed(run, unusableResultMessage(run, result.error, { pane: true }));
					void drainQueue();
					return;
				}
			} else {
				resultFailures.delete(run.id);
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

			// Escalated questions (local patch 23), read on this same tick: no extra
			// timer, and a question is delivered within one poll of the child writing
			// it. Its own try so a channel problem cannot skip the liveness checks that
			// follow; nothing in it can finish or fail the run.
			try {
				await handleEscalation(run);
			} catch (error) {
				console.error(`[tmux-subagent] escalation read failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
			}

			const paneResult = await pi.exec("tmux", tmuxArgs("capture-pane", "-p", "-J", "-t", run.tmuxTarget), {
				timeout: TMUX_EXEC_TIMEOUT_MS,
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

			const dead = await pi.exec("tmux", tmuxArgs("display-message", "-p", "-t", run.tmuxTarget, "#{pane_dead}"), {
				timeout: TMUX_EXEC_TIMEOUT_MS,
			});
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
		scheduleWatch(run);
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
			if (run.status === "cancelled") return;
			const tmuxVersion = await pi.exec("tmux", ["-V"], { timeout: TMUX_EXEC_TIMEOUT_MS });
			if (tmuxVersion.code !== 0) {
				throw new Error(`tmux is required for subagents: ${tmuxVersion.stderr.trim() || "tmux not found"}`);
			}

			const created = await pi.exec(
				"tmux",
				tmuxArgs("new-session", "-d", "-s", run.tmuxSession, "-n", "pi", "-c", run.cwd),
				{ timeout: TMUX_EXEC_TIMEOUT_MS },
			);
			if (created.code !== 0) {
				throw new Error(`Failed to create tmux session: ${created.stderr.trim() || created.stdout.trim()}`);
			}

			const remain = await pi.exec(
				"tmux",
				tmuxArgs("set-window-option", "-t", `${run.tmuxSession}:0`, "remain-on-exit", "on"),
				{ timeout: TMUX_EXEC_TIMEOUT_MS },
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
				// The child's own copy wins when its tree has one, but only for a
				// trusted tree: an explicit --extension bypasses project trust, so
				// naming an untrusted cwd's copy would execute that tree's code.
				// See handoff.ts.
				extensionPath: resolveChildExtensionPath(run.cwd, EXTENSION_PATH, run.trusted),
				promptPath,
			});
			const childCommand = [
				"exec env",
				`${CHILD_ENV}=1`,
				// The orchestrator's process role, written as a literal like the others.
				// It is a separate marker because the child-mode variable above is
				// scrubbed from the child's environment at startup, and the orchestrator
				// must still know it is a worker after that scrub.
				"PI_ORCHESTRATOR_ROLE=worker",
				`${RESULT_ENV}=${shellQuote(run.resultPath)}`,
				`${INTERRUPT_ENV}=${shellQuote(getInterruptFilePath(run.runDir))}`,
				// Local patch 23: the channel directory, which is also the child's
				// permission to ask. Written as a literal, like the others, so the child
				// reads it from its own environment only.
				`${ESCALATION_ENV}=${shellQuote(escalationDir(run.runDir))}`,
				piArgs.map(shellQuote).join(" "),
			].join(" ");

			// A stop policy may have abandoned this run while its tmux session was being
			// prepared. No child has started yet, so cancel here rather than launch a
			// step the plan already marked cancelled.
			if (run.status === "cancelled") {
				await killTmuxSession(run);
				return;
			}
			const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "-l", "--", childCommand), {
				timeout: TMUX_EXEC_TIMEOUT_MS,
			});
			if (sent.code !== 0) throw new Error(sent.stderr.trim() || "Failed to start child Pi.");
			if (run.status === "cancelled") {
				await killTmuxSession(run);
				return;
			}
			const entered = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "Enter"), {
				timeout: TMUX_EXEC_TIMEOUT_MS,
			});
			if (entered.code !== 0) throw new Error(entered.stderr.trim() || "Failed to submit child command.");
			// The submission itself is also a window: a stop policy can abandon this
			// step while Enter is in flight. Without this check the run resurrects
			// from cancelled to running, a child the policy refused is left running,
			// and the plan step it belongs to can never learn the outcome.
			if (run.status === "cancelled") {
				await killTmuxSession(run);
				return;
			}

			run.status = "running";
			run.startedAt = Date.now();
			await persist();
			scheduleWatch(run);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await killTmuxSession(run);
			await markRunFailed(run, message);
		}
	};

	const drainQueue = async (): Promise<void> => {
		while (activeCount() < maxConcurrent) {
			const admitted: RunRecord[] = [];
			while (activeCount() < maxConcurrent) {
				const next = [...runs.values()].find((run) => run.status === "queued");
				if (!next) break;
				next.status = "running";
				next.startedAt = Date.now();
				launching.add(next.id);
				admitted.push(next);
			}
			if (admitted.length === 0) return;
			await persist();
			await Promise.allSettled(
				admitted.map(async (run) => {
					try {
						await launchRun(run);
					} finally {
						launching.delete(run.id);
					}
				}),
			);
		}
	};

	const startRun = async (run: RunRecord): Promise<void> => {
		runs.set(run.id, run);
		// Announced before the queue admits it: the parent's live set must include a
		// run from the moment the tool returned its id, queued or not.
		publishRunStarted(run);
		await persist();
		await drainQueue();
		// Show the run in the widget now rather than up to 500ms later on the first
		// watcher tick: "I started something" deserves an immediate answer.
		refreshStatusWidget();
	};

	// --- Dependency plans -----------------------------------------------------
	//
	// A plan's steps are launched through the SAME `startRun`/`drainQueue` path as
	// a standalone run, so fan-out children share the one concurrency budget
	// instead of opening a second queue. The plan record is advanced from the
	// settle path (see `advancePlanForRun`), never from a scheduler of its own.

	/** Build the run record for one attempt of a plan step. No I/O, no launch. */
	const buildPlanRun = (plan: PlanRecord, step: PlanStepState): RunRecord => {
		const id = randomUUID();
		const runDir = path.join(sessionRunsDir, id);
		const tmuxSession = tmuxSessionName(id);
		const run: RunRecord = {
			id,
			task: step.task,
			cwd: step.cwd,
			provider: step.provider,
			model: step.model,
			thinking: step.thinking,
			tmuxSession,
			tmuxTarget: `${tmuxSession}:0.0`,
			attachCommand: "",
			captureCommand: "",
			runDir,
			resultPath: path.join(runDir, "result.json"),
			trusted: step.trusted,
			status: "queued",
			createdAt: Date.now(),
			mode: step.handoff as LaunchMode,
			attempt: step.attempts + 1,
			planId: plan.id,
			stepId: step.id,
			// Local patch 23: plan steps get the same channel as standalone runs.
			escalation: true,
		};
		updateTmuxCommands(run);
		return run;
	};

	/**
	 * Prepare and start one attempt of a plan step.
	 *
	 * The attempt is counted (`markStepLaunched`) BEFORE any filesystem work, so a
	 * launch that throws still consumes retry budget and cannot loop forever. The
	 * handoff snapshot for a retry is taken when that retry launches, because each
	 * attempt owns a fresh run dir and its seeded session file lives inside it.
	 */
	const launchPlanStep = async (plan: PlanRecord, step: PlanStepState): Promise<void> => {
		if (plan.status !== "running" || step.status !== "pending") return;
		const run = buildPlanRun(plan, step);
		if (!markStepLaunched(plan, step.id, run.id)) return;
		try {
			await mkdir(run.runDir, { recursive: true, mode: 0o700 });
			await mkdir(path.join(run.runDir, "session"), { recursive: true, mode: 0o700 });
			await writeFile(path.join(run.runDir, "task.md"), buildChildTaskPrompt(run.task), {
				encoding: "utf8",
				mode: 0o600,
			});
			if (usesSessionFile(run.mode ?? "standalone")) {
				// `sessionContext` is the CURRENT session's ctx, refreshed by every
				// `ensureSessionPaths` call. A plan resumed after a reload must hand off
				// from the branch the loading session is on, never from whatever context
				// created the plan — that context is stale, and forking it would seed the
				// child with a conversation the user has already left.
				if (!sessionContext) throw new Error("No parent session context is available for a handoff step.");
				await prepareHandoffSession(run, sessionContext);
			}
			// A sibling failure under `failurePolicy: "stop"`, `subagent_cancel`, or
			// `session_shutdown` may have ended the plan or step while async setup
			// (`mkdir` / `writeFile` / `prepareHandoffSession`) was in flight. Re-check
			// before `startRun(run)` so we never spawn an orphan tmux session.
			if (shuttingDown || plan.status !== "running" || step.status !== "running") {
				if (step.status === "running") {
					step.status = "cancelled";
					step.finishedAt = Date.now();
					step.error ??=
						plan.status === "failed"
							? "Abandoned: the plan stopped after another step failed."
							: shuttingDown
								? "Cancelled: session shut down before the step launched."
								: "Cancelled: the plan was cancelled before the step launched.";
				}
				run.status = "cancelled";
				run.finishedAt = Date.now();
				run.error = run.error ?? step.error ?? plan.reason ?? "Cancelled before launch.";
				runs.set(run.id, run);
				publishRunSettled(run);
				notifyWaiters(run);
				if (!shuttingDown && plan.status === "running") {
					await applyPlanAdvance(plan, resolvePlan(plan));
				} else {
					publishPlanSettled(plan);
					notifyPlanWaiters(plan);
					await persist();
					refreshStatusWidget();
				}
				return;
			}
			await startRun(run);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await persist();
			await applyPlanAdvance(plan, failPlanStep(plan, step.id, `Failed to launch step ${step.id}: ${message}`));
		}
	};

	/** Abandon a step's run while it is still only queued: it never started. */
	const abandonQueuedStep = async (step: PlanStepState, reason: string): Promise<void> => {
		const runId = step.runIds.at(-1);
		const run = runId ? runs.get(runId) : undefined;
		// A step whose child is already alive is left to record its own outcome: the
		// failure policy only prevents further STARTS, and cancelling a live child is
		// `subagent_cancel`'s job (which also settles the plan step).
		// `launching` covers the admitted-but-not-submitted window: the queue flipped
		// the run to `running` before its child command went out, and `launchRun`
		// re-checks this cancellation before submitting.
		if (!run || (run.status !== "queued" && !launching.has(run.id))) return;
		step.status = "cancelled";
		step.finishedAt = Date.now();
		clearTimer(run.id);
		run.status = "cancelled";
		run.finishedAt = Date.now();
		run.error = run.error ?? reason;
		// A queued run is live to a parked parent too: abandoning it is terminal.
		publishRunSettled(run);
		notifyWaiters(run);
	};

	/**
	 * Apply a plan reduction: abandon what the policy cancelled, then start what
	 * is ready. Idempotent because the reduction itself is (see plan.ts).
	 */
	const applyPlanAdvance = async (
		plan: PlanRecord,
		advance: ReturnType<typeof settlePlanStep>,
	): Promise<void> => {
		// Whatever this reduction did, a plan that is no longer running releases the
		// callers waiting on `subagent_wait({ plan })`. Done before the early return
		// so a reduction that only recorded a late step outcome still releases them.
		notifyPlanWaiters(plan);
		if (!advance.changed) return;

		if (advance.stop) {
			// `stop` means no further step STARTS. Queued runs belong to steps that
			// were admitted but never got a child, so they are abandoned here; live
			// children keep running and record their own outcome — cancelling a live
			// child is `subagent_cancel`'s job, not a failure policy's.
			for (const stepId of queuedStopCandidates(plan)) {
				const step = plan.steps.find((candidate) => candidate.id === stepId);
				if (step) await abandonQueuedStep(step, "Abandoned: the plan stopped after another step failed.");
			}
		}
		for (const stepId of advance.cancelled) {
			const step = plan.steps.find((candidate) => candidate.id === stepId);
			if (!step) continue;
			if (step.runIds.length > 0) await abandonQueuedStep(step, "Abandoned: a dependency failed.");
		}

		await persist();
		publishPlanSettled(plan);

		for (const stepId of advance.launch) {
			if (plan.status !== "running") break;
			const step = plan.steps.find((candidate) => candidate.id === stepId);
			// Re-checked here, synchronously with `launchPlanStep`'s own guard: a
			// second advance (a settlement landing right after `session_start`, or a
			// reconciliation) may have launched this step already, and `pending` is
			// the only truthful state to launch from.
			if (!step || step.status !== "pending") continue;
			await launchPlanStep(plan, step);
		}
		notifyPlanWaiters(plan);
		refreshStatusWidget();
	};

	/**
	 * The settle path's plan hook: called once per settled run, right where the
	 * run's own finalisation has already been persisted and announced.
	 *
	 * Two outcomes reach the plan from here. `completed` / `failed` go through
	 * `settlePlanStep`. `cancelled` goes through `cancelPlanStep`, because a cancel
	 * produces no result file and never reaches the finaliser: without this the
	 * step would stay `running` with nothing left able to settle it.
	 */
	const advancePlanForRun = async (run: RunRecord): Promise<ReturnType<typeof settlePlanStep> | undefined> => {
		if (!run.planId || !run.stepId) return undefined;
		const plan = plans.get(run.planId);
		if (!plan) return undefined;
		const advance =
			run.status === "cancelled"
				? cancelPlanStep(plan, run.stepId, `Cancelled: step "${run.stepId}" was cancelled.`)
				: run.status === "completed" || run.status === "failed"
					? settlePlanStep(plan, {
							stepId: run.stepId,
							runId: run.id,
							outcome: run.status,
							error: run.error,
						})
					: undefined;
		if (!advance) return undefined;
		await applyPlanAdvance(plan, advance);
		return advance;
	};

	/**
	 * Take a run out of service: kill its child, mark it cancelled and read the
	 * usage it already burned.
	 *
	 * Shared by `subagent_cancel` and the plan-level cascade so both cancel the
	 * same way. The caller persists and wakes waiters, because a plan cancel does
	 * both once for several runs.
	 *
	 * Returns false for a run that is already settled and owns no child, so an
	 * idempotent cascade cannot report work it did not do.
	 */
	const cancelRunRecord = async (run: RunRecord, reason?: string): Promise<boolean> => {
		if (isTerminal(run.status) && !holdsChild(run.status)) return false;
		clearTimer(run.id);
		resultFailures.delete(run.id);
		run.interruptRequestedAt = undefined;
		run.pendingRequest = undefined;
		await killTmuxSession(run);
		run.status = "cancelled";
		run.finishedAt = Date.now();
		if (reason) run.error ??= reason;
		// A cancelled run is very often one that had already spent real tokens;
		// read them before the terminal status is persisted, not never. The session
		// file survives the tmux kill, so this is still readable.
		await captureRunUsage(run);
		// Cancellation is terminal for a parked parent, not only for status/wait.
		publishRunSettled(run);
		return true;
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
		// The drain is the CALLER's step, not this one: admitting a queued run before
		// reconciliation has folded the plan in launches work a `stop` policy already
		// refused (a crash between the two index writes leaves exactly that state).
	};

	/**
	 * Read persisted plans so a later persist does not erase them.
	 *
	 * Loading does NOT reduce a plan by itself; `reconcileLoadedPlans` runs once
	 * after the run index is loaded and is the only thing that may resume one.
	 */
	const loadPersistedPlans = async (): Promise<void> => {
		if (!plansIndexPath) return;
		let parsed: PlanRecord[];
		try {
			parsed = JSON.parse(await readFile(plansIndexPath, "utf8")) as PlanRecord[];
		} catch {
			return;
		}
		for (const plan of parsed) {
			if (!plan?.id || !Array.isArray(plan.steps)) continue;
			plans.set(plan.id, plan);
		}
	};

	/**
	 * One-shot, load-time reconciliation of every persisted plan (R23).
	 *
	 * The rules live in `plan.ts` (`reconcilePlan`) because they are pure. What
	 * matters here is WHERE the run view comes from: `runs` as loaded, which is
	 * the whole truth about what a child is doing — and the reason the plan index
	 * can be behind it. A test that seeded a plan index by hand (or a crash
	 * between the two renames) lands here.
	 *
	 * Runs are matched by `planId` + `stepId` rather than by the step's recorded
	 * `runIds`, so a run the plan index never wrote is still found. An `interrupted`
	 * run is matched too and counts as live: its child still exists.
	 *
	 * Idempotent against the settle path. Every reduction goes through the same
	 * guarded plan functions, and a step is launched only while it is `pending`, so
	 * a settlement landing right after `session_start` cannot double-launch one.
	 * This runs once per loaded session; the settle path stays the advance source
	 * and no timer is created here.
	 */
	const reconcileLoadedPlans = async (): Promise<void> => {
		if (plansReconciled) return;
		plansReconciled = true;
		for (const plan of [...plans.values()]) {
			const runsByStep: Record<string, PlanStepRun[]> = {};
			for (const run of runs.values()) {
				if (run.planId !== plan.id || !run.stepId) continue;
				(runsByStep[run.stepId] ??= []).push({
					runId: run.id,
					status: run.status,
					error: run.error,
					createdAt: run.createdAt,
				});
			}
			const { advance, recovered } = reconcilePlan(plan, runsByStep);
			if (recovered.length > 0) {
				console.error(`[tmux-subagent] plan ${plan.id} reconciled after reload: ${recovered.join("; ")}`);
			}
			await applyPlanAdvance(plan, advance);
		}
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
		sessionContext = ctx;
		if (runsIndexPath) return;
		sessionId = ctx.sessionManager.getSessionId();
		sessionRunsDir = path.join(getAgentDir(), RUNS_DIR, sessionId);
		runsIndexPath = path.join(sessionRunsDir, "runs.json");
		plansIndexPath = path.join(sessionRunsDir, "plans.json");
		await mkdir(sessionRunsDir, { recursive: true, mode: 0o700 });
		// Plans FIRST: everything below may persist (reconciliation, then the drain),
		// and persisting with an empty plans map would erase `plans.json` before it
		// was ever read.
		await loadPersistedPlans();
		await loadPersistedRuns();
		// Then, once, reconcile what the reload missed. After BOTH indexes are in
		// memory, because reconciliation's job is to make them agree.
		await reconcileLoadedPlans();
		// Only now may queued runs be admitted: a queued plan step whose failure is
		// still only in `runs.json` must be abandoned by the policy first.
		await drainQueue();
		// The reload rebuild: whatever is still queued, running or interrupted after
		// reconciliation and the drain is the live set a parent needs before its
		// first settlement in this session.
		publishRunsSnapshot();
		void gcRunDirectories();
	};

	// Registered before the first await: `ensureSessionPaths` does filesystem I/O
	// and can reject, and the tools must not disappear with it.
	pi.on("before_agent_start", () => {
		registerManagementTools();
	});

	pi.on("session_start", async (_event, ctx) => {
		registerManagementTools();
		await ensureSessionPaths(ctx);
		// Remember where the widget would live, but do not install it yet: pi
		// re-arms this extension on reload, and an idle session must not leave an
		// empty strip above the editor. The first live run installs it.
		if (ctx.mode === "tui") statusUi = ctx;
		refreshStatusWidget();
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		// First, before any kill-on-shutdown flip: every pending wait is ending,
		// and none of them settled, whatever the run status becomes below.
		for (const end of [...endWaiters]) end();
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		for (const timer of reapTimers.values()) clearTimeout(timer);
		reapTimers.clear();
		// The widget and its ticker are parent-session furniture: both must go when
		// the session does, or the ticker keeps the event loop alive (local patch 10).
		stopWidgetTimer();
		clearWidget();
		statusStates.clear();
		// Per-session scratch: a reload builds a fresh closure, so this is belt and
		// braces, but it keeps the one piece of in-flight resume state from outliving
		// the session if the closure is ever reused.
		reservedResumes.clear();
		statusUi = undefined;
		for (const run of runs.values()) {
			// A blocked child reads the heartbeat to decide whether a parent is there, so
			// removing it is how shutdown says "nobody is left to answer" (local patch
			// 23). Its staleness check would notice within seconds regardless; this makes
			// it the child's very next poll. No timer is involved on either side.
			if (run.escalation) {
				await clearEscalationHeartbeat(escalationDir(run.runDir)).catch(() => undefined);
			}
			if (killOnShutdown && holdsChild(run.status)) {
				run.status = "cancelled";
				run.finishedAt = Date.now();
				// A killed child has no question left to answer. Leaving it would let a
				// reload surface a dialog for a run that no longer exists.
				run.pendingRequest = undefined;
				run.escalation = undefined;
				await killTmuxSession(run);
				// Kill first, then read: the child has stopped writing, but the tokens it
				// already burned are still its own. Same reason as subagent_cancel.
				await captureRunUsage(run);
				// The parent may be parked on this run; a shutdown kill releases it.
				publishRunSettled(run);
				notifyWaiters(run);
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

	/**
	 * Per-step shape shared by the fan-out surface.
	 *
	 * `tasks` is the ONE plan shape: an item with no `dependsOn` is a fan-out
	 * step with no edges, so a plain fan-out and a dependency graph take the same
	 * validation path and produce the same plan record. The top-level `task`
	 * parameter is retained as sugar for a one-step plan because it is the
	 * standalone contract existing callers already use; the two are mutually
	 * exclusive.
	 */
	const stepParameters = Type.Object({
		id: Type.Optional(
			Type.String({ description: "Optional step id, referenced by other steps' dependsOn. Defaults to step-1, step-2, … in request order." }),
		),
		task: Type.String({ description: "The complete task for this child Pi process." }),
		cwd: Type.Optional(Type.String({ description: "Working directory for this step. Defaults to the current project." })),
		provider: Type.Optional(Type.String({ description: "Provider override for this step." })),
		model: Type.Optional(Type.String({ description: "Model id override for this step." })),
		thinking: Type.Optional(
			StringEnum(THINKING_LEVELS, { description: "Thinking level override for this step." }),
		),
		handoff: Type.Optional(
			StringEnum(HANDOFF_MODES, {
				description: "Context handoff for this step. Same meanings as the single-task handoff parameter.",
			}),
		),
		dependsOn: Type.Optional(
			Type.Array(Type.String(), {
				description: "Step ids that must COMPLETE SUCCESSFULLY before this step starts. Omit for an independent fan-out step.",
			}),
		),
		retries: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "Retries allowed AFTER the first attempt for this step. Overrides retryLimit. 0 means one attempt.",
			}),
		),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: SUBAGENT_DESCRIPTION,
		promptSnippet: "Start delegated, non-blocking, tmux-backed Pi subagents (one or a dependency plan)",
		promptGuidelines: [
			"Use subagent to delegate an isolated task without blocking: it returns immediately, so start several when useful and keep working.",
			"For a fan-out, pass `tasks` with per-step overrides instead of several calls: the runs share the same concurrency budget and come back in the order requested. Add `dependsOn` step ids to make a step wait for its dependencies, and choose `failurePolicy` (`continue` by default, or `stop`). A plan is persisted and resumes after a reload at the first unfinished step.",
			"Start, then wait once: collect a finished run's output with subagent_wait({ id }) as soon as you have started the run — or subagent_wait({ ids }) for several runs. For a fan-out or dependency plan use subagent_wait({ plan }) once: later waves have no run ids yet, so the plan id is the only handle that covers all of them. Keep subagent_status for the live 'what is it doing right now' question, and for runs you deliberately left unwaited.",
			"To stop a run that is going the wrong way, prefer subagent_interrupt (keeps the child and its transcript, then attach to steer it) over subagent_cancel (throws the run away). An interrupted run still occupies a concurrency slot until it is cancelled, so cancel the ones you are done with.",
			"subagent_resume needs a run whose child is really gone: cancel or finish it first, or attach to an interrupted run and type the follow-up there.",
		],
		parameters: Type.Object({
			// The standalone contract. Kept optional because a fan-out request
			// supplies `tasks` instead; exactly one of the two is accepted.
			task: Type.Optional(Type.String({ description: "The complete task for one child Pi process. Use `tasks` instead for a fan-out or a dependency plan." })),
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
			tasks: Type.Optional(Type.Array(stepParameters, { description: "A fan-out or dependency plan: several children with per-step overrides. Cannot be combined with `task`." })),
			failurePolicy: Type.Optional(
				StringEnum(["stop", "continue"] as const, {
					description:
						"What a permanently failed step does to the plan. 'continue' (default) cancels only that step's dependents and keeps independent branches running; 'stop' starts nothing further and marks the plan failed.",
				}),
			),
			retryLimit: Type.Optional(
				Type.Integer({ minimum: 0, description: "Default retries after the first attempt for every step. A step's own `retries` overrides it. Default 0." }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Subagent aborted.");
			await ensureSessionPaths(ctx);

			if (params.tasks !== undefined) {
				if (params.task !== undefined) throw new Error("Pass either `task` (one run) or `tasks` (a fan-out/plan), not both.");

				// Everything is resolved and validated BEFORE the plan is recorded or
				// any run exists: a rejected cwd, model or dependency graph must leave
				// nothing launched and nothing half-written.
				const specs: PlanStepSpec[] = [];
				for (const item of params.tasks) {
					const cwd = path.resolve(ctx.cwd, item.cwd?.trim() || ".");
					await validateCwd(cwd);
					const selectedModel = resolveModel(ctx, item.provider, item.model);
					await validateModelSelection(ctx, selectedModel, hasExplicitModelOverride(item.provider, item.model));
					specs.push({
						id: item.id,
						task: item.task,
						cwd,
						provider: selectedModel.provider,
						model: selectedModel.model,
						thinking: item.thinking ?? pi.getThinkingLevel(),
						handoff: item.handoff ?? "standalone",
						trusted: isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted(),
						dependsOn: item.dependsOn,
						retries: item.retries,
					});
				}

				const built = buildPlan(randomUUID(), specs, {
					policy: params.failurePolicy as FailurePolicy | undefined,
					retryLimit: params.retryLimit,
				});
				if (!built.ok) throw new Error(`Plan rejected: ${built.error}`);
				const plan = built.plan;
				plans.set(plan.id, plan);
				await persist();

				for (const stepId of readyStepIds(plan)) {
					if (shuttingDown || plan.status !== "running") break;
					const step = plan.steps.find((candidate) => candidate.id === stepId);
					if (step) await launchPlanStep(plan, step);
				}
				await persist();

				const lines = [
					`Plan ${plan.id} started: ${plan.steps.length} step(s), policy ${plan.policy}` +
						`${plan.steps.some((step) => step.retries > 0) ? `, retry cap ${Math.max(...plan.steps.map((step) => step.retries))}` : ""}.`,
				];
				for (const [index, step] of plan.steps.entries()) {
					const runId = step.runIds.at(-1);
					const state =
						step.status === "pending"
							? `pending (waits for ${step.dependsOn.join(", ")})`
							: `${step.status}${step.attempts > 1 ? ` attempt ${step.attempts}/${step.retries + 1}` : ""}`;
					lines.push(`  ${index + 1}. ${step.id}  ${runId ?? "—"}  ${state}`);
				}
				const ordered = plan.steps
					.map((step) => step.runIds.at(-1))
					.filter((id): id is string => Boolean(id))
					.map((id) => runs.get(id))
					.filter((run): run is RunRecord => Boolean(run));
				// The plan id, not the first wave's run ids: a dependency plan's later
				// steps have no run yet, so no list of ids can cover the whole thing
				// (finding 3 from ticket 05).
				lines.push(
					`Wait: call subagent_wait({ plan: "${plan.id}" }) once — it returns when every step is over, with each step's status and run id.`,
				);
				lines.push(`Inspect or cancel the whole plan with subagent_status({ id }) and subagent_cancel({ id }) on the plan id.`);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { plan, runs: ordered } };
			}

			if (!params.task?.trim()) throw new Error("Subagent task must not be empty. Pass `task` for one run or `tasks` for a fan-out.");

			const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
			await validateCwd(cwd);

			const selectedModel = resolveModel(ctx, params.provider, params.model);
			await validateModelSelection(ctx, selectedModel, hasExplicitModelOverride(params.provider, params.model));
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
				runDir,
				resultPath,
				trusted: false,
				status: "queued",
				createdAt: Date.now(),
				mode,
				attempt: 1,
				// Local patch 23: this build launches a child with an escalation channel.
				escalation: true,
			};
			run.trusted = isSameOrDescendant(path.resolve(ctx.cwd), cwd) && ctx.isProjectTrusted();
			updateTmuxCommands(run);

			await mkdir(runDir, { recursive: true, mode: 0o700 });
			await mkdir(path.join(runDir, "session"), { recursive: true, mode: 0o700 });
			await writeFile(path.join(runDir, "task.md"), buildChildTaskPrompt(params.task), {
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
				`Wait: call subagent_wait({ id: "${id}" }) once to collect the result`,
			].join("\n");
			return { content: [{ type: "text", text }], details: run };
		},

		/**
		 * Add the "the other subagent tools are hidden" note only when they are.
		 *
		 * It is 360 bytes of system prompt per request, and it is a lie in a session
		 * that never enabled codemode or tool_search — where those tools are declared
		 * like any other. pi calls this whenever the active tool set changes, so it
		 * also keeps itself correct if `/tools` turns discovery on mid-session.
		 */
		prepareLoadout(loadout) {
			if (loadout.getExposure("subagent_status") !== "codemode") return undefined;
			const tool = loadout.declared.find((entry) => entry.name === "subagent");
			const description = tool?.description ?? SUBAGENT_DESCRIPTION;
			return {
				descriptions: {
					subagent: `${description} The other subagent tools (subagent_wait, subagent_status, subagent_answer, subagent_cancel, subagent_interrupt, subagent_resume, subagent_clean) are not declared while \`codemode\` or \`tool_search\` is active: reach them with tool_search, or tools.<name>(...) in a codemode script.`,
				},
			};
		},

		renderCall(args, theme) {
			if (Array.isArray(args.tasks)) {
				const steps = args.tasks as { dependsOn?: string[] }[];
				let text =
					theme.fg("toolTitle", theme.bold("subagent plan ")) + theme.fg("dim", `${steps.length} step(s)`);
				const edges = steps.reduce((count, step) => count + (step.dependsOn?.length ?? 0), 0);
				if (edges > 0) text += theme.fg("muted", ` · ${edges} dependency edge(s)`);
				if (args.failurePolicy) text += theme.fg("muted", ` · ${args.failurePolicy}`);
				return new Text(text, 0, 0);
			}
			const task = args.task?.trim() || "...";
			const firstLine = task.split("\n", 1)[0] ?? task;
			const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", preview);
			const overrides = [args.provider, args.model, args.thinking].filter(Boolean);
			if (overrides.length > 0) text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as (RunRecord & { plan?: PlanRecord; runs?: RunRecord[] }) | undefined;
			if (details?.plan) {
				const plan = details.plan;
				let text = `${theme.fg("warning", "●")} ${theme.fg("toolTitle", theme.bold(`plan ${plan.id}`))}`;
				text += theme.fg("muted", ` · ${plan.status} · ${plan.policy}`);
				for (const step of plan.steps) {
					const runId = step.runIds.at(-1) ?? "(pending)";
					const attempt = step.attempts > 1 ? ` · attempt ${step.attempts}/${step.retries + 1}` : "";
					text += `\n  ${step.id} ${runId} ${step.status}${attempt}`;
				}
				return new Text(text, 0, 0);
			}
			const run = details as RunRecord | undefined;
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
			name: "subagent_wait",
			label: "Subagent Wait",
			description:
				"subagent_wait blocks once until a subagent run settles and returns its result, instead of polling subagent_status. With an id: resolves as soon as that run reaches a terminal state (completed, failed, cancelled, interrupted) and returns the same record subagent_status({ id }) returns; if timeoutMs elapses first, returns the current record plus the latest pane output — a timed-out wait is a normal result, never an error. A run still queued at the timeout is reported as queued; a run that failed to start, was cancelled, died or was interrupted is terminal and returns immediately. With plan: waits until a whole dependency plan is over — every step completed, failed or cancelled — and returns the plan's status, its reason and every step's status and latest run id. Use it for a fan-out or a dependency plan instead of ids: later waves' run ids do not exist when the plan's reply is written, so the plan id is the only handle that covers all of them, while ids can only name the runs that exist now. With ids: waits until all of the named runs are terminal (or the timeout) and returns every settled run plus the still-running ones, in the order given; a settled run whose child is gone returns its output (when it has one) without the dead pane, which is carried only for a run whose child is still alive (running or interrupted). If the session ends before the run settles, the call returns early with the current record and reports that the session ended (details.ended), never that the run settled. Built on the existing settle watcher, so results land within about a second of the child's settle event; there is no second poll loop. To ask what a run is doing right now without waiting, use subagent_status.",
			promptSnippet: "Wait once for a subagent run or a whole plan to settle and collect its result",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Run id to wait for. Omit when passing ids or plan." })),
				plan: Type.Optional(
					Type.String({ description: "Plan id to wait for: resolves when the whole plan is terminal, whatever waves are still to launch." }),
				),
				ids: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Several run ids to wait for together. Returns every settled run plus the still-running ones.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description:
							"How long to wait before returning the current state. Defaults to 600000 (10 minutes).",
					}),
				),
			}),

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				await ensureSessionPaths(ctx);
				const given = [params.id, params.plan, params.ids].filter((value) => value !== undefined).length;
				if (given > 1) {
					throw new Error("subagent_wait takes either id or ids, not both — or plan on its own.");
				}
				const timeoutMs = resolveWaitTimeout(params.timeoutMs);
				if (params.plan !== undefined) {
					const id = params.plan.trim();
					const plan = plans.get(id);
					if (!plan) throw new Error(`Unknown subagent plan: ${id}`);
					const { timedOut, ended } = await waitForPlanSettled(plan, timeoutMs, signal);
					const pending = plan.steps.filter((step) => step.status === "running" || step.status === "pending").length;
					const lines = [
						ended
							? `Session ended before plan ${id} finished (status: ${plan.status}, ${pending} step(s) still live). The plan is persisted: reload this session and it resumes at the first unfinished step.`
							: timedOut
								? `Plan ${id} did not finish within ${timeoutMs}ms (status: ${plan.status}, ${pending} step(s) still live). It keeps running; wait again, or inspect it with subagent_status({ id: "${id}" }).`
								: `Plan ${id} finished: ${plan.status}.`,
						"",
						planSummary(plan, runs),
					];
					return { content: [{ type: "text", text: lines.join("\n") }], details: { plan, timedOut, ended, status: plan.status } };
				}
				if (params.id !== undefined) {
					const id = params.id.trim();
					const run = runs.get(id);
					if (!run) throw new Error(`Unknown subagent run: ${id}`);
					const { timedOut, ended } = await waitForRunsSettled([run], timeoutMs, signal);
					const text = ended
						? `Session ended before subagent ${id.slice(0, 8)} settled (status: ${run.status}). The run was not completed; its transcript is preserved.\n\n${runSummary(run, { pane: true, output: true })}`
						: timedOut
							? `Subagent ${id.slice(0, 8)} did not settle within ${timeoutMs}ms (status: ${run.status}).\n\n${runSummary(run, { pane: true, output: true })}`
							: runSummary(run, { pane: true, output: true });
					return { content: [{ type: "text", text }], details: { runs: [run], timedOut, ended } };
				}
				if (params.ids !== undefined) {
					const ids = params.ids.map((value) => value.trim());
					if (ids.length === 0) throw new Error("subagent_wait needs at least one id in ids.");
					const targets: RunRecord[] = [];
					for (const id of ids) {
						const run = runs.get(id);
						if (!run) {
							throw new Error(
								`Unknown subagent run: ${id}` +
									(plans.has(id) ? ". That is a plan id: pass it as plan to wait for the whole plan." : ""),
							);
						}
						targets.push(run);
					}
					const { timedOut, ended } = await waitForRunsSettled(targets, timeoutMs, signal);
					const pendingRuns = targets.filter((run) => !isTerminal(run.status));
					const lines = [
						ended
							? `Session ended before all runs settled: ${targets.length - pendingRuns.length} of ${targets.length} settled, ${pendingRuns.length} still ${pendingRuns.map((run) => run.status).join(", ")}. Not completed; the transcript is preserved.`
							: timedOut
								? `Timed out after ${timeoutMs}ms: ${targets.length - pendingRuns.length} of ${targets.length} run(s) settled, ${pendingRuns.length} still ${pendingRuns.map((run) => run.status).join(", ")}.`
								: `All ${targets.length} run(s) settled.`,
					];
					for (const run of targets) {
						// A settled run's pane is a dead TUI frame (spinner remnants and
						// stale text), not a result: the output is the result. Only a run
						// whose child is still alive needs its pane, which is the same rule
						// the status list uses (`showsPane`). Otherwise a fan-out wait pays
						// one pane per child for nothing — the cost this tool exists to cut.
						// A cancelled run has no output, but the caller issued the cancel and
						// the record retains the last pane for `subagent_status({ id })`; a
						// failed run's error now embeds that pane itself.
						lines.push("", runSummary(run, { pane: showsPane(run.status), output: true }));
					}
					return { content: [{ type: "text", text: lines.join("\n") }], details: { runs: targets, timedOut, ended } };
				}
				throw new Error("subagent_wait needs an id or a list of ids, or plan.");
			},
		},

		{
			name: "subagent_status",
			label: "Subagent Status",
			description:
				"Answer 'what is this run doing right now', or list this session's runs and plans. With an id: that run's status, model, tmux attach command, its final output once finished and its latest pane output while running — or, for a PLAN id, the plan's status, its reason and every step's status, latest run id and error. Without an id: one row per run and one row per plan, each step run of a plan folded into its plan's row so the list stays bounded, with the full detail — pane, activity, attach command, or every plan step — for at most two of them and a one-line row for the rest. Pass compact: true for one line per run and per plan and no pane. To wait for a run or a whole plan to finish, use subagent_wait instead of polling this. Non-blocking.",
			promptSnippet: "Inspect non-blocking subagent runs, plans and their output",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Run id to inspect, or a plan id to inspect that plan. Omit to list all runs and plans in this session." })),
				include_output: Type.Optional(
					Type.Boolean({
						description:
							"List view only. Include each finished run's full output. Defaults to false, because a list of many runs would otherwise carry every answer at once; inspecting a single id always returns its output. The list's detail budget still applies: when it leaves an output out, the reply says how many and which runs to fetch.",
					}),
				),
				compact: Type.Optional(
					Type.Boolean({
						description:
							"List view only. One short line per run and per plan (id, status, elapsed, usage) and no pane or detail block. Defaults to false. Use it for a cheap poll; inspect a specific run or plan by id for its output. Ignored together with an id, which always returns the full record.",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await ensureSessionPaths(ctx);
				const includeOutput = params.include_output ?? false;
				const runsArray = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
				const plansArray = [...plans.values()].sort((a, b) => a.createdAt - b.createdAt);
				if (params.id) {
					const run = runs.get(params.id.trim());
					if (run) {
						// `subagent_wait` is the blocking path, but a finished run's result must
						// still come back here: `include_output` is a LIST-view control and
						// never suppresses the output for a single run.
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
					// The same tool inspects a plan by id: the plan IS the record for its steps,
					// and making a caller guess that step runs are the only handle would hide
					// exactly the status this ticket is about.
					const plan = plans.get(params.id.trim());
					if (plan) {
						return { content: [{ type: "text", text: planSummary(plan, runs) }], details: { plan } };
					}
					throw new Error(`Unknown subagent run or plan: ${params.id}`);
				}
				if (runsArray.length === 0 && plansArray.length === 0) {
					return { content: [{ type: "text", text: "No subagent runs in this session." }], details: { runs: [], plans: [] } };
				}
				// The budget spans the WHOLE list (see listview.ts): without it a poll
				// pays PANE_PREVIEW_LINES for every live run, which at four concurrent
				// runs is most of the payload and says little a status line does not.
				// `compact` drops the detail blocks entirely.
				//
				// A plan and its steps are ONE row, not one row per step: a ten-step plan
				// must not spend the budget ten times (R25), and the plan block names
				// every step's latest run id, so no run becomes unreachable. A run whose
				// plan is gone (or whose plan file was pruned) stays a row of its own.
				const planIds = new Set(plansArray.map((plan) => plan.id));
				const stepRuns = runsArray.filter((run) => run.planId !== undefined && planIds.has(run.planId));
				const entries: (ListRow & { run?: RunRecord; plan?: PlanRecord })[] = [
					...runsArray
						.filter((run) => !(run.planId !== undefined && planIds.has(run.planId)))
						.map((run) => ({ ...listRow(run), run })),
					...plansArray.map((plan) => ({ ...planListRow(plan), plan })),
				].sort((a, b) => a.createdAt - b.createdAt);
				const text = renderRunList({
					runs: entries,
					compact: params.compact === true,
					renderDetail: (entry) => {
						if (entry.plan) return planSummary(entry.plan, runs);
						const run = entry.run as RunRecord;
						// An interrupted run has no final output yet but its pane is the
						// only view of the child's prompt, so it is shown like a running one.
						const live = showsPane(run.status);
						return runSummary(run, { pane: live, output: includeOutput || live });
					},
					// A bound that silently withholds an answer is worse than a big one: a
					// model that cannot tell "left out" from "there is none" will not go and
					// ask. Only include_output can be withheld this way, so only it needs
					// saying; the pane is a nicety the caller did not ask for by name.
					omittedNote: (omitted) => {
						const withheld = omitted.filter((entry) => entry.run && !showsPane(entry.run.status) && entry.run.output !== undefined);
						const notes: string[] = [];
						if (withheld.length > 0) {
							notes.push(
								`${withheld.length} finished run(s) have output that this list's detail budget left out. ` +
									`Call subagent_status({ id }) for each; omit include_output to see status only.`,
							);
						}
						// Plan steps are folded into their plan's row, so `include_output` cannot
						// reach them from here. Say where they went rather than dropping them
						// silently — the plan block in compact/detail form never carries output.
						const folded = includeOutput ? stepRuns.filter((run) => run.output !== undefined) : [];
						if (folded.length > 0) {
							notes.push(
								`${folded.length} plan step run(s) are folded into their plan's row; ` +
									`inspect the plan by id to see each step's run id, then inspect that run by id.`,
							);
						}
						return notes.length > 0 ? notes.join("\n") : undefined;
					},
				});
				return { content: [{ type: "text", text }], details: { runs: runsArray, plans: plansArray } };
			},
		},

		{
			name: "subagent_answer",
			label: "Subagent Answer",
			description:
				"Answer a question a subagent is blocked on. The run's pending question is reported by subagent_status (a run waiting on one says so) and is also delivered as a session message when it arrives; pass that request id with the answer you propose. A decision is CONFIRMED BY A HUMAN: this tool shows the question and your proposed answer to the user and only sends it if they confirm, so nothing here lets a model answer its own child's decision. With no UI to ask (print or JSON mode) it refuses and says why — the child then reaches its deadline and reports the blocker instead of being answered. A child's progress update needs no answer. The answer arrives as the child's tool result, so the child continues in the same turn.",
			promptSnippet: "Answer a subagent's blocking question, after a human confirms it",
			parameters: Type.Object({
				id: Type.String({
					description: "The request id of the pending question, as reported by subagent_status or by the question's session message.",
				}),
				answer: Type.String({
					description:
					"The answer to send. Put in it only what the human confirmed — the child treats it as authoritative and cannot ask again about the same thing.",
				}),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await ensureSessionPaths(ctx);
				const requestId = params.id.trim();
				const answer = params.answer.trim();
				if (!answer) throw new Error("subagent_answer needs a non-empty answer.");

				let target: { run: RunRecord; pending: PendingQuestion } | undefined;
				for (const run of runs.values()) {
					if (run.pendingRequest?.id === requestId) {
						target = { run, pending: run.pendingRequest };
						break;
					}
				}
				if (!target) {
					throw new Error(
						`No subagent question with id ${requestId} is waiting for an answer. ` +
							`The question may already be answered or expired; subagent_status lists runs and says which one is blocked.`,
					);
				}
				const { run, pending } = target;
				if (run.status !== "running") {
					// The child is gone (cancelled, interrupted, settled): a confirm dialog for
					// it would collect an answer nobody can receive. Clear the stale record.
					run.pendingRequest = undefined;
					await persist();
					refreshStatusWidget();
					throw new Error(
						`The run asking question ${requestId} is ${run.status}, so there is no child left to answer. ` +
							`The question was cleared; the run's own record says how it ended.`,
					);
				}
				if (pending.deadlineAt <= Date.now()) {
					// The child's clock has already expired the wait, so a reply now would
					// arrive after it gave up — or worse, be read by a later tool call that
					// reused the id. Clear it and report the expiry.
					run.pendingRequest = undefined;
					await persist();
					refreshStatusWidget();
					throw new Error(
						`The question (${requestId}) passed its deadline at ${new Date(pending.deadlineAt).toISOString()}. ` +
							`It was not delivered and the child was told the answer failed; the child reports the blocker and stops.`,
					);
				}
				if (!ctx.hasUI) {
					// The deliberate refusal (R14): a decision comes from a human or from
					// nobody. Answering it from the model would be the failure this feature
					// exists to prevent, so the tool fails loudly instead and the child times
					// out and reports the blocker.
					throw new Error(
						`subagent_answer needs a human to confirm a decision, and this session has no UI (mode "${ctx.mode}"). ` +
							`The answer was NOT sent. The child waits until ${new Date(pending.deadlineAt).toISOString()}, then reports the blocker and stops. ` +
							`Answer a decision in a TUI or RPC session; never answer one on the child's behalf.`,
					);
				}

				const question = [pending.text];
				if (pending.options && pending.options.length > 0) question.push("", `Proposed answers: ${pending.options.join(" / ")}`);
				const confirmed = await ctx.ui.confirm(
					`Send this answer to subagent ${run.id.slice(0, 8)}?`,
					[
						`The child is blocked on: ${pending.text}`,
						"",
						`Proposed answer: ${answer}`,
						"",
						"The child receives this as its tool result and continues. Only you can decide it; the model cannot.",
					].join("\n"),
				);
				if (!confirmed) {
					return {
						content: [
							{
								type: "text",
								text:
									`Not sent: the human declined to confirm this answer. The question (${requestId}) is still pending until ` +
									`${new Date(pending.deadlineAt).toISOString()}; ask them what to answer, or stop and report that the decision is open.`,
							},
						],
						details: run,
					};
				}

				// The dialog can be open arbitrarily long, so the deadline is re-checked AFTER
				// it: writing a reply the child has already stopped waiting for would leave an
				// orphan file and make "a late answer is never written" false.
				if (pending.deadlineAt <= Date.now()) {
					run.pendingRequest = undefined;
					await persist();
					refreshStatusWidget();
					throw new Error(
						`The question (${requestId}) passed its deadline while the confirmation was open. ` +
							`It was not delivered; the child reports the blocker and stops.`,
					);
				}
				try {
					await writeEscalationReply(escalationDir(run.runDir), {
						version: ESCALATION_VERSION,
						id: pending.id,
						runId: run.id,
						answer,
						answeredAt: Date.now(),
					});
				} catch (error) {
					throw new Error(
						`The confirmed answer could not be delivered to subagent ${run.id}: ${error instanceof Error ? error.message : String(error)}. ` +
							`The question is still pending until ${new Date(pending.deadlineAt).toISOString()}.`,
					);
				}
				run.pendingRequest = undefined;
				await persist();
				refreshStatusWidget();
				return {
					content: [
						{
							type: "text",
							text:
								`Answer delivered to subagent ${run.id}. The child received it as its tool result and continues in the same turn. ` +
								`Collect the run with subagent_wait({ id: "${run.id}" }) or inspect it with subagent_status({ id: "${run.id}" }).`,
						},
					],
					details: run,
				};
			},
		},

		{
			name: "subagent_cancel",
			label: "Subagent Cancel",
			description:
				"Cancel a subagent run by id: kill its tmux session and mark it cancelled. A plan step's plan is settled from the cancellation, so a plan whose only step you cancelled ends there instead of staying running. Pass a PLAN id instead to cancel the whole plan: its live steps are cancelled, steps that never started are cancelled, and completed steps keep their records. Cancelling one step of a `continue` plan leaves independent branches running and cancels only what depended on it, because those steps can never run now; under `stop` nothing further starts.",
			promptSnippet: "Cancel a running non-blocking subagent or a whole plan",
			parameters: Type.Object({
				id: Type.String({ description: "Run id to cancel, or a plan id to cancel the whole plan." }),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				await ensureSessionPaths(ctx);
				const id = params.id.trim();

				const plan = plans.get(id);
				if (plan) {
					const cancelled = cancelPlan(plan, "Cancelled: the plan was cancelled by subagent_cancel.");
					if (!cancelled.changed) {
						return { content: [{ type: "text", text: `Plan ${id} is already ${plan.status}.` }], details: { plan } };
					}
					const dropped = cancelled.cancelled.filter((stepId) => !cancelled.live.includes(stepId));
					const kept = plan.steps.filter((step) => step.status === "completed" || step.status === "failed").map((step) => step.id);
					const cancelledRuns: RunRecord[] = [];
					const liveNotes: string[] = [];
					for (const stepId of cancelled.live) {
						const runId = plan.steps.find((step) => step.id === stepId)?.runIds.at(-1);
						const run = runId ? runs.get(runId) : undefined;
						liveNotes.push(`${stepId} (${runId ?? "no run"})`);
						if (run && (await cancelRunRecord(run, `Cancelled: plan ${plan.id} was cancelled.`))) cancelledRuns.push(run);
					}
					await persist();
					publishPlanSettled(plan);
					for (const run of cancelledRuns) notifyWaiters(run);
					notifyPlanWaiters(plan);
					refreshStatusWidget();
					void drainQueue();
					const lines = [
						plan.status === "cancelled"
							? `Plan ${id} cancelled.`
							: `Plan ${id} was already ${plan.status}; released the children it still owned.`,
						`  live steps cancelled: ${liveNotes.join(", ") || "none"}`,
						`  not started, cancelled: ${dropped.join(", ") || "none"}`,
						`  kept with their records: ${kept.join(", ") || "none"}`,
					];
					return { content: [{ type: "text", text: lines.join("\n") }], details: { plan, runs: cancelledRuns } };
				}

				const run = runs.get(id);
				if (!run) throw new Error(`Unknown subagent run: ${id}`);
				// An interrupted run is terminal but still owns a live child, so cancel
				// must keep working for it: cancelling is how an interrupted child is
				// finally released.
				if (isTerminal(run.status) && !holdsChild(run.status)) {
					return { content: [{ type: "text", text: `Subagent ${id} is already ${run.status}.` }], details: run };
				}
				await cancelRunRecord(run);
				await persist();
				notifyWaiters(run);
				// The cancel path is the second place that knows a step ended: settle it,
				// or a plan whose only step was cancelled waits forever for a result that
				// will never exist.
				const advance = await advancePlanForRun(run);
				refreshStatusWidget();
				void drainQueue();
				const lines = [`Subagent ${id} cancelled.`];
				const parentPlan = run.planId ? plans.get(run.planId) : undefined;
				if (advance?.changed && parentPlan) {
					lines.push(`Plan ${parentPlan.id} step "${run.stepId}": cancelled.`);
					if (advance.cancelled.length > 0) {
						lines.push(`Also cancelled, because they can never run now: ${advance.cancelled.join(", ")}.`);
					}
					lines.push(`Plan status: ${parentPlan.status}${parentPlan.reason ? ` — ${parentPlan.reason}` : ""}.`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: run };
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
				const sent = await pi.exec("tmux", tmuxArgs("send-keys", "-t", run.tmuxTarget, "Escape"), {
					timeout: TMUX_EXEC_TIMEOUT_MS,
				});
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

				// No plan hook here, deliberately. A plan step is settled by the finaliser,
				// by `subagent_cancel` and by load reconciliation — not by an interrupt,
				// because an interrupted child is still alive with the watcher still
				// polling: the step stays `running` and can still settle from a later
				// result. It is the cancel that eventually releases that child, and that
				// is the call which settles the step.
				const lines =
					outcome.state === "confirmed"
						? [
								`Subagent ${id} interrupted.`,
								"The child aborted its current turn and is idle at its prompt; its session file is intact.",
								`Next: attach (${run.attachCommand}) to steer it, or subagent_cancel to stop it. It still holds its concurrency slot until then.`,
							]
						: outcome.state === "superseded"
							? [
									`Escape sent to subagent ${id}, but the run had already reached ${outcome.runStatus} when the abort was reported, so the interrupt did not change its status.`,
									`The run is ${outcome.runStatus}; inspect it with subagent_status({ id: "${id}" }).`,
								]
							: outcome.state === "stale"
							? [
									`Escape sent to subagent ${id}, but no new interrupt was reported: the only marker present is the one from the previous interrupt${outcome.marker.interruptedAt ? ` at ${new Date(outcome.marker.interruptedAt).toISOString()}` : ""}.`,
									"The child either was idle (Escape does nothing then) or has not aborted yet. Attach to see, and use subagent_cancel to stop it.",
								]
							: [
									`Escape sent to subagent ${id}, but it did not confirm an interrupt within ${formatConfirmWindow(interruptConfirmMs)} (status is still ${run.status})${outcome.aborted ? ", and this tool call was cancelled" : ""}.`,
									`The child was probably already idle — Escape does nothing while it waits at its prompt — or it is stuck somewhere Escape does not reach. Attach with ${run.attachCommand} to look, and use subagent_cancel to stop it.`,
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

				// The scan above only sees runs that have ALREADY registered. The work
				// below (mkdir, countSessionLines) awaits before the new run lands, so a
				// second resume fired without awaiting this one would pass the same scan.
				// Claim the transcript synchronously — no await between the check and the
				// add — and release it once the run is registered, where the scan sees it.
				if (reservedResumes.has(sessionFile)) {
					throw new Error(
						`Another resume of session file ${sessionFile} is already starting. ` +
							`Wait for it to launch, then resume it instead of ${previous.id}.`,
					);
				}
				reservedResumes.add(sessionFile);
				try {
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
						runDir,
						resultPath: path.join(runDir, "result.json"),
						status: "queued",
						createdAt: Date.now(),
						startedAt: undefined,
						finishedAt: undefined,
						pane: undefined,
						output: undefined,
						// The ancestor's artifact belongs to the ancestor's run dir and
						// describes the ancestor's answer; inheriting it would report a
						// previous attempt's report as this one's from the moment it is
						// queued, and keep it if this attempt is cancelled.
						report: undefined,
						error: undefined,
						usage: undefined,
						activity: undefined,
						// Interrupt history belongs to the run that owns it: a fresh child was
						// never sent an Escape, and inheriting the counters would make
						// subagent_status report an interrupt for an attempt that had none.
						interrupts: undefined,
						interruptedAt: undefined,
						interruptRequestedAt: undefined,
						// A pending question belongs to the attempt that asked it: this attempt
						// gets a fresh channel, so inheriting one would report a blocked run that
						// is not blocked and point subagent_answer at a dead request.
						pendingRequest: undefined,
						escalation: true,
						mode: "resume",
						resumeOf: previous.id,
						attempt: (previous.attempt ?? 1) + 1,
						planId: undefined,
						stepId: undefined,
						sessionFile,
					};
					updateTmuxCommands(run);

					await mkdir(runDir, { recursive: true, mode: 0o700 });
					await mkdir(path.join(runDir, "session"), { recursive: true, mode: 0o700 });
					await writeFile(path.join(runDir, "task.md"), buildChildTaskPrompt(message), {
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
				} finally {
					// `startRun` has registered the run, so the ordinary scan sees it now;
					// the claim has done its job either way.
					reservedResumes.delete(sessionFile);
				}
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

				const targets: RunRecord[] = [...runs.values()];
				const foreignRemovedIds = new Map<string, Set<string>>();
				const runOrigin = new Map<RunRecord, string>();

				if (params.all_sessions) {
					const root = path.join(getAgentDir(), RUNS_DIR);
					let dirs: Dirent[] = [];
					try {
						dirs = await readdir(root, { withFileTypes: true });
					} catch {
						dirs = [];
					}
					for (const entry of dirs) {
						if (!entry.isDirectory() || entry.name === sessionId) continue;
						const indexPath = path.join(root, entry.name, "runs.json");
						try {
							const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
							if (!Array.isArray(parsed)) continue;
							const foreignRuns = parsed.filter(
								(run): run is RunRecord => Boolean(run && typeof run === "object" && (run as RunRecord).id),
							);
							foreignRemovedIds.set(indexPath, new Set());
							for (const run of foreignRuns) {
								targets.push(run);
								runOrigin.set(run, indexPath);
							}
						} catch {
							// No index for this directory.
						}
					}
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
					if (deleteFiles && run.runDir && runDirOwnsLiveTranscript(run, targets)) {
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
						if (runs.get(run.id) === run) {
							runs.delete(run.id);
						} else {
							const origin = runOrigin.get(run);
							if (origin) foreignRemovedIds.get(origin)?.add(run.id);
						}
					}
				}
				if (deleteFiles) {
					await persist();
					for (const [indexPath, removedIds] of foreignRemovedIds) {
						if (removedIds.size === 0) continue;
						try {
							const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
							if (!Array.isArray(parsed)) continue;
							const freshRuns = parsed.filter(
								(run): run is RunRecord => Boolean(run && typeof run === "object" && (run as RunRecord).id),
							);
							const remaining = freshRuns.filter((run) => !removedIds.has(run.id));
							await writeJsonAtomic(indexPath, remaining);
						} catch (error) {
							const code = (error as NodeJS.ErrnoException | undefined)?.code;
							if (code === "ENOENT") continue;
							console.error(
								`[tmux-subagent] Failed to persist cleaned runs to ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					}
				}
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
	markerIsNewerThan,
	isTerminal,
	listRow,
	observationFromRead,
	openSubagentPanel,
	readBooleanEnv,
	readIntEnv,
	readNonNegativeIntEnv,
	resolveManagementExposure,
	resolveModel,
	resolveWaitTimeout,
	runDirOwnsLiveTranscript,
	runSummary,
	setPanelLauncher: (launcher?: PanelLauncher): void => {
		panelLauncher = launcher ?? defaultPanelLauncher;
	},
	shellQuote,
	startRepeatingRefresh,
	statusDetail,
	showsPane,
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
