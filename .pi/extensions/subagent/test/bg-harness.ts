// Shared harness for the `bg` tool's test files (01 onward).
//
// It boots the REAL extension factory against a throwaway PI_CODING_AGENT_DIR and
// records what pi would see: the tool registration and its exposure, every
// `sendMessage`, and the session handlers. Tool calls go through the real
// `execute`, exactly as the agent's would, so a test exercises the dispatch map
// rather than a helper beside it.
//
// Two things it models rather than asserts, because both decide what really
// happens in a session:
//
//   - The tool set pi would DECLARE to the model. A tool is active on
//     registration only when its exposure is `direct` or `model-only` and it does
//     not set `defaultActive: false`; everything else has to be named explicitly.
//     Asserting on the definition alone is what once let a change that altered
//     exposure but removed nothing pass the whole suite.
//   - `session_shutdown`. It stops the bg watcher, so every harness MUST be
//     closed (see `withBgHarness`, which does it in a `finally`): a live poll
//     timer keeps node's event loop alive and hangs `node --test`.
//
// Jobs are real detached shell processes writing real logs; nothing about process
// groups, pid liveness or exit codes is mocked. Cleanup kills any job the test
// left running, so a suite run cannot leak `sleep 30` processes.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";

import bgExtension from "../../bg/index.ts";
import { signalProcessGroup } from "../../bg/spawn.ts";
import { jobDirFor, readJobMeta, sessionJobsDir, type BgJobRecord } from "../../bg/store.ts";
import { waitFor, withEnv, withTempAgentDir } from "./helpers.ts";

/** Fixed so a test can name the on-disk session directory it is inspecting. */
export const BG_TEST_SESSION_ID = "bg-test-session";

export interface BgToolResult {
	text: string;
	details: Record<string, unknown>;
}

export interface BgToolRegistration {
	name: string;
	exposure: string | undefined;
	defaultActive: boolean | undefined;
}

