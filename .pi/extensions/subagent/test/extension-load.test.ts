// Regression guard: every vendored extension must load under a strict ESM
// loader.
//
// pi loads extensions through jiti, whose CJS interop resolves missing named
// exports lazily — a module importing a symbol that pi 1.0 removed (e.g.
// `complete` from pi-ai) still "loads" through jiti and only fails when the
// code path runs. Importing the modules here with `node --test` uses the real
// ESM linker, so a removed import fails at load time and this test goes red.
//
// Importing these modules has no side effects: each only evaluates its factory
// definition and its constant tables; nothing touches the filesystem, the
// network or pi's session state until the factory is called with an API.
//
// todos.ts was previously deliberately absent: it used a TypeScript parameter
// property, which node's strip-only loader rejects
// (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) even though pi's jiti loader accepts it.
// Removing that property for the todos-tool dedup also uncovered a genuine
// strict-ESM bug the exclusion had been hiding — `TUI` is a type-only export of
// pi-tui and was imported as a value — so todos.ts is listed here now.

import assert from "node:assert/strict";
import { test } from "node:test";

const EXTENSIONS = [
	"../../answer.ts",
	"../../btw/index.ts",
	"../../continue.ts",
	"../../goal.ts",
	"../../mcp-catalogue.ts",
	"../../native-web-search.ts",
	"../../opencode-go-provider/index.ts",
	"../../orchestrator/index.ts",
	"../../repo-explorer/index.ts",
	"../../review-triage/index.ts",
	"../../review.ts",
	"../../session-breakdown.ts",
	"../../todos.ts",
	"../index.ts",
	"../../voice/index.ts",
] as const;

// Extension tree files that are not entry points themselves but get imported
// by one at runtime; same rationale, they must link under the real ESM
// loader. The exports an importer will use are named, so an accidental drop
// of one fails here instead of at wiring time.
const MODULES: Record<string, string[]> = {
	"../../btw/launch.ts": [
		"buildBtwKillServerArgs",
		"buildBtwPaths",
		"buildBtwRemainOnExitArgs",
		"buildBtwSendKeysArgs",
		"buildBtwSessionCreateArgs",
		"buildBtwSubmitArgs",
		"buildBtwViewerCommand",
		"btwAnswerPath",
		"btwOwnerPidPath",
		"btwRootDir",
		"btwRunDir",
		"btwSessionName",
		"btwSocketPath",
		"btwTarget",
		"btwPanelPath",
		"requireBtwQuestion",
	],
	"../../btw/markdown.mjs": ["createMarkdownView"],
	"../../btw/theme.mjs": ["buildThemeSpec", "installThemeSpec", "themeTokenValues"],
	"../../btw/entry-points.mjs": ["resolvePiEntryPoints"],
	"../../btw/request.ts": [
		"buildBtwContext",
		"buildBtwRequestParts",
		"fenceCloser",
		"openCodeFence",
		"providerSessionHeaders",
		"reasoningOption",
		"runBtwRequest",
		"runBtwStream",
		"sanitizeAnswerText",
	],
	"../../repo-explorer/git.ts": ["openGit", "RepoGitError"],
	"../../repo-explorer/runner.ts": ["makeGitRunner"],
	"../../repo-explorer/branch-menu.ts": ["buildBranchMenu", "resolveBranchChoice", "chooseBranch"],
	"../../repo-explorer/quick-open.ts": ["parseExploreArgs", "resolveQuickBranch", "normalizeRepoPath", "tokenizeArgs"],
	"../../repo-explorer/file-browser.ts": ["FileBrowser", "listDirectory", "parentPath"],
	"../../repo-explorer/file-transcript.ts": ["formatFileTranscript", "numberLines", "fileMessageRenderer"],
	"../../repo-explorer/sanitize.ts": ["sanitizeDisplay", "sanitizeFileContent"],
	"../escalation.ts": [
		"clearEscalationHeartbeat",
		"consumeEscalationExchange",
		"escalationDir",
		"isValidRequestId",
		"listEscalationRequests",
		"readEscalationHeartbeat",
		"readEscalationReply",
		"readEscalationRequest",
		"replyPath",
		"requestPath",
		"touchEscalationHeartbeat",
		"validateEscalationReply",
		"validateEscalationRequest",
		"waitForEscalationReply",
		"writeEscalationReply",
		"writeEscalationRequest",
	],
	"../handoff.ts": [
		"buildChildPiArgs",
		"countSessionLines",
		"forkLiveBranch",
		"getPiInvocationParts",
		"requireExistingSession",
		"resolveChildExtensionPath",
		"seedLineageSession",
		"usesSessionFile",
	],
	"../../orchestrator/compact-snapshot.ts": ["buildCompactSnapshot"],
	"../../orchestrator/config.ts": ["gateConfigCanAct", "gateConfigPath", "normalizeGateConfig", "readGateConfig"],
	"../../orchestrator/advisor.ts": [
		"advisorSkipReason",
		"buildAdvisorDigest",
		"consultAdvisor",
		"detectAdvisorTrigger",
		"formatAdvisorRecord",
		"formatAdvisorSection",
		"gateTriggerKey",
		"loopTriggerKey",
		"readAdvisorState",
		"redactSecrets",
		"toPiUsage",
	],
	"../../orchestrator/events.ts": ["ORCHESTRATOR_CUSTOM_TYPES", "publishOrchestrationEvent", "subscribeOrchestrationEvent"],
	"../../orchestrator/gate.ts": [
		"evaluateGate",
		"formatLoopVerdict",
		"formatVerdict",
		"readGateHistory",
		"reconstructGateState",
		"scanEditVerification",
		"scanFailures",
	],
	"../../orchestrator/role.ts": ["ORCHESTRATOR_ROLE", "isWorkerRole", "resolveOrchestratorRole"],
	"../../orchestrator/loop.ts": [
		"createLoopState",
		"evaluateLoop",
		"invocationLabel",
		"loopBlockReason",
		"loopSignature",
		"recordCall",
		"recordResult",
		"resetLoopState",
		"resetLoopTurn",
		"resultSignature",
	],
	"../../orchestrator/todo-state.ts": ["readOpenTodos", "todoDirectory"],
	"../../orchestrator/verify.ts": [
		"boundVerificationOutput",
		"classifyVerification",
		"runVerification",
		"verificationFailedOpen",
		"verificationInvocation",
	],
	"../../orchestrator/workspace.ts": [
		"buildPeerMessage",
		"buildPresence",
		"buildReservationPaths",
		"canonicalPath",
		"formatPeerMessage",
		"globToRegExp",
		"listPresence",
		"liveReservations",
		"markMessageDelivered",
		"presenceHeartbeatMs",
		"presenceIsLive",
		"pruneDeliveredMarkers",
		"readInbox",
		"readPresence",
		"readWorkspaceBranch",
		"readReservations",
		"releaseReservations",
		"reservationPathMatches",
		"reservationPathsOverlap",
		"reservePaths",
		"resolveWorkspaceScope",
		"validatePeerMessage",
		"validatePresence",
		"validateReservation",
		"withWorkspaceLock",
		"writePeerMessage",
		"writePresence",
	],
	"../../orchestrator/workspace-runtime.ts": ["registerWorkspace"],
	"../panel.ts": ["buildEscapeBindArgs", "buildAttachCommand", "buildPanelLaunch"],
	"../plan.ts": [
		"buildPlan",
		"cancelPlan",
		"cancelPlanStep",
		"failPlanStep",
		"markStepLaunched",
		"queuedStopCandidates",
		"readyStepIds",
		"reconcilePlan",
		"resolvePlan",
		"settlePlanStep",
	],
	"../report.ts": [
		"boundChildReport",
		"buildChildTaskPrompt",
		"buildRunReport",
		"parseChildReportText",
		"readReportHead",
		"resolveChildReport",
		"validateChildReport",
		"writeReportArtifact",
	],
	"../shell.ts": ["shellQuote"],
	"../../voice/config.ts": ["agentDir", "configPath", "loadConfig", "parseEnvBool", "readConfigFile"],
	"../../voice/shortcut.ts": ["normalizeKeyId", "parseShortcutIds"],
	"../../voice/recorder.ts": [
		"Recorder",
		"buildCleanupCommand",
		"buildFetchCommand",
		"buildStartCommand",
		"buildStopCommand",
		"localRecordingPath",
		"newRecordingId",
		"remoteRecordingPath",
	],
	"../../voice/transcribe.ts": ["TranscribeError", "assertUploadSize", "resolveApiKey", "transcribeAudio"],
};