export interface BgMessage {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

export interface BgHarness {
	/** The temp PI_CODING_AGENT_DIR this session's jobs live under. */
	agentDir: string;
	/** The session id every call reports. */
	sessionId: string;
	/** The tool definitions registered, by name. */
	tools: Map<string, Record<string, unknown>>;
	/** Every registerTool call, with the metadata the exposure decision rests on. */
	registrations: BgToolRegistration[];
	/** Which tools pi would declare to the model (see the file header). */
	declared: () => string[];
	/** Every pi.sendMessage call, in order. Ticket 05 asserts on these. */
	messages: BgMessage[];
	/** Call the `bg` tool through its real `execute`. */
	call: (params: Record<string, unknown>) => Promise<BgToolResult>;
	/** The on-disk directory of one job. */
	jobDir: (id: string) => string;
	/** The job's metadata as persisted (throws when it is unreadable). */
	readJob: (id: string) => Promise<BgJobRecord>;
	/** The job's log, as text. Missing file reads as "". */
	readLog: (id: string) => Promise<string>;
	/** File names inside the job's directory — used to prove no `.tmp` litter. */
	jobFiles: (id: string) => Promise<string[]>;
	/** The session's job directory listing (ids). */
	jobIds: () => Promise<string[]>;
	/** Wait for a job's persisted state to satisfy `predicate`. */
	waitForJob: (id: string, predicate: (job: BgJobRecord) => boolean, timeoutMs?: number) => Promise<BgJobRecord>;
	/** Fire session_shutdown, as pi does when the session ends. */
	shutdown: () => Promise<void>;
}

export interface BgHarnessOptions {
	/** The session's working directory. Point it somewhere missing to force a spawn failure. */
	cwd?: string;
	/** Extra environment variables the job must inherit from the session. */
	env?: Record<string, string>;
	/** Override the reported session id (a second session in the same agent dir). */
	sessionId?: string;
}

/**
 * Boot the extension against a temp agent dir, hand `h` to `fn`, then shut the
 * session down and kill anything the test left running.
 */
export async function withBgHarness<T>(fn: (h: BgHarness) => Promise<T>, options: BgHarnessOptions = {}): Promise<T> {
	// withTempAgentDir points PI_CODING_AGENT_DIR at the temp dir; nothing else has to
	// know where a job's state lives.
	return withTempAgentDir((agentDir) =>
		withEnv({ ...(options.env ?? {}) }, async () => {
			const sessionId = options.sessionId ?? BG_TEST_SESSION_ID;
			const cwd = options.cwd ?? process.cwd();
			const tools = new Map<string, Record<string, unknown>>();
			const registrations: BgToolRegistration[] = [];
			const declared = ["read", "bash", "edit", "write"];
			const messages: BgMessage[] = [];
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			// Jobs this harness started, so the finally can stop them.
			const started: number[] = [];

			const pi = {
				registerTool: (tool: Record<string, unknown>) => {
					const name = String(tool.name);
					tools.set(name, tool);
					const exposure = tool.exposure as string | undefined;
					const defaultActive = tool.defaultActive as boolean | undefined;
					registrations.push({ name, exposure, defaultActive });
					const declarable = exposure === "direct" || exposure === "model-only" || exposure === undefined;
					if (declarable && defaultActive !== false && !declared.includes(name)) declared.push(name);
				},
				registerCommand: () => undefined,
				registerMessageRenderer: () => undefined,
				on: (event: string, handler: (...args: unknown[]) => unknown) => {
					handlers.set(event, handler);
					return () => handlers.delete(event);
				},
				sendMessage: (message: Record<string, unknown>, opts?: Record<string, unknown>) => {
					messages.push({ message, options: opts });
				},
				getActiveTools: () => [...declared],
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			};

			const ctx = {
				cwd,
				mode: "tui",
				hasUI: false,
				isProjectTrusted: () => true,
				isIdle: () => true,
				signal: undefined,
				model: { provider: "openrouter", id: "test/model" },
				thinkingLevel: "medium",
				sessionManager: {
					getSessionId: () => sessionId,
					getSessionFile: () => path.join(agentDir, "sessions", `${sessionId}.jsonl`),
					getBranch: () => [],
				},
				ui: { notify: () => undefined, setStatus: () => undefined },
				shutdown: () => undefined,
			};

			const harness: BgHarness = {
				agentDir,
				sessionId,
				tools,
				registrations,
				declared: () => [...declared],
				messages,
				call: async (params) => {
					const tool = tools.get("bg");
					assert.ok(tool, "the bg tool must be registered");
					const execute = tool.execute as (
						id: string,
						params: Record<string, unknown>,
						signal: unknown,
						onUpdate: unknown,
						ctx: unknown,
					) => Promise<{ content: { text?: string }[]; details?: Record<string, unknown> }>;
					const result = await execute("call", params, undefined, undefined, ctx);
					return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
				},
				jobDir: (id) => jobDirFor(sessionId, id),
				readJob: async (id) => {
					const read = await readJobMeta(jobDirFor(sessionId, id));
					assert.ok(read.ok, `job ${id} metadata must be readable: ${read.ok ? "" : read.error}`);
					return read.job;
				},
				readLog: async (id) => {
					try {
						return await readFile(path.join(jobDirFor(sessionId, id), "output.log"), "utf8");
					} catch {
						return "";
					}
				},
				jobFiles: async (id) => {
					try {
						return (await readdir(jobDirFor(sessionId, id))).sort();
					} catch {
						return [];
					}
				},
				jobIds: async () => {
					try {
						return (await readdir(sessionJobsDir(sessionId))).sort();
					} catch {
						return [];
					}
				},
				waitForJob: async (id, predicate, timeoutMs = 30_000) => {
					await waitFor(async () => {
						const read = await readJobMeta(jobDirFor(sessionId, id));
						return read.ok && predicate(read.job);
					}, timeoutMs);
					return harness.readJob(id);
				},
				shutdown: async () => {
					await handlers.get("session_shutdown")?.({}, ctx);
				},
			};

			// Remember every pid the tool reports, so cleanup can reach it.
			const call = harness.call;
			harness.call = async (params) => {
				const result = await call(params);
				const job = result.details.job as { pid?: number | null } | undefined;
				if (typeof job?.pid === "number") started.push(job.pid);
				return result;
			};

			bgExtension(pi as never);
			await handlers.get("session_start")?.({}, ctx);

			try {
				return await fn(harness);
			} finally {
				await harness.shutdown();
				// A test may deliberately leave a job running (a watcher-stop check);
				// a leaked `sleep 30` would outlive the suite otherwise.
				for (const pid of started) signalProcessGroup(pid, "SIGKILL");
			}
		}),
	);
}