for (const relative of EXTENSIONS) {
	test(`extension ${relative} loads under strict ESM`, async () => {
		const specifier = new URL(relative, import.meta.url).href;
		const module = (await import(specifier)) as { default?: unknown };
		assert.equal(typeof module.default, "function", `${relative} must export a default extension factory`);
	});
}

// A module may also export a *value* the linker has to resolve, not a function.
// `ORCHESTRATOR_ROLE` is the process role resolved once at module load; an
// importer that got `undefined` instead would treat every process as a parent,
// which is the bug the module exists to fix. Listed separately so every other
// named export stays pinned to a function.
const CONSTANT_EXPORTS: Record<string, string[]> = {
	"../../orchestrator/role.ts": ["ORCHESTRATOR_ROLE"],
	// The entry-type constant is a table, not a function, and `events.ts` is the
	// module both the index and `compact-snapshot.ts` import it from; pinning it
	// here means a dropped export fails at load rather than at send time.
	"../../orchestrator/events.ts": ["ORCHESTRATOR_CUSTOM_TYPES"],
	"../../orchestrator/compact-snapshot.ts": ["MAX_COMPACT_SNAPSHOT_BYTES"],
};

for (const [relative, exports] of Object.entries(MODULES)) {
	test(`module ${relative} loads under strict ESM`, async () => {
		const specifier = new URL(relative, import.meta.url).href;
		const module = (await import(specifier)) as Record<string, unknown>;
		for (const name of exports) {
			if (CONSTANT_EXPORTS[relative]?.includes(name)) {
				assert.ok(module[name] !== undefined, `${relative} must export the constant ${name}`);
				continue;
			}
			assert.equal(typeof module[name], "function", `${relative} must export ${name}`);
		}
	});
}
